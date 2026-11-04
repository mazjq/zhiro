import { describe, it, expect } from "vitest";
import { pick, cityRank, weekOf, MAX_NEW } from "./shortlist.js";

const me: any = { level: 3, concepts: new Set(["control_algorithm", "motor_control"]), stems: ["控制"], direction: ["动力定位"], user: { level: 3, majors: [], gaps: new Set(), evidence: [] } };
const rules = (o: any = {}) => ({ tiers: [["武汉"], ["深圳", "上海"], ["北京"]], noCities: [], onePerGroup: [], excludes: [], blocked: new Set<string>(), ...o });
const row = (id: string, o: any = {}) => ({ id, title: "控制算法工程师", jd_text: "", cities: '["武汉"]', degree_req: "", major_req: "", closes_at: null, created_at: "2026-11-01T00:00:00Z", watch_priority: null,
  c_closes: null, c_degree: "", c_major: "", c_cities: "[]", source_kind: "moka", company_id: id.slice(0, 1), company: `公司${id.slice(0, 1)}`, company_type: "民企", app_state: null, assessment: null, key_company: 0, ...o }) as any;
const assessOf = (r: any) => r.a ?? null;
const run = (rows: any[], o: any = {}) => pick(rows, me, rules(o.rules), o.applied ?? new Map(), assessOf, "2026-11-02", o.before ?? new Set());

describe("每周短名单", () => {
  it("weekOf is the Monday; cityRank walks the tiers", () => {
    expect(weekOf(Date.parse("2026-11-05T10:00:00"))).toBe("2026-11-02");
    expect(weekOf(Date.parse("2026-11-02T00:30:00"))).toBe("2026-11-02");
    expect(cityRank(["深圳"], [["武汉"], ["深圳", "上海"]])).toBe(1);
    expect(cityRank(["长春"], [["武汉"]])).toBe(-1);
    expect(cityRank(["全国"], [["武汉"]])).toBe(1); // unknown: after every tier, never out
    expect(cityRank(["长春"], [])).toBe(0); // no list, no rule
  });

  it("candidates are posts whose title names what the person has, in a listed city; 重点 companies always; rules are listed, not dropped", () => {
    const rows = [
      row("a1"), row("a2", { title: "销售经理" }), // title off: not a candidate at all
      row("b1", { cities: '["长春"]' }), // off the list: skipped, no rule
      row("c1", { title: "液压工程师", key_company: 1, cities: '["包头"]' }), // 重点: in, wherever
      row("d1", { company_id: "d" }), row("e1", { title: "控制算法工程师（销售）" }),
      row("f1", { app_state: "draft" }), row("g1", { cities: '["北京"]' }), row("h1", { cities: '["深圳"]', a: { tier: "优先考虑", S: 90, A: 40, judgements: [] } }),
    ];
    const { cards, skipped } = run(rows, { rules: { blocked: new Set(["d"]), excludes: ["销售"] } });
    expect(cards.map((c) => c.positionId)).toEqual(["c1", "a1", "h1", "g1"]); // 重点 first, then city tier, then assessment
    expect(skipped.map((s) => [s.positionId, s.rule?.kind ?? null])).toEqual([["b1", null], ["d1", "company"], ["e1", "type"]]);
    expect(cards[0].notes).toContain("重点公司");
  });

  it("at most two a company and MAX_NEW cards; the rest are skipped as 超出本周张数", () => {
    const rows = [...Array(5)].map((_, i) => row(`a${i}`)).concat([...Array(5)].map((_, i) => row(`b${i}`, { cities: '["上海"]' })));
    const { cards, skipped } = run(rows);
    expect(cards.filter((c) => c.slot === "new")).toHaveLength(Math.min(MAX_NEW, 4));
    expect(cards.filter((c) => c.companyId === "a")).toHaveLength(2);
    expect(skipped.every((s) => s.reason === "超出本周张数")).toBe(true);
    expect(skipped).toHaveLength(6);
  });

  it("同集团: side by side with a note, kept out only when the person said that group takes one", () => {
    const applied = new Map([["中船", ["中国船舶集团有限公司第七〇九研究所"]]]);
    const rows = [row("a1", { company: "中国船舶集团有限公司第七二二研究所" })];
    expect(run(rows, { applied }).cards[0].notes).toContain("同集团已投 中国船舶集团有限公司第七〇九研究所");
    const out = run(rows, { applied, rules: { onePerGroup: ["中船"] } });
    expect(out.cards).toHaveLength(0);
    expect(out.skipped[0].rule).toEqual({ kind: "group", value: "中船" });
  });

  it("可补: the open core skill that unlocks the most posts, with a date; a post 不投 before stays out", () => {
    const fill = (id: string, concept: string, S = 50) => row(id, { cities: '["上海"]', a: { tier: "可迁移", S, A: 35, judgements: [{ concepts: [concept], status: "unknown", importance: "core", modality: "required", depth: "used", quote: `熟悉${concept}` }] } });
    const rows = [...Array(MAX_NEW)].map((_, i) => row(`n${i}`, { company_id: `n${i}` })).concat([fill("x1", "ros"), fill("x2", "ros"), fill("y1", "reinforcement_learning"), row("z1", { company_id: "z" })]);
    const { cards, skipped } = run(rows, { before: new Set(["z1"]) });
    const fills = cards.filter((c) => c.slot === "fill");
    expect(fills.map((c) => [c.positionId, c.unlocks])).toEqual([["x1", 2], ["y1", 1]]);
    expect(fills[0].expiresAt).toBe("2026-11-23");
    expect(fills[0].gap).toContain("资料里还没有证据");
    expect(skipped.map((s) => s.positionId)).toEqual(["x2"]);
  });
});

describe("标题词", () => {
  it("is the head of the person's task concepts' names when it recurs: 控制 from 运动控制 / 电机控制, never a tool or a one-off", async () => {
    const { titleStems } = await import("./shortlist.js");
    const stems = titleStems(["motion_control", "motor_control", "control_algorithm", "trajectory_tracking", "ros", "matlab_simulink"]);
    expect(stems).toContain("控制");
    expect(stems).not.toContain("跟踪"); // 轨迹跟踪 / 路径跟踪 are one concept: counted once
    expect(stems).not.toContain("ros");
  });
});
