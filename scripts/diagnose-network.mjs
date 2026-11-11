#!/usr/bin/env node
/**
 * 网络诊断：搞清楚「这台机器到底能不能访问中行的净值静态页」。
 *
 * 为什么需要它：
 *   GitHub 托管 runner 在 Azure（默认美国），中行的 www.boc.cn 用的是
 *   **按客户端位置智能解析**（geo-DNS）——
 *   实测上海解析到 218.23.97.18，美国/德国解析到 36.102.224.177，日本到 116.136.32.177。
 *   不同节点对境外源 IP 的可达性不一样，所以「我这台机器能不能抓」必须实测，
 *   不能靠猜。
 *
 * 输出内容：
 *   1. 运行环境与出口 IP
 *   2. DNS：操作系统解析结果 + 多个带 ECS（客户端子网）的 DoH 解析结果
 *   3. 逐个候选 IP 探测：TCP 连通 / TLS 握手 / HTTP 取页（钉住 IP，保留 SNI）
 *   4. 对照站点：baidu / 中行首页 / 中行 sourcedb 路径
 *   5. Node fetch 的完整错误链（把 undici 包装掉的真实原因挖出来）
 *
 * 退出码恒为 0 —— 它是诊断工具，跑完了就该把信息交出去，不该把流水线带崩。
 * 想让它影响流水线，用 `--strict`（探测不到任何可用 IP 时退出码 1）。
 *
 * 用法：node scripts/diagnose-network.mjs [--strict]
 */

import dns from 'node:dns/promises';
import https from 'node:https';
import net from 'node:net';

const HOST = 'www.boc.cn';
const PATH_PROBE = '/sourcedb/srfd6_2024/index_1.html';
const HOME_PROBE = '/';
const STRICT = process.argv.includes('--strict');

/** 每个探测的超时（毫秒） */
const PROBE_TIMEOUT = 12_000;

/** 用来做 ECS 解析的客户端子网 —— 覆盖境内/境外几个区域 */
const ECS_SUBNETS = [
  { label: '中国·上海', cidr: '223.5.5.0/24' },
  { label: '中国·北京', cidr: '114.114.114.0/24' },
  { label: '中国·广东', cidr: '202.96.128.0/24' },
  { label: '美国', cidr: '8.8.8.0/24' },
  { label: '德国', cidr: '1.2.3.0/24' },
  { label: '日本', cidr: '210.0.0.0/16' },
  { label: '新加坡', cidr: '165.21.83.0/24' },
];

/** 可用的 DoH 解析器 */
const DOH_RESOLVERS = [
  { label: 'alidns(阿里)', url: (name) => `https://dns.alidns.com/resolve?name=${name}&type=A` },
  { label: 'doh.pub(腾讯)', url: (name) => `https://doh.pub/dns-query?name=${name}&type=A` },
];

/**
 * 已知的中行节点 IP —— **即使 ECS 解析没给出也要试**。
 *
 * 用途：回答一个决定性问题 ——
 * 「Azure runner 拿到的默认节点连不上，是不是因为它被解析到了境外/不可用的节点？
 *   钉住一个境内已知可用节点行不行？」
 * 如果钉住境内 IP 就能通，那抓取脚本可以「多 IP 探测 + 钉住可用 IP」，
 * 完全绕开默认 DNS 选错节点的问题 —— 那就是能修的。
 * 如果钉住哪个都不行，说明是这条出口网络整体到不了中行，只能换出口。
 */
const KNOWN_IPS = [
  '218.23.97.18',
  '36.102.224.177',
  '36.35.8.18',
  '116.136.32.177',
  '112.28.152.18',
];

function out(line = '') {
  process.stdout.write(line + '\n');
}

function hr(title) {
  out();
  out(`=== ${title} ${'='.repeat(Math.max(0, 60 - title.length))}`);
}

/** 把一条错误链压成人类能读的字符串 —— undici 会把真实原因裹进 cause */
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

/** 用 fetch 探测一个 URL，把完整错误链挖出来 */
async function probeFetch(url, timeout = PROBE_TIMEOUT) {
  const started = Date.now();
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; wealth-nav-watch/1.0; +diagnose)',
        Accept: 'text/html,application/xhtml+xml',
        // 让服务端别复用连接：有些节点 keep-alive 处理得不干净
        Connection: 'close',
      },
      signal: AbortSignal.timeout(timeout),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    return {
      ok: true,
      status: res.status,
      bytes: buf.length,
      ms: Date.now() - started,
      note: '',
    };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      bytes: 0,
      ms: Date.now() - started,
      note: describeError(err),
    };
  }
}

/**
 * 钉住一个 IP 去请求 https://HOST/path。
 * 用 node:https 而不是 fetch，是为了拿到两样东西：
 *   - lookup 覆盖（钉住 IP，但 SNI 和证书校验仍然按域名走 —— 换成 IP 直连会证书不过）
 *   - 明确的 err.code（ECONNRESET / ETIMEDOUT / ENOTFOUND …）
 */
function probePinnedIp(ip, path, family = 4) {
  return new Promise((resolve) => {
    const started = Date.now();
    const req = https.request(
      {
        host: HOST,
        path,
        servername: HOST, // SNI 必须是域名，否则对端可能直接重置握手
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; wealth-nav-watch/1.0; +diagnose)',
          Accept: 'text/html,application/xhtml+xml',
          Connection: 'close',
        },
        agent: false, // 不复用连接
        // Node 20+ 默认 autoSelectFamily:true，会以 { all: true } 调用 lookup，
        // 这时回调要收数组而不是 (address, family) —— 只写后者会拿到
        // ERR_INVALID_IP_ADDRESS: undefined。
        lookup: (_hostname, options, callback) => {
          if (options && options.all) {
            callback(null, [{ address: ip, family }]);
          } else {
            callback(null, ip, family);
          }
        },
        timeout: PROBE_TIMEOUT,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            ok: true,
            status: res.statusCode ?? 0,
            bytes: Buffer.concat(chunks).length,
            ms: Date.now() - started,
            note: '',
          });
        });
        res.on('error', (err) => {
          resolve({ ok: false, status: 0, bytes: 0, ms: Date.now() - started, note: describeError(err) });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('socket timeout'), { code: 'ETIMEDOUT' }));
    });
    req.on('error', (err) => {
      resolve({ ok: false, status: 0, bytes: 0, ms: Date.now() - started, note: describeError(err) });
    });
    // TLS socket 可能在请求结束后才抛错 —— 那时没人监听就会变成
    // unhandled 'error' event 直接把进程带崩（2026-11-11 在 Actions 上就是这么挂的）。
    req.on('socket', (socket) => socket.on('error', () => {}));
    req.end();
  });
}

/** 纯 TCP 连通性测试 */
function probeTcp(ip, port = 443) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = net.connect({ host: ip, port });
    const done = (ok, note) => {
      socket.destroy();
      resolve({ ok, ms: Date.now() - started, note });
    };
    socket.setTimeout(PROBE_TIMEOUT);
    socket.once('connect', () => done(true, ''));
    socket.once('timeout', () => done(false, 'TCP 超时'));
    socket.once('error', (err) => done(false, `${err.code ?? ''} ${err.message}`.trim()));
  });
}

async function dohResolve(name, resolver, ecs) {
  const url = resolver.url(name) + (ecs ? `&edns_client_subnet=${encodeURIComponent(ecs)}` : '');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10_000);
  try {
    const res = await fetch(url, { headers: { accept: 'application/dns-json' }, signal: controller.signal });
    const data = await res.json();
    return (data.Answer ?? [])
      .filter((a) => a.type === 1)
      .map((a) => a.data);
  } catch (err) {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  hr('1. 运行环境');
  out(`node                ${process.version}`);
  out(`platform            ${process.platform} ${process.arch}`);
  out(`GITHUB_ACTIONS      ${process.env.GITHUB_ACTIONS ?? '(不在 Actions 里)'}`);
  out(`runner region       ${process.env.RUNNER_REGION ?? process.env.RUNNER_NAME ?? '(未知)'}`);
  out(`runner os           ${process.env.RUNNER_OS ?? '(未知)'}`);
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    let ipText = '';
    for (const endpoint of ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://api.ip.sb']) {
      try {
        const ipRes = await fetch(endpoint, { signal: controller.signal });
        ipText = (await ipRes.text()).trim();
        if (ipText) break;
      } catch {
        /* 换下一个 */
      }
    }
    clearTimeout(timer);
    out(`出口 IP             ${ipText || '查不到'}`);
  } catch {
    out('出口 IP             查不到');
  }

  hr('2. DNS：操作系统解析');
  let osIps = [];
  let osV6 = [];
  try {
    const res = await dns.lookup(HOST, { all: true });
    osIps = res.filter((r) => r.family === 4).map((r) => r.address);
    osV6 = res.filter((r) => r.family === 6).map((r) => r.address);
    out(`getaddrinfo(${HOST}) -> IPv4: ${osIps.join(', ') || '(无)'}`);
    out(`                       IPv6: ${osV6.join(', ') || '(无)'}`);
    if (osV6.length) {
      out();
      out('⚠ 这台机器解析到了 IPv6 地址。');
      out('  Azure 托管 runner 通常**没有可用的 IPv6 出口** ——');
      out('  undici 取到 IPv6 后直接连会拿到 EINVAL/ECONNREFUSED，');
      out('  对外只表现为一句没有信息量的「TypeError: fetch failed」。');
      out('  → 抓取脚本必须**显式只走 IPv4**。');
    }
  } catch (err) {
    out(`getaddrinfo(${HOST}) -> 失败：${describeError(err)}`);
  }

  hr('2b. 对照：默认 fetch 能不能取到 sourcedb（这一步最关键）');
  {
    const r = await probeFetch(`https://${HOST}${PATH_PROBE}`, 30_000);
    out(
      `  默认 fetch  ${r.ok ? `通 status=${r.status} ${r.bytes}B` : '失败'}  ${r.ms}ms  ${r.note}`,
    );
    out(
      r.ok
        ? '  → 默认 fetch 可用，问题在别处（keep-alive 复用 / 瞬时抖动）。'
        : '  → 默认 fetch 不可用 → 抓取脚本必须钉住 IPv4（或换出口）。',
    );
  }

  hr('3. DNS：带 ECS 的多区域解析（看智能解析给了哪些节点）');
  const candidates = new Map(); // ip -> 来源说明
  for (const subnet of ECS_SUBNETS) {
    const found = new Set();
    for (const resolver of DOH_RESOLVERS) {
      for (const ip of await dohResolve(HOST, resolver, subnet.cidr)) {
        found.add(ip);
        if (!candidates.has(ip)) candidates.set(ip, []);
        candidates.get(ip).push(`${subnet.label}/${resolver.label}`);
      }
    }
    if (found.size) {
      for (const ip of found) {
        if (!candidates.has(ip)) candidates.set(ip, []);
      }
      out(`${subnet.label.padEnd(12)} -> ${[...found].join(', ')}`);
    } else {
      out(`${subnet.label.padEnd(12)} -> 解析失败`);
    }
  }
  for (const ip of osIps) {
    if (!candidates.has(ip)) candidates.set(ip, []);
    candidates.get(ip).push('操作系统解析');
  }
  // 已知节点一律纳入候选（标成「内置已知节点」），保证「钉住境内 IP 行不行」这个问题
  // 在任何网络环境下都被回答到
  for (const ip of KNOWN_IPS) {
    if (!candidates.has(ip)) candidates.set(ip, []);
    candidates.get(ip).push('内置已知节点');
  }
  out();
  out(`候选 IP 共 ${candidates.size} 个（含 ${KNOWN_IPS.length} 个内置已知节点）`);

  hr('4. 逐个候选 IP 探测（钉 IP、SNI 仍用域名）');
  const ipResults = [];
  for (const [ip, sources] of candidates) {
    const src = sources.length ? `（${sources.join('、')}）` : '';
    try {
      const tcp = await probeTcp(ip);
      const http = await probePinnedIp(ip, PATH_PROBE);
      ipResults.push({ ip, sources, tcp, http });
      out(`  ${ip}${src}`);
      out(`    TCP    ${tcp.ok ? '通' : '不通'}  ${tcp.ms}ms  ${tcp.note}`);
      out(
        `    HTTPS  ${http.ok ? `通 status=${http.status} ${http.bytes}B` : '失败'}  ${http.ms}ms  ${http.note}`,
      );
    } catch (err) {
      // 单个候选探测炸了不能带崩整个诊断
      out(`  ${ip}${src}`);
      out(`    探测自身出错：${describeError(err)}`);
    }
  }

  // IPv6 单独测：它可能是「默认 fetch 挂掉」的元凶，但要单独试（family 6）
  if (osV6.length) {
    out();
    out('  IPv6 候选（单独试）：');
    for (const ip of osV6) {
      try {
        const r = await probePinnedIp(ip, PATH_PROBE, 6);
        out(
          `    ${ip}  ${r.ok ? `通 status=${r.status} ${r.bytes}B` : '失败'}  ${r.ms}ms  ${r.note}`,
        );
      } catch (err) {
        out(`    ${ip}  探测自身出错：${describeError(err)}`);
      }
    }
  }

  hr('5. 对照站点（同一台机器、同一时刻）');
  const controls = [
    { label: '百度首页', url: 'https://www.baidu.com/' },
    { label: '中行首页', url: `https://${HOST}${HOME_PROBE}` },
    { label: '中行 sourcedb', url: `https://${HOST}${PATH_PROBE}` },
  ];
  for (const c of controls) {
    const r = await probeFetch(c.url);
    out(
      `  ${c.label.padEnd(14)} ${r.ok ? `通 status=${r.status} ${r.bytes}B` : '失败'}  ${r.ms}ms  ${r.note}`,
    );
  }

  hr('6. 结论');
  const usable = ipResults.filter((r) => r.http.ok && r.http.status === 200 && r.http.bytes > 1000);
  const anyPathOk = usable.length > 0;
  out(`可用的候选 IP（能取到 sourcedb 正文）：${usable.length ? usable.map((r) => r.ip).join(', ') : '无'}`);
  out(`任意路径可达（默认 DNS + fetch）：见第 5 节`);
  out();
  if (anyPathOk) {
    out('→ 存在可用 IP。抓取脚本可以「解析多个候选 + 逐个探测 + 钉住可用 IP」，不必依赖默认 DNS。');
  } else {
    out('→ 没有任何候选 IP 能取到 sourcedb 正文。');
    out('  说明这不是 DNS 选错了节点，而是**这条出口网络整体到不了中行该路径**。');
    out('  需要换出口（自建 runner / 国内环境 / 能连通的中转），单纯重试没有用。');
  }

  if (STRICT && !anyPathOk) {
    out();
    out('--strict：没有任何可用 IP，退出码 1');
    process.exitCode = 1;
  }
}

main().catch((err) => {
  out(`诊断脚本自身出错：${describeError(err)}`);
  process.exitCode = 1;
});
