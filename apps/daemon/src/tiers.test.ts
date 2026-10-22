import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Domain } from "./service/domain.js";
import { importCsv } from "./service/import-csv.js";
import { WorkflowEngine } from "./service/workflow.js";
import { callTool, callableBy, type Services } from "./registry.js";

const CSV = `更新时间,公司,企业类型,行业类别,批次,招聘届次,工作地点,招聘岗位,学历要求,专业要求,开始时间,截止时间,简历投递链接,公告链接,是否笔试,公告来源,备注
2026-09-01,示例汽车,民企,汽车,2027届博士专项,2027届,武汉,"底盘控制算法工程师,仿真建模工程师",博士,控制/车辆,2026-08-20,2030-10-15,https://app.mokahr.com/campus-recruitment/demo/1,https://example.com/n,否,校园招聘网,
`;

const AGENT = { kind: "agent" as const, via: "career" as const };
const HUMAN = { kind: "human" as const, via: "desktop" as const };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-tiers-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "agent:\n  mode: default\n", "utf8");
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const s: Services = { domain, workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], agent: { mode: "default", maxWritesPerTurn: 10 } } };
  const csv = join(dir, "a.csv");
  writeFileSync(csv, CSV, "utf8");
  importCsv(domain, csv);
  const pos = domain.listPositions({ query: "底盘" }).items[0];
  return { db, domain, s, pos };
}

describe("ADR-025 tiers: do / ask / never", () => {
  it("a reversible write runs at once, is listed, and undo puts the old value back", async () => {
    const { s, pos, db } = setup();
    const r: any = await callTool("position.watch", { positionId: pos.id, priority: 1 }, AGENT, s);
    expect(r.ok).toBe(true);
    expect(r.action.summary).toContain("示例汽车");
    expect(r.action.undoable).toBe(true);
    expect(db.prepare("select watch_priority from position where id = ?").get(pos.id)).toEqual({ watch_priority: 1 });
    const h: any = await callTool("history.list", {}, HUMAN, s);
    expect(h.items.map((x: any) => x.tool)).toEqual(["position.watch"]);
    await expect(callTool("history.undo", { id: r.action.id }, AGENT, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const u: any = await callTool("history.undo", { id: r.action.id }, HUMAN, s);
    expect(u.ok).toBe(true);
    expect(db.prepare("select watch_priority from position where id = ?").get(pos.id)).toEqual({ watch_priority: null });
    await expect(callTool("history.undo", { id: r.action.id }, HUMAN, s)).rejects.toMatchObject({ code: "ALREADY_UNDONE" });
  });

  it("preparing an application is direct; ending one or moving it forward asks", async () => {
    const { s, pos } = setup();
    const c: any = await callTool("application.create", { positionId: pos.id }, AGENT, s);
    expect(c.application.state).toBe("draft");
    expect(c.action.undoable).toBe(true);
    const drop: any = await callTool("application.update", { id: c.application.id, state: "cancelled", closeReason: "不想去" }, AGENT, s);
    expect(drop.application.state).toBe("cancelled");
    const back: any = await callTool("history.undo", { id: drop.action.id }, HUMAN, s);
    expect(back.undone.application.state).toBe("draft");
    const sub: any = await callTool("application.update", { id: c.application.id, state: "submitted" }, AGENT, s);
    expect(sub.proposal.kind).toBe("application.update"); // 标记已投递 is the user's own act
    await callTool("application.update", { id: c.application.id, state: "submitted" }, HUMAN, s);
    const close: any = await callTool("application.update", { id: c.application.id, state: "closed", closeReason: "拒信" }, AGENT, s);
    expect(close.proposal.decision).toBe("pending"); // ① an application in flight
  });

  it("irreversible, paid and bulk writes ask; the per-turn budget turns the rest into cards; conservative asks for everything", async () => {
    const { s, pos } = setup();
    const f: any = await callTool("fact.upsert", { kind: "preference", data: { field: "期望薪资", value: "25k×15" } }, AGENT, s);
    expect(f.action.undoable).toBe(true);
    const rm: any = await callTool("fact.remove", { id: f.fact.id }, AGENT, s);
    expect(rm.proposal.kind).toBe("fact.remove");
    // several obviously useless cards: one card that names them, and all of them go to 最近删除 once approved
    const junk: any[] = [];
    for (const [field, value] of [["发送动态码", "x"], ["+86", "y"]]) junk.push((await callTool("fact.upsert", { kind: "basic", data: { field, value } }, HUMAN, s) as any).fact.id);
    const many: any = await callTool("fact.remove", { ids: junk }, AGENT, s);
    const card = ((await callTool("proposal.list", {}, HUMAN, s)) as any).items.find((p: any) => p.id === many.proposal.id);
    expect(card.context.cards).toEqual(["发送动态码：x", "+86：y"]);
    await callTool("fact.remove", { ids: junk }, HUMAN, s);
    expect(((await callTool("fact.trash", {}, HUMAN, s)) as any).items.length).toBeGreaterThanOrEqual(2);
    await expect(callTool("fact.remove", { ids: junk }, HUMAN, s)).rejects.toMatchObject({ code: "NOT_FOUND" });
    // near-duplicate awards: one card for several merges, each saying which goes into which
    const aw: string[] = [];
    for (const title of ["电赛 · 一等奖", "电赛（本科组）· 一等奖", "数模 · 二等奖", "数模湖北赛区 · 二等奖"]) aw.push((await callTool("fact.upsert", { kind: "award", data: { title } }, HUMAN, s) as any).fact.id);
    const pairs = [{ fromId: aw[0], intoId: aw[1] }, { fromId: aw[2], intoId: aw[3] }];
    const m: any = await callTool("fact.merge", { pairs }, AGENT, s);
    const mc = ((await callTool("proposal.list", {}, HUMAN, s)) as any).items.find((p: any) => p.id === m.proposal.id);
    expect(mc.context.merges).toEqual(["电赛 · 一等奖 → 并入 → 电赛（本科组）· 一等奖", "数模 · 二等奖 → 并入 → 数模湖北赛区 · 二等奖"]);
    await callTool("fact.merge", { pairs }, HUMAN, s);
    expect(((await callTool("fact.list", { kind: "award" }, HUMAN, s)) as any).items.map((f: any) => f.data.title).sort()).toEqual(["数模湖北赛区 · 二等奖", "电赛（本科组）· 一等奖"]);
    const research: any = await callTool("research.company", { companyName: "示例汽车" }, AGENT, s);
    expect(research.proposal.kind).toBe("research.company");
    const over: any = await callTool("position.watch", { positionId: pos.id, priority: 2 }, { ...AGENT, overflow: true }, s);
    expect(over.proposal.kind).toBe("position.watch");
    await callTool("agent.mode", { mode: "conservative" }, HUMAN, s);
    await expect(callTool("agent.mode", { mode: "default" }, AGENT, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const cons: any = await callTool("position.watch", { positionId: pos.id, priority: 2 }, AGENT, s);
    expect(cons.proposal.kind).toBe("position.watch");
    expect(((await callTool("config.get", {}, HUMAN, s)) as any).config.agent.mode).toBe("conservative");
  });
});

describe("tool list per actor", () => {
  it("agents are not shown the tools they would only be refused", () => {
    const agent = callableBy({ kind: "agent", via: "mcp" }).map((c) => c.name), human = callableBy({ kind: "human", via: "desktop" }).map((c) => c.name);
    for (const n of ["model.login", "inbox.connect", "history.undo", "proposal.decide"]) { expect(agent).not.toContain(n); expect(human).toContain(n); }
    expect(agent).toContain("company.intel");
    expect(agent).toContain("apply.start"); // ADR-032
  });
});

describe("what an agent is told before calling says what tierOf does (B7)", async () => {
  const { policySummary } = await import("./service/tiers.js");
  const { tools } = await import("@zhiro/contracts");
  const say = (s: Services, name: string) => policySummary(name, (tools as any)[name], s);
  it("default: the application browser runs at once, a reference document asks, a read says nothing", () => {
    const { s } = setup();
    expect(say(s, "apply.start")).toBe("（写操作：直接执行）");
    expect(say(s, "apply.open")).toBe("（直接执行）");
    expect(say(s, "apply.read")).toBe("（直接执行）");
    expect(say(s, "apply.reference")).toContain("需用户确认");
    expect(say(s, "position.list")).toBe("");
    expect(say(s, "position.watch")).toContain("可撤销");
    expect(say(s, "application.update")).toContain("已投递");
  });
  it("conservative: every write asks", async () => {
    const { s } = setup();
    await callTool("agent.mode", { mode: "conservative" }, HUMAN, s);
    for (const n of ["apply.start", "apply.open", "position.watch", "application.update", "source.add"]) expect(say(s, n)).toContain("需用户确认");
  });
  it("an undo is promised only where undoPlan has one", () => {
    const { s } = setup();
    for (const n of Object.keys(tools)) if (say(s, n).includes("可撤销")) expect(["position.watch", "recommend.tag", "recommend.untag", "application.create", "application.update", "fact.upsert", "fact.restore", "preset.save"]).toContain(n);
  });
});

it("config.get names the config file with this platform's separators (B9)", async () => {
  const { s } = setup();
  expect(((await callTool("config.get", {}, HUMAN, s)) as any).config.configFile).toBe(join(s.config.vault, "config", "jobos.yaml"));
});
