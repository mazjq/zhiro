import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Domain } from "./service/domain.js";
import { WorkflowEngine } from "./service/workflow.js";
import { callTool, type Services } from "./registry.js";
import { sources, csvToTable, listingsFromTable, isLocalPath, forgetPreviews, type Source } from "./data/index.js";

/**
 * 技术债第三块（方案第 4 项）：一张本人同意了的确认卡，事没做完就不能看起来已同意。「执行中」存在卡上（库里），
 * daemon 中途退出后这张卡变成「中断」，不自动重做，由本人核对后决定。
 */
const HUMAN = { kind: "human" as const, via: "desktop" as const };
const AGENT = { kind: "agent" as const, via: "mcp" as const };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-propexec-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "sources: []\n", "utf8");
  const path = join(dir, "t.db");
  const db = openDb(path);
  const s: Services = { domain: new Domain(db), workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], agent: { mode: "default", maxWritesPerTurn: 10 } } };
  return { dir, path, db, s, domain: s.domain };
}

/** A piece of work that finishes when the test says so. */
function gate<T = unknown>() {
  let open!: (v: T) => void, fail!: (e: unknown) => void;
  const p = new Promise<T>((res, rej) => { open = res; fail = rej; });
  return { p, open, fail };
}
const flush = () => new Promise((r) => setTimeout(r, 0));

describe("确认卡：异步执行器", () => {
  it("while the work runs the card is still waiting, marked as running; it counts as approved only when the work is done", async () => {
    const { domain } = setup();
    const card = domain.createProposal("source.add", { url: "x" }, "agent:mcp");
    const work = gate<{ id: string }>();
    let calls = 0;
    const done = domain.decideProposal(card.id, "approved", card.payloadHash, () => { calls++; return work.p; });
    expect(done).toBeInstanceOf(Promise);

    const mid = domain.listProposals("pending");
    expect(mid.map((p) => p.id)).toEqual([card.id]);
    expect(mid[0]).toMatchObject({ decision: "pending", execution: "running" });
    expect(typeof mid[0].executionStartedAt).toBe("string");
    expect(domain.listProposals("approved")).toEqual([]);
    // nobody decides it twice, and nobody turns it down halfway
    expect(() => domain.decideProposal(card.id, "approved", card.payloadHash, () => { calls++; })).toThrow(expect.objectContaining({ code: "RUNNING" }));
    expect(() => domain.decideProposal(card.id, "rejected", card.payloadHash, () => {})).toThrow(expect.objectContaining({ code: "RUNNING" }));

    work.open({ id: "cfg1" });
    await expect(done).resolves.toEqual({ ok: true, result: { id: "cfg1" } });
    expect(calls).toBe(1);
    expect(domain.listProposals("pending")).toEqual([]);
    const [approved] = domain.listProposals("approved");
    expect(approved.id).toBe(card.id);
    expect(approved.execution).toBeUndefined(); // a settled card carries no execution state: the contract is as before
    expect(approved.executionStartedAt).toBeUndefined();
    expect(JSON.parse((domain.db.prepare("select result_json from proposal where id = ?").get(card.id) as any).result_json)).toEqual({ id: "cfg1" });
  });

  it("work that fails puts the card back to waiting, with the reason and a word that what was done is not undone", async () => {
    const { domain } = setup();
    const card = domain.createProposal("source.add", { url: "x" }, "agent:mcp");
    const err = Object.assign(new Error("FILE_NOT_FOUND: 找不到这个文件"), { code: "FILE_NOT_FOUND" });
    const done = domain.decideProposal(card.id, "approved", card.payloadHash, () => Promise.reject(err));
    await expect(done).rejects.toMatchObject({ code: "FILE_NOT_FOUND", message: expect.stringMatching(/^FILE_NOT_FOUND: 找不到这个文件.*不会撤回/) });
    const [back] = domain.listProposals("pending");
    expect(back).toMatchObject({ id: card.id, decision: "pending" });
    expect(back.execution).toBeUndefined();
    // and it can be tried again
    const again = domain.decideProposal(card.id, "approved", card.payloadHash, async () => ({ id: "cfg2" }));
    await expect(again).resolves.toMatchObject({ ok: true });
    expect(domain.listProposals("approved").map((p) => p.id)).toEqual([card.id]);
  });

  it("a card that needs a model first is not told it may have half-run", async () => {
    const { domain } = setup();
    const card = domain.createProposal("research.topic", { topic: "x" }, "agent:mcp");
    const err = Object.assign(new Error("needs a model"), { code: "MODEL_DELEGATED", job: { id: "j1" } });
    await expect(domain.decideProposal(card.id, "approved", card.payloadHash, () => Promise.reject(err))).rejects.toMatchObject({ code: "MODEL_DELEGATED", message: "needs a model", job: { id: "j1" } });
    expect(domain.listProposals("pending")[0].execution).toBeUndefined();
  });
});

describe("确认卡：重启后", () => {
  it("a card that was running when the daemon stopped becomes interrupted, is not run again by itself, and the person decides", async () => {
    const { path, domain } = setup();
    const card = domain.createProposal("research.topic", { topic: "人形机器人" }, "agent:mcp");
    const never = gate();
    void domain.decideProposal(card.id, "approved", card.payloadHash, () => never.p); // the process dies with this in flight

    // the next start: nothing runs the card by itself; it says what happened
    const db2 = openDb(path);
    const after = new Domain(db2);
    expect(after.listProposals("pending")[0].execution).toBe("running"); // opening the library alone changes nothing (a backup opens it too)
    expect(after.interruptRunningProposals()).toBe(1);
    const [card2] = after.listProposals("pending");
    expect(card2).toMatchObject({ id: card.id, decision: "pending", execution: "interrupted" });
    expect(after.today().pendingProposals).toBe(1);
    expect(after.interruptRunningProposals()).toBe(0);

    // the person checks and approves again: it runs once more and is done
    let runs = 0;
    await expect(after.decideProposal(card.id, "approved", card.payloadHash, async () => { runs++; return { runId: "r2" }; })).resolves.toMatchObject({ ok: true });
    expect(runs).toBe(1);
    const [done] = after.listProposals("approved");
    expect(done.id).toBe(card.id);
    expect(done.execution).toBeUndefined();
  });

  it("or turns it down: rejected, and the interrupted mark is gone with it", () => {
    const { domain } = setup();
    const card = domain.createProposal("feishu.notify", { text: "x" }, "agent:mcp");
    void domain.decideProposal(card.id, "approved", card.payloadHash, () => new Promise(() => {}));
    domain.interruptRunningProposals();
    expect(domain.decideProposal(card.id, "rejected", card.payloadHash, () => { throw new Error("must not run"); })).toEqual({ ok: true, result: undefined });
    const [r] = domain.listProposals("rejected");
    expect(r.id).toBe(card.id);
    expect(r.execution).toBeUndefined();
  });
});

describe("确认卡：同步执行器照旧", () => {
  it("done and marked in one transaction: a failure leaves the card waiting and nothing written, no execution mark", () => {
    const { domain } = setup();
    const card = domain.createProposal("application.update", { id: "a" }, "agent:mcp");
    expect(() => domain.decideProposal(card.id, "approved", card.payloadHash, () => {
      domain.createProposal("fact.upsert", { key: "k" }, "agent:mcp"); // any database write the executor made
      throw new Error("boom");
    })).toThrow("boom");
    expect(domain.db.prepare("select count(*) as n from proposal").get()).toEqual({ n: 1 });
    const [p] = domain.listProposals("pending");
    expect(p.execution).toBeUndefined();
    expect(domain.decideProposal(card.id, "approved", card.payloadHash, () => ({ ok: 1 }))).toEqual({ ok: true, result: { ok: 1 } });
    expect(domain.listProposals("approved")[0].execution).toBeUndefined();
  });
});

describe("确认卡：经工具", () => {
  afterEach(() => { delete sources.gated; forgetPreviews(); });
  it("proposal.list shows the running card to every other window and agent while the person's approval is being carried out", async () => {
    const { dir, s } = setup();
    const read = gate<void>();
    const gated: Source = {
      id: "gated", name: "慢表", aggregate: true, mode: "pull", describe: "测试用",
      detect: (u) => isLocalPath(u) && u.endsWith(".gated"), siteKey: (u) => u,
      async table() { await read.p; return csvToTable("公司,招聘岗位,截止时间\n示例重工,控制算法工程师,2099-10-31\n"); },
      async fetch(cfg, ctx) { return listingsFromTable(await this.table!(cfg, ctx), cfg, "慢表"); },
    };
    sources.gated = gated;
    const file = join(dir, "jobs.gated");
    writeFileSync(file, "x", "utf8");
    const asked: any = await callTool("source.add", { url: file, name: "慢表" }, AGENT, s);
    const deciding = callTool("proposal.decide", { id: asked.proposal.id, decision: "approved", payloadHash: asked.proposal.payloadHash }, HUMAN, s);
    await flush();
    const seen: any = await callTool("proposal.list", {}, AGENT, s);
    expect(seen.items).toHaveLength(1);
    expect(seen.items[0]).toMatchObject({ id: asked.proposal.id, decision: "pending", execution: "running" });
    await expect(callTool("proposal.decide", { id: asked.proposal.id, decision: "rejected", payloadHash: asked.proposal.payloadHash }, HUMAN, s)).rejects.toMatchObject({ code: "RUNNING" });

    read.open();
    await expect(deciding).resolves.toMatchObject({ ok: true, result: { id: expect.any(String) } });
    expect(((await callTool("proposal.list", {}, HUMAN, s)) as any).items).toEqual([]);
    expect(s.config.sources.map((c) => c.url)).toEqual([file]);
  });
});
