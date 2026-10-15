import { dataOf, type Services } from "../registry.js";
import { NotFound } from "./domain.js";
import { sourceFor, siteKeyOf } from "../data/index.js";
import { addSource, runSource, saveSources, reasonOf, SYNC_REASONS } from "../data/index.js";
import { listFacts } from "./profile.js";
import { terms } from "../recommenders/common.js";
import { majorStems } from "../recommenders/profile-match.js";
import { expandable } from "../recommenders/expand.js";

/**
 * 国聘全站发现 (ADR-034): one subscription whose keywords follow the profile — the direction words and the core of each
 * major (控制科学与工程 → 控制, 自动化). Created, updated or left alone here; pulled at once when it changes.
 */
const DISCOVER_ID = "iguopin-discover";
export function discoveryKeywords(s: Services): string[] {
  const facts = listFacts(s.domain.db).items as any[];
  const dirs = terms(facts.filter((f) => f.kind === "direction").map((f) => f.data.keyword)).filter((k) => k.length >= 2);
  const majors = facts.filter((f) => f.kind === "education").map((f) => majorStems(f.data.major ?? "").sort((a, b) => a.length - b.length)[0]).filter(Boolean);
  return [...new Set([...dirs, ...majors])].slice(0, 8);
}
export function ensureDiscovery(s: Services): void {
  const keywords = discoveryKeywords(s);
  const cur = s.config.sources.find((c) => c.id === DISCOVER_ID);
  if (!keywords.length || (cur && JSON.stringify(cur.keywords) === JSON.stringify(keywords))) return;
  const entry = { id: DISCOVER_ID, source: "iguopin", name: "国聘全站发现", url: "https://www.iguopin.com/", discover: true, keywords, cohort: "2027届", batch: "校招", everyHours: 24, enabled: true, auto: true };
  saveSources(dataOf(s), cur ? s.config.sources.map((c) => (c.id === DISCOVER_ID ? { ...c, keywords } : c)) : [...s.config.sources, entry]);
  void runSource(dataOf(s), DISCOVER_ID, { quiet: true }).catch(() => {});
}

/**
 * An aggregator sheet knows a company is hiring and links its career site, but lists jobs as loose categories
 * ("技术类造型设计类职能支持类"). When that link is a system we can read directly (Moka, 北森), the real job list is one
 * scan away — so for companies the user actually cares about we register the link as a pull source and scan it.
 * Deliberately not done for the whole sheet: that would be ~1,400 daily scans of sites nobody asked about.
 */
export function officialLinks(s: Services, companyId: string): { url: string; source: string; configured: boolean }[] {
  const rows = s.domain.db.prepare("select distinct apply_url, notice_url from campaign where company_id = ?").all(companyId) as any[];
  const urls = [...new Set(rows.flatMap((r) => [r.apply_url, r.notice_url]).filter(Boolean))] as string[];
  const out: { url: string; source: string; configured: boolean }[] = [];
  for (const url of urls) {
    const src = sourceFor(url);
    if (!src?.fetch || out.some((o) => o.source === src.id && sameSite(o.url, url))) continue;
    out.push({ url, source: src.id, configured: s.config.sources.some((c) => c.source === src.id && c.url && sameSite(c.url, url)) });
  }
  return out;
}

const sameSite = (a: string, b: string) => siteKeyOf(a) === siteKeyOf(b);

export interface SyncResult { url: string; source: string; ok: boolean; received: number; positionsNew: number; error: string; reason: string }
/**
 * Read a company's career sites now. The answer always says what happened: every source read (ok), some of them
 * (partial — never reported as success), none (failed, with the reason), or nothing to read (none: no link, or a system
 * no reader knows). A site that answers with no posts at all is a failure, and closes nothing.
 */
export async function syncOfficial(s: Services, companyId: string, opts: { quiet?: boolean } = {}) {
  const co = s.domain.db.prepare("select name from company where id = ?").get(companyId) as { name: string } | undefined;
  if (!co) throw new NotFound(`company ${companyId}`);
  const links = officialLinks(s, companyId);
  const results: SyncResult[] = [];
  if (!links.length) {
    const urls = (s.domain.db.prepare("select apply_url u from campaign where company_id = ? and apply_url != '' union select notice_url from campaign where company_id = ? and notice_url != ''").all(companyId, companyId) as { u: string }[])
      .map((r) => r.u).filter((u) => /^https?:/.test(u) && !/mp\.weixin\.qq\.com|docs\.qq\.com|feishu\.cn\/(base|sheets|wiki)/.test(u));
    const reason = urls.length ? "UNSUPPORTED_PLATFORM" : "NO_OFFICIAL_LINK";
    return { companyName: co.name, links: 0, status: "none" as const, reason, results, unsupported: urls.slice(0, 5),
      message: SYNC_REASONS[reason] + (urls.length ? `：${urls.slice(0, 3).join("、")}。可以用 page.read 读页面，再用 listing.capture / deadline.report 记下来` : "。找到校招官网后用 listing.capture 接入") };
  }
  for (const l of links) {
    let cfg = s.config.sources.find((c) => c.source === l.source && c.url && sameSite(c.url, l.url));
    if (!cfg) { const added = addSource(dataOf(s), { url: l.url, name: co.name, cohort: "2027届", batch: "校招", auto: true }); cfg = s.config.sources.find((c) => c.id === added.id)!; }
    const r = await runSource(dataOf(s), cfg.id, opts);
    results.push(r.ok ? { url: l.url, source: l.source, ok: true, received: r.result.received, positionsNew: r.result.positionsNew, error: "", reason: "" } : { url: l.url, source: l.source, ok: false, received: 0, positionsNew: 0, error: r.error, reason: reasonOf(r.error) });
  }
  const good = results.filter((r) => r.ok), bad = results.filter((r) => !r.ok);
  const status = !bad.length ? ("ok" as const) : good.length ? ("partial" as const) : ("failed" as const);
  const read = good.length ? `读到 ${good.reduce((n, r) => n + r.received, 0)} 个岗位（新增 ${good.reduce((n, r) => n + r.positionsNew, 0)}）` : "";
  const failed = bad.map((r) => `${r.source}：${SYNC_REASONS[r.reason]}`).join("；");
  return { companyName: co.name, links: links.length, status, reason: bad[0]?.reason ?? "", results, unsupported: [] as string[],
    message: status === "ok" ? `官网已同步：${read}` : status === "partial" ? `只同步了一部分：${read}；没读成的：${failed}` : `官网没读成：${failed}` };
}

let batch: Promise<void> | null = null;
/**
 * Keep the official job lists of every company the user cares about in step, without anyone clicking: whenever the
 * recommendations change, companies that are tagged / watched / applied-to and whose apply link is a readable system
 * get registered and scanned — one site at a time, a few seconds apart, no model involved. After that the normal
 * daily source_scan keeps each one fresh. Deliberately limited to companies the user cares about: the sheet links
 * ~1,400 such sites and scanning all of them daily would serve nobody.
 */
export function syncRelevantOfficial(s: Services): Promise<void> {
  return (batch ??= (async () => {
    try {
      try { ensureDiscovery(s); } catch { /* no profile yet */ }
      const ids = caredCompanies(s);
      const todo = ids.filter((id) => officialLinks(s, id).some((l) => !l.configured));
      if (!todo.length) return;
      console.log(`[official] syncing ${todo.length} companies' career sites`);
      let done = 0;
      for (const id of todo) {
        await syncOfficial(s, id, { quiet: true }).catch(() => {}); // a failing site is recorded in scan_run and retried by its daily scan
        if (++done % 25 === 0) s.onDataChanged?.();               // let matching catch up while the batch is still running
        await new Promise((r) => setTimeout(r, 3000));
      }
      s.onDataChanged?.();
    } finally { batch = null; }
  })());
}

/** Fire-and-forget after the user shows real interest (待投 / 我点名的): failures only show up in 更新情况. */
export function syncOfficialInBackground(s: Services, companyId: string): void {
  if (officialLinks(s, companyId).some((l) => !l.configured)) void syncOfficial(s, companyId).catch(() => {});
}

/**
 * Companies whose official job list is worth keeping in step: watched, applied to, tagged by hand, and — since the user
 * asked for it on 2026-09-29 — everything on their direction (画像匹配, which 待展开 is a subset of). Search presets
 * (a city, a keyword) are not a direction and stay out.
 */
export function caredCompanies(s: Services): string[] {
  return (s.domain.db.prepare(`select distinct c.company_id as id from campaign c where
    exists (select 1 from recommendation r where r.company_id = c.company_id and r.mode in ('manual', 'profile_match', 'expand'))
    or exists (select 1 from position p where p.campaign_id = c.id and p.watch_priority > 0)
    or exists (select 1 from application a where a.campaign_id = c.id and a.state != 'cancelled')`).all() as { id: string }[]).map((r) => r.id);
}

/**
 * Startup housekeeping of auto-added subscriptions (the user's own are never touched): one per site, and only for
 * companies still cared about — or that would be the moment their subscription went: a company 待展开 stops naming
 * because its site has been read is one whose subscription is doing its work, not one nobody cares about. What a
 * removed subscription alone had brought in is cleared by the tidy that follows (tidy.ts).
 */
export function pruneAutoSources(s: Services): { before: number; after: number } {
  const ids = [...new Set([...caredCompanies(s), ...expandable(s)])];
  const cared = new Set<string>();
  for (let i = 0; i < ids.length; i += 500) for (const r of s.domain.db.prepare(`select name from company where id in (${ids.slice(i, i + 500).map(() => "?").join(",")})`).all(...ids.slice(i, i + 500)) as { name: string }[]) cared.add(r.name);
  const seen = new Set<string>();
  const keep = s.config.sources.filter((c) => {
    const key = c.url ? siteKeyOf(c.url) : c.id;
    if (!c.auto || c.discover) { seen.add(key); return true; }
    if (seen.has(key) || !cared.has(c.name ?? "")) return false;
    seen.add(key); return true;
  });
  const before = s.config.sources.length;
  if (keep.length !== before) saveSources(dataOf(s), keep);
  return { before, after: keep.length };
}
