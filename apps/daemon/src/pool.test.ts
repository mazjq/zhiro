import { describe, it, expect, vi } from "vitest";
import { createServices, testConfig } from "./services.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Domain } from "./service/domain.js";
import { callTool, callableBy, type Services, type Actor } from "./registry.js";
import { ingest } from "./data/index.js";
import type { Listing } from "./data/index.js";
import { rerunAuto } from "./recommenders/index.js";
import { officialTarget } from "./service/apply-run.js";
import { withPurpose, recordUsage, usageSummary } from "./service/usage.js";

// the daemon reruns the recommenders after a profile change in the background; tests wait for that run explicitly
let pending: Promise<void> = Promise.resolve();
const settle = () => pending;

const HUMAN: Actor = { kind: "human", via: "desktop" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-pool-"));
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const s: Services = createServices({ db: db, domain, config: testConfig(dir, { sources: [] }) });
  s.onDataChanged = () => { pending = rerunAuto(s); };
  return { dir, domain, s };
}

const listing = (o: Partial<Listing>): Listing => ({
  externalId: o.title ?? "x", url: "https://example.com/j", title: "底盘控制算法工程师", company: "示例汽车", locations: ["武汉"],
  publisher: "示例汽车", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "秋招", ...o,
});

describe("pool: multi-source merge (ADR-015)", () => {
  it("one company row; official value wins; the aggregator's claim is shown, not applied", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "moka-demo", [listing({ validThrough: "2099-10-20", degreeReq: "博士" }), listing({ title: "仿真建模工程师", externalId: "2" })]);
    // the aggregator spells the company with its legal suffix, has an older deadline and re-lists the same job
    ingest(domain, dir, "sheet", "sheet-1", [listing({ company: "示例汽车有限公司", grade: "聚合", isOriginal: false, publisher: "汇总表", validThrough: "2099-10-15", title: "底盘控制算法工程师 " })]);

    const { items } = (await callTool("pool.list", {}, HUMAN, s)) as any;
    expect(items).toHaveLength(1);
    expect(items[0].closesAt).toBe("2099-10-20");
    expect(items[0].grade).toBe("官方");
    expect(items[0].sources).toHaveLength(2);
    expect(items[0].conflicts).toEqual([expect.objectContaining({ value: "2099-10-15", grade: "聚合" })]);
    expect(items[0].positions.map((p: any) => p.title).sort()).toEqual(["仿真建模工程师", "底盘控制算法工程师"]);
    expect(items[0].positions.find((p: any) => p.title.startsWith("底盘")).grades).toEqual(["官方", "聚合"]);

    // the bad source rescans with nonsense: the official campaign row is untouched
    ingest(domain, dir, "sheet", "sheet-1", [listing({ company: "示例汽车有限公司", grade: "聚合", publisher: "汇总表", validThrough: "2001-01-01" })]);
    expect(((await callTool("pool.list", {}, HUMAN, s)) as any).items[0].closesAt).toBe("2099-10-20");
  });

  it("several open batches: the nearest date is the company's deadline, unless an official source states one", async () => {
    const { dir, domain, s } = setup();
    // 库犸 on 2026-09-30: an official portal without dates and two sheet rows, 12-31 (verified last) and 9-30
    ingest(domain, dir, "feishu-jobs", "fj", [listing({ company: "库犸科技", title: "机器人算法工程师" })]);
    ingest(domain, dir, "sheet", "s1", [listing({ company: "库犸科技", grade: "校方转载", publisher: "汇总表", batch: "秋招", validThrough: "2099-09-30", title: "算法" })]);
    ingest(domain, dir, "sheet", "s2", [listing({ company: "库犸科技", grade: "校方转载", publisher: "汇总表2", batch: "秋招2", validThrough: "2099-12-31", title: "软件" })]);
    const it0 = ((await callTool("pool.list", {}, HUMAN, s)) as any).items[0];
    expect(it0.closesAt).toBe("2099-09-30");
    // two batches from the same kind of source close on different days: by ADR-041 that is no disagreement, so the
    // company page's 「其他来源写的截止」 no longer lists 12-31 (2026-10-14; it did before)
    expect(it0.conflicts).toEqual([]);
  });

  it("a full pull closes the posts it no longer lists, reopens one that comes back, never touches an applied-to post", async () => {
    const { dir, domain, s } = setup();
    const tick = () => new Promise((r) => setTimeout(r, 5));
    ingest(domain, dir, "moka", "m", [listing({ title: "甲" }), listing({ title: "乙", externalId: "2" }), listing({ title: "丙", externalId: "3" })], { closeUnseen: true });
    const id = (t: string) => (domain.db.prepare("select id from position where title = ?").get(t) as any).id;
    await callTool("application.create", { positionId: id("丙") }, HUMAN, s);
    await tick();
    expect(ingest(domain, dir, "moka", "m", [listing({ title: "甲" })], { closeUnseen: true }).positionsClosed).toBe(1);
    const st = (t: string) => (domain.db.prepare("select status from position where title = ?").get(t) as any).status;
    expect([st("甲"), st("乙"), st("丙")]).toEqual(["open", "closed", "open"]);
    await tick();
    ingest(domain, dir, "capture", "c", [listing({ title: "丁", company: "别家" })]); // a captured page closes nothing
    ingest(domain, dir, "moka", "m", [listing({ title: "甲" }), listing({ title: "乙", externalId: "2" })], { closeUnseen: true });
    expect(st("乙")).toBe("open");
    expect(ingest(domain, dir, "moka", "m", [], { closeUnseen: true }).positionsClosed).toBe(0); // an empty answer is not "all taken down"
    // a whole batch the site no longer lists (a stale 专项 list dropped): its posts close too; another subscription's do not
    await tick();
    ingest(domain, dir, "moka", "m", [listing({ title: "甲" }), listing({ title: "专项岗", externalId: "9", batch: "专项" })], { closeUnseen: true });
    ingest(domain, dir, "moka", "other", [listing({ title: "别的订阅岗", externalId: "o1", company: "别家", batch: "专项" })], { closeUnseen: true });
    await tick();
    expect(ingest(domain, dir, "moka", "m", [listing({ title: "甲" })], { closeUnseen: true }).positionsClosed).toBeGreaterThanOrEqual(1);
    expect([st("专项岗"), st("别的订阅岗"), st("丙")]).toEqual(["closed", "open", "open"]);
  });

  it("different legal entities stay apart until a human merges them", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "a", [listing({ company: "东风汽车集团" })]);
    ingest(domain, dir, "moka", "b", [listing({ company: "东风汽车股份" })]);
    const before = ((await callTool("pool.list", {}, HUMAN, s)) as any).items;
    expect(before).toHaveLength(2);
    await callTool("company.merge", { fromId: before[1].companyId, intoId: before[0].companyId }, HUMAN, s);
    expect(((await callTool("pool.list", {}, HUMAN, s)) as any).items).toHaveLength(1);
    // later scans under the old name land on the survivor
    ingest(domain, dir, "moka", "b", [listing({ company: before[1].companyName, title: "新岗位" })]);
    expect(((await callTool("pool.list", {}, HUMAN, s)) as any).items).toHaveLength(1);
  });
});

describe("profile + recommend", () => {
  it("fact upsert dedups and never degrades an existing card", async () => {
    const { s } = setup();
    const a: any = await callTool("fact.upsert", { kind: "publication", data: { title: "Robust DP Control of Vessels", venue: "Ocean Eng." } }, HUMAN, s);
    const b: any = await callTool("fact.upsert", { kind: "publication", data: { title: "robust dp control of vessels.", venue: "WRONG", year: "2026" }, source: { quote: "from the PDF" } }, { kind: "system", via: "workflow" }, s);
    expect(b.created).toBe(false);
    expect(b.fact.id).toBe(a.fact.id);
    expect(b.fact.data).toMatchObject({ venue: "Ocean Eng.", year: "2026" });
    expect(b.fact.grade).toBe("本人确认");
    expect(b.fact.sources).toHaveLength(1);
    await expect(callTool("fact.upsert", { kind: "education", data: { school: "X" } }, HUMAN, s)).rejects.toMatchObject({ code: "MISSING_FIELD" });
  });

  it("position.list filters by the post's own major / degree / city, falling back to the campaign's", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "m-1", [listing({ company: "国能", externalId: "a", title: "智能控制研究员", majorReq: "控制科学与工程类相关专业,自动化", degreeReq: "博士研究生", locations: ["南京"] }), listing({ company: "国能", externalId: "b", title: "热动研究员", majorReq: "能源与动力工程", degreeReq: "博士研究生", locations: ["南京"] }), listing({ company: "国能", externalId: "c", title: "电气工程师", majorReq: "电气工程及其自动化", degreeReq: "硕士研究生", locations: ["北京"] })]);
    // several words are alternatives: 「控制科学与工程 自动化」 also finds 电气工程及其自动化 (硕士, filtered out by 博士 here)
    const hit = ((await callTool("position.list", { major: "控制科学与工程 自动化", degree: "博士" }, HUMAN, s)) as any).items;
    expect(hit.map((p: any) => p.title)).toEqual(["智能控制研究员"]);
    expect(hit[0].majorReq).toContain("控制科学与工程");
    expect(((await callTool("position.list", { major: "控制科学与工程 自动化" }, HUMAN, s)) as any).items.map((p: any) => p.title).sort()).toEqual(["智能控制研究员", "电气工程师"]);
    expect(((await callTool("position.list", { major: "自动化", city: "北京" }, HUMAN, s)) as any).items.map((p: any) => p.title)).toEqual(["电气工程师"]);
    // a campaign whose deadline has passed is not 在招 unless asked
    ingest(domain, dir, "moka", "m-old", [listing({ company: "旧公司", externalId: "o", title: "过期控制岗", majorReq: "自动化", degreeReq: "博士", validThrough: "2020-01-01" })]);
    expect(((await callTool("position.list", { major: "自动化", degree: "博士" }, HUMAN, s)) as any).items.map((p: any) => p.title)).toEqual(["智能控制研究员"]);
    expect(((await callTool("position.list", { major: "自动化", degree: "博士", includeExpired: true }, HUMAN, s)) as any).items.map((p: any) => p.title).sort()).toEqual(["智能控制研究员", "过期控制岗"]);
  });

  it("期望卡 (ADR-036): a hard city hides 不符合 only when asked, 待核实 stays, 不投 companies fail, 重点 and 不投 exclude each other", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "m-wh", [listing({ company: "武汉公司", locations: ["武汉"] })]);
    ingest(domain, dir, "moka", "m-bj", [listing({ company: "北京公司", locations: ["北京"] })]);
    ingest(domain, dir, "moka", "m-na", [listing({ company: "没写地方公司", locations: [] })]);
    await callTool("fact.upsert", { kind: "preference", data: { field: "城市", value: "武汉、深圳", mode: "硬性" } }, HUMAN, s);
    await expect(callTool("fact.upsert", { kind: "preference", data: { field: "行业", value: "机器人", mode: "硬性" } }, HUMAN, s)).rejects.toMatchObject({ code: "BAD_MODE" });
    // one card per field: a second 城市 card merges into the first instead of adding a row
    await callTool("fact.upsert", { kind: "preference", data: { field: "城市", value: "上海" } }, HUMAN, s);
    expect(((await callTool("fact.list", { kind: "preference" }, HUMAN, s)) as any).items).toHaveLength(1);

    const all = (await callTool("pool.list", { sort: "match" }, HUMAN, s)) as any;
    const st = Object.fromEntries(all.items.map((c: any) => [c.companyName, c.expectation.status]));
    expect(st).toEqual({ 武汉公司: "pass", 北京公司: "fail", 没写地方公司: "unknown" });
    expect(all.items[0].companyName).toBe("武汉公司"); // pass before unknown before fail
    expect(all.items.find((c: any) => c.companyName === "北京公司").positions[0].expectation.reasons[0]).toMatchObject({ field: "城市", status: "fail", evidence: "北京", hard: true });

    const shown = (await callTool("pool.list", { hideExpectationFail: true }, HUMAN, s)) as any;
    expect(shown.items.map((c: any) => c.companyName).sort()).toEqual(["武汉公司", "没写地方公司"]);

    const wh = all.items.find((c: any) => c.companyName === "武汉公司").companyId;
    await callTool("recommend.tag", { companyId: wh, tag: "重点" }, HUMAN, s);
    await callTool("recommend.tag", { companyId: wh, tag: "不投" }, HUMAN, s);
    const after = (await callTool("pool.list", { companyId: wh }, HUMAN, s)) as any;
    expect(after.items[0].tags.map((t: any) => t.tag)).toEqual(["不投"]);
    expect(after.items[0].expectation.status).toBe("fail");
    expect(((await callTool("pool.list", { hideExpectationFail: true }, HUMAN, s)) as any).items.map((c: any) => c.companyName)).toEqual(["没写地方公司"]);
  });

  it("profile_match: degree is a hard gate, tags are per company, rerun replaces only its own rows", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "a", [
      listing({ title: "运动控制算法工程师", degreeReq: "硕士及以上" }),
      listing({ title: "控制理论研究员", externalId: "2", degreeReq: "博士研究生" }),
      listing({ title: "行政专员", externalId: "3" }),
    ]);
    await expect(callTool("recommend.run", { mode: "profile_match" }, HUMAN, s)).rejects.toMatchObject({ code: "PROFILE_EMPTY" });
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "硕士", major: "控制科学与工程" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "direction", data: { keyword: "运动控制" } }, HUMAN, s); await settle(); // auto mode reruns on profile change

    let co = ((await callTool("pool.list", { recommendedOnly: true }, HUMAN, s)) as any).items;
    expect(co).toHaveLength(1);
    expect(co[0].tags.map((t: any) => t.tag)).toEqual(["画像匹配"]);
    expect(co[0].positions.filter((p: any) => p.match).map((p: any) => p.title)).toEqual(["运动控制算法工程师"]);

    await callTool("recommend.tag", { companyName: "示例汽车", tag: "我点名的", reason: "想去" }, HUMAN, s);
    await callTool("recommend.run", { mode: "profile_match" }, HUMAN, s);
    co = ((await callTool("pool.list", { recommendedOnly: true }, HUMAN, s)) as any).items;
    expect(co[0].tags.map((t: any) => t.tag).sort()).toEqual(["我点名的", "画像匹配"].sort());
    expect(domain.db.prepare("select count(*) as n from recommendation where mode = 'profile_match'").get()).toEqual({ n: 1 });

    // ADR-025: a tag is reversible, so an agent does it at once and it is logged with an undo
    const r: any = await callTool("recommend.tag", { companyName: "示例汽车", tag: "小而强" }, { kind: "agent", via: "mcp" }, s);
    expect(r.ok).toBe(true);
    expect(r.action.undoable).toBe(true);
  });
});

describe("applications page", () => {
  it("application.list carries company, title, stages and the last event", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "a", [listing({})]);
    const pos = domain.listPositions({}).items[0];
    const { application }: any = await callTool("application.create", { positionId: pos.id }, HUMAN, s);
    await callTool("application.update", { id: application.id, state: "submitted" }, HUMAN, s);
    await callTool("stage.add", { applicationId: application.id, kind: "笔试" }, HUMAN, s);
    const { items }: any = await callTool("application.list", {}, HUMAN, s);
    expect(items[0]).toMatchObject({ companyName: "示例汽车", title: "底盘控制算法工程师", application: { state: "in_process" } });
    expect(items[0].stages).toHaveLength(1);
    expect(items[0].lastEvent.kind).toBe("stage");
  });
});

import { majorStems, weakTerms } from "./recommenders/profile-match.js";
import { scheduleAllDeadlines, deadlineReminder } from "./workflows/deadline.js";

describe("profile_match vocabulary", () => {
  it("majors are matched by stem, long directions also by head noun", () => {
    expect(majorStems("控制科学与工程")).toEqual(expect.arrayContaining(["控制科学与工程", "控制"]));
    expect(majorStems("电气工程及其自动化")).toContain("电气");
    expect(weakTerms(["运动控制", "动力定位", "mpc"])).toEqual(["控制", "定位"]);
  });

  it("a slash-separated keyword and a 控制科学与工程 PhD find 控制算法 jobs; major alone never recommends a non-technical job", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "sheet", "x", [
      listing({ title: "控制算法工程师", majorReq: "控制类、自动化" }),
      listing({ title: "报关岗", externalId: "2", majorReq: "控制类、自动化" }),
    ]);
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "博士", major: "控制科学与工程" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "direction", data: { keyword: "动力定位/运动控制" } }, HUMAN, s); await settle();
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "本科", major: "自动化" } }, HUMAN, s);
    const co = ((await callTool("pool.list", { recommendedOnly: true }, HUMAN, s)) as any).items[0];
    expect(co.positions.filter((p: any) => p.match).map((p: any) => p.title)).toEqual(["控制算法工程师"]);
  });
});

describe("岗位适配度 v2 (ADR-035): 库犸 regression", () => {
  const 规控 = `岗位职责
1. 负责移动机器人自主导航、运动规划及控制等相关软件算法的研究与开发；
2. 参与实地测试与调优。
任职要求
1. 硕士及以上学历，自动化、电子、控制、机器人、计算机等相关专业；
2. 熟悉C/C++编程，熟悉Linux/ROS开发环境；
3. 具备对运动机器人建模的能力；
4. 熟悉常见的规划控制算法，有DWA、A*、MPC、PID、LQR等算法的开发经验。`;
  const 具身 = `岗位职责
1. 负责末端执行器的机械与控制方案设计；
2. 实现接触式任务所需的力控/阻抗控制；
3. 负责运动学标定、碰撞检测与安全边界设计。
任职要求
1. 机器人学/控制理论相关方向硕士及以上，有机械臂控制经验；
2. 熟悉力控/阻抗控制/导纳控制等柔顺控制方法；
3. 熟悉机器人运动学、动力学建模；
4. 熟悉ROS/ROS2及实时控制系统开发。`;
  const 测试 = `岗位职责
1. 负责嵌入式软件的自动化测试用例设计与执行。
任职要求
1. 熟练使用 Git，了解仿真测试平台。`;
  async function world() {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "feishu-jobs", "k", [
      listing({ company: "库犸科技", title: "规控算法工程师（深圳）", degreeReq: "硕士及以上", description: 规控, locations: ["深圳"] }),
      listing({ company: "库犸科技", title: "【具身智能】运动控制算法工程师", externalId: "2", degreeReq: "硕士及以上", description: 具身, locations: ["深圳"] }),
      listing({ company: "库犸科技", title: "自动化测试工程师", externalId: "3", degreeReq: "本科及以上", description: 测试, locations: ["深圳"] }),
    ]);
    ingest(domain, dir, "sheet", "x", [listing({ company: "库犸科技", title: "运动规划算法工程师", grade: "聚合", publisher: "汇总表", majorReq: "自动化、计算机", locations: ["深圳"] })]);
    ingest(domain, dir, "chnenergy", "n", [listing({ company: "国家能源集团", title: "电气工程师（某电厂）", degreeReq: "大学本科", description: "技能岗;某电厂;专业:自动化类;大学本科;1人", locations: ["湖北武汉"] })]);
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "博士", major: "控制科学与工程" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "direction", data: { keyword: "动力定位/运动控制" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "本科", major: "自动化" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "project", data: { title: "海洋平台动力定位控制", role: "骨干", period: "2024—2027", description: "围绕海洋平台动力定位开展动力学建模、扰动估计与补偿、控制器设计" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "skill", data: { name: "MATLAB / Simulink", level: "熟练" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "skill", data: { name: "C/C++", level: "熟练" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "skill", data: { name: "单片机编程", level: "熟练" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "preference", data: { field: "城市", value: "武汉" } }, HUMAN, s); await settle();
    return { dir, domain, s };
  }
  const tierOf = (co: any, t: string) => co.positions.find((p: any) => p.title === t)?.match?.reason.split(" · ")[0];

  it("规控 is transferable with what is still open named; 具身 is transferable until the 机械臂 gap is confirmed; testing is not recommended; leads stay leads", async () => {
    const { s } = await world();
    const items = ((await callTool("pool.list", { recommendedOnly: true }, HUMAN, s)) as any).items;
    const ku = items.find((c: any) => c.companyName === "库犸科技"), gn = items.find((c: any) => c.companyName === "国家能源集团");
    expect(tierOf(ku, "规控算法工程师（深圳）")).toBe("可迁移");
    const why = ku.positions.find((p: any) => p.title === "规控算法工程师（深圳）").match.reason;
    expect(why).toMatch(/证据.*动力学建模/); expect(why).toMatch(/待核实.*ros/);
    expect(tierOf(ku, "【具身智能】运动控制算法工程师")).toBe("可迁移");
    expect(ku.positions.find((p: any) => p.title === "【具身智能】运动控制算法工程师").match.reason).toMatch(/待核实.*机械臂/);
    expect(ku.positions.find((p: any) => p.title === "自动化测试工程师")?.match ?? undefined).toBeUndefined();
    expect(tierOf(ku, "运动规划算法工程师")).toBe("待补资料"); // a sheet row naming the user's major: a lead, not a match
    expect(tierOf(gn, "电气工程师（某电厂）")).toBe("待补资料"); // a one-line post naming the major: a lead, never 学历不相称
    expect(ku.positions[0].title).toBe("规控算法工程师（深圳）");
    // post-level filters keep working on the new bands
    expect(((await callTool("pool.list", { minTier: "可迁移", city: "深圳" }, HUMAN, s)) as any).items[0].positions.map((p: any) => p.title)).toEqual(["规控算法工程师（深圳）", "【具身智能】运动控制算法工程师"]);
    expect(((await callTool("pool.list", { minTier: "优先考虑" }, HUMAN, s)) as any).items).toHaveLength(0);
  });

  it("a confirmed gap is the only negative: 没做过机械臂 turns 具身 into 明显缺口 and the ledger says so", async () => {
    const { s } = await world();
    await callTool("gap.confirm", { conceptId: "d_manipulator", status: "confirmed", note: "没做过" }, HUMAN, s); await settle();
    const ku = ((await callTool("pool.list", { recommendedOnly: true }, HUMAN, s)) as any).items.find((c: any) => c.companyName === "库犸科技");
    expect(tierOf(ku, "【具身智能】运动控制算法工程师")).toBe("明显缺口");
    const ledger = (await callTool("gap.list", {}, HUMAN, s)) as any;
    const ros = ledger.items.find((x: any) => x.conceptId === "ros");
    expect(ros).toMatchObject({ status: "unknown" });
    expect(ros.positions).toBeGreaterThanOrEqual(2); expect(ros.companies).toBe(1); // two 库犸 posts, one company
    expect(ledger.items.find((x: any) => x.conceptId === "d_manipulator")).toMatchObject({ status: "gap" });
  });
});

describe("岗位适配度 layer 2 (ADR-034)", () => {
  it("queued posts get the model's reading, it shows on the pool, a profile change marks it stale", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "a", [listing({ title: "运动控制算法工程师", description: "负责 MPC 控制算法" })]);
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "博士", major: "控制科学与工程" } }, HUMAN, s);
    const prompts: string[] = [];
    (s as any).llm = { model: () => ({ id: "stub" }), models: { completeSimple: async (_m: any, ctx: any) => { prompts.push(ctx.messages[0].content[0].text); return { content: [{ type: "text", text: '```json\n{"score": 86, "verdict": "对口", "meets": ["博士，控制科学与工程"], "gaps": []}\n```' }] }; } } };
    const id = (domain.db.prepare("select id from position").get() as any).id;
    expect(await callTool("fit.deep", { positionIds: [id] }, HUMAN, s)).toMatchObject({ queued: 1 });
    for (let i = 0; i < 50 && ((await callTool("fit.list", { positionIds: [id] }, HUMAN, s)) as any).pending.length; i++) await new Promise((r) => setTimeout(r, 10));
    const fit = ((await callTool("fit.list", { positionIds: [id] }, HUMAN, s)) as any).items[0];
    expect(fit).toMatchObject({ score: 86, verdict: "对口", meets: ["博士，控制科学与工程"], stale: false, model: "stub" });
    expect(prompts[0]).toMatch(/控制科学与工程[\s\S]*运动控制算法工程师[\s\S]*MPC/);
    expect(((await callTool("pool.list", {}, HUMAN, s)) as any).items[0].positions[0].fit).toEqual({ score: 86, verdict: "对口" });
    expect(await callTool("fit.deep", { positionIds: [id] }, HUMAN, s)).toMatchObject({ queued: 0, alreadyDone: 1 });
    await callTool("fact.upsert", { kind: "skill", data: { name: "ROS" } }, HUMAN, s);
    expect(((await callTool("fit.list", { positionIds: [id] }, HUMAN, s)) as any).items[0].stale).toBe(true);
  });
});

describe("国聘全站发现 (ADR-034)", () => {
  it("keywords follow the profile: direction words and the core of each major", async () => {
    const { s } = setup();
    const { discoveryKeywords } = await import("./service/official.js");
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "博士", major: "控制科学与工程" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "本科", major: "自动化" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "direction", data: { keyword: "动力定位/运动控制" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "本科", major: "自动化" } }, HUMAN, s);
    expect(discoveryKeywords(s)).toEqual(["动力定位", "运动控制", "控制", "自动化"]);
  });
});

describe("待补资料 leads (ADR-035)", () => {
  it("a sheet lead behind a 公众号 page is listed once, unreadable, with its deadline; a readable site is not a lead", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "feishu-base", "x", [
      listing({ company: "某机器人公司", title: "运动控制类", grade: "聚合", publisher: "汇总表", majorReq: "自动化、控制", url: "https://mp.weixin.qq.com/s/abc", validThrough: "2099-10-20" }),
      listing({ company: "某北森公司", title: "运动控制工程师", externalId: "2", grade: "聚合", publisher: "汇总表", majorReq: "自动化", url: "https://x.zhiye.com/campus" }),
    ]);
    await callTool("fact.upsert", { kind: "education", data: { school: "某大学", degree: "博士", major: "自动化" } }, HUMAN, s);
    await callTool("fact.upsert", { kind: "direction", data: { keyword: "运动控制" } }, HUMAN, s); await settle();
    const { listLeads } = await import("./service/leads.js");
    const leads = listLeads(s);
    expect(leads.map((l) => l.companyName).sort()).toEqual(["某北森公司", "某机器人公司"]);
    const wx = leads.find((l) => l.companyName === "某机器人公司")!, bs = leads.find((l) => l.companyName === "某北森公司")!;
    expect(wx).toMatchObject({ readable: false, closesAt: "2099-10-20", attemptedAt: null, url: "https://mp.weixin.qq.com/s/abc" });
    expect(bs.readable).toBe(true); // official.ts pulls it; lead.resolve skips it
  });
});

describe("deadline reminders follow relevance", () => {
  it("a reminder per held post, by its own deadline (ADR-041): watching starts it, a new day replaces it, submitting or unwatching drops it", async () => {
    const { dir, domain, s } = setup();
    s.workflows.register(deadlineReminder(s));
    ingest(domain, dir, "sheet", "x", [listing({ validThrough: "2099-10-20", grade: "聚合", isOriginal: false }), listing({ company: "无关公司", validThrough: "2099-10-21" })]);
    expect(scheduleAllDeadlines(s)).toBe(0);
    // a tag on the company is not a post held: the 今日 page shows it, no reminder is sent for it
    await callTool("recommend.tag", { companyName: "示例汽车", tag: "我点名的" }, HUMAN, s);
    expect(scheduleAllDeadlines(s)).toBe(0);
    const co = ((await callTool("pool.list", { recommendedOnly: true }, HUMAN, s)) as any).items[0], id = co.positions[0].id;
    expect(((await callTool("today.summary", { days: 40000 }, HUMAN, s)) as any).deadlines).toEqual([expect.objectContaining({ companyName: "示例汽车", positionId: null, closesAt: "2099-10-20", verified: false })]);
    await callTool("position.watch", { positionId: id, priority: 2 }, HUMAN, s);
    expect(scheduleAllDeadlines(s)).toBe(1);
    const keys = () => (domain.db.prepare("select idempotency_key k from workflow where kind = 'deadline_reminder' and state = 'running'").all() as any[]).map((w) => w.k);
    expect(keys()).toEqual([`deadline_reminder:${id}:2099-10-20`]);
    // the person corrects the day: the reminder follows, the old one is gone
    await callTool("campaign.deadline", { companyId: co.companyId, positionId: id, date: "2099-11-30" }, HUMAN, s);
    expect(scheduleAllDeadlines(s)).toBe(1);
    expect(keys()).toEqual([`deadline_reminder:${id}:2099-11-30`]);
    // 待核实: a sheet's word only → listed until an official sentence or the person's word settles it
    await callTool("campaign.deadline", { companyId: co.companyId, positionId: id, clear: true }, HUMAN, s);
    expect(((await callTool("deadline.pending", {}, HUMAN, s)) as any).items).toEqual([expect.objectContaining({ positionId: id, verified: false, why: "还没有可靠的截止信息" })]);
    await callTool("deadline.report", { positionId: id, policy: "until_filled", grade: "官方", evidence: "不设置投递截止日期，招满即止" }, HUMAN, s);
    expect(((await callTool("deadline.pending", {}, HUMAN, s)) as any).items[0]).toMatchObject({ conflict: true, why: "不同来源写的截止不一样" });
    expect(scheduleAllDeadlines(s)).toBe(1);
    expect(keys()).toEqual([`deadline_reminder:${id}:asap`]);
    await callTool("position.watch", { positionId: id, priority: 0 }, HUMAN, s);
    expect(scheduleAllDeadlines(s)).toBe(0);
    expect(domain.db.prepare("select count(*) as n from workflow where kind = 'deadline_reminder' and state = 'running'").get()).toEqual({ n: 0 });
  });
});

describe("a deadline that moves and moves back (B28)", () => {
  it("says every change from the day last told: A → B, then B → A", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "x", [listing({ validThrough: "2099-10-20" })]);
    const co = ((await callTool("pool.list", {}, HUMAN, s)) as any).items[0], id = co.positions[0].id;
    await callTool("position.watch", { positionId: id, priority: 2 }, HUMAN, s);
    const step = () => deadlineReminder(s).steps.remind({ subjectId: id, checkpoint: {} } as any);
    const told = () => (domain.db.prepare("select body from notice where kind = 'deadline' and title like '截止已更新%' order by rowid").all() as any[]).map((r) => JSON.parse(r.body)[0] as string);
    await step(); // 2099-10-20 known: nothing changed yet
    await callTool("campaign.deadline", { companyId: co.companyId, positionId: id, date: "2099-11-30" }, HUMAN, s);
    await step();
    await callTool("campaign.deadline", { companyId: co.companyId, positionId: id, date: "2099-10-20" }, HUMAN, s);
    await step();
    expect(told()).toHaveLength(2);
    expect(told()[1]).toContain("改为 **");
    expect(told()[1]).toMatch(/11.*30.*改为.*10.*20/);
  });
});

describe("deadline reminders count Beijing calendar days", () => {
  it("「剩 1 天」 the morning before, 「今天」 the morning of, nothing after — not hours rounded up (2026-10-28)", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "x", [listing({ validThrough: "2099-10-20" })]);
    const id = ((await callTool("pool.list", {}, HUMAN, s)) as any).items[0].positions[0].id;
    await callTool("position.watch", { positionId: id, priority: 2 }, HUMAN, s);
    const said = () => (domain.db.prepare("select body from notice where kind = 'deadline' and title like '截止提醒%' order by rowid").all() as any[]).map((r) => JSON.parse(r.body)[0] as string);
    const at = async (iso: string) => { vi.setSystemTime(new Date(iso)); return deadlineReminder(s).steps.remind({ subjectId: id, checkpoint: {} } as any) as Promise<any>; };
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      // the machine may sit anywhere: 09:00 Beijing on the 19th is 19:00 the day before at UTC−6
      const r1 = await at("2099-10-19T09:00:00+08:00");
      expect(said().at(-1)).toContain("剩 1 天");
      expect(r1).toEqual({ type: "sleep", until: new Date("2099-10-20T09:00:00+08:00").toISOString() }); // no waking every minute
      await at("2099-10-20T09:00:00+08:00");
      expect(said().at(-1)).toContain("今天");
      expect(await at("2099-10-21T00:30:00+08:00")).toEqual({ type: "done" });
      expect(said()).toHaveLength(2);
    } finally { vi.useRealTimers(); }
  });
});

describe("搜索模式 (presets) and 排除词", () => {
  it("must = AND, any = OR, exclude = NOT; the preset's tag ranks by its own score; a global 排除词 applies to every mode", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "sheet", "x", [
      listing({ title: "船舶运动控制算法工程师" }),
      listing({ title: "运动控制算法实习生", externalId: "2" }),
      listing({ title: "电机控制工程师", externalId: "3", company: "另一家" }),
      listing({ title: "船舶销售经理", externalId: "4", company: "另一家" }),
    ]);
    const saved: any = await callTool("preset.save", { name: "精确-船舶控制", must: ["船舶", "控制"], exclude: ["实习", "销售"] }, HUMAN, s);
    expect(saved).toMatchObject({ hits: 1, companies: 1 });
    const wide: any = await callTool("preset.save", { name: "宽-控制类", any: ["运动控制/电机", "控制"], exclude: ["销售"] }, HUMAN, s);
    expect(wide.hits).toBe(3);
    await expect(callTool("preset.save", { name: "空的" }, HUMAN, s)).rejects.toMatchObject({ code: "MISSING_FIELD" });

    const byTag = ((await callTool("pool.list", { tag: "宽-控制类" }, HUMAN, s)) as any).items;
    expect(byTag.map((c: any) => c.companyName)).toEqual(["示例汽车", "另一家"]); // same top score; ties keep pool order
    expect(byTag[0].tags.map((t: any) => t.tag).sort()).toEqual(["宽-控制类", "精确-船舶控制"].sort());

    // a global exclude word removes 实习 everywhere on the next run
    await callTool("fact.upsert", { kind: "exclude", data: { keyword: "实习" } }, HUMAN, s); await settle();
    const after = ((await callTool("pool.list", { tag: "宽-控制类" }, HUMAN, s)) as any).items.flatMap((c: any) => c.positions.filter((p: any) => p.match).map((p: any) => p.title));
    expect(after).not.toContain("运动控制算法实习生");

    const sug: any = await callTool("recommend.suggest", { presetId: wide.preset.id }, HUMAN, s);
    expect(sug.include.map((x: any) => x.word)).toContain("算法");

    await callTool("preset.remove", { id: wide.preset.id }, HUMAN, s);
    expect(((await callTool("pool.list", { tag: "宽-控制类" }, HUMAN, s)) as any).items).toHaveLength(0);
  });
});

import { companyKey } from "./service/domain.js";

describe("company name key", () => {
  it("ignores spacing and width, keeps letters (regression: the whitespace rule once read /s+/ and ate the letter s)", () => {
    expect(companyKey("DJI 大疆")).toBe(companyKey("DJI大疆"));
    expect(companyKey("TOP TOY")).toBe("toptoy");
    expect(companyKey("ｓgs（上海）有限公司")).toBe("sgs(上海)");
  });
  it("a spaced spelling lands on the existing company", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "sheet", "x", [listing({ company: "DJI大疆" }), listing({ company: "DJI 大疆", title: "飞控算法工程师", externalId: "2" })]);
    expect(((await callTool("pool.list", {}, HUMAN, s)) as any).items).toHaveLength(1);
  });
});

describe("human-only tools", () => {
  it("an agent cannot call or even propose credential / model operations (the application browser it may open, ADR-032)", async () => {
    const { domain, s } = setup();
    for (const [tool, input] of [["model.select", { modelId: "x" }], ["inbox.connect", { provider: "163", email: "a@163.com", authCode: "SECRET" }]] as const)
      await expect(callTool(tool, input, { kind: "agent", via: "mcp" }, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(callableBy({ kind: "agent", via: "mcp" }).map((c) => c.name)).toContain("apply.open");
    expect(domain.listProposals()).toHaveLength(0);
    expect(JSON.stringify(domain.db.prepare("select payload_json from proposal").all())).not.toContain("SECRET");
  });
});

describe("关注 → 准备申请", () => {
  it("a watched position is flagged in the pool and listed with its apply link until an application exists", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "moka-demo", [listing({ applyUrl: "https://example.com/apply#/jobs" } as any)]);
    const id = ((await callTool("pool.list", {}, HUMAN, s)) as any).items[0].positions[0].id;
    await callTool("position.watch", { positionId: id, priority: 2 }, HUMAN, s);
    expect(((await callTool("pool.list", {}, HUMAN, s)) as any).items[0].positions[0].watched).toBe(true);
    const watched = async () => ((await callTool("position.list", { watchedOnly: true }, HUMAN, s)) as any).items;
    expect(await watched()).toEqual([expect.objectContaining({ id, applicationState: null, applyUrl: expect.any(String) })]);
    await callTool("application.create", { positionId: id }, HUMAN, s);
    expect((await watched())[0].applicationState).toBe("draft");
  });
});

describe("closed batches", () => {
  it("last season's better-graded row does not decide the deadline or the apply link; a company with nothing open sorts last", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "csv", "old", [listing({ grade: "校方转载", isOriginal: false, batch: "春招", validThrough: "2020-05-31", url: "https://mp.weixin.qq.com/s/poster" })]);
    ingest(domain, dir, "sheet", "now", [listing({ grade: "聚合", isOriginal: false, url: "https://app.mokahr.com/campus-recruitment/x/1#/jobs" })]);
    ingest(domain, dir, "csv", "old", [listing({ company: "只有旧批次", grade: "官方", validThrough: "2020-05-31" })]);
    // a company whose posts all closed long ago is 过期信息, left out by default (stale.ts); asked for, it sorts last
    expect(((await callTool("pool.list", {}, HUMAN, s)) as any).items.map((x: any) => x.companyName)).toEqual(["示例汽车"]);
    const { items } = (await callTool("pool.list", { includeStale: true }, HUMAN, s)) as any;
    expect(items.map((x: any) => [x.companyName, x.expired])).toEqual([["示例汽车", false], ["只有旧批次", true]]);
    expect(items[0].closesAt).toBeNull();
    expect(items[0].applyUrl).toContain("mokahr");
    expect(items[0].conflicts).toEqual([]);
  });
});

describe("pool cache", () => {
  it("survives reads (each writes an audit row) and a 关注; background writes rebuild behind the answer, own writes before it", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "moka-demo", [listing({})]);
    const list = async () => ((await callTool("pool.list", {}, HUMAN, s)) as any).items;
    const first = await list();
    const built = domain.db.prepare;
    let merges = 0;
    domain.db.prepare = function (this: any, sql: string) { if (sql.startsWith("select c.*, co.name")) merges++; return built.call(this, sql); } as any;
    await list(); await list();
    await callTool("position.watch", { positionId: first[0].positions[0].id, priority: 2 }, HUMAN, s);
    expect((await list())[0].positions[0].watched).toBe(true);
    expect(merges).toBe(0);
    // a background write (a scheduled scan): answered from the old rows at once, rebuilt right after
    ingest(domain, dir, "moka", "moka-demo", [listing({}), listing({ title: "新岗位", externalId: "n" })]);
    expect((await list())[0].positions).toHaveLength(1);
    await new Promise((r) => setTimeout(r, 20));
    expect((await list())[0].positions).toHaveLength(2);
    expect(merges).toBe(1);
    // the user's own write through a tool: the very next read shows it
    await callTool("recommend.tag", { companyId: first[0].companyId, tag: "手动" }, HUMAN, s);
    expect((await list())[0].tags.map((t: any) => t.tag)).toContain("手动");
  });
});

describe("不投了 (ADR-023)", () => {
  it("before submitting it cancels: gone from 投递, 关注 offered again, and preparing again revives the same application; after submitting it closes for good", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "moka-demo", [listing({})]);
    const pos = async () => ((await callTool("pool.list", {}, HUMAN, s)) as any).items[0].positions[0];
    const id = (await pos()).id;
    await callTool("position.watch", { positionId: id, priority: 2 }, HUMAN, s);
    const { application: a } = (await callTool("application.create", { positionId: id }, HUMAN, s)) as any;
    await callTool("application.update", { id: a.id, state: "cancelled", closeReason: "不感兴趣" }, HUMAN, s);
    expect(await pos()).toMatchObject({ applicationState: null, watched: false });
    expect(((await callTool("application.list", {}, HUMAN, s)) as any).items).toEqual([]);
    const again = (await callTool("application.create", { positionId: id }, HUMAN, s)) as any;
    expect(again.application).toMatchObject({ id: a.id, state: "draft", closeReason: "" });
    await callTool("application.update", { id: a.id, state: "submitted" }, HUMAN, s);
    await expect(callTool("application.update", { id: a.id, state: "cancelled" }, HUMAN, s)).rejects.toThrow();
    await callTool("application.update", { id: a.id, state: "closed", closeReason: "放弃" }, HUMAN, s);
    await expect(callTool("application.create", { positionId: id }, HUMAN, s)).rejects.toThrow();
  });
});

describe("paging, sorting and card order", () => {
  it("pool.list pages with offset and sorts by deadline or by new positions; fact order sticks", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "sheet", "a", [listing({ company: "晚截止", validThrough: "2099-12-01" })]);
    ingest(domain, dir, "sheet", "b", [listing({ company: "早截止", validThrough: "2099-10-01" })]);
    ingest(domain, dir, "sheet", "c", [listing({ company: "岗位多", validThrough: "2099-11-01" }), listing({ company: "岗位多", title: "二号", externalId: "2" })]);
    const names = async (q: any) => ((await callTool("pool.list", q, HUMAN, s)) as any).items.map((x: any) => x.companyName);
    expect(await names({})).toEqual(["早截止", "岗位多", "晚截止"]);
    expect(await names({ limit: 1, offset: 1 })).toEqual(["岗位多"]);
    expect((await names({ sort: "new" }))[0]).toBe("岗位多");
    const ids: string[] = [];
    for (const field of ["姓名", "性别", "籍贯"]) ids.push(((await callTool("fact.upsert", { kind: "basic", data: { field, value: "x" } }, HUMAN, s)) as any).fact.id);
    await callTool("fact.reorder", { ids: [ids[2], ids[0], ids[1]] }, HUMAN, s);
    const order = ((await callTool("fact.list", { kind: "basic" }, HUMAN, s)) as any).items.map((f: any) => f.data.field);
    expect(order).toEqual(["籍贯", "姓名", "性别"]);
  });
});

describe("开始网申 goes to the job's own page", () => {
  it("a sheet position is pinned to the same company's official Moka job by exact title, and opens its application form by address", async () => {
    const { dir, domain } = setup();
    ingest(domain, dir, "sheet", "sheet-1", [listing({ grade: "聚合", isOriginal: false, title: "控制算法工程师", url: "https://app.mokahr.com/campus-recruitment/x/1#/jobs" })]);
    ingest(domain, dir, "moka", "moka-x", [listing({ title: "控制算法工程师", externalId: "abc", url: "https://app.mokahr.com/campus-recruitment/x/1#/job/abc" }), listing({ title: "控制算法工程师（实习）", externalId: "def", url: "https://app.mokahr.com/campus-recruitment/x/1#/job/def" })]);
    const sheetPos = (domain.db.prepare("select position_id as id from source_listing where provider = 'sheet'").get() as any).id;
    expect(officialTarget(domain.db, sheetPos)).toEqual({ url: "https://app.mokahr.com/campus-recruitment/x/1#/job/abc/apply", exact: true });
    ingest(domain, dir, "sheet", "sheet-1", [listing({ grade: "聚合", isOriginal: false, title: "结构工程师", externalId: "s2", url: "https://app.mokahr.com/campus-recruitment/x/1#/jobs" })]);
    const unmatched = (domain.db.prepare("select sl.position_id as id from source_listing sl join position p on p.id = sl.position_id where p.title = '结构工程师'").get() as any).id;
    expect(officialTarget(domain.db, unmatched)).toBeNull();
    // the job's own page captured from the browser counts too (the campaign link was the list page)
    ingest(domain, dir, "capture", "cap-1", [listing({ title: "规划算法工程师", externalId: "c1", url: "https://app.mokahr.com/campus_apply/y/2#/job/ghi" })]);
    const captured = (domain.db.prepare("select position_id as id from source_listing where provider = 'capture'").get() as any).id;
    expect(officialTarget(domain.db, captured)).toEqual({ url: "https://app.mokahr.com/campus_apply/y/2#/job/ghi/apply", exact: true });
  });
});

describe("token usage", () => {
  it("tags each call with the work that caused it, through timers, and sums per purpose and per run", async () => {
    const { domain } = setup();
    const msg = (input: number, output: number) => ({ usage: { input, output, totalTokens: input + output, cost: { total: 0.01 } } });
    await withPurpose("apply.start", "app1", async () => {
      recordUsage(domain.db, msg(3000, 800), "p", "m");
      await new Promise<void>((r) => setTimeout(() => { recordUsage(domain.db, msg(1000, 200), "p", "m"); r(); }, 5)); // a run's later tick
    });
    await withPurpose("apply.start", "app2", async () => recordUsage(domain.db, msg(2000, 0), "p", "m"));
    recordUsage(domain.db, msg(10, 5), "p", "m");
    const { items, total } = usageSummary(domain.db);
    expect(items.find((i) => i.purpose === "网申填写")).toMatchObject({ calls: 3, total: 7000, jobs: 2, perJob: 3500 });
    expect(items.find((i) => i.purpose === "其他")).toMatchObject({ calls: 1, total: 15 });
    expect(total).toMatchObject({ calls: 4, total: 7015 });
  });
});

describe("found by the agent evaluation", () => {
  it("a malformed fact from an agent is refused at once with the right shape; two words search as two; paid research needs the user", async () => {
    const { dir, domain, s } = setup();
    const AGENT = { kind: "agent" as const, via: "career" as const };
    await expect(callTool("fact.upsert", { kind: "preference", data: { 期望薪资: "25k×15" } }, AGENT, s)).rejects.toMatchObject({ code: "MISSING_FIELD", message: expect.stringContaining('"field"') });
    const ok: any = await callTool("fact.upsert", { kind: "preference", data: { field: "期望薪资", value: "25k×15" } }, AGENT, s);
    expect(ok.action).toBeTruthy(); // ADR-025: a profile field the user dictated is a reversible write
    ingest(domain, dir, "moka", "moka-demo", [listing({ company: "远澈科技", title: "测试工程师" }), listing({ company: "远澈科技", title: "控制算法工程师", externalId: "2" })]);
    const found: any = await callTool("position.list", { query: "远澈科技 测试工程师" }, HUMAN, s);
    expect(found.items.map((p: any) => p.title)).toEqual(["测试工程师"]);
    const research: any = await callTool("research.company", { companyName: "远澈科技" }, AGENT, s);
    expect(research.proposal).toBeTruthy();
  });
});
