import { ulid } from "ulid";
import { createHash } from "node:crypto";
import type { StatementSync } from "node:sqlite";
import type { Db } from "../db.js";
import { json, now } from "../db.js";
import type { Static, Campaign } from "@zhiro/contracts";

/**
 * 岗位目录: who a company, a campaign and a post are, and the one place that writes them. Ingest (what a source said)
 * and the person's own operations (merging two companies, moving a campaign) both go through here, so an identity is
 * computed by one rule only.
 */
type CampaignT = Static<typeof Campaign>;

/** A word a page uses for itself, not a company's name (「公司」「本公司」「我司」): a row filed under it belongs to nobody. */
export const genericCompany = (name: string) => /^(本|我|该|某|贵|总)?(公司|司|单位|集团|企业|院|所)$|^(unknown|n\/a|null|none|未知|无|暂无)$/i.test(name.trim());

/**
 * Lossless company-name key (ADR-015): width/whitespace/bracket noise and the bare "有限公司" suffix only.
 * Anything fuzzier is a human `company.merge` — "东风汽车集团" and "东风汽车股份" are different employers.
 */
export function companyKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, "").replace(/(有限责任公司|有限公司)$/, "").toLowerCase();
}

export function sha(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

/**
 * Campaign identity = source + publisher + company + cohort + batch: the same tenant re-scanned tomorrow lands on the
 * same campaign; a different batch is a different campaign.
 */
export function campaignKey(sourceId: string, publisher: string, company: string, cohort: string, batch: string): string {
  return sha(`${sourceId}|${publisher}|${company}|${cohort}|${batch}`);
}

const findCompany = (db: Db, name: string) => (db.prepare("select id from company where name = ?").get(name)
  ?? db.prepare("select id from company where norm = ? or aliases like ?").get(companyKey(name), `%${JSON.stringify(name)}%`)) as { id: string } | undefined;

export function upsertCompany(db: Db, name: string, type = "", industry = ""): string {
  const found = findCompany(db, name);
  if (found) {
    if (type || industry) db.prepare("update company set type = coalesce(nullif(?, ''), type), industry = coalesce(nullif(?, ''), industry) where id = ?").run(type, industry, found.id);
    return found.id;
  }
  const id = ulid();
  db.prepare("insert into company(id, name, norm, type, industry, created_at) values (?,?,?,?,?,?)").run(id, name, companyKey(name), type, industry, now());
  return id;
}

export type CampaignInput = Omit<CampaignT, "id" | "companyName" | "createdAt" | "updatedAt" | "lastVerifiedAt"> & { externalKey: string; lastVerifiedAt?: string | null };

export function upsertCampaign(db: Db, c: CampaignInput): { id: string; created: boolean } {
  const found = db.prepare("select id from campaign where external_key = ?").get(c.externalKey) as { id: string } | undefined;
  const t = now();
  if (found) {
    db.prepare(`update campaign set kind=?, cohort=?, batch=?, cities=?, degree_req=?, major_req=?, opens_at=?, closes_at=?, deadline_kind=?, deadline_text=?,
      apply_url=?, notice_url=?, source_grade=?, source_kind=?, has_written_test=?, notes=?, last_verified_at=coalesce(?, last_verified_at), updated_at=? where id=?`)
      .run(c.kind, c.cohort, c.batch, json.str(c.cities), c.degreeReq, c.majorReq, c.opensAt, c.closesAt, c.deadlineKind, c.deadlineText,
        c.applyUrl, c.noticeUrl, c.sourceGrade, c.sourceKind, c.hasWrittenTest, c.notes, c.lastVerifiedAt ?? null, t, found.id);
    return { id: found.id, created: false };
  }
  const id = ulid();
  db.prepare(`insert into campaign(id, company_id, external_key, kind, cohort, batch, cities, degree_req, major_req, opens_at, closes_at, deadline_kind, deadline_text,
    apply_url, notice_url, source_grade, source_kind, has_written_test, notes, last_verified_at, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(id, c.companyId, c.externalKey, c.kind, c.cohort, c.batch, json.str(c.cities), c.degreeReq, c.majorReq, c.opensAt, c.closesAt, c.deadlineKind, c.deadlineText,
      c.applyUrl, c.noticeUrl, c.sourceGrade, c.sourceKind, c.hasWrittenTest, c.notes, c.lastVerifiedAt ?? null, t, t);
  return { id, created: true };
}

export type PositionExtra = Partial<{ jdText: string; cities: string[]; degreeReq: string; majorReq: string; closesAt: string | null; directionTags: string[]; sourceKey: string }>;

/** The post row `upsertPosition` finds (the lookups below are the one identity rule; the batch writer reuses them). */
const findPostByKey = (db: Db, campaignId: string, key: string) => db.prepare("select id from position where campaign_id = ? and source_key = ?").get(campaignId, key) as { id: string } | undefined;
const findPostByTitle = (db: Db, campaignId: string, title: string, keyed: boolean) =>
  db.prepare(`select id from position where campaign_id = ? and title = ? ${keyed ? "and source_key = ''" : "order by source_key = '' desc"} limit 1`).get(campaignId, title) as { id: string } | undefined;

const UPDATE_POST = `update position set title = ?, jd_text = coalesce(nullif(?, ''), jd_text), major_req = coalesce(nullif(?, ''), major_req), degree_req = coalesce(nullif(?, ''), degree_req), closes_at = coalesce(?, closes_at),
  cities = case when ? != '[]' then ? else cities end, source_key = case when ? != '' then ? else source_key end, status = 'open', last_seen_at = ?, updated_at = ? where id = ?`;
const INSERT_POST = "insert into position(id, campaign_id, title, jd_text, cities, degree_req, major_req, closes_at, status, direction_tags, last_seen_at, created_at, updated_at, source_key) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
const updatePost = (db: Db, id: string, title: string, extra: PositionExtra, t: string) => {
  const key = extra.sourceKey ?? "", cities = json.str(extra.cities ?? []);
  db.prepare(UPDATE_POST).run(title, extra.jdText ?? "", extra.majorReq ?? "", extra.degreeReq ?? "", extra.closesAt ?? null, cities, cities, key, key, t, t, id);
};
const insertPost = (db: Db, campaignId: string, title: string, extra: PositionExtra, t: string): string => {
  const id = ulid();
  db.prepare(INSERT_POST).run(id, campaignId, title, extra.jdText ?? "", json.str(extra.cities ?? []), extra.degreeReq ?? "", extra.majorReq ?? "", extra.closesAt ?? null, "open", json.str(extra.directionTags ?? []), t, t, t, extra.sourceKey ?? "");
  return id;
};

/**
 * A post is the same post when its source says so (sourceKey: the site's own post id), else when its title is the same
 * within the batch (ADR-041). 大疆 lists 控制算法工程师 three times — 深圳, 上海, 北京 — as three posts with three ids:
 * they stay three. A post first seen without a key is adopted by the first key that arrives under its title, so watches
 * and applications made before the site was read properly carry over.
 */
export function upsertPosition(db: Db, campaignId: string, title: string, extra: PositionExtra = {}): { id: string; created: boolean } {
  const key = extra.sourceKey ?? "";
  const found = (key ? findPostByKey(db, campaignId, key) : undefined) ?? findPostByTitle(db, campaignId, title, !!key);
  const t = now();
  if (found) { updatePost(db, found.id, title, extra, t); return { id: found.id, created: false }; }
  return { id: insertPost(db, campaignId, title, extra, t), created: true };
}

interface PostState { id: string; campaign_id: string; title: string; source_key: string; jd_text: string; major_req: string; degree_req: string; closes_at: string | null; cities: string; status: string }
interface CampaignState { id: string; external_key: string; kind: string; cohort: string; batch: string; cities: string; degree_req: string; major_req: string; opens_at: string | null; closes_at: string | null;
  deadline_kind: string; deadline_text: string; apply_url: string; notice_url: string; source_grade: string; source_kind: string; has_written_test: string; notes: string; last_verified_at: string | null }
const CAMPAIGN_COLS = "id, external_key, kind, cohort, batch, cities, degree_req, major_req, opens_at, closes_at, deadline_kind, deadline_text, apply_url, notice_url, source_grade, source_kind, has_written_test, notes, last_verified_at";
const POST_COLS = "id, campaign_id, title, source_key, jd_text, major_req, degree_req, closes_at, cities, status";
/** `in (…)` lists of at most 500 */
export const inChunks = <T>(xs: T[], f: (part: T[], marks: string) => void): void => { for (let i = 0; i < xs.length; i += 500) { const part = xs.slice(i, i + 500); f(part, part.map(() => "?").join(",")); } };
const sameCampaign = (r: CampaignState, c: CampaignInput) => r.kind === c.kind && r.cohort === c.cohort && r.batch === c.batch && r.cities === json.str(c.cities) && r.degree_req === c.degreeReq
  && r.major_req === c.majorReq && r.opens_at === (c.opensAt ?? null) && r.closes_at === (c.closesAt ?? null) && r.deadline_kind === c.deadlineKind && r.deadline_text === c.deadlineText
  && r.apply_url === c.applyUrl && r.notice_url === c.noticeUrl && r.source_grade === c.sourceGrade && r.source_kind === c.sourceKind && r.has_written_test === c.hasWrittenTest && r.notes === c.notes;

/** A campaign's posts in hand, looked up by title and by site id as `upsertPosition` looks them up. */
class Posts {
  rows: PostState[] = [];
  private byTitle = new Map<string, PostState[]>();
  private byKey = new Map<string, PostState[]>();
  add(r: PostState): void { this.rows.push(r); this.put(r); }
  private put(r: PostState) {
    (this.byTitle.get(r.title) ?? this.byTitle.set(r.title, []).get(r.title)!).push(r);
    (this.byKey.get(r.source_key) ?? this.byKey.set(r.source_key, []).get(r.source_key)!).push(r);
  }
  private drop(r: PostState) {
    for (const xs of [this.byTitle.get(r.title)!, this.byKey.get(r.source_key)!]) xs.splice(xs.indexOf(r), 1);
  }
  titled(t: string): PostState[] { return this.byTitle.get(t) ?? []; }
  keyed(k: string): PostState[] { return this.byKey.get(k) ?? []; }
  /** the row as the database now holds it (title and site id included, so the lookups follow) */
  set(r: PostState, next: Partial<PostState>): void { this.drop(r); Object.assign(r, next); this.put(r); }
}

/**
 * One source's rows written at once (ingest, ADR-063): the same identity rules as the functions above, in the same
 * order, but the batch's campaigns and their posts are read once up front and a row is written only when it would
 * come out different. A post listed again exactly as it is gets only its `last_seen_at` (what closing the posts a
 * source no longer lists goes by); a campaign, only its `last_verified_at` (the pool prefers the batch confirmed last).
 * The result is the full rewrite's, except that `updated_at` now moves only when something changed. Where the copy in
 * hand cannot tell which row the database would pick (two posts of a batch sharing one site id), the database is asked —
 * every write goes straight through, so it always holds what the full rewrite would hold at that point.
 */
export class CatalogBatch {
  /** company name → id; one found by its norm or an alias may resolve elsewhere once a company is added */
  private companies = new Map<string, string>();
  private byNorm = new Set<string>();
  private companyRows = new Map<string, { type: string; industry: string }>();
  private campaigns = new Map<string, CampaignState>(); // external_key → row
  private targets = new Map<string, CampaignInput>(); // campaign id → what its last row says
  private posts = new Map<string, Posts>(); // campaign id → its posts
  private seen = new Set<string>(); // posts listed again exactly as they are
  /** companies, campaigns and posts already there that this batch changed (a new one is not counted) */
  updated = 0;
  private added = new Set<string>(); // ids this batch created: what a later row changes in them is part of being new
  private edit(id: string) { if (!this.added.has(id)) this.updated++; }
  private st: { name: StatementSync; company: StatementSync; campaign: StatementSync; postsOf: StatementSync; post: StatementSync };

  constructor(private db: Db, externalKeys: string[]) {
    this.st = {
      name: db.prepare("select id from company where name = ?"),
      company: db.prepare("select type, industry from company where id = ?"),
      campaign: db.prepare(`select ${CAMPAIGN_COLS} from campaign where external_key = ?`),
      postsOf: db.prepare(`select ${POST_COLS} from position where campaign_id = ?`),
      post: db.prepare(`select ${POST_COLS} from position where id = ?`),
    };
    inChunks([...new Set(externalKeys)], (part, q) => { for (const r of db.prepare(`select ${CAMPAIGN_COLS} from campaign where external_key in (${q})`).all(...part) as unknown as CampaignState[]) this.campaigns.set(r.external_key, r); });
    const ids = [...this.campaigns.values()].map((c) => c.id);
    for (const id of ids) this.posts.set(id, new Posts());
    inChunks(ids, (part, q) => { for (const r of db.prepare(`select ${POST_COLS} from position where campaign_id in (${q})`).all(...part) as unknown as PostState[]) this.posts.get(r.campaign_id)!.add(r); });
  }

  /** The campaigns this batch knows of so far (read up front, or added). */
  campaignIds(): string[] { return [...this.campaigns.values()].map((c) => c.id); }

  company(name: string, type = "", industry = ""): string {
    let id = this.companies.get(name);
    if (id === undefined) {
      const exact = this.st.name.get(name) as { id: string } | undefined;
      const found = exact ?? findCompany(this.db, name);
      if (!found) {
        id = upsertCompany(this.db, name, type, industry);
        for (const n of this.byNorm) this.companies.delete(n); // a name found by its norm or an alias may find the new one first now
        this.byNorm.clear();
        this.companies.set(name, id);
        this.companyRows.set(id, { type, industry });
        this.added.add(id);
        return id;
      }
      id = found.id;
      this.companies.set(name, id);
      if (!exact) this.byNorm.add(name);
    }
    if (type || industry) {
      const cur = this.companyRows.get(id) ?? { ...(this.st.company.get(id) as { type: string; industry: string }) };
      this.companyRows.set(id, cur);
      const t = type || cur.type, i = industry || cur.industry;
      if (t !== cur.type || i !== cur.industry) { this.db.prepare("update company set type = ?, industry = ? where id = ?").run(t, i, id); cur.type = t; cur.industry = i; this.edit(id); }
    }
    return id;
  }

  /** The campaign's id. Its fields are written at `finish`, from its last row — as the full rewrite leaves them. */
  campaign(c: CampaignInput): { id: string; created: boolean } {
    let cur = this.campaigns.get(c.externalKey);
    if (!cur) {
      cur = this.st.campaign.get(c.externalKey) as unknown as CampaignState | undefined;
      if (!cur) {
        const { id } = upsertCampaign(this.db, c);
        this.campaigns.set(c.externalKey, this.db.prepare(`select ${CAMPAIGN_COLS} from campaign where id = ?`).get(id) as unknown as CampaignState);
        this.posts.set(id, new Posts());
        this.added.add(id);
        return { id, created: true };
      }
      this.campaigns.set(c.externalKey, cur);
    }
    this.targets.set(cur.id, c);
    return { id: cur.id, created: false };
  }

  position(campaignId: string, title: string, extra: PositionExtra = {}): { id: string; created: boolean } {
    let posts = this.posts.get(campaignId);
    if (!posts) {
      this.posts.set(campaignId, (posts = new Posts()));
      for (const r of this.st.postsOf.all(campaignId) as unknown as PostState[]) posts.add(r);
    }
    const key = extra.sourceKey ?? "";
    // upsertPosition's lookup over the rows in hand; where it could match more than one row, the database's order decides
    const asked = (r: { id: string } | undefined) => (r ? posts!.rows.find((x) => x.id === r.id) : undefined);
    let found: PostState | undefined;
    if (key) { const m = posts.keyed(key); found = m.length > 1 ? asked(findPostByKey(this.db, campaignId, key)) : m[0]; }
    if (!found) {
      const m = posts.titled(title);
      if (key) found = m.find((r) => r.source_key === "");
      else found = m.find((r) => r.source_key === "") ?? (m.length > 1 ? asked(findPostByTitle(this.db, campaignId, title, false)) : m[0]);
    }
    if (!found) {
      const id = insertPost(this.db, campaignId, title, extra, now());
      posts.add(this.st.post.get(id) as unknown as PostState);
      this.added.add(id);
      return { id, created: true };
    }
    const cities = json.str(extra.cities ?? []);
    const next = { title, jd_text: extra.jdText || found.jd_text, major_req: extra.majorReq || found.major_req, degree_req: extra.degreeReq || found.degree_req,
      closes_at: extra.closesAt ?? found.closes_at, cities: cities !== "[]" ? cities : found.cities, source_key: key !== "" ? key : found.source_key, status: "open" };
    if ((Object.keys(next) as (keyof typeof next)[]).some((k) => next[k] !== found![k])) { updatePost(this.db, found.id, title, extra, now()); posts.set(found, next); this.seen.delete(found.id); this.edit(found.id); }
    else this.seen.add(found.id);
    return { id: found.id, created: false };
  }

  /** Write each campaign from its last row; mark the posts listed again unchanged as seen. */
  finish(): void {
    const verified = new Map<string, string[]>(); // stamp → campaigns (one stamp per batch, as ingest gives it)
    for (const cur of this.campaigns.values()) {
      const c = this.targets.get(cur.id);
      if (!c) continue;
      if (!sameCampaign(cur, c)) { upsertCampaign(this.db, c); this.edit(cur.id); }
      else if (c.lastVerifiedAt != null && c.lastVerifiedAt !== cur.last_verified_at) (verified.get(c.lastVerifiedAt) ?? verified.set(c.lastVerifiedAt, []).get(c.lastVerifiedAt)!).push(cur.id);
    }
    // one statement per set, not one per row: the 70,000 posts of a sheet listed again unchanged take a tenth of a second
    for (const [stamp, ids] of verified) this.db.prepare("update campaign set last_verified_at = ? where id in (select value from json_each(?))").run(stamp, JSON.stringify(ids));
    if (this.seen.size) this.db.prepare("update position set last_seen_at = ? where id in (select value from json_each(?))").run(now(), JSON.stringify([...this.seen]));
  }
}
