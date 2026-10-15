import type { Services } from "../registry.js";
import { json, now } from "../db.js";
import { label } from "../recommenders/fit.js";
import { expiredMany } from "./deadlines.js";

/**
 * 机会缺口 (ADR-035), the read side: every requirement the rules could not confirm on a task-related post, grouped by
 * concept. Counts are posts and distinct companies (a group's forty look-alike posts stay one company). Only posts the
 * user's work relates to (A ≥ 30) count, so 「缺 Java」 never shows up from unrelated jobs. What the user says about a
 * concept (gap.confirm) is the only negative the matcher ever uses; "没做过" here is a project-experience gap, not
 * "does not know".
 */
export interface GapRow { conceptId: string; label: string; status: "unknown" | "transferable" | "gap"; positions: number; companies: number; core: number; examples: { positionId: string; title: string; company: string; tier: string; quote: string }[] }

export function listGaps(s: Services, q: { minA?: number } = {}): { items: GapRow[]; assessed: number; related: number } {
  const all = s.domain.db.prepare(`select a.position_id, a.position_id id, p.campaign_id, p.closes_at, a.json, p.title, co.name company, c.company_id from position_assessment a
    join position p on p.id = a.position_id join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id
    where p.status != 'closed'`).all() as any[];
  // posts still open by the resolver, as the matcher counts them (ADR-041)
  const expired = expiredMany(s.domain.db, all);
  const rows = all.filter((r) => !expired.get(r.id));
  const minA = q.minA ?? 30;
  const acc = new Map<string, GapRow & { cos: Set<string> }>();
  let related = 0;
  for (const r of rows) {
    const a = json.parse(r.json, {} as any);
    if ((a.A ?? 0) < minA || !Array.isArray(a.judgements)) continue;
    related++;
    const seen = new Set<string>();
    for (const j of a.judgements) {
      if (j.modality !== "required" || j.status === "supported") continue;
      for (const id of j.concepts) {
        const key = `${id}|${j.status}`;
        if (seen.has(key)) continue; // one post counts once per concept
        seen.add(key);
        const row = acc.get(key) ?? acc.set(key, { conceptId: id, label: label(id), status: j.status, positions: 0, companies: 0, core: 0, examples: [], cos: new Set() }).get(key)!;
        row.positions++; row.cos.add(r.company_id);
        if (j.importance === "core") row.core++;
        if (row.examples.length < 5) row.examples.push({ positionId: r.position_id, title: r.title, company: r.company, tier: a.tier, quote: j.quote });
      }
    }
  }
  const items = [...acc.values()].map(({ cos, ...row }) => ({ ...row, companies: cos.size })).sort((x, y) => y.core - x.core || y.companies - x.companies || y.positions - x.positions); // what blocks most as a core requirement first, then breadth
  return { items, assessed: rows.length, related };
}

export function confirmGap(s: Services, p: { conceptId: string; status: "confirmed" | "cleared"; note?: string }) {
  if (p.status === "cleared") s.domain.db.prepare("delete from user_gap where concept_id = ?").run(p.conceptId);
  else s.domain.db.prepare("insert into user_gap(concept_id, status, note, created_at) values (?,?,?,?) on conflict(concept_id) do update set status = excluded.status, note = excluded.note, created_at = excluded.created_at").run(p.conceptId, "confirmed", p.note ?? "", now());
  s.onDataChanged?.(); // the matcher reruns with the new negative
  return { ok: true, conceptId: p.conceptId, label: label(p.conceptId), status: p.status };
}
