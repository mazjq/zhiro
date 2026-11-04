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

describe("重点公司 card: no open post, a known way to apply", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../db.js");
  const { Domain } = await import("./domain.js");
  const { createServices, testConfig } = await import("../services.js");
  const { ingest } = await import("../data/index.js");
  const { tagCompany } = await import("../recommenders/index.js");
  const { addSite } = await import("./trust.js");
  const { runShortlist, decideCard, shortlistLines } = await import("./shortlist.js");

  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "zhiro-shortlist-co-"));
    const db = openDb(join(dir, "t.db"));
    const domain = new Domain(db);
    const s = createServices({ db, domain, config: testConfig(dir, { sources: [] }) });
    // 甲: only an old, closed post, but its batch has an apply link; 乙: only its own site on record; 丙: nothing known; 丁: an open post
    ingest(domain, dir, "capture", "c1", [
      { externalId: "j1", url: "https://example.org/jobs/j1", title: "算法工程师", company: "示例甲科技有限公司", locations: ["武汉"], publisher: "site:example", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "校招" },
      { externalId: "j2", url: "https://example.org/jobs/j2", title: "算法工程师", company: "示例丁科技有限公司", locations: ["武汉"], publisher: "site:example", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "校招" },
    ] as any);
    const id = (name: string) => (db.prepare("select id from company where name = ?").get(name) as any)?.id as string;
    db.prepare("update position set status = 'closed' where campaign_id in (select id from campaign where company_id = ?)").run(id("示例甲科技有限公司"));
    db.prepare("update campaign set apply_url = 'https://jobs.example.org/jia', updated_at = '2026-10-01T00:00:00Z' where company_id = ?").run(id("示例甲科技有限公司"));
    for (const n of ["示例甲科技有限公司", "示例乙电子有限公司", "示例丙机械有限公司", "示例丁科技有限公司"]) tagCompany(s, { companyName: n, tag: "重点", reason: "测试" });
    addSite(db, { companyId: id("示例乙电子有限公司"), siteKey: "yi.example.org", rootKind: "exchange", basisUrl: "https://example.org/disclosure", basisQuote: "公司网址：yi.example.org", fingerprint: "test" });
    return { s, db, id };
  }

  it("one card, for the company with the newest evidence; it says how to apply and links the evidence; 看过了 keeps it away until something new", () => {
    const { s, db, id } = setup();
    const list = runShortlist(s);
    const cos = list.cards.filter((c) => c.slot === "company");
    expect(cos).toHaveLength(1);
    expect(cos[0]).toMatchObject({ company: "示例乙电子有限公司", gap: expect.stringContaining("官网 yi.example.org"), links: [{ text: "官网 yi.example.org", url: "https://yi.example.org" }] });
    expect(shortlistLines(list)).toContain("· 重点公司 · 示例乙电子有限公司 · 还没有在招的岗位");
    expect(() => decideCard(s, { runId: list.id, key: cos[0].key, decision: "apply" })).toThrow(/看过了/);
    decideCard(s, { runId: list.id, key: cos[0].key, decision: "seen" });
    const next = runShortlist(s, Date.now() + 60_000).cards.find((c) => c.slot === "company")!;
    expect(next).toMatchObject({ company: "示例甲科技有限公司", gap: expect.stringContaining("投递入口 jobs.example.org"), links: expect.arrayContaining([expect.objectContaining({ url: "https://jobs.example.org/jia" })]) });
    // a captured article naming 乙 later brings it back
    db.prepare("insert into capture(id, url, title, text_path, publisher, created_at) values (?,?,?,?,?,?)").run("cap1", "https://example.org/a/1", "示例乙电子2027届校园招聘启动", "", "wechat", "2099-01-01T00:00:00Z");
    expect(runShortlist(s, Date.now() + 120_000).cards.find((c) => c.slot === "company")!.company).toBe("示例乙电子有限公司");
    expect(id("示例丙机械有限公司")).toBeTruthy();
  });

  it("不投这家 is the 不投 company rule; a company with an open post or no known way never gets this card", () => {
    const { s, db } = setup();
    const list = runShortlist(s);
    const card = list.cards.find((c) => c.slot === "company")!;
    decideCard(s, { runId: list.id, key: card.key, decision: "skip" });
    expect(db.prepare("select 1 from recommendation where company_id = ? and tag = '不投'").get(card.companyId)).toBeTruthy();
    const after = runShortlist(s, Date.now() + 60_000).cards.filter((c) => c.slot === "company").map((c) => c.company);
    expect(after).toEqual(["示例甲科技有限公司"]);
    expect(() => decideCard(s, { runId: list.id, key: list.cards.find((c) => c.slot !== "company")?.key ?? card.key, decision: "seen" })).toThrow();
  });
});
