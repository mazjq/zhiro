import { ulid } from "ulid";
import type { Db } from "../db.js";
import { tx } from "../db.js";
import { ingest } from "../data/index.js";
import { status, stopOf, toListing, full, leftUnder, type BossConfig, type BossKind, type BossPost } from "./boss.js";
import type { Cdp } from "./boss-cdp.js";

/**
 * BOSS v2 (D-28): Zhiro itself opens BOSS pages in the dedicated browser and listens to the job data the page asks
 * for — no page text through a model, no request of Zhiro's own. A search page gives 15 posts a screen as BOSS's own
 * JSON (plain pay, skills, days a week, months); those are kept as candidates, not posts: a candidate becomes a post
 * once its job page is read (description, registered company name, address). The day's and the session's budget
 * (D-27's book, `boss_visit`) and the 24-hour stop after a check by BOSS are held here, not by the agent.
 */

export const CITY: Record<string, string> = {
  武汉: "101200100", 北京: "101010100", 上海: "101020100", 天津: "101030100", 重庆: "101040100", 广州: "101280100", 深圳: "101280600",
  杭州: "101210100", 南京: "101190100", 苏州: "101190400", 成都: "101270100", 西安: "101110100", 长沙: "101250100", 合肥: "101220100",
  郑州: "101180100", 济南: "101120100", 青岛: "101120200", 宁波: "101210400", 厦门: "101230200", 东莞: "101281600",
};
export const cityCode = (c: string) => (/^\d{9}$/.test(c.trim()) ? c.trim() : CITY[c.trim().replace(/市$/, "")] ?? null);

/** What went wrong, told apart: only a check by BOSS stops visits for a day; the rest are said and nothing is stopped. */
export type Failure = "RISK_BLOCKED" | "AUTH_REQUIRED" | "SCHEMA_CHANGED" | "CAPTURE_TIMEOUT" | "NO_RESULTS" | "NETWORK_ERROR";
export class BossFail extends Error { constructor(public code: Failure | "BUDGET" | "STOPPED" | "BROWSER_DOWN" | "BAD_INPUT", message: string) { super(message); } }

/** A joblist.json body → its posts, or why it is not one. Exported for tests. */
export function readJoblist(body: any): { jobs: Candidate[]; hasMore: boolean } | { fail: Failure; message: string } {
  if (!body || typeof body !== "object") return { fail: "SCHEMA_CHANGED", message: "岗位数据不是 JSON" };
  if (body.code !== 0) {
    const msg = String(body.message ?? "");
    if (body.code === 37 || /异常|验证|安全|频繁/.test(msg)) return { fail: "RISK_BLOCKED", message: `BOSS 返回 code ${body.code}：${msg}` };
    if (/登录/.test(msg)) return { fail: "AUTH_REQUIRED", message: `BOSS 要求登录：${msg}` };
    return { fail: "SCHEMA_CHANGED", message: `BOSS 返回 code ${body.code}：${msg}` };
  }
  const list = body.zpData?.jobList;
  if (!Array.isArray(list)) return { fail: "SCHEMA_CHANGED", message: "岗位数据里没有 jobList" };
  return { jobs: list.filter((j: any) => j?.encryptJobId && j?.jobName).map(toCandidate), hasMore: !!body.zpData?.hasMore };
}

export interface Candidate { jobId: string; url: string; title: string; salary: string; city: string; district: string; experience: string; degree: string; days: string; months: string; brand: string; scale: string; stage: string; industry: string; skills: string[]; labels: string[] }
const s = (v: unknown) => (typeof v === "string" ? v.trim() : "");
export const toCandidate = (j: any): Candidate => ({
  jobId: s(j.encryptJobId), url: `https://www.zhipin.com/job_detail/${s(j.encryptJobId)}.html`, title: s(j.jobName), salary: s(j.salaryDesc),
  city: s(j.cityName), district: [s(j.areaDistrict), s(j.businessDistrict)].filter(Boolean).join("·"), experience: s(j.jobExperience), degree: s(j.jobDegree),
  days: s(j.daysPerWeekDesc), months: s(j.leastMonthDesc), brand: s(j.brandName), scale: s(j.brandScaleName), stage: s(j.brandStageName), industry: s(j.brandIndustry),
  skills: Array.isArray(j.skills) ? j.skills.map(s).filter(Boolean) : [], labels: Array.isArray(j.jobLabels) ? j.jobLabels.map(s).filter(Boolean) : [],
});
export const isIntern = (c: { title: string; salary: string; days: string }) => /元\/天/.test(c.salary) || !!c.days || /实习|intern/i.test(c.title);

/** Where the browser ended up: a check, a login, or fine. */
export function pageFail(href: string): { fail: Failure; message: string } | null {
  try {
    const p = new URL(href).pathname;
    if (/verify|safe|captcha|security/i.test(p)) return { fail: "RISK_BLOCKED", message: `页面跳到了验证页（${p}）` };
    if (/passport|login/i.test(p)) return { fail: "AUTH_REQUIRED", message: "专用浏览器掉了登录：在里面重新扫码登录" };
  } catch { /* about:blank and the like */ }
  return null;
}

// ---------- the book (D-27's boss_visit), written by Zhiro now ----------
const iso = (t: number) => new Date(t).toISOString();
function book(db: Db, session: string, kind: BossKind, target: string, outcome: string, detail = "", now = Date.now()) {
  db.prepare("insert into boss_visit(id, session_id, requested_at, not_before, expires_at, consumed_at, target, kind, outcome, detail) values (?,?,?,?,?,?,?,?,?,?)")
    .run(ulid(), session, iso(now), iso(now), iso(now), iso(now), target, kind, outcome, detail.slice(0, 200));
}
/** The session to book under (a new one opens on a city page), or why not now. */
function session(db: Db, cfg: BossConfig | undefined, want: Partial<Record<BossKind, number>>, now: number): { id: string; fresh: boolean } {
  const st = status(db, cfg, now);
  if (st.stop) throw new BossFail("STOPPED", `BOSS 访问已暂停到 ${st.stop.until}：${st.stop.reason}。用户确认 BOSS 正常后可在设置页解除`);
  const id = st.session ?? ulid(), fresh = !st.session;
  if (fresh && full(st.today.sessions, st.limits.sessionsPerDay)) throw new BossFail("BUDGET", `今天的 ${st.limits.sessionsPerDay} 次会话用完了，明天再来`);
  for (const [k, n] of Object.entries(want) as [BossKind, number][]) {
    const used = fresh ? 0 : st.inSession.filter((r) => r.kind === k).length;
    const cap = st.limits.perSession[k];
    if (cap !== null && used + n > cap) throw new BossFail("BUDGET", `这次会话的${k === "search" ? "搜索页" : "详情页"}额度还剩 ${Math.max(0, cap - used)}，不够 ${n}；歇半小时再开新会话，或少要一点`);
  }
  return { id, fresh };
}
function stop(db: Db, sessionId: string, target: string, why: string) { book(db, sessionId, "search", target, "risk", why); }

// ---------- the browser side ----------
export interface Deps { db: Db; cfg?: BossConfig; cdp: Cdp; vault: string; sleep?: (ms: number) => Promise<void>; rnd?: () => number; now?: () => number }
const between = (rnd: () => number, a: number, b: number) => a + rnd() * (b - a);

async function navigate(d: Deps, url: string) {
  d.cdp.events.length = 0; // the watermark: only what this page asks for from here on
  await d.cdp.send("Page.navigate", { url });
}
async function href(d: Deps): Promise<string> { return (await d.cdp.send("Runtime.evaluate", { expression: "location.href", returnByValue: true }))?.result?.value ?? ""; }
/** One turn of the wheel over the list, now and then a little back up, as a person reads down a list. */
async function wheel(d: Deps) {
  const back = d.rnd!() < 0.12;
  await d.cdp.send("Input.dispatchMouseEvent", { type: "mouseWheel", x: Math.round(between(d.rnd!, 300, 900)), y: Math.round(between(d.rnd!, 300, 700)), deltaX: 0, deltaY: back ? -Math.round(between(d.rnd!, 60, 160)) : Math.round(between(d.rnd!, 300, 650)) });
}
/** The next joblist.json this page asked for, for this query, city and page — or null when none came in time. */
async function nextJoblist(d: Deps, q: { query: string; city: string; page: number }, waitMs: number, seen: Set<string>): Promise<any | null> {
  let waited = 0; // ponytail: counts sleeps, not wall time (a fake clock in tests), so the wait runs a little long
  // the page POSTs its search: query / city / page are in the body (seen 2026-10-18), in the url on older builds
  const params = new Map<string, URLSearchParams>();
  while (waited < waitMs) {
    for (const e of d.cdp.events) {
      if (e.method === "Network.requestWillBeSent" && /\/wapi\/zpgeek\/search\/joblist\.json/.test(String(e.params?.request?.url ?? ""))) {
        const r = e.params.request, p = new URLSearchParams(String(r.postData ?? ""));
        for (const [k, v] of new URL(r.url).searchParams) if (!p.has(k)) p.set(k, v);
        params.set(e.params.requestId, p);
      }
      if (e.method !== "Network.responseReceived") continue;
      const u = String(e.params?.response?.url ?? "");
      if (!/\/wapi\/zpgeek\/search\/joblist\.json/.test(u) || seen.has(e.params.requestId)) continue;
      const p = params.get(e.params.requestId) ?? new URL(u).searchParams;
      if (p.get("query") !== q.query || p.get("city") !== q.city || Number(p.get("page") ?? 1) !== q.page) continue;
      seen.add(e.params.requestId);
      for (let k = 0; k < 4; k++) {
        try { const r = await d.cdp.send("Network.getResponseBody", { requestId: e.params.requestId }); return JSON.parse(r.body); } catch { await d.sleep!(400); }
      }
      return { code: -1, message: "读不到响应内容" };
    }
    await d.sleep!(300);
    waited += 300;
  }
  return null;
}

/**
 * Search BOSS for `query` in `city`, up to `pages` screens (15 posts a screen). Candidates are kept (upserted by BOSS's
 * job id) and returned with any look-alike already in the pool; nothing becomes a post here.
 */
export async function search(d: Deps, domain: { listPositions: (q: any) => { items: any[] } }, q: { query: string; city: string; pages?: number }) {
  const sleep = (d.sleep ??= (ms) => new Promise((r) => setTimeout(r, ms)));
  const rnd = (d.rnd ??= Math.random), now = d.now ?? Date.now;
  const city = cityCode(q.city);
  if (!q.query.trim() || !city) throw new BossFail("BAD_INPUT", city ? "要搜的词是空的" : `不认识这个城市：${q.city}（给城市名或 BOSS 的 9 位城市代码）`);
  const pages = Math.max(1, Math.min(5, q.pages ?? 2));
  const ses = session(d.db, d.cfg, { search: pages }, now());
  const target = `https://www.zhipin.com/web/geek/jobs?query=${encodeURIComponent(q.query.trim())}&city=${city}`;
  await d.cdp.send("Network.enable");
  await d.cdp.send("Page.enable");
  if (ses.fresh) { // a session opens on BOSS's home page, as a person comes in
    await navigate(d, "https://www.zhipin.com/");
    await sleep(between(rnd, 3000, 7000));
    book(d.db, ses.id, "home", "https://www.zhipin.com/", "ok", "", now());
  }
  await navigate(d, target);
  const seen = new Set<string>();
  const out: Candidate[] = [];
  let stopped: { code: Failure; message: string } | null = null, got = 0, more = true;
  for (let page = 1; page <= pages && more; page++) {
    let body: any = null;
    if (page === 1) body = await nextJoblist(d, { query: q.query.trim(), city, page }, 20_000, seen);
    else { // read down the list until the page asks for the next screen
      await sleep(between(rnd, 1500, 4000));
      for (let k = 0; k < 14 && !body; k++) { await wheel(d); body = await nextJoblist(d, { query: q.query.trim(), city, page }, Math.round(between(rnd, 700, 1500)), seen); }
      if (!body) body = await nextJoblist(d, { query: q.query.trim(), city, page }, 5000, seen);
    }
    const where = await href(d).catch(() => "");
    const bad = pageFail(where);
    if (bad) { stopped = { code: bad.fail, message: bad.message }; break; }
    if (!body) { stopped = { code: "CAPTURE_TIMEOUT", message: `第 ${page} 屏等不到岗位数据（可能已到底，或页面没加载出来）` }; break; }
    const r = readJoblist(body);
    if ("fail" in r) { stopped = { code: r.fail, message: r.message }; break; }
    book(d.db, ses.id, "search", `${target}&page=${page}`, "ok", `${r.jobs.length} 条`, now());
    got++;
    out.push(...r.jobs);
    more = r.hasMore;
  }
  if (stopped?.code === "RISK_BLOCKED") stop(d.db, ses.id, target, stopped.message);
  const fresh = keep(d.db, out, q.query.trim(), city, now());
  const unique = new Map(out.map((c) => [c.jobId, c]));
  return {
    query: q.query.trim(), city, screens: got, found: unique.size, duplicates: out.length - unique.size, newCandidates: fresh, complete: !stopped && (!more || got === pages),
    stopped: stopped ? { ...stopped, stoppedVisits: stopped.code === "RISK_BLOCKED" } : null, left: leftOf(d.db, d.cfg, now()),
    items: [...unique.values()].map((c) => ({ ref: c.jobId, title: c.title, salary: c.salary, brand: c.brand, place: [c.city, c.district].filter(Boolean).join("·"),
      need: [c.degree, c.experience, c.days, c.months].filter(Boolean).join(" "), intern: isIntern(c), maybeInPool: lookAlikes(domain, c.title, c.brand) })),
  };
}

/** Read up to five candidates' job pages and file each as a post; a page without its description stays a candidate. */
export async function detail(d: Deps, refs: string[]) {
  const sleep = (d.sleep ??= (ms) => new Promise((r) => setTimeout(r, ms)));
  const rnd = (d.rnd ??= Math.random), now = d.now ?? Date.now;
  const ids = [...new Set(refs)].slice(0, 5);
  const rows = ids.map((id) => d.db.prepare("select * from boss_candidate where job_id = ?").get(id) as any).filter(Boolean);
  if (!rows.length) throw new BossFail("BAD_INPUT", "没有这些候选：先用 boss.search 搜到它们");
  const ses = session(d.db, d.cfg, { detail: rows.length }, now());
  await d.cdp.send("Page.enable");
  const results: any[] = [];
  for (const [i, c] of rows.entries()) {
    if (i > 0) await sleep(between(rnd, 5000, 12000));
    await navigate(d, c.url);
    await sleep(between(rnd, 3000, 5000));
    const bad = pageFail(await href(d).catch(() => ""));
    if (bad) { if (bad.fail === "RISK_BLOCKED") stop(d.db, ses.id, c.url, bad.message); results.push({ ref: c.job_id, outcome: bad.fail, message: bad.message }); break; }
    const v = (await d.cdp.send("Runtime.evaluate", { expression: READ_DETAIL, returnByValue: true }))?.result?.value ?? {};
    book(d.db, ses.id, "detail", c.url, "ok", "", now());
    const post = postOf(c, v);
    if (post.jd.length < 30) { results.push({ ref: c.job_id, outcome: "NO_DESCRIPTION", message: "这一页没读到职位描述（可能已下架或页面改版）" }); continue; }
    const r = ingest(d, d.vault, "capture", `boss-${c.job_id}`, [toListing(post, { target: c.url, jobId: c.job_id })], { closeUnseen: false });
    const positionId = r.listed.positionIds[0] ?? null;
    d.db.prepare("update boss_candidate set position_id = ?, detail_at = ? where job_id = ?").run(positionId, iso(now()), c.job_id);
    results.push({ ref: c.job_id, outcome: "filed", positionId, title: post.title, company: post.company || post.brand });
  }
  return { results, left: leftOf(d.db, d.cfg, now()) };
}

/** The job page, read in the page: only the post. Exported for tests. */
export const READ_DETAIL = `(() => { const q = (s) => document.querySelector(s)?.innerText?.trim() ?? "";
  const biz = {}; for (const li of document.querySelectorAll('.level-list li, .business-info li')) { const [k, ...v] = li.innerText.split('\\n'); if (k && v.length) biz[k.trim()] = v.join(' ').trim(); }
  return { title: q('.job-banner .name h1') || q('.name h1'), salary: q('.job-banner .salary'), jd: q('.job-sec-text'), address: q('.location-address'), company: biz['公司名称'] ?? '' }; })()`;

export function postOf(c: any, v: { title?: string; salary?: string; jd?: string; address?: string; company?: string }): BossPost {
  const salary = v.salary || c.salary || "";
  const post: BossPost = { title: v.title || c.title, salary, city: c.city, daysPerWeek: c.days, months: c.months, degree: c.degree, experience: c.experience,
    brand: c.brand, company: v.company || "", address: v.address || "", jd: (v.jd || "").trim(), intern: false };
  post.intern = isIntern({ title: post.title, salary, days: c.days });
  return post;
}

function keep(db: Db, cs: Candidate[], query: string, city: string, now: number): number {
  let fresh = 0;
  tx(db, () => {
    const has = db.prepare("select 1 from boss_candidate where job_id = ?");
    const up = db.prepare(`insert into boss_candidate(job_id, url, title, salary, city, district, experience, degree, days, months, brand, scale, stage, industry, skills, labels, query, city_code, first_seen, last_seen)
      values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) on conflict(job_id) do update set title = excluded.title, salary = excluded.salary, last_seen = excluded.last_seen`);
    for (const c of cs) {
      if (!has.get(c.jobId)) fresh++;
      up.run(c.jobId, c.url, c.title, c.salary, c.city, c.district, c.experience, c.degree, c.days, c.months, c.brand, c.scale, c.stage, c.industry, JSON.stringify(c.skills), JSON.stringify(c.labels), query, city, iso(now), iso(now));
    }
  });
  return fresh;
}

/** Candidates not yet read in full, newest first (seen in the last 14 days). */
export function candidates(db: Db, q: { internOnly?: boolean; query?: string; limit?: number } = {}, now = Date.now()) {
  const rows = db.prepare("select * from boss_candidate where position_id is null and last_seen >= ? order by last_seen desc limit 500").all(iso(now - 14 * 86400_000)) as any[];
  const words = (q.query ?? "").trim().split(/\s+/).filter(Boolean);
  return rows.filter((r) => (!q.internOnly || isIntern({ title: r.title, salary: r.salary, days: r.days })) && words.every((w) => `${r.title} ${r.brand}`.includes(w)))
    .slice(0, q.limit ?? 100)
    .map((r) => ({ ref: r.job_id, title: r.title, salary: r.salary, brand: r.brand, place: [r.city, r.district].filter(Boolean).join("·"), need: [r.degree, r.experience, r.days, r.months].filter(Boolean).join(" "),
      skills: JSON.parse(r.skills || "[]"), seen: r.last_seen, intern: isIntern({ title: r.title, salary: r.salary, days: r.days }) }));
}

function leftOf(db: Db, cfg: BossConfig | undefined, now: number) {
  const st = status(db, cfg, now);
  const inS = (k: BossKind) => st.inSession.filter((r) => r.kind === k).length;
  return { sessionsToday: leftUnder(st.limits.sessionsPerDay, st.today.sessions), thisSession: { search: leftUnder(st.limits.perSession.search, inS("search")), detail: leftUnder(st.limits.perSession.detail, inS("detail")) }, stopped: stopOf(db, now) };
}

function lookAlikes(domain: { listPositions: (q: any) => { items: any[] } }, title: string, brand: string): string[] {
  const words = title.replace(/[（(].*?[)）]/g, " ").trim();
  if (!words || !brand) return [];
  try {
    return domain.listPositions({ query: words, limit: 20 }).items.filter((x) => x.companyName.includes(brand) || brand.includes(x.companyName.slice(0, 4))).slice(0, 3).map((x) => `${x.companyName} · ${x.title}`);
  } catch { return []; }
}
