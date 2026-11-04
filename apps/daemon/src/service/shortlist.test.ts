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

describe("短名单细评: the two lines from the model's deep match", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../db.js");
  const { Domain } = await import("./domain.js");
  const { createServices, testConfig } = await import("../services.js");
  const { ingest } = await import("../data/index.js");
  const { tagCompany } = await import("../recommenders/index.js");
  const { backgroundKind, BudgetDeferred } = await import("../budget/index.js");
  const { currentPurpose } = await import("./usage.js");
  const { runShortlist, deepenShortlist, quotedLine, DEEP_PER_WEEK } = await import("./shortlist.js");

  const JD = "岗位职责：负责无人船运动控制算法开发。任职要求：熟悉 ROS；有 MPC 项目经验者优先。";
  function setup(answer: (n: number) => any, posts = 1) {
    const dir = mkdtempSync(join(tmpdir(), "zhiro-shortlist-deep-"));
    const db = openDb(join(dir, "t.db"));
    const domain = new Domain(db);
    ingest(domain, dir, "capture", "c1", [...Array(posts)].map((_, i) => ({ externalId: `j${i}`, url: `https://example.org/jobs/j${i}`, title: `控制算法工程师${i}`, company: "示例海工有限公司",
      locations: ["武汉"], description: JD, publisher: "site:example", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "校招" }) as any));
    const s = createServices({ db, domain, config: testConfig(dir, { sources: [] }) });
    tagCompany(s, { companyId: (db.prepare("select id from company").get() as any).id, tag: "重点", reason: "测试" });
    const calls: { kind: string | null; purpose: string }[] = [];
    (s as any).llm = { model: () => ({ id: "fake" }), models: { completeSimple: async () => {
      calls.push({ kind: backgroundKind(), purpose: currentPurpose().purpose });
      const a = answer(calls.length);
      if (a instanceof Error) throw a;
      return { content: [{ type: "text", text: JSON.stringify(a) }] };
    } } };
    return { s, db, calls };
  }
  const good = { score: 80, verdict: "对口", meets: ["「负责无人船运动控制算法开发」：做过船舶运动控制课题"], gaps: ["「熟悉 ROS」：资料里没有 ROS 的经历"] };

  it("a quoted line of the post replaces the rule wording; asked as held background work under shortlist.fit, once", async () => {
    const { s, calls } = setup(() => good);
    const list = runShortlist(s);
    expect(list.cards).toHaveLength(1);
    expect(await deepenShortlist(s, list.id)).toBe(1);
    const card = (await import("./shortlist.js")).latestShortlist(s.domain.db)!.cards[0];
    expect(card.why).toBe(good.meets[0]);
    expect(card.gap).toBe(good.gaps[0]);
    expect(calls).toEqual([{ kind: "shortlist_fit", purpose: "shortlist.fit" }]);
    // the next list reads the same deep match: no second call
    const again = runShortlist(s, Date.now() + 60_000);
    await deepenShortlist(s, again.id);
    expect(calls).toHaveLength(1);
  });

  it("a line whose quote is not in the post, a refusal of the gate, or a model error keeps the rule wording", async () => {
    const made = { score: 70, verdict: "", meets: ["「精通强化学习」：有论文"], gaps: ["差 ROS"] };
    const a = setup(() => made);
    const la = runShortlist(a.s);
    const before = la.cards[0];
    expect(await deepenShortlist(a.s, la.id)).toBe(0);
    expect(a.s.domain.db.prepare("select json from shortlist_run").get()).toEqual({ json: JSON.stringify(la) });
    expect(before.why).not.toContain("强化学习");

    const b = setup(() => new BudgetDeferred(new Date().toISOString(), "周额度已用 75%"), 3);
    const lb = runShortlist(b.s);
    expect(await deepenShortlist(b.s, lb.id)).toBe(0);
    expect(b.calls).toHaveLength(1); // a refusal stops the rest of the week's run

    const c = setup((n) => (n === 1 ? new Error("模型超时") : good), 2);
    const lc = runShortlist(c.s);
    expect(await deepenShortlist(c.s, lc.id)).toBe(1); // the failed card keeps the rules' lines, the next one is reworded
    expect(c.calls).toHaveLength(2);
  });

  it("at most DEEP_PER_WEEK calls a week, counted from what this week already used", async () => {
    const { s, db, calls } = setup(() => good, 3);
    const ins = db.prepare("insert into llm_usage(id, at, purpose, ref, provider, model, input, output, cache_read, total, cost) values (?,?,?,?,?,?,?,?,?,?,?)");
    for (let i = 0; i < DEEP_PER_WEEK - 1; i++) ins.run(`u${i}`, new Date().toISOString(), "shortlist.fit", "", "p", "m", 1, 1, 0, 2, 0);
    const list = runShortlist(s);
    expect(await deepenShortlist(s, list.id)).toBe(1);
    expect(calls).toHaveLength(1);
  });

  it("a card decided meanwhile keeps its lines; the quote check ignores spaces and case", async () => {
    expect(quotedLine("「熟悉ros」：有", JD)).toBe("「熟悉ros」：有");
    expect(quotedLine("熟悉 ROS：有", JD)).toBeNull();
    const { s } = setup(() => good);
    const list = runShortlist(s);
    const { decideCard, latestShortlist } = await import("./shortlist.js");
    decideCard(s, { runId: list.id, key: list.cards[0].key, decision: "hold" });
    await deepenShortlist(s, list.id);
    expect(latestShortlist(s.domain.db)!.cards[0].why).toBe(list.cards[0].why);
  });
});

describe("补一下: a plan written once", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { openDb } = await import("../db.js");
  const { Domain } = await import("./domain.js");
  const { createServices, testConfig } = await import("../services.js");
  const { ingest } = await import("../data/index.js");
  const { tagCompany } = await import("../recommenders/index.js");
  const { upsertFact } = await import("./profile.js");
  const { backgroundKind, BudgetDeferred } = await import("../budget/index.js");
  const { currentPurpose } = await import("./usage.js");
  const { callTool } = await import("../registry.js");
  const { runShortlist, fillPlan, latestShortlist } = await import("./shortlist.js");
  const HUMAN = { kind: "human", via: "desktop" } as any;

  const JD = "岗位职责：\n1. 负责水下机器人运动控制算法开发\n任职要求：\n1. 熟悉 ROS 和 Gazebo 仿真\n2. 硕士及以上学历";
  function setup(answer: any, o: { project?: boolean; llm?: boolean } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "zhiro-shortlist-plan-"));
    const db = openDb(join(dir, "t.db"));
    const domain = new Domain(db);
    ingest(domain, dir, "capture", "c1", ["j1", "j2"].map((id) => ({ externalId: id, url: `https://example.org/jobs/${id}`, title: `控制算法工程师${id}`, company: id === "j1" ? "示例海工有限公司" : "示例船舶有限公司",
      locations: ["武汉"], description: JD, validThrough: "2099-12-31", publisher: "site:example", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "校招" }) as any));
    const s = createServices({ db, domain, config: testConfig(dir, { sources: [] }) });
    for (const co of db.prepare("select id from company").all() as any[]) tagCompany(s, { companyId: co.id, tag: "重点", reason: "测试" });
    if (o.project !== false) upsertFact(db, { kind: "project", data: { title: "水面无人艇航迹跟踪控制" } }, "本人确认");
    const calls: { kind: string | null; purpose: string; text: string }[] = [];
    if (o.llm !== false) (s as any).llm = { model: () => ({ id: "fake" }), models: { completeSimple: async (_m: any, req: any) => {
      calls.push({ kind: backgroundKind(), purpose: currentPurpose().purpose, text: req.messages[0].content[0].text });
      if (answer instanceof Error) throw answer;
      return { content: [{ type: "text", text: JSON.stringify(answer) }] };
    } } };
    const list = runShortlist(s);
    const card = list.cards.find((c) => c.title.endsWith("j1"))!;
    return { s, db, calls, list, card };
  }
  const good = { project: "水面无人艇航迹跟踪控制", task: "把航迹跟踪控制器搬到 ROS 里，用 Gazebo 跑一遍仿真并录屏", time: "三个晚上" };

  it("one held call under shortlist.fill; the plan quotes the post, names the person's project, counts days and other posts; not asked twice", async () => {
    const { s, calls, list, card } = setup(good);
    expect(card.gap).toMatch(/「.+」/);
    await callTool("shortlist.decide", { runId: list.id, key: card.key, decision: "fill" }, HUMAN, s);
    await new Promise((r) => setTimeout(r, 20));
    const plan = latestShortlist(s.domain.db)!.cards.find((c) => c.key === card.key)!.plan!;
    expect(calls.map((c) => [c.kind, c.purpose])).toEqual([["shortlist_fill", "shortlist.fill"]]);
    expect(calls[0].text).toContain("水面无人艇航迹跟踪控制");
    expect(plan).toContain(`差的：「${/「([^」]+)」/.exec(card.gap)![1]}」`);
    expect(plan).toContain("接着你的「水面无人艇航迹跟踪控制」做");
    expect(plan).toContain("大约要：三个晚上");
    expect(plan).toMatch(/还剩 \d+ 天截止/);
    expect(plan).toContain("还能投另外 1 个要它的岗位");
    await fillPlan(s, list.id, card.key);
    expect(calls).toHaveLength(1);
  });

  it("no model, no project, a refusal, an error or a plan on a project they do not have: said plainly, no plan", async () => {
    const cases: [any, any, string][] = [
      [good, { llm: false }, "现在没有能用的模型"],
      [good, { project: false }, "资料里还没有项目或经历"],
      [new BudgetDeferred(new Date().toISOString(), "周额度已用 75%"), {}, "额度要先留给你自己用（周额度已用 75%）"],
      [new Error("超时"), {}, "模型出错了"],
      [{ ...good, project: "强化学习四足机器人" }, {}, "没接上你资料里的项目"],
    ];
    for (const [answer, o, said] of cases) {
      const { s, list, card } = setup(answer, o);
      await fillPlan(s, list.id, card.key);
      const c = latestShortlist(s.domain.db)!.cards.find((x) => x.key === card.key)!;
      expect(c.plan).toBeUndefined();
      expect(c.planNote).toContain(said);
    }
  });
});
