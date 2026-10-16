/**
 * ADR-046: the chat backends that run a harness's command line. The parsers are checked against real output of
 * `claude -p --output-format stream-json` and `codex exec --json` (fixtures/), the runner against a fake command line
 * that behaves like one — including a real tool call through the turn token, over HTTP, into this daemon.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { openDb } from "../../db.js";
import { Domain } from "../../service/domain.js";
import { importCsv } from "../../service/import-csv.js";
import { WorkflowEngine } from "../../service/workflow.js";
import { createApp } from "../../http.js";
import { Auth, loadCredentials } from "../../auth.js";
import type { Services } from "../../registry.js";
import { ChatHub, builtinBackend } from "../backend.js";
import { cliBackend, type CliSpec } from "./cli.js";
import { claudeSpec } from "./claude.js";
import { codexSpec } from "./codex.js";
import { acpSpec, jobosTool } from "./acp.js";
import { repoRoot } from "../agent-dir.js";

const fixture = (f: string) => readFileSync(join(repoRoot(), "apps", "daemon", "src", "agent", "backends", "fixtures", f), "utf8").split(/\r?\n/).filter(Boolean);

describe("parsers against real CLI output", () => {
  it("claude stream-json: session, tool calls with their results, the final text and cost", () => {
    const parse = claudeSpec.parser();
    const all = fixture("claude-stream.jsonl").flatMap(parse);
    expect(all.find((x) => x.kind === "session")).toEqual({ kind: "session", id: "6bc35a9c-d724-46ee-9aeb-00005308aff1" });
    const starts = all.filter((x: any) => x.kind === "event" && x.event.type === "tool_execution_start").map((x: any) => x.event.toolName);
    expect(starts).toEqual(["today.summary", "position.list", "position.watch", "campaign.list"]);
    const ends = all.filter((x: any) => x.kind === "event" && x.event.type === "tool_execution_end") as any[];
    expect(ends.map((x) => x.event.toolName)).toEqual(starts);
    expect(ends[2].event.result.details.action.tool).toBe("position.watch"); // the drawer says 已执行：关注了…
    const result = all.find((x) => x.kind === "result") as any;
    expect(result.isError).toBe(false);
    expect(result.text).toMatch(/底盘控制算法工程师/);
    expect(result.costUsd).toBeCloseTo(0.27, 1);
    // a half line, a stray non-JSON line: ignored, not fatal
    expect(parse("Reading input…")).toEqual([{ kind: "ignore" }]);
    expect(() => parse('{"type":"assistant","mess')).toThrow();
  });
  it("codex --json: thread id, tool calls, the answer, and the skills warning ignored", () => {
    const parse = codexSpec.parser();
    const all = fixture("codex-json.jsonl").flatMap(parse);
    expect(all.find((x) => x.kind === "session")).toEqual({ kind: "session", id: "01a136ac-9db2-7fb0-9652-2cfdb00e82ad" });
    const ev = all.filter((x: any) => x.kind === "event") as any[];
    expect(ev.map((x) => x.event.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
    expect(ev[1].event.result.details.deadlines).toEqual([]);
    expect(all.filter((x) => x.kind === "text").map((x: any) => x.text)).toEqual(["规则已读。\n", "JobOS 显示，你关注或正在准备申请的岗位中，今天没有截止的岗位。"]);
    expect(all.filter((x) => x.kind === "result")).toEqual([{ kind: "result", text: "", isError: false }]);
    expect(all.some((x: any) => x.kind === "result" && x.isError)).toBe(false);
    const err = parse('{"type":"item.completed","item":{"id":"x","type":"error","message":"thread 123 not found"}}') as any[];
    expect(err[0]).toMatchObject({ kind: "result", isError: true, sessionMissing: true });
  });
  it("argv: claude limits itself to jobos + web, no user settings; codex ignores the user config, approves jobos tools, resumes by id", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-argv-"));
    const mcp = { command: "node", args: ["x.cjs"], env: { JOBOS_AGENT_TOKEN: "t" } };
    const c = claudeSpec.argv({ dir, sessionId: "sid", rulesFile: "r.md", mcp, prompt: "hi", budgetUsd: 2, maxTurns: 60 });
    expect(c.args).toEqual(["-p", "--output-format", "stream-json", "--verbose", "--resume", "sid", "--mcp-config", join(dir, "mcp.json"), "--strict-mcp-config", "--tools", "WebSearch,WebFetch", "--allowedTools", "mcp__jobos__*", "WebSearch", "WebFetch", "--permission-mode", "dontAsk", "--append-system-prompt-file", "r.md", "--setting-sources", "", "--disable-slash-commands", "--max-turns", "60", "--max-budget-usd", "2", "--", "hi"]);
    expect(c.stdin).toBeUndefined();
    expect(JSON.parse(readFileSync(join(dir, "mcp.json"), "utf8")).mcpServers.jobos.env.JOBOS_AGENT_TOKEN).toBe("t");
    const x = codexSpec.argv({ dir: "D:\\a b", sessionId: null, rulesFile: "", mcp: { command: "node", args: ["E:\\a b\\jobos-mcp.cjs"], env: { JOBOS_VAULT: "E:\\v", JOBOS_AGENT_TOKEN: "t" } }, prompt: "hi", budgetUsd: 2, maxTurns: 60 });
    expect(x.args.slice(0, 8)).toEqual(["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "-C", "D:\\a b", "-s", "read-only"]);
    expect(x.args).toContain('mcp_servers.jobos.args=["E:\\\\a b\\\\jobos-mcp.cjs"]'); // a TOML string, backslashes escaped
    expect(x.args).toContain('mcp_servers.jobos.env={JOBOS_VAULT="E:\\\\v",JOBOS_AGENT_TOKEN="t"}');
    expect(x.args).toContain('mcp_servers.jobos.default_tools_approval_mode="approve"');
    expect(x.args.slice(-1)).toEqual(["-"]);
    expect(codexSpec.argv({ dir: "d", sessionId: "tid", rulesFile: "", mcp, prompt: "", budgetUsd: 1, maxTurns: 1 }).args.slice(-3)).toEqual(["resume", "tid", "-"]);
  });
});

const CSV = `更新时间,公司,企业类型,行业类别,批次,招聘届次,工作地点,招聘岗位,学历要求,专业要求,开始时间,截止时间,简历投递链接,公告链接,是否笔试,公告来源,备注
2026-09-01,示例汽车,民企,汽车,2027届博士专项,2027届,武汉,"底盘控制算法工程师,仿真建模工程师",博士,控制/车辆,2026-08-20,2030-10-15,https://app.mokahr.com/campus-recruitment/demo/1,https://example.com/n,否,校园招聘网,
`;

/** A daemon listening on a free port, so a fake CLI can call tools over HTTP with the turn token it is given. */
async function daemon() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-cli-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "agent:\n  mode: default\n", "utf8");
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const s: Services = { domain, workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], agent: { mode: "default", maxWritesPerTurn: 10 } } };
  const csv = join(dir, "a.csv"); writeFileSync(csv, CSV, "utf8"); importCsv(domain, csv);
  const auth = new Auth(loadCredentials(dir));
  const career = { ask: async () => ({ answer: "builtin", actions: [], proposals: [] }), onEvent: () => () => {}, history: () => [], reset: () => {} };
  const hubRef: { hub?: ChatHub } = {};
  const app = createApp(s, auth, new Proxy({} as ChatHub, { get: (_t, k) => (hubRef.hub as any)[k] }));
  const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 0 });
  const port: number = await new Promise((r) => server.on("listening", () => r((server.address() as any).port)));
  s.config.http.port = port;
  const pos = domain.listPositions({ query: "底盘" }).items[0];
  return { s, auth, db, dir, pos, career, hubRef, close: () => server.close() };
}

/**
 * A command line that behaves like a harness: prints claude-style events, and — with the MCP config it is handed —
 * calls position.watch on the daemon with the turn token, exactly as the forwarder would.
 */
function fakeCli(dir: string, body: string): string {
  const f = join(dir, "fake-cli.cjs");
  writeFileSync(f, `
const fs = require("node:fs");
const i = process.argv.indexOf("--mcp-config");
const env = i > 0 ? JSON.parse(fs.readFileSync(process.argv[i + 1], "utf8")).mcpServers.jobos.env : {};
const resume = process.argv.indexOf("--resume") > 0 ? process.argv[process.argv.indexOf("--resume") + 1] : null;
const stdin = process.argv[process.argv.length - 1]; // the prompt is the last argument, after "--"
process.stdin.resume(); process.stdin.on("end", async () => {
  const say = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  const call = (name, input) => fetch(env.JOBOS_URL + "/api/tools/" + name, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.JOBOS_AGENT_TOKEN, "x-jobos-actor": "desktop" }, body: JSON.stringify(input) }).then((r) => r.json());
  ${body}
});
`, "utf8");
  return f;
}

const spec = (cli: string): CliSpec => ({ ...claudeSpec, name: "claude", launcher: () => ({ cmd: process.execPath, args: [cli] }) });

describe("the runner: a turn token for the process, its writes carry the turn id, the session continues, the second message waits", () => {
  it("runs a turn: the fake harness watches a post with the turn token; the action comes back with the answer, tagged with the turn", async () => {
    const d = await daemon();
    try {
      const cli = fakeCli(d.dir, `
        say({ type: "system", subtype: "init", session_id: "S1" });
        say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t1", name: "mcp__jobos__position_watch", input: { positionId: ${JSON.stringify(d.pos.id)}, priority: 1 } }] } });
        const r = await call("position.watch", { positionId: ${JSON.stringify(d.pos.id)}, priority: 1 });
        say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: JSON.stringify(r) }] } });
        // the turn token may not decide anything, whatever header it sends
        const d2 = await call("proposal.decide", { id: "x", decision: "approved", payloadHash: "h" });
        say({ type: "result", subtype: "success", is_error: false, result: "已关注；decide=" + d2.error, session_id: "S1", total_cost_usd: 0.01 });
      `);
      const b = cliBackend(d.s, d.auth, spec(cli), () => ({ command: "unused", args: [] }));
      const hub = new ChatHub(d.s, { builtin: builtinBackend(d.career, d.s), claude: b, codex: b, dsh: b });
      d.hubRef.hub = hub;
      d.s.config.agent!.backend = "claude";
      const events: any[] = [];
      hub.onEvent((e) => events.push(e));
      const t = await hub.ask("关注底盘", "turn-A");
      expect(t.answer).toBe("已关注；decide=FORBIDDEN");
      expect(t.actions.length).toBe(1);
      expect(t.actions[0].tool).toBe("position.watch");
      expect(d.db.prepare("select turn_id, actor from agent_action").all()).toEqual([{ turn_id: "turn-A", actor: "agent:embedded:desktop" }]);
      expect(d.db.prepare("select status, session_id, cost_usd, cost_kind from chat_turn where id = 'turn-A'").get()).toEqual({ status: "completed", session_id: "S1", cost_usd: 0.01, cost_kind: "estimated" });
      expect(events.map((e) => e.type)).toEqual(["tool_execution_start", "tool_execution_end"]);
      expect(events[0].turnId).toBe("turn-A");
      // the token died with the turn
      expect(d.auth.principalOf(JSON.parse(readFileSync(join(d.dir, "chat", "claude", "mcp.json"), "utf8")).mcpServers.jobos.env.JOBOS_AGENT_TOKEN, undefined)).toBeNull();
      expect(existsSync(join(d.dir, "chat", "claude", "rules-turn-A.md"))).toBe(false);
      expect(hub.history()).toEqual([{ role: "user", text: "关注底盘", backend: "claude" }, { role: "agent", text: "已关注；decide=FORBIDDEN", backend: "claude" }]);
    } finally { d.close(); }
  });
  it("continues the session by id; a session that is gone restarts once with the record as material, but not after a write", async () => {
    const d = await daemon();
    try {
      const cli = fakeCli(d.dir, `
        if (resume === "GONE") { say({ type: "result", subtype: "error_during_execution", is_error: true, result: "No conversation found with session ID: GONE" }); return; }
        if (resume === "WROTE") { await call("position.watch", { positionId: ${JSON.stringify(d.pos.id)}, priority: 2 }); say({ type: "assistant", message: { content: [{ type: "tool_use", id: "t", name: "mcp__jobos__position_watch", input: {} }] } }); say({ type: "result", is_error: true, result: "No conversation found with session ID: WROTE" }); return; }
        say({ type: "system", subtype: "init", session_id: resume ?? "NEW" });
        say({ type: "result", is_error: false, result: "resume=" + resume + " prompt=" + stdin.slice(0, 40).replace(/\\n/g, " "), session_id: resume ?? "NEW" });
      `);
      const b = cliBackend(d.s, d.auth, spec(cli), () => ({ command: "unused", args: [] }));
      const hub = new ChatHub(d.s, { builtin: builtinBackend(d.career, d.s), claude: b, codex: b, dsh: b });
      d.hubRef.hub = hub; d.s.config.agent!.backend = "claude";
      expect((await hub.ask("一", "t1")).answer).toBe("resume=null prompt=一");
      expect((await hub.ask("二", "t2")).answer).toBe("resume=NEW prompt=二"); // continued
      d.db.prepare("update chat set session_id = 'GONE' where id = 'claude'").run();
      const t3 = await hub.ask("三", "t3");
      expect(t3.answer).toMatch(/^resume=null prompt=【之前的对话记录/); // started over, with the record first
      expect(t3.note).toMatch(/续不上/);
      d.db.prepare("update chat set session_id = 'WROTE' where id = 'claude'").run();
      await expect(hub.ask("四", "t4")).rejects.toThrow(/No conversation found/); // it had already written: no replay
      expect(d.db.prepare("select status from chat_turn where id = 't4'").get()).toEqual({ status: "failed" });
      expect(d.db.prepare("select count(*) as n from agent_action").get()).toEqual({ n: 1 });
    } finally { d.close(); }
  });
  it("one answer at a time: the second message is refused; cancel kills the process and the turn ends", async () => {
    const d = await daemon();
    try {
      const cli = fakeCli(d.dir, `say({ type: "system", subtype: "init", session_id: "S" }); setTimeout(() => say({ type: "result", is_error: false, result: "late" }), 30_000);`);
      const b = cliBackend(d.s, d.auth, spec(cli), () => ({ command: "unused", args: [] }));
      const hub = new ChatHub(d.s, { builtin: builtinBackend(d.career, d.s), claude: b, codex: b, dsh: b });
      d.hubRef.hub = hub; d.s.config.agent!.backend = "claude";
      const first = hub.ask("慢", "slow");
      await new Promise((r) => setTimeout(r, 700));
      await expect(hub.ask("再", "again")).rejects.toMatchObject({ code: "BUSY" });
      expect(hub.busy()).toEqual({ turnId: "slow", backend: "claude" });
      hub.cancel();
      await expect(first).rejects.toThrow(/已停止/);
      expect(d.db.prepare("select status from chat_turn where id = 'slow'").get()).toEqual({ status: "cancelled" });
      expect(hub.busy()).toBeNull();
    } finally { d.close(); }
  }, 20_000);
});

describe("an agent that speaks ACP (dsh and the like), through the bridge and the same runner", () => {
  it("names tools; the turn token reaches its Zhiro server; Zhiro tools are allowed, others refused; the session resumes, or starts over", async () => {
    expect(["mcp__jobos__position_watch", "jobos/today.summary", "jobos: today_summary", "shell"].map(jobosTool)).toEqual(["position.watch", "today.summary", "today.summary", null]);
    const d = await daemon();
    try {
      const agent = join(d.dir, "fake-acp.mjs");
      writeFileSync(agent, `
import * as acp from ${JSON.stringify(import.meta.resolve("@agentclientprotocol/sdk"))};
import { Readable, Writable } from "node:stream";
let env = {}, resumed = "none";
const servers = (p) => { env = Object.fromEntries(p.mcpServers[0].env.map((e) => [e.name, e.value])); };
const opts = [{ optionId: "y", name: "允许", kind: "allow_once" }, { optionId: "n", name: "拒绝", kind: "reject_once" }];
new acp.AgentSideConnection((c) => ({
  async initialize() { return { protocolVersion: acp.PROTOCOL_VERSION, agentCapabilities: { sessionCapabilities: { resume: {} } } }; },
  async newSession(p) { servers(p); return { sessionId: "A1" }; },
  async resumeSession(p) { if (p.sessionId === "GONE") throw new Error("no such session"); servers(p); resumed = p.sessionId; return {}; },
  async authenticate() { return {}; },
  async cancel() {},
  async prompt(p) {
    const up = (update) => c.sessionUpdate({ sessionId: p.sessionId, update });
    await up({ sessionUpdate: "tool_call", toolCallId: "t1", title: "mcp__jobos__position_watch", status: "pending" });
    const ok = await c.requestPermission({ sessionId: p.sessionId, toolCall: { toolCallId: "t1", title: "mcp__jobos__position_watch" }, options: opts });
    const no = await c.requestPermission({ sessionId: p.sessionId, toolCall: { toolCallId: "t2", title: "shell: del *" }, options: opts });
    const r = await fetch(env.JOBOS_URL + "/api/tools/position.watch", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer " + env.JOBOS_AGENT_TOKEN }, body: JSON.stringify({ positionId: ${JSON.stringify(d.pos.id)}, priority: 1 }) }).then((x) => x.json());
    await up({ sessionUpdate: "tool_call_update", toolCallId: "t1", status: "completed", rawOutput: r });
    const said = p.prompt[0].text;
    await up({ sessionUpdate: "agent_message_chunk", content: { type: "text", text: "ok=" + ok.outcome.optionId + " shell=" + no.outcome.optionId + " resumed=" + resumed + " rules=" + said.includes("<Zhiro 规则>") + " record=" + said.includes("之前的对话记录") } });
    return { stopReason: "end_turn" };
  },
}), acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
`, "utf8");
      const b = cliBackend(d.s, d.auth, acpSpec("dsh", () => ({ cmd: process.execPath, args: [agent] })), () => ({ command: process.execPath, args: [join(repoRoot(), "bin", "jobos-mcp.cjs")] }));
      const hub = new ChatHub(d.s, { builtin: builtinBackend(d.career, d.s), claude: b, codex: b, dsh: b });
      d.hubRef.hub = hub; d.s.config.agent!.backend = "dsh";
      const events: any[] = []; hub.onEvent((e) => events.push(e));
      const t1 = await hub.ask("关注底盘", "a1");
      expect(t1.answer).toBe("ok=y shell=n resumed=none rules=true record=false");
      expect(t1.actions.map((a) => a.tool)).toEqual(["position.watch"]);
      expect(d.db.prepare("select turn_id from agent_action").all()).toEqual([{ turn_id: "a1" }]);
      expect(events.filter((e) => e.type?.startsWith("tool_execution")).map((e) => [e.type, e.toolName])).toEqual([["tool_execution_start", "position.watch"], ["tool_execution_end", "position.watch"]]);
      expect((await hub.ask("再来", "a2")).answer).toMatch(/resumed=A1/);
      d.db.prepare("update chat set session_id = 'GONE' where id = 'dsh'").run();
      const t3 = await hub.ask("三", "a3");
      expect(t3.answer).toMatch(/resumed=none .*record=true/); // could not resume: started over with the record
    } finally { d.close(); }
  }, 60_000);
});

describe("the stdio MCP launcher relays to the daemon's /mcp", () => {
  it("lists and calls tools as an agent, closes cleanly, and the daemon keeps serving", async () => {
    const d = await daemon();
    try {
      const sdk = (m: string) => import.meta.resolve(`@modelcontextprotocol/sdk/client/${m}`);
      const { Client } = await import(sdk("index.js"));
      const { StdioClientTransport } = await import(sdk("stdio.js"));
      const c = new Client({ name: "t", version: "1" });
      await c.connect(new StdioClientTransport({ command: process.execPath, args: [join(repoRoot(), "bin", "jobos-mcp.cjs")], env: { ...process.env, JOBOS_VAULT: d.dir, JOBOS_URL: `http://127.0.0.1:${d.s.config.http.port}`, JOBOS_ACTOR: "t" } as any }));
      const names = (await c.listTools()).tools.map((t: any) => t.name);
      expect(names).toContain("position.watch");
      expect(names).not.toContain("model.login"); // an agent's list
      const r: any = await c.callTool({ name: "position.watch", arguments: { positionId: d.pos.id, priority: 1 } });
      expect(JSON.parse(r.content[0].text).action.tool).toBe("position.watch");
      await c.close();
      await new Promise((ok) => setTimeout(ok, 500));
      // an empty Response after the transport had answered crashed the daemon (ERR_HTTP_HEADERS_SENT), 2026-10-14 — a client
      // opening the event stream (GET) and a notification (202) are answered by the transport alone
      const key = readFileSync(join(d.dir, "config", ".agent-token"), "utf8").trim(), h = { authorization: `Bearer ${key}`, accept: "application/json, text/event-stream", "content-type": "application/json" };
      const url = `http://127.0.0.1:${d.s.config.http.port}/mcp`;
      expect((await fetch(url, { headers: h })).status).toBe(405); // no event stream on a stateless server
      await fetch(url, { method: "POST", headers: h, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) }).then((x) => x.text());
      expect((await fetch(url, { method: "DELETE", headers: h })).status).toBe(405);
      await new Promise((ok) => setTimeout(ok, 300));
      expect((await fetch(`http://127.0.0.1:${d.s.config.http.port}/api/tools`)).status).toBe(401);
    } finally { d.close(); }
  }, 60_000);
});

