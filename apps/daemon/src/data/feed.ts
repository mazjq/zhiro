/**
 * Subscribing to a signed data source: someone else read the career sites; their reads are filed here exactly as if
 * this computer had read them (same reader, same subscription, same ingest — so batch identity, merging, closing and
 * the person's own changes behave as for a local read). What arrives is checked before anything is written:
 *   - sizes first: the manifest, the package and what it unpacks to are bounded before they are read;
 *   - the manifest is signed by the key the person configured (ed25519), for this feed, in this protocol, not older
 *     than the last one applied, not over two weeks old and not from the future;
 *   - the bundle is the one the manifest names (sha256), unpacks to exactly the size it says, and every subscription in
 *     it is of a reader this build knows, with an id that cannot reach another subscription's files;
 *   - each subscription's read is newer than the one filed (same read again: skipped; same time, other content or
 *     another reader: refused; the same read now complete where it was stale: filed, so it may close what it dropped);
 *   - listings keep the fields a reader fills and nothing else; a row that does not pass (or whose identity is too
 *     long to keep whole) is left out — and then the read no longer counts as complete: it adds, it closes nothing;
 *   - rows the sender held back come as post ids only: still listed by the site, so kept open, never closed.
 * Then all of it is filed in one transaction with the feed's position (no files are written: the package is the
 * record). One writer per subscription: one this library reads itself is left to its own reads. A subscription the
 * feed drops closes what only it listed (releaseClaims); a paused feed keeps what it brought, a removed one goes
 * (tidy.ts reads liveFeedConfigs). Feed subscriptions are named `feed~<feed id>~<subscription id>`.
 * ponytail, known limits of this stage: (1) two subscriptions of one reader that list the same post share its listing
 * row, so a feed read up to a day older than a local read of another channel can rewrite that row until the next read;
 * per-observation versions would close it. (2) The import runs on the daemon's thread: measured on the first full
 * package; a worker if it holds the daemon too long. (3) A read that succeeded with nothing in it only adds, as a local
 * read of nothing counts as failed (ZERO_POSTS).
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { pathToFileURL, fileURLToPath } from "node:url";
import { gunzipSync } from "node:zlib";
import { tx, type Db } from "../db.js";
import { sources } from "./readers/index.js";
import { ingest, releaseClaims } from "./ingest.js";
import type { Listing } from "./types.js";

export const FEED_PROTOCOL = 1;
const MAX_AGE_MS = 14 * 86400_000, SKEW_MS = 3600_000;
const MAX_MANIFEST = 16 * 1024 * 1024, MAX_PACKED = 128 * 1024 * 1024, MAX_UNPACKED = 512 * 1024 * 1024;
const MAX_SUBS = 20_000, MAX_ROWS = 3_000_000;
const GRADES = new Set(["官方", "校方转载", "聚合", "行业线索", "推断"]);
const SAFE_ID = /^[^\\/:*?"<>|~%\u0000-\u001f]{1,120}$/;

export interface FeedConfig { id: string; url: string; publicKey: string; enabled?: boolean }
/**
 * One subscription's read. `count` rows are sent; `withheld` more the site listed are not (a gate held them back) and
 * are sent by their post id only — still there, so never taken for gone. `sha256` covers both: JSON of [rows, withheld].
 */
export interface FeedSub { id: string; source: string; state: "complete" | "stale"; observedAt: string; count: number; withheld?: number; sha256: string }
export interface FeedManifest { feed: string; protocol: number; seq: number; createdAt: string; bundle: { path: string; sha256: string; bytes: number }; subs: FeedSub[]; sig?: string }

export const feedConfigId = (feedId: string, subId: string) => `feed~${feedId}~${subId}`;
/** The feed subscriptions this library holds: tidy treats them as configured — a paused feed's too (it keeps its data). */
export const liveFeedConfigs = (db: Db, feeds: FeedConfig[] = []): Set<string> => {
  const known = new Set(feeds.map((f) => f.id));
  return new Set((db.prepare("select feed_id, sub_id from feed_applied").all() as { feed_id: string; sub_id: string }[]).filter((r) => known.has(r.feed_id)).map((r) => feedConfigId(r.feed_id, r.sub_id)));
};

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** What is signed: the manifest without its signature, as written. */
export const signedPart = (m: FeedManifest) => { const { sig: _, ...rest } = m; return JSON.stringify(rest); };

class FeedError extends Error { constructor(public code: string, msg: string) { super(`${code}: ${msg}`); } }

/**
 * A file of the feed's folder, never more than `max` bytes read (the size is not trusted: the file may change between a
 * look and a read). F1: a folder on this computer. ponytail: https + token with F2.
 */
function readFrom(folder: string, name: string, max: number): Buffer {
  const path = fileURLToPath(new URL(encodeURIComponent(name), pathToFileURL(folder.endsWith("/") || folder.endsWith("\\") ? folder : `${folder}/`)));
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(Math.min(max + 1, fstatSync(fd).size + 1));
    let n = 0, r = 0;
    while (n < buf.length && (r = readSync(fd, buf, n, buf.length - n, n)) > 0) n += r;
    if (n > max) throw new FeedError("FEED_TOO_LARGE", `${name} 超过上限 ${max} 字节`);
    return buf.subarray(0, n);
  } finally { closeSync(fd); }
}
const ms = (s: unknown) => (typeof s === "string" ? Date.parse(s) : Number.NaN);

/** The manifest, checked (signature, feed, protocol, age, position); null when it is the one already applied. */
export function checkManifest(raw: string, cfg: FeedConfig, lastSeq: number | null, now = Date.now()): FeedManifest | null {
  const m = JSON.parse(raw) as FeedManifest;
  if (typeof m.sig !== "string" || !verify(null, Buffer.from(signedPart(m)), createPublicKey({ key: Buffer.from(cfg.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(m.sig, "base64"))) throw new FeedError("FEED_BAD_SIGNATURE", "签名对不上：不是配置的那个源发的，或被改过");
  if (m.feed !== cfg.id) throw new FeedError("FEED_WRONG_FEED", `这是「${m.feed}」的数据，不是「${cfg.id}」`);
  if (m.protocol !== FEED_PROTOCOL) throw new FeedError("FEED_PROTOCOL", `协议版本 ${m.protocol}，这个版本只认 ${FEED_PROTOCOL}`);
  if (!Number.isInteger(m.seq) || m.seq < 1) throw new FeedError("FEED_BAD_MANIFEST", "序号不对");
  const created = ms(m.createdAt);
  // too old or from the future: also for the package already applied (a source that stopped publishing says so)
  if (!(created > now - MAX_AGE_MS)) throw new FeedError("FEED_EXPIRED", `这份数据生成于 ${m.createdAt}，超过两周`);
  if (created > now + SKEW_MS) throw new FeedError("FEED_BAD_MANIFEST", `生成时间 ${m.createdAt} 在将来`);
  if (lastSeq !== null && m.seq < lastSeq) throw new FeedError("FEED_ROLLBACK", `序号 ${m.seq} 比已导入的 ${lastSeq} 旧`);
  if (lastSeq !== null && m.seq === lastSeq) return null;
  if (!Array.isArray(m.subs) || m.subs.length > MAX_SUBS) throw new FeedError("FEED_TOO_LARGE", "订阅太多");
  let rows = 0;
  for (const s of m.subs) {
    if (!SAFE_ID.test(s.id)) throw new FeedError("FEED_BAD_MANIFEST", `订阅 id 不合规：${s.id}`);
    if (!sources[s.source] || sources[s.source].mode !== "pull") throw new FeedError("FEED_UNKNOWN_SOURCE", `不认识的读取器：${s.source}`);
    if (s.state !== "complete" && s.state !== "stale") throw new FeedError("FEED_BAD_MANIFEST", `订阅状态不认识：${s.state}`);
    const at = ms(s.observedAt);
    if (Number.isNaN(at) || at > created + SKEW_MS) throw new FeedError("FEED_BAD_MANIFEST", `读取时间不对：${s.id}`);
    if (!Number.isInteger(s.count) || s.count < 0) throw new FeedError("FEED_BAD_MANIFEST", `条数不对：${s.id}`);
    rows += s.count;
  }
  if (rows > MAX_ROWS) throw new FeedError("FEED_TOO_LARGE", `共 ${rows} 条，超过上限`);
  if (new Set(m.subs.map((s) => s.id)).size !== m.subs.length) throw new FeedError("FEED_BAD_MANIFEST", "订阅 id 重复");
  if (!SAFE_ID.test(m.bundle?.path ?? "") || m.bundle.path.includes("..")) throw new FeedError("FEED_BAD_MANIFEST", "数据包路径不对");
  if (!Number.isInteger(m.bundle.bytes) || m.bundle.bytes < 0 || m.bundle.bytes > MAX_UNPACKED) throw new FeedError("FEED_TOO_LARGE", "数据包太大");
  return m;
}

/** A listing as a reader fills it, and nothing else; null when it does not pass or its identity cannot be kept whole. */
export function cleanListing(x: any): Listing | null {
  if (!x || typeof x !== "object") return null;
  const id = (v: unknown, max: number) => (typeof v === "string" && v.trim() && v.length <= max ? v : null);
  const title = id(x.title, 300), company = id(x.company, 200), url = id(x.url, 2000), externalId = x.externalId === undefined ? url : id(x.externalId, 500);
  if (!title || !company || !url || !externalId || !/^https?:\/\//i.test(url)) return null;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);
  const l: Listing = {
    externalId, url, title, company,
    locations: Array.isArray(x.locations) ? x.locations.filter((c: unknown) => typeof c === "string").slice(0, 50).map((c: string) => c.slice(0, 50)) : [],
    publisher: str(x.publisher, 200) ?? "", grade: GRADES.has(x.grade) ? x.grade : "推断", isOriginal: x.isOriginal === true,
    confidence: typeof x.confidence === "number" && Number.isFinite(x.confidence) ? Math.max(0, Math.min(1, x.confidence)) : 0.5,
  };
  for (const [k, max] of [["noticeUrl", 2000], ["companyType", 50], ["industry", 100], ["orgUnit", 200], ["description", 30000], ["employmentType", 50], ["datePosted", 40], ["validThrough", 40], ["deadlineText", 500], ["degreeReq", 100], ["majorReq", 1000], ["cohort", 100], ["batch", 100], ["kind", 50]] as const) {
    const v = str(x[k], max);
    if (v !== undefined) (l as any)[k] = v;
  }
  return l;
}

export interface FeedResult { feed: string; seq: number | null; unchanged: boolean; applied: number; unchangedSubs?: number; skipped: number; local: number; released: number; downgraded: number; positionsNew: number; positionsClosed: number }

/**
 * Read, check and file one feed. Throws (nothing written) when any check fails. `local`: the subscriptions this library
 * reads itself — one writer each, so the feed's copy of those is left alone (an older feed read must not overwrite a
 * newer local one, and two writers would take each other's claims).
 */
export function importFeed(store: { db: Db }, vault: string, cfg: FeedConfig, local: Set<string> = new Set(), now = Date.now()): FeedResult {
  const db = store.db;
  if (!SAFE_ID.test(cfg.id)) throw new FeedError("FEED_BAD_CONFIG", `数据源 id 不合规：${cfg.id}`);
  const applied = new Map((db.prepare("select sub_id, source, state, observed_at, sha256, applied_at from feed_applied where feed_id = ?").all(cfg.id) as { sub_id: string; source: string; state: string; observed_at: string; sha256: string; applied_at: string }[]).map((r) => [r.sub_id, r]));

  const last = db.prepare("select seq from feed_run where feed_id = ?").get(cfg.id) as { seq: number } | undefined;
  const m = checkManifest(readFrom(cfg.url, "manifest.json", MAX_MANIFEST).toString("utf8"), cfg, last?.seq ?? null, now);
  const result: FeedResult = { feed: cfg.id, seq: m?.seq ?? last?.seq ?? null, unchanged: !m, applied: 0, skipped: 0, local: 0, released: 0, downgraded: 0, positionsNew: 0, positionsClosed: 0 };
  if (!m) return result;
  const packed = readFrom(cfg.url, m.bundle.path, MAX_PACKED);
  if (sha256(packed) !== m.bundle.sha256) throw new FeedError("FEED_BAD_BUNDLE", "数据包和清单对不上（sha256）");
  const unpacked = gunzipSync(packed, { maxOutputLength: Math.max(1, m.bundle.bytes) });
  if (unpacked.length !== m.bundle.bytes) throw new FeedError("FEED_BAD_BUNDLE", "数据包解开后的大小和清单不符");
  const bundle = JSON.parse(unpacked.toString("utf8")) as { subs: Record<string, unknown[]>; withheld?: Record<string, unknown[]> };

  // every check before any write: what each subscription brings, and whether it is newer than what is here
  const plan: { sub: FeedSub; listings: Listing[]; held: string[]; complete: boolean; at: string }[] = [];
  const touched: { sub: FeedSub; at: string }[] = []; // read again, found the same: only the read time moves
  for (const sub of m.subs) {
    const rows = bundle.subs?.[sub.id], held = bundle.withheld?.[sub.id] ?? [];
    if (!Array.isArray(rows) || rows.length !== sub.count || !Array.isArray(held) || held.length !== (sub.withheld ?? 0) || held.some((x) => typeof x !== "string" || x.length > 500)
      || sha256(JSON.stringify([rows, held])) !== sub.sha256) throw new FeedError("FEED_BAD_BUNDLE", `订阅「${sub.id}」的内容和清单对不上`);
    if (local.has(sub.id)) { result.local++; continue; }
    const at = new Date(ms(sub.observedAt)).toISOString(), before = applied.get(sub.id);
    if (before && before.source !== sub.source) throw new FeedError("FEED_CONFLICT", `订阅「${sub.id}」的读取器从 ${before.source} 变成了 ${sub.source}`);
    if (before && at < before.observed_at) { result.skipped++; continue; } // an older read than the one filed
    if (before && at === before.observed_at) {
      if (before.sha256 !== sub.sha256) throw new FeedError("FEED_CONFLICT", `订阅「${sub.id}」同一次读取内容不同`);
      if (!(before.state === "stale" && sub.state === "complete")) { result.skipped++; continue; } // the same read, now known complete: filed again
    }
    // most subscriptions read the same as yesterday: nothing to file, only when they were read (the first full package
    // took 47 s to file; every one after it would have taken as long for the few that changed)
    if (before && before.sha256 === sub.sha256 && (before.state === sub.state || before.state === "complete")) { touched.push({ sub, at }); continue; }
    const listings = rows.map(cleanListing).filter((l): l is Listing => !!l);
    // a read with rows left out, or with none at all (a local read of nothing is a failure too), only adds
    const complete = sub.state === "complete" && listings.length === rows.length && listings.length > 0;
    if (sub.state === "complete" && !complete) result.downgraded++;
    plan.push({ sub, listings, held: held as string[], complete, at });
  }

  tx(db, () => {
    // a subscription this library now reads itself: handed over once its own full read has come in since the feed's
    // last one (until then the feed's claims keep what it brought); its claims go, nothing is closed by the hand-over
    const readSince = db.prepare("select 1 from scan_run where config_id = ? and complete = 1 and error = '' and started_at > ? limit 1");
    for (const [id, a] of [...applied]) if (local.has(id) && readSince.get(id, a.applied_at)) {
      db.prepare("delete from position_seen where config_id = ?").run(feedConfigId(cfg.id, id));
      db.prepare("delete from feed_applied where feed_id = ? and sub_id = ?").run(cfg.id, id);
      applied.delete(id);
    }
    // what the feed no longer carries lists nothing any more here: what only it listed closes, its claims go first
    const carried = new Set(m.subs.map((s) => s.id));
    for (const id of [...applied.keys()]) if (!carried.has(id) && !local.has(id)) {
      result.positionsClosed += releaseClaims(db, feedConfigId(cfg.id, id)).closed;
      db.prepare("delete from feed_applied where feed_id = ? and sub_id = ?").run(cfg.id, id);
      result.released++;
    }
    for (const { sub, listings, held, complete, at } of plan) {
      const r = ingest(store, vault, sub.source, feedConfigId(cfg.id, sub.id), listings, { closeUnseen: complete, complete, observedAt: at, noSnapshot: true, alsoSeen: held });
      result.positionsNew += r.positionsNew; result.positionsClosed += r.positionsClosed; result.applied++;
      db.prepare(`insert into feed_applied(feed_id, sub_id, source, state, observed_at, sha256, applied_at) values (?,?,?,?,?,?,?) on conflict(feed_id, sub_id) do update set
        source = excluded.source, state = excluded.state, observed_at = excluded.observed_at, sha256 = excluded.sha256, applied_at = excluded.applied_at`)
        .run(cfg.id, sub.id, sub.source, sub.state, at, sub.sha256, new Date(now).toISOString()); // the state the sender declared (a downgrade here is this run's alone)
    }
    for (const { sub, at } of touched) db.prepare("update feed_applied set observed_at = ?, applied_at = ? where feed_id = ? and sub_id = ?").run(at, new Date(now).toISOString(), cfg.id, sub.id);
    result.unchangedSubs = touched.length;
    db.prepare("insert into feed_run(feed_id, seq, created_at, applied_at) values (?,?,?,?) on conflict(feed_id) do update set seq = excluded.seq, created_at = excluded.created_at, applied_at = excluded.applied_at")
      .run(cfg.id, m.seq, m.createdAt, new Date(now).toISOString());
  });
  return result;
}
