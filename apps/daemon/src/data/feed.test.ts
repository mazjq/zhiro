/** A subscribed data source: checked before anything is written, filed as a local read would be, all or nothing. */
import { describe, it, expect } from "vitest";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openDb } from "../db.js";
import { importFeed, signedPart, feedConfigId, type FeedManifest } from "./feed.js";
import type { Listing } from "./types.js";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const PUB = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const sha = (x: string | Buffer) => createHash("sha256").update(x).digest("hex");
const post = (id: string, o: Partial<Listing> = {}): Listing => ({ externalId: id, url: `https://example.com/${id}`, title: `岗位${id}`, company: "示例公司", locations: ["武汉"], cohort: "2027届", batch: "秋招", publisher: "示例公司", grade: "官方", isOriginal: true, confidence: 1, description: `职责${id}`, ...o } as Listing);

/** What the collector writes: a bundle and a signed manifest in one folder. */
function publish(dir: string, seq: number, subs: { id: string; source?: string; state?: "complete" | "stale"; at: string; rows: unknown[] }[], o: { createdAt?: string; tamper?: boolean; feed?: string } = {}) {
  mkdirSync(dir, { recursive: true });
  const bundle = Buffer.from(JSON.stringify({ subs: Object.fromEntries(subs.map((s) => [s.id, s.rows])) }));
  const packed = gzipSync(bundle), path = `bundle-${seq}.json.gz`;
  writeFileSync(join(dir, path), packed);
  const m: FeedManifest = { feed: o.feed ?? "f1", protocol: 1, seq, createdAt: o.createdAt ?? new Date().toISOString(), bundle: { path, sha256: sha(packed), bytes: bundle.length },
    subs: subs.map((s) => ({ id: s.id, source: s.source ?? "moka", state: s.state ?? "complete", observedAt: s.at, count: s.rows.length, sha256: sha(JSON.stringify(s.rows)) })) };
  m.sig = sign(null, Buffer.from(signedPart(m)), privateKey).toString("base64");
  if (o.tamper) m.seq += 100;
  writeFileSync(join(dir, "manifest.json"), JSON.stringify(m));
}

function world() {
  const vault = mkdtempSync(join(tmpdir(), "zhiro-feed-"));
  const db = openDb(join(vault, "z.db"));
  const out = join(vault, "out");
  const cfg = { id: "f1", url: out, publicKey: PUB };
  db.prepare("update meta set value = ? where key = 'claims_since'").run(T(24 * 3)); // past the first two days of claims (ingest.ts)
  const open = () => (db.prepare("select title from position where status = 'open' order by title").all() as any[]).map((r) => r.title);
  return { vault, db, out, cfg, open, pull: () => importFeed({ db }, vault, cfg) };
}
const NOW = Date.now();
const T = (h: number) => new Date(NOW - h * 3600_000).toISOString();

describe("a subscribed data source", () => {
  it("files what it brings like a local read, keeps the reader's time as the check time, and leaves the person's word alone", () => {
    const w = world();
    publish(w.out, 1, [{ id: "moka-a", at: T(5), rows: [post("1"), post("2", { raw: { hr: "张三 13800000000" } } as any)] }]);
    expect(w.pull()).toMatchObject({ seq: 1, applied: 1, positionsNew: 2 });
    expect(w.open()).toEqual(["岗位1", "岗位2"]);
    expect(w.db.prepare("select last_verified_at v from campaign").get()).toEqual({ v: T(5) }); // when the reader read it, not now
    expect(JSON.stringify(w.db.prepare("select extracted_json from source_listing").all())).not.toContain("13800000000"); // raw never filed
    const camp = (w.db.prepare("select id from campaign").get() as any).id;
    w.db.prepare("update campaign set closes_at_override = '2026-12-31' where id = ?").run(camp);
    w.db.prepare("update position set watch_priority = 2 where title = '岗位1'").run();
    publish(w.out, 2, [{ id: "moka-a", at: T(1), rows: [post("1", { validThrough: "2026-11-30" }), post("2")] }]);
    expect(w.pull()).toMatchObject({ seq: 2, applied: 1 });
    expect(w.db.prepare("select closes_at_override o from campaign where id = ?").get(camp)).toEqual({ o: "2026-12-31" });
    expect(w.db.prepare("select watch_priority p from position where title = '岗位1'").get()).toEqual({ p: 2 });
    expect(w.pull()).toMatchObject({ unchanged: true }); // the same package again: nothing to do
  });

  it("refuses a wrong signature, another feed, an older or expired package, an unknown reader — writing nothing", () => {
    const w = world();
    publish(w.out, 1, [{ id: "moka-a", at: T(5), rows: [post("1")] }], { tamper: true });
    expect(() => w.pull()).toThrow(/FEED_BAD_SIGNATURE/);
    publish(w.out, 1, [{ id: "moka-a", at: T(5), rows: [post("1")] }], { feed: "other" });
    expect(() => w.pull()).toThrow(/FEED_WRONG_FEED/);
    publish(w.out, 1, [{ id: "moka-a", at: T(5), rows: [post("1")] }], { createdAt: T(24 * 20) });
    expect(() => w.pull()).toThrow(/FEED_EXPIRED/);
    publish(w.out, 1, [{ id: "x", source: "nosuch", at: T(5), rows: [post("1")] }]);
    expect(() => w.pull()).toThrow(/FEED_UNKNOWN_SOURCE/);
    publish(w.out, 1, [{ id: "../moka-a", at: T(5), rows: [post("1")] }]);
    expect(() => w.pull()).toThrow(/FEED_BAD_MANIFEST/);
    expect(w.open()).toEqual([]);
    publish(w.out, 3, [{ id: "moka-a", at: T(5), rows: [post("1")] }]);
    w.pull();
    publish(w.out, 2, [{ id: "moka-a", at: T(1), rows: [] }]);
    expect(() => w.pull()).toThrow(/FEED_ROLLBACK/);
    expect(w.open()).toEqual(["岗位1"]);
  });

  it("an older read is skipped, a stale read only adds, a complete one closes what it no longer lists", () => {
    const w = world();
    publish(w.out, 1, [{ id: "moka-a", at: T(5), rows: [post("1"), post("2")] }]);
    w.pull();
    publish(w.out, 2, [{ id: "moka-a", at: T(9), rows: [post("1")] }]); // the collector re-sent an older read
    expect(w.pull()).toMatchObject({ applied: 0, skipped: 1 });
    expect(w.open()).toEqual(["岗位1", "岗位2"]);
    publish(w.out, 3, [{ id: "moka-a", state: "stale", at: T(4), rows: [post("3")] }]); // its last read failed: only adds
    w.pull();
    expect(w.open()).toEqual(["岗位1", "岗位2", "岗位3"]);
    publish(w.out, 4, [{ id: "moka-a", at: T(3), rows: [post("1")] }]);
    w.pull();
    expect(w.open()).toEqual(["岗位1"]);
  });

  it("a row that does not pass makes the read add only; a subscription dropped upstream closes what only it listed", () => {
    const w = world();
    publish(w.out, 1, [{ id: "moka-a", at: T(5), rows: [post("1"), post("2")] }, { id: "moka-b", at: T(5), rows: [post("3")] }]);
    w.pull();
    publish(w.out, 2, [{ id: "moka-a", at: T(4), rows: [post("1"), { title: "", company: "示例公司", url: "https://example.com/x" }] }]); // a bad row
    expect(w.pull()).toMatchObject({ downgraded: 1, released: 1 });
    expect(w.open()).toEqual(["岗位1", "岗位2"]); // 2 not closed by a read that lost a row; 3 (only b's) closed
    publish(w.out, 3, [{ id: "moka-a", at: T(3), rows: [post("1", { title: "x".repeat(400) })] }]); // identity too long: not cut, left out
    expect(w.pull()).toMatchObject({ downgraded: 1 });
    expect(w.open()).toEqual(["岗位1", "岗位2"]);
  });

  it("refuses a package larger than it says, and a read from the future", () => {
    const w = world();
    publish(w.out, 1, [{ id: "moka-a", at: new Date(NOW + 5 * 3600_000).toISOString(), rows: [post("1")] }]);
    expect(() => w.pull()).toThrow(/读取时间不对/);
    publish(w.out, 1, [{ id: "moka-a", at: T(5), rows: [post("1")] }]);
    const m = JSON.parse(readFileSync(join(w.out, "manifest.json"), "utf8"));
    m.bundle.bytes = 10; // signed again with the lie: the unpacking stops at what it says
    m.sig = sign(null, Buffer.from(signedPart(m)), privateKey).toString("base64");
    writeFileSync(join(w.out, "manifest.json"), JSON.stringify(m));
    expect(() => w.pull()).toThrow();
    expect(w.open()).toEqual([]);
  });

  it("a subscription this library reads itself is left to its own reads", () => {
    const w = world();
    publish(w.out, 1, [{ id: "moka-a", at: T(5), rows: [post("1")] }, { id: "moka-mine", at: T(5), rows: [post("8", { company: "本机也读的" })] }]);
    expect(importFeed({ db: w.db }, w.vault, w.cfg, new Set(["moka-mine"]))).toMatchObject({ applied: 1, local: 1 });
    expect(w.db.prepare("select count(*) n from company where name = '本机也读的'").get()).toEqual({ n: 0 });
  });

  it("a subscription the feed no longer carries loses its claims; nothing of it is left half-filed when a later one is bad", () => {
    const w = world();
    publish(w.out, 1, [{ id: "moka-a", at: T(5), rows: [post("1")] }, { id: "moka-b", at: T(5), rows: [post("9", { company: "另一家" })] }]);
    w.pull();
    expect(w.db.prepare("select count(*) n from position_seen where config_id = ?").get(feedConfigId("f1", "moka-b"))).toEqual({ n: 1 });
    publish(w.out, 2, [{ id: "moka-a", at: T(4), rows: [post("1")] }]);
    expect(w.pull()).toMatchObject({ released: 1 });
    expect(w.db.prepare("select count(*) n from position_seen where config_id = ?").get(feedConfigId("f1", "moka-b"))).toEqual({ n: 0 });
    // the same read time with other content: refused, and the good subscription before it is not filed either
    publish(w.out, 3, [{ id: "moka-c", at: T(2), rows: [post("5", { company: "第三家" })] }, { id: "moka-a", at: T(4), rows: [post("1"), post("7")] }]);
    expect(() => w.pull()).toThrow(/FEED_CONFLICT/);
    expect(w.db.prepare("select count(*) n from company where name = '第三家'").get()).toEqual({ n: 0 });
  });
});
