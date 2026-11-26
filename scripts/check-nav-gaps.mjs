#!/usr/bin/env node
/**
 * 净值丢档体检 —— 找出「本该有、但库里没有」的那几档净值。
 *
 * ## 为什么需要它
 *
 * 中行归档站每只产品只保留最新一行（实测：9,798 行里 9,363 个产品代码，
 * 拥有 ≥2 个不同净值日期的产品 = 0 只）。所以「攒历史」只能靠**每天拍一张快照**，
 * 而快照一旦没赶上，那一档净值就在源头被下一批覆盖，**永久消失**。
 *
 * 现在库里缺 11-19 那一档时，从数据本身看不出任何异常 ——
 * 「产品那天没披露」和「我们没拍到」长得一模一样。
 * 这个脚本就是来把这两者**分开**的。
 *
 * ## 怎么分
 *
 * 三条证据凑一起看：
 *
 * 1. **产品自己的节奏**：平时隔 1~2 个工作日就披露一次的产品，
 *    突然隔了 5 个工作日 → 异常。季频产品天生隔 90 天，不算异常。
 * 2. **那天的披露密度**：全库有多少产品在 D 那天披露了净值？
 *    很多 → D 确实是个披露日（不是节假日），我们缺了可疑。
 *    几乎没人 → D 大概率是非披露日（节假日 / 周末），不报。
 * 3. **窗口里跑过几轮快照**：
 *    - 跑过 → 我们**有机会**拍到 D 却没拍到 → 疑似被覆盖；
 *    - 没跑过 → 纯调度问题（那段时间压根没抓）→ 性质完全不同，要单独说。
 *
 * 注意：第 3 条只能给出「疑似」。要 100% 确认某产品那天到底披露没披露，
 * 只能去中行官网/App 查历史曲线 —— 归档站不给历史（实测：
 * 页面上的日期检索表单指向的 search.jsp 已下线，fund/search.jsp 404，
 * 页面上也没有任何产品详情链接）。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/check-nav-gaps.mjs               # 人看的报告
 * node scripts/check-nav-gaps.mjs --strict      # 有疑似丢档就 exit 1（给 CI 用）
 * node scripts/check-nav-gaps.mjs --json        # 机器读的 JSON
 * node scripts/check-nav-gaps.mjs --code 122510D  # 只看某一只
 * node scripts/check-nav-gaps.mjs --stale-days 14  # 顺带列出 N 天没披露的产品
 * ```
 *
 * 零第三方依赖，只用 Node 内建模块。
 */

import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const DATA_DIR = path.join(REPO, 'data');
const SNAPSHOT_DIR = path.join(REPO, 'snapshots');

/**
 * 「那天是披露日」的判定门槛：全库当天披露的产品数 ≥ 这个数，才算正常披露日。
 *
 * 取 100 而不是更大：全库有 9,000 多个产品代码，
 * 正常披露日当天会有几千只产品披露，节假日则是 0。
 * 100 足够把两者分开，又不会因为某天只有小批量产品披露而误判。
 */
const DISCLOSURE_DENSITY_MIN = 100;

/** 产品平时最多隔几个工作日还算正常（超过就算异常节奏） */
const NORMAL_INTERVAL_MAX = 2;

// ---------------------------------------------------------------- 参数

function parseArgs(argv) {
  const opts = { strict: false, json: false, summary: false, code: null, staleDays: 0 };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--strict') opts.strict = true;
    else if (arg === '--json') opts.json = true;
    else if (arg === '--summary') opts.summary = true;
    else if (arg === '--code') opts.code = argv[++i] ?? '';
    else if (arg === '--stale-days') opts.staleDays = Number(argv[++i] ?? 0);
    else if (arg === '--help' || arg === '-h') {
      console.log(
        '用法：node scripts/check-nav-gaps.mjs [--strict] [--json] [--summary] [--code CODE] [--stale-days N]',
      );
      process.exit(0);
    } else {
      console.error(`不认识的参数：${arg}`);
      process.exit(2);
    }
  }
  return opts;
}

// ---------------------------------------------------------------- 日期工具

/** `2026-11-19` → Date（按 UTC 解析，避免本地时区偏移） */
function parseDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

/** Date → `2026-11-19` */
function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

/** 周六(6) / 周日(0) */
function isWeekend(d) {
  const w = d.getUTCDay();
  return w === 0 || w === 6;
}

/** a、b 之间的工作日（不含 a、b 本身），周末不算 */
function businessDaysBetween(a, b) {
  const out = [];
  const cur = new Date(a.getTime());
  cur.setUTCDate(cur.getUTCDate() + 1);
  while (cur < b) {
    if (!isWeekend(cur)) out.push(new Date(cur.getTime()));
    cur.setUTCDate(cur.getUTCDate() + 1);
  }
  return out;
}

/**
 * a → b 跨了几个工作日（**跨度**，不是缺口数）。
 *
 * 周一→周二 = 1，周三→周五 = 2（周三、周四两个工作日），
 * 周五→周一 = 1（周六周日不算）。
 *
 * 为什么要单独定义：产品的「平时节奏」说的是**跨度**
 * （一个工作日一档 = 跨度 1，隔天一档 = 跨度 2），
 * 而「缺了哪一档」说的是**缺口**（周三→周五缺周四 = 缺口 1）。
 * 两个量混用会算错 —— 一开始就踩了这个坑，
 * 把「平时 1 个工作日一档」显示成了「平时 0 个」。
 */
function businessDaySpan(a, b) {
  return businessDaysBetween(a, b).length + 1;
}

/** 中位数 */
function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((x, y) => x - y);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ---------------------------------------------------------------- 读数据

/** CSV 解析（够用就行：支持引号包裹和字段里的逗号/换行） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field.length || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/** 读 data/ 下所有 CSV → 产品 → 净值档期 */
async function loadProducts() {
  let files = [];
  try {
    files = (await readdir(DATA_DIR)).filter((f) => f.endsWith('.csv')).sort();
  } catch {
    return new Map();
  }
  const products = new Map();
  for (const file of files) {
    const text = await readFile(path.join(DATA_DIR, file), 'utf8');
    const rows = parseCsv(text);
    if (!rows.length) continue;
    const idx = new Map(rows[0].map((h, i) => [h.trim(), i]));
    const ci = idx.get('code');
    const ni = idx.get('nav_date');
    const si = idx.get('snapshot_at');
    if (ci === undefined || ni === undefined) continue;
    for (let i = 1; i < rows.length; i += 1) {
      const cells = rows[i];
      const code = (cells[ci] ?? '').trim();
      const navDate = (cells[ni] ?? '').trim();
      if (!code || !/^\d{4}-\d{2}-\d{2}$/.test(navDate)) continue;
      if (!products.has(code)) {
        products.set(code, { code, name: '', dates: new Map() });
      }
      const p = products.get(code);
      if (!p.name && cells[idx.get('product_name')]) p.name = cells[idx.get('product_name')].trim();
      const snapshotAt = si === undefined ? '' : (cells[si] ?? '').trim();
      // 同一档可能被多轮快照看到 —— 取**最早**看到它的那一轮
      const prev = p.dates.get(navDate);
      if (!prev || (snapshotAt && snapshotAt < prev.snapshotAt)) {
        p.dates.set(navDate, { navDate, snapshotAt });
      }
    }
  }
  return products;
}

/** 读 snapshots/*.jsonl → 快照列表（按时间排） */
async function loadSnapshots() {
  let files = [];
  try {
    files = (await readdir(SNAPSHOT_DIR)).filter((f) => f.endsWith('.jsonl')).sort();
  } catch {
    return [];
  }
  const out = [];
  for (const file of files) {
    const text = await readFile(path.join(SNAPSHOT_DIR, file), 'utf8');
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        out.push(JSON.parse(line));
      } catch {
        // 坏行跳过 —— 清单是辅助材料，不该因为一行坏掉就整个失败
      }
    }
  }
  out.sort((a, b) => String(a.snapshot_at).localeCompare(String(b.snapshot_at)));
  return out;
}

// ---------------------------------------------------------------- 体检逻辑

/**
 * 找出每只产品缺的档期。
 *
 * @param {Map} products 产品 → 档期
 * @param {Map} density 净值日期 → 当天披露的产品数
 * @param {Array} snapshots 快照清单
 */
function findSuspectGaps(products, density, snapshots) {
  const suspect = [];
  for (const p of products.values()) {
    const dates = [...p.dates.keys()].sort();
    if (dates.length < 3) continue; // 记录太少，判断不出「它平时多快」
    const parsed = dates.map((d) => parseDate(d));
    const spans = [];
    for (let i = 1; i < parsed.length; i += 1) {
      spans.push(businessDaySpan(parsed[i - 1], parsed[i]));
    }
    const typical = median(spans);
    // 这个产品本来就不是天天披露的 → 它的「缺档」是正常的
    if (typical > NORMAL_INTERVAL_MAX) continue;

    for (let i = 1; i < parsed.length; i += 1) {
      const prevDate = parsed[i - 1];
      const nextDate = parsed[i];
      const missing = businessDaysBetween(prevDate, nextDate);
      if (!missing.length) continue;
      const span = missing.length + 1;
      if (span <= typical) continue; // 在它平时的节奏之内

      for (const d of missing) {
        const key = fmtDate(d);
        // 那天全库几乎没人披露 → 多半是节假日 / 非披露日，不是我们的问题
        const disclosed = density.get(key) ?? 0;
        if (disclosed < DISCLOSURE_DENSITY_MIN) continue;

        const prevSnapshot = p.dates.get(fmtDate(prevDate))?.snapshotAt ?? '';
        const nextSnapshot = p.dates.get(fmtDate(nextDate))?.snapshotAt ?? '';
        const inWindow = snapshots.filter(
          (s) => s.snapshot_at > prevSnapshot && s.snapshot_at < nextSnapshot,
        );
        // 清单本身是新的 —— 窗口落在清单覆盖范围之前就说不了准话
        const covered = snapshots.length > 0 && prevSnapshot && nextSnapshot
          && snapshots[0].snapshot_at <= prevSnapshot;
        suspect.push({
          code: p.code,
          name: p.name,
          missing_date: key,
          prev_date: fmtDate(prevDate),
          next_date: fmtDate(nextDate),
          gap_business_days: missing.length,
          span,
          typical_interval: typical,
          disclosed_that_day: disclosed,
          snapshots_in_window: inWindow.length,
          window: [prevSnapshot || '(无)', nextSnapshot || '(无)'],
          /** 窗口里跑过快照 = 有机会拍到却没拍到 → 疑似被新批次覆盖 */
          verdict: !covered
            ? 'unknown-no-manifest'
            : inWindow.length > 0
              ? 'suspect-overwritten'
              : 'no-snapshot-in-window',
        });
      }
    }
  }
  return suspect;
}

/** 净值日期 → 当天披露的产品数 */
function buildDensity(products) {
  const density = new Map();
  for (const p of products.values()) {
    for (const d of p.dates.keys()) {
      density.set(d, (density.get(d) ?? 0) + 1);
    }
  }
  return density;
}

// ---------------------------------------------------------------- 主流程

async function main(argv) {
  const opts = parseArgs(argv);

  const products = await loadProducts();
  const snapshots = await loadSnapshots();
  const density = buildDensity(products);

  let suspect = findSuspectGaps(products, density, snapshots);
  if (opts.code) suspect = suspect.filter((s) => s.code === opts.code);

  // 同一个日期缺的产品太多 → 不是某一只产品的问题，是**整批没抓到**
  const byDate = new Map();
  for (const s of suspect) {
    byDate.set(s.missing_date, (byDate.get(s.missing_date) ?? 0) + 1);
  }
  const batchMisses = [...byDate.entries()]
    .filter(([, n]) => n >= 20)
    .sort((a, b) => b[1] - a[1]);

  const stale = [];
  if (opts.staleDays > 0) {
    const today = new Date();
    for (const p of products.values()) {
      const dates = [...p.dates.keys()].sort();
      if (!dates.length) continue;
      const last = parseDate(dates[dates.length - 1]);
      const days = Math.round((today - last) / 86400000);
      if (days >= opts.staleDays) {
        stale.push({ code: p.code, name: p.name, last_date: dates[dates.length - 1], days });
      }
    }
    stale.sort((a, b) => b.days - a.days);
  }

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          products_checked: products.size,
          snapshots: snapshots.length,
          suspect_gaps: suspect,
          batch_misses: batchMisses.map(([date, count]) => ({ date, count })),
          stale_products: stale.slice(0, 200),
          stale_count: stale.length,
        },
        null,
        2,
      ),
    );
  } else if (opts.summary) {
    // 摘要模式 —— 给 CI 看：**清单生效之后**还在丢多少，才说明新机制好不好使。
    //
    // 「清单生效之前」的丢档是历史包袱（清单是新加的），
    // 混在一起看会以为一直在大量丢，其实那些是老账。
    const covered = suspect.filter((s) => s.verdict !== 'unknown-no-manifest');
    const overwritten = covered.filter((s) => s.verdict === 'suspect-overwritten');
    const noSnapshot = covered.filter((s) => s.verdict === 'no-snapshot-in-window');
    console.log('=== 净值丢档体检（摘要）===');
    console.log(`产品 ${products.size} 只　快照 ${snapshots.length} 轮`);
    console.log(`疑似丢档合计 ${suspect.length} 处（清单覆盖期内 ${covered.length} 处）`);
    console.log(`  其中：窗口内跑过快照却没拍到 ${overwritten.length} 处`);
    console.log(`  其中：窗口内压根没跑快照 ${noSnapshot.length} 处`);
    if (batchMisses.length) {
      console.log('批量缺档（同一日期 ≥ 20 只产品同时缺）：');
      for (const [date, count] of batchMisses.slice(0, 5)) {
        console.log(`  ${date}：${count} 只`);
      }
    } else {
      console.log('批量缺档：无');
    }
  } else {
    console.log('=== 净值丢档体检 ===');
    console.log(`产品数：${products.size}　快照轮数：${snapshots.length}　数据日：${[...density.keys()].sort().slice(0, 1)[0] ?? '-'} ~ ${[...density.keys()].sort().slice(-1)[0] ?? '-'}`);
    console.log('');

    if (!suspect.length) {
      console.log('没有发现疑似丢档。');
    } else {
      console.log(`发现 ${suspect.length} 处疑似丢档：`);
      console.log('');
      for (const s of suspect) {
        const verdict =
          s.verdict === 'suspect-overwritten'
            ? `窗口内跑过 ${s.snapshots_in_window} 轮快照 → 有机会拍到却没拍到，疑似被新批次覆盖`
            : s.verdict === 'no-snapshot-in-window'
              ? '窗口内没有快照跑过 → 调度问题（那段时间压根没抓）'
              : '快照清单还没覆盖这段时间 → 判不了（清单是新加的，只覆盖之后）';
        console.log(`  ${s.code}  ${s.name}`);
        console.log(
          `    缺 ${s.missing_date}（${s.prev_date} → ${s.next_date}，跨 ${s.span} 个工作日；平时 ${s.typical_interval} 个工作日一档）`,
        );
        console.log(`    那天全库有 ${s.disclosed_that_day} 只产品披露 → 是个正常披露日`);
        console.log(`    ${verdict}`);
        console.log('');
      }
    }

    if (batchMisses.length) {
      console.log('⚠️ 同一日期大量产品同时缺档 —— 更像是整批没抓到，不是单只产品的问题：');
      for (const [date, count] of batchMisses) {
        console.log(`  ${date}：${count} 只产品同时缺这一档`);
      }
      console.log('');
    }

    if (opts.staleDays > 0) {
      console.log(`=== ${opts.staleDays} 天没披露的产品：${stale.length} 只（只列前 50）===`);
      for (const s of stale.slice(0, 50)) {
        console.log(`  ${s.code}  ${s.days} 天没更新（最后 ${s.last_date}）  ${s.name}`);
      }
      console.log('');
    }
  }

  if (opts.strict && suspect.length > 0) {
    console.error(`::error::发现 ${suspect.length} 处疑似丢档`);
    return 1;
  }
  return 0;
}

process.exitCode = await main(process.argv.slice(2));
