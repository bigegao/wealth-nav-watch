#!/usr/bin/env node
/**
 * 抓**蓝筹 / 高股息**股票的**分红公告** → 生成**日历订阅（ICS）** → 写回本仓库。
 *
 * ## 这条流水线在干什么
 *
 * 1. 按 `config/dividend-watchlist.json` 里的清单（50 只蓝筹 / 高股息），
 *    从东方财富抓两样东西：
 *    - **分红方案**（数据中心 `RPT_SHAREBONUS_DET`）：每笔分红的报告期、预案公告日、
 *      实施公告日、**股权登记日**、**除权除息日**、每 10 股派息、方案进度；
 *    - **分红公告**（公告库 `np-anotice-stock`）：公告标题、披露日、原文链接。
 *    两者按「公告日」对上号：方案的实施公告日 ↔ 公告的披露日。
 * 2. 把结果写成四份文件（都在 `calendar/` 下）：
 *
 *    | 文件 | 内容 |
 *    | --- | --- |
 *    | `dividend-calendar.ics` | **日历订阅**（日历 App 订阅这个地址） |
 *    | `dividend-announcements.json` | 抓到的分红公告（结构化） |
 *    | `dividend-announcements.csv` | 同上（表格，方便瞄一眼） |
 *    | `dividend-plans.json` | 抓到的分红方案（登记日 / 除权日 / 派息） |
 *
 * 3. 产物**提交回仓库**，订阅方用 GitHub raw 直接读：
 *
 *    ```
 *    https://raw.githubusercontent.com/bigegao/wealth-nav-watch/main/calendar/dividend-calendar.ics
 *    ```
 *
 * ## 为什么放在这个仓库、用独立的 action 跑
 *
 * - **要跑得久、要抓得多**。50 只股票 × (1 页方案 + 2~3 页公告) 是上百次请求；
 *   放在有子请求上限的运行时里（比如 Cloudflare Workers 免费版每次调用只有 50 次）直接超限。
 *   GitHub Actions 没有这个限制，能一次把 50 只全抓完（实测约 10 秒）。
 * - **产物要能被订阅**。日历订阅需要一个稳定 URL，
 *   「提交进仓库 → raw 读取」最省事：不依赖服务器，服务挂了订阅也不会断。
 * - **职责单一好排查**。抓取只在这里做 —— 两个地方都抓，
 *   出问题时你分不清数据是哪条路来的。
 *
 * ## 日历里放的是哪两类事件
 *
 * | 分类 | 落点日期 | 是什么 |
 * | --- | --- | --- |
 * | `分红` | 股权登记日（缺省除权除息日） | 这一天是**分红的最后资格日** —— 当天收盘还持有才有这笔钱 |
 * | `公告` | 公告披露日 | 某笔分红的预案 / 实施公告出来了 |
 *
 * 两条都必要：**分红**是提醒（哪天该落袋），**公告**是凭据（这条安排是哪份公告说的，
 * 点事件能直接打开原文）。
 *
 * ## 口径
 *
 * 1. **一条分红方案 = 一个日历条目**，不按日期拆成多条 ——
 *    登记日和除权日差一个交易日，拆两条会让同一笔分红在日历里出现两遍。
 *    两个日期都写在事件的说明里。
 * 2. **落点日期用股权登记日**，没有就退回除权除息日；
 *    两个都没有（只有报告期）**不进日历** —— 报告期不是「哪天除权」。
 *    → **为什么是登记日**：登记日是分红的**资格截止日**（当天收盘持有才拿得到），
 *    拿它当提醒点，提醒的是「这天得在场」；除权日是股价调整的那天，
 *    晚一天，提醒到的已经是「钱在路上了」。
 *    实测 50 只蓝筹 111 条方案里，登记日与除权日**成对出现**（100 条），
 *    登记日从没落在周末、也永远早于除权日 —— 换成登记日不会引入异常落点。
 * 3. **已取消的方案不进日历**（进度含「取消 / 不分配 / 终止」）。
 * 4. **公告事件只留最近 `--announcement-days` 天**（默认 60）——
 *    再往前的公告翻出来只是噪音，方案数据里还留着。
 * 5. **UID 不含金额**：派息额在预案与实施公告之间会改（10 派 4.2 元 → 10 派 4.5 元）。
 *    金额进了 UID，日历 App 会当成两条事件 —— 用户的日历里会同时留着「预计」和「已实施」。
 *    金额写在说明里，同一个 UID 的内容变了，日历 App 会**就地更新**那一条。
 *
 * ## 产物是**幂等**的
 *
 * 文件里**不写「生成时间」**，DTSTAMP 也取自数据本身（公告日 / 方案公告日），
 * 所以**数据没变 → 产物字节级不变 → 仓库不会产生无意义的提交**。
 * 这跟本仓库中行净值那条流水线的「没有新增数据就不产生文件」是同一个思路。
 *
 * 唯一随时间滑动的窗口是 `--history-days`（分红事件的回看天数，默认 30）：
 * 只有当天正好有事件跨过这个边界，文件才会变一次。
 *
 * ## 用法
 *
 * ```bash
 * node scripts/fetch-dividend-calendar.mjs                # 抓取并写产物
 * node scripts/fetch-dividend-calendar.mjs --dry-run      # 只抓不写，打印摘要
 * node scripts/fetch-dividend-calendar.mjs --selftest     # 自测（不联网）
 * node scripts/fetch-dividend-calendar.mjs --codes 600660,600036   # 只抓指定代码
 * node scripts/fetch-dividend-calendar.mjs --history-days 0        # 只留未来的分红事件
 * node scripts/fetch-dividend-calendar.mjs --plan-window-days 2000 # 把方案历史全写进仓库
 * ```
 *
 * 零第三方依赖（只用 Node 内建 `node:https` / `node:dns`），Node 18+ 可跑。
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dns from 'node:dns/promises';
import https from 'node:https';
import http from 'node:http';

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const WATCHLIST_FILE = path.join(REPO, 'config', 'dividend-watchlist.json');
const OUT_DIR = path.join(REPO, 'calendar');

const OUT_ICS = path.join(OUT_DIR, 'dividend-calendar.ics');
const OUT_ANN_JSON = path.join(OUT_DIR, 'dividend-announcements.json');
const OUT_ANN_CSV = path.join(OUT_DIR, 'dividend-announcements.csv');
const OUT_PLANS_JSON = path.join(OUT_DIR, 'dividend-plans.json');

/** 东方财富数据中心（分红方案） */
const PLAN_HOST = 'datacenter-web.eastmoney.com';
const PLAN_API = `https://${PLAN_HOST}/api/data/v1/get`;

/** 东方财富公告库（分红公告原文） */
const NOTICE_HOST = 'np-anotice-stock.eastmoney.com';
const NOTICE_API = `https://${NOTICE_HOST}/api/security/ann`;

const PLAN_COLUMNS = [
  'SECURITY_CODE', 'SECURITY_NAME_ABBR', 'REPORT_DATE', 'PLAN_NOTICE_DATE', 'NOTICE_DATE',
  'EQUITY_RECORD_DATE', 'EX_DIVIDEND_DATE', 'PRETAX_BONUS_RMB', 'BONUS_RATIO', 'IT_RATIO',
  'BONUS_IT_RATIO', 'ASSIGN_PROGRESS', 'IMPL_PLAN_PROFILE',
].join(',');

/** 一次请求里最多带多少只股票的代码 */
const MAX_CODES_PER_REQUEST = 150;

/** 分红方案最多翻多少页（每页 500 行） */
const MAX_PLAN_PAGES = 20;

/** 公告每页多少条、每只股票最多翻几页 */
const NOTICE_PAGE_SIZE = 50;
const NOTICE_MAX_PAGES = 12;

/** 抓公告的并发数（同一主机开太多新连接容易触发限流） */
const CONCURRENCY = 6;

/** 单次请求的重试轮数（每轮把所有候选 IP 试一遍） */
const RETRIES = 3;

/** 单次请求超时（毫秒） */
const REQUEST_TIMEOUT = 30_000;

/** 抓公告的时间窗口（天）。够覆盖「预案 → 实施」的一整轮（3 月预案、6-7 月实施）。 */
const DEFAULT_ANNOUNCEMENT_WINDOW_DAYS = 400;

/**
 * 分红方案写进产物的窗口（天）。默认与公告窗口一致。
 *
 * 为什么要有窗口：上游的方案表是**全历史**（实测 50 只股票 1,197 条，
 * 一路回溯到 2000 年），全量写进仓库有 600 多 KB。
 * 而方案历史**不会消失**（ unlike 中行净值那种「只留最新一条」的归档站），
 * 需要时随时能重抓 —— 所以仓库里只留近期这一段。
 */
const DEFAULT_PLAN_WINDOW_DAYS = DEFAULT_ANNOUNCEMENT_WINDOW_DAYS;

/**
 * 分红事件的历史回看天数（默认 180）。
 *
 * 为什么不是 0：A 股分红高度集中在 6—7 月，11 月打开日历会一片空白
 * （实测当前清单里「落点在今天及之后」的方案 = 0 条）。
 * 留 180 天 = 覆盖最近一轮派息，日历打开就有内容可看。
 *
 * 窗口滑动才让产物变一次（某个事件的落点跨过 180 天那天），
 * 不是每天变 —— 仓库不会因此产生无意义的提交。
 */
const DEFAULT_HISTORY_DAYS = 180;

/** 公告事件在日历里保留的天数 */
const DEFAULT_ANNOUNCEMENT_DAYS = 60;

/**
 * 分红公告的过滤规则。
 *
 * 标题命中即算（实测东方财富的分类名是「分配预案 / 分配方案实施」，
 * 「分红送配」这个分类名反而少见，所以**靠标题**更稳）。
 */
const NOTICE_TITLE_RE = /分红|利润分配|权益分派|派息/;

/** 方案进度里出现这些词 = 已取消，不进日历 */
const CANCELLED_RE = /取消|不分配|终止|作废/;

/** UID 的域名后缀（同一个 UID 在任何日历 App 里都必须唯一） */
const UID_DOMAIN = 'wealth-nav';

const CALENDAR_NAME = '蓝筹分红日历';
const CALENDAR_PROD_ID = '-//wealth-nav-watch//蓝筹分红日历//CN';

/* ------------------------------------------------------------------ *
 * 传输层：钉住 IPv4 的 node:https
 * ------------------------------------------------------------------ */

/**
 * 把错误链压成一行。
 *
 * `fetch` 会把 DNS / TCP / TLS / 超时统统裹成一句 `fetch failed`，
 * 零信息量；这里一层层往下挖（实测有效）。
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

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 解析候选 IP —— **只取 IPv4**。
 *
 * GitHub 托管 runner 在 Azure 上没有可用的 IPv6 出口，
 * 而 `getaddrinfo` 会同时返回 IPv4 和 IPv6（例：`2409:8731:21f:30:11e::11e`），
 * 拿到 IPv6 就 `connect ENETUNREACH` —— 对外只表现成「fetch failed」。
 * 所以这里显式把 IPv6 滤掉。
 */
const ipCache = new Map(); // host → { ips: string[], at: number }
const IP_TTL_MS = 60_000;

async function resolveIPv4(host) {
  const cached = ipCache.get(host);
  if (cached && Date.now() - cached.at < IP_TTL_MS) return cached.ips;
  let list = [];
  try {
    const res = await dns.lookup(host, { all: true });
    list = res.filter((r) => r.family === 4 || r.family === 'IPv4').map((r) => r.address);
  } catch (err) {
    throw new Error(`解析 ${host} 失败：${describeError(err)}`);
  }
  if (!list.length) throw new Error(`解析 ${host} 没有得到 IPv4 地址（只有 IPv6？）`);
  const ips = [...new Set(list)];
  ipCache.set(host, { ips, at: Date.now() });
  return ips;
}

/** 发一次请求（**不跟随重定向**）。`ip` 为 null 表示用系统 DNS。 */
function httpGetOnce(url, ip, timeoutMs) {
  return new Promise((resolve, reject) => {
    const target = new URL(url);
    const isHttps = target.protocol === 'https:';
    const transport = isHttps ? https : http;
    const options = {
      hostname: target.hostname,
      port: target.port || undefined,
      path: target.pathname + target.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; wealth-nav-watch/1.0)',
        Accept: 'application/json, text/plain, */*',
      },
      agent: false,
      timeout: timeoutMs,
    };
    if (isHttps) options.servername = target.hostname;
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
    // TLS socket 可能在请求结束后才抛错 —— 那时没人监听会变成 unhandled 'error' 把进程带崩。
    req.on('socket', (socket) => socket.on('error', () => {}));
    req.end();
  });
}

/** 请求并**跟随重定向**（最多 3 跳）。换域名时不能继续钉原来的 IP。 */
async function httpGet(url, ip, timeoutMs) {
  let current = url;
  let currentIp = ip;
  for (let hop = 0; hop <= 3; hop += 1) {
    const res = await httpGetOnce(current, currentIp, timeoutMs);
    const status = res.status;
    if (status >= 300 && status < 400 && res.headers.location) {
      const next = new URL(res.headers.location, current);
      currentIp = next.hostname === new URL(url).hostname ? ip : null;
      current = next.toString();
      continue;
    }
    return res;
  }
  throw new Error(`重定向次数过多：${url}`);
}

/**
 * 抓一个 JSON，失败就抛错。
 *
 * 重试策略：每轮把所有候选 IP 试一遍，轮与轮之间退避并**重新解析 DNS**
 * （东方财富的节点会轮换）。4xx 不重试（重试没有意义）。
 */
async function fetchJson(url, { headers = {} } = {}) {
  const target = new URL(url);
  const host = target.hostname;
  const attempts = [];
  let ips = await resolveIPv4(host);

  for (let round = 0; round < RETRIES; round += 1) {
    for (const ip of ips) {
      const started = Date.now();
      try {
        const res = await httpGet(url, ip, REQUEST_TIMEOUT);
        const ms = Date.now() - started;
        if (res.status >= 200 && res.status < 300) {
          const text = res.body.toString('utf8');
          try {
            return JSON.parse(text);
          } catch {
            throw new Error('返回内容不是合法 JSON');
          }
        }
        attempts.push(`第${round + 1}轮 ${ip} → HTTP ${res.status}（${ms}ms）`);
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`HTTP ${res.status}（4xx，重试没有意义）`);
        }
      } catch (err) {
        attempts.push(`第${round + 1}轮 ${ip} → ${describeError(err)}（${Date.now() - started}ms）`);
      }
    }
    if (round + 1 < RETRIES) {
      await sleep(1000 * (round + 1) + Math.floor(Math.random() * 500));
      try {
        ips = await resolveIPv4(host);
      } catch {
        /* 沿用上一轮的候选 */
      }
    }
  }
  throw new Error(
    `抓取 ${url} 失败（${RETRIES} 轮 × ${ips.length} 个候选 IP）：\n      - ${attempts.join('\n      - ')}`,
  );
}

/* ------------------------------------------------------------------ *
 * 纯函数：日期 / 口径 / ICS
 * ------------------------------------------------------------------ */

/** 'YYYY-MM-DD HH:mm:ss' / ISO 串 → 'YYYY-MM-DD'（认不出来就 null，不猜） */
export function dateOnly(v) {
  if (v === null || v === undefined || v === '') return null;
  const s = String(v);
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/** 日期加减天数（按 UTC 走，避免本地时区把某天推到前一天） */
export function addDays(date, delta) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + delta);
  return d.toISOString().slice(0, 10);
}

/** 'YYYY-MM-DD' → 'YYYYMMDD' */
export function formatIcsDate(date) {
  return String(date ?? '').replace(/-/g, '');
}

/** 全天事件的 DTEND：次日（**不含**当天） */
export function nextIcsDate(date) {
  return formatIcsDate(addDays(date, 1));
}

/** 'YYYY-MM-DD' → 'YYYYMMDDTHHMMSSZ'（DTSTAMP 必须是 UTC 时间戳） */
export function formatIcsStamp(date) {
  return `${formatIcsDate(date)}T000000Z`;
}

/** 数值解析：空 / 非法 → null（不编 0） */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 分红方案的落点日期。
 *
 * **股权登记日优先**，没有就退回除权除息日。
 *
 * 为什么是登记日：登记日是这笔分红的**资格截止日** ——
 * 当天收盘还持有才有这笔钱（除权日是股价除权调整的那天，晚一个交易日）。
 * 拿登记日当提醒点，提醒的是「这天得在场」。
 *
 * 两个都没有 → null（只有报告期，不是「哪天除权」，不进日历）。
 */
export function planAnchor(plan) {
  if (plan.record_date) return { date: plan.record_date, anchor: 'record', label: '股权登记日' };
  if (plan.ex_date) return { date: plan.ex_date, anchor: 'ex', label: '除权除息日' };
  return { date: null, anchor: 'report', label: '报告期' };
}

/** 方案是不是已取消 */
export function isCancelled(plan) {
  return CANCELLED_RE.test(String(plan.progress ?? ''));
}

/**
 * 一笔分红的 UID。
 *
 * 构成 = 代码 + 报告期 + 登记日 + 除息日（**不含金额**，见文件头的口径 5）。
 */
export function dividendUid(plan) {
  const parts = [plan.code, plan.report_date ?? '', plan.record_date ?? '', plan.ex_date ?? ''];
  return `dividend-${parts.join('-')}@${UID_DOMAIN}`;
}

/** 一条公告的 UID（art_code 是公告库里的唯一编号） */
export function noticeUid(notice) {
  return `notice-${notice.code}-${notice.art_code}@${UID_DOMAIN}`;
}

/**
 * 给方案找对应的公告。
 *
 * 对应关系（实测）：
 *   方案的 `NOTICE_DATE`（实施公告日）      ↔ 公告的披露日
 *   方案的 `PLAN_NOTICE_DATE`（预案公告日） ↔ 公告的披露日
 * 先找实施公告，找不到再退到预案公告 —— 实施公告才是「哪天除权」的最终依据。
 */
export function matchNotice(plan, notices) {
  const byDate = new Map();
  for (const n of notices) {
    if (!n.notice_date) continue;
    const list = byDate.get(n.notice_date);
    if (list) list.push(n);
    else byDate.set(n.notice_date, [n]);
  }
  const pick = (date) => {
    const list = byDate.get(date);
    if (!list || !list.length) return null;
    // 同一可能有多条（预案 + 实施），优先挑「实施」那条
    return list.find((n) => /实施/.test(n.column ?? '')) ?? list[0];
  };
  return pick(plan.notice_date) ?? pick(plan.plan_notice_date) ?? null;
}

/* --- ICS 文本处理（RFC 5545） --- */

/**
 * 转义文本值（RFC 5545 §3.3.11）。
 *
 * 顺序要紧：**先转义反斜杠**，再转义分号与逗号 ——
 * 反过来做会把后加的反斜杠再转义一次，文本就坏了。
 */
export function escapeIcsText(text) {
  return String(text ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r\n|\r|\n/g, '\\n');
}

/**
 * 折行（RFC 5545 §3.1）：每行不超过 75 **字节**。
 *
 * 续行以一个空格开头，所以续行的内容只能占 74 字节。
 * 按字符遍历（不是按字节）—— 折行点落在一个汉字中间会切坏 UTF-8 序列。
 */
export function foldIcsLine(line, limit = 75) {
  const encoder = new TextEncoder();
  const segments = [];
  let current = '';
  let contentBytes = 0;
  let budget = limit;
  for (const ch of Array.from(line)) {
    const size = encoder.encode(ch).length;
    if (contentBytes + size > budget) {
      segments.push(current);
      current = ch;
      contentBytes = size;
      budget = limit - 1;
    } else {
      current += ch;
      contentBytes += size;
    }
  }
  segments.push(current);
  return segments.join('\r\n ');
}

/**
 * 生成一份 ICS 日历。
 *
 * 事件的顺序按传入顺序写（调用方排好序）。
 * **产物必须是输入的纯函数** —— 不写「生成时间」，这样数据没变时文件字节级不变。
 */
export function buildIcsFeed(events, options = {}) {
  const name = options.name ?? CALENDAR_NAME;
  const prodId = options.prodId ?? CALENDAR_PROD_ID;

  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    `PRODID:${prodId}`,
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeIcsText(name)}`,
    `X-WR-CALDESC:${escapeIcsText(options.desc ?? '蓝筹 / 高股息股票的分红日历：股权登记日与分红公告')}`,
    // 告诉日历 App 多久回源一次（GitHub raw 有 CDN 缓存，6 小时足够）
    'REFRESH-INTERVAL;VALUE=DURATION:PT6H',
    'X-PUBLISHED-TTL:PT6H',
  ];

  for (const event of events) {
    const date = formatIcsDate(event.date);
    // 日期不合法就不写这一条 —— 宁可少一条，也不要给日历 App 一个坏事件
    if (!/^\d{8}$/.test(date)) continue;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${escapeIcsText(event.uid)}`);
    lines.push(`DTSTAMP:${event.stamp}`);
    lines.push(`DTSTART;VALUE=DATE:${date}`);
    lines.push(`DTEND;VALUE=DATE:${nextIcsDate(event.date)}`);
    lines.push(`SUMMARY:${escapeIcsText(event.summary)}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeIcsText(event.description)}`);
    if (event.category) lines.push(`CATEGORIES:${escapeIcsText(event.category)}`);
    // URL 是 URI 属性，不套 TEXT 的转义规则
    if (event.url) lines.push(`URL:${event.url}`);
    for (const [key, value] of Object.entries(event.extra ?? {})) {
      lines.push(`${key}:${escapeIcsText(value)}`);
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return `${lines.map((line) => foldIcsLine(line)).join('\r\n')}\r\n`;
}

/* ------------------------------------------------------------------ *
 * 抓取
 * ------------------------------------------------------------------ */

/** 读清单 */
export async function loadWatchlist() {
  const raw = await readFile(WATCHLIST_FILE, 'utf8');
  const parsed = JSON.parse(raw);
  const stocks = Array.isArray(parsed?.stocks) ? parsed.stocks : [];
  const out = [];
  const seen = new Set();
  for (const s of stocks) {
    const code = String(s?.code ?? '').trim();
    if (!/^\d{6}$/.test(code) || seen.has(code)) continue;
    seen.add(code);
    out.push({ code, name: String(s?.name ?? '').trim() });
  }
  if (!out.length) throw new Error(`清单是空的：${WATCHLIST_FILE}`);
  return out;
}

/** 一行原始数据 → 分红方案 */
export function toPlan(row) {
  const code = String(row.SECURITY_CODE ?? '').trim();
  return {
    code,
    name: String(row.SECURITY_NAME_ABBR ?? '').trim(),
    report_date: dateOnly(row.REPORT_DATE) ?? '',
    plan_notice_date: dateOnly(row.PLAN_NOTICE_DATE),
    notice_date: dateOnly(row.NOTICE_DATE),
    record_date: dateOnly(row.EQUITY_RECORD_DATE),
    ex_date: dateOnly(row.EX_DIVIDEND_DATE),
    pretax_per10: numOrNull(row.PRETAX_BONUS_RMB),
    bonus_per10: numOrNull(row.BONUS_RATIO),
    transfer_per10: numOrNull(row.IT_RATIO),
    bonus_it_per10: numOrNull(row.BONUS_IT_RATIO),
    progress: row.ASSIGN_PROGRESS ? String(row.ASSIGN_PROGRESS).trim() : null,
    profile: row.IMPL_PLAN_PROFILE ? String(row.IMPL_PLAN_PROFILE).trim() : null,
    source: 'eastmoney',
  };
}

/**
 * 抓一批代码的分红方案（一页）。
 *
 * 一次请求带 N 只代码：上游的 filter 支持 `SECURITY_CODE in (...)`，
 * 而请求行有长度上限（实测约 7.6 KB → 约 470 只就会 400/414），所以分片。
 */
async function fetchPlanPage(codes, pageNumber) {
  const list = [...new Set(codes.map((c) => String(c ?? '').trim()).filter(Boolean))];
  const filter =
    list.length === 1
      ? `(SECURITY_CODE="${list[0]}")`
      : `(SECURITY_CODE in ("${list.join('","')}"))`;
  const url =
    `${PLAN_API}?reportName=RPT_SHAREBONUS_DET&columns=${encodeURIComponent(PLAN_COLUMNS)}` +
    `&pageNumber=${pageNumber}&pageSize=500&sortColumns=REPORT_DATE&sortTypes=-1&filter=${encodeURIComponent(filter)}`;

  const payload = await fetchJson(url, { headers: { Referer: 'https://data.eastmoney.com/' } });
  return payload ?? {};
}

/**
 * 抓一批代码的全部分红方案（内部按页翻）。
 *
 * 翻页结束的判据：**空页**才是真正的结束信号。
 * 上游偶尔给出 0 / 负数 / 非数字的页数 —— 那时候不能当成「一页就翻完了」，
 * 否则没抓到的代码会被误判成「没有分红记录」。
 */
async function fetchPlansForChunk(codes) {
  const byCode = new Map();
  let finished = false;

  for (let page = 1; page <= MAX_PLAN_PAGES; page += 1) {
    const payload = await fetchPlanPage(codes, page);

    if (payload?.success === false) {
      // 9201 = 「这一页没有数据」。第一页才说明整批都没记录；
      // 翻页途中遇到它只是「翻完了」。
      if (payload.code === 9201) {
        finished = page === 1;
        break;
      }
      throw new Error(`分红数据源返回错误（code=${payload.code}）：${payload.message ?? '未知错误'}`);
    }

    const result = payload?.result;
    if (!result || !Array.isArray(result.data)) {
      throw new Error('分红数据源返回结构异常（缺少 result.data）');
    }
    for (const row of result.data) {
      const plan = toPlan(row);
      if (!plan.code) continue;
      const list = byCode.get(plan.code);
      if (list) list.push(plan);
      else byCode.set(plan.code, [plan]);
    }

    if (result.data.length === 0) {
      finished = true; // 空页 = 翻完了
      break;
    }
    const pages = Number(result.pages);
    if (Number.isFinite(pages) && pages >= 1 && page >= Math.floor(pages)) {
      finished = true; // 翻完了上游说的页数
      break;
    }
  }

  return { byCode, finished };
}

/** 抓所有代码的分红方案 */
export async function fetchAllPlans(codes) {
  const chunks = [];
  for (let i = 0; i < codes.length; i += MAX_CODES_PER_REQUEST) {
    chunks.push(codes.slice(i, i + MAX_CODES_PER_REQUEST));
  }
  const byCode = new Map();
  for (const chunk of chunks) {
    const { byCode: chunkPlans } = await fetchPlansForChunk(chunk);
    for (const [code, plans] of chunkPlans.entries()) {
      const list = byCode.get(code) ?? [];
      list.push(...plans);
      byCode.set(code, list);
    }
  }
  for (const list of byCode.values()) {
    list.sort((a, b) =>
      a.report_date === b.report_date
        ? a.code.localeCompare(b.code)
        : a.report_date < b.report_date
          ? 1
          : -1,
    );
  }
  return byCode;
}

/**
 * 抓一只股票的分红公告。
 *
 * 公告库支持 `begin_time` / `end_time` —— **按时间窗口抓**，
 * 比一页页往前翻省得多（实测：600660 全部公告 1945 条，
 * 限定 11 个月就只剩 112 条）。
 */
async function fetchNoticesForCode(code, beginTime, endTime) {
  const out = [];
  const seen = new Set();
  for (let page = 1; page <= NOTICE_MAX_PAGES; page += 1) {
    const url =
      `${NOTICE_API}?sr=-1&page_size=${NOTICE_PAGE_SIZE}&page_index=${page}` +
      `&ann_type=A&client_source=web&stock_list=${encodeURIComponent(code)}&f_node=0&s_node=0` +
      `&begin_time=${encodeURIComponent(beginTime)}&end_time=${encodeURIComponent(endTime)}`;
    const payload = await fetchJson(url, { headers: { Referer: 'https://data.eastmoney.com/' } });
    const list = payload?.data?.list;
    if (!Array.isArray(list) || list.length === 0) break;

    let added = 0;
    for (const item of list) {
      const artCode = String(item?.art_code ?? '').trim();
      if (!artCode || seen.has(artCode)) continue;
      const title = String(item?.title ?? '').trim();
      const column = String(item?.columns?.[0]?.column_name ?? '').trim();
      if (!NOTICE_TITLE_RE.test(title) && column !== '分红送配') continue;
      seen.add(artCode);
      added += 1;
      out.push({
        code,
        art_code: artCode,
        title,
        column,
        notice_date: dateOnly(item?.notice_date ?? item?.display_time),
        url: `https://data.eastmoney.com/notices/detail/${code}/${artCode}.html`,
        source: 'eastmoney_notice',
      });
    }
    // 这一页一条分红公告都没有 → 再往后翻也是白翻（公告按时间倒序，越往后越旧）
    if (added === 0 && page > 1) break;
    if (list.length < NOTICE_PAGE_SIZE) break;
  }
  out.sort((a, b) => (a.notice_date === b.notice_date ? 0 : a.notice_date < b.notice_date ? 1 : -1));
  return out;
}

/** 限制并发地跑一批任务 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    for (;;) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

/* ------------------------------------------------------------------ *
 * 事件构造
 * ------------------------------------------------------------------ */

/** 一笔分红方案 → 日历事件 */
export function planToEvent(plan, notice, name) {
  const anchor = planAnchor(plan);
  if (!anchor.date) return null;
  const label = name || plan.name || plan.code;

  const lines = [];
  lines.push(`${plan.code} ${label}`);
  lines.push(`报告期 ${plan.report_date || '未知'}`);
  if (plan.record_date) lines.push(`股权登记日 ${plan.record_date}`);
  if (plan.ex_date) lines.push(`除权除息日 ${plan.ex_date}`);
  if (plan.pretax_per10 != null) lines.push(`每 10 股派息 ${plan.pretax_per10} 元（含税）`);
  if (plan.bonus_per10 != null || plan.transfer_per10 != null) {
    const bonus = plan.bonus_per10 ?? 0;
    const transfer = plan.transfer_per10 ?? 0;
    if (bonus || transfer) lines.push(`每 10 股送转 ${bonus + transfer} 股`);
  }
  if (plan.progress) lines.push(`方案进度：${plan.progress}`);
  if (plan.profile) lines.push(`方案摘要：${plan.profile}`);
  if (notice) {
    lines.push('');
    lines.push(`公告：${notice.title}`);
    lines.push(notice.url);
  } else {
    lines.push('');
    lines.push('未匹配到对应的分红公告原文');
  }

  // DTSTAMP 取数据自身的时间（不是「现在」）—— 产物才能字节级幂等
  const stampDate = plan.notice_date || plan.plan_notice_date || plan.report_date || anchor.date;

  return {
    date: anchor.date,
    uid: dividendUid(plan),
    stamp: formatIcsStamp(stampDate),
    summary: `${label} ${anchor.label}`,
    description: lines.join('\n'),
    category: '分红',
    url: notice?.url ?? '',
    extra: {
      'X-WEALTH-CODE': plan.code,
      'X-WEALTH-DATE-KIND': anchor.label,
      'X-WEALTH-PROGRESS': plan.progress ?? '',
    },
  };
}

/** 一条分红公告 → 日历事件 */
export function noticeToEvent(notice, name) {
  if (!notice.notice_date) return null;
  const label = name || notice.code;
  const kind = /实施/.test(notice.column ?? '')
    ? '实施公告'
    : /预案/.test(notice.column ?? '')
      ? '分配预案'
      : '分红公告';
  const lines = [
    `${notice.code} ${label}`,
    notice.title,
    `公告类型：${notice.column || kind}`,
    notice.url,
  ];
  return {
    date: notice.notice_date,
    uid: noticeUid(notice),
    stamp: formatIcsStamp(notice.notice_date),
    summary: `${label} ${kind}`,
    description: lines.join('\n'),
    category: '公告',
    url: notice.url,
    extra: {
      'X-WEALTH-CODE': notice.code,
      'X-WEALTH-ART-CODE': notice.art_code,
    },
  };
}

/* ------------------------------------------------------------------ *
 * 写文件
 * ------------------------------------------------------------------ */

/** 内容没变就不写 —— 避免仓库产生无意义的提交 */
async function writeIfChanged(file, content) {
  let old = null;
  try {
    old = await readFile(file, 'utf8');
  } catch {
    old = null;
  }
  if (old === content) return false;
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content, 'utf8');
  return true;
}

/** CSV 转义（含逗号 / 引号 / 换行的字段要加引号） */
export function csvCell(value) {
  const s = value === null || value === undefined ? '' : String(value);
  if (/[",\r\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

/* ------------------------------------------------------------------ *
 * 主流程
 * ------------------------------------------------------------------ */

export function parseArgs(argv) {
  const opts = {
    dryRun: false,
    selftest: false,
    historyDays: DEFAULT_HISTORY_DAYS,
    announcementDays: DEFAULT_ANNOUNCEMENT_DAYS,
    announcementWindowDays: DEFAULT_ANNOUNCEMENT_WINDOW_DAYS,
    planWindowDays: DEFAULT_PLAN_WINDOW_DAYS,
    codes: null,
    asOf: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const next = () => argv[++i];
    switch (arg) {
      case '--dry-run':
        opts.dryRun = true;
        break;
      case '--selftest':
        opts.selftest = true;
        break;
      case '--history-days':
        opts.historyDays = Number(next());
        break;
      case '--announcement-days':
        opts.announcementDays = Number(next());
        break;
      case '--announcement-window-days':
        opts.announcementWindowDays = Number(next());
        break;
      case '--plan-window-days':
        opts.planWindowDays = Number(next());
        break;
      case '--codes':
        opts.codes = String(next() ?? '')
          .split(',')
          .map((c) => c.trim())
          .filter(Boolean);
        break;
      case '--as-of':
        opts.asOf = String(next() ?? '');
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }
  return opts;
}

/** 北京时间的今天（抓取日） */
export function todayInBeijing(now = new Date()) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(now);
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.selftest) {
    const { runSelftest } = await import('./selftest.mjs');
    const ok = await runSelftest();
    process.exit(ok ? 0 : 1);
  }

  const asOf = opts.asOf && /^\d{4}-\d{2}-\d{2}$/.test(opts.asOf) ? opts.asOf : todayInBeijing();
  const watchlist = await loadWatchlist();
  const stocks = opts.codes?.length
    ? watchlist.filter((s) => opts.codes.includes(s.code))
    : watchlist;
  if (!stocks.length) throw new Error('没有匹配的代码');

  console.log(
    `== 抓取 ${stocks.length} 只股票（清单 ${watchlist.length} 只）· 抓取日 ${asOf}（北京）==`,
  );

  // 1) 分红方案
  const codes = stocks.map((s) => s.code);
  console.log('-- 抓分红方案 --');
  const plansByCode = await fetchAllPlans(codes);
  const planCount = [...plansByCode.values()].reduce((s, l) => s + l.length, 0);
  console.log(`   方案 ${planCount} 条，覆盖 ${plansByCode.size} 只`);

  // 2) 分红公告（按时间窗口抓）
  const beginDate = addDays(asOf, -opts.announcementWindowDays);
  console.log(`-- 抓分红公告（${beginDate} ~ ${asOf}）--`);
  const names = new Map(stocks.map((s) => [s.code, s.name]));
  const noticeResults = await mapLimit(stocks, CONCURRENCY, async (s) => {
    const list = await fetchNoticesForCode(s.code, beginDate, asOf);
    console.log(`   ${s.code} ${s.name}：${list.length} 条`);
    return list;
  });
  const noticesByCode = new Map();
  noticeResults.forEach((list, i) => noticesByCode.set(stocks[i].code, list));
  const noticeCount = noticeResults.reduce((s, l) => s + l.length, 0);
  console.log(`   公告合计 ${noticeCount} 条`);

  // 3) 拼事件
  const events = [];
  const historyFrom = addDays(asOf, -opts.historyDays);
  const announcementFrom = addDays(asOf, -opts.announcementDays);

  for (const s of stocks) {
    const plans = plansByCode.get(s.code) ?? [];
    const notices = noticesByCode.get(s.code) ?? [];
    for (const plan of plans) {
      if (isCancelled(plan)) continue;
      const anchor = planAnchor(plan);
      if (!anchor.date) continue; // 只有报告期 = 不是「哪天除权」，不进日历
      if (anchor.date < historyFrom) continue; // 窗口外的历史不进日历
      const notice = matchNotice(plan, notices);
      const event = planToEvent(plan, notice, s.name);
      if (event) events.push(event);
    }
  }

  for (const s of stocks) {
    const notices = noticesByCode.get(s.code) ?? [];
    for (const notice of notices) {
      if (!notice.notice_date || notice.notice_date < announcementFrom) continue;
      if (notice.notice_date > asOf) continue;
      const event = noticeToEvent(notice, s.name);
      if (event) events.push(event);
    }
  }

  events.sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    if (a.category !== b.category) return a.category === '分红' ? -1 : 1;
    return a.uid < b.uid ? -1 : 1;
  });

  const dividendEvents = events.filter((e) => e.category === '分红');
  const noticeEvents = events.filter((e) => e.category === '公告');
  console.log(
    `== 事件：分红 ${dividendEvents.length} 条 + 公告 ${noticeEvents.length} 条 = ${events.length} 条 ==`,
  );
  for (const e of dividendEvents.slice(0, 10)) {
    console.log(`   [分红] ${e.date} ${e.summary}`);
  }

  // 4) 产物
  const ics = buildIcsFeed(events);
  const allNotices = [];
  for (const s of stocks) {
    for (const n of noticesByCode.get(s.code) ?? []) {
      allNotices.push({ ...n, name: s.name });
    }
  }
  allNotices.sort((a, b) =>
    a.notice_date === b.notice_date
      ? a.code.localeCompare(b.code)
      : a.notice_date < b.notice_date
        ? 1
        : -1,
  );

  const planCutoff = addDays(asOf, -opts.planWindowDays);
  const allPlans = [];
  for (const s of stocks) {
    for (const p of plansByCode.get(s.code) ?? []) {
      // 窗口判定看「最晚的那个日期」—— 一笔方案只要在窗口内有过动作就留下
      const latest = [p.notice_date, p.plan_notice_date, p.record_date, p.ex_date, p.report_date]
        .filter(Boolean)
        .sort()
        .pop();
      if (!latest || latest < planCutoff) continue;
      const notice = matchNotice(p, noticesByCode.get(s.code) ?? []);
      allPlans.push({
        ...p,
        name: s.name || p.name,
        notice_title: notice?.title ?? null,
        notice_url: notice?.url ?? null,
      });
    }
  }

  const annJson = `${JSON.stringify({ announcements: allNotices }, null, 2)}\n`;
  const plansJson = `${JSON.stringify({ plans: allPlans }, null, 2)}\n`;
  const csvHeader = 'code,name,notice_date,column,title,art_code,url';
  const csvRows = allNotices.map((n) =>
    [n.code, n.name, n.notice_date, n.column, n.title, n.art_code, n.url].map(csvCell).join(','),
  );
  const annCsv = `${[csvHeader, ...csvRows].join('\n')}\n`;

  if (opts.dryRun) {
    console.log('-- dry-run：不写文件 --');
    console.log(`ICS ${ics.length} 字节 / ${events.length} 个事件`);
    return;
  }

  const changed = [];
  if (await writeIfChanged(OUT_ICS, ics)) changed.push(path.relative(REPO, OUT_ICS));
  if (await writeIfChanged(OUT_ANN_JSON, annJson)) changed.push(path.relative(REPO, OUT_ANN_JSON));
  if (await writeIfChanged(OUT_ANN_CSV, annCsv)) changed.push(path.relative(REPO, OUT_ANN_CSV));
  if (await writeIfChanged(OUT_PLANS_JSON, plansJson)) changed.push(path.relative(REPO, OUT_PLANS_JSON));

  if (changed.length) {
    console.log(`-- 已写入：${changed.join('、')} --`);
  } else {
    console.log('-- 数据没变，产物保持原样（仓库不会产生提交）--');
  }
}

// 直接运行时才执行（被 import 时不跑）
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error(`::error::${err?.message ?? err}`);
    if (err?.stack) console.error(err.stack);
    process.exit(1);
  });
}
