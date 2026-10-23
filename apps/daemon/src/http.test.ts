import { describe, it, expect } from "vitest";
import { createServices, testConfig } from "./services.js";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { createApp } from "./http.js";
import { Auth, loadCredentials } from "./auth.js";
import type { Services } from "./services.js";

function app() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-http-"));
  mkdirSync(join(dir, "config"));
  const db = openDb(join(dir, "t.db"));
  const s: Services = createServices({ db: db, config: testConfig(dir, { sources: [] }) });
  const auth = new Auth(loadCredentials(dir));
  const a = createApp(s, auth, { onEvent: () => () => {}, history: () => [], reset: () => {}, cancel: () => {}, ask: async () => ({}), current: () => ({ name: "builtin" }), busy: () => null } as any);
  return { a, auth, creds: auth.creds, db };
}
const H = { host: "127.0.0.1:8787", "content-type": "application/json" };
const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const bearer = (t: string) => ({ ...H, authorization: `Bearer ${t}` });

describe("every way in to the tools carries a credential (ADR-045)", () => {
  it("the api and the MCP endpoint both refuse a caller without one, whatever it says it is", async () => {
    const { a } = app();
    expect((await a.request("/api/tools", { headers: H })).status).toBe(401);
    expect((await a.request("/mcp", { method: "POST", headers: { ...H, "x-jobos-actor": "mcp-human" }, body: initialize })).status).toBe(401);
    expect((await a.request("/mcp", { method: "POST", headers: bearer("wrong"), body: initialize })).status).toBe(401);
    expect((await a.request("/mcp", { method: "GET", headers: H })).status).toBe(401);
  });
  it("with the person's token the api answers, and the MCP endpoint is let through; another host is refused", async () => {
    const { a, creds } = app();
    const ok = bearer(creds.human);
    expect((await a.request("/api/tools", { headers: ok })).status).toBe(200);
    // past the guard the MCP transport needs the node request objects a real server provides: anything but 401 / 403 here
    const mcp = await Promise.resolve(a.request("/mcp", { method: "POST", headers: ok, body: initialize })).then((r) => r.status).catch(() => 0);
    expect([401, 403]).not.toContain(mcp);
    expect((await a.request("/mcp", { method: "POST", headers: { ...ok, host: "evil.example" }, body: initialize })).status).toBe(403);
  });
  it("the credential decides who is calling; the header only lowers", async () => {
    const { a, creds } = app();
    // the agent token calling itself the desktop is still an agent: it does not see proposal.decide (confirmation in the
    // harness is the default, so it does see it — set to window to show the ceiling)
    const list = async (t: string, via?: string) => ((await (await a.request("/api/tools", { headers: { ...bearer(t), ...(via ? { "x-jobos-actor": via } : {}) } })).json()) as any).tools.map((x: any) => x.name) as string[];
    expect(await list(creds.human)).toContain("model.login");
    expect(await list(creds.agent, "desktop")).not.toContain("model.login");
    expect(await list(creds.human, "mcp")).not.toContain("model.login"); // the person acting as an agent
    // deciding as the agent token with a desktop header: refused by the registry, not by the transport
    const r = await a.request("/api/tools/model.login", { method: "POST", headers: { ...bearer(creds.agent), "x-jobos-actor": "desktop" }, body: "{}" });
    expect(r.status).toBe(403);
  });
  it("the key may also come as x-jobos-key (a client that strips Authorization headers)", async () => {
    const { a, creds } = app();
    expect((await a.request("/api/tools", { headers: { ...H, "x-jobos-key": creds.agent } })).status).toBe(200);
    expect((await a.request("/api/tools", { headers: { ...H, "x-jobos-key": "wrong" } })).status).toBe(401);
    expect((await a.request("/api/chat/history", { headers: { ...H, "x-jobos-key": creds.agent } })).status).toBe(403);
  });
  it("an agent credential reaches the tools and nothing else", async () => {
    const { a, creds } = app();
    for (const path of ["/api/chat/history", "/api/events/ticket", "/bookmarklet"]) {
      const r = await a.request(path, { method: path === "/api/events/ticket" ? "POST" : "GET", headers: bearer(creds.agent) });
      expect(r.status, path).toBe(403);
      expect((await a.request(path, { method: path === "/api/events/ticket" ? "POST" : "GET", headers: bearer(creds.human) })).status, path).toBe(200);
    }
  });
});

describe("the browser session, the event ticket, the capture key", () => {
  it("a launch code is good once and becomes a cookie the api accepts; without it /api/launch refuses", async () => {
    const { a, auth } = app();
    const code = auth.newLaunch();
    const r = await a.request(`/api/launch?code=${code}`, { headers: H });
    expect(r.status).toBe(302);
    const cookie = r.headers.get("set-cookie") ?? "";
    expect(cookie).toMatch(/jobos_session=\w+; Max-Age=2592000; Path=\/; HttpOnly; SameSite=Strict/);
    expect((await a.request(`/api/launch?code=${code}`, { headers: H })).status).toBe(403); // spent
    expect((await a.request(`/api/launch?code=nope`, { headers: H })).status).toBe(403);
    const session = cookie.split(";")[0];
    expect((await a.request("/api/tools", { headers: { ...H, cookie: session } })).status).toBe(200);
    expect((await a.request("/api/tools", { headers: { ...H, cookie: "jobos_session=forged" } })).status).toBe(401);
    // a redirect target is a local path or nothing
    expect((await a.request(`/api/launch?code=${auth.newLaunch()}&to=//evil.example`, { headers: H })).headers.get("location")).toBe("/app/");
  });
  it("the person's key pasted once becomes a cookie; a wrong key, an agent key or a ticket does not", async () => {
    const { a, auth, creds } = app();
    const post = (token: string) => a.request("/api/launch", { method: "POST", headers: H, body: JSON.stringify({ token }) });
    const ok = await post(creds.human);
    expect(ok.status).toBe(200);
    const session = (ok.headers.get("set-cookie") ?? "").split(";")[0];
    expect(session).toMatch(/^jobos_session=\w+$/);
    expect((await a.request("/api/tools", { headers: { ...H, cookie: session } })).status).toBe(200);
    await new Promise((r) => setTimeout(r, 600));
    expect((await post("wrong")).status).toBe(401);
    await new Promise((r) => setTimeout(r, 600));
    expect((await post(creds.agent)).status).toBe(401);
    await new Promise((r) => setTimeout(r, 600));
    expect((await post(auth.newTicket())).status).toBe(401);
  });
  it("the person mints a one-time open link; an agent cannot", async () => {
    const { a, creds } = app();
    expect((await a.request("/api/launch/code", { method: "POST", headers: bearer(creds.agent) })).status).toBe(403);
    const { url } = (await (await a.request("/api/launch/code", { method: "POST", headers: bearer(creds.human) })).json()) as any;
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:8787\/api\/launch\?code=\w{48}$/);
    expect((await a.request(url.replace("http://127.0.0.1:8787", ""), { headers: H })).status).toBe(302);
  });
  it("the event stream takes the cookie or a one-time ticket, never a bearer in the query, and a ticket is not a token", async () => {
    const { a, auth, creds } = app();
    expect((await a.request(`/api/events?token=${creds.human}`, { headers: H })).status).toBe(401);
    const { ticket } = (await (await a.request("/api/events/ticket", { method: "POST", headers: bearer(creds.human) })).json()) as any;
    expect(ticket).toMatch(/^\w{48}$/);
    expect((await a.request("/api/tools", { headers: bearer(ticket) })).status).toBe(401);
    expect(auth.redeemTicket(ticket)).toBe(true);
    expect(auth.redeemTicket(ticket)).toBe(false); // spent
  });
  it("the capture key opens exactly the capture route; a token is not a capture key", async () => {
    const { a, creds } = app();
    expect((await a.request(`/capture/${creds.human}`, { method: "POST", headers: H, body: "{}" })).status).toBe(401);
    expect((await a.request("/api/tools", { headers: bearer(creds.capture) })).status).toBe(401);
    const r = await a.request(`/capture/${creds.capture}`, { method: "POST", headers: { ...H, "content-length": "2000000" }, body: "{}" });
    expect(r.status).toBe(413);
  });
});
