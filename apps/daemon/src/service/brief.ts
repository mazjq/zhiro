/**
 * The short form of the list tools (`detail: "brief"`, D-22): what an agent needs to decide and act, without the long
 * texts. Asked for explicitly — a call without `detail` gets exactly what it always got. Long text is one `position.get`
 * away. Measured on a copy of a real database (2026-10-15): position.list 20 posts 10,925 → about 3,500 tokens;
 * pool.list for one keyword about 1,065,000 → about 8,000 (every company used to carry all its posts).
 */
import type { Resolution } from "./deadlines.js";

/** Enough of a deadline to judge by: no source evidence, no list of conflicts (their number instead). Not known ≠ not expired. */
export function deadlineBrief(d: Resolution | null | undefined) {
  if (!d) return null;
  const known = d.policy !== "unknown" || !!d.date;
  return { closesAt: d.date, deadlineKind: d.policy, expired: known ? d.expired : null, status: d.status, say: d.say, conflictsCount: d.conflicts.length };
}

const omit = <T extends object>(o: T, keys: string[]) => Object.fromEntries(Object.entries(o).filter(([k]) => !keys.includes(k)));

/** position.list: the post without its description (position.get has it) and without the notice link. */
export function positionBrief(p: Record<string, any>) {
  return { ...omit(p, ["jdText", "noticeUrl"]), deadline: deadlineBrief(p.deadline) };
}

const EVENT_CHARS = 80;
const dropEmpty = (o: Record<string, unknown>) => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== "" && v != null));

/** application.list: what the application is and what comes next; the description and the full stage notes stay behind. */
export function applicationBrief(x: Record<string, any>) {
  const a = x.application;
  const e = x.lastEvent as { at: string; kind: string; detail: string } | null;
  return {
    // empty fields left out; campaignId / timestamps are in the full form
    application: dropEmpty({ id: a.id, positionId: a.positionId, state: a.state, closeReason: a.closeReason, channel: a.channel, resumeLabel: a.resumeLabel, submittedAt: a.submittedAt, nextAction: a.nextAction, nextActionAt: a.nextActionAt }),
    companyName: x.companyName, title: x.title, cities: x.cities, closesAt: x.closesAt, applyUrl: x.applyUrl,
    stages: (x.stages ?? []).map((s: any) => ({ id: s.id, kind: s.kind, scheduledAt: s.scheduledAt, result: s.result })),
    lastEvent: e ? { at: e.at, kind: e.kind, detail: e.detail.slice(0, EVENT_CHARS), truncated: e.detail.length > EVENT_CHARS } : null,
    deadline: deadlineBrief(x.deadline),
  };
}

const MATCHED_CAP = 50;
const OTHER_PREVIEWS = 3;
const TIER: Record<string, number> = { 优先考虑: 0, 可迁移: 1 };

/** One post in a company's short form. `expired` is always there: null = not known, which is not "still open". */
function postBrief(p: any, matchedBy?: string) {
  const d = deadlineBrief(p.deadline);
  return { ...dropEmpty({ id: p.id, title: p.title, matchedBy, cities: p.cities?.length ? p.cities : null, fit: p.fit?.verdict, applicationState: p.applicationState, watched: p.watched || null, closesAt: d?.closesAt, say: d?.say }), expired: d ? d.expired : null };
}

/**
 * pool.list (20 companies a page unless a limit is given), one company. Listed (compact; up to 50 — positionsLimit
 * raises it for one company — then matchedHasMore): every post whose title has all the search words (the search finds
 * a company by its name or a post title, pool.ts) and every post the profile matched, each saying which (matchedBy).
 * A few previews hid most of them (measured 2026-10-15). Other posts are counted; a company with none listed shows a
 * few. New names throughout: `positions` would read as "all of them". position.list({ companyId }) lists all.
 */
export function poolCompanyBrief(c: Record<string, any>, matchedCap = MATCHED_CAP, words: string[] = []) {
  const posts: any[] = c.positions ?? [];
  const titleHit = (p: any) => words.length > 0 && words.every((w) => String(p.title ?? "").toLowerCase().includes(w));
  const why = (p: any) => [titleHit(p) ? "岗位名" : "", p.match ? "画像" : ""].filter(Boolean).join("+");
  const rank = (p: any) => [TIER[p.fit?.verdict] ?? 2, p.deadline?.date ?? "9999", p.id] as const;
  const sorted = (xs: any[]) => [...xs].sort((a, b) => { const x = rank(a), y = rank(b); for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1; return 0; });
  const matched = sorted(posts.filter((p) => why(p))), others = posts.filter((p) => !why(p));
  const shownMatched = matched.slice(0, matchedCap), shownOthers = matched.length ? [] : sorted(others).slice(0, OTHER_PREVIEWS);
  return {
    ...omit(c, ["positions", "sources", "conflicts", "noticeUrl", "tags"]),
    tagNames: (c.tags ?? []).map((t: any) => t.tag), // the recommendation tags by name (the full form has each tag's mode and reason)
    sourcesCount: (c.sources ?? []).length,
    conflictsCount: (c.conflicts ?? []).length,
    matchedPositions: shownMatched.map((p) => postBrief(p, why(p))),
    matchedPositionsTotal: matched.length,
    matchedHasMore: matched.length > shownMatched.length,
    otherPositionPreviews: shownOthers.map((p) => postBrief(p)),
    otherPositionsTotal: others.length,
    allPositionsTotal: posts.length,
    positionsHasMore: posts.length > shownMatched.length + shownOthers.length,
  };
}
