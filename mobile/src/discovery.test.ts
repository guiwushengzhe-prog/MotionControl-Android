// 找电脑这件事里，错了不会报错的那几处判断。
//
// 每一条对应一个真实踩过或差点踩的坑，测试名字就是那个坑。

import { describe, expect, it } from "vitest";

import {
  CANDIDATE_CAP, MAX_MISSES, candidatesOf, dedupeServers, forgetFailures,
  lastOctetHint, mergeCandidates, pickBest, rankCandidates, sameSubnet,
  type ServerCandidate,
} from "./discovery";

const usb = (host: string): ServerCandidate => ({ host, port: 8765, kind: "usb" });
const lan = (host: string): ServerCandidate => ({ host, port: 8765, kind: "lan" });

describe("合并候选地址", () => {
  it("不把已有的地址冲掉", () => {
    // 这一条就是那个 bug 的回归：扫描找到一个地址，原来用它 [found] 覆盖整张表，
    // 于是电脑连上时报过来的完整地址表没了，换条路又得从头找。
    const before = [usb("10.0.0.2"), lan("192.168.1.9")];
    const after = mergeCandidates(before, [lan("192.168.1.50")]);
    const hosts = after.map((item) => item.host);
    expect(hosts).toContain("10.0.0.2");
    expect(hosts).toContain("192.168.1.9");
    expect(hosts).toContain("192.168.1.50");
  });

  it("同一个地址不会变成两条", () => {
    const after = mergeCandidates([lan("192.168.1.9")], [usb("192.168.1.9")]);
    expect(after).toHaveLength(1);
    expect(after[0].kind).toBe("usb");
  });

  it("满了先扔最久没连上的", () => {
    const old = Array.from({ length: CANDIDATE_CAP }, (_, index) =>
      ({ ...lan(`10.9.0.${index + 1}`), seenAt: index }));
    const after = mergeCandidates(old, [usb("10.9.9.9")], 999_999);
    expect(after).toHaveLength(CANDIDATE_CAP);
    expect(after.map((item) => item.host)).toContain("10.9.9.9");
    expect(after.map((item) => item.host)).not.toContain("10.9.0.1");
  });

  it("重新连上就把之前攒的失败一笔勾销", () => {
    const stale = [{ ...lan("192.168.1.9"), misses: MAX_MISSES - 1 }];
    const after = mergeCandidates(stale, [lan("192.168.1.9")]);
    expect(after[0].misses).toBe(0);
  });
});

describe("淘汰连不上的地址", () => {
  it("一次不通不丢——电脑可能只是还没开", () => {
    const after = forgetFailures([lan("192.168.1.9")], [{ host: "192.168.1.9", port: 8765 }]);
    expect(after).toHaveLength(1);
    expect(after[0].misses).toBe(1);
  });

  it("连续失败够多次就丢，否则列表里全是尸体", () => {
    let list = [lan("192.168.1.9")];
    for (let round = 0; round < MAX_MISSES; round++) {
      list = forgetFailures(list, [{ host: "192.168.1.9", port: 8765 }]);
    }
    expect(list).toHaveLength(0);
  });

  it("没被点名的不受影响", () => {
    const after = forgetFailures([lan("192.168.1.9"), usb("10.0.0.2")],
                                 [{ host: "192.168.1.9", port: 8765 }]);
    expect(after.find((item) => item.host === "10.0.0.2")?.misses).toBeUndefined();
  });
});

describe("排序", () => {
  const links = [{ name: "wlan0", address: "192.168.1.37", prefix: 24 }];

  it("同网段的先试", () => {
    const ranked = rankCandidates([lan("10.9.9.9"), lan("192.168.1.50")], links);
    expect(ranked[0].host).toBe("192.168.1.50");
  });

  it("异网段的排后面但不丢掉", () => {
    // 过滤掉就等于替用户断定他的网络不可能跨网段路由。
    const ranked = rankCandidates([lan("10.9.9.9"), lan("192.168.1.50")], links);
    expect(ranked.map((item) => item.host)).toContain("10.9.9.9");
  });

  it("同样远近时数据线排前面", () => {
    const ranked = rankCandidates([lan("172.16.0.5"), usb("10.9.9.9")], links);
    expect(ranked[0].kind).toBe("usb");
  });
});

describe("并行探测之后挑哪一条", () => {
  it("数据线赢，哪怕无线先答应", () => {
    // 并行化最容易改坏的就是这里：实测数据线 4.4ms、无线 8.3ms，差几毫秒，
    // 谁先到基本随机。按到达顺序挑会让数据线随机地输掉。
    const best = pickBest([
      { candidate: lan("192.168.1.50"), ok: true, rttMs: 4 },
      { candidate: usb("10.0.0.2"), ok: true, rttMs: 9 },
    ]);
    expect(best?.kind).toBe("usb");
  });

  it("同一种链路里快的赢", () => {
    const best = pickBest([
      { candidate: lan("192.168.1.50"), ok: true, rttMs: 40 },
      { candidate: lan("192.168.1.51"), ok: true, rttMs: 7 },
    ]);
    expect(best?.host).toBe("192.168.1.51");
  });

  it("没应答的不算数", () => {
    const best = pickBest([
      { candidate: usb("10.0.0.2"), ok: false, rttMs: 800 },
      { candidate: lan("192.168.1.50"), ok: true, rttMs: 30 },
    ]);
    expect(best?.host).toBe("192.168.1.50");
  });

  it("一个都没答应就是没有", () => {
    expect(pickBest([{ candidate: usb("10.0.0.2"), ok: false, rttMs: 800 }])).toBeNull();
  });
});

describe("同一台电脑只算一台", () => {
  it("两个网卡各回一份，界面上不该冒出两台", () => {
    const servers = dedupeServers([
      { host: "10.0.0.2", port: 8765, instance: "abc", name: "PC" },
      { host: "192.168.1.50", port: 8765, instance: "abc", name: "PC" },
    ]);
    expect(servers).toHaveLength(1);
  });

  it("真的两台还是两台", () => {
    const servers = dedupeServers([
      { host: "10.0.0.2", port: 8765, instance: "abc" },
      { host: "192.168.1.50", port: 8765, instance: "xyz" },
    ]);
    expect(servers).toHaveLength(2);
  });
});

describe("实测可达的地址排最前", () => {
  it("应答从哪来的就先试哪个", () => {
    // candidates 里那些只是电脑声称可达，可能是虚拟网卡、也可能被防火墙挡着；
    // 应答包的源地址是刚刚真的走通过的。
    const flat = candidatesOf({
      host: "10.0.0.2", port: 8765,
      candidates: [lan("192.168.1.50"), usb("10.0.0.2")],
    });
    expect(flat[0].host).toBe("10.0.0.2");
    expect(flat[0].kind).toBe("usb");
    expect(flat).toHaveLength(2);
  });
});

describe("兜底时只问最后一段", () => {
  it("知道自己在哪个网段就只缺最后一段", () => {
    const hint = lastOctetHint([{ name: "wlan0", address: "192.168.1.37", prefix: 24 }]);
    expect(hint?.prefix).toBe("192.168.1.");
  });

  it("网段太大时说不出前三段，就别乱说", () => {
    expect(lastOctetHint([{ name: "wlan0", address: "10.4.7.33", prefix: 16 }])).toBeNull();
  });
});

describe("网段比较", () => {
  it("认得边界", () => {
    expect(sameSubnet("192.168.1.5", "192.168.1.200", 24)).toBe(true);
    expect(sameSubnet("192.168.1.5", "192.168.2.5", 24)).toBe(false);
    expect(sameSubnet("10.4.7.5", "10.4.200.5", 16)).toBe(true);
    expect(sameSubnet("10.4.7.5", "10.5.7.5", 16)).toBe(false);
  });

  it("垃圾输入不当成同网段", () => {
    expect(sameSubnet("不是地址", "192.168.1.5", 24)).toBe(false);
    expect(sameSubnet("192.168.1.999", "192.168.1.5", 24)).toBe(false);
  });
});
