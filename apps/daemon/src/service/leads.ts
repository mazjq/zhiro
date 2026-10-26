import { isAggregate, isNotices } from "../data/index.js";
import type { Services } from "../services.js";
import { entryOf } from "../recommenders/expand.js";
import { capture } from "./capture.js";
import { withPurpose } from "./usage.js";
import { loadContext, campaignSaying } from "./deadlines.js";

/**
 * 待补资料 leads (ADR-035): a sheet row or a one-line post says a company on the user's direction is hiring, but not
 * which jobs. Readable career sites are already pulled by official.ts; what is left is an announcement page (公众号 …)
 * the model has to read — one capture per page, ~1–2k tokens. This resolves the most relevant leads first, within a
 * daily budget, and never the same page twice in a week. ponytail: relevance = the lead's own score (task-related
 * before major-related) then the nearest deadline; a company-tier weighting is the upgrade.
 */
export interface Lead { companyId: string; companyName: string; score: number; reason: string; closesAt: string | null; url: string; entry: string; readable: boolean; attemptedAt: string | null }

export function listLeads(s: Services): Lead[] {
  const db = s.domain.db;
  const rows = db.prepare(`select r.company_id, co.name, max(r.score) score, r.reason from recommendation r join company co on co.id = r.company_id
    where r.mode = 'profile_match' and r.reason like '待补资料%' group by r.company_id order by score desc`).all() as any[];
  if (!rows.length) return [];
  // 「这家公司还有能投的入口吗」: its batches whose 项目层说法 has not passed (ADR-041; the person's later day counts)
  const ctx = loadContext(db, rows.length <= 500 ? rows.map((r) => r.company_id) : undefined);
  const links = db.prepare("select id, apply_url, notice_url, source_kind from campaign where company_id = ?");
  const attempted = db.prepare("select max(created_at) at from capture where url = ? and created_at >= datetime('now', '-7 days')");
  const out: Lead[] = [];
  for (const r of rows) {
    const cs = (links.all(r.company_id) as any[]).flatMap((c) => { const d = campaignSaying(ctx, c.id); return d.expired ? [] : [{ ...c, closes_at: d.date }]; });
    if (cs.some((c) => !isAggregate(c.source_kind) && !isNotices(c.source_kind) && c.source_kind !== "capture")) continue; // a site with a page per post already answers
    const urls = [...new Set(cs.flatMap((c) => [c.apply_url, c.notice_url]).filter(Boolean))] as string[];
    if (!urls.length) continue;
    const e = entryOf(urls);
    const url = e.url ?? urls.find((u) => /^https?:/.test(u)) ?? urls[0];
    out.push({ companyId: r.company_id, companyName: r.name, score: r.score, reason: r.reason, closesAt: cs.map((c) => c.closes_at).filter(Boolean).sort()[0] ?? null, url, entry: e.label, readable: e.readable, attemptedAt: (attempted.get(url) as any)?.at ?? null });
  }
  return out;
}

/** Read the next `budget` announcement pages the model has not seen this week; readable sites are official.ts's job. */
export async function resolveLeads(s: Services, budget = s.config.leads?.dailyBudget ?? 30, companyIds?: string[]) {
  const want = companyIds ? new Set(companyIds) : null;
  const todo = listLeads(s).filter((l) => (want ? want.has(l.companyId) : !l.attemptedAt) && !l.readable && /^https?:/.test(l.url))
    .sort((a, b) => b.score - a.score || Number(a.closesAt == null) - Number(b.closesAt == null) || String(a.closesAt).localeCompare(String(b.closesAt)))
    .slice(0, want ? 200 : budget);
  const results: { companyName: string; url: string; note: string; positions: number }[] = [];
  for (const l of todo) {
    try {
      const r = await withPurpose("lead.resolve", l.companyId, () => capture(s.domain, s.config.vault, { url: l.url }, s.llm));
      results.push({ companyName: l.companyName, url: l.url, note: r.note, positions: r.positionIds.length });
    } catch (e: any) {
      if (e?.code === "BUDGET_DEFERRED") { if (results.some((r) => r.positions)) s.onDataChanged?.(); throw e; } // the run sleeps until the allowance allows
      if (e?.code === "MODEL_DELEGATED") { results.push({ companyName: l.companyName, url: l.url, note: "等外部 agent 代答", positions: 0 }); break; } // the rest waits for the answer
      results.push({ companyName: l.companyName, url: l.url, note: String(e?.message ?? e).slice(0, 120), positions: 0 });
    }
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (results.some((r) => r.positions)) s.onDataChanged?.();
  return { attempted: results.length, positions: results.reduce((n, r) => n + r.positions, 0), results, remaining: Math.max(0, listLeads(s).filter((l) => !l.readable && !l.attemptedAt).length) };
}
