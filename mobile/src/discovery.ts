// 找电脑这件事里不碰浏览器、不碰插件的那一半。
//
// 拆出来的理由不是好看，是这几个判断错了之后都不报错：地址排错序会让数据线输给
// WiFi，缓存合并写错会把电脑报过来的地址表冲掉，去重漏了会让一台双网卡的电脑在
// 界面上变成两台。这些在真机上只表现为"有时候慢""有时候连错"，查起来极贵，而在
// 这里它们全是纯函数，可以直接钉死。

export type ServerCandidate = {
  host: string;
  port: number;
  kind: string;
  /** 上次被证实能连上的时间。超出容量时先淘汰最旧的。 */
  seenAt?: number;
  /** 连续失败次数。攒到 MAX_MISSES 就丢掉，否则死地址会一直占着并行探测的名额。 */
  misses?: number;
};

export type Discovered = {
  host: string;
  port: number;
  name?: string;
  version?: string;
  instance?: string;
  candidates?: ServerCandidate[];
};

export type LocalLink = { name: string; address: string; prefix: number };

/** 数据线比无线快一倍、抖动也小一半（见 local_endpoints.py 的实测），所以它该赢。 */
const KIND_RANK: Record<string, number> = { usb: 0, lan: 1 };
export const CANDIDATE_CAP = 12;
export const MAX_MISSES = 3;

function rankOf(kind: string): number {
  return KIND_RANK[kind] ?? 9;
}

function keyOf(item: { host: string; port: number }): string {
  return `${item.host}:${item.port}`;
}

export function toLong(ipv4: string): number {
  const parts = String(ipv4 ?? "").trim().split(".");
  if (parts.length !== 4) return -1;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return -1;
    const octet = Number(part);
    if (octet > 255) return -1;
    value = value * 256 + octet;
  }
  return value;
}

export function sameSubnet(a: string, b: string, prefix: number): boolean {
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return false;
  const left = toLong(a);
  const right = toLong(b);
  if (left < 0 || right < 0) return false;
  if (prefix === 0) return true;
  const mask = prefix === 32 ? 0xffffffff : (0xffffffff << (32 - prefix)) >>> 0;
  return ((left & mask) >>> 0) === ((right & mask) >>> 0);
}

/**
 * 合并两份候选地址，而不是让后来的覆盖先前的。
 *
 * 以前扫描找到一个地址就用它整个覆盖掉列表，于是电脑连上时报过来的那份完整地址表
 * 被冲没了——下次换条路（拔了线走 WiFi）就又得从头找。电脑报的那份是权威全表，
 * 该整体替换；扫描和广播找到的是单条线索，只能往里加。
 */
export function mergeCandidates(existing: ServerCandidate[], incoming: ServerCandidate[],
                                now = Date.now(), cap = CANDIDATE_CAP): ServerCandidate[] {
  const merged = new Map<string, ServerCandidate>();
  for (const item of existing) {
    if (!item || !item.host || !item.port) continue;
    merged.set(keyOf(item), { ...item });
  }
  for (const item of incoming) {
    if (!item || !item.host || !item.port) continue;
    const key = keyOf(item);
    const before = merged.get(key);
    merged.set(key, {
      host: item.host,
      port: item.port,
      kind: item.kind || before?.kind || "lan",
      seenAt: now,
      misses: 0,   // 刚被证实过，之前攒的失败一笔勾销
    });
  }
  return [...merged.values()]
    .sort((a, b) => (b.seenAt ?? 0) - (a.seenAt ?? 0))
    .slice(0, cap);
}

/**
 * 记下这一轮谁没应答。连续失败够多次就丢掉。
 *
 * 不立刻丢，是因为一次不通可能只是电脑还没开；一直留着，则是因为换过几个网络之后
 * 列表里全是尸体，而每一具都要占一个并行探测的名额。
 */
export function forgetFailures(list: ServerCandidate[],
                               failed: { host: string; port: number }[]): ServerCandidate[] {
  const missed = new Set(failed.map(keyOf));
  const kept: ServerCandidate[] = [];
  for (const item of list) {
    if (!missed.has(keyOf(item))) {
      kept.push(item);
      continue;
    }
    const misses = (item.misses ?? 0) + 1;
    if (misses < MAX_MISSES) kept.push({ ...item, misses });
  }
  return kept;
}

/**
 * 决定先探谁。同网段的排前面，但**异网段的不丢**。
 *
 * 不存网段标签而是拿手机当前的网卡现算：标签是会过期的东西，而"我现在在哪个网段"
 * 每次问都是当前值。只用来排序不用来过滤，是因为跨网段路由的情况确实存在——过滤
 * 掉就等于替用户断定他的网络不可能那样连。
 */
export function rankCandidates(candidates: ServerCandidate[], links: LocalLink[]): ServerCandidate[] {
  const near = (item: ServerCandidate) =>
    links.some((link) => sameSubnet(item.host, link.address, link.prefix));
  return [...candidates].sort((a, b) => {
    const byNear = Number(near(b)) - Number(near(a));
    if (byNear) return byNear;
    const byKind = rankOf(a.kind) - rankOf(b.kind);
    if (byKind) return byKind;
    return (b.seenAt ?? 0) - (a.seenAt ?? 0);
  });
}

export type ProbeResult = { candidate: ServerCandidate; ok: boolean; rttMs: number };

/**
 * 一起探、但不是谁先答应用谁。
 *
 * 串行探测的原意是"顺序即偏好"，数据线排在前面所以它赢。并行会把这个意思弄丢：
 * 实测数据线 4.4ms、无线 8.3ms，差几毫秒，谁先到基本是随机的。所以先到不算数，
 * 等一个很短的宽限窗收齐几个，再按"哪条链路更好"挑——宽限窗只要远大于那几毫秒的
 * 差距，数据线在场就必定落在窗内。
 */
export function pickBest(results: ProbeResult[]): ServerCandidate | null {
  const good = results.filter((item) => item.ok);
  if (!good.length) return null;
  good.sort((a, b) => {
    const byKind = rankOf(a.candidate.kind) - rankOf(b.candidate.kind);
    if (byKind) return byKind;
    return a.rttMs - b.rttMs;
  });
  return good[0].candidate;
}

/**
 * 同一台电脑从两个网卡各回一份应答，是一台机器不是两台。
 *
 * 不去重的话，插着线又连着 WiFi 的电脑会在界面上变成两台让人选，而它们其实是同一台
 * 的两条路——选哪个都对，但让人选本身就已经错了。
 */
export function dedupeServers(servers: Discovered[]): Discovered[] {
  const byInstance = new Map<string, Discovered>();
  for (const server of servers) {
    const key = server.instance || server.host;
    if (!key || byInstance.has(key)) continue;
    byInstance.set(key, server);
  }
  return [...byInstance.values()];
}

/**
 * 把一次发现的结果摊平成候选地址，实测可达的那条排最前。
 *
 * 应答包的源地址是刚刚走通过的，而 candidates 里那些只是电脑**声称**可达——它可能
 * 在报一个虚拟网卡的地址，也可能报一条被防火墙挡住的路。已经走通的那条不该排在
 * 声称后面。
 */
export function candidatesOf(server: Discovered): ServerCandidate[] {
  const listed = server.candidates ?? [];
  const reached: ServerCandidate = {
    host: server.host,
    port: server.port,
    kind: listed.find((item) => item.host === server.host)?.kind ?? "lan",
  };
  const rest = listed.filter((item) => keyOf(item) !== keyOf(reached));
  return [reached, ...rest];
}

/**
 * 电脑地址里和手机同网段的那些，方便只问用户"最后一段是多少"。
 *
 * 自动找不到的时候，让人照着电脑屏幕输一个完整 IP，十五个字符里错一个就白输。
 * 而手机知道自己在 192.168.1.x，所以真正缺的只有最后那一段。
 */
export function lastOctetHint(links: LocalLink[]): { prefix: string; example: string } | null {
  const usable = links.find((link) => link.prefix >= 24 && toLong(link.address) > 0);
  if (!usable) return null;
  const parts = usable.address.split(".");
  return { prefix: `${parts[0]}.${parts[1]}.${parts[2]}.`, example: parts[3] };
}
