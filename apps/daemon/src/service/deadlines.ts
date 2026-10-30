import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { Db } from "../db.js";
import { now } from "../db.js";
import { DomainError, NotFound } from "./errors.js";
import { isAggregate } from "../data/index.js";
import { twinsOf, type GroupPost } from "./post-groups.js";

/**
 * 截止 (ADR-041): three layers, never mixed.
 *  1. facts — what each source said about a deadline, for a post, a campaign or a company, with its evidence;
 *  2. resolution — which fact a post goes by, and which other sources disagree;
 *  3. what to say — one of four sentences a person can act on.
 * The old columns (position.closes_at, campaign.closes_at / deadline_kind / deadline_text) are read as facts of their
 * source's grade; nothing is migrated. A person's word (deadline_override) outranks every source. Only 投递截止 facts
 * resolve a deadline — a 报名开始 or 面试 date never does. "The site does not say" is no fact at all, so it cannot hide
 * what a lower-graded source says.
 */
export type Policy = "date" | "until_filled" | "date_or_until_filled" | "rolling" | "no_fixed_date" | "unknown";
export type Precision = "datetime" | "day" | "range" | "month_end" | "month";
export type Applies = "this_position" | "all_campaign_positions" | "campaign_unspecified";
/** apply_rule is not a time at all: how many posts one may apply to, what does not count — said by the same pages, kept the same way */
export type DeadlineEvent = "application_open" | "application_close" | "screening" | "assessment" | "interview" | "offer" | "apply_rule";
export interface Fact {
  id: string; subjectType: "position" | "campaign" | "company"; subjectId: string; event: DeadlineEvent; policy: Policy;
  dateStart: string | null; dateEnd: string | null; precision: Precision; applies: Applies;
  grade: string; sourceKind: string; url: string; evidence: string; by: string; at: string; explicit: boolean;
}
export interface DeadlineSource { grade: string; sourceKind: string; url: string; evidence: string }
export interface Resolution {
  policy: Policy;
  /** the last day one can still apply (a 月底 keeps its range: date = the end of it) */
  date: string | null; dateText: string;
  status: "verified" | "unverified";
  /** post = said about this post; campaign = said for the whole batch; unspecified = the batch has several dates and this post's is not known */
  scope: "post" | "campaign" | "unspecified" | "none";
  say: string;
  source: DeadlineSource | null;
  conflicts: { say: string; date: string | null; source: DeadlineSource }[];
  expired: boolean;
  /** the recruiting process as the official source describes it (筛选 / 面试 already running) — shown, never turned into a date */
  process: string;
}

export const GRADE_RANK: Record<string, number> = { 本人: -1, 官方: 0, 校方转载: 1, 聚合: 2, 行业线索: 3, 推断: 4 };
const rank = (g: string) => GRADE_RANK[g] ?? 9;
/** How a person names the source: a 汇总表 stays a 汇总表 whatever grade its rows carry. */
export const sourceName = (s: { grade: string; sourceKind: string }) => (s.grade === "本人" ? "本人核实" : s.grade === "官方" ? "官网" : isAggregate(s.sourceKind) ? "汇总表" : s.grade === "校方转载" ? "校方转载" : "转载");

/** The day in Beijing: every 截止 is a Beijing date, wherever the computer is (the author's runs at UTC−6, 14 hours behind). */
export const beijingDay = (d = new Date()) => new Date(d.getTime() + 8 * 3600_000).toISOString().slice(0, 10);
/** 2026-10-21 → 「10 月 21 日」; another year is spelled out. */
export function sayDate(day: string, precision: Precision = "day"): string {
  const [y, m, d] = day.slice(0, 10).split("-").map(Number);
  const year = y === new Date().getFullYear() ? "" : `${y} 年 `;
  return precision === "month_end" ? `${year}${m} 月底` : precision === "month" ? `${year}${m} 月` : `${year}${m} 月 ${d} 日`;
}
const lastDay = (f: Fact) => (f.dateEnd ?? f.dateStart)?.slice(0, 10) ?? null;
const hasDate = (f: Fact) => (f.policy === "date" || f.policy === "date_or_until_filled") && !!lastDay(f);
const src = (f: Fact): DeadlineSource => ({ grade: f.grade, sourceKind: f.sourceKind, url: f.url, evidence: f.evidence });

/** Two facts agree when their days coincide, or one's day falls inside the other's range (「12 月底」 vs 12-31). */
function compatible(a: Fact, b: Fact): boolean {
  if (!hasDate(a) || !hasDate(b)) return hasDate(a) === hasDate(b);
  // a 月底 with no start given covers the last third of its month; a bare month, all of it
  const range = (f: Fact): [string, string] => {
    const end = lastDay(f)!;
    if (f.precision === "day" || f.precision === "datetime") return [end, end];
    return [f.dateStart?.slice(0, 10) ?? (f.precision === "month_end" ? `${end.slice(0, 8)}21` : f.precision === "month" ? `${end.slice(0, 8)}01` : end), end];
  };
  const [a0, a1] = range(a), [b0, b1] = range(b);
  return a0 <= b1 && b0 <= a1;
}

function sayFact(f: Fact, verified: boolean, unspecified: boolean): string {
  const who = sourceName(f), d = lastDay(f), when = d ? sayDate(d, f.precision) : "";
  if (unspecified) return `${who}各岗位截止不同，本岗位的截止未确认`;
  if (verified) {
    if (f.policy === "date") return f.grade === "本人" ? `本人核实：${when}截止` : `官网截止 ${when}`;
    if (f.policy === "date_or_until_filled") return `官网截止 ${when}，招满可能提前结束`;
    if (f.policy === "until_filled") return "招满即止，宜尽早";
    if (f.policy === "rolling") return "滚动招聘，宜尽早";
    if (f.policy === "no_fixed_date") return "官网未设截止，宜尽早";
    return "截止未核实";
  }
  if (hasDate(f)) return `仅来自${who}：${when}截止，待核实`;
  if (f.policy === "until_filled") return `仅来自${who}：招满为止，待核实`;
  if (f.policy === "rolling") return `仅来自${who}：尽快投递，待核实`;
  return "截止未核实";
}

export interface CampaignRow { id: string; company_id: string; kind: string; cohort: string; closes_at: string | null; deadline_kind: string; deadline_text: string; source_grade: string; source_kind: string; apply_url: string; notice_url: string }
export interface PostRow { id: string; campaign_id: string; closes_at: string | null }
export interface OverrideRow { subject_type: string; subject_id: string; kind: string; date: string | null; note: string; by: string; at: string }

/** 实习 / 社招 are their own recruiting drives; everything else (校招, 管培生, 博士专项 …) is the campus drive. */
const drive = (kind: string) => (/实习/.test(kind) ? "intern" : /社招/.test(kind) ? "social" : "campus");
const cohorts = (s: string) => new Set(s.match(/\d{4}/g) ?? []);
/** Two batches can be compared only when they are the same drive of the same graduating year. */
export function sameDrive(a: CampaignRow, b: CampaignRow): boolean {
  if (a.id === b.id) return true;
  if (drive(a.kind) !== drive(b.kind)) return false;
  const ca = cohorts(a.cohort), cb = cohorts(b.cohort);
  return !ca.size || !cb.size || [...ca].some((y) => cb.has(y));
}

/** The old columns of a campaign, read as what its source said. `unknown` says nothing. */
function campaignFact(c: CampaignRow): Fact | null {
  const days = new Set((c.deadline_text ?? "").match(/\d{4}-\d{1,2}-\d{1,2}/g) ?? []);
  const base = { subjectType: "campaign" as const, subjectId: c.id, event: "application_close" as const, precision: "day" as Precision, grade: c.source_grade, sourceKind: c.source_kind, url: c.notice_url || c.apply_url || "", evidence: c.deadline_text ?? "", by: c.source_kind, at: "", explicit: false, id: `c:${c.id}` };
  if (c.closes_at) return { ...base, policy: "date", dateStart: null, dateEnd: c.closes_at, applies: days.size >= 2 ? "campaign_unspecified" : "all_campaign_positions" };
  if (c.deadline_kind === "until_filled" || c.deadline_kind === "rolling") return { ...base, policy: c.deadline_kind, dateStart: null, dateEnd: null, applies: "all_campaign_positions" };
  return null;
}

export interface ResolveContext { campaigns: Map<string, CampaignRow>; byCompany: Map<string, CampaignRow[]>; facts: Map<string, Fact[]>; overrides: Map<string, OverrideRow>; today: string;
  /** a batch's same-drive batches, worked out once per batch (filled as posts are resolved) */
  siblings?: Map<string, CampaignRow[]> }

/** Everything the resolver needs, loaded once (facts and overrides are few; campaigns are ~10k rows). */
export function loadContext(db: Db, companyIds?: string[]): ResolveContext {
  const where = companyIds?.length ? `where company_id in (${companyIds.map(() => "?").join(",")})` : "";
  const cs = db.prepare(`select id, company_id, kind, cohort, closes_at, deadline_kind, deadline_text, source_grade, source_kind, apply_url, notice_url from campaign ${where}`).all(...(companyIds ?? [])) as unknown as CampaignRow[];
  const campaigns = new Map(cs.map((c) => [c.id, c])), byCompany = new Map<string, CampaignRow[]>();
  for (const c of cs) (byCompany.get(c.company_id) ?? byCompany.set(c.company_id, []).get(c.company_id)!).push(c);
  const facts = new Map<string, Fact[]>();
  for (const r of db.prepare("select * from deadline_fact where superseded_at is null").all() as any[]) {
    const f: Fact = { id: r.id, subjectType: r.subject_type, subjectId: r.subject_id, event: r.event, policy: r.policy, dateStart: r.date_start, dateEnd: r.date_end, precision: r.precision, applies: r.applies, grade: r.grade, sourceKind: r.source_kind, url: r.url, evidence: r.evidence, by: r.by, at: r.created_at, explicit: true };
    const k = `${f.subjectType}:${f.subjectId}`;
    (facts.get(k) ?? facts.set(k, []).get(k)!).push(f);
  }
  const overrides = new Map((db.prepare("select * from deadline_override").all() as unknown as OverrideRow[]).map((o) => [`${o.subject_type}:${o.subject_id}`, o]));
  return { campaigns, byCompany, facts, overrides, today: beijingDay() };
}

const UNKNOWN: Resolution = { policy: "unknown", date: null, dateText: "", status: "unverified", scope: "none", say: "截止未核实", source: null, conflicts: [], expired: false, process: "" };
const OVERRIDE_SAY: Record<string, string> = { until_filled: "本人核实：招满即止，宜尽早", rolling: "本人核实：滚动招聘，宜尽早", no_fixed_date: "本人核实：官网未设截止，宜尽早", unknown: "本人核实：官方未写截止" };

/** One post → what it goes by. Pure over the context. */
export function resolvePost(post: PostRow, ctx: ResolveContext, twins: PostRow[] = []): Resolution {
  const own = ctx.campaigns.get(post.campaign_id);
  if (!own) return UNKNOWN;
  let siblings = ctx.siblings?.get(own.id);
  if (!siblings) (ctx.siblings ??= new Map()).set(own.id, (siblings = (ctx.byCompany.get(own.company_id) ?? []).filter((c) => sameDrive(own, c))));
  // the person's word wins outright: on the post, on its batch, on any batch of the same drive (the old campaign.deadline), on the company
  const ov = ctx.overrides.get(`position:${post.id}`) ?? ctx.overrides.get(`campaign:${own.id}`) ?? siblings.map((c) => ctx.overrides.get(`campaign:${c.id}`)).find(Boolean) ?? (drive(own.kind) === "campus" ? ctx.overrides.get(`company:${own.company_id}`) : undefined);
  if (ov) {
    const date = ov.kind === "date" ? ov.date : null;
    return { policy: ov.kind as Policy, date, dateText: date ? sayDate(date) : "", status: "verified", scope: ov.subject_type === "position" ? "post" : "campaign", say: date ? `本人核实：${sayDate(date)}截止` : OVERRIDE_SAY[ov.kind] ?? "截止未核实",
      source: { grade: "本人", sourceKind: "override", url: "", evidence: ov.note }, conflicts: [], expired: !!date && date < ctx.today, process: "" };
  }
  const all: Fact[] = [...(ctx.facts.get(`position:${post.id}`) ?? [])];
  if (post.closes_at) all.push({ id: `p:${post.id}`, subjectType: "position", subjectId: post.id, event: "application_close", policy: "date", dateStart: null, dateEnd: post.closes_at, precision: "day", applies: "this_position", grade: own.source_grade, sourceKind: own.source_kind, url: own.apply_url || own.notice_url || "", evidence: "", by: own.source_kind, at: "", explicit: false });
  // the same post as another source of the same drive lists it: what is said of that one is said of this one
  for (const t of twins) {
    const tc = ctx.campaigns.get(t.campaign_id);
    if (!tc || !siblings.includes(tc)) continue;
    all.push(...(ctx.facts.get(`position:${t.id}`) ?? []));
    if (t.closes_at) all.push({ id: `p:${t.id}`, subjectType: "position", subjectId: t.id, event: "application_close", policy: "date", dateStart: null, dateEnd: t.closes_at, precision: "day", applies: "this_position", grade: tc.source_grade, sourceKind: tc.source_kind, url: tc.apply_url || tc.notice_url || "", evidence: "", by: tc.source_kind, at: "", explicit: false });
  }
  for (const c of siblings) { all.push(...(ctx.facts.get(`campaign:${c.id}`) ?? [])); const f = campaignFact(c); if (f) all.push(f); }
  if (drive(own.kind) === "campus") all.push(...(ctx.facts.get(`company:${own.company_id}`) ?? []));

  const process = all.filter((f) => f.event !== "application_close" && f.event !== "application_open" && f.event !== "apply_rule" && rank(f.grade) <= 0).sort((a, b) => b.at.localeCompare(a.at)).map((f) => f.evidence).filter(Boolean)[0] ?? "";
  const past = (f: Fact) => Number(hasDate(f) && lastDay(f)! < ctx.today);
  // a batch that has closed says nothing about the one that is open now (last spring's poster, a 提前批 that ended):
  // another batch's passed date never decides this post. A wrong 已截止 hides the opening; a wrong 未核实 costs a click.
  const stale = (f: Fact) => !!past(f) && (f.subjectType === "campaign" ? f.subjectId !== own.id : f.subjectType === "position" && f.subjectId !== post.id);
  const closing = all.filter((f) => f.event === "application_close" && f.policy !== "unknown");
  const close = closing.filter((f) => !stale(f));
  if (!close.length) return process ? { ...UNKNOWN, process } : UNKNOWN;

  // grade first; then how directly it speaks about this post; then this post's own batch; then a batch still open;
  // then an explicit record over an old column; then the earlier day (the safer one to act on)
  const direct = (f: Fact) => (f.applies === "this_position" ? 0 : f.applies === "all_campaign_positions" ? 1 : 2);
  // Which listing a statement comes from. The same post listed by several batches of the company (two 汇总表 that both
  // carry it, a sheet and a captured page) is said something about by each of them: none is more "its own" than the
  // other, so among equals the earlier day wins — a reminder too early costs nothing, one too late costs the application
  // (user, 2026-09-30 and 2026-10-13) — and a different day in another of them is a disagreement to show.
  const listedBy = new Map<string, string>([[post.id, own.id]]);
  for (const t of twins) if (siblings.some((c) => c.id === t.campaign_id)) listedBy.set(t.id, t.campaign_id);
  const listings = new Set(listedBy.values());
  const listing = (f: Fact) => (f.subjectType === "position" ? listedBy.get(f.subjectId) : f.subjectType === "campaign" && listings.has(f.subjectId) ? f.subjectId : undefined);
  close.sort((a, b) => rank(a.grade) - rank(b.grade) || direct(a) - direct(b) || Number(!!listing(b)) - Number(!!listing(a))
    || past(a) - past(b) || Number(b.explicit) - Number(a.explicit) || (lastDay(a) ?? "9").localeCompare(lastDay(b) ?? "9"));
  const best = close[0], verified = rank(best.grade) <= 0, unspecified = best.applies === "campaign_unspecified";
  const date = unspecified ? null : lastDay(best);
  // another source that names a day this one does not allow. Not a conflict: another batch of the same source (different
  // batches close on different days), an equally graded source whose day has passed, a batch with several days of its own.
  // … but a better source's batch that closed in the last two months is worth a word beside a lesser source's later day
  const since = beijingDay(new Date(Date.now() - 60 * 86400000));
  const recent = closing.filter((f) => stale(f) && rank(f.grade) < rank(best.grade) && lastDay(f)! >= since);
  const conflicts = unspecified ? [] : [...close.slice(1), ...recent]
    .filter((f) => hasDate(f) && f.applies !== "campaign_unspecified" && !compatible(best, f))
    .filter((f) => !(f.grade === best.grade && (past(f) || (f.sourceKind === best.sourceKind && !f.explicit && !(listing(f) && listing(best) && listing(f) !== listing(best))))))
    .filter((f, i, arr) => arr.findIndex((x) => lastDay(x) === lastDay(f) && sourceName(x) === sourceName(f)) === i)
    .map((f) => ({ say: `${sourceName(f)} ${sayDate(lastDay(f)!, f.precision)}`, date: lastDay(f), source: src(f) }));
  let say = sayFact(best, verified && !unspecified, unspecified);
  if (conflicts.length) say += `；来源有分歧：${conflicts.map((c) => c.say).join("、")}`;
  return {
    policy: unspecified ? "unknown" : best.policy, date, dateText: date ? sayDate(date, best.precision) : "",
    status: verified && !unspecified ? "verified" : "unverified", scope: unspecified ? "unspecified" : best.applies === "this_position" ? "post" : "campaign",
    say, source: src(best), conflicts, expired: !!date && date < ctx.today, process,
  };
}

/** What the official pages say about how to apply at this company (大疆: 每位同学限投递一个职位), newest first, with where it says so. */
export function applyRules(ctx: ResolveContext, companyId: string): { text: string; url: string }[] {
  const subjects = [`company:${companyId}`, ...(ctx.byCompany.get(companyId) ?? []).map((c) => `campaign:${c.id}`)];
  return subjects.flatMap((k) => ctx.facts.get(k) ?? []).filter((f) => f.event === "apply_rule").sort((a, b) => b.at.localeCompare(a.at))
    .filter((f, i, arr) => arr.findIndex((x) => x.evidence === f.evidence) === i).slice(0, 3).map((f) => ({ text: f.evidence, url: f.url }));
}

/** Company line: the range of its open posts' deadlines and how many have none. */
export function summarize(rs: Resolution[]): { text: string; earliest: string | null; latest: string | null; asap: number; unverified: number } {
  const open = rs.filter((r) => !r.expired);
  const days = open.map((r) => r.date).filter(Boolean).sort() as string[];
  const isAsap = (r: Resolution) => !r.date && r.status === "verified" && (r.policy === "until_filled" || r.policy === "rolling" || r.policy === "no_fixed_date");
  const asap = open.filter(isAsap).length, unverified = open.filter((r) => !r.date && !isAsap(r)).length;
  // no post has a day and they all go by the same statement: say that statement
  if (!days.length && open.length && open.every((r) => r.say === open[0].say)) return { text: open[0].say, earliest: null, latest: null, asap, unverified };
  const short = (d: string) => (d.slice(0, 4) === String(new Date().getFullYear()) ? d.slice(5) : d);
  const range = !days.length ? "" : days[0] === days[days.length - 1] ? `截止 ${short(days[0])}` : `岗位截止 ${short(days[0])} ～ ${short(days[days.length - 1])}`;
  const rest = [asap ? `${asap} 个招满即止` : "", unverified ? `${unverified} 个待核实` : ""].filter(Boolean).join("、");
  return { text: range && rest ? `${range}；另有 ${rest}` : range || (rest ? rest : rs.length ? "已截止" : ""), earliest: days[0] ?? null, latest: days[days.length - 1] ?? null, asap, unverified };
}

/**
 * 「这个岗位还能投吗」 and what it goes by, for many posts at once: a tool answer, position.list's 在招 filter, the
 * matcher's candidates, 机会缺口. One context; the same post elsewhere found by the pool's own grouping (post-groups.ts),
 * so a post says the same here as on the pool page. A post with no fact or word of the person's of its own (nor on its
 * twins) depends only on its batch, its own day and its twins' batches and days, in their order: resolved once per
 * such combination — most posts have no twin, and come down to one answer per (batch, day), as in the pool.
 * `twins`: the grouping already worked out by a caller that has every post in hand (the matcher).
 */
export function resolveMany(db: Db, posts: (PostRow & { company_id: string })[], twins?: Map<string, GroupPost[]>): Map<string, Resolution> {
  const out = new Map<string, Resolution>();
  if (!posts.length) return out;
  const companies = new Set<string>();
  for (const p of posts) companies.add(p.company_id);
  const ids = [...companies];
  const ctx = loadContext(db, ids.length <= 5000 ? ids : undefined);
  twins ??= twinsOf(db, ids);
  // posts something is said of by id (a fact, the person's word): those are resolved one by one
  const own = new Set<string>();
  for (const k of [...ctx.facts.keys(), ...ctx.overrides.keys()]) if (k.startsWith("position:")) own.add(k.slice(9));
  const shared = new Map<string, Map<string, Resolution>>(); // batch → its own day and its twins' → what it goes by
  for (const p of posts) {
    const tw = twins.get(p.id);
    if (own.size && (own.has(p.id) || tw?.some((t) => own.has(t.id)))) { out.set(p.id, resolvePost(p, ctx, tw ?? [])); continue; }
    let k = p.closes_at ?? "";
    if (tw) for (const t of tw) k += `|${t.campaign_id}|${t.closes_at ?? ""}`;
    const byDay = shared.get(p.campaign_id) ?? shared.set(p.campaign_id, new Map()).get(p.campaign_id)!;
    let r = byDay.get(k);
    if (!r) byDay.set(k, (r = resolvePost(p, ctx, tw ?? [])));
    out.set(p.id, r);
  }
  return out;
}

/**
 * Only 「这个岗位还能投吗」, for many posts: the matcher's candidates, 机会缺口, position.list's 在招 filter.
 * `every`: these are all the posts not closed (the matcher). That answer is kept; afterwards only the posts of companies
 * where something it depends on has changed since are worked out again, by every caller — after a day's reads that is a
 * handful of companies, not 115,000 posts. `twins`: how the caller can group every post itself, asked for only when the
 * whole answer has to be worked out.
 */
export function expiredMany(db: Db, posts: (PostRow & { company_id: string })[], opts: { every?: boolean; twins?: () => Map<string, GroupPost[]> } = {}): Map<string, boolean> {
  const k = tracked(db), day = beijingDay();
  const kept = k.day === day && !k.all ? k.expired : null;
  if (!kept) {
    const r = resolveMany(db, posts, opts.twins?.()), out = new Map<string, boolean>();
    for (const p of posts) out.set(p.id, !!r.get(p.id)?.expired);
    if (opts.every) { k.day = day; k.all = false; k.dirty.clear(); k.expired = out; }
    return out;
  }
  // a post closed since keeps its old answer here: nobody asks about a closed post, and reopening it marks its company
  const stale = posts.filter((p) => !kept.has(p.id) || (k.dirty.size > 0 && k.dirty.has(p.company_id)));
  if (!stale.length) return kept;
  const fresh = resolveMany(db, stale);
  if (opts.every) { for (const p of stale) kept.set(p.id, !!fresh.get(p.id)?.expired); k.dirty.clear(); return kept; }
  const out = new Map<string, boolean>();
  for (const p of posts) out.set(p.id, fresh.has(p.id) ? !!fresh.get(p.id)!.expired : kept.get(p.id)!);
  return out;
}

/**
 * Which companies something `expired` reads has changed for, on this connection: a post's title, cities, status, watch,
 * own day or batch; a batch's company, kind, cohort or deadline columns; an application; a deadline fact; the person's
 * word — everything resolvePost reads is the post's own company's. Most writes touch none of it (a read of a source that
 * found the same posts only marks them seen, ADR-063). Temporary triggers report the company; one they cannot name, or
 * triggers lost with a rolled-back transaction (checked each time, put back), makes the whole answer stale.
 */
interface Kept { day: string; all: boolean; dirty: Set<string>; expired: Map<string, boolean> | null }
const keptOpen = new WeakMap<Db, Kept>();
const companyOfPost = (p: string) => `(select c.company_id from position p join campaign c on c.id = p.campaign_id where p.id = ${p})`;
const companyOfSubject = (r: string) => `(case ${r}.subject_type when 'company' then ${r}.subject_id when 'campaign' then (select company_id from campaign where id = ${r}.subject_id) when 'position' then ${companyOfPost(`${r}.subject_id`)} end)`;
const changed = (cols: string[]) => cols.map((c) => `old.${c} is not new.${c}`).join(" or ");
const POST_COLS = ["title", "cities", "status", "watch_priority", "closes_at", "campaign_id"];
const CAMPAIGN_COLS = ["company_id", "kind", "cohort", "closes_at", "deadline_kind", "deadline_text", "source_grade", "source_kind", "apply_url", "notice_url"];
const ofCampaign = (r: string) => `(select company_id from campaign where id = ${r}.campaign_id)`;
const DEADLINE_INPUTS: [string, string, string[]][] = [
  ["p_new", "after insert on main.position", [ofCampaign("new")]],
  ["p_gone", "after delete on main.position", [ofCampaign("old")]],
  ["p_upd", `after update of ${POST_COLS.join(", ")} on main.position when ${changed(POST_COLS)}`, [ofCampaign("old"), ofCampaign("new")]],
  ["c_new", "after insert on main.campaign", ["new.company_id"]],
  ["c_gone", "after delete on main.campaign", ["old.company_id"]],
  ["c_upd", `after update of ${CAMPAIGN_COLS.join(", ")} on main.campaign when ${changed(CAMPAIGN_COLS)}`, ["old.company_id", "new.company_id"]],
  ["a_new", "after insert on main.application", [companyOfPost("new.position_id")]],
  ["a_gone", "after delete on main.application", [companyOfPost("old.position_id")]],
  ["a_upd", "after update on main.application", [companyOfPost("old.position_id"), companyOfPost("new.position_id")]],
  ...["deadline_fact", "deadline_override"].flatMap((t, i): [string, string, string[]][] => [
    [`${i}_new`, `after insert on main.${t}`, [companyOfSubject("new")]],
    [`${i}_gone`, `after delete on main.${t}`, [companyOfSubject("old")]],
    [`${i}_upd`, `after update on main.${t}`, [companyOfSubject("old"), companyOfSubject("new")]],
  ]),
];
/** The companies marked changed since the matcher last asked about every post (what the next callers work out again). */
export const changedCompanies = (db: Db): ReadonlySet<string> => tracked(db).dirty;

function tracked(db: Db): Kept {
  let k = keptOpen.get(db);
  if (!k) {
    const kept: Kept = (k = { day: "", all: true, dirty: new Set(), expired: null });
    keptOpen.set(db, kept);
    db.function("jobos_deadline_inputs_changed", (company) => { if (typeof company === "string") kept.dirty.add(company); else kept.all = true; return null; });
  }
  const have = (db.prepare("select count(*) n from sqlite_temp_master where type = 'trigger' and name like 'jobos_dl_%'").get() as { n: number }).n;
  if (have < DEADLINE_INPUTS.length) {
    for (const [name, when, companies] of DEADLINE_INPUTS) db.exec(`create temp trigger if not exists jobos_dl_${name} ${when} begin ${companies.map((c) => `select jobos_deadline_inputs_changed(${c});`).join(" ")} end`);
    k.all = true;
  }
  return k;
}

/** Resolve posts by id (a tool answer). */
export function resolveFor(db: Db, positionIds: string[]): Map<string, Resolution> {
  const posts: (PostRow & { company_id: string })[] = [];
  for (let i = 0; i < positionIds.length; i += 5000) {
    const part = positionIds.slice(i, i + 5000);
    posts.push(...(db.prepare(`select p.id, p.campaign_id, p.closes_at, c.company_id from position p join campaign c on c.id = p.campaign_id where p.id in (${part.map(() => "?").join(",")})`).all(...part) as unknown as (PostRow & { company_id: string })[]));
  }
  return resolveMany(db, posts);
}

/**
 * 项目层说法 — what a batch goes by for a post with nothing of its own: the person's word on it (or on a batch of the
 * same drive, or on the company's campus hiring), else what the sources say of it and of its same-drive batches. It
 * answers 「这家公司还有能投的入口吗」 (线索补全, 待展开: any batch whose saying has not passed) and picks the batch the
 * pool's company line and its 「其他来源写的截止」 go by.
 */
export const campaignSaying = (ctx: ResolveContext, campaignId: string): Resolution => resolvePost({ id: "", campaign_id: campaignId, closes_at: null }, ctx);

/** Batches still open by their 项目层说法 (of these companies, or all). */
export function openCampaigns(db: Db, companyIds?: string[]): Set<string> {
  const ctx = loadContext(db, companyIds);
  return new Set([...ctx.campaigns.keys()].filter((id) => !campaignSaying(ctx, id).expired));
}

/**
 * The person's own day for a batch, else the source's — what position.get has always called `campaignClosesAt`. Their
 * word lives in deadline_override only (the old campaign.closes_at_override columns are no longer written or read).
 */
export function campaignClosesAt(db: Db, campaignId: string, sourceDate: string | null): string | null {
  const o = db.prepare("select kind, date from deadline_override where subject_type = 'campaign' and subject_id = ?").get(campaignId) as { kind: string; date: string | null } | undefined;
  return o ? (o.kind === "date" ? o.date : null) : sourceDate;
}

// ---------- writing ----------
export interface FactInput { positionId?: string; campaignId?: string; companyId?: string; event?: DeadlineEvent; policy: Policy; date?: string; dateStart?: string; precision?: Precision; applies?: Applies; grade: string; sourceKind?: string; url?: string; evidence: string; by?: string; /** the announcement check it came from (notice.ts) */ checkId?: string }

/**
 * Record what a source said. The evidence sentence is required: a deadline with no words behind it is a guess. The same
 * statement about the same subject is stored once; a new statement from the same source page replaces that page's old one.
 */
export function recordFact(db: Db, p: FactInput): { id: string; created: boolean } {
  const subjectType = p.positionId ? "position" : p.campaignId ? "campaign" : p.companyId ? "company" : null;
  const subjectId = p.positionId ?? p.campaignId ?? p.companyId;
  if (!subjectType || !subjectId) throw new DomainError("MISSING_FIELD", "要说明这是哪个岗位、招聘项目或公司的截止");
  if (!db.prepare(`select 1 from ${subjectType} where id = ?`).get(subjectId)) throw new NotFound(`${subjectType} ${subjectId}`);
  if (!p.evidence?.trim()) throw new DomainError("MISSING_FIELD", "需要原文证据句（来源页面上怎么写的）");
  if (!(p.grade in GRADE_RANK) || p.grade === "本人") throw new DomainError("BAD_GRADE", "grade 为 官方 / 校方转载 / 聚合；本人的判断用 campaign.deadline");
  const event = p.event ?? "application_close";
  const dated = p.policy === "date" || p.policy === "date_or_until_filled";
  if (event === "application_close" && dated && !/^\d{4}-\d{2}-\d{2}/.test(p.date ?? "")) throw new DomainError("BAD_DATE", "具体截止要给 date（YYYY-MM-DD；「12 月底」写 date=12-31、precision=month_end）");
  const applies = p.applies ?? (subjectType === "position" ? "this_position" : "all_campaign_positions");
  const hash = createHash("sha256").update([event, p.policy, p.dateStart ?? "", p.date ?? "", p.precision ?? "day", applies, p.grade, p.url ?? "", p.evidence.trim()].join("|")).digest("hex").slice(0, 32);
  // the same page saying something new about the same subject, event and reach: its earlier statement no longer stands.
  // What it says of another reach (all of a batch's posts vs. one post) is a different statement and stays.
  const supersedeOthers = (keep: string) => { if (p.url) db.prepare("update deadline_fact set superseded_at = ? where subject_type = ? and subject_id = ? and event = ? and url = ? and applies = ? and superseded_at is null and id != ?").run(now(), subjectType, subjectId, event, p.url, applies, keep); };
  const dup = db.prepare("select id from deadline_fact where subject_type = ? and subject_id = ? and content_hash = ?").get(subjectType, subjectId, hash) as { id: string } | undefined;
  if (dup) {
    // A → B → A: A stands again and B, which had replaced it, no longer does
    db.prepare("update deadline_fact set superseded_at = null, check_id = coalesce(?, check_id) where id = ?").run(p.checkId ?? null, dup.id);
    supersedeOthers(dup.id);
    return { id: dup.id, created: false };
  }
  supersedeOthers("");
  const id = ulid();
  db.prepare("insert into deadline_fact(id, subject_type, subject_id, event, policy, date_start, date_end, precision, applies, grade, source_kind, url, evidence, content_hash, by, created_at, check_id) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, subjectType, subjectId, event, p.policy, p.dateStart ?? null, dated || event !== "application_close" ? (p.date ?? null) : null, p.precision ?? "day", applies, p.grade, p.sourceKind ?? "", p.url ?? "", p.evidence.trim().slice(0, 600), hash, p.by ?? "", now(), p.checkId ?? null);
  return { id, created: true };
}

/** The person's own word about a post, a batch or a company: a date, 招满即止, 无固定截止, or taking the word back. */
export function setOverride(db: Db, p: { subjectType: "position" | "campaign" | "company"; subjectId: string; kind: "date" | "until_filled" | "rolling" | "no_fixed_date" | "unknown" | "clear"; date?: string; note?: string; by?: string }): void {
  if (p.kind === "clear") { db.prepare("delete from deadline_override where subject_type = ? and subject_id = ?").run(p.subjectType, p.subjectId); return; }
  if (p.kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(p.date ?? "")) throw new DomainError("BAD_DATE", "日期要写成 YYYY-MM-DD");
  db.prepare("insert or replace into deadline_override(subject_type, subject_id, kind, date, note, by, at) values (?,?,?,?,?,?,?)").run(p.subjectType, p.subjectId, p.kind, p.kind === "date" ? p.date! : null, p.note ?? "", p.by ?? "", now());
}
