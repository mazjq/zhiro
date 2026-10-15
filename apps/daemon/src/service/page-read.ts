import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { now } from "../db.js";
import type { Services } from "../registry.js";
import { DomainError } from "./domain.js";
import { httpContext, publicUrl } from "../data/index.js";
import { articleText } from "./extract.js";
import { readerPage } from "./apply.js";
import { currentRun } from "./apply-run.js";
import { siteLinks } from "../data/index.js";

/**
 * 读页 (ADR-038): one tool that turns any web page into text the assistant can read — the information layer the per-site
 * readers cannot cover. HTTP first (fast, no browser); the person's own Chrome profile (logins, own IP) when the page
 * is rendered by script or thin over HTTP. Page = accessibility tree flattened to structured text + the links + the
 * tables; never clicks, never types, never gets past a login or a captcha — it reports them instead.
 */
export interface PageLink { text: string; href: string }
export interface PageRead {
  url: string; finalUrl: string; title: string;
  status: "ok" | "stepFailed" | "needsLogin" | "blocked" | "empty" | "busy" | "expired" | "closed";
  session?: { id: string; state: "ready" | "expired" | "closed"; actionsUsed: number; expiresAt: string };
  via: "http" | "browser" | "cache";
  text: string; links: PageLink[]; tables: string[][][];
  next: string | null; // a "下一页 / 加载更多" link when the page has one
  steps?: { step: string; ok: boolean; note: string }[];
  truncated: boolean; chars: number; found: boolean | null;
}
export interface PageReadInput { url?: string; mode?: "once" | "open" | "continue" | "close"; sessionId?: string; wait?: "load" | "idle"; find?: string; maxChars?: number; refresh?: boolean; browser?: boolean; steps?: Step[] }

// ponytail: Codex review (vault/research/2026-10-01-page-read-codex-review.md) sized these; continuation clicks,
// per-task limits and a shared BrowserHost are the second version
const DEFAULT_CHARS = 12_000, MAX_LINKS = 60, MAX_TABLES = 5, MAX_ROWS = 100, CACHE_MINUTES = 30, ORIGIN_INTERVAL_MS = 800, SETTLE_MAX_MS = 4_000, READ_HARD_MS = 60_000;
export const safeUrl = publicUrl;
const lastByOrigin = new Map<string, number>();
// two tabs at a time per site (what a person with two tabs does; measured 2026-10-02: one at a time made a 10-detail
// task take 7–11 s a page, serially), up to MAX_PARALLEL reads across sites
const MAX_PARALLEL = 4, PER_ORIGIN = 2;
class Semaphore {
  private active = 0; private waiters: (() => void)[] = [];
  constructor(private max: number) {}
  async run<T>(fn: () => Promise<T>): Promise<T> {
    while (this.active >= this.max) await new Promise<void>((r) => this.waiters.push(r));
    this.active++;
    try { return await fn(); } finally { this.active--; this.waiters.shift()?.(); }
  }
}
const global = new Semaphore(MAX_PARALLEL);
const perSite = new Map<string, Semaphore>();
function perOrigin<T>(origin: string, fn: () => Promise<T>): Promise<T> {
  const site = perSite.get(origin) ?? perSite.set(origin, new Semaphore(PER_ORIGIN)).get(origin)!;
  return site.run(() => global.run(fn));
}
const LOGIN_URL = /login|signin|sign-in|passport|sso|auth|register/i;
const BLOCK_TEXT = /验证码|人机验证|安全验证|访问受限|Access Denied|403 Forbidden|请开启 ?JavaScript|滑动验证|captcha/i;
const NEXT_TEXT = /^(下一页|下页|加载更多|更多|next|›|>|»)$/i;

/** Playwright's aria snapshot (YAML) → indented text: headings, links in [brackets], list bullets, buttons marked, tables skipped (returned apart). */
export function flattenAria(yaml: string): string {
  const out: string[] = [];
  let skipDepth = -1;
  for (const raw of yaml.split("\n")) {
    if (/^\s*- \/\w+:/.test(raw)) continue; // element attributes (/url: …) are not content
    const m = /^(\s*)- (\w+)(?: "((?:[^"\\]|\\.)*)")?(?: \[([^\]]*)\])?:?\s*(.*)$/.exec(raw);
    if (!m) { if (raw.trim() && skipDepth < 0) out.push(raw.trim()); continue; }
    const depth = m[1].length / 2, role = m[2], name = (m[3] ?? "").replace(/\\"/g, '"'), attrs = m[4] ?? "", rest = m[5].replace(/^"|"$/g, "");
    if (skipDepth >= 0 && depth > skipDepth) continue;
    skipDepth = -1;
    if (role === "table") { out.push(`${" ".repeat(depth)}[表格]`); skipDepth = depth; continue; }
    if (["navigation", "banner", "contentinfo", "img", "separator", "presentation", "none", "dialog"].includes(role) && !name) { if (role !== "img") continue; }
    const label = name || rest;
    if (!label) continue;
    const pad = " ".repeat(Math.min(depth, 6));
    if (role === "heading") { const lv = /level=(\d)/.exec(attrs)?.[1] ?? "2"; out.push(`${pad}${"#".repeat(Math.min(Number(lv), 4))} ${label}`); }
    else if (role === "link") out.push(`${pad}[${label}]`);
    else if (role === "button") out.push(`${pad}(按钮 ${label})`);
    else if (role === "listitem") out.push(`${pad}• ${label}`);
    else if (["text", "paragraph", "cell", "option", "generic", "article", "main", "region", "group", "list", "strong", "emphasis", "code", "term", "definition", "blockquote", "figure", "time"].includes(role)) out.push(`${pad}${label}`);
    else if (["textbox", "combobox", "checkbox", "radio", "searchbox", "spinbutton", "slider"].includes(role)) { if (name) out.push(`${pad}(${role} ${name})`); } // never the value typed in a field
    else if (["tab", "menuitem"].includes(role)) out.push(`${pad}(${role} ${label})`);
    else if (role === "img") out.push(`${pad}(图 ${label})`);
    else out.push(`${pad}${label}`);
  }
  // collapse runs of blank-ish lines and exact repeats (menus repeat on every page)
  const seen = new Set<string>();
  return out.filter((l) => { const k = l.trim(); if (!k) return false; if (seen.has(k) && k.length > 2) return false; seen.add(k); return true; }).join("\n");
}

/** Keep only the blocks (blank-line or heading separated) that mention one of the words; null = no word given. */
export function findBlocks(text: string, find: string): { text: string; found: boolean } {
  const words = find.split(/[\s,，、/|]+/).filter(Boolean);
  if (!words.length) return { text, found: true };
  const blocks: string[][] = [[]];
  for (const line of text.split("\n")) { if (!line.trim() || /^\s*#/.test(line)) blocks.push([]); blocks[blocks.length - 1].push(line); }
  const hit = blocks.filter((b) => words.some((w) => b.some((l) => l.includes(w))));
  return hit.length ? { text: hit.map((b) => b.join("\n")).join("\n\n"), found: true } : { text, found: false };
}

const absolute = (href: string, base: string) => { try { return new URL(href, base).href; } catch { return ""; } };
const dedupeLinks = (links: PageLink[], base: string): PageLink[] => {
  const host = (() => { try { return new URL(base).host; } catch { return ""; } })();
  const seen = new Set<string>(), out: PageLink[] = [];
  for (const l of links) {
    const href = absolute(l.href, base);
    if (!/^https?:/.test(href) || seen.has(href) || href.split("#")[0] === base.split("#")[0]) continue;
    seen.add(href); out.push({ text: l.text.replace(/\s+/g, " ").trim().slice(0, 80), href });
  }
  const same = out.filter((l) => l.href.includes(host)), other = out.filter((l) => !l.href.includes(host));
  return [...same, ...other].slice(0, MAX_LINKS);
};
const htmlLinks = (html: string, base: string): PageLink[] =>
  dedupeLinks([...html.matchAll(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)].map((m) => ({ href: m[1], text: m[2].replace(/<[^>]+>/g, "") })), base);

/** The HTTP answer is enough when it carries real text; script-rendered shells (an empty #app) and walls go to the browser. */
const thin = (text: string, html: string) => text.replace(/\s+/g, "").length < 1_200 || (/id=["'](app|root)["']/.test(html) && text.replace(/\s+/g, "").length < 3_000);

export async function readPage(s: Services, input: PageReadInput): Promise<PageRead> {
  const url = String(input.url ?? "").trim();
  const onSession = input.mode === "continue" || input.mode === "close";
  if (onSession && !input.sessionId) throw new DomainError("BAD_SESSION", `mode=${input.mode} 需要 sessionId`);
  if (!onSession && !safeUrl(url)) throw new DomainError("BAD_URL", "url 必须是公网的 http(s) 地址");
  const db = s.domain.db, maxChars = Math.max(1_000, Math.min(input.maxChars ?? DEFAULT_CHARS, 60_000));
  const dir = join(s.config.vault, "pages");
  mkdirSync(dir, { recursive: true });

  const finish = (r: Omit<PageRead, "truncated" | "chars" | "found">, store: boolean): PageRead => {
    let text = r.text, found: boolean | null = null;
    if (input.find) ({ text, found } = findBlocks(text, input.find));
    const truncated = text.length > maxChars;
    if (store) {
      const id = ulid(), path = join(dir, `${id}.txt`);
      writeFileSync(path, JSON.stringify({ ...r, text: r.text }), "utf8");
      db.prepare("insert into page_read(id, url, final_url, status, via, chars, text_path, created_at) values (?,?,?,?,?,?,?,?)").run(id, url, r.finalUrl, r.status, r.via, r.text.length, path, now());
    }
    return { ...r, text: truncated ? text.slice(0, maxChars) + "\n…（已截断）" : text, truncated, chars: r.text.length, found };
  };

  if (onSession) return sessionRead(s, input, finish);

  // the same page within half an hour comes from the vault, unless asked to look again (lists change; failures are never cached)
  if (!input.refresh && !input.steps?.length && input.mode !== "open") {
    const c = db.prepare(`select text_path from page_read where url = ? and status = 'ok' and created_at >= datetime('now', '-${CACHE_MINUTES} minutes') order by created_at desc limit 1`).get(url) as { text_path: string } | undefined;
    if (c && existsSync(c.text_path)) { try { return finish({ ...JSON.parse(readFileSync(c.text_path, "utf8")), via: "cache" }, false); } catch { /* unreadable cache: read again */ } }
  }

  // HTTP first: static pages, announcements and 公众号 articles need no browser (steps need one)
  if (!input.browser && !input.steps?.length && input.mode !== "open") {
    try {
      const html = await httpContext().fetchText(url, { headers: { accept: "text/html" }, timeoutMs: 15_000 });
      const a = articleText(html, url);
      if (!thin(a.text, html) && !BLOCK_TEXT.test(a.text.slice(0, 400))) return finish({ url, finalUrl: url, title: a.title, status: "ok", via: "http", text: a.text, links: htmlLinks(html, url), tables: [], next: null }, true);
    } catch { /* the browser gets its turn */ }
  }

  // the browser: the person's own profile, headless unless their window is open; never while a web application runs
  const budget = s.config.pages?.dailyBudget ?? 300; // a safety cap, not a cost: a ten-item research turn alone reads 50–90 pages
  const used = (db.prepare("select count(*) n from page_read where via = 'browser' and created_at >= datetime(date('now', 'localtime'), 'utc')").get() as { n: number }).n;
  if (used >= budget) throw new DomainError("BUDGET", `今天用浏览器读页已达 ${budget} 页（config.pages.dailyBudget）`);
  if (currentRun()) return finish({ url, finalUrl: url, title: "", status: "busy", via: "browser", text: "", links: [], tables: [], next: null }, false);
  // a site that hangs (国家管网's root took >3 minutes to fail, 2026-10-02) must not hold a slot or the caller: one hard cap per read
  return perOrigin(new URL(url).origin, () => Promise.race([
    browserRead(s, url, input, finish),
    new Promise<PageRead>((r) => setTimeout(() => r(finish({ url, finalUrl: url, title: "", status: "blocked", via: "browser", text: "（页面在 60 秒内没有打开）", links: [], tables: [], next: null }, true)), READ_HARD_MS).unref()),
  ]));
}

type Finish = (r: Omit<PageRead, "truncated" | "chars" | "found">, store: boolean) => PageRead;

/** A tab kept open between calls (mode open / continue / close): the next steps run where the last ones left off. */
interface Session { id: string; page: import("playwright-core").Page; done: () => Promise<void>; origin: string; actions: number; createdAt: number; lastUsed: number; chain: Promise<unknown> }
const SESSION = { idleMs: 10 * 60_000, absoluteMs: 30 * 60_000, maxOpen: 3, maxActions: 40 };
const sessions = new Map<string, Session>();
const sessionInfo = (x: Session, state: "ready" | "expired" | "closed") => ({ id: x.id, state, actionsUsed: x.actions, expiresAt: new Date(Math.min(x.lastUsed + SESSION.idleMs, x.createdAt + SESSION.absoluteMs)).toISOString() });
const expired = (x: Session) => Date.now() - x.lastUsed > SESSION.idleMs || Date.now() - x.createdAt > SESSION.absoluteMs || x.actions >= SESSION.maxActions;
async function closeSession(x: Session) { sessions.delete(x.id); await x.chain.catch(() => {}); await x.done().catch(() => {}); }
setInterval(() => { for (const x of sessions.values()) if (expired(x)) void closeSession(x); }, 60_000).unref();

async function sessionRead(s: Services, input: PageReadInput, finish: Finish): Promise<PageRead> {
  const blank = (status: PageRead["status"], session?: PageRead["session"]) => finish({ url: input.url ?? "", finalUrl: "", title: "", status, via: "browser", text: "", links: [], tables: [], next: null, session }, false);
  const x = sessions.get(String(input.sessionId ?? ""));
  if (input.mode === "close") { if (x) await closeSession(x); return blank("closed", x ? sessionInfo(x, "closed") : undefined); }
  if (!x || expired(x)) { if (x) await closeSession(x); return blank("expired", x ? sessionInfo(x, "expired") : undefined); }
  // one action at a time per tab, and the site's own pacing
  const run = x.chain.then(() => perOrigin(x.origin, async () => {
    x.actions += (input.steps?.length ?? 0) || 1;
    x.lastUsed = Date.now();
    const r = await extract(s, x.page, x.page.url(), input, finish, x.page);
    if (r.pageOut !== x.page) { await x.page.close().catch(() => {}); x.page = r.pageOut; } // a step opened a new tab: the session follows it
    return { ...r.result, session: sessionInfo(x, expired(x) ? "expired" : "ready") };
  }));
  x.chain = run.catch(() => {});
  const out = await run;
  if (expired(x)) void closeSession(x);
  return out;
}

async function browserRead(s: Services, url: string, input: PageReadInput, finish: Finish): Promise<PageRead> {
  const origin = new URL(url).origin, since = Date.now() - (lastByOrigin.get(origin) ?? 0);
  if (since < ORIGIN_INTERVAL_MS) await new Promise((r) => setTimeout(r, ORIGIN_INTERVAL_MS - since)); // one site is never hammered
  lastByOrigin.set(origin, Date.now());
  if (input.mode === "open" && [...sessions.values()].filter((x) => !expired(x)).length >= SESSION.maxOpen) throw new DomainError("SESSIONS", `同时最多 ${SESSION.maxOpen} 个读页会话：先 close 一个`);
  const opened = await readerPage(s.config.vault);
  let page = opened.page;
  const done = async () => { if (page !== opened.page) await page.close().catch(() => {}); await opened.done(); };
  let keep = false;
  try {
    // a page that keeps polling never reaches "networkidle": wait for the DOM, then until the visible text stops growing
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20_000 }).catch(() => {});
    await page.waitForLoadState("networkidle", { timeout: input.wait === "idle" ? 4_000 : 1_500 }).catch(() => {});
    let last = -1;
    for (let waited = 0; waited < SETTLE_MAX_MS; waited += 400) {
      await page.waitForTimeout(400);
      const n = ((await page.evaluate(() => document.body?.innerText.length ?? 0).catch(() => 0)) as number);
      if (n === last && n > 0) break;
      last = n;
    }
    const r = await extract(s, page, url, input, finish, opened.page);
    page = r.pageOut;
    if (input.mode === "open" && r.result.status !== "blocked") {
      keep = true;
      const x: Session = { id: ulid(), page, done, origin, actions: (input.steps?.length ?? 0) + 1, createdAt: Date.now(), lastUsed: Date.now(), chain: Promise.resolve() };
      sessions.set(x.id, x);
      return { ...r.result, session: sessionInfo(x, "ready") };
    }
    return r.result;
  } finally {
    if (!keep) await done();
  }
}

/** Steps, then the snapshot of whatever tab they ended on. `pageOut` is that tab (a step may have opened a new one). */
async function extract(s: Services, pageIn: import("playwright-core").Page, url: string, input: PageReadInput, finish: Finish, original: import("playwright-core").Page): Promise<{ result: PageRead; pageOut: import("playwright-core").Page }> {
  void s; void original;
  let page = pageIn;
  {
    const stepped = await runSteps(page, input.steps ?? []);
    const steps = stepped.log;
    page = stepped.page; // a step may have opened a new tab: that is the page to read
    const finalUrl = page.url(), title = (await page.title().catch(() => "")) ?? "";
    if (!safeUrl(finalUrl)) return { result: finish({ url, finalUrl, title, status: "blocked", via: "browser", text: "", links: [], tables: [], next: null, steps }, true), pageOut: page };
    const snapshot = async () => {
      const yaml = await page.locator("body").ariaSnapshot({ timeout: 10_000 }).catch(() => "");
      let t = flattenAria(yaml);
      if (t.replace(/\s+/g, "").length < 200) t = ((await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) as string).trim() || t;
      return t;
    };
    let text = await snapshot();
    // a script that draws the list a beat after the text went quiet: one more look before calling the page empty
    // a detail view in a single-page app can show its frame first and its body a beat later: up to three more looks
    // (confidence over speed; a genuinely empty page costs 6 s, a real one is caught at the first look that has text)
    for (let i = 0; i < 3 && text.replace(/\s+/g, "").length < 150; i++) { await page.waitForTimeout(2_000); text = await snapshot(); }
    if (stepped.scrolled.length) { const have = new Set(text.split("\n").map((l) => l.trim())); const more = stepped.scrolled.join("\n").split("\n").filter((l) => !have.has(l.trim())); if (more.length) text += "\n（滚动后新增）\n" + more.join("\n"); }
    // a link drawn as an icon has no text of its own: the row it sits in says what it opens
    const rawLinks = (await page.evaluate(() => [...document.querySelectorAll("a[href]")].map((a) => ({ text: (a as HTMLElement).innerText.trim() || a.getAttribute("title") || a.getAttribute("aria-label") || ((a.parentElement as HTMLElement | null)?.innerText ?? "").trim().slice(0, 80), href: (a as HTMLAnchorElement).href }))).catch(() => [])) as PageLink[];
    let links = dedupeLinks(rawLinks, finalUrl);
    // a splash page (51job branded sites) has no <a> at all: its entrances are script literals (location.href = "about.html")
    if (links.length < 3) {
      const html = await page.content().catch(() => "");
      links = dedupeLinks([...links, ...siteLinks(html, finalUrl).filter((h) => /\.html?$/i.test(h)).map((h) => ({ text: h.split("/").pop() ?? h, href: h }))], finalUrl);
    }
    const tables = (await page.evaluate(([maxT, maxR]) => [...document.querySelectorAll("table")].slice(0, maxT).map((t) => [...t.querySelectorAll("tr")].slice(0, maxR).map((tr) => [...tr.querySelectorAll("th,td")].map((c) => (c as HTMLElement).innerText.replace(/\s+/g, " ").trim()))).filter((rows) => rows.length > 1), [MAX_TABLES, MAX_ROWS]).catch(() => [])) as string[][][];
    const hasPassword = (await page.locator("input[type=password]").count().catch(() => 0)) > 0;
    const len = text.replace(/\s+/g, "").length, short = len < 400, tiny = len < 150; // a menu page of subsidiaries is short but not empty
    // a login box on a home page is not a wall (国家管网's index has one beside public links): a wall is a redirect to a
    // login url, or a page that is nothing but the form
    // a home page that is a login box plus a public menu (首页 校园招聘 社会招聘 …) is not a wall either: the menu is clickable
    const menu = new Set((text.match(/首页|校园招聘|社会招聘|招聘公告|职位|岗位/g) ?? [])).size >= 2;
    const base: PageRead["status"] = (LOGIN_URL.test(finalUrl) && !LOGIN_URL.test(url)) || (hasPassword && tiny && !menu) ? "needsLogin" : BLOCK_TEXT.test(title + "\n" + text.slice(0, 600)) && short && !menu ? "blocked" : tiny && !tables.length && !menu ? "empty" : "ok";
    const status: PageRead["status"] = base === "ok" && steps.some((x) => !x.ok) ? "stepFailed" : base; // the page is still returned, but a failed step is not a success
    const next = links.find((l) => NEXT_TEXT.test(l.text))?.href ?? null;
    return { result: finish({ url, finalUrl, title, status, via: "browser", text, links, tables, next, steps }, true), pageOut: page };
  }
}

/**
 * Steps (ADR-038 附注): the few things a reader must sometimes do before the content shows — open a tab, pick an
 * option, type a search word, go to the next page. Each one names a control by its visible text; nothing that submits,
 * applies, pays or deletes is ever clicked, and the list is replayed from the URL on every call (no session to keep).
 */
export type Step = { click: string; near?: string } | { fill: string; value: string } | { select: string; option: string } | { press: string } | { next: true } | { scroll: number };
const FORBIDDEN = /提交|投递|申请|确认|支付|付款|删除|注销|退出|登录|注册|发送|同意/;
const MAX_STEPS = 8;

async function settle(page: import("playwright-core").Page) {
  await page.waitForLoadState("networkidle", { timeout: 2_500 }).catch(() => {});
  let last = -1;
  for (let waited = 0; waited < 4_000; waited += 400) {
    await page.waitForTimeout(400);
    const n = ((await page.evaluate(() => document.body?.innerText.length ?? 0).catch(() => 0)) as number);
    if (n === last) break;
    last = n;
  }
}

/** The first visible control whose accessible name or text contains `name`; roles first (precise), plain text last. */
async function control(page: import("playwright-core").Page, name: string, roles: ("link" | "button" | "tab" | "menuitem" | "option" | "radio" | "checkbox" | "treeitem")[]) {
  const locs = [...roles.map((r) => page.getByRole(r, { name, exact: false })), page.getByText(name, { exact: true }), page.getByText(name, { exact: false })];
  // the control may still be rendering (a list that fills after the page settled): wait for any of them, then prefer the precise one
  await locs.reduce((a, b) => a.or(b)).first().waitFor({ state: "visible", timeout: 6_000 }).catch(() => {});
  for (const l of locs) { const first = l.first(); if ((await first.count().catch(() => 0)) > 0 && (await first.isVisible().catch(() => false))) return first; }
  return null;
}

export async function runSteps(page: import("playwright-core").Page, steps: Step[]): Promise<{ log: { step: string; ok: boolean; note: string }[]; page: import("playwright-core").Page; scrolled: string[] }> {
  const out: { step: string; ok: boolean; note: string }[] = [];
  const scrolled: string[] = [((await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) as string)];
  const textLen = () => page.evaluate(() => document.body?.innerText.length ?? 0).catch(() => 0) as Promise<number>;
  for (const st of steps.slice(0, MAX_STEPS)) {
    const label = JSON.stringify(st);
    const before = await textLen();
    // a click may open a new tab (查看详情 on a group's site): follow it, the old tab is of no further use
    const popup = page.context().waitForEvent("page", { timeout: 4_000 }).catch(() => null);
    try {
      if ("click" in st) {
        if (FORBIDDEN.test(st.click)) { out.push({ step: label, ok: false, note: "这类按钮读页不点（提交 / 申请 / 登录…）" }); break; }
        let el = await control(page, st.click, ["tab", "link", "button", "menuitem", "option", "radio", "checkbox", "treeitem"]);
        if (st.near) {
          // the one after the anchor text in document order: the 查看详情 that belongs to this company, not the first on the page
          const anchor = page.getByText(st.near, { exact: false }).first();
          const after = anchor.locator(`xpath=following::*[(self::a or self::button or @role='button' or @role='link' or @onclick) and contains(normalize-space(.), "${st.click.replace(/"/g, "")}")][1]`);
          if ((await anchor.count().catch(() => 0)) === 0) { out.push({ step: label, ok: false, note: `页面上没有「${st.near}」` }); break; }
          el = (await after.count().catch(() => 0)) > 0 ? after.first() : anchor.locator(`xpath=following::*[contains(normalize-space(.), "${st.click.replace(/"/g, "")}")][1]`).first();
        }
        if (!el || (await el.count().catch(() => 0)) === 0) { out.push({ step: label, ok: false, note: "页面上没有这个文字的可点元素" }); break; }
        await el.click({ timeout: 5_000 });
        const np = await popup;
        if (np) { await np.waitForLoadState("domcontentloaded", { timeout: 15_000 }).catch(() => {}); page = np; }
      } else if ("fill" in st) {
        const box = [page.getByPlaceholder(st.fill, { exact: false }), page.getByLabel(st.fill, { exact: false }), page.getByRole("textbox", { name: st.fill, exact: false }), page.getByRole("searchbox", { name: st.fill, exact: false }), page.getByRole("combobox", { name: st.fill, exact: false })];
        let hit = null;
        for (const b of box) { const f = b.first(); if ((await f.count().catch(() => 0)) > 0 && (await f.isVisible().catch(() => false))) { hit = f; break; } }
        if (!hit) { out.push({ step: label, ok: false, note: "没有这个标签 / 占位文字的输入框" }); break; }
        await hit.fill(st.value, { timeout: 5_000 });
      } else if ("select" in st) {
        const sel = page.getByLabel(st.select, { exact: false }).first();
        if ((await sel.count().catch(() => 0)) === 0) { out.push({ step: label, ok: false, note: "没有这个标签的下拉框" }); break; }
        await sel.selectOption({ label: st.option }, { timeout: 5_000 });
      } else if ("press" in st) {
        if (!/^(Enter|Tab|Escape|Space)$/.test(st.press)) { out.push({ step: label, ok: false, note: "只支持 Enter / Tab / Escape / Space" }); break; }
        await page.keyboard.press(st.press);
      } else if ("next" in st) {
        const el = await control(page, "下一页", ["button", "link"]) ?? page.locator("[aria-label*=下一页], [title*=下一页], .btn-next, .ant-pagination-next, .el-pagination__next, li.next a, a.next").first();
        if ((await el.count().catch(() => 0)) === 0 || (await el.isDisabled().catch(() => false))) { out.push({ step: label, ok: false, note: "没有下一页" }); break; }
        await el.click({ timeout: 5_000 });
      } else if ("scroll" in st) {
        // the window and the page's own scrollable panes (a virtualised table draws rows only as they come into view):
        // each screen's new lines are kept, so the final text holds what a person would have seen scrolling through
        for (let i = 0; i < Math.min(5, Number(st.scroll) || 1); i++) {
          await page.evaluate(() => {
            const panes = [...document.querySelectorAll<HTMLElement>("*")].filter((e) => /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.scrollHeight > e.clientHeight + 40).sort((a, b) => b.scrollHeight - a.scrollHeight).slice(0, 3);
            for (const e of panes) e.scrollTop += e.clientHeight * 0.9;
            window.scrollBy(0, window.innerHeight * 0.9);
          }).catch(() => {});
          await page.waitForTimeout(700);
          const seen = new Set(scrolled.flatMap((t) => t.split("\n")));
          const now = ((await page.evaluate(() => document.body?.innerText ?? "").catch(() => "")) as string).split("\n").map((l) => l.trim()).filter((l) => l && !seen.has(l));
          if (now.length) scrolled.push(now.join("\n"));
        }
      }
      // a click that fetches (a unit's list, a search) shows nothing for a moment: wait for the page to change, then to calm down
      if (!("fill" in st)) for (let w = 0; w < 6_000 && (await textLen()) === before; w += 300) await page.waitForTimeout(300);
      await settle(page);
      out.push({ step: label, ok: true, note: (await textLen()) === before ? "页面没有变化" : "" });
    } catch (e: any) {
      out.push({ step: label, ok: false, note: String(e?.message ?? e).split("\n")[0].slice(0, 120) });
      break;
    }
  }
  return { log: out, page, scrolled: scrolled.slice(1) };
}
