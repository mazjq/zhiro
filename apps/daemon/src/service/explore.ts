import type { Services } from "../registry.js";
import { listPool } from "./pool.js";

/**
 * 探索候选 (ADR-036 第二块, first cut): which posts the exploration line may take, by the rules the user set —
 * only 可迁移 posts that pass every hard expectation, at companies marked neither 重点 nor 不投, never a company with a
 * single post, at most MAX_PER_COMPANY a season minus what was already applied there (one slot always stays for a
 * 重点 post). How many applications a company allows is not known yet: it is reported as 待核实, not guessed.
 */
export const MAX_PER_COMPANY = 2;
export const RESERVED_SLOTS = 1;

export interface Candidate {
  companyId: string; companyName: string; positionId: string; title: string; cities: string[]; closesAt: string | null;
  why: string; prefScore: number; usedThisSeason: number; slots: number; quota: number | null; note: string;
}

/** Pure selection over pool rows; `applied` = applications per company this season. Exported for tests. */
export function pickCandidates(rows: any[], applied: Map<string, number>): Candidate[] {
  const out: Candidate[] = [];
  for (const c of rows) {
    if (c.tags?.some((t: any) => t.tag === "重点" || t.tag === "不投")) continue;
    if (c.expired || (c.positions?.length ?? 0) < 2) continue; // a single post = a single slot, and that one is reserved
    const used = applied.get(c.companyId) ?? 0;
    const slots = Math.max(0, Math.min(MAX_PER_COMPANY, c.positions.length - RESERVED_SLOTS) - used);
    if (!slots) continue;
    const posts = c.positions
      .filter((p: any) => p.match && /^可迁移/.test(p.match.reason) && !p.watched && !p.applicationState && (!p.expectation || p.expectation.status === "pass"))
      .sort((a: any, b: any) => (b.expectation?.score ?? 0) - (a.expectation?.score ?? 0) || (b.match?.score ?? 0) - (a.match?.score ?? 0) || String(a.closesAt ?? "9").localeCompare(String(b.closesAt ?? "9")))
      .slice(0, slots);
    for (const p of posts) out.push({
      companyId: c.companyId, companyName: c.companyName, positionId: p.id, title: p.title, cities: [...new Set<string>(p.cities ?? [])], closesAt: p.closesAt ?? c.closesAt ?? null,
      why: p.match.reason, prefScore: p.expectation?.score ?? 0, usedThisSeason: used, slots, quota: null,
      note: "该公司每人最多可投几个岗位未核实（待调研）；探索线只会停在提交页，提交由本人点",
    });
  }
  return out.sort((a, b) => b.prefScore - a.prefScore || String(a.closesAt ?? "9").localeCompare(String(b.closesAt ?? "9")));
}

export function exploreCandidates(s: Services, q: { limit?: number } = {}) {
  const db = s.domain.db;
  // ponytail: the season is a date in config (season.since); a cohort-aware calendar is the upgrade
  const since = s.config.season?.since ?? new Date(Date.now() - 180 * 86400_000).toISOString().slice(0, 10);
  const applied = new Map<string, number>();
  for (const r of db.prepare("select c.company_id id, count(*) n from application a join position p on p.id = a.position_id join campaign c on c.id = p.campaign_id where a.state != 'cancelled' and a.created_at >= ? group by c.company_id").all(since) as any[]) applied.set(r.id, r.n);
  const { items } = listPool(db, { recommendedOnly: true, minTier: "可迁移", hideExpectationFail: true, limit: 5000, sort: "match" });
  const all = pickCandidates(items, applied);
  return { season: s.config.season?.key ?? "", since, total: all.length, items: all.slice(0, q.limit ?? 50) };
}
