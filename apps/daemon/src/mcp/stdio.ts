/**
 * `jobos-mcp` over stdio for Claude Code / Codex / any MCP client.
 * ponytail: a relay, nothing more — every MCP message goes to the running daemon's own MCP endpoint (/mcp) and back, so
 * there is one MCP implementation and one business process (Codex review 2.3). It used to rebuild the tool list and the
 * results itself from /api/tools: two copies of the same rules (2026-10-14). If the daemon is not running, every request
 * is answered at once with an error that says so.
 * It carries the agent credential (ADR-045): whatever client sits behind it is an agent to the daemon. An embedded
 * harness (one the daemon started for a chat turn) gets its turn token through JOBOS_AGENT_TOKEN instead.
 */
import "../env.js"; // ZHIRO_* names (before anything reads the environment)
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { defaultVaultDir } from "../config.js";

const vault = defaultVaultDir();
const base = process.env.JOBOS_URL ?? "http://127.0.0.1:8787";
const token = process.env.JOBOS_AGENT_TOKEN ?? readFileSync(join(vault, "config", ".agent-token"), "utf8").trim();
const actorVia = process.env.JOBOS_ACTOR ?? "mcp"; // an audit label only (claude / codex / workbuddy / …)

const down = new StdioServerTransport();
const up = new StreamableHTTPClientTransport(new URL("/mcp", base), { requestInit: { headers: { authorization: `Bearer ${token}`, "x-jobos-actor": actorVia } } });

down.onmessage = (m: JSONRPCMessage) => {
  up.send(m).catch((e: any) => {
    if (!("id" in m) || !("method" in m)) return; // a notification or a response: nobody waits for an answer
    const why = /fetch failed|ECONNREFUSED/i.test(String(e?.cause?.code ?? e?.message)) ? `Zhiro 没在运行（${base} 连不上），请先启动 Zhiro` : String(e?.message ?? e);
    void down.send({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: why } });
  });
};
up.onmessage = (m: JSONRPCMessage) => void down.send(m);
down.onclose = () => { void up.close(); process.exit(0); };
await up.start();
await down.start();
