import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { openDb, json, now, tx, type Db } from "../db.js";
import { ingest, campaignUrl } from "./ingest.js";
import { campaignKey, genericCompany, upsertCompany, upsertCampaign, upsertPosition } from "./catalog.js";
import { parseDeadline } from "./sheet.js";
import { isAggregate, sources } from "./readers/index.js";
import { runSource, listSources } from "./sync.js";
import type { DataContext, Listing, Source } from "./types.js";

/**
 * ADR-063: ingest writes only what changed. The oracle is the full rewrite it replaced (data/ingest.ts up to 7ba3e85,
 * snapshot left out), run on a copy of the same database: after every kind of change both must leave the same rows.
 * Two things are allowed to differ and are left out of the comparison: `updated_at` (now: when it last changed, not
 * when it was last read) and which snapshot a listing row names (the run it last changed in).
 */
function fullRewrite(db: Db, sourceId: string, configId: string, listings: Listing[]) {
  const started = now(), snapshotPath = `x/${started.replace(/[:.]/g, "-")}-${configId}.json`;
  const sourceKey = (l: Listing) => (isAggregate(sourceId) || /#\d+$/.test(l.externalId) || l.externalId === l.url || l.externalId === l.title ? "" : l.externalId);
  const groupKey = (l: Listing) => `${l.publisher}|${l.company}|${l.cohort ?? ""}|${l.batch ?? ""}`;
  const groups = new Map<string, Listing[]>();
  for (const l of listings) (groups.get(groupKey(l)) ?? groups.set(groupKey(l), []).get(groupKey(l))!).push(l);
  const campaigns = new Set<string>();
  let positionsNew = 0, positionsSeen = 0, positionsClosed = 0;
  tx(db, () => {
    for (const l of listings) {
      if (!l.title || !l.company || genericCompany(l.company)) continue;
      const companyId = upsertCompany(db, l.company, l.companyType ?? "", l.industry ?? "");
      const cohort = l.cohort ?? "", batch = l.batch ?? "";
      const group = groups.get(groupKey(l))!;
      const d = group.find((x) => x.validThrough || x.deadlineText) ?? l;
      const perPost = new Set(group.map((x) => x.validThrough?.slice(0, 10)).filter(Boolean)).size > 1;
      const dl = perPost ? { closesAt: null, kind: "unknown" as const } : d.validThrough ? { closesAt: d.validThrough.slice(0, 10), kind: "date" as const } : parseDeadline(d.deadlineText ?? "");
      const { id: campaignId } = upsertCampaign(db, {
        companyId, externalKey: campaignKey(sourceId, l.publisher, l.company, cohort, batch), kind: l.kind ?? "校招", cohort, batch,
        cities: Array.from(new Set(group.flatMap((x) => x.locations))).slice(0, 20),
        degreeReq: group.find((x) => x.degreeReq)?.degreeReq ?? "", majorReq: group.find((x) => x.majorReq)?.majorReq ?? "",
        opensAt: null, closesAt: dl.closesAt, deadlineKind: dl.kind, deadlineText: perPost ? "各岗位截止不同" : d.deadlineText ?? "",
        applyUrl: campaignUrl(l.url), noticeUrl: campaignUrl(l.noticeUrl ?? l.url), sourceGrade: l.grade, sourceKind: sourceId, hasWrittenTest: "", notes: "", lastVerifiedAt: now(),
      });
      campaigns.add(campaignId);
      const p = upsertPosition(db, campaignId, l.title, { jdText: l.description ?? "", cities: l.locations, degreeReq: l.degreeReq ?? "", majorReq: l.majorReq ?? "", closesAt: l.validThrough ? l.validThrough.slice(0, 10) : null, sourceKey: sourceKey(l) });
      p.created ? positionsNew++ : positionsSeen++;
      const existing = db.prepare("select id from source_listing where provider = ? and external_id = ? and position_id = ?").get(sourceId, l.externalId, p.id) as { id: string } | undefined;
      if (existing) db.prepare("update source_listing set url = ?, extracted_json = ?, confidence = ?, content_path = ?, fetched_at = ? where id = ?").run(l.url, json.str({ ...l, raw: undefined }), l.confidence, snapshotPath, now(), existing.id);
      else db.prepare("insert into source_listing(id, position_id, campaign_id, provider, tenant, external_id, url, publisher, grade, is_original, extracted_json, confidence, content_path, fetched_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(ulid(), p.id, campaignId, sourceId, l.publisher, l.externalId, l.url, l.publisher, l.grade, l.isOriginal ? 1 : 0, json.str({ ...l, raw: undefined }), l.confidence, snapshotPath, now());
    }
    const ids = [...campaigns];
    if (listings.length && ids.length) {
      positionsClosed = Number(db.prepare(`update position set status = 'closed', updated_at = ? where campaign_id in (${ids.map(() => "?").join(",")})
        and status = 'open' and last_seen_at < ? and id not in (select position_id from application where state != 'cancelled')`).run(now(), ...ids, started).changes);
      const gone = (db.prepare("select distinct campaign_id id from source_listing where provider = ? and content_path like ? and campaign_id is not null").all(sourceId, `%-${configId}.json`) as { id: string }[]).map((r) => r.id).filter((id) => !campaigns.has(id));
      if (gone.length) positionsClosed += Number(db.prepare(`update position set status = 'closed', updated_at = ? where campaign_id in (${gone.map(() => "?").join(",")})
        and status = 'open' and id not in (select position_id from application where state != 'cancelled')`).run(now(), ...gone).changes);
    }
    db.prepare("insert into scan_run(id, source, config_id, started_at, finished_at, complete, found, new_positions, error, snapshot_path) values (?,?,?,?,?,?,?,?,?,?)")
      .run(ulid(), sourceId, configId, started, now(), 1, listings.length, positionsNew, "", snapshotPath);
  });
  return { received: listings.length, campaigns: campaigns.size, positionsNew, positionsSeen, positionsClosed };
}

/** Every row the two ways write, by natural keys; a time stamp from this run reads NOW (older ones are the same in both copies). */
function dump(db: Db, since: string) {
  const T = (v: string | null) => (v && v >= since ? "NOW" : v);
  const ck = new Map((db.prepare("select id, external_key from campaign").all() as any[]).map((r) => [r.id, r.external_key]));
  const co = new Map((db.prepare("select id, name from company").all() as any[]).map((r) => [r.id, r.name]));
  const pk = new Map((db.prepare("select id, campaign_id, title, source_key from position").all() as any[]).map((r) => [r.id, `${ck.get(r.campaign_id)}|${r.title}|${r.source_key}`]));
  const rows = (sql: string, f: (r: any) => unknown[]) => (db.prepare(sql).all() as any[]).map((r) => f(r).join("\t")).sort();
  return {
    company: rows("select * from company", (r) => [r.name, r.norm, r.aliases, r.type, r.industry]),
    campaign: rows("select * from campaign", (r) => [r.external_key, co.get(r.company_id), r.kind, r.cohort, r.batch, r.cities, r.degree_req, r.major_req, r.opens_at, r.closes_at, r.deadline_kind, r.deadline_text, r.apply_url, r.notice_url, r.source_grade, r.source_kind, T(r.last_verified_at)]),
    position: rows("select * from position", (r) => [pk.get(r.id), r.jd_text, r.cities, r.degree_req, r.major_req, r.closes_at, r.status, r.watch_priority, T(r.last_seen_at), T(r.created_at)]),
    source_listing: rows("select * from source_listing", (r) => [r.provider, r.external_id, pk.get(r.position_id), ck.get(r.campaign_id), r.url, r.grade, r.extracted_json, r.confidence]),
    scan_run: rows("select * from scan_run where started_at >= '" + since + "'", (r) => [r.source, r.config_id, r.complete, r.found, r.new_positions]),
  };
}

const sheet = (row: string, over: Partial<Listing> = {}): Listing => ({ externalId: `${row}|研发类`, url: "https://app.mokahr.com/campus_apply/acme/1#/", noticeUrl: "https://mp.weixin.qq.com/s/a", title: "研发类", company: "示例科技",
  companyType: "民企", industry: "科技", locations: ["北京", "上海"], deadlineText: "招满为止", degreeReq: "本科, 硕士", majorReq: "/", cohort: "2027届", batch: "秋招", kind: "校招",
  publisher: "飞书校招汇总表", grade: "校方转载", isOriginal: false, confidence: 0.7, ...over });
const site = (id: string, title: string, over: Partial<Listing> = {}): Listing => ({ externalId: id, url: `https://app.mokahr.com/campus-recruitment/acme/1#/job/${id}`, title, company: "示例重工",
  locations: ["武汉"], description: "jd", publisher: "moka:acme", grade: "官方", isOriginal: true, confidence: 0.9, cohort: "2027届", batch: "校招", ...over });
const SEED_SHEET = [sheet("r1"), sheet("r1", { externalId: "r1|算法类", title: "算法类" }), sheet("r2", { company: "另一家", title: "测试类", externalId: "r2|测试类" }), sheet("r3", { company: "第三家", title: "销售", externalId: "r3|销售", deadlineText: "2026-12-01" })];
const SEED_SITE = [site("j1", "控制算法工程师"), site("j2", "仿真工程师", { validThrough: "2026-11-30" }), site("j3", "电机控制工程师", { validThrough: "2026-11-30" })];

/** The seed filed the old way, copied; then the same pull filed the old way on one copy and the new way on the other. */
function compare(source: string, seed: Listing[][], next: Listing[], tweak?: (db: Db) => void) {
  const dir = mkdtempSync(join(tmpdir(), "jobos-incr-"));
  const a = openDb(join(dir, "a.db"));
  for (const s of seed) fullRewrite(a, source, "cfg", s);
  tweak?.(a);
  a.exec(`vacuum into '${join(dir, "b.db").replace(/'/g, "''")}'`);
  const b = openDb(join(dir, "b.db"));
  const since = now();
  const old = fullRewrite(a, source, "cfg", next);
  // `updated` (what changed in place, 5B) the full rewrite cannot tell: it rewrote everything
  const { runId: _r, snapshotPath: _s, listed: _l, updated, ...neu } = ingest({ db: b }, dir, source, "cfg", next, { closeUnseen: true });
  expect(neu).toEqual(old);
  expect(dump(b, since)).toEqual(dump(a, since));
  return { a, b, since, result: { ...neu, updated } };
}

describe("ingest writes only what changed, and ends where the full rewrite ends (ADR-063)", () => {
  it("an unchanged pull: same rows, nothing rewritten but the seen marks", () => {
    const { b, since, result } = compare("feishu-base", [SEED_SHEET], SEED_SHEET);
    expect(result).toMatchObject({ positionsNew: 0, positionsSeen: 4, positionsClosed: 0, updated: 0 }); // 0: the pages are not told (5B)
    expect(b.prepare("select count(*) n from position where updated_at >= ?").get(since)).toEqual({ n: 0 });
    expect(b.prepare("select count(*) n from source_listing where fetched_at >= ?").get(since)).toEqual({ n: 0 });
    expect(b.prepare("select count(*) n from position where last_seen_at >= ?").get(since)).toEqual({ n: 4 });
  });
  it("one row changed (cities, major)", () => {
    const { result } = compare("feishu-base", [SEED_SHEET], [sheet("r1", { locations: ["北京", "深圳"], majorReq: "自动化" }), ...SEED_SHEET.slice(1)]);
    expect(result.updated).toBeGreaterThan(0);
  });
  it("a row added: a new post, a new company and campaign", () => {
    const { result } = compare("feishu-base", [SEED_SHEET], [...SEED_SHEET, sheet("r1", { externalId: "r1|硬件类", title: "硬件类" }), sheet("r9", { company: "新公司", title: "运营", externalId: "r9|运营" })]);
    expect(result.positionsNew).toBe(2);
  });
  it("a row removed: its post closes; a removed post applied to stays open; a campaign not listed at all closes", () => {
    const { result } = compare("feishu-base", [SEED_SHEET], [SEED_SHEET[0], SEED_SHEET[1]], (db) => {
      const p = db.prepare("select id, campaign_id from position where title = '测试类'").get() as any;
      db.prepare("insert into application(id, position_id, campaign_id, state, created_at, updated_at) values (?,?,?,?,?,?)").run(ulid(), p.id, p.campaign_id, "draft", now(), now());
    });
    expect(result.positionsClosed).toBe(1); // 第三家·销售 closes; 另一家·测试类 is applied to
  });
  it("a campaign-level field changes (the sheet's deadline for a company), and the company's type", () => {
    const { result } = compare("feishu-base", [SEED_SHEET], [sheet("r1", { deadlineText: "2026-11-15", companyType: "国企" }), sheet("r1", { externalId: "r1|算法类", title: "算法类", deadlineText: "2026-11-15", companyType: "国企" }), ...SEED_SHEET.slice(2)]);
    expect(result).toMatchObject({ positionsNew: 0, positionsClosed: 0, updated: 2 }); // the campaign and the company
  });
  it("a deadline changes: a post's own day moves, and a batch whose posts now carry different days says none", () => {
    compare("moka", [SEED_SITE], [SEED_SITE[0], site("j2", "仿真工程师", { validThrough: "2026-12-20" }), SEED_SITE[2]]);
    compare("moka", [SEED_SITE], [site("j1", "控制算法工程师", { validThrough: "2026-10-30" }), ...SEED_SITE.slice(1)]);
  });
  it("a post closed elsewhere comes back open; a renamed post (same site id) keeps its id; a listing twice in one pull", () => {
    compare("moka", [SEED_SITE], [site("j1", "控制算法工程师（武汉）"), SEED_SITE[1], SEED_SITE[2], SEED_SITE[2]], (db) => db.prepare("update position set status = 'closed' where title = '仿真工程师'").run());
  });
  it("a post first seen without a site id is taken over by the id that arrives under its title", () => {
    compare("moka", [[site("https://x/1", "控制算法工程师", { url: "https://x/1" })]], [site("j1", "控制算法工程师")]);
  });
  it("two posts of a batch sharing one site id: the database decides which one, as before", () => {
    // (renamed under the same id: the one the database finds first takes the new title)
    compare("moka", [SEED_SITE], [site("j1", "控制算法工程师（新）")], (db) => {
      const c = (db.prepare("select campaign_id c from position limit 1").get() as any).c;
      db.prepare("insert into position(id, campaign_id, title, status, last_seen_at, created_at, updated_at, source_key) values (?,?,?,?,?,?,?,?)").run(ulid(), c, "A 另一个名字", "open", now(), now(), now(), "j1");
    });
  });
  it("a company name read by its norm or alias, and one added in the same pull", () => {
    compare("feishu-base", [[sheet("r1", { company: "示例科技有限公司" })]], [sheet("r1", { company: "示例科技" }), sheet("r5", { company: "示例 科技", externalId: "r5|研发类" }), sheet("r6", { company: "全新", externalId: "r6|研发类" })]);
  });
});

describe("snapshots: a new one only when the pull differs from the last", () => {
  it("the same pull again keeps the last snapshot; a change writes one", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-snap-"));
    const db = openDb(join(dir, "t.db"));
    const r1 = ingest({ db }, dir, "feishu-base", "cfg", SEED_SHEET, { closeUnseen: true });
    const r2 = ingest({ db }, dir, "feishu-base", "cfg", SEED_SHEET, { closeUnseen: true });
    expect(r2.snapshotPath).toBe(r1.snapshotPath);
    expect(readdirSync(join(dir, "snapshots", "feishu-base"))).toHaveLength(1);
    // "not seen this time" is last_seen_at < this pull's start: two pulls in one millisecond (a fast CI machine) look
    // like one. Real pulls of a subscription are minutes apart.
    const t = Date.now(); while (Date.now() === t) { /* next millisecond */ }
    const r3 = ingest({ db }, dir, "feishu-base", "cfg", SEED_SHEET.slice(1), { closeUnseen: true });
    expect(r3.snapshotPath).not.toBe(r1.snapshotPath);
    expect(r3.positionsClosed).toBe(1);
    // a subscription whose id ends like another's does not take the other's snapshot for its own
    const r4 = ingest({ db }, dir, "feishu-base", "x-cfg", SEED_SHEET.slice(1), { closeUnseen: true });
    expect(r4.snapshotPath).not.toBe(r3.snapshotPath);
    expect(db.prepare("select snapshot_path p from scan_run order by rowid").all().map((r: any) => r.p)).toEqual([r1.snapshotPath, r1.snapshotPath, r3.snapshotPath, r4.snapshotPath]);
  });
});

describe("「更新情况」 shows a pull under way", () => {
  afterEach(() => { delete sources.slow; });
  it("while the table is read: how many rows of how many; afterwards nothing", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-progress-"));
    let release!: () => void;
    const gate = new Promise<void>((ok) => (release = ok));
    sources.slow = { id: "slow", name: "慢表", mode: "pull", describe: "测试用", fetch: async (_c, ctx) => { ctx.log("slow s1: 3000/13754"); await gate; return [site("j1", "控制算法工程师")]; } } as Source;
    const ctx: DataContext = { db: openDb(join(dir, "t.db")), vault: dir, sources: [{ id: "s1", source: "slow", name: "慢表" }] };
    const run = runSource(ctx, "s1");
    await new Promise((ok) => setImmediate(ok));
    expect(listSources(ctx).configured[0]).toMatchObject({ running: { stage: "reading", done: 3000, total: 13754 } });
    release();
    expect(await run).toMatchObject({ ok: true });
    expect(listSources(ctx).configured[0]).not.toHaveProperty("running");
  });
});
