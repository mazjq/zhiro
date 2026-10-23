/**
 * Subscribing to a signed data source: someone else read the career sites; their reads are filed here exactly as if
 * this computer had read them (same reader, same subscription, same ingest — so batch identity, merging, closing and
 * the person's own changes behave as for a local read). What arrives is checked before anything is written:
 *   - the manifest is signed by the key the person configured (ed25519), for this feed, in this protocol, not older
 *     than the last one applied and not over two weeks old;
 *   - the bundle is the one the manifest names (sha256), not larger than it says, and every subscription in it is of a
 *     reader this build knows, with an id that cannot reach another subscription's files;
 *   - each subscription's read is newer than the one applied before (the same read again is skipped; the same time with
 *     other content is refused); only a read the feed says was complete may close posts, a stale one only adds;
 *   - listings keep the fields a reader fills and nothing else, within length limits.
 * Then all of it is filed in one transaction with the feed's position. Feed subscriptions are named
 * `feed~<feed id>~<subscription id>`; the ones the feed no longer carries lose their claims, so tidy can drop what only
 * they kept (tidy.ts reads liveFeedConfigs).
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import { gunzipSync } from "node:zlib";
import { tx, type Db } from "../db.js";
import { sources } from "./readers/index.js";
import { ingest } from "./ingest.js";
import type { Listing } from "./types.js";

export const FEED_PROTOCOL = 1;
const MAX_AGE_MS = 14 * 86400_000;
const MAX_BUNDLE = 1024 * 1024 * 1024; // 1 GB unpacked
const GRADES = new Set(["官方", "校方转载", "聚合", "行业线索", "推断"]);
const SAFE_ID = /^[^\\/:*?"<>|~%\u0000-\u001f]{1,200}$/;

export interface FeedConfig { id: string; url: string; publicKey: string; enabled?: boolean }
export interface FeedSub { id: string; source: string; state: "complete" | "stale"; observedAt: string; count: number; sha256: string }
export interface FeedManifest { feed: string; protocol: number; seq: number; createdAt: string; bundle: { path: string; sha256: string; bytes: number }; subs: FeedSub[]; sig?: string }

export const feedConfigId = (feedId: string, subId: string) => `feed~${feedId}~${subId}`;
/** The feed subscriptions this library holds now: tidy treats them as configured. */
export const liveFeedConfigs = (db: Db, feeds: FeedConfig[] = []): Set<string> => {
  const on = new Set(feeds.filter((f) => f.enabled !== false).map((f) => f.id));
  return new Set((db.prepare("select feed_id, sub_id from feed_applied").all() as { feed_id: string; sub_id: string }[]).filter((r) => on.has(r.feed_id)).map((r) => feedConfigId(r.feed_id, r.sub_id)));
};

const sha256 = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");
/** What is signed: the manifest without its signature, as written. */
export const signedPart = (m: FeedManifest) => { const { sig: _, ...rest } = m; return JSON.stringify(rest); };

class FeedError extends Error { constructor(public code: string, msg: string) { super(`${code}: ${msg}`); } }

function readFrom(base: string, rel?: string): Buffer {
  // F1: a folder on this computer (the collector's output). ponytail: https with a subscription token comes with F2
  const path = rel ? new URL(rel, base.endsWith("/") ? base : `${base}/`) : new URL(base);
  if (path.protocol !== "file:") throw new FeedError("FEED_UNREACHABLE", `只支持本机文件夹：${base}`);
  return readFileSync(path);
}
const folderUrl = (url: string) => (/^file:/.test(url) ? url : new URL(`file:///${url.replace(/\\/g, "/").replace(/^\/+/, "")}`).href);

/** The manifest, checked (signature, feed, protocol, age, position); null when it is the one already applied. */
export function checkManifest(raw: string, cfg: FeedConfig, lastSeq: number | null, now = Date.now()): FeedManifest | null {
  const m = JSON.parse(raw) as FeedManifest;
  if (!m.sig || !verify(null, Buffer.from(signedPart(m)), createPublicKey({ key: Buffer.from(cfg.publicKey, "base64"), format: "der", type: "spki" }), Buffer.from(m.sig, "base64"))) throw new FeedError("FEED_BAD_SIGNATURE", "签名对不上：不是配置的那个源发的，或被改过");
  if (m.feed !== cfg.id) throw new FeedError("FEED_WRONG_FEED", `这是「${m.feed}」的数据，不是「${cfg.id}」`);
  if (m.protocol !== FEED_PROTOCOL) throw new FeedError("FEED_PROTOCOL", `协议版本 ${m.protocol}，这个版本只认 ${FEED_PROTOCOL}`);
  if (!Number.isInteger(m.seq) || m.seq < 1) throw new FeedError("FEED_BAD_MANIFEST", "序号不对");
  if (lastSeq !== null && m.seq < lastSeq) throw new FeedError("FEED_ROLLBACK", `序号 ${m.seq} 比已导入的 ${lastSeq} 旧`);
  if (lastSeq !== null && m.seq === lastSeq) return null;
  if (!(Date.parse(m.createdAt) > now - MAX_AGE_MS)) throw new FeedError("FEED_EXPIRED", `这份数据生成于 ${m.createdAt}，超过两周`);
  for (const s of m.subs) {
    if (!SAFE_ID.test(s.id)) throw new FeedError("FEED_BAD_MANIFEST", `订阅 id 不合规：${s.id}`);
    if (!sources[s.source] || sources[s.source].mode !== "pull") throw new FeedError("FEED_UNKNOWN_SOURCE", `不认识的读取器：${s.source}`);
    if (s.state !== "complete" && s.state !== "stale") throw new FeedError("FEED_BAD_MANIFEST", `订阅状态不认识：${s.state}`);
    if (Number.isNaN(Date.parse(s.observedAt))) throw new FeedError("FEED_BAD_MANIFEST", `读取时间不对：${s.id}`);
  }
  if (new Set(m.subs.map((s) => s.id)).size !== m.subs.length) throw new FeedError("FEED_BAD_MANIFEST", "订阅 id 重复");
  return m;
}

const str = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : undefined);
/** A listing as a reader fills it, and nothing else. */
export function cleanListing(x: any): Listing | null {
  if (!x || typeof x.title !== "string" || typeof x.company !== "string" || !x.title.trim() || !x.company.trim() || typeof x.url !== "string") return null;
  const grade = GRADES.has(x.grade) ? x.grade : "推断";
  const l: Listing = {
    externalId: str(x.externalId, 500) ?? x.url, url: x.url.slice(0, 2000), title: x.title.slice(0, 300), company: x.company.slice(0, 200),
    locations: Array.isArray(x.locations) ? x.locations.filter((c: unknown) => typeof c === "string").slice(0, 50).map((c: string) => c.slice(0, 50)) : [],
    publisher: str(x.publisher, 200) ?? "", grade, isOriginal: x.isOriginal === true, confidence: typeof x.confidence === "number" ? Math.max(0, Math.min(1, x.confidence)) : 0.5,
  };
  for (const [k, max] of [["noticeUrl", 2000], ["companyType", 50], ["industry", 100], ["orgUnit", 200], ["description", 30000], ["employmentType", 50], ["datePosted", 40], ["validThrough", 40], ["deadlineText", 500], ["degreeReq", 100], ["majorReq", 1000], ["cohort", 100], ["batch", 100], ["kind", 50]] as const) {
    const v = str(x[k], max);
    if (v !== undefined) (l as any)[k] = v;
  }
  return l;
}

export interface FeedResult { feed: string; seq: number | null; unchanged: boolean; applied: number; skipped: number; released: number; positionsNew: number; positionsClosed: number }

/** Read, check and file one feed. Throws (nothing written) when any check fails. */
export function importFeed(store: { db: Db }, vault: string, cfg: FeedConfig, now = Date.now()): FeedResult {
  const db = store.db, base = folderUrl(cfg.url);
  const last = db.prepare("select seq from feed_run where feed_id = ?").get(cfg.id) as { seq: number } | undefined;
  const m = checkManifest(readFrom(base, "manifest.json").toString("utf8"), cfg, last?.seq ?? null, now);
  if (!m) return { feed: cfg.id, seq: last!.seq, unchanged: true, applied: 0, skipped: 0, released: 0, positionsNew: 0, positionsClosed: 0 };
  if (!SAFE_ID.test(m.bundle.path) || m.bundle.path.includes("..")) throw new FeedError("FEED_BAD_MANIFEST", "数据包路径不对");
  const packed = readFrom(base, m.bundle.path);
  if (sha256(packed) !== m.bundle.sha256) throw new FeedError("FEED_BAD_BUNDLE", "数据包和清单对不上（sha256）");
  const unpacked = gunzipSync(packed, { maxOutputLength: Math.min(MAX_BUNDLE, Math.max(0, m.bundle.bytes)) });
  const bundle = JSON.parse(unpacked.toString("utf8")) as { subs: Record<string, unknown[]> };

  // every check before any write: what each subscription brings, and whether it is newer than what is here
  const applied = new Map((db.prepare("select sub_id, observed_at, sha256 from feed_applied where feed_id = ?").all(cfg.id) as { sub_id: string; observed_at: string; sha256: string }[]).map((r) => [r.sub_id, r]));
  const plan: { sub: FeedSub; listings: Listing[] }[] = [];
  let skipped = 0;
  for (const sub of m.subs) {
    const rows = bundle.subs?.[sub.id];
    if (!Array.isArray(rows) || rows.length !== sub.count || sha256(JSON.stringify(rows)) !== sub.sha256) throw new FeedError("FEED_BAD_BUNDLE", `订阅「${sub.id}」的内容和清单对不上`);
    const before = applied.get(sub.id);
    if (before && sub.observedAt < before.observed_at) { skipped++; continue; } // an older read than the one filed
    if (before && sub.observedAt === before.observed_at) { if (before.sha256 !== sub.sha256) throw new FeedError("FEED_CONFLICT", `订阅「${sub.id}」同一次读取内容不同`); skipped++; continue; }
    plan.push({ sub, listings: rows.map(cleanListing).filter((l): l is Listing => !!l) });
  }

  let positionsNew = 0, positionsClosed = 0, released = 0;
  tx(db, () => {
    for (const { sub, listings } of plan) {
      const complete = sub.state === "complete";
      const r = ingest(store, vault, sub.source, feedConfigId(cfg.id, sub.id), listings, { closeUnseen: complete, complete, observedAt: sub.observedAt });
      positionsNew += r.positionsNew; positionsClosed += r.positionsClosed;
      db.prepare("insert into feed_applied(feed_id, sub_id, observed_at, sha256, applied_at) values (?,?,?,?,?) on conflict(feed_id, sub_id) do update set observed_at = excluded.observed_at, sha256 = excluded.sha256, applied_at = excluded.applied_at")
        .run(cfg.id, sub.id, sub.observedAt, sub.sha256, new Date(now).toISOString());
    }
    // what the feed no longer carries lists nothing any more here: its claims go (tidy then drops what only it kept)
    const carried = new Set(m.subs.map((s) => s.id));
    for (const id of applied.keys()) if (!carried.has(id)) {
      db.prepare("delete from position_seen where config_id = ?").run(feedConfigId(cfg.id, id));
      db.prepare("delete from feed_applied where feed_id = ? and sub_id = ?").run(cfg.id, id);
      released++;
    }
    db.prepare("insert into feed_run(feed_id, seq, created_at, applied_at) values (?,?,?,?) on conflict(feed_id) do update set seq = excluded.seq, created_at = excluded.created_at, applied_at = excluded.applied_at")
      .run(cfg.id, m.seq, m.createdAt, new Date(now).toISOString());
  });
  return { feed: cfg.id, seq: m.seq, unchanged: false, applied: plan.length, skipped, released, positionsNew, positionsClosed };
}
