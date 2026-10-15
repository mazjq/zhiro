/**
 * One chat turn with an agent that speaks ACP (Agent Client Protocol: dsh, and any other that does natively), printed
 * as the same JSON lines `claude -p --output-format stream-json` prints. So an ACP agent is one more entry for the chat
 * runner (cli.ts) — limits, stop, session resume, turn token, record — instead of a second runner (2026-10-14).
 *
 *   node acp-bridge.ts --mcp <mcp.json> --rules <rules.md> [--resume <sessionId>] -- <agent command> [args…]   (the message on stdin)
 *
 * The agent gets Zhiro's MCP server (this turn's token is in mcp.json) and nothing from the client: no file reading,
 * no terminal. It asks before using a tool; Zhiro's tools are allowed, everything else is refused.
 */
import { spawn, execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { Readable, Writable } from "node:stream";
import * as acp from "@agentclientprotocol/sdk";
import { jobosTool } from "./acp.js";

const argv = process.argv.slice(2), cut = argv.indexOf("--");
const opt = (k: string) => { const i = argv.indexOf(k); return i >= 0 && i < cut ? argv[i + 1] : undefined; };
const [cmd, ...args] = argv.slice(cut + 1);
const mcp = JSON.parse(readFileSync(opt("--mcp")!, "utf8")).mcpServers.jobos as { command: string; args: string[]; env: Record<string, string> };
const rules = readFileSync(opt("--rules")!, "utf8");
const resume = opt("--resume");
const text = readFileSync(0, "utf8");

const say = (o: unknown) => process.stdout.write(JSON.stringify(o) + "\n");
const fail = (message: string, missing = false) => { say({ type: "result", subtype: "error_during_execution", is_error: true, num_turns: missing ? 0 : 1, result: message }); process.exit(0); };

const agent = spawn(cmd, args, { cwd: process.cwd(), stdio: ["pipe", "pipe", "inherit"], windowsHide: true, env: { ...process.env, CLAUDECODE: "" } });
agent.on("error", (e) => fail(`起不来：${e.message}`));
agent.on("exit", (code) => fail(`它自己退出了（退出码 ${code}）`));

const names = new Map<string, string>();
let answer = "";
const client: acp.Client = {
  async sessionUpdate({ update: u }: any) {
    if (u.sessionUpdate === "agent_message_chunk" && u.content?.type === "text") answer += u.content.text;
    else if (u.sessionUpdate === "tool_call") {
      const name = jobosTool(String(u.title ?? "")) ?? String(u.title ?? u.kind ?? "工具");
      names.set(u.toolCallId, name);
      say({ type: "assistant", message: { content: [{ type: "tool_use", id: u.toolCallId, name, input: u.rawInput ?? {} }] } });
    }
    if ((u.sessionUpdate === "tool_call" || u.sessionUpdate === "tool_call_update") && (u.status === "completed" || u.status === "failed")) {
      const out = u.rawOutput != null ? (typeof u.rawOutput === "string" ? u.rawOutput : JSON.stringify(u.rawOutput)) : (u.content ?? []).map((c: any) => c.content?.text ?? "").join("");
      say({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: u.toolCallId, content: out, is_error: u.status === "failed" }] } });
    }
  },
  async requestPermission(p: any) {
    const ok = !!jobosTool(String(p.toolCall?.title ?? "")) || /jobos/i.test(JSON.stringify(p.toolCall?.rawInput ?? {}));
    const o = p.options.find((x: any) => x.kind === (ok ? "allow_once" : "reject_once")) ?? p.options.find((x: any) => ok === x.kind.startsWith("allow"));
    return o ? { outcome: { outcome: "selected", optionId: o.optionId } } : { outcome: { outcome: "cancelled" } };
  },
};
const conn = new acp.ClientSideConnection(() => client, acp.ndJsonStream(Writable.toWeb(agent.stdin!), Readable.toWeb(agent.stdout!) as any));

try {
  const init = await conn.initialize({ protocolVersion: acp.PROTOCOL_VERSION, clientCapabilities: {} });
  const servers = [{ name: "jobos", command: mcp.command, args: mcp.args, env: Object.entries(mcp.env).map(([name, value]) => ({ name, value })) }];
  let sessionId = "";
  if (resume) {
    // this turn's token rides on the MCP server, so the session is resumed with it; an agent that cannot resume starts over
    if (!(init.agentCapabilities as any)?.sessionCapabilities?.resume) fail(`No conversation found with session ID: ${resume}（这个 agent 不能续接会话）`, true);
    sessionId = await conn.resumeSession({ sessionId: resume, cwd: process.cwd(), mcpServers: servers }).then(() => resume, () => "");
    if (!sessionId) fail(`No conversation found with session ID: ${resume}`, true);
  } else sessionId = (await conn.newSession({ cwd: process.cwd(), mcpServers: servers })).sessionId;
  say({ type: "system", subtype: "init", session_id: sessionId });
  // ACP has no system prompt: the rules go first in every message (they carry the day's deadlines)
  const r = await conn.prompt({ sessionId, prompt: [{ type: "text", text: `<Zhiro 规则>\n${rules}\n</Zhiro 规则>\n\n${text}` }] });
  if (answer) say({ type: "assistant", message: { content: [{ type: "text", text: answer }] } });
  const ok = r.stopReason === "end_turn";
  say({ type: "result", subtype: ok ? "success" : r.stopReason, is_error: !ok, result: ok ? answer : `没有答完（${r.stopReason}）`, session_id: sessionId });
} catch (e: any) {
  say({ type: "result", subtype: "error", is_error: true, result: String(e?.message ?? e).slice(0, 300) });
}
agent.removeAllListeners("exit");
// the agent and what it started (Zhiro's MCP forwarder among them)
try { if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(agent.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); else agent.kill(); } catch { /* gone */ }
process.exit(0);
