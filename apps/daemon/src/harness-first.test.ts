/** ADR-057: one harness does the AI work — who answers what, the no-tools check, and what an agent is told of the person's edits. */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Domain } from "./service/domain.js";
import { WorkflowEngine } from "./service/workflow.js";
import { createLlm } from "./llm.js";
import { callTool, type Services } from "./registry.js";
import { asAgentCall, callingAgent } from "./service/usage.js";
import { backgroundTarget, researchTarget } from "./agent/route.js";
import { promptParts, oneshotArgv, oneshotLine, asciiJson, oneshot } from "./agent/backends/oneshot.js";
import { chooseModel, followedModel, harnessModel, harnessModels } from "./agent/backends/cli.js";
import { importCsv } from "./service/import-csv.js";
import { tierOf } from "./service/tiers.js";
import { spawnRun } from "./agent/worker.js";
import { tools } from "@zhiro/contracts";

const AGENT = { kind: "agent" as const, via: "workbuddy", cred: "agent" as const };
const HUMAN = { kind: "human" as const, via: "desktop" as const };
const CSV = `更新时间,公司,企业类型,行业类别,批次,招聘届次,工作地点,招聘岗位,学历要求,专业要求,开始时间,截止时间,简历投递链接,公告链接,是否笔试,公告来源,备注
2026-09-01,示例汽车,民企,汽车,2027届博士专项,2027届,武汉,底盘控制算法工程师,博士,控制,2026-08-20,2030-10-15,https://app.mokahr.com/campus-recruitment/demo/1,https://example.com/n,否,官网,
`;

function setup(llmCfg: any = { provider: "openai-codex", model: "gpt-5.6-sol" }, agent: any = { mode: "default", maxWritesPerTurn: 10 }) {
  const dir = mkdtempSync(join(tmpdir(), "jobos-h1-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "llm:\n  provider: openai-codex\n", "utf8");
  const db = openDb(join(dir, "t.db"));
  const config: any = { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: llmCfg, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], agent };
  const llm = createLlm(config);
  llm.db = db;
  const s: Services = { domain: new Domain(db), workflows: new WorkflowEngine(db), config, llm };
  return { s, db, dir };
}
const env = { ...process.env };
afterEach(() => { for (const k of ["JOBOS_CLAUDE_CLI", "JOBOS_CODEX_CLI", "APPDATA"]) { if (env[k] === undefined) delete process.env[k]; else process.env[k] = env[k]; } });
/** No Claude Code or Codex installed: the launchers look under APPDATA. */
const noHarness = () => { process.env.APPDATA = mkdtempSync(join(tmpdir(), "jobos-noapp-")); delete process.env.JOBOS_CLAUDE_CLI; delete process.env.JOBOS_CODEX_CLI; };

describe("who does the background work", () => {
  it("the switch on: the built-in model; off: the chosen harness — and a missing one is said, not swapped", () => {
    const { s } = setup({ provider: "openai-codex", model: "gpt-5.6-sol" }, { backend: "claude" });
    process.env.JOBOS_CLAUDE_CLI = "C:\\fake\\claude.exe"; process.env.JOBOS_CODEX_CLI = "C:\\fake\\codex.exe"; // clean:allow (made-up paths)
    expect(backgroundTarget(s)).toEqual({ kind: "model" }); // on unless turned off
    s.config.llm.forBackground = false;
    expect(backgroundTarget(s)).toEqual({ kind: "harness", name: "claude" });
    s.config.agent!.backend = "codex";
    expect(backgroundTarget(s)).toEqual({ kind: "harness", name: "codex" });
    expect(researchTarget(s)).toEqual({ kind: "worker", runner: "codex" });
    noHarness();
    expect(backgroundTarget(s)).toMatchObject({ kind: "unavailable" });
    expect(researchTarget(s)).toEqual({ kind: "waiting" });
    s.config.agent!.backend = "builtin";
    expect(backgroundTarget(s)).toEqual({ kind: "model" });
    s.config.llm.provider = "external";
    expect(backgroundTarget(s)).toEqual({ kind: "waiting" }); // no model of our own: the person's agent's queue (ADR-032)
  });

  it("inside an external agent's call the model work goes back to it; work left running after the call does not", async () => {
    const { s, db } = setup();
    s.llm!.route = () => ({ kind: "unavailable", why: "测试：不该走到这里" });
    const ask = () => s.llm!.models.completeSimple(s.llm!.model(), { systemPrompt: "分类", messages: [{ role: "user", content: [{ type: "text", text: "一封邮件" }], timestamp: Date.now() }] } as any);
    let later: Promise<unknown> | null = null;
    await asAgentCall("workbuddy", async () => {
      await expect(ask()).rejects.toMatchObject({ code: "MODEL_DELEGATED" });
      later = new Promise((ok) => setTimeout(ok, 30)).then(() => { expect(callingAgent()).toBeNull(); return ask(); });
    });
    await expect(later!).rejects.toThrow(/BACKGROUND_UNAVAILABLE/);
    const jobs = db.prepare("select caller from model_job").all() as any[];
    expect(jobs).toEqual([{ caller: "workbuddy" }]);
  });

  it("an external agent's research needs no card (it researches itself); a chat turn's still does; jobs are each agent's own", async () => {
    const { s } = setup();
    const c = (tools as any)["research.topic"];
    expect(tierOf("research.topic", c, {}, s, true)).toBe("do");
    expect(tierOf("research.topic", c, {}, s, false)).toBe("ask");
    expect(tierOf("fit.deep", (tools as any)["fit.deep"], {}, s, true)).toBe("do"); // the deep fit too: it answers the prompt itself
    const { runId } = await asAgentCall("workbuddy", async () => spawnRun(s, { mode: "company.find", subjectType: "company", subjectId: "", subjectLabel: "示例", prompt: "找入口", schema: { type: "object" } }));
    expect(((await callTool("llm.pending", {}, AGENT, s)) as any).items.map((j: any) => j.id)).toEqual([runId]);
    expect(((await callTool("llm.pending", {}, { ...AGENT, via: "claude" }, s)) as any).items).toEqual([]);
  });
});

describe("one answer from a harness, with no tools", () => {
  it("builds the prompt within the limits, in pure ASCII for Claude, as files for Codex, with the chosen model", () => {
    const big = Buffer.alloc(6_000_000).toString("base64");
    const ctx = { systemPrompt: "抽取", messages: [{ role: "user", content: [{ type: "text", text: "简章正文" }, { type: "image", data: "aGk=", mimeType: "image/png" }, { type: "image", data: big, mimeType: "image/png" }, { type: "image", data: "aGk=", mimeType: "image/tiff" }] }] };
    const p = promptParts(ctx);
    expect(p.images).toHaveLength(1);
    expect(p.text).toContain("另有 2 张图片超出限制");
    expect(asciiJson({ t: "中文" })).toBe('{"t":"\\u4e2d\\u6587"}');
    const c = oneshotArgv("claude", p, "d", "opus");
    expect(c.args).toEqual(expect.arrayContaining(["--tools", "", "--setting-sources", "", "--strict-mcp-config", "--model", "opus"]));
    expect(c.args[c.args.indexOf("--tools") + 1]).toBe("");
    expect(/[^\x00-\x7f]/.test(c.stdin)).toBe(false);
    expect(JSON.parse(c.stdin).message.content[1].source.media_type).toBe("image/png");
    const dir = mkdtempSync(join(tmpdir(), "jobos-os-"));
    const x = oneshotArgv("codex", p, dir, "");
    expect(x.args).toEqual(expect.arrayContaining(["--disable", "shell_tool", "--disable", "unified_exec", "--ignore-user-config", "--ephemeral", "-i", join(dir, "image-1.png")]));
    expect(x.stdin.startsWith("抽取\n\n---\n\n简章正文")).toBe(true);
  });

  it("stops the moment a harness turns out to have tools, or reaches for one", () => {
    const st: any = { text: "", model: "" };
    expect(oneshotLine("claude", JSON.stringify({ type: "system", subtype: "init", tools: ["Bash"], model: "m" }), st)).toMatch(/带着工具/);
    expect(oneshotLine("claude", JSON.stringify({ type: "system", subtype: "init", tools: [], model: "claude-x" }), st)).toBeNull();
    expect(st.model).toBe("claude-x");
    expect(oneshotLine("claude", JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", name: "Read" }] } }), st)).toMatch(/Read/);
    expect(oneshotLine("codex", JSON.stringify({ type: "item.started", item: { type: "command_execution" } }), st)).toMatch(/command_execution/);
    expect(oneshotLine("codex", JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "{\"a\":1}" } }), st)).toBeNull();
    expect(st.text).toBe('{"a":1}');
  });

  it("runs a harness end to end: the answer and its usage; one with tools is refused", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-fake-"));
    const fake = (tools: string[]) => { const f = join(dir, `fake-${tools.length}.js`); writeFileSync(f, `process.stdin.resume();process.stdin.on("end",()=>{const o=(x)=>console.log(JSON.stringify(x));o({type:"system",subtype:"init",tools:${JSON.stringify(tools)},model:"fake-model"});o({type:"result",is_error:false,result:"{\\"ok\\":true}",total_cost_usd:0.001,usage:{input_tokens:3,output_tokens:4}});});`); return f; };
    process.env.JOBOS_CLAUDE_CLI = fake([]);
    const a = await oneshot("claude", { systemPrompt: "s", messages: [{ role: "user", content: "问" }] });
    expect(a).toMatchObject({ text: '{"ok":true}', model: "fake-model", usage: { input: 3, output: 4 }, costUsd: 0.001 });
    process.env.JOBOS_CLAUDE_CLI = fake(["Bash"]);
    await expect(oneshot("claude", { systemPrompt: "s", messages: [{ role: "user", content: "问" }] })).rejects.toThrow(/带着工具/);
  });

  it("follows the model chosen in the harness, and nothing when none is set", () => {
    const home = mkdtempSync(join(tmpdir(), "jobos-home-"));
    expect(followedModel("claude", home)).toBe("");
    mkdirSync(join(home, ".claude")); writeFileSync(join(home, ".claude", "settings.json"), '{"model":"opus"}');
    mkdirSync(join(home, ".codex")); writeFileSync(join(home, ".codex", "config.toml"), 'model_reasoning_effort = "high"\nmodel = "gpt-6.1-sol"\n\n[profiles.x]\nmodel = "other"\n');
    expect(followedModel("claude", home)).toBe("opus");
    expect(followedModel("codex", home)).toBe("gpt-6.1-sol");
  });

  it("lists the models the harness keeps on this computer, newest first; a model picked in Zhiro wins until cleared", () => {
    const home = mkdtempSync(join(tmpdir(), "jobos-home-"));
    expect(harnessModels("claude", home)).toEqual([]);
    mkdirSync(join(home, ".claude", "cache", "model-catalog"), { recursive: true });
    writeFileSync(join(home, ".claude", "cache", "model-catalog", "x-cc.json"), JSON.stringify({ catalog: { config: { models: [
      { id: "claude-new", name: "New", description: "d", section: "main" }, { id: "claude-old", name: "Old", section: "overflow" }] } } }));
    mkdirSync(join(home, ".codex"));
    writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({ models: [
      { slug: "b", display_name: "B", visibility: "list", priority: 2 }, { slug: "hidden", visibility: "hide", priority: 0 }, { slug: "a", display_name: "A", visibility: "list", priority: 1 }] }));
    expect(harnessModels("claude", home).map((m) => [m.id, m.older])).toEqual([["claude-new", false], ["claude-old", true]]);
    expect(harnessModels("codex", home).map((m) => m.id)).toEqual(["a", "b"]);
    writeFileSync(join(home, ".claude", "settings.json"), '{"model":"opus"}');
    chooseModel("claude", "claude-new");
    expect(followedModel("claude", home)).toBe("claude-new");
    expect(harnessModel("claude", home)).toBe("opus"); // the harness's own setting is untouched
    chooseModel("claude", "");
    expect(followedModel("claude", home)).toBe("opus");
  });
});

describe("what the person changed, told to an external agent", () => {
  it("a short table of the person's writes since the agent's last call: no secrets, no repeats, nothing on the first call", async () => {
    const { s, dir } = setup();
    const csv = join(dir, "a.csv"); writeFileSync(csv, CSV, "utf8"); importCsv(s.domain, csv);
    const pos = s.domain.listPositions({}).items[0];
    const first: any = await callTool("today.summary", {}, AGENT, s);
    expect(first.changedByUser).toBeUndefined();
    await callTool("position.watch", { positionId: pos.id, priority: 1 }, HUMAN, s);
    await callTool("position.watch", { positionId: pos.id, priority: 2, note: "私人备注 13800000000" }, HUMAN, s);
    await callTool("fact.upsert", { kind: "basic", data: { field: "手机", value: "13800000000" } }, HUMAN, s).catch(() => {});
    await callTool("today.summary", {}, HUMAN, s); // a read: never listed
    const next: any = await callTool("today.summary", {}, AGENT, s);
    const t: string = next.changedByUser;
    expect(t.split("\n").slice(0, 2)).toEqual([expect.stringMatching(/^本人在窗口里改了 \d 处/), "时间|工具|对象|改动"]);
    expect(t).toContain("position.watch|示例汽车·底盘控制算法工程师|priority=2");
    expect(t).not.toContain("priority=1"); // the later edit of the same thing
    expect(t).not.toContain("13800000000");
    expect(t).not.toContain("私人备注");
    expect(t).not.toContain("today.summary");
    const again: any = await callTool("today.summary", {}, AGENT, s);
    expect(again.changedByUser).toBeUndefined(); // told once
    const other: any = await callTool("today.summary", {}, { ...AGENT, via: "codex" }, s);
    expect(other.changedByUser).toBeUndefined(); // another agent's first call
    // the drawer's harness (a turn, labelled claude like an external Claude) and the built-in assistant hear it too, each in its own place
    const turn = { kind: "agent" as const, via: "workbuddy", cred: "turn" as const, turnId: "T" }, builtin = { kind: "agent" as const, via: "career" };
    await callTool("today.summary", {}, turn, s); await callTool("today.summary", {}, builtin, s);
    await callTool("position.watch", { positionId: pos.id, priority: 1 }, HUMAN, s);
    expect(((await callTool("today.summary", {}, turn, s)) as any).changedByUser).toContain("priority=1");
    expect(((await callTool("today.summary", {}, builtin, s)) as any).changedByUser).toContain("priority=1");
    expect(((await callTool("today.summary", {}, AGENT, s)) as any).changedByUser).toContain("priority=1"); // the turn did not use up the external agent's news
  });
});
