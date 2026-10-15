import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db.js";
import { Domain } from "./domain.js";
import { ingest, type Listing } from "../data/index.js";
import { expiredMany, changedCompanies, resolveMany, localDay, setOverride, recordFact } from "./deadlines.js";

/**
 * 「还能投吗」 is kept between callers and worked out again only for the companies where something it reads changed
 * (deadlines.ts expiredMany). After every kind of change, what is kept must be what a fresh resolution says.
 */
const day = (n: number) => localDay(new Date(Date.now() + n * 86400000));
const site = (id: string, title: string, over: Partial<Listing> = {}): Listing => ({ externalId: id, url: `https://app.mokahr.com/campus-recruitment/acme/1#/job/${id}`, title, company: "示例重工",
  locations: ["武汉"], publisher: "moka:acme", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "校招", ...over });
const sheet = (company: string, title: string, deadline: string): Listing => ({ externalId: `${company}|${title}`, url: "https://example.com/a", title, company, locations: ["北京"],
  deadlineText: deadline, publisher: "飞书校招汇总表", grade: "校方转载", isOriginal: false, confidence: 0.7, cohort: "2027届", batch: "秋招" });
// 第四家 is on the sheet alone: its deadline is what changes (示例重工's sheet rows go by the official batch's day)
const SHEET = (d = day(20)) => [sheet("示例重工", "控制算法工程师", day(20)), sheet("示例重工", "电气工程师", day(20)), sheet("另一家", "测试工程师", day(-3)), sheet("第三家", "销售", day(10)), sheet("第四家", "运营", d)];

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-kept-"));
  const db = openDb(join(dir, "t.db"));
  ingest({ db }, dir, "moka", "m", [site("j1", "控制算法工程师", { validThrough: day(5) }), site("j2", "仿真工程师")], { closeUnseen: true });
  ingest({ db }, dir, "feishu-base", "f", SHEET(), { closeUnseen: true });
  return { dir, db, domain: new Domain(db) };
}
const open = (db: Db) => db.prepare("select p.id, p.campaign_id, p.closes_at, c.company_id from position p join campaign c on c.id = p.campaign_id where p.status != 'closed'").all() as any[];
const fresh = (db: Db, posts: any[]) => { const r = resolveMany(db, posts); return Object.fromEntries(posts.map((p) => [p.id, !!r.get(p.id)?.expired])); };
const asMap = (m: Map<string, boolean>, posts: any[]) => Object.fromEntries(posts.map((p) => [p.id, m.get(p.id)]));
/** what a page asks (some posts) and what the matcher asks (all of them, kept), both against a fresh resolution */
function checked(db: Db) {
  const all = open(db), some = all.filter((_, i) => i % 2 === 0);
  expect(asMap(expiredMany(db, some), some)).toEqual(fresh(db, some));
  expect(asMap(expiredMany(db, all, { every: true }), all)).toEqual(fresh(db, all));
  expect(asMap(expiredMany(db, all), all)).toEqual(fresh(db, all));
  return JSON.stringify(fresh(db, all));
}

afterEach(() => { vi.useRealTimers(); });

describe("「还能投吗」 kept between callers (expiredMany)", () => {
  it("follows every kind of change to what it reads", () => {
    const { dir, db, domain } = setup();
    const answers = new Set<string>(), check = (d: Db) => answers.add(checked(d));
    check(db);
    // a source's batch deadline passes; then the same read again (seen marks only)
    ingest({ db }, dir, "feishu-base", "f", SHEET(day(-1)), { closeUnseen: true });
    check(db);
    ingest({ db }, dir, "feishu-base", "f", SHEET(day(-1)), { closeUnseen: true });
    check(db);
    // the official site's own day for a post moves into the past: its twin on the sheet follows
    ingest({ db }, dir, "moka", "m", [site("j1", "控制算法工程师", { validThrough: day(-2) }), site("j2", "仿真工程师")], { closeUnseen: true });
    check(db);
    // the person's word on a batch, then taken back
    const camp = (db.prepare("select campaign_id c from position where title = '测试工程师'").get() as any).c;
    setOverride(db, { subjectType: "campaign", subjectId: camp, kind: "date", date: day(30) });
    check(db);
    setOverride(db, { subjectType: "campaign", subjectId: camp, kind: "clear" });
    check(db);
    // a fact recorded from an official page
    const sim = (db.prepare("select id from position where title = '仿真工程师'").get() as any).id;
    recordFact(db, { positionId: sim, policy: "date", date: day(-1), grade: "官方", evidence: "投递截止 昨天", url: "https://example.com/n" });
    check(db);
    // a post renamed so it becomes the twin of another; a post closed; a closed post watched and applied to
    db.prepare("update position set title = '仿真工程师' where title = '电气工程师'").run();
    check(db);
    const ctrl = (db.prepare("select id from position where title = '控制算法工程师' and source_key = 'j1'").get() as any).id;
    db.prepare("update position set status = 'closed' where id = ?").run(ctrl);
    check(db);
    domain.watchPosition(ctrl, 2);
    check(db);
    domain.createApplication(ctrl);
    check(db);
    // a batch moved to another company
    const other = (db.prepare("select id from company where name = '第三家'").get() as any).id;
    db.prepare("update campaign set company_id = ? where id = ?").run(other, camp);
    check(db);
    expect(answers.size).toBeGreaterThanOrEqual(5); // the changes above did change answers (not all of them do)
  });

  it("each write to what it reads marks that company; seen marks and other columns mark nothing", () => {
    const { dir, db, domain } = setup();
    const co = (name: string) => (db.prepare("select id from company where name = ?").get(name) as any).id as string;
    const post = (title: string) => (db.prepare("select id, campaign_id from position where title = ?").get(title) as any) as { id: string; campaign_id: string };
    const marks = (write: () => void) => { expiredMany(db, open(db), { every: true }); write(); return [...changedCompanies(db)].sort(); };
    const [A, D] = [co("示例重工"), co("第四家")];
    const sales = post("运营"), sim = post("仿真工程师");
    // a read that found the same posts, and columns the answer does not read
    expect(marks(() => ingest({ db }, dir, "feishu-base", "f", SHEET(), { closeUnseen: true }))).toEqual([]);
    expect(marks(() => db.prepare("update position set jd_text = 'x', last_seen_at = '2099', updated_at = '2099' where id = ?").run(sales.id))).toEqual([]);
    expect(marks(() => db.prepare("update campaign set last_verified_at = '2099', updated_at = '2099', notes = 'x' where id = ?").run(sales.campaign_id))).toEqual([]);
    // a post: each column read, added, removed
    for (const set of ["title = '运营岗'", "cities = '[\"上海\"]'", "status = 'closed'", "watch_priority = 1", "closes_at = '2026-01-01'"]) expect(marks(() => db.prepare(`update position set ${set} where id = ?`).run(sales.id))).toEqual([D]);
    expect(marks(() => ingest({ db }, dir, "feishu-base", "f", [...SHEET(), sheet("第四家", "新岗位", day(20))]))).toEqual([D]);
    expect(marks(() => db.prepare("delete from source_listing where position_id in (select id from position where title = '新岗位')").run() && db.prepare("delete from position where title = '新岗位'").run())).toEqual([D]);
    // a batch: its deadline columns; moved to another company (both)
    expect(marks(() => db.prepare("update campaign set deadline_text = 'x' where id = ?").run(sales.campaign_id))).toEqual([D]);
    expect(marks(() => db.prepare("update campaign set company_id = ? where id = ?").run(A, sales.campaign_id))).toEqual([A, D].sort());
    // an application; a deadline fact (on a post, a batch, a company); the person's word
    expect(marks(() => domain.createApplication(sim.id))).toEqual([A]);
    expect(marks(() => recordFact(db, { positionId: sim.id, policy: "date", date: day(3), grade: "官方", evidence: "截止", url: "https://e/1" }))).toEqual([A]);
    expect(marks(() => recordFact(db, { campaignId: sim.campaign_id, policy: "date", date: day(4), grade: "官方", evidence: "截止", url: "https://e/2" }))).toEqual([A]);
    expect(marks(() => recordFact(db, { companyId: A, policy: "date", date: day(5), grade: "官方", evidence: "截止", url: "https://e/3" }))).toEqual([A]);
    expect(marks(() => setOverride(db, { subjectType: "position", subjectId: sim.id, kind: "until_filled" }))).toEqual([A]);
    expect(marks(() => setOverride(db, { subjectType: "position", subjectId: sim.id, kind: "clear" }))).toEqual([A]);
  });

  it("works it all out again when the day turns", () => {
    const { db } = setup();
    const a = checked(db);
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(Date.now() + 11 * 86400000)); // 第三家's day (+10) is now past
    expect(checked(db)).not.toBe(a);
  });

  it("a rolled-back transaction that took the change-watch with it: noticed, and worked out again", () => {
    const { dir, db } = setup();
    db.exec("begin");
    expiredMany(db, open(db), { every: true }); // the first ask sets up the watch — inside a transaction that is then rolled back
    db.exec("rollback");
    const before = fresh(db, open(db));
    ingest({ db }, dir, "feishu-base", "f", SHEET(day(-1)), { closeUnseen: true }); // a change nothing saw
    expect(fresh(db, open(db))).not.toEqual(before);
    checked(db);
  });
});
