import { VERSION } from "../version.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { callTool, callableBy, ToolError, type Actor, type Services } from "../registry.js";
import { emitToolDone } from "../events.js";

/** Low-level MCP server so TypeBox JSON Schema is passed through untouched. */
export function createMcpServer(s: Services, actor: Actor): Server {
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
