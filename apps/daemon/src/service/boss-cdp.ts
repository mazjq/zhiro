import { spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

/**
 * The dedicated BOSS browser (D-28): the system's own Chrome started the ordinary way with a debugging port and a
 * profile of its own (`<data>/boss-chrome`); the person logs in to BOSS there once. Not Playwright, no automation
 * switch: to BOSS it is a person's browser. Zhiro attaches over the DevTools protocol to open pages, scroll, and
 * listen to the responses the page itself asks for — it never sends a request of its own to BOSS (a request injected
 * into the page is what BOSS flags, code 37; the reference project's issue #53). Chrome 136+ refuses a debugging port
 * on the person's default profile, hence the profile of its own; their everyday Chrome is never touched.
 */
export const DEFAULT_PORT = 9333;

export function chromePath(): string | null {
  const c = process.platform === "win32"
    ? [process.env.ProgramFiles, process.env["ProgramFiles(x86)"], process.env.LOCALAPPDATA].filter(Boolean).map((d) => join(d!, "Google", "Chrome", "Application", "chrome.exe"))
    : process.platform === "darwin" ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
    : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return c.find((p) => p && existsSync(p)) ?? null;
}

export const profileDir = (vault: string) => join(vault, "boss-chrome");

/** Is the dedicated browser up on its port, and which page is it on. */
export async function browserState(port = DEFAULT_PORT): Promise<{ running: boolean; page?: string }> {
  try {
    const tabs = (await (await fetch(`http://127.0.0.1:${port}/json`, { signal: AbortSignal.timeout(1500) })).json()) as { type: string; url: string }[];
    return { running: true, page: tabs.find((t) => t.type === "page")?.url };
  } catch { return { running: false }; }
}

/** Start it if it is not up. Returns at once; the window stays the person's. */
export async function openBrowser(vault: string, port = DEFAULT_PORT): Promise<{ running: boolean; started: boolean; page?: string }> {
  const now = await browserState(port);
  if (now.running) return { ...now, started: false };
  const chrome = chromePath();
  if (!chrome) throw Object.assign(new Error("NO_CHROME: 没找到 Google Chrome；装好 Chrome 再试"), { code: "NO_CHROME" });
  mkdirSync(profileDir(vault), { recursive: true });
  spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profileDir(vault)}`, "--no-first-run", "--no-default-browser-check", "https://www.zhipin.com/"], { detached: true, stdio: "ignore" }).unref();
  for (let i = 0; i < 20; i++) { await new Promise((r) => setTimeout(r, 500)); const s = await browserState(port); if (s.running) return { ...s, started: true }; }
  return { running: false, started: true };
}

export interface CdpEvent { method: string; params: any }
export interface Cdp { send(method: string, params?: Record<string, unknown>): Promise<any>; events: CdpEvent[]; close(): void }

/** Attach to the browser's BOSS tab (or its first page). Events are kept in `events` for the caller to read. */
export async function attach(port = DEFAULT_PORT): Promise<Cdp> {
  const st = await browserState(port);
  if (!st.running) throw Object.assign(new Error("BROWSER_DOWN: BOSS 专用浏览器没开：在设置页点「打开 BOSS 专用浏览器」，在里面登录一次"), { code: "BROWSER_DOWN" });
  const tabs = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()) as { type: string; url: string; webSocketDebuggerUrl: string }[];
  const tab = tabs.find((t) => t.type === "page" && /zhipin\.com/.test(t.url)) ?? tabs.find((t) => t.type === "page");
  if (!tab) throw Object.assign(new Error("BROWSER_DOWN: 专用浏览器里没有打开的页面"), { code: "BROWSER_DOWN" });
  const ws = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise<void>((ok, no) => { ws.onopen = () => ok(); ws.onerror = () => no(new Error("连不上专用浏览器")); });
  let seq = 0;
  const waiting = new Map<number, (d: any) => void>();
  const events: CdpEvent[] = [];
  ws.onmessage = (m) => {
    const d = JSON.parse(String(m.data));
    if (d.id && waiting.has(d.id)) { waiting.get(d.id)!(d); waiting.delete(d.id); } else if (d.method) { events.push(d); if (events.length > 2000) events.splice(0, 1000); }
  };
  return {
    events,
    send: (method, params = {}) => new Promise((ok, no) => {
      const id = ++seq;
      const t = setTimeout(() => { waiting.delete(id); no(new Error(`CDP ${method} 超时`)); }, 30_000);
      waiting.set(id, (d) => { clearTimeout(t); d.error ? no(new Error(d.error.message)) : ok(d.result); });
      ws.send(JSON.stringify({ id, method, params }));
    }),
    close: () => ws.close(),
  };
}
