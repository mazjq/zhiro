import { ulid } from "ulid";
import { mkdirSync, writeFileSync, readdirSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { json, now, tx } from "../db.js";
import type { Db } from "../db.js";
import { CatalogBatch, campaignKey, genericCompany, inChunks, type CampaignInput } from "./catalog.js";
import { parseDeadline } from "./sheet.js";
import { isAggregate } from "./readers/index.js";
import type { Listing } from "./types.js";

/**
 * The link a person opens for the whole campaign. Career sites are single-page apps whose route lives in the #fragment
 * ("…/168424#/jobs"), so the fragment stays — dropping it left Moka pages spinning on an empty route. Only a fragment that
 * points at one job ("#/job/<id>", from the Moka pull source) is swapped for the job list.
 */
export function campaignUrl(url: string): string {
  const hash = url.indexOf("#");
  const base = hash < 0 ? url : url.slice(0, hash), frag = hash < 0 ? "" : url.slice(hash + 1);
  const moka = base.includes("mokahr.com/campus-recruitment/") || base.includes("mokahr.com/social-recruitment/");
  if (frag.startsWith("/job/") || (moka && (frag === "" || frag === "/"))) return moka ? base + "#/jobs" : base;
  return url;
}

/** `updated`: posts, campaigns and companies already there whose content this run changed (a post back up counts; one only seen again does not) */
export interface IngestResult { runId: string; received: number; campaigns: number; positionsNew: number; positionsSeen: number; positionsClosed: number; updated: number; snapshotPath: string }
/** What this run listed: its campaigns, and the post of each of its listing rows, in listing order (not part of a tool's answer). */
export interface Listed { campaignIds: string[]; positionIds: string[] }

/**
 * The site's own id for a post, when it has one. A captured or extracted page numbers its posts by where they stand on
 * the page (`url#3`), a sheet has rows, not posts, and a reader with no id falls back to the link: none of those is a key.
 */
const sourceKey = (aggregate: boolean, l: Listing) => (aggregate || /#\d+$/.test(l.externalId) || l.externalId === l.url || l.externalId === l.title ? "" : l.externalId);

/** How long after claims began (v45) a post nobody has claimed may close: every daily subscription has read by then. */
export const CLAIMS_SETTLE_MS = 48 * 3600_000;

/**
 * A subscription that lists nothing any more (removed, switched off, dropped by a feed): the posts only it claimed
 * close as a full read listing nothing would close them (one the person watches or applied to stays as it was: the
 * subscription went, not the post), then its claims go. The campaigns
 * it claimed posts of are returned, for tidy's orphan check.
 */
export function releaseClaims(db: Db, configId: string): { campaigns: string[]; closed: number } {
  const campaigns = (db.prepare("select distinct p.campaign_id id from position_seen s join position p on p.id = s.position_id where s.config_id = ?").all(configId) as { id: string }[]).map((r) => r.id);
  const closed = Number(db.prepare(`update position set status = 'closed', updated_at = ? where status = 'open'
    and id in (select position_id from position_seen where config_id = ?)
    and not exists (select 1 from position_seen o where o.position_id = position.id and o.config_id != ?)
    and coalesce(watch_priority, 0) <= 0 and id not in (select position_id from application where state != 'cancelled')`).run(now(), configId, configId).changes);
  db.prepare("delete from position_seen where config_id = ?").run(configId);
  return { campaigns, closed };
}

/** A subscription's snapshots are named `<24-char time>-<configId>.json`; only its own, not another id that ends the same. */
const ownSnapshots = (dir: string, configId: string) => readdirSync(dir).filter((f) => f.slice(25) === `${configId}.json`).sort();
const SNAPSHOT_KEEP = 7;

/**
 * The immutable record of what the source returned. When it returned exactly what the subscription's last snapshot holds
 * (most days for most sources: the big sheet is 45 MB), that snapshot stands for this run too and nothing is written.
 */
function keepSnapshot(vault: string, sourceId: string, configId: string, listings: Listing[]): string {
  const dir = join(vault, "snapshots", sourceId);
  mkdirSync(dir, { recursive: true });
  const at = now(), body = JSON.stringify({ sourceId, configId, at, count: listings.length, listings }, null, 1);
  const prior = ownSnapshots(dir, configId);
  const last = prior.length ? join(dir, prior[prior.length - 1]) : "";
  // everything after the time stamp: the time is the same length every run, so equal files are equal in size first
  const tail = (s: string) => { const i = s.indexOf('\n "count"'); return i > 0 ? s.slice(i) : null; };
  try { if (last && statSync(last).size === Buffer.byteLength(body) && tail(readFileSync(last, "utf8")) === tail(body)) return last; } catch { /* unreadable: write a new one */ }
  const path = join(dir, `${at.replace(/[:.]/g, "-")}-${configId}.json`);
  writeFileSync(path, body, "utf8");
  // ponytail: keep the newest 7 snapshots per subscription; source_listing rows listed unchanged since an older one
  // keep its name (only the subscription id in it is read: tidy.ts). Archive instead of deleting if the history matters.
  for (const old of [...prior, path.slice(dir.length + 1)].sort().slice(0, -SNAPSHOT_KEEP)) rmSync(join(dir, old), { force: true });
  return path;
}

/**
 * The single write path for every source (pull or push):
 *  1. keep an immutable snapshot of what the source returned (observation) — a new one only when it differs from the last
 *  2. company → campaign → position, one source_listing row per listing (state) — written only where it changes (ADR-063)
 *  3. record a scan_run row (so "0 new" and "failed" stay distinguishable from "closed")
 * One transaction, all or nothing. Campaign identity: catalog.campaignKey; the rest of the identity rules: catalog.ts.
 */
export function ingest(store: { db: Db }, vault: string, sourceId: string, configId: string, listings: Listing[], opts: { complete?: boolean; error?: string; closeUnseen?: boolean; observedAt?: string; noSnapshot?: boolean; alsoSeen?: string[] } & ReadCost = {}): IngestResult & { listed: Listed } {
  const db = store.db;
  const runId = ulid();
  const started = now();
  // a feed's package is its own record (data/feed.ts): only the name is kept, no file is written outside the transaction
  const snapshotPath = opts.noSnapshot ? join(vault, "snapshots", sourceId, `${started.replace(/[:.]/g, "-")}-${configId}.json`) : keepSnapshot(vault, sourceId, configId, listings);

  // Campaign-level fields come from the whole group, not from whichever listing happens to be last:
  // one job without a deadline must not blank the deadline another job of the same campaign stated.
  type Whole = Omit<CampaignInput, "companyId" | "kind" | "applyUrl" | "noticeUrl" | "sourceGrade" | "lastVerifiedAt">;
  const groups = new Map<string, { listings: Listing[]; whole?: Whole }>();
  const groupOf = listings.map((l) => {
    const k = `${l.publisher}|${l.company}|${l.cohort ?? ""}|${l.batch ?? ""}`;
    const g = groups.get(k) ?? groups.set(k, { listings: [] }).get(k)!;
    g.listings.push(l);
    return g;
  });
  const filed = (l: Listing) => !!l.title && !!l.company && !genericCompany(l.company); // a row of nobody's is not filed (ADR-041)
  // what a campaign is, from its group: the same for every listing of it (kind, links and grade are each listing's own:
  // the campaign keeps its last listing's)
  const ofGroup = (g: { listings: Listing[]; whole?: Whole }, l: Listing): Whole => {
    let w = g.whole;
    if (!w) {
      const group = g.listings;
      const d = group.find((x) => x.validThrough || x.deadlineText) ?? l;
      // posts that each carry their own day (荣耀: 10-07 … 次年 08-18) have no one day for the batch: taking the first
      // would hand an early date to every post without one. Each post keeps its own; the batch says nothing (ADR-041).
      const perPost = new Set(group.map((x) => x.validThrough?.slice(0, 10)).filter(Boolean)).size > 1;
      const dl = perPost ? { closesAt: null, kind: "unknown" as const } : d.validThrough ? { closesAt: d.validThrough.slice(0, 10), kind: "date" as const } : parseDeadline(d.deadlineText ?? "");
      g.whole = w = {
        externalKey: campaignKey(sourceId, l.publisher, l.company, l.cohort ?? "", l.batch ?? ""), cohort: l.cohort ?? "", batch: l.batch ?? "",
        cities: Array.from(new Set(group.flatMap((x) => x.locations))).slice(0, 20),
        degreeReq: group.find((x) => x.degreeReq)?.degreeReq ?? "", majorReq: group.find((x) => x.majorReq)?.majorReq ?? "",
        opensAt: null, closesAt: dl.closesAt, deadlineKind: dl.kind, deadlineText: perPost ? "各岗位截止不同" : d.deadlineText ?? "",
        sourceKind: sourceId, hasWrittenTest: "", notes: "",
      };
    }
    return w;
  };

  const campaigns = new Set<string>();
  const listedRows = new Map<string, string>(); // one per listing row: its post
  let positionsNew = 0;
  let positionsSeen = 0;
  let positionsClosed = 0;
  let updated = 0;
  tx(db, () => {
    const batch = new CatalogBatch(db, listings.flatMap((l, i) => (filed(l) ? [ofGroup(groupOf[i], l).externalKey] : [])));
    // the campaigns this pull lists were confirmed when it read them: now, or when a subscribed feed's reader did (feed.ts)
    const verifiedAt = opts.observedAt ?? now();
    const aggregate = isAggregate(sourceId);
    // this source's listing rows of these campaigns, first by rowid as the lookup below finds them. A listing row stays
    // with its post and its post with its campaign (nothing rewrites either), so a row not found here is not there.
    const rows = new Map<string, { id: string; extracted_json: string }>();
    const rowKey = (externalId: string, positionId: string) => `${externalId}\u0000${positionId}`;
    inChunks(batch.campaignIds(), (part, q) => {
      // by campaign (`+provider` keeps SQLite off the provider index, which would scan every row of the source per chunk)
      for (const r of db.prepare(`select id, external_id, position_id, extracted_json from source_listing where campaign_id in (${q}) and +provider = ? order by rowid`).all(...part, sourceId) as any[]) {
        const k = rowKey(r.external_id, r.position_id);
        if (!rows.has(k)) rows.set(k, { id: r.id, extracted_json: r.extracted_json });
      }
    });
    const findRow = db.prepare("select id, extracted_json from source_listing where provider = ? and external_id = ? and position_id = ?");
    const updateRow = db.prepare("update source_listing set url = ?, extracted_json = ?, confidence = ?, content_path = ?, fetched_at = ? where id = ?");
    const insertRow = db.prepare("insert into source_listing(id, position_id, campaign_id, provider, tenant, external_id, url, publisher, grade, is_original, extracted_json, confidence, content_path, fetched_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)");

    for (const [i, l] of listings.entries()) {
      if (!filed(l)) continue;
      const companyId = batch.company(l.company, l.companyType ?? "", l.industry ?? "");
      const { id: campaignId } = batch.campaign({
        ...ofGroup(groupOf[i], l), companyId, kind: l.kind ?? "校招", sourceGrade: l.grade,
        applyUrl: campaignUrl(l.url), noticeUrl: campaignUrl(l.noticeUrl ?? l.url), lastVerifiedAt: verifiedAt,
      });
      campaigns.add(campaignId);
      const p = batch.position(campaignId, l.title, { jdText: l.description ?? "", cities: l.locations, degreeReq: l.degreeReq ?? "", majorReq: l.majorReq ?? "", closesAt: l.validThrough ? l.validThrough.slice(0, 10) : null, sourceKey: sourceKey(aggregate, l) });
      p.created ? positionsNew++ : positionsSeen++;
      // the listing as filed; unchanged since it was last written, it stays as it is (its snapshot name included)
      const said = json.str({ ...l, raw: undefined }), k = rowKey(l.externalId, p.id);
      listedRows.set(k, p.id);
      const existing = rows.get(k) ?? (findRow.get(sourceId, l.externalId, p.id) as { id: string; extracted_json: string } | undefined);
      if (existing) {
        if (existing.extracted_json !== said) { updateRow.run(l.url, said, l.confidence, snapshotPath, now(), existing.id); rows.set(k, { id: existing.id, extracted_json: said }); }
      } else {
        const id = ulid();
        insertRow.run(id, p.id, campaignId, sourceId, l.publisher, l.externalId, l.url, l.publisher, l.grade, l.isOriginal ? 1 : 0, said, l.confidence, snapshotPath, now());
        rows.set(k, { id, extracted_json: said });
      }
    }
    batch.finish();
    updated = batch.updated;
    // a full pull of a career site is the whole truth for what it lists: a post it no longer lists was taken down (or
    // renamed) — and closes when no other subscription lists it either (two 国聘 channels feed one batch: B34). Only for
    // scheduled pulls (not a captured page, not a partial read) and never on an empty answer; an applied-to post stays.
    if (opts.closeUnseen && opts.complete !== false && listings.length && campaigns.size) {
      // what it lists now (only full reads claim: a claim must be one a later full read can take back)
      const seen = db.prepare("insert into position_seen(position_id, config_id, seen_at) values (?,?,?) on conflict do update set seen_at = excluded.seen_at");
      for (const p of new Set(listedRows.values())) seen.run(p, configId, started);
      // posts the site still lists that the sender held back (a feed's quality gate): still there, so not closed —
      // their claims and their last-seen time are kept as if listed, their content left as it was
      if (opts.alsoSeen?.length) inChunks(opts.alsoSeen, (part, q) => {
        for (const r of db.prepare(`select distinct position_id id from source_listing where provider = ? and external_id in (${q})`).all(sourceId, ...part) as { id: string }[]) {
          seen.run(r.id, configId, started);
          db.prepare("update position set last_seen_at = ? where id = ?").run(started, r.id);
        }
      });
      // where to look: its campaigns now, the ones it fed before and did not list at all this time (国能 dropped a stale
      // 专项 list), and those of the posts it claimed before
      // this subscription's snapshot names, as a LIKE pattern (an id's own % or _ taken literally)
      const ownSnapshot = `%-${configId.replace(/[\\%_]/g, (c) => `\\${c}`)}.json`;
      const gone = (db.prepare("select distinct campaign_id id from source_listing where provider = ? and content_path like ? escape '\\' and campaign_id is not null").all(sourceId, ownSnapshot) as { id: string }[]).map((r) => r.id);
      const claimed = (db.prepare("select distinct p.campaign_id id from position_seen s join position p on p.id = s.position_id where s.config_id = ? and s.seen_at < ?").all(configId, started) as { id: string }[]).map((r) => r.id);
      const ids = [...new Set([...campaigns, ...gone, ...claimed])];
      // the first two days of claims every daily subscription reads at least once; until then a post nobody has claimed
      // yet may be another channel's whose listing row is this one's (rows are shared): it waits
      const since = (db.prepare("select value from meta where key = 'claims_since'").get() as { value: string } | undefined)?.value ?? "";
      const settled = since !== "" && Date.parse(since) < Date.parse(started) - CLAIMS_SETTLE_MS ? 1 : 0;
      inChunks(ids, (part, q) => {
        // a post closes when no other subscription claims it, and it was this one's: claimed by it before, or — not
        // claimed by anyone yet (from before claims were kept) — filed by no other subscription
        positionsClosed += Number(db.prepare(`update position set status = 'closed', updated_at = ? where campaign_id in (${q})
          and status = 'open' and last_seen_at < ? and id not in (select position_id from application where state != 'cancelled')
          and not exists (select 1 from position_seen s where s.position_id = position.id and s.config_id != ?)
          and (exists (select 1 from position_seen s where s.position_id = position.id and s.config_id = ?)
            or (? and not exists (select 1 from source_listing l where l.position_id = position.id and (l.provider != ? or l.content_path not like ? escape '\\'))))`)
          .run(now(), ...part, started, configId, configId, settled, sourceId, ownSnapshot).changes);
        db.prepare(`delete from position_seen where config_id = ? and seen_at < ? and position_id in (select id from position where campaign_id in (${q}))`).run(configId, started, ...part);
      });
    }
    db.prepare("insert into scan_run(id, source, config_id, started_at, finished_at, complete, found, new_positions, error, snapshot_path, fetch_ms, requests) values (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(runId, sourceId, configId, started, now(), opts.complete === false ? 0 : 1, listings.length, positionsNew, opts.error ?? "", snapshotPath, opts.fetchMs ?? null, opts.requests ?? null);
  });
  return { runId, received: listings.length, campaigns: campaigns.size, positionsNew, positionsSeen, positionsClosed, updated, snapshotPath, listed: { campaignIds: [...campaigns], positionIds: [...listedRows.values()] } };
}

/** What a read cost: the reader's own time (the filing after it is not counted) and the requests it made. */
export interface ReadCost { fetchMs?: number; requests?: number }

export function recordFailedRun(store: { db: Db }, sourceId: string, configId: string, error: string, cost: ReadCost = {}): void {
  store.db.prepare("insert into scan_run(id, source, config_id, started_at, finished_at, complete, found, new_positions, error, snapshot_path, fetch_ms, requests) values (?,?,?,?,?,?,?,?,?,?,?,?)")
    .run(ulid(), sourceId, configId, now(), now(), 0, 0, 0, error, "", cost.fetchMs ?? null, cost.requests ?? null);
}
