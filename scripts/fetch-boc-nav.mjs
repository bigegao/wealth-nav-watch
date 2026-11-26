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

import { readFile, readdir, writeFile, mkdir, appendFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DATA_DIR = path.join(REPO, 'data');

/**
 * 快照清单目录。
 *
 * 每一轮抓取都往 `snapshots/YYYY-MM.jsonl` 追加一行，
 * 记下「这一轮什么时候跑的、扫了多少页、看到多少组合、新增多少」。
 *
 * 为什么需要它：仓库里**只存新增的行**，
 * 所以「某一轮跑了但什么都没新增」这件事在数据文件里是看不见的。
 * 而判断某档净值是「产品没披露」还是「我们没拍到」，
 * 唯一的证据就是「那段时间里到底跑过几轮」—— 证据只能存在这里。
 */
const SNAPSHOT_DIR = path.join(REPO, 'snapshots');

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
 * 「一两个月没变化」的天数 —— 净值日期比这个更早的算**陈旧**。
 *
 * ⚠️ **这个常量就是「陈旧」的口径本身**（60 天）。
 * 导入方若另有一份早停实现，数值必须与这里一致 ——
 * 漂移就会出现「上游写了、下游早停」这种口径不一致。
 *
 * 取 60 天的理由：季频披露的产品平时净值日期就有 90 天大，
 * 阈值必须宽过季度周期，否则会把正常在披露的季频产品判成僵尸。
 */
const STALE_DAYS = 60;

/**
 * 早停时一块翻多少页。
 *
 * 判据是「这一块里最新的净值日期都早于截止日 → 后面只会更老，停」。
 * 用「整块」而不是「连续 N 页」：块内夹着一页新鲜的就继续翻，
 * 漏抓的风险更小。
 */
const STALE_BLOCK_PAGES = 8;

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
  'snapshot_at', // **这一档是被哪一次快照拍到的**（北京时间 ISO8601）
];

/**
 * 参与去重键的列数 —— **前 10 列**。
 *
 * 为什么单独记一个数：`snapshot_at` 是后加的第 11 列，
 * 而 2026-11-26 之前的所有 CSV 都只有 10 列。
 * 如果按 `COLUMNS.length`（现在 = 11）去筛行数，
 * 那些老文件会被整份跳过 → 已知键集合塌成空 →
 * 所有历史组合都被当成「新增」重写一遍。
 *
 * 所以：**老文件按 10 列读，新文件按 11 列写**，
 * 缺的那一列补空串。去重键只用前 10 列（见 csvRowKey），
 * 与加列之前完全一致 —— 加列不改变「什么算重复」。
 */
const BASE_COLUMN_COUNT = 10;

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = {
    dirs: SOURCES.map((s) => s.dir),
    pages: MAX_PAGES,
    dryRun: false,
    date: null,
    selftest: false,
    /** 陈旧天数：净值日期比「今天 − N 天」还老的不抓、不写。0 = 不过滤 */
    staleDays: STALE_DAYS,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? '';
    if (arg === '--dir') opts.dirs = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--pages') opts.pages = Number(next());
    else if (arg === '--stale-days') opts.staleDays = Number(next());
    else if (arg === '--full') opts.staleDays = 0;
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--date') opts.date = next();
    else if (arg === '--selftest') opts.selftest = true;
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法：node scripts/fetch-boc-nav.mjs [--dir a,b] [--pages N] [--stale-days N] [--full] [--dry-run] [--date YYYY-MM-DD] [--selftest]',
        '  --date 指定「数据日」（产出 data/<数据日>.csv）；默认 = 昨天（北京时间）',
        `  --stale-days N  净值日期早于「今天 − N 天」的算陈旧，不抓不写（默认 ${STALE_DAYS}）`,
        '  --full          等价于 --stale-days 0：全量翻页，什么都不过滤（回补历史时用）',
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
  if (!Number.isInteger(opts.staleDays) || opts.staleDays < 0) {
    console.error('--stale-days 不能是负数（0 = 不过滤）');
    process.exit(2);
  }
  return opts;
}

/**
 * 截止日 = 北京今天往前推 N 天。
 *
 * @param {number} staleDays 天数；0 = 永不过期（返回空串）
 * @returns {string} YYYY-MM-DD，空串表示不过滤
 */
function staleCutoff(staleDays) {
  if (!staleDays || staleDays <= 0) return '';
  const shifted = new Date(Date.now() + (8 * 60 - staleDays * 24 * 60) * 60 * 1000);
  return shifted.toISOString().slice(0, 10);
}

/** 这一行的净值日期算不算「陈旧」（日期认不出来 → 不算，宁可多抓一次） */
function isStale(navDate, cutoff) {
  if (!cutoff) return false;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(navDate ?? ''))) return false;
  return navDate < cutoff;
}

/** 一批行里最新的净值日期 */
function maxNavDate(rows) {
  let max = null;
  for (const r of rows) {
    const d = String(r.nav_date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue;
    if (max === null || d > max) max = d;
  }
  return max;
}

/**
 * 这一块要不要早停？
 *
 * 判据：**整块里最新的净值日期都早于截止日** → 后面只会更老，收工。
 * 夹着一页新鲜的就继续翻（漏抓的风险更小）。
 *
 * 「没有有效日期」不算陈旧 —— 宁可多翻几页，也不能漏。
 */
function shouldStopForStale(blockRows, cutoff) {
  if (!cutoff) return false;
  const newest = maxNavDate(blockRows);
  return newest !== null && newest < cutoff;
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

/**
 * 北京时间的 ISO8601（带 +08:00 偏移），例：`2026-11-26T13:04:05+08:00`。
 *
 * 为什么带偏移而不是不带：中行、仓库、GitHub 看的是三个不同的时区，
 * 一个不带时区的时间戳没法比先后。
 */
function beijingNow(from = new Date()) {
  const shifted = new Date(from.getTime() + 8 * 60 * 60 * 1000);
  return `${shifted.toISOString().slice(0, 19)}+08:00`;
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
/**
 * 抓一个源的所有页。
 *
 * **抓失败要抛错** —— 宁可整个任务失败，也不能拿半截数据去算增量：
 * 那样会把「没抓到」写成「没有变化」，历史就断了。
 *
 * ## 分块 + 陈旧早停
 *
 * 按块（`STALE_BLOCK_PAGES` 页一块）翻，块内并发、块间串行。
 * 每抓完一块就问一次：**这一块里最新的净值日期都早于截止日吗？**
 * 是 → 后面只会更老，收工（`stopReason: 'stale'`）。
 *
 * 为什么早停不会漏数据：页序 = 披露批次（页码越小 = 披露日期越新），
 * 产品**再次披露时会回到前面的页** —— 睡着的产品一醒来必然出现在
 * 我们还在翻的前几页里。万一顺序有例外，由**每周一次全量扫描**兜底。
 *
 * @param {string} dir 来源目录
 * @param {number} maxPages 最多翻几页
 * @param {{cutoff?: string}} opts cutoff 非空才启用早停
 */
async function fetchSource(dir, maxPages, opts = {}) {
  const cutoff = opts.cutoff ?? '';
  const rows = [];
  let emptyStreak = 0;
  let scanned = 0;
  let stopReason = null;
  let stopPage = null;
  const started = Date.now();

  for (let blockStart = 1; blockStart <= maxPages; blockStart += STALE_BLOCK_PAGES) {
    const blockEnd = Math.min(maxPages, blockStart + STALE_BLOCK_PAGES - 1);
    const pages = new Array(blockEnd - blockStart + 1).fill(null);

    // 块内并发
    let cursor = 0;
    const worker = async () => {
      while (cursor < pages.length) {
        const idx = cursor;
        cursor += 1;
        pages[idx] = await fetchPage(dir, blockStart + idx);
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(CONCURRENCY, pages.length) }, () => worker()),
    );

    const blockRows = [];
    for (const html of pages) {
      scanned += 1;
      if (html === null) {
        // 404 = 页面不存在 = 翻到底了
        emptyStreak += 1;
        continue;
      }
      const pageRows = parseBocPage(html);
      if (pageRows.length === 0) {
        emptyStreak += 1;
      } else {
        emptyStreak = 0;
        blockRows.push(...pageRows);
      }
    }
    rows.push(...blockRows);

    const secs = ((Date.now() - started) / 1000).toFixed(0);
    console.log(
      `    ${dir}：已抓 ${scanned} 页（${secs}s），累计 ${rows.length} 行`,
    );

    // 连续两页空 → 后面没有了
    if (emptyStreak >= 2) {
      stopReason = 'empty';
      stopPage = blockEnd;
      break;
    }

    // 这一块整块都陈旧 → 后面只会更老，收工
    if (shouldStopForStale(blockRows, cutoff)) {
      stopReason = 'stale';
      stopPage = blockEnd;
      break;
    }
  }

  return { rows, scanned, stopReason, stopPage };
}

// ---------------------------------------------------------------- 增量

/** 增量去重键：来源 + 产品代码 + 净值日期 */
function makeKey(code, navDate, sourceDir) {
  return [sourceDir, code, navDate].join('\u0001');
}

/** 从一行 CSV 算键 —— 只用前 {@link BASE_COLUMN_COUNT} 列（加列不改变去重口径） */
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
      // 判 10 列而不是 COLUMNS.length：老文件只有 10 列，不能整份跳过
      if (row.length < BASE_COLUMN_COUNT) continue;
      keys.add(csvRowKey(row));
    }
  }
  return keys;
}

/**
 * 读当天的文件（如果 workflow 重跑过），用来合并而不是覆盖。
 *
 * 老文件（10 列）会被补齐到 11 列 —— 补的是空的 `snapshot_at`，
 * 因为那批数据当时确实没有记录是哪一次快照拍到的。
 */
async function loadExistingRows(file) {
  try {
    const text = await readFile(file, 'utf8');
    const rows = parseCsv(text);
    return rows
      .slice(1)
      .filter((r) => r.length >= BASE_COLUMN_COUNT)
      .map((r) => (r.length >= COLUMNS.length ? r : [...r, ...Array(COLUMNS.length - r.length).fill('')]));
  } catch {
    return [];
  }
}

/**
 * 往 `snapshots/YYYY-MM.jsonl` 追加一行「这一轮快照」的记录。
 *
 * 按月一个文件、一轮一行 —— 一年 12 个文件、每天几行，
 * git diff 里能直接看到「快照密度」的变化，又不至于把仓库塞满小文件。
 *
 * 记的是**这一轮看到了什么**，不是「新增了什么」：
 * 新增的行在 CSV 里，**没新增这件事只有这里有**。
 */
async function writeSnapshotManifest(entry) {
  await mkdir(SNAPSHOT_DIR, { recursive: true });
  const month = entry.snapshotAt.slice(0, 7); // 2026-11
  const file = path.join(SNAPSHOT_DIR, `${month}.jsonl`);
  const line = JSON.stringify({
    snapshot_at: entry.snapshotAt,
    data_date: entry.dataDate,
    mode: entry.mode,
    dirs: entry.dirs,
    known: entry.knownCombos,
    seen: entry.seenCombos,
    new: entry.newRows,
    stale_skipped: entry.staleSkipped,
    sources: entry.sources.map((s) => ({
      dir: s.dir,
      pages: s.pages_scanned,
      rows: s.rows_seen,
      stop: s.stop_reason,
      stop_page: s.stop_page,
      seconds: s.seconds,
    })),
  });
  await appendFile(file, `${line}\n`, 'utf8');
  console.log(`→ ${path.relative(REPO, file)}（记了这一轮快照）`);
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

  // 这一轮快照的时刻 —— 写进每一行的 `snapshot_at`，也写进快照清单。
  //
  // 取的是**开始抓的时候**，不是结束的时候：一轮要跑 1~3 分钟，
  // 中途中行可能就刷了新批次，用开始时刻才不会把两轮的时间算串。
  const snapshotAt = beijingNow();

  console.log(`数据日（北京时间）：${dataDate}（抓取日 ${beijingDate()} 的前一天）`);
  console.log(`快照时刻：${snapshotAt}`);
  console.log(`来源：${opts.dirs.join('、')}（每个源最多 ${opts.pages} 页）`);

  // 陈旧截止日：净值日期比它还早的 = 一两个月没变化，不抓、不写。
  const cutoff = staleCutoff(opts.staleDays);
  if (cutoff) {
    console.log(
      `陈旧截止日：${cutoff}（净值日期早于它的算「${opts.staleDays} 天没变化」，不写进增量）`,
    );
  } else {
    console.log('陈旧过滤：关（全量）');
  }

  const known = await loadKnownKeys();
  console.log(`仓库里已有的 (来源,代码,净值日期) 组合：${known.size} 个`);

  const all = [];
  let staleSeen = 0;
  const sources = [];
  for (const dir of opts.dirs) {
    const started = Date.now();
    const fetched = await fetchSource(dir, opts.pages, { cutoff });
    const label = SOURCES.find((s) => s.dir === dir)?.label ?? dir;
    const secs = ((Date.now() - started) / 1000).toFixed(1);
    const why =
      fetched.stopReason === 'stale'
        ? `，第 ${fetched.stopPage} 页起整块陈旧，提前收工`
        : fetched.stopReason === 'empty'
          ? '，翻到底了'
          : '';
    console.log(
      `  ${dir}（${label}）：扫 ${fetched.scanned} 页 / ${fetched.rows.length} 行（用时 ${secs}s）${why}`,
    );
    // 陈旧的行不进增量 —— 一两个月没变化的产品只会往仓库里堆僵尸数据。
    const keep = cutoff ? fetched.rows.filter((r) => !isStale(r.nav_date, cutoff)) : fetched.rows;
    staleSeen += fetched.rows.length - keep.length;
    all.push(...keep.map((r) => ({ ...r, source_dir: dir })));
    sources.push({
      dir,
      pages_scanned: fetched.scanned,
      rows_seen: fetched.rows.length,
      stop_reason: fetched.stopReason,
      stop_page: fetched.stopPage,
      seconds: Number(secs),
    });
  }
  if (staleSeen > 0) console.log(`陈旧跳过 ${staleSeen} 行（不进增量）`);

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
      snapshotAt,
    ];
    merged.set(csvRowKey(csvRow), csvRow);
  }

  // 快照清单：这一轮跑过了就是跑过了 —— 哪怕它什么都没新增。
  // 写在最前面，因为它比数据文件更重要：**数据文件只记新增，
  // 「这一轮跑了但没有新增」在数据文件里是看不见的**，
  // 而判断某档净值是「没披露」还是「没拍到」，证据就在这里。
  await writeSnapshotManifest({
    snapshotAt,
    dataDate,
    mode: opts.staleDays > 0 ? 'early-stop' : 'full',
    dirs: opts.dirs,
    knownCombos: known.size,
    seenCombos: seen.size,
    newRows: fresh.length,
    staleSkipped: staleSeen,
    sources,
  });

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

    // 8) 陈旧截止日 = 今天往前推 N 天
    const cutoff = staleCutoff(60);
    const expectCutoff = new Date(Date.now() + (8 * 60 - 60 * 24 * 60) * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    check(
      '陈旧截止日 = 北京今天往前推 60 天',
      cutoff === expectCutoff,
      `cutoff=${cutoff} 期望=${expectCutoff}`,
    );

    // 9) 陈旧判定：早于截止日算陈旧，日期认不出来不算
    check('净值日期早于截止日 → 陈旧', isStale('2019-05-06', '2026-09-17') === true);
    check('净值日期不早于截止日 → 不陈旧', isStale('2026-11-15', '2026-09-17') === false);
    check(
      '日期认不出来 → 不算陈旧（宁可多抓一次）',
      isStale('不是日期', '2026-09-17') === false && isStale('', '2026-09-17') === false,
    );

    // 10) 早停判据：整块都陈旧才停，夹着一页新鲜就继续
    const oldBlock = [{ nav_date: '2019-05-06' }, { nav_date: '2019-05-07' }];
    const mixedBlock = [{ nav_date: '2019-05-06' }, { nav_date: '2026-11-15' }];
    check('整块都陈旧 → 停', shouldStopForStale(oldBlock, '2026-09-17') === true);
    check('块里夹着一页新鲜的 → 不停', shouldStopForStale(mixedBlock, '2026-09-17') === false);
    check('不过滤时永远不停', shouldStopForStale(oldBlock, '') === false);
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
