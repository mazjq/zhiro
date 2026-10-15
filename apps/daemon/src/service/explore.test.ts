import { describe, it, expect } from "vitest";
import { pickCandidates } from "./explore.js";

const post = (id: string, tier: string, o: any = {}) => ({ id, title: id, cities: ["武汉"], closesAt: null, watched: false, applicationState: null, match: { score: 120, reason: `${tier} · 证据 控制算法` }, expectation: { status: "pass", score: 1 }, ...o });
const co = (companyId: string, positions: any[], o: any = {}) => ({ companyId, companyName: companyId, expired: false, tags: [], closesAt: null, positions, ...o });

describe("探索候选 (ADR-036)", () => {
  it("only 可迁移 posts that pass the hard cards, at unmarked companies with more than one post, two a season minus what was applied", () => {
    const rows = [
      co("A", [post("a1", "可迁移"), post("a2", "可迁移"), post("a3", "可迁移"), post("a4", "优先考虑")]),
      co("B", [post("b1", "可迁移")]), // one post: the slot is reserved
      co("C", [post("c1", "可迁移"), post("c2", "可迁移")], { tags: [{ tag: "重点" }] }),
      co("D", [post("d1", "可迁移"), post("d2", "可迁移")], { tags: [{ tag: "不投" }] }),
      co("E", [post("e1", "可迁移", { expectation: { status: "unknown", score: 0 } }), post("e2", "可迁移", { watched: true }), post("e3", "可迁移", { applicationState: "draft" }), post("e4", "低相关")]),
      co("F", [post("f1", "可迁移"), post("f2", "可迁移"), post("f3", "可迁移")]),
    ];
    const picked = pickCandidates(rows, new Map([["F", 1]]));
    expect(picked.map((c) => c.positionId).sort()).toEqual(["a1", "a2", "f1"]);
    expect(picked.find((c) => c.companyId === "F")).toMatchObject({ usedThisSeason: 1, slots: 1, quota: null });
  });
});
