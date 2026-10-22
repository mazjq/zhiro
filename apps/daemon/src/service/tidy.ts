import type { Services } from "../registry.js";
import { tx } from "../db.js";
import { sources } from "../data/index.js";
import { unitIndex, unitKey } from "./same-company.js";
import { poolDirty } from "./pool.js";

/**
 * Evidence-based tidying (user, 2026-10-01: "don't make me click merge — merge yourself once there is real evidence").
 * Two things the pool gets wrong on its own, each fixed only on evidence the data itself holds:
 *  1. A pull subscription that was pruned (the same site is subscribed under another company) leaves its campaigns
 *     behind — 中核's group site showed its 700 posts under three subsidiaries. Those campaigns are copies: dropped,
 *     unless a person watched or applied to one of their posts.
 *  2. Two company rows that are one unit under the sheet's and the site's spellings (unitKey) where exactly one carries
 *     an official source: the spelling without one is an alias of it and is merged in (aliases kept, audit written).
 *     Two rows that both have official sources are two legal entities and stay apart.
 */
/** One side of a proposed merge, as a person needs it to decide. */
export interface MergeSide { id: string; name: string; exists: boolean; positions: number; official: boolean; sources: string[] }
export interface MergeEvidence { from: MergeSide; into: MergeSide; signals: string[]; strong: boolean; stale: string }

/**
 * What the data says about merging `from` into `into`. Strong evidence (merge without asking): both companies post on
 * the same recruiting page (an apply / notice URL that no third company uses — a shared 汇总表 link is not evidence), or
 * one unit spelled two ways (unitKey) where only one side has an official source. A name that merely contains the other
 * is shown, never acted on: 东风汽车集团 and 东风汽车股份 are two employers.
 */
export function mergeEvidence(db: Services["domain"]["db"], fromId: string, intoId: string): MergeEvidence {
  const side = (id: string): MergeSide => {
    const c = db.prepare("select name from company where id = ?").get(id) as { name: string } | undefined;
    if (!c) return { id, name: "", exists: false, positions: 0, official: false, sources: [] };
    const cs = db.prepare("select source_kind, source_grade from campaign where company_id = ?").all(id) as { source_kind: string; source_grade: string }[];
    const positions = (db.prepare("select count(*) n from position p join campaign c on c.id = p.campaign_id where c.company_id = ? and p.status != 'closed'").get(id) as { n: number }).n;
    return { id, name: c.name, exists: true, positions, official: cs.some((x) => x.source_grade === "官方"), sources: [...new Set(cs.map((x) => x.source_kind))] };
  };
  const from = side(fromId), into = side(intoId);
  const signals: string[] = [];
  if (!from.exists || !into.exists) return { from, into, signals, strong: false, stale: `${!from.exists ? "被并的" : "保留的"}公司已不在库里（之前已合并或删除）` };
  if (fromId === intoId) return { from, into, signals, strong: false, stale: "是同一家公司" };
  const urls = (id: string) => new Set((db.prepare("select apply_url u from campaign where company_id = ? and apply_url != '' union select notice_url from campaign where company_id = ? and notice_url != ''").all(id, id) as { u: string }[]).map((r) => r.u.split("#")[0]));
  const a = urls(fromId), b = urls(intoId);
  const shared = [...a].filter((u) => b.has(u) && (db.prepare("select count(distinct company_id) n from campaign where (apply_url like ? or notice_url like ?)").get(u + "%", u + "%") as { n: number }).n <= 2);
  if (shared.length) signals.push(`两家挂在同一个招聘页：${shared[0]}`);
  const sameUnit = unitKey(from.name) === unitKey(into.name) && unitKey(from.name).length >= 3;
  if (sameUnit) signals.push("同一单位的两种写法（集团简称 / 中文数字 / 研究所写法统一后相同）");
  const norm = (n: string) => n.normalize("NFKC").replace(/[（(][^）)]*[）)]/g, "").replace(/(股份)?有限(责任)?公司|集团/g, "").replace(/\s+/g, "");
  if (!sameUnit && (norm(into.name).includes(norm(from.name)) || norm(from.name).includes(norm(into.name))) && Math.min(norm(from.name).length, norm(into.name).length) >= 2) signals.push("一个名字包含另一个（只作参考，不自动合并）");
  const strong = shared.length > 0 || (sameUnit && from.official !== into.official);
  return { from, into, signals, strong, stale: "" };
}

/** Pending merge proposals (an agent's suggestions): stale ones expire, strongly evidenced ones are carried out. */
export function resolveMergeProposals(s: Services): { merged: string[]; expired: string[] } {
  const db = s.domain.db, merged: string[] = [], expired: string[] = [];
  for (const p of db.prepare("select id, payload_json from proposal where kind = 'company.merge' and decision = 'pending'").all() as { id: string; payload_json: string }[]) {
    const x = JSON.parse(p.payload_json), e = mergeEvidence(db, x.fromId, x.intoId);
    if (e.stale) {
      db.prepare("update proposal set decision = 'expired', decided_at = ?, result_json = ? where id = ?").run(new Date().toISOString(), JSON.stringify({ reason: e.stale }), p.id);
      expired.push(`${e.from.name || "?"} → ${e.into.name || "?"}`);
    } else if (e.strong) {
      try {
        const r = s.domain.mergeCompany(x.fromId, x.intoId);
        db.prepare("update proposal set decision = 'approved', decided_at = ?, result_json = ? where id = ?").run(new Date().toISOString(), JSON.stringify({ ...r, by: "system", evidence: e.signals }), p.id);
        s.domain.audit("system", "company.merge", { ...x, evidence: e.signals, proposal: p.id }, true, `${e.from.name} → ${e.into.name}`);
        merged.push(`${e.from.name} → ${e.into.name}`);
      } catch { /* left for the person */ }
    }
  }
  return { merged, expired };
}

/**
 * The campaigns a subscription that no longer exists had fed (all such subscriptions, or just `only`): dropped, unless
 * another subscription feeds them too or a person watched / applied to one of their posts.
 */
export function dropOrphanCampaigns(s: Services, only?: string): number {
  const db = s.domain.db;
  const configured = new Set(s.config.sources.map((c) => c.id));
  const pullKinds = new Set(Object.values(sources).filter((x) => x.mode === "pull").map((x) => x.id));
  // source_listing.provider is the reader kind; the subscription id is in the snapshot name: <timestamp 24 chars>-<configId>.json
  const configIdOf = (path: string) => { const base = path.split(/[\\/]/).pop() ?? ""; return base.length > 30 ? base.slice(25).replace(/\.json$/, "") : ""; };
  // snapshot paths are few (≤ 7 per subscription); listing rows are many — group by path first
  const paths = db.prepare("select content_path path, min(provider) provider from source_listing where content_path != '' group by content_path").all() as { path: string; provider: string }[];
  const gone = new Map<string, string>(), mine: string[] = []; // subscription id → reader kind; their snapshot paths
  for (const p of paths) { const id = configIdOf(p.path); if (id && pullKinds.has(p.provider) && !configured.has(id) && (!only || id === only)) { gone.set(id, p.provider); mine.push(p.path); } }
  // a subscription removed or switched off lists nothing any more: its claims go, so the others' full reads can close
  // what it alone kept open (B34) — whether or not it left listing rows of its own
  const live = new Set(s.config.sources.filter((c) => c.enabled !== false).map((c) => c.id));
  const unclaim = db.prepare("delete from position_seen where config_id = ?");
  const claimedBy = db.prepare("select distinct p.campaign_id id from position_seen s join position p on p.id = s.position_id where s.config_id = ?");
  const released: string[] = []; // the campaigns they claimed posts of: checked like the ones their listing rows name
  for (const { id } of db.prepare("select distinct config_id id from position_seen").all() as { id: string }[]) {
    if (live.has(id) || (only && id !== only)) continue;
    released.push(...(claimedBy.all(id) as { id: string }[]).map((r) => r.id));
    unclaim.run(id);
  }
  if (!mine.length && !released.length) return 0;

  // Whole sets per statement, every gone subscription in one transaction: the cost is a few passes over the listing
  // table however many campaigns or subscriptions there are. Going campaign by campaign took 19 minutes, the daemon
  // answering nothing, for a sheet of 1 万 campaigns / 8.8 万 posts; subscription by subscription still took 10 s for
  // the 28 the real library had waiting at start (2026-10-13). Deleting a post or a campaign makes SQLite look up what
  // still points at it, so source_listing needs its indexes on position_id and campaign_id (migrations v29, v30).
  db.exec("create temp table if not exists gone_path (path text primary key); create temp table if not exists gone_campaign (id text primary key)");
  const posts = "select id from position where campaign_id in (select id from gone_campaign)";
  const droppedCampaigns = tx(db, () => {
    db.exec("delete from gone_path; delete from gone_campaign");
    const add = db.prepare("insert into gone_path values (?)");
    for (const p of mine) add.run(p);
    // a campaign something else still feeds (another subscription, a captured page — by the campaign or by one of its
    // posts) is alive; one a person holds a post of (关注, an application) stays whoever fed it
    const cand = db.prepare("insert or ignore into gone_campaign values (?)");
    for (const id of released) cand.run(id);
    db.exec(`insert or ignore into gone_campaign select distinct campaign_id from source_listing where campaign_id is not null and content_path in (select path from gone_path);
      delete from source_listing where campaign_id is not null and content_path in (select path from gone_path);
      delete from gone_campaign where id in (select campaign_id from source_listing where campaign_id is not null)
        or id in (select p.campaign_id from source_listing l join position p on p.id = l.position_id)
        or id in (select p.campaign_id from position_seen s join position p on p.id = s.position_id)
        or id in (select campaign_id from position where watch_priority > 0)
        or id in (select p.campaign_id from application a join position p on p.id = a.position_id)
        or id in (select campaign_id from application where campaign_id is not null);
      delete from position_fit where position_id in (${posts}); delete from position_assessment where position_id in (${posts});
      delete from recommendation where position_id in (${posts});
      delete from position where campaign_id in (select id from gone_campaign)`);
    return Number(db.prepare("delete from campaign where id in (select id from gone_campaign)").run().changes);
  });
  if (droppedCampaigns) s.domain.audit("system", "pool.tidy", { subscriptions: [...gone].map(([id, provider]) => `${provider}:${id}`).slice(0, 50), gone: gone.size }, true, `orphan subscriptions: ${droppedCampaigns} campaigns dropped`);
  return droppedCampaigns;
}

export function tidyPool(s: Services): { droppedCampaigns: number; merged: { from: string; into: string }[] } {
  const db = s.domain.db;
  const droppedCampaigns = dropOrphanCampaigns(s);

  const merged: { from: string; into: string }[] = [];
  const official = db.prepare("select 1 from campaign where company_id = ? and source_grade = '官方' limit 1");
  for (const cos of unitIndex(db).values()) {
    if (cos.length < 2) continue;
    const withOfficial = cos.filter((c) => official.get(c.id));
    if (withOfficial.length !== 1) continue;
    const into = withOfficial[0];
    for (const from of cos) {
      if (from.id === into.id) continue;
      try {
        s.domain.mergeCompany(from.id, into.id);
        s.domain.audit("system", "company.merge", { fromId: from.id, intoId: into.id, evidence: "同一单位两种写法；只有一方有官方来源" }, true, `${from.name} → ${into.name}`);
        merged.push({ from: from.name, into: into.name });
      } catch { /* a merge that cannot happen (already gone) is not an error here */ }
    }
  }
  const fromProposals = resolveMergeProposals(s);
  for (const m of fromProposals.merged) { const [from, into] = m.split(" → "); merged.push({ from, into }); }
  if (droppedCampaigns || merged.length) { poolDirty(); s.onDataChanged?.(); }
  return { droppedCampaigns, merged };
}
