import { withPurpose } from "./service/usage.js";
import { Hono, type MiddlewareHandler } from "hono";
import { cors } from "hono/cors";
import { getCookie, setCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { callTool, callableBy, ToolError, type Actor, type Services } from "./registry.js";
import { tools, type ToolContract } from "@zhiro/contracts";
import { createMcpServer } from "./mcp/server.js";
import type { ChatHub } from "./agent/backend.js";
import type { Auth, Principal } from "./auth.js";
import { bus, emit, emitToolDone } from "./events.js";
import { currentRun } from "./service/apply-run.js";
import { existsSync, readFileSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { join, resolve } from "node:path";
import { UI_DIST } from "./paths.js";
import { VERSION } from "./version.js";
import { serveStatic } from "@hono/node-server/serve-static";
import { RESPONSE_ALREADY_SENT } from "@hono/node-server/utils/response";

export { bus } from "./events.js";

const SESSION_COOKIE = "jobos_session";
const SESSION_MAX_AGE_S = 30 * 24 * 3600; // a persistent cookie: a browser logs in once, not once per browser window
const INSTANCE_ID = randomUUID();
/** The data directory, recognisable but not spelled out: the path's hash (normalised), first 16 hex chars. */
export const vaultFingerprint = (vault: string) => createHash("sha256").update(resolve(vault).replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 16);

/** One agent event reduced to what a person can follow: which tool with what, what the model said or thought in between. */
function agentStep(e: any): { type: string; tool?: string; args?: string; text?: string; thinking?: string; ok?: boolean; result?: string; write?: boolean } {
  const clip = (s: string, n: number) => s.replace(/\s+/g, " ").trim().slice(0, n);
  if (e.type === "tool_execution_start") return { type: e.type, tool: String(e.toolName ?? "").replace(/_/g, "."), args: clip(JSON.stringify(e.args ?? {}), 600) };
  if (e.type === "tool_execution_end") {
    const tool = String(e.toolName ?? "").replace(/_/g, ".");
    const d = e.result?.details;
    const result = e.isError ? clip(String(e.result?.content?.[0]?.text ?? "失败"), 200)
      : Array.isArray(d?.items) ? `${d.items.length} 条${d.total != null && d.total !== d.items.length ? `（共 ${d.total}）` : ""}`
      : d?.action ? `已执行：${d.action.summary}` : d?.proposal ? "生成确认卡" : clip(JSON.stringify(d ?? ""), 120);
    // pages refresh only after a write; a lookup changes nothing on screen
    return { type: e.type, tool, ok: !e.isError, result, write: !!(tools as Record<string, ToolContract | undefined>)[tool]?.effects.localWrite };
  }
  if (e.type === "message_end" && e.message?.role === "assistant") {
    const blocks = e.message.content ?? [];
    const thinking = blocks.filter((b: any) => b.type === "thinking").map((b: any) => b.thinking).join(" ");
    const text = blocks.filter((b: any) => b.type === "text").map((b: any) => b.text).join(" ");
    return { type: e.type, text: clip(text, 200), thinking: clip(thinking, 300) };
  }
  return { type: e.type };
}

const CAPTURE_MAX_BYTES = 1_000_000;
const CAPTURE_MIN_GAP_MS = 500;

type Env = { Variables: { principal: Principal } };

/**
 * Every way in carries a credential (ADR-045): the person's token or browser session, the agent token, a turn token.
 * Which credential decides who the caller is; the x-jobos-actor header only lowers (and labels the audit row).
 * An agent credential reaches the tools (/api/tools, /mcp) and nothing else: not the chat, not the event stream, not the UI.
 */
export function createApp(s: Services, auth: Auth, chat: ChatHub) {
  const app = new Hono<Env>();
  app.use("*", cors({ origin: (o) => (o && /^(https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?|tauri:\/\/localhost|http:\/\/tauri\.localhost)$/.test(o) ? o : ""), allowHeaders: ["content-type", "authorization", "x-jobos-actor", "x-jobos-client"], credentials: true }));

  // instanceId / vault: so the desktop can tell this daemon from another one on the same port with a different data directory
  app.get("/health", (c) => c.json({ ok: true, name: "jobos-daemon", version: VERSION, instanceId: INSTANCE_ID, vault: vaultFingerprint(s.config.vault), pid: process.pid, applyRunning: !!currentRun()?.state && !["已投递", "已停止", "结果待核实"].includes(currentRun()!.state), keyFile: join(s.config.vault, "config", ".daemon-token") }));

  // the credential: `Authorization: Bearer <key>`, or `x-jobos-key: <key>` for a client that strips Authorization headers
  // from its config (WorkBuddy does, seen 2026-10-13) — same key, same rules
  const bearerOf = (c: any): string | undefined => { const h = c.req.header("authorization") ?? ""; return h.startsWith("Bearer ") ? h.slice(7) : (c.req.header("x-jobos-key") || undefined); };
  const principalOf = (c: any): Principal | null => auth.principalOf(bearerOf(c), getCookie(c, SESSION_COOKIE));
  const goodHost = (c: any) => /^(127\.0\.0\.1|localhost)(:\d+)?$/.test(c.req.header("host") ?? "");
  const actorOf = (c: any): Actor => auth.actorOf(c.get("principal"), c.req.header("x-jobos-actor"));

  // ---------- the browser UI: a one-time launch code becomes a session cookie; the page's JS never sees a token ----------
  // the other way in: paste the person's key once; it is exchanged for the cookie and kept nowhere in the page
  let lastLogin = 0;
  app.post("/api/launch", async (c) => {
    if (!goodHost(c)) return c.json({ error: "BAD_HOST" }, 403);
    if (Date.now() - lastLogin < 500) return c.json({ error: "TOO_FAST" }, 429);
    lastLogin = Date.now();
    const body = await c.req.json().catch(() => ({}));
    const p = auth.principalOf(String(body?.token ?? "").trim(), undefined);
    if (!p || p.kind !== "human") return c.json({ error: "UNAUTHORIZED", message: "钥匙不对：要粘贴的是 config\\.daemon-token 这个文件里的那一行" }, 401);
    setCookie(c, SESSION_COOKIE, auth.newSession(), { httpOnly: true, sameSite: "Strict", path: "/", maxAge: SESSION_MAX_AGE_S });
    return c.json({ ok: true });
  });
  app.get("/api/launch", (c) => {
    const session = auth.redeemLaunch(c.req.query("code"));
    if (!session || !goodHost(c)) return c.text("这个打开链接已失效：从托盘「打开」，或用 daemon 启动时打印的链接", 403);
    setCookie(c, SESSION_COOKIE, session, { httpOnly: true, sameSite: "Strict", path: "/", maxAge: SESSION_MAX_AGE_S });
    const to = c.req.query("to") ?? "/app/";
    return c.redirect(/^\/[^/]/.test(to) ? to : "/app/");
  });

  // Production UI: daemon serves the built desktop bundle same-origin; auth is the session cookie set by /api/launch
  const dist = UI_DIST;
  if (existsSync(join(dist, "index.html"))) {
    app.get("/app", (c) => c.redirect("/app/"));
    app.get("/app/", (c) => c.html(readFileSync(join(dist, "index.html"), "utf8"))); // read per request so a UI rebuild shows up without restarting the daemon
    app.use("/app/*", serveStatic({ root: dist, rewriteRequestPath: (p) => p.replace(/^\/app/, "") }));
  }

  // ---------- the guard: who is this, and may they be here ----------
  const guard = (agentAllowed: boolean): MiddlewareHandler<Env> => async (c, next) => {
    const p = principalOf(c);
    if (!p) return c.json({ error: "UNAUTHORIZED" }, 401);
    if (!goodHost(c)) return c.json({ error: "BAD_HOST" }, 403);
    if (p.kind === "agent" && !agentAllowed) return c.json({ error: "FORBIDDEN", message: "an agent credential reaches the tools only" }, 403);
    c.set("principal", p);
    await next();
  };
  app.use("/api/tools", guard(true));
  app.use("/api/tools/*", guard(true));
  app.use("/mcp", guard(true));
  app.use("/api/chat", guard(false));
  app.use("/api/chat/*", guard(false));
  app.use("/api/events/ticket", guard(false));
  app.use("/api/launch/code", guard(false));
  app.use("/bookmarklet", guard(false));
  // the person (the tray, a script holding the key) mints a one-time link to open the UI in a browser without typing anything
  app.post("/api/launch/code", (c) => c.json({ url: `http://${c.req.header("host")}/api/launch?code=${auth.newLaunch()}` }));

  // Bookmarklet installer page (the person only). Drag the link to the bookmarks bar; click it on any job page.
  app.get("/bookmarklet", (c) => {
    const origin = `http://${c.req.header("host")}`;
    const js = `javascript:(async()=>{const t=document.body.innerText;const r=await fetch(${JSON.stringify(origin + "/capture/" + auth.creds.capture)},{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url:location.href,title:document.title,text:t.slice(0,60000),html:document.documentElement.outerHTML.slice(0,400000)})}).then(r=>r.json()).catch(e=>({note:'Zhiro daemon 未运行: '+e}));alert('Zhiro: '+(r.note||JSON.stringify(r)));})();`;
    return c.html(`<!doctype html><meta charset="utf-8"><title>Zhiro 捕获书签</title><body style="font:15px system-ui;padding:32px;max-width:720px">
<h2>Zhiro 一键捕获</h2><p>把下面这个链接拖到浏览器书签栏。之后在任何招聘页面点它，页面正文会发到本机 Zhiro 并入库为岗位。</p>
<p><a href="${js.replace(/"/g, "&quot;")}" style="display:inline-block;padding:10px 16px;background:#274C77;color:#fff;border-radius:6px;text-decoration:none">📥 存到 Zhiro</a></p>
<p style="color:#666">只对本机有效；链接里带的钥匙只能用来存页面，别的都做不了。</p></body>`);
  });

  // bookmarklet capture: its own key travels in the URL (a bookmarklet on a third-party page cannot set headers); the key
  // reaches exactly this one tool, with a size and a pace
  let lastCapture = 0;
  app.post("/capture/:key", async (c) => {
    if (!auth.isCaptureKey(c.req.param("key"))) return c.json({ error: "UNAUTHORIZED" }, 401);
    if (Number(c.req.header("content-length") ?? 0) > CAPTURE_MAX_BYTES) return c.json({ error: "TOO_LARGE" }, 413);
    if (Date.now() - lastCapture < CAPTURE_MIN_GAP_MS) return c.json({ error: "TOO_FAST" }, 429);
    lastCapture = Date.now();
    const body = await c.req.json();
    const out = await callTool("listing.capture", body, { kind: "human", via: "desktop" }, s);
    emit("capture", out);
    return c.json(out);
  });

  app.get("/api/tools", (c) =>
    c.json({ tools: callableBy(actorOf(c), s).map((t) => ({ name: t.name, description: t.description, inputSchema: t.input, outputSchema: t.output, effects: t.effects, execution: t.execution })) }),
  );

  app.post("/api/tools/:name", async (c) => {
    const actor = actorOf(c);
    let input: unknown = {};
    try { input = await c.req.json(); } catch { /* empty body */ }
    try {
      const out = await callTool(c.req.param("name"), input, actor, s);
      emitToolDone(c.req.param("name"), actor, c.req.header("x-jobos-client") ?? "");
      return c.json(out);
    } catch (e: any) {
      const code = e instanceof ToolError ? e.code : "ERROR";
      const status = code === "NOT_FOUND" ? 404 : code === "FORBIDDEN" ? 403 : code === "UNAUTHORIZED" ? 401 : 400;
      return c.json({ error: code, message: e?.message ?? String(e) }, status);
    }
  });

  // the drawer: who answers is the hub's business (ADR-046); one answer at a time, a second message gets 409
  app.get("/api/chat/history", (c) => c.json({ items: chat.history(), backend: chat.current().name, busy: chat.busy() }));
  app.post("/api/chat/reset", (c) => { chat.reset(); return c.json({ ok: true }); });
  app.post("/api/chat/cancel", (c) => { chat.cancel(); return c.json({ ok: true }); });
  app.post("/api/chat", async (c) => {
    if (s.config.maintenance) return c.json({ error: "MAINTENANCE", message: "维护模式：暂不对话" }, 503);
    const { text, turnId } = await c.req.json();
    const id = /^[A-Za-z0-9-]{1,40}$/.test(String(turnId ?? "")) ? String(turnId) : undefined; // the window names the turn so it can tell the turn's events from others'
    try {
      const turn = await withPurpose("chat", "", () => chat.ask(String(text ?? ""), id));
      return c.json(turn);
    } catch (e: any) {
      if (e?.code === "BUSY") return c.json({ error: "BUSY", message: e.message }, 409);
      return c.json({ error: "AGENT_ERROR", message: e?.message ?? String(e) }, 500);
    }
  });

  // EventSource cannot set headers: a client holding a bearer token first trades it for a one-time ticket; the browser UI
  // just sends its cookie
  app.post("/api/events/ticket", (c) => c.json({ ticket: auth.newTicket() }));
  app.get("/api/events", (c) => {
    const p = principalOf(c);
    const ok = (p && p.kind === "human") || auth.redeemTicket(c.req.query("ticket"));
    if (!ok) return c.json({ error: "UNAUTHORIZED" }, 401);
    if (!goodHost(c)) return c.json({ error: "BAD_HOST" }, 403);
    return streamSSE(c, async (stream) => {
      const send = (ev: any) => stream.writeSSE({ event: ev.type, data: JSON.stringify(ev.data) });
      bus.on("event", send);
      // the chat drawer shows the assistant's steps from these (tool + args, interim text, thinking); pages refresh on the end events
      const agentUnsub = chat.onEvent((e) => send({ type: "agent", data: { ...agentStep(e), turnId: e.turnId ?? "", backend: e.backend ?? "" } }));
      stream.onAbort(() => { bus.off("event", send); agentUnsub(); });
      await stream.writeSSE({ event: "hello", data: "{}" });
      while (true) { await stream.sleep(15_000); await stream.writeSSE({ event: "ping", data: "{}" }); }
    });
  });

  // MCP streamable-http (stateless): the same credentials and the same registry as everything else
  app.all("/mcp", async (c) => {
    // stateless: no event stream to open (GET) and no session to end (DELETE) — a held GET also kept a server per request alive
    if (c.req.method !== "POST") return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed" }, id: null }, 405);
    const actor = actorOf(c);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true } as any);
    const server = createMcpServer(s, actor, c.req.header("x-zhiro-result-mode") === "text" ? "text" : "dual");
    await server.connect(transport);
    const { incoming, outgoing } = (c.env as any);
    const body = await c.req.json().catch(() => undefined);
    await transport.handleRequest(incoming, outgoing, body);
    // the transport wrote the answer itself: an empty Response here made the server write headers a second time, and
    // that error took the whole daemon down (2026-10-14, when the stdio relay started using /mcp)
    return RESPONSE_ALREADY_SENT;
  });

  return app;
}
