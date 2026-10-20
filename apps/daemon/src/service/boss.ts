import { ulid } from "ulid";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import { ingest, type Listing } from "../data/index.js";

/**
 * BOSS 直聘: a visit budget and a circuit breaker for the person's own agent, which searches BOSS in the person's own,
 * logged-in, visible browser (D-26, D-27). Zhiro never opens BOSS itself. What Zhiro can hold the agent to is the order
 * and pace of its calls: every page needs a one-time permit (`permit`), handed back with what was read (`consume`).
 * Whether the agent really waited, and in which browser, Zhiro cannot see; the skill asks for it.
 *
 * Pages are read by an allow-list: from a job page only the post itself (title, pay, place, days, months, degree,
 * description, the company's registered name, work address) is kept. Nothing else of the page is stored or handed back,
 * the person's own block (masked phone, 竞争力分析) included.
 */

export type BossKind = "home" | "search" | "detail";
/** A cap of null is no cap. */
export interface BossLimits { sessionsPerDay: number | null; perSession: Record<BossKind, number | null>; rampDays: number }
export type BossConfig = { sessionsPerDay?: number | null; perSession?: Partial<Record<BossKind, number | null>>; rampDays?: number };
/**
 * No caps by default (the person's call, 2026-10-20): what guards the account is a person's pace and stopping at the
 * first check BOSS shows. Caps can still be set in jobos.yaml (boss); with caps, rampDays halves them after a start
 * or a stop.
 */
export const DEFAULT_LIMITS: BossLimits = { sessionsPerDay: null, perSession: { home: null, search: null, detail: null }, rampDays: 0 };
/** Used up: a cap is set and reached. */
export const full = (used: number, cap: number | null) => cap !== null && used >= cap;
/** What is left under a cap; null when there is no cap. */
export const leftUnder = (cap: number | null, used: number) => (cap === null ? null : cap - used);

const SESSION_IDLE_MS = 30 * 60_000;
const PERMIT_TTL_MS = 5 * 60_000;
const STOP_MS = 24 * 3600_000;
const localDay = (t: number) => new Date(t).toLocaleDateString("en-CA"); // the person's calendar day, on this machine

export class BossError extends Error { constructor(public code: string, message: string, public extra: Record<string, unknown> = {}) { super(message); } }

/** A BOSS page in one canonical spelling, and what kind it is; anything else is refused. */
export function canonical(raw: string): { kind: BossKind; target: string; jobId?: string } {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new BossError("NOT_BOSS", `不是一个网址：${raw}`); }
  const host = u.hostname.toLowerCase();
  if (u.protocol !== "https:" || !(host === "zhipin.com" || host.endsWith(".zhipin.com"))) throw new BossError("NOT_BOSS", `不是 BOSS 直聘（https://www.zhipin.com）的页面：${raw}`);
  const p = u.pathname;
  const job = /^\/job_detail\/([A-Za-z0-9_~-]+)\.html$/.exec(p);
  if (job) return { kind: "detail", target: `https://www.zhipin.com/job_detail/${job[1]}.html`, jobId: job[1] };
  if (/^\/web\/geek\/jobs?\/?$/.test(p)) {
    const q = new URLSearchParams();
    for (const k of ["query", "city", "page"]) { const v = u.searchParams.get(k); if (v) q.set(k, v); }
    return { kind: "search", target: `https://www.zhipin.com/web/geek/jobs?${q.toString()}` };
  }
  if (p === "/" || /^\/[a-z]+\/?$/.test(p)) return { kind: "home", target: `https://www.zhipin.com${p === "/" ? "/" : `/${p.replace(/\//g, "")}/`}` };
  throw new BossError("NOT_BOSS", `只认城市首页、搜索页和岗位详情页：${raw}`);
}

/** Page-level signs that BOSS stopped the visit: a redirect to a check or a login, a check at the top, an empty page. Not words in a job description. */
export function riskOf(text: string, finalUrl?: string): string | null {
  if (finalUrl) {
    try { const u = new URL(finalUrl); if (/\/web\/user\/safe|verify|captcha|\/web\/passport|login/i.test(u.pathname)) return `页面跳到了验证或登录页（${u.pathname}）`; } catch { /* the url itself was checked by canonical */ }
  }
  const t = text.trim();
  if (t.length < 40) return "页面是空的或没加载出来";
  const head = t.slice(0, 400);
  const m = /安全验证|环境存在异常|请完成验证|滑动验证|拖动滑块|访问受限|异常访问|code\s*37/i.exec(head);
  return m ? `页面顶部出现「${m[0]}」` : null;
}

const lines = (text: string) => text.replace(/\d{3}\*{4}\d{4}/g, "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
const SALARY = /(\d+(?:\.\d+)?-\d+(?:\.\d+)?\s*(?:K|k|元\/天|元\/月|元\/时)(?:·\d+薪)?)\s*$/;
const ACTIVE = /(刚刚|今日|昨日|\d+日内|本周|本月|近半年|半年前)活跃|^在线$/;
const SECTION_END = ["竞争力分析", "BOSS 安全提示", "公司介绍", "工商信息", "看过该职位的人还看了"];

export interface BossPost { title: string; salary: string; city: string; daysPerWeek: string; months: string; degree: string; experience: string; brand: string; company: string; address: string; jd: string; intern: boolean }

/** A job page's text → the post, or what could not be found. Exported for tests. */
export function parseDetail(text: string): { post: BossPost; missing: string[] } {
  const ls = lines(text);
  let i = ls.slice(0, 60).findIndex((l) => SALARY.test(l) && l.replace(SALARY, "").trim().length > 1);
  const header = i >= 0 ? ls[i] : "";
  const salary = SALARY.exec(header)?.[1]?.replace(/\s+/g, "") ?? "";
  const title = header.replace(SALARY, "").trim();
  const meta = i >= 0 ? (ls[i + 1] ?? "").split(/\s+/) : [];
  const pick = (re: RegExp) => meta.find((x) => re.test(x)) ?? "";
  const after = (label: string) => { const k = ls.indexOf(label); return k >= 0 ? ls[k + 1] ?? "" : ""; };
  let jd = "";
  const d = ls.indexOf("职位描述");
  if (d >= 0) {
    let end = ls.length;
    for (const s of SECTION_END) { const k = ls.indexOf(s, d + 1); if (k > d && k < end) end = k; }
    // the recruiter's card sits between the description and 竞争力分析: name, activity, company, ·, role
    const block = ls.slice(d + 1, end);
    const act = block.findIndex((l) => ACTIVE.test(l));
    const dot = block.indexOf("·");
    const cut = Math.min(act >= 0 ? act - 1 : block.length, dot >= 2 ? dot - 2 : block.length);
    jd = block.slice(0, Math.max(0, cut)).join("\n").trim();
  }
  const post: BossPost = {
    title, salary, city: meta[0] && !/天\/周|月|硕士|本科|博士|大专|经验|年/.test(meta[0]) ? meta[0] : "",
    daysPerWeek: pick(/^\d天\/周$/), months: pick(/^\d+个?月$/), degree: pick(/^(博士|硕士|本科|大专|学历不限)$/), experience: pick(/年|经验不限|在校\/应届/),
    brand: after("公司基本信息"), company: after("公司名称"), address: after("工作地址"), jd,
    intern: /元\/天/.test(salary) || !!pick(/^\d天\/周$/) || /实习|intern/i.test(title),
  };
  const missing = [!post.title && "岗位名", !(post.company || post.brand) && "公司", post.jd.length < 30 && "职位描述"].filter(Boolean) as string[];
  return { post, missing };
}

/** A search page's text → its posts, for the person to pick from (nothing is filed from a list). Exported for tests. */
export function parseSearch(text: string): { title: string; company: string; place: string; tags: string[] }[] {
  const ls = lines(text);
  const pay = (l: string) => /^-?[\d.]*-?[\d.]*\s*(K|k|元\/天|元\/月)(·.*薪)?$/.test(l) || /^-(K|元\/天)/.test(l);
  const stop = ls.findIndex((l) => /完善信息提醒|热门职位|热门城市/.test(l));
  const body = stop > 0 ? ls.slice(0, stop) : ls;
  const starts = body.map((l, k) => (k + 1 < body.length && pay(body[k + 1]) && !pay(l) ? k : -1)).filter((k) => k >= 0);
  return starts.map((s, n) => {
    const rest = body.slice(s + 2, n + 1 < starts.length ? starts[n + 1] : body.length);
    return { title: body[s], company: rest.length >= 2 ? rest[rest.length - 2] : "", place: rest[rest.length - 1] ?? "", tags: rest.slice(0, Math.max(0, rest.length - 2)) };
  });
}

/** The post as a listing: a reprint (聚合), the site's own job id, the registered company name over the brand. */
export function toListing(p: BossPost, c: { target: string; jobId: string }): Listing {
  const head = [p.salary, p.daysPerWeek, p.months, p.degree, p.experience].filter(Boolean).join(" · ");
  return {
    externalId: `boss:${c.jobId}`, url: c.target, noticeUrl: c.target, title: p.title, company: p.company || p.brand,
    locations: p.city ? [p.city] : [], description: [head, p.address ? `工作地址：${p.address}` : "", p.jd].filter(Boolean).join("\n\n"),
    degreeReq: p.degree || undefined, deadlineText: "BOSS 在招，未写截止", kind: p.intern ? "实习" : undefined, batch: p.intern ? "实习" : "BOSS",
    publisher: "boss", grade: "聚合", isOriginal: false, confidence: 0.7,
  };
}

// ---------- the budget: one-time permits ----------

interface Row { id: string; session_id: string; requested_at: string; not_before: string; expires_at: string; consumed_at: string | null; target: string; kind: string; outcome: string; detail: string }
const ms = (s: string) => Date.parse(s);
const iso = (t: number) => new Date(t).toISOString();
const between = (rnd: () => number, a: number, b: number) => Math.round(a + rnd() * (b - a));

/** Seconds a person might take before the next page, by what they did last; now and then a longer look elsewhere. */
export function pause(prev: BossKind | null, next: BossKind, rnd: () => number): number {
  const base = !prev ? 0 : prev === "home" ? between(rnd, 4, 10) : prev === "search" && next === "detail" ? between(rnd, 8, 30)
    : prev === "detail" && next === "detail" ? between(rnd, 12, 45) : prev === "search" ? between(rnd, 10, 25) : between(rnd, 6, 20);
  return base + (prev && rnd() < 0.08 ? between(rnd, 40, 120) : 0);
}

export function limitsOf(cfg: BossConfig | undefined): BossLimits {
  return { ...DEFAULT_LIMITS, ...(cfg ?? {}), perSession: { ...DEFAULT_LIMITS.perSession, ...(cfg?.perSession ?? {}) } };
}

/** Who stopped visits, until when; the person can lift it (`resume`). */
export function stopOf(db: Db, now: number): { until: string; reason: string } | null {
  const risk = db.prepare("select requested_at, consumed_at, detail from boss_visit where outcome = 'risk' order by coalesce(consumed_at, requested_at) desc limit 1").get() as Row | undefined;
  if (!risk) return null;
  const at = ms(risk.consumed_at ?? risk.requested_at);
  const lifted = db.prepare("select 1 from boss_visit where kind = 'resume' and requested_at > ? limit 1").get(iso(at));
  return !lifted && now - at < STOP_MS ? { until: iso(at + STOP_MS), reason: risk.detail } : null;
}

/** Half the budget while the first days, or the days since the last stop, are fewer than rampDays. */
function ramped(db: Db, now: number, lim: BossLimits): boolean {
  const first = db.prepare("select min(requested_at) at from boss_visit where kind != 'resume'").get() as { at: string | null };
  const risk = db.prepare("select max(coalesce(consumed_at, requested_at)) at from boss_visit where outcome = 'risk'").get() as { at: string | null };
  const from = Math.max(first.at ? ms(first.at) : now, risk.at ? ms(risk.at) : 0);
  return now - from < lim.rampDays * 86400_000;
}

export function status(db: Db, cfg: BossConfig | undefined, now = Date.now()) {
  const lim = limitsOf(cfg), half = ramped(db, now, lim);
  const cap = (n: number | null) => (n === null ? null : half ? Math.max(1, Math.ceil(n / 2)) : n);
  const day = localDay(now);
  const rows = (db.prepare("select * from boss_visit where kind != 'resume' and requested_at >= ? order by requested_at").all(iso(now - 2 * 86400_000)) as unknown as Row[]).filter((r) => localDay(ms(r.requested_at)) === day);
  const live = (r: Row) => r.consumed_at || ms(r.expires_at) > now; // an unused permit that ran out costs nothing
  const used = { home: 0, search: 0, detail: 0 } as Record<BossKind, number>;
  for (const r of rows) if (live(r)) used[r.kind as BossKind]++;
  const last = db.prepare("select * from boss_visit where kind != 'resume' order by requested_at desc limit 1").get() as Row | undefined;
  const lastAt = last ? Math.max(ms(last.consumed_at ?? last.not_before), ms(last.requested_at)) : 0;
  const session = last && now - lastAt < SESSION_IDLE_MS ? last.session_id : null;
  const inSession = session ? (db.prepare("select * from boss_visit where session_id = ?").all(session) as unknown as Row[]).filter(live) : [];
  const sessions = new Set(rows.filter(live).map((r) => r.session_id)).size;
  return {
    limits: { sessionsPerDay: cap(lim.sessionsPerDay), perSession: { home: cap(lim.perSession.home), search: cap(lim.perSession.search), detail: cap(lim.perSession.detail) } },
    halfWhileNew: half && lim.sessionsPerDay !== null, today: { sessions, ...used }, session, inSession, last, lastAt, stop: stopOf(db, now),
  };
}

/** One permit for one page, if the budget and the order allow; atomic, so two calls at once cannot both pass. */
export function permit(db: Db, cfg: BossConfig | undefined, url: string, now = Date.now(), rnd: () => number = Math.random) {
  const c = canonical(url);
  return tx(db, () => {
    const st = status(db, cfg, now);
    if (st.stop) throw new BossError("STOPPED", `BOSS 访问已暂停到 ${st.stop.until}：${st.stop.reason}。这期间不要再打开 BOSS；用户可以在设置页解除。`, { until: st.stop.until });
    const open = st.inSession.find((r) => !r.consumed_at);
    if (open) throw new BossError("OPEN_PERMIT", "上一张通行证还没交回：先把那一页交给 boss.page，或等它过期", { permitId: open.id, target: open.target, expiresAt: open.expires_at });
    let session = st.session, notBefore = now;
    if (!session) {
      if (full(st.today.sessions, st.limits.sessionsPerDay)) throw new BossError("BUDGET", `今天的 ${st.limits.sessionsPerDay} 次会话已经用完，明天再来`);
      if (c.kind !== "home") throw new BossError("HOME_FIRST", "每次会话先打开城市首页（如 https://www.zhipin.com/wuhan/），再搜");
      session = ulid();
      if (st.lastAt) notBefore = Math.max(now, st.lastAt + between(rnd, 20, 60) * 60_000); // a person comes back after a while
    } else {
      const done = st.inSession.filter((r) => r.consumed_at);
      const n = st.inSession.filter((r) => r.kind === c.kind).length;
      if (full(n, st.limits.perSession[c.kind])) throw new BossError("BUDGET", `这次会话的${c.kind === "home" ? "首页" : c.kind === "search" ? "搜索页" : "详情页"}额度（${st.limits.perSession[c.kind]}）用完了；歇至少半小时再开新会话`);
      if (c.kind === "detail" && !done.some((r) => r.kind === "search")) throw new BossError("SEARCH_FIRST", "先打开搜索页，再从结果里点详情");
      const prev = done[done.length - 1];
      notBefore = Math.max(now, (prev ? ms(prev.consumed_at!) : now) + pause((prev?.kind as BossKind) ?? null, c.kind, rnd) * 1000);
    }
    const id = ulid();
    db.prepare("insert into boss_visit(id, session_id, requested_at, not_before, expires_at, target, kind, outcome) values (?,?,?,?,?,?,?, 'issued')")
      .run(id, session, iso(now), iso(notBefore), iso(notBefore + PERMIT_TTL_MS), c.target, c.kind);
    const after = status(db, cfg, now);
    return { permitId: id, kind: c.kind, target: c.target, notBefore: iso(notBefore), waitSeconds: Math.max(0, Math.ceil((notBefore - now) / 1000)), expiresAt: iso(notBefore + PERMIT_TTL_MS),
      left: { sessionsToday: leftUnder(after.limits.sessionsPerDay, after.today.sessions), thisSession: { search: leftUnder(after.limits.perSession.search, after.inSession.filter((r) => r.kind === "search").length), detail: leftUnder(after.limits.perSession.detail, after.inSession.filter((r) => r.kind === "detail").length) } },
      halfWhileNew: after.halfWhileNew };
  });
}

/** Hand a permit back with the page it opened. A permit is used once; a 预览 (post not complete) may be completed with `fields` within its life. */
export function consume(db: Db, permitId: string, url: string, now = Date.now()): { row: Row; kind: BossKind; target: string; jobId?: string; again: boolean } {
  const r = db.prepare("select * from boss_visit where id = ?").get(permitId) as Row | undefined;
  if (!r) throw new BossError("NO_PERMIT", "没有这张通行证：每打开一页前先调 boss.permit");
  const c = canonical(url);
  if (c.target !== r.target) throw new BossError("WRONG_PAGE", `这张通行证是给 ${r.target} 的，不是 ${c.target}`);
  if (r.consumed_at) {
    if (r.outcome === "preview" && now - ms(r.consumed_at) < 15 * 60_000) return { row: r, kind: c.kind, target: c.target, jobId: c.jobId, again: true };
    throw new BossError("USED", "这张通行证已经用过了");
  }
  if (now < ms(r.not_before) - 1000) throw new BossError("TOO_EARLY", `还没到时间：这一页应在 ${r.not_before} 之后打开`, { notBefore: r.not_before });
  if (now > ms(r.expires_at)) throw new BossError("EXPIRED", "通行证过期了，重新请一张");
  db.prepare("update boss_visit set consumed_at = ?, outcome = 'ok' where id = ?").run(iso(now), r.id);
  return { row: r, kind: c.kind, target: c.target, jobId: c.jobId, again: false };
}

/**
 * The page a permit opened, handed back: a stop if BOSS checked the visit; a search page's posts (with any look-alike
 * already in the pool) for the person to pick from; a job page filed as one post, or a 预览 saying what is missing.
 * `fields` completes a 预览 with what the agent read off the same page — every value must be found in that page's text.
 */
export function handlePage(domain: { db: Db; listPositions: (q: any) => { items: any[] } }, vault: string,
  p: { permitId: string; url: string; text: string; finalUrl?: string; fields?: Record<string, string> }, now = Date.now()) {
  const db = domain.db;
  const u = consume(db, p.permitId, p.url, now);
  const risk = riskOf(p.text, p.finalUrl);
  if (risk) {
    mark(db, u.row.id, "risk", risk);
    return { outcome: "stopped" as const, stoppedUntil: iso(now + STOP_MS), reason: risk, say: "BOSS 拦了这次访问：已暂停 24 小时。停下，不要刷新、不要重试，告诉用户。" };
  }
  if (u.kind === "home") { mark(db, u.row.id, "ok"); return { outcome: "ok" as const }; }
  if (u.kind === "search") {
    const items = parseSearch(p.text).slice(0, 40).map((it) => ({ ...it, maybeInPool: lookAlikes(domain, it.title, it.company) }));
    mark(db, u.row.id, "ok", `${items.length} 条`);
    return { outcome: "ok" as const, items, say: items.length ? "把没在库里的列给用户挑；详情只为挑中的打开" : "没从这页解析出岗位：自己从页面上挑详情链接" };
  }
  const { post, missing: first } = parseDetail(p.text);
  let missing = first;
  if (p.fields) {
    const page = lines(p.text).join("\n");
    for (const [k, v] of Object.entries(p.fields)) {
      if (!(k in post) || k === "intern" || typeof v !== "string" || !v.trim()) continue;
      const probe = k === "jd" ? v.trim().split(/\r?\n/)[0].trim().slice(0, 40) : v.trim();
      if (!page.includes(probe)) throw new BossError("NO_EVIDENCE", `「${k}」的值在这一页的文字里找不到：${probe}`);
      (post as any)[k] = v.trim();
    }
    missing = [!post.title && "岗位名", !(post.company || post.brand) && "公司", post.jd.length < 30 && "职位描述"].filter(Boolean) as string[];
  }
  if (missing.length) {
    mark(db, u.row.id, "preview", missing.join("、"));
    const { jd, ...brief } = post;
    return { outcome: "preview" as const, missing, post: { ...brief, jdChars: jd.length }, say: `没取到：${missing.join("、")}。从这一页读出来，用 fields 带上，同一张通行证 15 分钟内再交一次（不再扣额度）` };
  }
  const listing = toListing(post, { target: u.target, jobId: u.jobId! });
  const r = ingest(domain, vault, "capture", `boss-${u.jobId}`, [listing], { closeUnseen: false });
  mark(db, u.row.id, "filed", listing.externalId);
  return { outcome: "filed" as const, positionId: r.listed.positionIds[0] ?? null, title: post.title, company: listing.company, intern: post.intern, salary: post.salary };
}

/** Posts in the pool that may be this one: the same words in the title at a company whose name shares the brand. Shown, never used to drop. */
function lookAlikes(domain: { listPositions: (q: any) => { items: any[] } }, title: string, brand: string): string[] {
  const words = title.replace(/[（(].*?[)）]/g, " ").trim();
  if (!words || !brand) return [];
  try {
    return domain.listPositions({ query: words, limit: 20 }).items
      .filter((x) => x.companyName.includes(brand) || brand.includes(x.companyName.slice(0, 4)))
      .slice(0, 3).map((x) => `${x.companyName} · ${x.title}`);
  } catch { return []; }
}

export const mark = (db: Db, id: string, outcome: "ok" | "risk" | "preview" | "filed", detail = "") => db.prepare("update boss_visit set outcome = ?, detail = ? where id = ?").run(outcome, detail.slice(0, 200), id);
export const resume = (db: Db, now = Date.now()) => db.prepare("insert into boss_visit(id, session_id, requested_at, not_before, expires_at, target, kind, outcome) values (?, '', ?, ?, ?, '', 'resume', 'cleared')").run(ulid(), iso(now), iso(now), iso(now));
