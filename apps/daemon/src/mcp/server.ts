import { VERSION } from "../version.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, callableBy, ToolError, type Actor, type Services } from "../registry.js";
import { emitToolDone } from "../events.js";

/**
 * How a result is handed back (D-23). "dual" (default, what MCP asks for): the JSON as text and as structuredContent —
 * Claude Code gives its model the structured copy only, but Codex gives it both (measured 2026-10-15). "text": the
 * text copy alone, for a connection that said so (header x-zhiro-result-mode, set by the stdio relay from
 * ZHIRO_RESULT_MODE). Not the structured copy alone: with `content: []` Codex's model took the result for empty in
 * three runs of four. Never guessed from a client's name.
 */
export type ResultMode = "dual" | "text";

/** Low-level MCP server so TypeBox JSON Schema is passed through untouched. */
export function createMcpServer(s: Services, actor: Actor, mode: ResultMode = "dual"): Server {
  const server = new Server({ name: "zhiro", version: VERSION }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: callableBy(actor, s).map((c) => ({
      name: c.name,
      description: `${c.description}${actor.kind === "agent" ? (c.effects.localWrite || c.effects.externalAction ? (!c.effects.localWrite || c.effects.externalAction || c.effects.dataEgress || !c.effects.reversible ? "（写操作：生成提案，需用户确认）" : "（写操作：直接执行，用户可撤销）") : "") : ""}`,
      inputSchema: c.input as any,
    })),
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    try {
      const out: any = await callTool(req.params.name, req.params.arguments ?? {}, actor, s);
      emitToolDone(req.params.name, actor); // the pages refresh on this path too, not only on /api/tools
      if (mode === "text") return { content: [{ type: "text", text: JSON.stringify(out) }] };
      return out?.proposal
        ? { content: [{ type: "text", text: JSON.stringify(out) }] }
        : { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
    } catch (e: any) {
      const code = e instanceof ToolError ? e.code : "ERROR";
      return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: code, message: e?.message ?? String(e) }) }] };
    }
  });
  return server;
}
