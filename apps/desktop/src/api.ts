/**
 * Thin client for the daemon. All calls go through the same tool registry the agents use,
 * with actor = desktop (human) so writes execute directly and proposals can be decided here.
 */
/**
 * Same-origin always: in dev Vite proxies /api → daemon; in prod the daemon serves this UI at /app.
 * (Chrome/WebView2 Local Network Access checks block cross-origin fetches to loopback, so we never do that.)
 * Two ways to be the person (ADR-045): the Tauri window reads the token from disk and sends it as a bearer; a browser
 * holds an HttpOnly session cookie set by the launch link — this code never sees a token then.
 */
let token = "";
const base = "";

declare global {
  interface Window { __TAURI_INTERNALS__?: unknown }
}

export async function initApi(): Promise<void> {
  if (window.__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    token = await invoke<string>("daemon_token");
    return;
  }
  // a browser: the cookie is sent on its own; if it is not there, the app shows the key box (App.tsx)
  const r = await fetch(`${base}/api/tools`, { credentials: "same-origin" });
  if (r.status === 401) throw new ApiError("NEED_LOGIN", "还没有登录");
}

/** Where the person's key file is, for the key box; and the key pasted once → the session cookie. */
export async function keyFile(): Promise<string> { try { return (await (await fetch(`${base}/health`)).json()).keyFile ?? ""; } catch { return ""; } }
export async function loginWithKey(key: string): Promise<void> {
  const r = await fetch(`${base}/api/launch`, { method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: key }) });
  const body = await r.json().catch(() => ({}));
  if (!r.ok) throw new ApiError(body.error ?? String(r.status), body.message ?? "登录失败");
}

export class ApiError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

/** Identifies this window, so it can ignore the echo of its own writes and still refresh on everyone else's. */
export const CLIENT_ID = Math.random().toString(36).slice(2);

const auth = (): Record<string, string> => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

export async function call<T = any>(tool: string, input: unknown = {}): Promise<T> {
  const res = await fetch(`${base}/api/tools/${tool}`, {
    method: "POST", credentials: "same-origin",
    headers: { ...auth(), "x-jobos-actor": "desktop", "x-jobos-client": CLIENT_ID },
    body: JSON.stringify(input ?? {}),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new ApiError(body.error ?? String(res.status), body.message ?? "request failed");
  return body as T;
}

/** One assistant turn: the reply, writes it did at once (undoable), and confirm cards (proposals) it needs decided. */
export interface Turn { answer: string; actions: any[]; proposals: any[]; backend?: string; cost?: { usd?: number; kind: "estimated" | "unknown" }; note?: string }

/** The window names the turn, so the step log can keep this turn's events apart from another window's. */
export async function chat(text: string, turnId: string): Promise<Turn> {
  const res = await fetch(`${base}/api/chat`, { method: "POST", credentials: "same-origin", headers: auth(), body: JSON.stringify({ text, turnId }) });
  const body = await res.json();
  if (!res.ok) throw new ApiError(body.error ?? "AGENT_ERROR", body.message ?? "agent failed");
  return { answer: body.answer ?? "", actions: body.actions ?? [], proposals: body.proposals ?? [], backend: body.backend, cost: body.cost, note: body.note };
}

export async function chatHistory(): Promise<{ items: { role: "user" | "agent"; text: string; backend?: string }[]; backend: string }> {
  const res = await fetch(`${base}/api/chat/history`, { credentials: "same-origin", headers: auth() });
  if (!res.ok) return { items: [], backend: "" };
  const b = await res.json();
  return { items: b.items ?? [], backend: b.backend ?? "" };
}
export async function chatReset(): Promise<void> { await fetch(`${base}/api/chat/reset`, { method: "POST", credentials: "same-origin", headers: auth() }); }
export async function chatCancel(): Promise<void> { await fetch(`${base}/api/chat/cancel`, { method: "POST", credentials: "same-origin", headers: auth() }); }

/**
 * The event stream. EventSource cannot send headers: with a bearer token each connection first trades it for a one-time
 * ticket (and a dropped connection gets a fresh ticket, never the used one); with the cookie the browser reconnects itself.
 *
 * One connection per page, however many parts of it listen: a browser keeps at most six connections to one address
 * across all its tabs, and a stream holds one for as long as the page is open. With a stream each for the page and the
 * chat drawer, the third Zhiro tab used up the last two — after that every request in every tab just waited (seen
 * 2026-10-13: the settings page stuck on 加载中 while the daemon answered at once).
 */
type Listener = (type: string, data: any) => void;
const listeners = new Set<Listener>();
let stream: EventSource | null = null, retry: any = null;
async function openStream() {
  if (stream || !listeners.size) return;
  let url = `${base}/api/events`;
  if (token) {
    const r = await fetch(`${base}/api/events/ticket`, { method: "POST", headers: auth() }).then((r) => r.json()).catch(() => null);
    if (!r?.ticket) { retry = setTimeout(openStream, 3_000); return; }
    url += `?ticket=${encodeURIComponent(r.ticket)}`;
  }
  if (stream || !listeners.size) return; // opened, or no longer wanted, while the ticket was fetched
  const es = (stream = new EventSource(url));
  for (const t of ["capture", "tool", "agent", "hello", "data", "scan"]) es.addEventListener(t, (e: MessageEvent) => { const d = safeJson(e.data); for (const l of [...listeners]) l(t, d); });
  if (token) es.onerror = () => { es.close(); if (stream === es) stream = null; retry = setTimeout(openStream, 2_000); }; // the browser's own retry would reuse the spent ticket
}
export function events(onEvent: Listener): () => void {
  listeners.add(onEvent);
  void openStream();
  return () => { listeners.delete(onEvent); if (!listeners.size) { clearTimeout(retry); stream?.close(); stream = null; } };
}

function safeJson(s: string) { try { return JSON.parse(s); } catch { return s; } }

export function bookmarkletUrl(): string { return `${window.location.origin}${base}/bookmarklet`; }

export function daysLeft(iso: string | null): number | null {
  if (!iso) return null;
  return Math.ceil((Date.parse(iso + "T23:59:59+08:00") - Date.now()) / 86400_000);
}
