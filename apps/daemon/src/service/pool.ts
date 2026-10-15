import type { Db } from "../db.js";
import { json } from "../db.js";
import { loadExpectations, judge, statusRank, type ExpStatus, type Verdict } from "./expectations.js";
import { loadContext, resolvePost, summarize, applyRules, localDay, campaignSaying, type Resolution } from "./deadlines.js";
import { groupPosts, titleKey } from "./post-groups.js";

/** ADR-015: lower = more trusted. Unknown grades sort last; the person's own word (本人) above all. */
export const GRADE_RANK: Record<string, number> = { 本人: -1, 官方: 0, 校方转载: 1, 聚合: 2, 行业线索: 3, 推断: 4 };
const rank = (g: string) => GRADE_RANK[g] ?? 9;
/** the company line's kind when it has no posts, from what its batch goes by */
const KIND: Record<string, string> = { date: "date", date_or_until_filled: "date", until_filled: "until_filled", rolling: "rolling" };

export interface PoolQuery { companyId?: string; query?: string; tag?: string; recommendedOnly?: boolean; companyType?: string; city?: string; matchedOnly?: boolean; minTier?: "优先考虑" | "可迁移"; newWithinDays?: number; limit?: number; offset?: number; sort?: "match" | "deadline" | "new"; hideExpectationFail?: boolean }


/**
 * The merge over every campaign and position costs most of a second, and a page asks for it on every click — so it
 * is built once and kept until the database changes. `total_changes()` counts this connection's writes, and the
 * daemon is the only writer, so an unchanged count means nothing the merge reads has moved.
 */
// every tool call — reads included — writes an audit row; counted here so that reading the pool does not itself expire it
const unrelated = new WeakMap<Db, number>();
export const poolUnrelatedWrite = (db: Db): void => { unrelated.set(db, (unrelated.get(db) ?? 0) + 1); };
const stamp = (db: Db, days: number) => `${(db.prepare("select total_changes() as n").get() as any).n - (unrelated.get(db) ?? 0)}|${days}|${localDay()}`;
/**
 * Two kinds of staleness. After the user's own write (a tool call) the next read must show it: rebuild first, then
 * answer. After a background write (a scheduled scan, a recommender rerun — minutes of them at startup) nobody is
 * waiting for that particular row: answer from the old rows at once and rebuild right after, so browsing never
 * stalls behind a scan.
 */
let userWrote = false;
export const poolDirty = (): void => { userWrote = true; };
let rebuilding: Db | null = null;
let cache: { db: Db; key: string; days: number; at: number; rows: Row[]; tagCounts: { tag: string; count: number }[] } | null = null;
interface Row { item: any; keys: string[]; recs: { tag: string; score: number; reason: string; key: string }[]; search: string; name: string; aliases: string[] }

/**
 * How a search word found a company, best first: the company itself before a company that merely has a post by that
 * name (「小红书」 must not open with 拓竹科技 because one of its posts mentions 小红书运营).
 * ponytail: post descriptions are not searched — 110k JDs in memory for a rarely useful match; add an FTS table if asked.
 */
export const MATCHED_BY = ["公司名", "别名", "公司名开头", "公司名包含", "岗位名"] as const;
export function matchRank(q: string, name: string, aliases: string[]): number {
  const n = name.toLowerCase(), a = aliases.map((x) => x.toLowerCase());
  return n === q ? 0 : a.includes(q) ? 1 : n.startsWith(q) ? 2 : n.includes(q) || a.some((x) => x.includes(q)) ? 3 : 4;
}

function build(db: Db, newWithinDays: number): Pick<NonNullable<typeof cache>, "rows" | "tagCounts"> {
  const campaigns = db.prepare("select c.*, co.name as company_name, co.type as company_type, co.aliases as company_aliases from campaign c join company co on co.id = c.company_id").all() as any[];
  const positions = db.prepare("select p.id, p.campaign_id, p.title, p.cities, p.status, p.watch_priority, p.created_at, p.closes_at, a.state as app_state, f.score as fit_score, f.verdict as fit_verdict from position p left join application a on a.position_id = p.id and a.state != 'cancelled' left join position_fit f on f.position_id = p.id").all() as any[];
  const recs = db.prepare("select * from recommendation order by score desc").all() as any[];
  const newSince = new Date(Date.now() - newWithinDays * 86400_000).toISOString();
  const dctx = loadContext(db), resolved = new Map<string, Resolution>();
  // what each batch goes by (ADR-041's 项目层说法: the person's word, else its sources and its same-drive batches)
  const sayings = new Map<string, Resolution>();
  const say = (c: any) => sayings.get(c.id) ?? sayings.set(c.id, campaignSaying(dctx, c.id)).get(c.id)!;
  const over = (c: any) => say(c).expired;
  // the person's word on one batch, shown in that batch's own line (`sources`)
  const word = (c: any) => dctx.overrides.get(`campaign:${c.id}`);

  const byCompany = new Map<string, any[]>();
  for (const c of campaigns) (byCompany.get(c.company_id) ?? byCompany.set(c.company_id, []).get(c.company_id)!).push(c);
  const posByCampaign = new Map<string, any[]>();
  for (const p of positions) (posByCampaign.get(p.campaign_id) ?? posByCampaign.set(p.campaign_id, []).get(p.campaign_id)!).push(p);
  const recsByCompany = new Map<string, any[]>();
  for (const r of recs) (recsByCompany.get(r.company_id) ?? recsByCompany.set(r.company_id, []).get(r.company_id)!).push(r);
  const titleOf = new Map<string, string>(positions.map((p) => [p.id, p.title]));

  const rows: Row[] = [];
  const counts = new Map<string, number>();
  const gradeOf = new Map<string, string>(campaigns.map((c) => [c.id, c.source_grade]));
  for (const [companyId, cs] of byCompany) {
    // a batch that has closed says nothing about the one that is open now: last spring's deadline and poster link
    // must not outrank this autumn's row just because their source is graded higher
    cs.sort((a, b) => Number(over(a)) - Number(over(b)) || rank(a.source_grade) - rank(b.source_grade) || String(b.last_verified_at ?? "").localeCompare(String(a.last_verified_at ?? "")));
    const live = cs.filter((c) => !over(c));
    const pick = (f: string) => cs.find((c) => c[f])?.[f] ?? "";
    // several open batches with different dates (库犸: two sheet rows, 9-30 and 12-31): the nearest one is the one to act
    // on — an early reminder costs nothing, a late one costs the application (user, 2026-09-30). The person's word, then
    // an official date, beat a sheet's transcription (ADR-015, ADR-041).
    const sg = (c: any) => rank(say(c).source?.grade ?? c.source_grade);
    const dated = live.filter((c) => say(c).date).sort((a, b) => sg(a) - sg(b) || String(say(a).date).localeCompare(String(say(b).date)));
    const dl = dated[0] ?? live.find((c) => say(c).policy !== "unknown") ?? live[0] ?? cs[0];

    // 「其他来源写的截止」 (the yellow box on the company page): the dates that disagree with what that batch goes by, by
    // ADR-041's rules — the same drive and year only; not another batch of the same kind of source, not an equal
    // source's passed day; nothing at all once the person has said. (Before 2026-10-14: every open batch with another day.)
    const conflicts = say(dl).conflicts.map((x) => ({ field: "closesAt", value: x.date ?? "", grade: x.source.grade, sourceKind: x.source.sourceKind,
      batch: (cs.find((c) => c.source_kind === x.source.sourceKind && c.closes_at === x.date)?.batch ?? "") as string }));

    // 「同一岗位」: the rule shared with every tool answer (post-groups.ts)
    const merged = new Map<string, any>();
    for (const [k, ps] of groupPosts(cs.map((c) => c.id), posByCampaign).groups) {
      const p = ps[0];
      merged.set(k, { id: p.id, title: p.title, cities: [...new Set(ps.flatMap((x) => json.parse(x.cities, [] as string[])))], rows: ps, status: p.status, grades: [...new Set(ps.map((x) => gradeOf.get(x.campaign_id)))],
        applicationState: ps.find((x) => x.app_state)?.app_state ?? null, watched: ps.some((x) => x.watch_priority > 0), isNew: ps.every((x) => x.created_at >= newSince), match: null, fit: p.fit_score == null ? null : { score: p.fit_score, verdict: p.fit_verdict } });
    }
    for (const m of merged.values()) {
      const [p, ...twins] = m.rows as any[];
      // posts that share a batch and have nothing said about them alone resolve alike: one object for all of them. The
      // same post seen in another source (a captured page and the site's own list) brings what that source says of it.
      const own = twins.length > 0 || dctx.facts.has(`position:${p.id}`) || dctx.overrides.has(`position:${p.id}`), rk = `${p.campaign_id}|${p.closes_at ?? ""}`;
      m.deadline = own ? resolvePost(p, dctx, twins) : resolved.get(rk) ?? resolved.set(rk, resolvePost(p, dctx)).get(rk)!;
      m.closesAt = m.deadline.date;
      delete m.rows;
    }
    // recs are score-desc, so the first row per tag / per title is the best one
    const mine = recsByCompany.get(companyId) ?? [];
    const tags: { tag: string; mode: string; score: number; reason: string }[] = [];
    for (const r of mine) if (!tags.some((x) => x.tag === r.tag)) tags.push({ tag: r.tag, mode: r.mode, score: r.score, reason: r.reason });
    for (const t of tags) counts.set(t.tag, (counts.get(t.tag) ?? 0) + 1);
    const pos = [...merged.values()];
    // the company's line (ADR-041): the range over its open posts, and the day that matters to this person — the earliest
    // among the posts being prepared, else the watched ones, else the matched ones, else all
    const sum = summarize(pos.map((p) => p.deadline));
    const matchedKeys = new Set(mine.filter((r) => r.position_id).map((r) => titleKey(titleOf.get(r.position_id) ?? "")));
    const groups: [string, any[]][] = [["准备申请的岗位", pos.filter((p) => p.applicationState === "draft")], ["关注的岗位", pos.filter((p) => p.watched && !p.applicationState)], ["匹配的岗位", pos.filter((p) => matchedKeys.has(titleKey(p.title)))], ["岗位", pos]];
    const focus = groups.find(([, g]) => g.some((p) => !p.deadline.expired)) ?? groups[3];
    const first = focus[1].filter((p) => p.deadline.date && !p.deadline.expired).sort((a, b) => a.deadline.date.localeCompare(b.deadline.date))[0];
    const allExpired = pos.length > 0 && pos.every((p) => p.deadline.expired);

    rows.push({
      keys: [...merged.keys()],
      recs: mine.filter((r) => r.position_id).map((r) => ({ tag: r.tag, score: r.score, reason: r.reason, key: titleKey(titleOf.get(r.position_id) ?? "") })),
      name: cs[0].company_name as string, aliases: json.parse(cs[0].company_aliases, [] as string[]),
      search: (cs[0].company_name + "\n" + json.parse(cs[0].company_aliases, [] as string[]).join("\n") + "\n" + pos.map((p) => p.title).join("\n")).toLowerCase(),
      item: {
        companyId, companyName: cs[0].company_name as string, companyType: (cs[0].company_type ?? "") as string,
        // with posts: by their resolved deadlines; a company that is only a sheet row with no posts goes by its batch
        closesAt: (pos.length ? first?.deadline.date ?? null : say(dl).date) as string | null,
        deadlineKind: (pos.length ? (first ? "date" : sum.asap ? "until_filled" : "unknown") : KIND[say(dl).policy] ?? "unknown") as string,
        deadlineText: (pos.length ? sum.text : (say(dl).source?.grade === "本人" && say(dl).source!.evidence) || dl.deadline_text) as string,
        deadline: { summary: sum.text, earliest: sum.earliest, latest: sum.latest, asap: sum.asap, unverified: sum.unverified, why: first ? `${focus[0]}「${first.title}」${first.deadline.say}` : "", process: pos.find((p) => p.deadline.process)?.deadline.process ?? "", rules: applyRules(dctx, companyId) },
        expired: pos.length ? allExpired : live.length === 0,
        applyUrl: pick("apply_url") as string, noticeUrl: pick("notice_url") as string, degreeReq: pick("degree_req") as string, majorReq: pick("major_req") as string,
        cities: Array.from(new Set(cs.flatMap((c) => json.parse(c.cities, [] as string[])))).slice(0, 20),
        grade: (live[0] ?? cs[0]).source_grade as string,
        sources: cs.map((c) => ({ campaignId: c.id as string, sourceKind: c.source_kind as string, grade: c.source_grade as string, batch: c.batch as string, cohort: c.cohort as string,
          closesAt: (word(c) ? (word(c)!.kind === "date" ? word(c)!.date : null) : c.closes_at ?? null) as string | null, deadlineText: (word(c)?.note || c.deadline_text) as string, positions: (posByCampaign.get(c.id) ?? []).length, lastVerifiedAt: (c.last_verified_at ?? null) as string | null })),
        conflicts, positions: pos, newPositions: pos.filter((p) => p.isNew).length,
        tags, applied: pos.some((p) => p.applicationState && p.applicationState !== "draft"),
      },
    });
  }
  return { rows, tagCounts: [...counts].map(([tag, count]) => ({ tag, count })) };
}

/** The pool's rows for this database, rebuilt when a write has made them stale. Shared by every reader of the pool. */
function ensure(db: Db, days: number): NonNullable<typeof cache> {
  if (!cache || cache.db !== db || cache.days !== days) rebuild(db, days);
  else if (stale(cache, db, days)) {
    if (userWrote) rebuild(db, days);
    // already rebuilt by then (refreshPool, below): not again
    else if (rebuilding !== db) { rebuilding = db; setTimeout(() => { try { if (cache?.db === db && cache.days === days && stale(cache, db, days)) rebuild(db, days); } catch { /* db closed */ } finally { if (rebuilding === db) rebuilding = null; } }, 0); }
  }
  if (!cache) throw new Error("unreachable");
  return cache;
}
function rebuild(db: Db, days: number): void { userWrote = false; cache = { db, key: stamp(db, days), days, at: Date.now(), ...build(db, days) }; }
const stale = (c: NonNullable<typeof cache>, db: Db, days: number) => c.key !== stamp(db, days) || Date.now() - c.at > 600_000;

/**
 * After a background write, put the new rows in place now, so that a page told about it (5B, service/background.ts)
 * reads them — `ensure` alone would answer that page from the old rows and rebuild behind it, and nobody would say so
 * again. Nothing held, or nothing written since: nothing to do (the next read builds what it needs).
 */
export function refreshPool(db: Db): boolean {
  if (!cache || cache.db !== db || cache.key === stamp(db, cache.days)) return false;
  rebuild(db, cache.days);
  return true;
}

export interface BoardItem { companyId: string; companyName: string; positionId: string | null; title: string; cities: string[]; closesAt: string | null; daysLeft: number | null; applied: boolean; say: string; verified: boolean; conflict: boolean; grade: string; url: string; why: string }
/**
 * What needs the person's eye about deadlines (ADR-041), over the posts they hold — watched, or being applied to — and
 * the companies they tagged by hand: `deadlines` are the days coming up; `verify` is what nobody has confirmed, most
 * dangerous first — a sheet claiming a day within two weeks, then sources that disagree, then no deadline at all — and
 * within one risk the better match first. A submitted application needs neither.
 */
export function deadlineBoard(db: Db, days = 14, verifyLimit = 5): { deadlines: BoardItem[]; verify: BoardItem[] } {
  const today = localDay(), until = localDay(new Date(Date.now() + days * 86400_000)), soon = localDay(new Date(Date.now() + 14 * 86400_000));
  const left = (d: string) => Math.round((Date.parse(d) - Date.parse(today)) / 86400_000);
  const deadlines: BoardItem[] = [], risky: { it: BoardItem; risk: number; held: number; score: number }[] = [];
  for (const r of ensure(db, 3).rows) {
    const c = r.item, score = c.tags.reduce((m: number, t: any) => Math.max(m, t.score), 0);
    const held = c.positions.filter((p: any) => (p.watched && !p.applicationState) || p.applicationState === "draft" || p.applicationState === "submitted");
    const byHand = c.tags.some((t: any) => t.mode === "manual" && t.tag !== "不投");
    if (!held.length && !byHand) continue;
    // a hand-tagged company with no post picked yet stands by the post that decides its own line
    const posts: any[] = held.length ? held : [c.positions.find((p: any) => !p.deadline.expired && p.deadline.date === c.closesAt) ?? c.positions.find((p: any) => !p.deadline.expired)].filter(Boolean);
    for (const p of posts) {
      const d: Resolution = p.deadline, applied = p.applicationState === "submitted";
      const it: BoardItem = { companyId: c.companyId, companyName: c.companyName, positionId: held.length ? p.id : null, title: held.length ? p.title : "", cities: p.cities ?? [], closesAt: d.date, daysLeft: d.date ? left(d.date) : null, applied,
        say: d.say, verified: d.status === "verified", conflict: d.conflicts.length > 0, grade: d.source?.grade ?? c.grade, url: d.source?.url || c.noticeUrl || c.applyUrl, why: "" };
      if (d.date && d.date >= today && d.date <= until) deadlines.push(it);
      if (applied || d.expired) continue;
      const risk = d.status === "unverified" && d.date && d.date <= soon ? 0 : d.conflicts.length ? 1 : d.status === "unverified" ? 2 : -1;
      if (risk >= 0) risky.push({ it: { ...it, why: ["来源写的截止就在两周内，但还没在官网核实", "不同来源写的截止不一样", "还没有可靠的截止信息"][risk] }, risk, held: Number(held.length > 0), score });
    }
  }
  deadlines.sort((a, b) => String(a.closesAt).localeCompare(String(b.closesAt)));
  risky.sort((a, b) => a.risk - b.risk || b.held - a.held || b.score - a.score || String(a.it.closesAt ?? "9").localeCompare(String(b.it.closesAt ?? "9")));
  return { deadlines, verify: risky.slice(0, verifyLimit).map((x) => x.it) };
}

/**
 * One row per company, merged at read time across every source that mentions it.
 * Sources never overwrite each other on write (campaign identity includes the source), so a bad source can only
 * be wrong about its own rows; here each field takes the best-graded, most recently verified non-empty value and
 * disagreeing lower-grade values are surfaced in `conflicts`, never applied.
 */
export function listPool(db: Db, q: PoolQuery = {}) {
  const cache = ensure(db, q.newWithinDays ?? 3);
  const words = (q.query ?? "").trim().toLowerCase().split(/\s+/).filter(Boolean);
  const scoreOf = (r: Row) => (q.tag ? (r.item.tags.find((t: any) => t.tag === q.tag)?.score ?? 0) : r.item.tags.reduce((m: number, t: any) => Math.max(m, t.score), 0));
  const hits = cache.rows.filter((r) => (!q.companyId || r.item.companyId === q.companyId) && words.every((w) => r.search.includes(w)) && (!q.companyType || String(r.item.companyType ?? "").includes(q.companyType))
    && (!q.recommendedOnly || r.item.tags.length > 0) && (!q.tag || r.item.tags.some((t: any) => t.tag === q.tag)))
    .map((r) => ({ r, score: scoreOf(r) }));
  // post-level filters (ADR-034): a city, only posts the profile matched, a floor on the 适配度 tier — a company stays
  // when one of its posts passes, and only those posts are returned (国能 has 2,500; the agent wants the 12 in 武汉)
  const tagFor = q.tag ?? "画像匹配";
  const floor = q.minTier === "优先考虑" ? 200 : q.minTier === "可迁移" ? 100 : 0;
  const postFilter = q.city || q.matchedOnly || floor ? (r: Row, p: any) => {
    const where: string[] = p.cities?.length ? p.cities : r.item.cities;
    if (q.city && !where.some((c) => c.includes(q.city!))) return false;
    if (!q.matchedOnly && !floor) return true;
    const rec = r.recs.find((x) => x.tag === tagFor && x.key === titleKey(p.title));
    return !!rec && rec.score >= floor;
  } : null;
  if (postFilter) for (let i = hits.length - 1; i >= 0; i--) if (!hits[i].r.item.positions.some((p: any) => postFilter(hits[i].r, p))) hits.splice(i, 1);
  // 期望卡 (ADR-036): every post judged against the cards and annotated; a company stands by its best post; nothing is
  // hidden unless asked (hideExpectationFail), and then only 不符合 — 待核实 stays, since missing data is not a mismatch
  const exps = loadExpectations(db);
  const verdicts = new Map<Row, { status: ExpStatus; score: number; byPost: Map<string, Verdict> }>();
  if (exps.length || q.hideExpectationFail) for (let i = hits.length - 1; i >= 0; i--) {
    const r = hits[i].r, co = { companyType: r.item.companyType, cities: r.item.cities, blocked: r.item.tags.some((t: any) => t.tag === "不投") };
    const byPost = new Map<string, Verdict>();
    for (const p of r.item.positions) if (!postFilter || postFilter(r, p)) byPost.set(p.id, judge(exps, p, co));
    const vs = byPost.size ? [...byPost.values()] : [judge(exps, {}, co)];
    const status = vs.reduce<ExpStatus>((s, v) => (statusRank(v.status) < statusRank(s) ? v.status : s), "fail"), score = Math.max(...vs.map((v) => v.score));
    if (q.hideExpectationFail && status === "fail") hits.splice(i, 1);
    else verdicts.set(r, { status, score, byPost });
  }
  // default: by match when looking at recommendations, by deadline otherwise. Closed companies always go last;
  // in match order 重点 companies come first, then 符合 before 待核实, then the soft expectations, then the match
  const sort = q.sort ?? (q.recommendedOnly || q.tag ? "match" : "deadline");
  const byDeadline = (a: any, b: any) => Number(a.r.item.closesAt == null) - Number(b.r.item.closesAt == null) || String(a.r.item.closesAt).localeCompare(String(b.r.item.closesAt));
  const top = (h: { r: Row }) => Number(h.r.item.tags.some((t: any) => t.tag === "重点"));
  const v = (h: { r: Row }) => verdicts.get(h.r);
  // a search answers "where is X" first: the company called X, then its aliases, … and only then the usual order
  const asked = words.join(" "), rel = new Map<Row, number>();
  if (asked) for (const h of hits) rel.set(h.r, matchRank(asked, h.r.name, h.r.aliases));
  hits.sort((a, b) => (rel.get(a.r) ?? 0) - (rel.get(b.r) ?? 0) || Number(a.r.item.expired) - Number(b.r.item.expired)
    || (sort === "match" ? top(b) - top(a) || statusRank(v(a)?.status) - statusRank(v(b)?.status) || (v(b)?.score ?? 0) - (v(a)?.score ?? 0) || b.score - a.score
      : sort === "new" ? b.r.item.newPositions - a.r.item.newPositions : 0) || byDeadline(a, b));

  // the cached rows are shared between calls: per-query fields (score, each position's match) go on copies
  const from = q.offset ?? 0;
  const items = hits.slice(from, from + (q.limit ?? 200)).map(({ r, score }) => {
    const vr = verdicts.get(r);
    const positions = r.item.positions.filter((p: any) => (!postFilter || postFilter(r, p)) && !(q.hideExpectationFail && vr?.byPost.get(p.id)?.status === "fail"))
      .map((p: any) => ({ ...p, ...(vr?.byPost.has(p.id) ? { expectation: vr.byPost.get(p.id) } : {}) }));
    // by title (the list may be filtered); same-titled posts in several cities share the title's match
    const at = new Map<string, any[]>();
    for (const p of positions) (at.get(titleKey(p.title)) ?? at.set(titleKey(p.title), []).get(titleKey(p.title))!).push(p);
    for (const rec of q.tag ? r.recs.filter((x) => x.tag === q.tag) : r.recs) for (const p of at.get(rec.key) ?? []) if (!p.match) p.match = { score: rec.score, reason: rec.reason };
    // a model's reading (layer 2) outranks the rules where it exists; among equals, what fits the person's wants first
    positions.sort((a: any, b: any) => (b.fit?.score ?? -1) - (a.fit?.score ?? -1) || (b.match?.score ?? 0) - (a.match?.score ?? 0) || statusRank(a.expectation?.status) - statusRank(b.expectation?.status));
    return { ...r.item, score, positions, ...(vr ? { expectation: { status: vr.status, score: vr.score } } : {}), ...(rel.has(r) ? { matchedBy: MATCHED_BY[rel.get(r)!] } : {}) };
  });
  return { items, total: hits.length, tagCounts: cache.tagCounts };
}

/**
 * 关注 flips one flag the cache mirrors. Applying it to the cached row keeps the cache valid across the write, so
 * bookmarking a few jobs and clicking on does not pay for a rebuild each time. Call it right after the write.
 */
export function poolWatched(db: Db, positionId: string, watched: boolean): void {
  if (!cache || cache.db !== db) return;
  const p = cache.rows.flatMap((r) => r.item.positions).find((x: any) => x.id === positionId);
  if (!p) { userWrote = true; return; } // a duplicate the merge folded under another id: rebuild rather than guess
  p.watched = watched;
  // current up to this one-row write → still current; otherwise it stays stale for whatever else changed
  const now = stamp(db, cache.days), [n, ...rest] = cache.key.split("|");
  if (`${Number(n) + 1}|${rest.join("|")}` === now) cache.key = now;
}

export function searchCompanies(db: Db, query: string, limit = 10) {
  const like = `%${query.trim()}%`;
  const q = query.trim().toLowerCase();
  const rows = db.prepare(`select co.id, co.name, co.aliases, co.type, co.industry, (select count(*) from position p join campaign c on c.id = p.campaign_id where c.company_id = co.id) as n
    from company co where co.name like ? or co.aliases like ? order by length(co.name) limit 200`).all(like, like) as any[];
  return { items: rows.map((r) => ({ r, rank: matchRank(q, r.name, json.parse(r.aliases, [] as string[])) })).sort((a, b) => a.rank - b.rank || b.r.n - a.r.n).slice(0, limit)
    .map(({ r, rank }) => ({ companyId: r.id as string, companyName: r.name as string, type: r.type as string, industry: r.industry as string, positions: r.n as number, matchedBy: MATCHED_BY[rank] as string })) };
}

export function poolFacets(db: Db) {
  const top = (values: string[], n: number) => { const c = new Map<string, number>(); for (const v of values) if (v) c.set(v, (c.get(v) ?? 0) + 1); return [...c].sort((a, b) => b[1] - a[1]).slice(0, n).map(([v]) => v); };
  const cities = (db.prepare("select cities from campaign").all() as any[]).flatMap((r) => json.parse(r.cities, [] as string[]));
  const cos = db.prepare("select type, industry from company").all() as any[];
  const split = (s: string) => (s ?? "").split(/[、,，\s]+/);
  return { cities: top(cities, 80), industries: top(cos.flatMap((r) => split(r.industry)), 40), companyTypes: top(cos.flatMap((r) => split(r.type)), 20) };
}

export function scanHistory(db: Db, names: Map<string, string>, limit = 30) {
  const rows = db.prepare("select * from scan_run order by started_at desc limit ?").all(limit) as any[];
  return { items: rows.map((r) => ({ runId: r.id as string, source: r.source as string, configId: r.config_id as string, name: names.get(r.config_id) ?? "", at: r.started_at as string, found: r.found as number, newPositions: r.new_positions as number, complete: !!r.complete, error: r.error as string })) };
}
