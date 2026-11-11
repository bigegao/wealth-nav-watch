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

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DATA_DIR = path.join(REPO, 'data');

const BASE = 'https://www.boc.cn/sourcedb';

/** 来源目录 → 说明（写进 CSV 的 source_dir 列） */
const SOURCES = [
  { dir: 'srfd6_2024', label: '代销理财' },
  { dir: 'srfd2_2024', label: '代销基金' },
  { dir: 'srfd3_2024', label: '代销资管' },
];

/** 每个源最多翻多少页（留余量，实际最后一页之后就是空页） */
const MAX_PAGES = 220;

/** 并发抓取数 */
const CONCURRENCY = 6;

/** 单页重试次数 */
const RETRIES = 3;

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
  'run_date', // 本次抓取日期（北京时间）
];

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = { dirs: SOURCES.map((s) => s.dir), pages: MAX_PAGES, dryRun: false, date: null };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i] ?? '';
    if (arg === '--dir') opts.dirs = next().split(',').map((s) => s.trim()).filter(Boolean);
    else if (arg === '--pages') opts.pages = Number(next());
    else if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--date') opts.date = next();
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法：node scripts/fetch-boc-nav.mjs [--dir a,b] [--pages N] [--dry-run] [--date YYYY-MM-DD]',
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

async function fetchPage(dir, page) {
  const url = `${BASE}/${dir}/index_${page}.html`;
  let lastErr = null;
  for (let attempt = 0; attempt < RETRIES; attempt += 1) {
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (compatible; wealth-nav-watch/1.0)' },
        signal: AbortSignal.timeout(20_000),
      });
      if (!res.ok) {
        lastErr = new Error(`HTTP ${res.status}`);
        if (res.status < 500 && res.status !== 429) break; // 4xx 重试没有意义
      } else {
        const buf = Buffer.from(await res.arrayBuffer());
        // 三个源实测都是 UTF-8；万一变了就退回 gb18030（不静默出乱码）
        let html = new TextDecoder('utf-8', { fatal: false }).decode(buf);
        if (html.includes('�')) {
          html = new TextDecoder('gb18030', { fatal: false }).decode(buf);
        }
        return html;
      }
    } catch (err) {
      lastErr = err;
    }
    if (attempt + 1 < RETRIES) await sleep(800 * (attempt + 1));
  }
  throw new Error(`抓取 ${url} 连续 ${RETRIES} 次失败：${lastErr}`);
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
  const worker = async () => {
    while (cursor <= maxPages) {
      const page = cursor;
      cursor += 1;
      const html = await fetchPage(dir, page);
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
async function loadRunDateRows(file) {
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
  const runDate = opts.date || beijingDate();

  console.log(`抓取日期（北京时间）：${runDate}`);
  console.log(`来源：${opts.dirs.join('、')}（每个源最多 ${opts.pages} 页）`);

  const known = await loadKnownKeys();
  console.log(`仓库里已有的 (来源,代码,净值日期) 组合：${known.size} 个`);

  const all = [];
  for (const dir of opts.dirs) {
    const rows = await fetchSource(dir, opts.pages);
    const label = SOURCES.find((s) => s.dir === dir)?.label ?? dir;
    console.log(`  ${dir}（${label}）：${rows.length} 行`);
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
  const outFile = path.join(DATA_DIR, `${runDate}.csv`);

  // 同一天重跑 → 合并而不是覆盖（去重键相同的不重复写）
  const existing = await loadRunDateRows(outFile);
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
      runDate,
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

main(process.argv.slice(2))
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error('抓取失败：', err instanceof Error ? err.message : err);
    process.exit(1);
  });
