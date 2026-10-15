/**
 * Codex as the chat backend: `codex exec --json`, continued with `codex exec resume <id>`. The person's own Codex config
 * is not loaded (its MCP servers, skills budget and model choice would come along); the jobos server is given with -c,
 * the rules are the working directory's AGENTS.md, the user's words come in on stdin.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { followedModel, type CliLine, type CliSpec } from "./cli.js";

export function codexLauncher(): { cmd: string; args: string[] } | null {
  const override = process.env.JOBOS_CODEX_CLI;
  if (override) return override.endsWith(".js") ? { cmd: process.execPath, args: [override] } : { cmd: override, args: [] };
  const js = join(process.env.APPDATA ?? "", "npm", "node_modules", "@openai", "codex", "bin", "codex.js");
  if (existsSync(js)) return { cmd: process.execPath, args: [js] };
  for (const c of ["/usr/local/bin/codex", join(process.env.HOME ?? "", ".local", "bin", "codex")]) if (existsSync(c)) return { cmd: c, args: [] };
  return null;
}

const toml = (v: string) => JSON.stringify(v); // a TOML basic string is a JSON string for our values (paths, ids)

export const codexSpec: CliSpec = {
  name: "codex",
  launcher: codexLauncher,
  prepare: (dir, rules) => writeFileSync(join(dir, "AGENTS.md"), rules, "utf8"),
  argv: ({ dir, sessionId, mcp, prompt }) => ({
    args: [
      "exec", "--json", "--skip-git-repo-check", "--ignore-user-config",
      "-C", dir, "-s", "read-only",
      "-c", 'approval_policy="never"',
      ...(followedModel("codex") ? ["-c", `model=${toml(followedModel("codex"))}`] : []), // the model they chose in Codex, nothing else of their config
      "-c", `mcp_servers.jobos.command=${toml(mcp.command)}`,
      "-c", `mcp_servers.jobos.args=[${mcp.args.map(toml).join(",")}]`,
      "-c", `mcp_servers.jobos.env={${Object.entries(mcp.env).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`,
      "-c", 'mcp_servers.jobos.default_tools_approval_mode="approve"',
      "-o", join(dir, "last.md"),
      ...(sessionId ? ["resume", sessionId] : []),
      "-",
    ],
    stdin: prompt,
  }),
  parser: () => (line: string): CliLine[] => {
    if (!line.trim().startsWith("{")) return [{ kind: "ignore" }];
    const e = JSON.parse(line);
    if (e.type === "thread.started" && e.thread_id) return [{ kind: "session", id: e.thread_id }];
    const it = e.item;
    if (e.type === "item.started" && it?.type === "mcp_tool_call") return [{ kind: "event", event: { type: "tool_execution_start", toolName: it.tool, args: it.arguments } }];
    if (e.type === "item.completed" && it?.type === "mcp_tool_call") {
      const text = (it.result?.content ?? []).map((c: any) => c.text ?? "").join("") || (it.error?.message ?? "");
      let details: any = it.result?.structured_content; if (details == null) { try { details = JSON.parse(text); } catch { details = undefined; } }
      return [{ kind: "event", event: { type: "tool_execution_end", toolName: it.tool, isError: it.status === "failed" || !!it.error, result: { details, content: [{ type: "text", text }] } } }];
    }
    if (e.type === "item.completed" && it?.type === "agent_message" && it.text) return [{ kind: "text", text: it.text }];
    if (e.type === "item.completed" && it?.type === "reasoning" && it.text) return [{ kind: "event", event: { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: it.text }] } } }];
    if (e.type === "item.completed" && it?.type === "error") {
      const msg = String(it.message ?? "");
      if (/skill descriptions were shortened/i.test(msg)) return [{ kind: "ignore" }];
      return [{ kind: "result", text: "", isError: true, error: msg.slice(0, 300), sessionMissing: /thread|session|rollout/i.test(msg) && /not found|no such|does not exist|no rollout/i.test(msg) }];
    }
    if (e.type === "error") { const msg = String(e.message ?? "出错了"); return [{ kind: "result", text: "", isError: true, error: msg.slice(0, 300), sessionMissing: /thread|session|rollout/i.test(msg) && /not found|no such|does not exist|no rollout/i.test(msg) }]; }
    if (e.type === "turn.completed") return [{ kind: "result", text: "", isError: false }]; // the answer is the last agent_message (or -o)
    return [{ kind: "ignore" }];
  },
};
