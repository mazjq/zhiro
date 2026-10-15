import { ulid } from "ulid";
import type { Services } from "../registry.js";
import { now, tx } from "../db.js";
import { NotFound } from "../service/domain.js";
import { profileMatch } from "./profile-match.js";
import { expand } from "./expand.js";
import { listPresets, runPreset } from "./preset.js";
import { loadContext } from "./common.js";

export interface Hit { companyId: string; positionId?: string; score: number; reason: string }

/**
 * A recommendation mode (ADR-016). Same shape as sources/: one file, one line in `recommenders` below.
 * A mode owns exactly one tag; re-running it replaces its own rows and nothing else.
 * `auto` modes are cheap and deterministic, so they re-run whenever the position pool changes.
 */
export interface Recommender {
  id: string;
  tag: string;
  describe: string;
  auto: boolean;
  run(s: Services, params: Record<string, unknown>): Promise<Hit[]> | Hit[];
}

export const recommenders: Record<string, Recommender> = { [profileMatch.id]: profileMatch, [expand.id]: expand };

export async function runRecommender(s: Services, mode: string, params: Record<string, unknown> = {}) {
  const r = recommenders[mode];
  if (!r) throw new NotFound(`recommender ${mode}`);
  const hits = await r.run(s, params);
  const db = s.domain.db, runId = ulid(), t = now();
  tx(db, () => {
    db.prepare("delete from recommendation where mode = ?").run(mode);
    const ins = db.prepare("insert or ignore into recommendation(id, company_id, position_id, mode, tag, score, reason, run_id, created_at) values (?,?,?,?,?,?,?,?,?)");
    for (const h of hits) ins.run(ulid(), h.companyId, h.positionId ?? "", mode, r.tag, h.score, h.reason, runId, t);
  });
  return { mode, tag: r.tag, hits: hits.length, companies: new Set(hits.map((h) => h.companyId)).size };
}

/** Called when the pool changes (scan, capture, import). A mode that can't run yet (empty profile) is skipped. */
export async function rerunAuto(s: Services): Promise<void> {
  // each step blocks the event loop for up to a second: yield in between so page requests are not queued behind all of them
  const breathe = () => new Promise((r) => setImmediate(r));
  for (const r of Object.values(recommenders)) if (r.auto) { await runRecommender(s, r.id).catch(() => {}); await breathe(); }
  const presets = listPresets(s);
  if (presets.length) { const ctx = loadContext(s); for (const p of presets) runPreset(s, p, ctx); }
}

export function tagCompany(s: Services, p: { companyId?: string; companyName?: string; tag: string; reason?: string; score?: number }) {
  const db = s.domain.db;
  const co = (p.companyId ? db.prepare("select id from company where id = ?").get(p.companyId) : db.prepare("select id from company where name = ? or aliases like ?").get(p.companyName ?? "", `%${JSON.stringify(p.companyName ?? "")}%`)) as { id: string } | undefined;
  if (!co) throw new NotFound(`company ${p.companyId ?? p.companyName}（不在岗位库中）`);
  db.prepare("insert into recommendation(id, company_id, position_id, mode, tag, score, reason, run_id, created_at) values (?,?,'','manual',?,?,?,'',?) on conflict(company_id, position_id, mode, tag) do update set score = excluded.score, reason = excluded.reason")
    .run(ulid(), co.id, p.tag, p.score ?? 5, p.reason ?? "", now());
  // 重点 (never auto-applied, sorted first) and 不投 (skipped everywhere) exclude each other (ADR-036)
  if (p.tag === "重点" || p.tag === "不投") db.prepare("delete from recommendation where company_id = ? and mode = 'manual' and tag = ?").run(co.id, p.tag === "重点" ? "不投" : "重点");
  return { ok: true, companyId: co.id };
}
