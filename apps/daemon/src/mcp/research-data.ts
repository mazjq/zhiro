/**
 * The data tools, for the background research worker (ADR-056). The worker is a web-reading agent kept apart from the
 * user's data, so it is not given the daemon: this small stdio server holds only the public-data tools (a company's
 * filings, a theme's listed companies, brokers' reports, US occupation statistics). It does not talk to the daemon,
 * carries no token and opens no database. Each call and its answer are written to the run's own directory
 * (JOBOS_RUN_DIR), which is how the daemon later knows what the report was given.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { tools } from "@zhiro/contracts";
import { callData, dataFile, DATA_TOOLS, type DataTool } from "../service/research-data.js";

const file = process.env.JOBOS_RUN_DIR ? dataFile(process.env.JOBOS_RUN_DIR) : undefined;
const names = Object.keys(DATA_TOOLS) as DataTool[];
/** Tool names on the wire are letters and underscores only (company_financials): some clients refuse a dot. */
export const wireName = (n: string) => n.replace(".", "_");
const inWireNames = (text: string) => names.reduce((t, n) => t.split(n).join(wireName(n)), text);

const server = new Server({ name: "jobos-data", version: "0.0.1" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: names.map((n) => {
    const input = tools[n].input as any;
    const { runId: _run, ...properties } = input.properties; // the run is this process's own: nothing for the model to pass
    return { name: wireName(n), description: inWireNames(tools[n].description), inputSchema: { type: "object", properties, required: (input.required ?? []).filter((r: string) => r !== "runId") } };
  }),
}));
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const tool = names.find((n) => wireName(n) === req.params.name);
  if (!tool) return { isError: true, content: [{ type: "text", text: `unknown tool ${req.params.name}` }] };
  try { return { content: [{ type: "text", text: JSON.stringify(await callData(tool, req.params.arguments ?? {}, file)) }] }; }
  catch (e: any) { return { isError: true, content: [{ type: "text", text: String(e?.message ?? e) }] }; }
});
await server.connect(new StdioServerTransport());
