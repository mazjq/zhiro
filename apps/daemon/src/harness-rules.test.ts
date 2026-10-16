/**
 * ADR-045 / ADR-047: what an agent credential may do with cards and undo, and the write budget of a caller without a turn.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Domain } from "./service/domain.js";
import { importCsv } from "./service/import-csv.js";
import { WorkflowEngine } from "./service/workflow.js";
import { callTool, callableBy, type Actor, type Services } from "./registry.js";
import { Auth, loadCredentials, sanitizeVia } from "./auth.js";

const CSV = `更新时间,公司,企业类型,行业类别,批次,招聘届次,工作地点,招聘岗位,学历要求,专业要求,开始时间,截止时间,简历投递链接,公告链接,是否笔试,公告来源,备注
2026-09-01,示例汽车,民企,汽车,2027届博士专项,2027届,武汉,"底盘控制算法工程师,仿真建模工程师,A1,A2,A3,A4,A5,A6,A7,A8,A9,A10,A11,A12",博士,控制/车辆,2026-08-20,2030-10-15,https://app.mokahr.com/campus-recruitment/demo/1,https://example.com/n,否,校园招聘网,
`;

const HUMAN: Actor = { kind: "human", via: "desktop" };
const EXTERNAL: Actor = { kind: "agent", via: "claude", cred: "agent" };
const EMBEDDED: Actor = { kind: "agent", via: "claude", cred: "turn", turnId: "turn-1" };
const BUILTIN: Actor = { kind: "agent", via: "career" };

function setup(harnessConfirm: "harness" | "window" = "harness") {
  const dir = mkdtempSync(join(tmpdir(), "jobos-harness-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "agent:\n  mode: default\n", "utf8");
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const s: Services = { domain, workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], agent: { mode: "default", maxWritesPerTurn: 10, harnessConfirm } } };
  const csv = join(dir, "a.csv");
  writeFileSync(csv, CSV, "utf8");
  importCsv(domain, csv);
  const positions = domain.listPositions({ query: "" , limit: 50 } as any).items;
  return { db, domain, s, positions, pos: positions[0] };
}

/** A card an agent raises: preparing an application then marking it submitted is 「先问」. */
async function raiseCard(s: Services, posId: string, by: Actor) {
  const a: any = await callTool("application.create", { positionId: posId, channel: "official" }, by, s);
  const r: any = await callTool("application.update", { id: a.application.id, state: "submitted" }, by, s);
  expect(r.proposal).toBeTruthy();
  return { app: a.application, proposal: r.proposal };
}

describe("ADR-047: the person's own harness confirms and undoes its own doings — when the person lets it", () => {
  it("an external agent decides a card it raised; the application moves; the audit says the harness confirmed", async () => {
    const { s, pos, db } = setup();
    const { app, proposal } = await raiseCard(s, pos.id, EXTERNAL);
    expect(db.prepare("select state from application where id = ?").get(app.id)).toEqual({ state: "draft" });
    const r: any = await callTool("proposal.decide", { id: proposal.id, decision: "approved", payloadHash: proposal.payloadHash }, EXTERNAL, s);
    expect(r.ok).toBe(true);
    expect(db.prepare("select state from application where id = ?").get(app.id)).toEqual({ state: "submitted" });
    expect(db.prepare("select decision from proposal where id = ?").get(proposal.id)).toEqual({ decision: "approved" });
    // and it is listed among what such an agent may call
    expect(callableBy(EXTERNAL, s).map((c) => c.name)).toContain("proposal.decide");
    expect(callableBy(EXTERNAL, s).map((c) => c.name)).toContain("history.undo");
  });
  it("not when the person set confirmation to the Zhiro window", async () => {
    const { s, pos } = setup("window");
    const { proposal } = await raiseCard(s, pos.id, EXTERNAL);
    await expect(callTool("proposal.decide", { id: proposal.id, decision: "approved", payloadHash: proposal.payloadHash }, EXTERNAL, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(callableBy(EXTERNAL, s).map((c) => c.name)).not.toContain("proposal.decide");
    expect((await callTool("proposal.decide", { id: proposal.id, decision: "approved", payloadHash: proposal.payloadHash }, HUMAN, s) as any).ok).toBe(true);
  });
  it("an embedded turn never decides, whatever its header says; its card and writes carry the turn id", async () => {
    const { s, pos, positions, db } = setup();
    const { proposal } = await raiseCard(s, pos.id, EMBEDDED);
    expect(db.prepare("select turn_id, created_by from proposal where id = ?").get(proposal.id)).toEqual({ turn_id: "turn-1", created_by: "agent:embedded:claude" });
    expect(db.prepare("select turn_id from agent_action order by at desc limit 1").get()).toEqual({ turn_id: "turn-1" });
    for (const via of ["claude", "mcp", "desktop", "career"]) {
      await expect(callTool("proposal.decide", { id: proposal.id, decision: "approved", payloadHash: proposal.payloadHash }, { ...EMBEDDED, via }, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(callableBy(EMBEDDED, s).map((c) => c.name)).not.toContain("proposal.decide");
    // nor may an external agent decide the embedded turn's card, nor the built-in assistant's
    await expect(callTool("proposal.decide", { id: proposal.id, decision: "approved", payloadHash: proposal.payloadHash }, EXTERNAL, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { proposal: p2 } = await raiseCard(s, positions[1].id, BUILTIN);
    await expect(callTool("proposal.decide", { id: p2.id, decision: "approved", payloadHash: p2.payloadHash }, EXTERNAL, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callTool("proposal.decide", { id: p2.id, decision: "approved", payloadHash: p2.payloadHash }, BUILTIN, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
  it("a card older than 30 minutes, an expired one, a decided one: all refused to the agent", async () => {
    const { s, pos, db } = setup();
    const { proposal } = await raiseCard(s, pos.id, EXTERNAL);
    db.prepare("update proposal set created_at = ? where id = ?").run(new Date(Date.now() - 31 * 60_000).toISOString(), proposal.id);
    await expect(callTool("proposal.decide", { id: proposal.id, decision: "approved", payloadHash: proposal.payloadHash }, EXTERNAL, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    db.prepare("update proposal set created_at = ? where id = ?").run(new Date().toISOString(), proposal.id);
    expect((await callTool("proposal.decide", { id: proposal.id, decision: "rejected", payloadHash: proposal.payloadHash }, EXTERNAL, s) as any).ok).toBe(true);
    await expect(callTool("proposal.decide", { id: proposal.id, decision: "approved", payloadHash: proposal.payloadHash }, EXTERNAL, s)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
  });
  it("an external agent undoes its own write exactly (the old value back, the record marked undone), not another agent's", async () => {
    const { s, pos, db } = setup();
    const mine: any = await callTool("position.watch", { positionId: pos.id, priority: 2, note: "x" }, EXTERNAL, s);
    expect(mine.note).toContain("history.undo");
    const r: any = await callTool("history.undo", { id: mine.action.id }, EXTERNAL, s);
    expect(r.ok).toBe(true);
    expect(db.prepare("select watch_priority, undone from (select watch_priority, (select undone_at is not null from agent_action where id = ?) as undone from position where id = ?)").get(mine.action.id, pos.id)).toEqual({ watch_priority: null, undone: 1 }); // never watched before: null, not 0
    const theirs: any = await callTool("position.watch", { positionId: pos.id, priority: 1 }, EMBEDDED, s);
    await expect(callTool("history.undo", { id: theirs.action.id }, EXTERNAL, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(callTool("history.undo", { id: theirs.action.id }, EMBEDDED, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const { s: s2, pos: pos2 } = setup("window");
    const m2: any = await callTool("position.watch", { positionId: pos2.id, priority: 2 }, EXTERNAL, s2);
    await expect(callTool("history.undo", { id: m2.action.id }, EXTERNAL, s2)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("ADR-045: the write budget of a caller without a turn", () => {
  it("eleven direct writes at once by external agents: ten run, the eleventh is a card; an embedded turn is not counted", async () => {
    const { s, positions } = setup();
    expect(positions.length).toBeGreaterThanOrEqual(12);
    const results: any[] = await Promise.all(positions.slice(0, 11).map((p, i) => callTool("position.watch", { positionId: p.id, priority: 1 }, { ...EXTERNAL, via: i % 2 ? "claude" : "codex" }, s)));
    expect(results.filter((r) => r.action).length).toBe(10);
    expect(results.filter((r) => r.proposal).length).toBe(1);
    // the embedded turn has its own budget (per turn), the external window does not touch it
    const e: any = await callTool("position.watch", { positionId: positions[11].id, priority: 1 }, EMBEDDED, s);
    expect(e.action).toBeTruthy();
  });
  it("an embedded turn: ten direct writes, then cards — counted by its turn id, not by the clock", async () => {
    const { s, positions } = setup();
    const results: any[] = [];
    for (const p of positions.slice(0, 11)) results.push(await callTool("position.watch", { positionId: p.id, priority: 1 }, EMBEDDED, s));
    expect(results.filter((r) => r.action).length).toBe(10);
    expect(results[10].proposal).toBeTruthy();
    // another turn starts fresh
    const next: any = await callTool("position.watch", { positionId: positions[11].id, priority: 1 }, { ...EMBEDDED, turnId: "turn-2" }, s);
    expect(next.action).toBeTruthy();
  });
});

describe("the audit label comes from the credential", () => {
  it("a header is letters, digits and dashes or it is 'mcp'", () => {
    expect(sanitizeVia("Claude-Code")).toBe("claude-code");
    expect(sanitizeVia("embedded:claude")).toBe("mcp");
    expect(sanitizeVia("")).toBe("mcp");
    expect(sanitizeVia("x".repeat(40))).toBe("mcp");
  });
  it("a turn token is an embedded agent, the agent token an external one, the person's token the person — and the header only lowers", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-auth-"));
    mkdirSync(join(dir, "config"));
    const auth = new Auth(loadCredentials(dir));
    const t = auth.issueTurn("turn-9", 60_000);
    expect(auth.actorOf(auth.principalOf(t, undefined)!, "desktop")).toEqual({ kind: "agent", via: "desktop", cred: "turn", turnId: "turn-9" });
    expect(auth.actorOf(auth.principalOf(auth.creds.agent, undefined)!, "desktop")).toEqual({ kind: "agent", via: "desktop", cred: "agent" });
    expect(auth.actorOf(auth.principalOf(auth.creds.human, undefined)!, undefined)).toEqual({ kind: "human", via: "desktop" });
    expect(auth.actorOf(auth.principalOf(auth.creds.human, undefined)!, "mcp")).toEqual({ kind: "agent", via: "mcp", cred: "agent" });
    auth.revokeTurn("turn-9");
    expect(auth.principalOf(t, undefined)).toBeNull();
    expect(auth.principalOf(auth.creds.capture, undefined)).toBeNull();
  });
});
