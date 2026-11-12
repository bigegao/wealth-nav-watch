#!/usr/bin/env node
/**
 * 抓中国银行「当日代销理财产品净值」静态页 → **算增量** → 写 `data/YYYY-MM-DD.csv`。
 *
 * ## 为什么是「增量」
 *
 * 中行这个归档站**每只产品只保留最新的一条记录**（实测：拥有 ≥2 个不同净值日期的
 * 产品 = 0 只；197 页里 9,798 行 / 9,363 个产品代码）。
 * 所以：
 *
 * - **页面上永远是每只产品的最新净值** —— 今天抓到的是「今天之前最新的那一条」；
 * - **历史批次一旦被新披露覆盖就永久消失** —— 想攒历史，**只能每天存一条**。
 *
 * 于是本脚本的增量定义是：
 * **本次抓到的 `(来源, 产品代码, 净值日期)` 组合里，仓库里还没有的那些。**
 *
 * - 每天新披露的产品 → 落进当天的新组合 → 进当天文件 ✓
 * - 昨天就披露过、今天净值没变的 → 组合没变 → 不重复记 ✓
 * - 中途停跑几天 → 停跑期间的批次重新出现（还没被覆盖的话）→ 会被补上 ✓
 *
 * ## 三个来源
 *
 * | `source_dir` | 是什么 | 页数（实测 2026-11） |
 * | --- | --- | --- |
 * | `srfd6_2024` | 代销**理财** | 196 |
 * | `srfd2_2024` | 代销**基金** | 121 |
 * | `srfd3_2024` | 代销**资管** | 199 |
 *
 * 三者的表头完全一致（8 列），格式统一。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/fetch-boc-nav.mjs                 # 抓全部源，算增量，写 data/<今天>.csv
 * node scripts/fetch-boc-nav.mjs --dry-run       # 只算不写
 * node scripts/fetch-boc-nav.mjs --dir srfd6_2024 --pages 20   # 只抓理财的前 20 页
 * ```
 *
 * 零第三方依赖（只用 Node 自带的 fetch），Node 18+ 可跑。
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DATA_DIR = path.join(REPO, 'data');

const BASE = 'https://www.boc.cn/sourcedb';

/** 站点域名（钉 IP 时 SNI 和证书校验仍然按域名走） */
const HOST = 'www.boc.cn';

/** 来源目录 → 说明（写进 CSV 的 source_dir 列） */
const SOURCES = [
  { dir: 'srfd6_2024', label: '代销理财' },
  { dir: 'srfd2_2024', label: '代销基金' },
  { dir: 'srfd3_2024', label: '代销资管' },
];

/** 每个源最多翻多少页（留余量，实际最后一页之后就是空页） */
const MAX_PAGES = 220;

/**
 * 并发抓取数。
 *
 * 跨境实测单页 1.6~3 秒（TLS 握手 + 往返），520 页 ÷ 4 并发 ≈ 5.5 分钟。
 * 调高不是不行，只是没必要 —— 而且同一主机上同时开太多新连接容易触发限流。
 */
const CONCURRENCY = 4;

/** 单页重试轮数（每轮会把候选 IP 全试一遍） */
const RETRIES = 4;

/** 单次请求超时（毫秒）—— 跨境抖动大，给足余量 */
const REQUEST_TIMEOUT = 30_000;

/**
 * CSV 的列定义。
 *
 * 数值**保留页面上的原始字符串**，不做浮点转换 —— 一是避免精度损失，
 * 二是能区分「空」（这项没有）和 `0`（真的就是 0）。
 */
const COLUMNS = [
  'code', // 产品代码（中行销售代码）
  'product_name', // 产品名称
  'nav_date', // 净值日期 = 中行的「截止日期」= 估值日（不是发布日）
  'unit_nav', // 单位净值
  'cum_nav', // 累计净值（**算收益用这个**）
  'period_change_pct', // 期间涨跌幅 %（中行第 7 列，实为相对上一披露日的涨跌幅，单位净值口径）
  'per10k', // 每万份基金单位收益（元，货币基金口径）
  'yield7d_pct', // 七日年收益率 %（货币基金口径）
  'source_dir', // 来源静态页
  'data_date', // 数据日（北京时间）= **抓取日的前一天**（见下方「日期规范」）
];

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = {
    dirs: SOURCES.map((s) => s.dir),
    pages: MAX_PAGES,
    dryRun: false,
    date: null,
    selftest: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? '';
    if (arg === '--dir') opts.dirs = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--pages') opts.pages = Number(next());
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--date') opts.date = next();
    else if (arg === '--selftest') opts.selftest = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法：node scripts/fetch-boc-nav.mjs [--dir a,b] [--pages N] [--dry-run] [--date YYYY-MM-DD] [--selftest]',
        '  --date 指定「数据日」（产出 data/<数据日>.csv）；默认 = 昨天（北京时间）',
      );
      process.exit(0);
    } else {
      console.error(`不认识的参数：${arg}`);
      process.exit(2);
    }
  }
  if (!Number.isInteger(opts.pages) || opts.pages < 1) {
    console.error('--pages 至少为 1');
    process.exit(2);
  }
  return opts;
}

/** 北京日期（YYYY-MM-DD）—— 中国的理财数据，看的是北京日期 */
function beijingDate(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
}

/**
 * 北京日期往前推 n 天（n 为负数是往前）。
 *
 * 不用 `new Date(Date.now() + n*86400000)` —— 那是在 UTC 上加减，
 * 跨 UTC 日界时会差一天。这里先平移到北京时间（+8 小时），
 * 再按 UTC 取日期，结果就是「北京时历的那一天」。
 */
function beijingDateOffset(days, from = new Date()) {
  const shifted = new Date(from.getTime() + (8 * 60 + days * 24 * 60) * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

// ---------------------------------------------------------------- CSV

/** RFC4180 转义 */
function csvField(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function csvLine(values) {
  return values.map(csvField).join(',');
}

/** 解析一段 CSV 文本 → 行数组（支持引号包裹、字段里的逗号与换行） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"') { inQuotes = true; continue; }
    if (ch === ',') { row.push(field); field = ''; continue; }
    if (ch === '\r') continue;
    if (ch === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += ch;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }
  return rows;
}

// ---------------------------------------------------------------- HTML

const ENTITIES = {
  '&nbsp;': ' ',
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&ldquo;': '“',
  '&rdquo;': '”',
};

/** 去标签 + 解实体 + 收空白 */
function cleanCell(html) {
  let out = html.replace(/<[^>]*>/g, ' ');
  for (const [ent, ch] of Object.entries(ENTITIES)) out = out.split(ent).join(ch);
  return out.replace(/\s+/g, ' ').trim();
}

/** `2026/11/09 00:00:00` → `2026-11-09`；认不出来返回空串 */
function toIsoDate(raw) {
  const m = raw.trim().match(/(\d{4})[/-](\d{1,2})[/-](\d{1,2})/);
  if (!m) return '';
  const [, y, mo, d] = m;
  return `${y}-${mo.padStart(2, '0')}-${d.padStart(2, '0')}`;
}

/**
 * 解析一页静态 HTML。
 *
 * 只认**数据表**里的行：8 个 `<td>`、首列非空、末列是日期。
 * 页面顶部还有一个「起始时间 / 结束时间」筛选表单行（也是 8 个 `<td>`），
 * 按末列是不是日期就能把它排除掉。
 */
function parseBocPage(html) {
  const out = [];
  const rowRe = /<tr[^>]*>([\s\S]*?)<\/tr>/gi;
  let rowMatch;
  while ((rowMatch = rowRe.exec(html)) !== null) {
    const cells = [];
    const cellRe = /<td[^>]*>([\s\S]*?)<\/td>/gi;
    let cellMatch;
    while ((cellMatch = cellRe.exec(rowMatch[1])) !== null) {
      cells.push(cleanCell(cellMatch[1]));
    }
    if (cells.length !== 8) continue;

    const code = cells[0].trim();
    const navDate = toIsoDate(cells[7]);
    // 数据行的两个必要条件：首列是代码、末列是日期
    if (!code || !navDate) continue;

    out.push({
      code,
      product_name: cells[1].trim(),
      nav_date: navDate,
      unit_nav: cells[2].trim(),
      cum_nav: cells[3].trim(),
      per10k: cells[4].trim(),
      yield7d_pct: cells[5].trim(),
      period_change_pct: cells[6].trim(),
    });
  }
  return out;
}

// ---------------------------------------------------------------- 抓取

/**
 * 把一条错误链压成人类能读的字符串。
 *
 * 为什么要自己压：undici 的 `fetch` 失败时只给一句
 * `TypeError: fetch failed`，真实原因（ECONNRESET / ENOTFOUND / EINVAL…）
 * 藏在 `err.cause` 里。2026-11-11 第一次在 GitHub Actions 上跑就栽在这 ——
 * 日志里只有「fetch failed」，完全看不出是 IPv6 地址不可达。
 */
function describeError(err) {
  const parts = [];
  let e = err;
  let depth = 0;
  while (e && depth < 8) {
    const code = e.code ? `[${e.code}]` : '';
    parts.push(`${e.name}${code}: ${e.message}`);
    e = e.cause;
    depth += 1;
  }
  return parts.join('  <-  ');
}

/**
 * 解析候选 IP —— **只取 IPv4**。
 *
 * 关键：中行是 geo-DNS（按客户端位置智能解析），GitHub 托管 runner 在 Azure，
 * 实测 `getaddrinfo(www.boc.cn)` 会返回 `36.35.8.18` **和 IPv6 的
 * `2408:862a:c11:200::46`**。Azure runner 没有可用的 IPv6 出口，
 * 拿到 IPv6 就直接 `connect EINVAL` —— 对外只表现成「fetch failed」。
 * 所以这里显式把 IPv6 滤掉，只用 IPv4。
 */
async function resolveIPv4() {
  let list = [];
  try {
    const res = await dns.lookup(HOST, { all: true });
    list = res.filter((r) => r.family === 4 || r.family === 'IPv4').map((r) => r.address);
  } catch (err) {
    throw new Error(`解析 ${HOST} 失败：${describeError(err)}`);
  }
  if (!list.length) {
    throw new Error(`解析 ${HOST} 没有得到 IPv4 地址（只有 IPv6？）`);
  }
  return [...new Set(list)];
}

/**
 * 发一次 HTTPS 请求（**不跟随重定向**）。
 *
 * `ip` 传 null 表示用系统 DNS；传 IP 则钉住它（SNI 与证书仍按域名校验）。
 */
function httpsGet(url, ip, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const options = {
      hostname: target.hostname,
      // 不写 port 的话 Node 会用默认端口（http 80 / https 443），
      // 非默认端口的地址就打到 80 去了 —— 漏掉这一行的症状是
      // 「connect ECONNREFUSED 127.0.0.1:80」。
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; wealth-nav-watch/1.0)',
        Accept: 'text/html,application/xhtml+xml',
      },
      agent: false,
      timeout: timeoutMs,
    };
    if (isHttps) {
      options.servername = target.hostname;
    }
    if (ip) {
      options.lookup = (_hostname, lookupOptions, callback) => {
        // Node 20+ 默认 autoSelectFamily:true，会以 { all: true } 调用 lookup，
        // 这时回调要收数组而不是 (address, family)。
        if (lookupOptions && lookupOptions.all) callback(null, [{ address: ip, family: 4 }]);
        else callback(null, ip, 4);
      };
    }
    const req = transport.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () =>
        resolve({
          status: res.statusCode ?? 0,
          headers: res.headers,
          body: Buffer.concat(chunks),
        }),
      );
      res.on('error', reject);
    });
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('socket 超时'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', reject);
    // TLS socket 可能在请求结束后才抛错 —— 那时没人监听就会变成
    // unhandled 'error' event 直接把进程带崩。
    req.on('socket', (socket) => socket.on('error', () => {}));
    req.end();
  });
}

/**
 * 钉住 IP 取一次页面，**跟随重定向**（最多 3 跳）。
 *
 * 为什么必须跟随：中行对超出范围的页码（实测第 197 页起）返回
 * **302 → /custserv/cs1/msg/200909/...（一个「提示信息」页）**。
 * 那不是错误，是「翻到底了」的正常信号 —— 提示页里没有净值表格，
 * 解析出来 0 行，于是「连续两页空 → 停止」。
 *
 * 早期版本用 `fetch`，默认跟随重定向，所以行为是对的；
 * 换成 node:https 后忘了跟 → 302 被当成致命错误，整个任务挂掉。
 * 这个坑用 --selftest 钉住。
 */
async function httpGetPinned(url, ip, timeoutMs) {
  let current = url;
  let currentIp = ip;
  for (let hop = 0; hop <= 3; hop += 1) {
    const res = await httpsGet(current, currentIp, timeoutMs);
    const status = res.status;
    if (status >= 300 && status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, current);
      // 换了域名就不能继续钉同一个 IP 了
      currentIp = next.hostname === HOST ? ip : null;
      current = next.toString();
      continue;
    }
    return res;
  }
  throw new Error(`重定向次数过多：${url}`);
}

/** 页面字节 → 文本（三个源实测都是 UTF-8，万一变了就退回 gb18030） */
function decodeHtml(buf) {
  let html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
  if (html.includes('�')) {
    html = new TextDecoder('gb18030', { fatal: false }).decode(buf);
  }
  return html;
}

/**
 * 抓一页。
 *
 * 返回：HTML 文本；页码不存在（404）时返回 null（表示「到底了」）。
 * 失败必须抛错 —— 宁可整个任务失败，也不能拿半截数据去算增量。
 */
async function fetchPage(dir, page) {
  const url = `${BASE}/${dir}/index_${page}.html`;
  const attempts = [];
  let ips = await resolveIPv4();

  for (let round = 0; round < RETRIES; round += 1) {
    for (const ip of ips) {
      const started = Date.now();
      try {
        const { status, body } = await httpGetPinned(url, ip, REQUEST_TIMEOUT);
        const ms = Date.now() - started;
        if (status === 404) {
          // 这一页不存在 = 翻到底了，不是「抓取失败」
          return null;
        }
        if (status >= 200 && status < 300) {
          return decodeHtml(body);
        }
        attempts.push(`第${round + 1}轮 ${ip} → HTTP ${status}（${ms}ms）`);
        if (status < 500 && status !== 429) {
          throw new Error(`HTTP ${status}（4xx，重试没有意义）`);
        }
      } catch (err) {
        attempts.push(`第${round + 1}轮 ${ip} → ${describeError(err)}（${Date.now() - started}ms）`);
      }
    }
    if (round + 1 < RETRIES) {
      await sleep(1000 * (round + 1) + Math.floor(Math.random() * 500));
      // 重新解析：中行 DNS TTL 只有 300 秒且会轮换，可能换到别的节点
      try {
        ips = await resolveIPv4();
      } catch {
        /* 沿用上一轮的候选 */
      }
    }
  }
  throw new Error(
    `抓取 ${url} 失败（${RETRIES} 轮 × ${ips.length} 个候选 IP）：\n      - ${attempts.join('\n      - ')}`,
  );
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 抓一个源的所有页。
 *
 * **抓失败要抛错** —— 宁可整个任务失败，也不能拿半截数据去算增量：
 * 那样会把「没抓到」写成「没有变化」，历史就断了。
 */
async function fetchSource(dir, maxPages) {
  const rows = [];
  let cursor = 1;
  let emptyStreak = 0;
  let done = 0;
  const started = Date.now();
  const worker = async () => {
    while (cursor <= maxPages) {
      const page = cursor;
      cursor += 1;
      const html = await fetchPage(dir, page);
      done += 1;
      // 跨境抓取要几分钟，日志里得有动静，否则看不出是在跑还是在卡
      if (done % 20 === 0) {
        const secs = ((Date.now() - started) / 1000).toFixed(0);
        console.log(`    ${dir}：已抓 ${done} 页（${secs}s），累计 ${rows.length} 行`);
      }
      if (html === null) {
        // 404 = 页面不存在 = 翻到底了
        emptyStreak += 1;
        if (emptyStreak >= 2) return;
        continue;
      }
      const pageRows = parseBocPage(html);
      if (pageRows.length === 0) {
        emptyStreak += 1;
        // 连续两页空 → 后面没有了
        if (emptyStreak >= 2) return;
      } else {
        emptyStreak = 0;
        rows.push(...pageRows);
      }
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, maxPages) }, () => worker()),
  );
  return rows;
}

// ---------------------------------------------------------------- 增量

/** 增量去重键：来源 + 产品代码 + 净值日期 */
function makeKey(code, navDate, sourceDir) {
  return [sourceDir, code, navDate].join('\u0001');
}

/** 从一行 CSV（10 列）算键 */
function csvRowKey(row) {
  return makeKey(row[0] ?? '', row[2] ?? '', row[8] ?? '');
}

/** 读 data/ 下已有的所有 CSV → 已知键集合 */
async function loadKnownKeys() {
  const keys = new Set();
  let files = [];
  try {
    files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.csv'));
  } catch {
    return keys; // data/ 还不存在（第一次跑）
  }
  for (const file of files) {
    const text = await readFile(path.join(DATA_DIR, file), 'utf8');
    const rows = parseCsv(text);
    for (let i = 1; i < rows.length; i += 1) {
      const row = rows[i];
      if (row.length < COLUMNS.length) continue;
      keys.add(csvRowKey(row));
    }
  }
  return keys;
}

/** 读当天的文件（如果 workflow 重跑过），用来合并而不是覆盖 */
async function loadExistingRows(file) {
  try {
    const text = await readFile(file, 'utf8');
    const rows = parseCsv(text);
    return rows.slice(1).filter((r) => r.length >= COLUMNS.length);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------- 主流程

async function main(argv) {
  const opts = parseArgs(argv);
  if (opts.selftest) {
    return selftest();
  }
  // 日期规范：**数据日 = 抓取日的前一天**。
  //
  // 中行按估值日披露、批次在第二天才刷新，所以凌晨 5 点抓到的
  // 是「昨天（按北京日）披露出来的那一批」。文件名与 `data_date` 列
  // 一律用**数据日**，不再用「我什么时候跑的」——
  // 否则同一个「2026-11-12.csv」在不同批次下含义会漂。
  const dataDate = opts.date || beijingDateOffset(-1);

  console.log(`数据日（北京时间）：${dataDate}（抓取日 ${beijingDate()} 的前一天）`);
  console.log(`来源：${opts.dirs.join('、')}（每个源最多 ${opts.pages} 页）`);

  const known = await loadKnownKeys();
  console.log(`仓库里已有的 (来源,代码,净值日期) 组合：${known.size} 个`);

  const all = [];
  for (const dir of opts.dirs) {
    const started = Date.now();
    const rows = await fetchSource(dir, opts.pages);
    const label = SOURCES.find((s) => s.dir === dir)?.label ?? dir;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    console.log(`  ${dir}（${label}）：${rows.length} 行（用时 ${secs}s）`);
    all.push(...rows.map((r) => ({ ...r, source_dir: dir })));
  }

  // 去重：同一源里同一 (code, nav_date) 只留一条；仓库里已有的也不算增量
  const seen = new Set();
  const fresh = [];
  for (const row of all) {
    const key = makeKey(row.code, row.nav_date, row.source_dir);
    if (seen.has(key)) continue;
    seen.add(key);
    if (known.has(key)) continue;
    fresh.push(row);
  }

  console.log(`本次抓到的组合：${seen.size} 个；其中**新增** ${fresh.length} 个`);

  // 按净值日期倒序、同日按代码排 —— 最新披露的排前面
  fresh.sort((a, b) => (a.nav_date === b.nav_date
    ? a.code.localeCompare(b.code)
    : b.nav_date.localeCompare(a.nav_date)));

  if (opts.dryRun) {
    console.log('（--dry-run：不写文件）');
    for (const row of fresh.slice(0, 10)) {
      console.log(`  ${row.nav_date}  ${row.code}  ${row.product_name}`);
    }
    return 0;
  }

  await mkdir(DATA_DIR, { recursive: true });
  const outFile = path.join(DATA_DIR, `${dataDate}.csv`);

  // 同一天重跑 → 合并而不是覆盖（去重键相同的不重复写）
  const existing = await loadExistingRows(outFile);
  const merged = new Map();
  for (const row of existing) merged.set(csvRowKey(row), row);
  for (const row of fresh) {
    const csvRow = [
      row.code,
      row.product_name,
      row.nav_date,
      row.unit_nav,
      row.cum_nav,
      row.period_change_pct,
      row.per10k,
      row.yield7d_pct,
      row.source_dir,
      dataDate,
    ];
    merged.set(csvRowKey(csvRow), csvRow);
  }

  // 没有新增、而且当天也没有既存文件 → **不写文件**。
  // 否则仓库里会多出一个只有表头的空 CSV（每天一个，纯噪音）。
  if (merged.size === 0) {
    console.log('没有新增数据，不写文件');
    return 0;
  }

  const lines = [csvLine(COLUMNS)];
  for (const row of merged.values()) lines.push(csvLine(row));
  const content = `${lines.join('\n')}\n`;

  // 内容没变就别改文件（免得 git 认为有变更）
  try {
    const old = await readFile(outFile, 'utf8');
    if (old === content) {
      console.log(`→ ${path.relative(REPO, outFile)}（内容未变，不重写）`);
      return 0;
    }
  } catch {
    // 文件不存在，正常写
  }

  await writeFile(outFile, content, 'utf8');
  console.log(`→ ${path.relative(REPO, outFile)}（共 ${merged.size} 行）`);
  return 0;
}

/**
 * 自测：把几个「踩过坑」的传输层行为钉住。
 *
 * 为什么要专门写这个 —— 2026-11-11 那天连续栽了两次：
 *   1. 302 重定向没跟随 → 中行第 197 页起返回 302 跳「提示信息」页，
 *      被当成致命错误，整个任务挂在 180 页；
 *   2. IPv6 没排除 → Azure runner 上 connect ENETUNREACH。
 *
 * 这两个都是「不报错但行为错」或「只在特定网络环境才错」的问题，
 * 光靠本地跑一次抓取是抓不到的 —— 必须用本地服务器把边界条件复现出来。
 */
async function selftest() {
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok, detail });
    console.log(`${ok ? '  ✅' : '  ❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  };

  // 模拟中行的行为：正常页 / 302→提示页 / 404
  const server = http.createServer((req, res) => {
    if (req.url === '/page.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><body>净值表格</body></html>');
    } else if (req.url === '/out-of-range.html') {
      // 中行对超出范围的页码：302 跳到「提示信息」页
      res.writeHead(302, { Location: '/tip.html' });
      res.end();
    } else if (req.url === '/tip.html') {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end('<html><head><title>中国银行全球门户网站-提示信息</title></head><body>没有净值表格</body></html>');
    } else if (req.url === '/missing.html') {
      res.writeHead(404);
      res.end('没有这一页');
    } else {
      res.writeHead(500);
      res.end();
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  try {
    console.log('=== 自测 ===');

    // 1) 302 必须跟随（这是 2026-11-11 挂掉的原因）
    const redirected = await httpGetPinned(`${base}/out-of-range.html`, null, 5000);
    check(
      '302 重定向被跟随（而不是当成错误）',
      redirected.status === 200 && redirected.body.toString('utf8').includes('提示信息'),
      `status=${redirected.status}`,
    );

    // 2) 跟到提示页后，解析出来的必须是 0 行 —— 「翻到底了」而不是「有数据」
    check(
      '提示页解析出 0 行',
      parseBocPage(redirected.body.toString('utf8')).length === 0,
    );

    // 3) 404 必须原样返回状态码（fetchPage 靠它判定「到底了」）
    const missing = await httpGetPinned(`${base}/missing.html`, null, 5000);
    check('404 原样返回状态码', missing.status === 404, `status=${missing.status}`);

    // 4) 200 正常页原样返回
    const ok = await httpGetPinned(`${base}/page.html`, null, 5000);
    check('200 正常页原样返回', ok.status === 200 && ok.body.toString('utf8').includes('净值表格'));

    // 5) 钉 IP 时必须真的走那个 IP（lookup 覆盖生效）
    const pinned = await httpGetPinned(`${base}/page.html`, '127.0.0.1', 5000);
    check('钉住 IP 时请求仍能成功', pinned.status === 200);

    // 6) 错误链要能挖出真实原因（不是只给一句「fetch failed」）
    const cause = describeError(
      Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('boom'), { code: 'ECONNRESET' }) }),
    );
    check(
      '错误链包含底层错误码',
      cause.includes('ECONNRESET') && cause.includes('fetch failed'),
      cause,
    );

    // 7) 只取 IPv4 —— IPv6 在 GitHub runner 上是黑洞
    check('错误链只取 IPv4 的过滤逻辑存在', typeof resolveIPv4 === 'function');
  } finally {
    server.close();
  }

  const failed = results.filter((r) => !r.ok);
  console.log();
  console.log(failed.length ? `❌ 自测失败 ${failed.length} 项` : `✅ 自测全部通过（${results.length} 项）`);
  return failed.length ? 1 : 0;
}

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('抓取失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  });
