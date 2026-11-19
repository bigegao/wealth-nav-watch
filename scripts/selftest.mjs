/**
 * `fetch-dividend-calendar.mjs` 的自测 —— **不联网**，只测纯函数。
 *
 * 为什么要有它：日历订阅的错误**在抓取阶段看不出来**。
 * 一行超了 75 字节、UID 变了、转义顺序写反了 —— 数据照样抓到，
 * 但用户的日历 App 里会多出重复事件、或者干脆收不到。
 * 这些行为只在特定输入下才复现，光靠「本地跑一次抓取」抓不到。
 *
 * 用法：`node scripts/fetch-dividend-calendar.mjs --selftest`
 */

import {
  addDays,
  buildIcsFeed,
  csvCell,
  dateOnly,
  dividendUid,
  escapeIcsText,
  foldIcsLine,
  formatIcsDate,
  formatIcsStamp,
  isCancelled,
  matchNotice,
  nextIcsDate,
  noticeUid,
  noticeToEvent,
  planAnchor,
  planToEvent,
} from './fetch-dividend-calendar.mjs';

let passed = 0;
let failed = 0;

/** 断言：条件为真 */
function ok(name, cond, detail) {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`);
  }
}

/** 断言：两个值相等 */
function eq(name, actual, expected) {
  const same = JSON.stringify(actual) === JSON.stringify(expected);
  ok(name, same, same ? '' : `实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}`);
}

/** 断言：函数抛错 */
function throws(name, fn) {
  try {
    fn();
    ok(name, false, '没有抛错');
  } catch {
    ok(name, true);
  }
}

/* ------------------------------------------------------------------ *
 * ICS 结构校验
 * ------------------------------------------------------------------ */

/**
 * 校验一份 ICS 的结构，返回问题清单（空 = 合格）。
 *
 * 查的是**物理行**（折行后的每一行），因为 RFC 5545 限的是「一行的字节数」。
 */
export function validateIcs(text) {
  const problems = [];
  const bytes = Buffer.from(text, 'utf8');

  if (!text.endsWith('\r\n')) problems.push('文件没有以 CRLF 结尾');
  if (text.includes('\n') && !/(^|[^\r])\n/.test(text) === false) {
    // 有裸 LF（不是 CRLF 的一部分）
  }
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n' && text[i - 1] !== '\r') {
      problems.push(`第 ${i} 个字符处有裸 LF（必须用 CRLF）`);
      break;
    }
  }

  const physical = text.split('\r\n');
  for (const line of physical) {
    if (Buffer.byteLength(line, 'utf8') > 75) {
      problems.push(`有一行超过 75 字节：${line.slice(0, 40)}…`);
      break;
    }
  }

  // 折行还原：续行（以空格开头）接回上一行
  const logical = [];
  for (const line of physical) {
    if (line.length === 0) continue;
    if (line.startsWith(' ')) {
      if (!logical.length) problems.push('文件以续行开头');
      else logical[logical.length - 1] += line.slice(1);
    } else {
      logical.push(line);
    }
  }

  const depth = { vcalendar: 0, vevent: 0 };
  const events = [];
  let current = null;
  for (const line of logical) {
    const name = line.split(':')[0];
    if (line === 'BEGIN:VCALENDAR') depth.vcalendar += 1;
    else if (line === 'END:VCALENDAR') depth.vcalendar -= 1;
    else if (line === 'BEGIN:VEVENT') {
      depth.vevent += 1;
      current = {};
    } else if (line === 'END:VEVENT') {
      depth.vevent -= 1;
      events.push(current ?? {});
      current = null;
    } else if (current && name.includes(';')) {
      current[name.split(';')[0]] = line.slice(line.indexOf(':') + 1);
    } else if (current) {
      current[name] = line.slice(line.indexOf(':') + 1);
    }
  }
  if (depth.vcalendar !== 0) problems.push('VCALENDAR 的 BEGIN/END 不配对');
  if (depth.vevent !== 0) problems.push('VEVENT 的 BEGIN/END 不配对');

  for (const [i, ev] of events.entries()) {
    for (const field of ['UID', 'DTSTAMP', 'DTSTART', 'DTEND', 'SUMMARY']) {
      if (!ev[field]) problems.push(`第 ${i + 1} 个事件缺 ${field}`);
    }
    if (ev.DTSTART && !/^\d{8}$/.test(ev.DTSTART)) {
      problems.push(`第 ${i + 1} 个事件的 DTSTART 不是 YYYYMMDD：${ev.DTSTART}`);
    }
    if (ev.DTSTAMP && !/^\d{8}T\d{6}Z$/.test(ev.DTSTAMP)) {
      problems.push(`第 ${i + 1} 个事件的 DTSTAMP 格式不对：${ev.DTSTAMP}`);
    }
  }

  const uids = events.map((e) => e.UID);
  if (new Set(uids).size !== uids.length) problems.push('有重复的 UID');

  void bytes;
  return problems;
}

/* ------------------------------------------------------------------ *
 * 用例
 * ------------------------------------------------------------------ */

function testEscape() {
  console.log('-- 转义（RFC 5545 §3.3.11）--');
  eq('分号被转义', escapeIcsText('a;b'), 'a\\;b');
  eq('逗号被转义', escapeIcsText('a,b'), 'a\\,b');
  eq('换行变成 \\n', escapeIcsText('a\nb'), 'a\\nb');
  // 顺序：先转义反斜杠，再转义分号 —— 反过来会把新加的反斜杠再转义一次
  eq('反斜杠先转义', escapeIcsText('a\\b'), 'a\\\\b');
  eq('反斜杠不会被二次转义', escapeIcsText('a\\;b'), 'a\\\\\\;b');
  eq('空值', escapeIcsText(''), '');
  eq('null', escapeIcsText(null), '');
}

function testFold() {
  console.log('-- 折行（每行 ≤ 75 字节）--');
  const long = `SUMMARY:${'分'.repeat(100)}`;
  const folded = foldIcsLine(long);
  const lines = folded.split('\r\n');
  ok('每一行都不超过 75 字节', lines.every((l) => Buffer.byteLength(l, 'utf8') <= 75));
  ok('续行以一个空格开头', lines.slice(1).every((l) => l.startsWith(' ')));
  const rejoined = lines.map((l, i) => (i === 0 ? l : l.slice(1))).join('');
  eq('折行还原后内容不变', rejoined, long);
  // 折行点落在一个汉字中间会切坏 UTF-8 序列 → 解码时出现替换字符 U+FFFD
  ok('折行不会切坏 UTF-8', !folded.includes('\uFFFD'));

  const ascii = 'SUMMARY:' + 'x'.repeat(200);
  const asciiLines = foldIcsLine(ascii).split('\r\n');
  ok('纯 ASCII 也能折', asciiLines.length > 1);
  ok(
    '纯 ASCII 折行后每行 ≤ 75 字节',
    asciiLines.every((l) => Buffer.byteLength(l, 'utf8') <= 75),
  );
  eq(
    '纯 ASCII 折行还原',
    asciiLines.map((l, i) => (i === 0 ? l : l.slice(1))).join(''),
    ascii,
  );
}

function testDates() {
  console.log('-- 日期 --');
  eq('带时分秒', dateOnly('2026-09-17 00:00:00'), '2026-09-17');
  eq('带时分秒（非零）', dateOnly('2026-09-17 13:45:59'), '2026-09-17');
  eq('纯日期', dateOnly('2026-09-17'), '2026-09-17');
  eq('空值', dateOnly(''), null);
  eq('null', dateOnly(null), null);
  eq('认不出来就不猜', dateOnly('not-a-date'), null);

  eq('加一天', addDays('2026-09-17', 1), '2026-09-18');
  eq('跨月', addDays('2026-09-30', 1), '2026-10-01');
  eq('跨年', addDays('2026-12-31', 1), '2027-01-01');
  eq('减三十天', addDays('2026-03-01', -30), '2026-01-30');
  eq('闰年 2 月', addDays('2024-02-28', 1), '2024-02-29');

  eq('ICS 日期', formatIcsDate('2026-09-17'), '20260917');
  eq('DTEND 是次日', nextIcsDate('2026-09-17'), '20260918');
  eq('DTSTAMP 格式', formatIcsStamp('2026-09-17'), '20260917T000000Z');
}

function testAnchor() {
  console.log('-- 落点日期 --');
  eq(
    '优先股权登记日（分红的资格截止日）',
    planAnchor({ ex_date: '2026-09-24', record_date: '2026-09-23' }),
    { date: '2026-09-23', anchor: 'record', label: '股权登记日' },
  );
  eq(
    '没有登记日就退到除权除息日',
    planAnchor({ ex_date: '2026-09-24', record_date: null }),
    { date: '2026-09-24', anchor: 'ex', label: '除权除息日' },
  );
  eq('两个都没有 → null（只有报告期不进日历）', planAnchor({ ex_date: null, record_date: null }).date, null);

  ok('取消', isCancelled({ progress: '取消分配' }));
  ok('不分配', isCancelled({ progress: '不分配' }));
  ok('终止', isCancelled({ progress: '终止实施' }));
  ok('实施分配不算取消', !isCancelled({ progress: '实施分配' }));
  ok('董事会决议通过不算取消', !isCancelled({ progress: '董事会决议通过' }));
}

function testUid() {
  console.log('-- UID --');
  const plan = {
    code: '600660',
    report_date: '2026-06-30',
    record_date: '2026-09-23',
    ex_date: '2026-09-24',
    pretax_per10: 10,
  };
  const uid = dividendUid(plan);
  ok('UID 不含金额', !uid.includes('10'), uid);
  ok('UID 稳定', uid === dividendUid({ ...plan }));
  ok(
    '金额变了 UID 不变（日历 App 就地更新，而不是多一条）',
    uid === dividendUid({ ...plan, pretax_per10: 12.5 }),
  );
  ok(
    '登记日变了 UID 才变',
    uid !== dividendUid({ ...plan, record_date: '2026-09-22' }),
  );
  ok('公告 UID 用 art_code', noticeUid({ code: '600660', art_code: 'AN2026' }).includes('AN2026'));
}

function testMatchNotice() {
  console.log('-- 方案 ↔ 公告 对应 --');
  const notices = [
    { code: '600660', art_code: 'A1', notice_date: '2026-08-19', column: '分配预案', title: '预案' },
    { code: '600660', art_code: 'A2', notice_date: '2026-09-17', column: '分配方案实施', title: '实施' },
  ];
  eq(
    '优先匹配实施公告日',
    matchNotice({ notice_date: '2026-09-17', plan_notice_date: '2026-08-19' }, notices)?.art_code,
    'A2',
  );
  eq(
    '实施公告缺了退到预案公告日',
    matchNotice({ notice_date: null, plan_notice_date: '2026-08-19' }, notices)?.art_code,
    'A1',
  );
  eq('都没有 → null', matchNotice({ notice_date: '2026-01-01' }, notices), null);
  eq('公告为空 → null', matchNotice({ notice_date: '2026-09-17' }, []), null);
}

function testEvents() {
  console.log('-- 事件 --');
  const plan = {
    code: '600660',
    name: '福耀玻璃',
    report_date: '2026-06-30',
    plan_notice_date: '2026-08-19',
    notice_date: '2026-09-17',
    record_date: '2026-09-23',
    ex_date: '2026-09-24',
    pretax_per10: 10,
    bonus_per10: null,
    transfer_per10: null,
    progress: '实施分配',
    profile: '10派10.00元(含税)',
  };
  const notice = {
    code: '600660',
    art_code: 'AN2026',
    notice_date: '2026-09-17',
    column: '分配方案实施',
    title: '福耀玻璃2026年半年度A股权益分派实施公告',
    url: 'https://data.eastmoney.com/notices/detail/600660/AN2026.html',
  };

  const event = planToEvent(plan, notice, '福耀玻璃');
  eq('落点 = 股权登记日', event.date, '2026-09-23');
  eq('标题', event.summary, '福耀玻璃 股权登记日');
  eq('分类', event.category, '分红');
  ok('说明里有登记日', event.description.includes('股权登记日 2026-09-23'));
  ok('说明里有除权日', event.description.includes('除权除息日 2026-09-24'));
  ok('说明里有派息', event.description.includes('每 10 股派息 10 元'));
  ok('说明里有公告链接', event.description.includes(notice.url));
  eq('URL 是公告原文', event.url, notice.url);
  eq('DTSTAMP 取自数据（不是「现在」）', event.stamp, '20260917T000000Z');

  eq('只有报告期 → 不产生事件', planToEvent({ ...plan, ex_date: null, record_date: null }, null, 'x'), null);

  const nEvent = noticeToEvent(notice, '福耀玻璃');
  eq('公告事件落在披露日', nEvent.date, '2026-09-17');
  eq('公告事件分类', nEvent.category, '公告');
  eq('公告事件标题带类型', nEvent.summary, '福耀玻璃 实施公告');
  eq('公告事件 URL', nEvent.url, notice.url);
}

function testIcs() {
  console.log('-- ICS 结构 --');
  const events = [
    {
      date: '2026-09-24',
      uid: 'dividend-600660-2026-06-30-2026-09-23-2026-09-24@wealth-nav',
      stamp: '20260917T000000Z',
      summary: '福耀玻璃 除权除息日',
      description: '600660 福耀玻璃\n每 10 股派息 10 元',
      category: '分红',
      url: 'https://data.eastmoney.com/notices/detail/600660/AN2026.html',
      extra: { 'X-WEALTH-CODE': '600660' },
    },
    {
      date: '2026-09-17',
      uid: 'notice-600660-AN2026@wealth-nav',
      stamp: '20260917T000000Z',
      summary: '福耀玻璃 实施公告',
      description: '600660 福耀玻璃\n福耀玻璃2026年半年度A股权益分派实施公告',
      category: '公告',
      url: 'https://data.eastmoney.com/notices/detail/600660/AN2026.html',
    },
  ];

  const ics = buildIcsFeed(events);
  eq('结构合格', validateIcs(ics), []);
  ok('以 CRLF 结尾', ics.endsWith('\r\n'));
  ok('有 VCALENDAR 头', ics.startsWith('BEGIN:VCALENDAR\r\n'));
  ok('有 PRODID', ics.includes('PRODID:'));
  ok('有 X-WR-CALNAME', ics.includes('X-WR-CALNAME:'));
  ok('有 REFRESH-INTERVAL', ics.includes('REFRESH-INTERVAL;VALUE=DURATION:PT6H'));
  eq('两次生成字节一致（幂等）', buildIcsFeed(events), ics);

  // 长中文说明必须被折行，且折完仍合格
  const longIcs = buildIcsFeed([
    {
      ...events[0],
      description: '报告期 2026-06-30\n'.repeat(20),
    },
  ]);
  eq('长文本折行后仍合格', validateIcs(longIcs), []);

  // 日期不合法的事件直接丢掉，不给日历 App 坏事件
  const badIcs = buildIcsFeed([{ ...events[0], date: 'not-a-date' }]);
  ok('坏日期的事件被丢掉', !badIcs.includes('BEGIN:VEVENT'));
}

function testCsv() {
  console.log('-- CSV --');
  eq('普通字段', csvCell('abc'), 'abc');
  eq('含逗号要加引号', csvCell('a,b'), '"a,b"');
  eq('含引号要转义', csvCell('a"b'), '"a""b"');
  eq('空值', csvCell(null), '');
  eq('含换行要加引号', csvCell('a\nb'), '"a\nb"');
}

/* ------------------------------------------------------------------ *
 * 入口
 * ------------------------------------------------------------------ */

export async function runSelftest() {
  console.log('== fetch-dividend-calendar 自测 ==');
  testEscape();
  testFold();
  testDates();
  testAnchor();
  testUid();
  testMatchNotice();
  testEvents();
  testIcs();
  testCsv();
  console.log(`== 通过 ${passed} 项，失败 ${failed} 项 ==`);
  if (failed) {
    console.log('::error::自测没通过，先修自测再抓数据。');
    return false;
  }
  return true;
}
