/**
 * Claude Code as the chat backend: `claude -p --output-format stream-json`, continued with --resume. Only the jobos MCP
 * server and web search / fetch; no user settings, hooks or slash commands; the rules appended to its system prompt.
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { followedModel, type CliLine, type CliSpec } from "./cli.js";

/** Windows: a .cmd shim cannot be spawned without a shell, so the npm install's JS entry is run with this node. Override with JOBOS_CLAUDE_CLI. */
export function claudeLauncher(): { cmd: string; args: string[] } | null {
  const override = process.env.JOBOS_CLAUDE_CLI;
  if (override) return override.endsWith(".js") ? { cmd: process.execPath, args: [override] } : { cmd: override, args: [] };
  // the npm package: a native binary copied to bin/ by its postinstall; else its JS fallback launcher; else the old cli.js
  const pkg = join(process.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code");
  if (existsSync(join(pkg, "bin", "claude.exe"))) return { cmd: join(pkg, "bin", "claude.exe"), args: [] };
  for (const c of [join(pkg, "cli-wrapper.cjs"), join(pkg, "cli.js")]) if (existsSync(c)) return { cmd: process.execPath, args: [c] };
  for (const c of ["/usr/local/bin/claude", join(process.env.HOME ?? "", ".local", "bin", "claude"), join(process.env.HOME ?? "", ".claude", "local", "claude")]) if (existsSync(c)) return { cmd: c, args: [] };
  return null;
}

const TOOL = /^mcp__jobos__(.+)$/;
const toolName = (n: string) => { const m = TOOL.exec(n); return m ? m[1].replace(/_/g, ".") : n; };

export const claudeSpec: CliSpec = {
  name: "claude",
  launcher: claudeLauncher,
  argv: ({ dir, sessionId, rulesFile, mcp, prompt, budgetUsd, maxTurns }) => {
    // the MCP config is a file by name; it holds this turn's token, which is dead once the turn ends — the file is
    // overwritten next turn and removed on reset
    const mcpFile = join(dir, "mcp.json");
    writeFileSync(mcpFile, JSON.stringify({ mcpServers: { jobos: mcp } }), "utf8");
    return {
      args: [
        "-p", "--output-format", "stream-json", "--verbose",
        ...(sessionId ? ["--resume", sessionId] : []),
        "--mcp-config", mcpFile, "--strict-mcp-config",
        "--tools", "WebSearch,WebFetch", "--allowedTools", "mcp__jobos__*", "WebSearch", "WebFetch",
        "--permission-mode", "dontAsk",
        "--append-system-prompt-file", rulesFile,
        "--setting-sources", "", "--disable-slash-commands",
        ...(followedModel("claude") ? ["--model", followedModel("claude")] : []), // the model they chose in Claude Code, nothing else of their settings
        "--max-turns", String(maxTurns), "--max-budget-usd", String(budgetUsd),
        // the prompt as an argument, not on stdin: on Windows the CLI reads a piped stdin in the console code page and
        // Chinese arrives garbled (seen 2026-10-13); argv is UTF-16 and arrives intact
        "--", prompt,
      ],
    };
  },
  parser: () => {
    const names = new Map<string, string>(); // tool_use id → tool name, for the matching result line
    return (line: string): CliLine[] => {
      if (!line.trim().startsWith("{")) return [{ kind: "ignore" }];
      const e = JSON.parse(line);
      const out: CliLine[] = [];
      if (e.type === "system" && e.subtype === "init" && e.session_id) out.push({ kind: "session", id: e.session_id });
      else if (e.type === "assistant") {
        for (const b of e.message?.content ?? []) {
          if (b.type === "tool_use") { names.set(b.id, toolName(b.name)); out.push({ kind: "event", event: { type: "tool_execution_start", toolName: toolName(b.name), args: b.input } }); }
          else if (b.type === "text" && b.text) out.push({ kind: "text", text: b.text });
          else if (b.type === "thinking" && b.thinking) out.push({ kind: "event", event: { type: "message_end", message: { role: "assistant", content: [{ type: "thinking", thinking: b.thinking }] } } });
        }
      } else if (e.type === "user") {
        for (const b of e.message?.content ?? []) {
          if (b.type !== "tool_result") continue;
          const text = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("");
          let details: any; try { details = JSON.parse(text); } catch { details = undefined; }
          out.push({ kind: "event", event: { type: "tool_execution_end", toolName: names.get(b.tool_use_id) ?? "?", isError: !!b.is_error, result: { details, content: [{ type: "text", text }] } } });
        }
      } else if (e.type === "result") {
        const text = typeof e.result === "string" ? e.result : "";
        // a session that cannot be resumed: the CLI says so on stderr only ("No conversation found with session ID"), and
        // its result line is an error with nothing executed (num_turns 0) — that pair is what we go by (seen 2026-10-13)
        const sessionMissing = !!e.is_error && (e.num_turns === 0 && e.subtype === "error_during_execution" || /no conversation found|session.*not found|could not (find|resume)/i.test(text));
        out.push({ kind: "result", text: e.is_error ? "" : text, costUsd: typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined, isError: !!e.is_error, error: e.is_error ? (text || e.subtype || "出错了").slice(0, 300) : undefined, sessionMissing });
        if (e.session_id) out.push({ kind: "session", id: e.session_id });
      }
      return out.length ? out : [{ kind: "ignore" }];
    };
  },
};
