import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Domain } from "./service/domain.js";
import { WorkflowEngine } from "./service/workflow.js";
import { createLlm } from "./llm.js";
import { callTool, type Services } from "./registry.js";
import { spawnRun, readRun } from "./agent/worker.js";
import { asAgentCall } from "./service/usage.js";

const AGENT = { kind: "agent" as const, via: "mcp" as const, cred: "agent" as const };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-ext-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "llm:\n  provider: external\n  model: agent\n", "utf8");
  const db = openDb(join(dir, "t.db"));
  const config: any = { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "external", model: "agent" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], agent: { mode: "default", maxWritesPerTurn: 10 } };
  const llm = createLlm(config);
  llm.db = db;
  const s: Services = { domain: new Domain(db), workflows: new WorkflowEngine(db), config, llm };
  return { s, db, dir };
}

describe("ADR-032 external agent stands in for the model", () => {
  it("a tool that needs the model hands the prompt to the agent, takes the answer, and finishes on the retry", async () => {
    const { s, db } = setup();
    const mail = { subject: "【星澜汽车】一面邀请", text: "张三你好，诚邀你参加底盘控制算法工程师一面，时间 2026-10-02 14:00，线上。" };
    const first: any = await callTool("inbox.paste", mail, AGENT, s);
    expect(first.needsModel.jobId).toBeTruthy();
    expect(first.needsModel.user).toContain("一面");
    expect(((await callTool("llm.pending", {}, AGENT, s)) as any).items).toHaveLength(1);
    // the same call again before the answer: still one job, not two
    expect(((await callTool("inbox.paste", mail, AGENT, s)) as any).needsModel.jobId).toBe(first.needsModel.jobId);
    await callTool("llm.reply", { jobId: first.needsModel.jobId, text: JSON.stringify({ category: "面试", round: "一面", company: "星澜汽车", position: "底盘控制算法工程师", scheduledAt: "2026-10-02T14:00:00+08:00", summary: "一面 10-02 14:00 线上", confidence: 0.9 }) }, AGENT, s);
    const done: any = await callTool("inbox.paste", mail, AGENT, s);
    expect(done.needsModel).toBeUndefined();
    expect(done.message).toMatchObject({ category: "面试", round: "一面", company: "星澜汽车" });
    expect(((await callTool("llm.pending", {}, AGENT, s)) as any).items).toHaveLength(0);
    expect((db.prepare("select status from model_job").get() as any).status).toBe("used");
  });

  it("a research run waits for the agent instead of spawning claude, and its answer is the worker output", async () => {
    const { s } = setup();
    // started inside the agent's own call (ADR-057): the agent researches, no worker is spawned
    const { runId, runDir } = await asAgentCall("mcp", async () => spawnRun(s, { runner: "claude", mode: "company.find", subjectType: "company", subjectId: "", subjectLabel: "云岫半导体", prompt: "找校招入口", schema: { type: "object" } }));
    expect(readRun(runDir).status).toBe("running");
    const job = ((await callTool("llm.pending", {}, AGENT, s)) as any).items[0];
    expect(job).toMatchObject({ id: runId, kind: "run", user: "找校招入口" });
    await expect(callTool("llm.reply", { jobId: runId, text: "不是 JSON" }, AGENT, s)).rejects.toThrow(/JSON/);
    await callTool("llm.reply", { jobId: runId, text: '{"links":[]}' }, AGENT, s);
    expect(readRun(runDir)).toMatchObject({ status: "done", structured: { links: [] } });
  });
});
