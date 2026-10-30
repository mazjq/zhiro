import { describe, it, expect, vi } from "vitest";
import { createServices, testConfig } from "../services.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { callTool, type Services, type Actor } from "../registry.js";
import { ingest } from "../data/index.js";
import type { Listing } from "../data/index.js";
import { beijingDay } from "./deadlines.js";
import { loadContext as matchContext } from "../recommenders/common.js";
import { expandable } from "../recommenders/expand.js";
import { listGaps } from "./opportunity-gaps.js";
import { listLeads } from "./leads.js";
import { poolDirty } from "./pool.js";

/**
 * Technical-debt block 2 (docs/plans/2026-10-14-tech-debt.md, items 1 and 2): one deadline, one 「同一岗位」.
 * The person's word lives in deadline_override only; every "is it still open?" is answered by the resolver, by what
 * the caller is asking; the pool and the tool answers group posts the same way.
 */
const HUMAN: Actor = { kind: "human", via: "desktop" };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-unify-"));
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const s: Services = createServices({ db: db, domain, config: testConfig(dir, { sources: [] }) });
  return { dir, domain, db, s };
}
const listing = (o: Partial<Listing>): Listing => ({ externalId: o.title ?? "x", url: "https://example.com/j", title: "控制算法工程师", company: "示例", locations: ["武汉"], publisher: "示例", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "秋招", ...o });
const day = (n: number) => beijingDay(new Date(Date.now() + n * 86400000));
const tick = () => new Promise((r) => setTimeout(r, 5));
// an ingest is a background write: the pool answers from its old rows once and rebuilds behind; here, read it fresh
const company = async (s: Services, name: string) => { poolDirty(); return ((await callTool("pool.list", { query: name }, HUMAN, s)) as any).items.find((x: any) => x.companyName === name); };
const post = async (s: Services, id: string) => ((await callTool("position.get", { id }, HUMAN, s)) as any);
const listed = async (s: Services, q: any = {}) => ((await callTool("position.list", { limit: 1000, ...q }, HUMAN, s)) as any).items.map((p: any) => p.id as string).sort();
const candidates = (s: Services) => matchContext(s).candidates.map((c) => c.id).sort();
const companyId = (db: any, name: string) => (db.prepare("select id from company where name = ?").get(name) as any).id as string;
const postId = (db: any, title: string, city?: string) => (db.prepare(`select id from position where title = ?${city ? " and cities like ?" : ""}`).get(title, ...(city ? [`%${city}%`] : [])) as any).id as string;
/** a post the rules found task-related, with one requirement they could not confirm (what 机会缺口 counts) */
const assess = (db: any, positionId: string) => db.prepare("insert into position_assessment(position_id, json, created_at) values (?,?,?)")
  .run(positionId, JSON.stringify({ A: 60, tier: "可迁移", judgements: [{ modality: "required", status: "unknown", concepts: ["ros"], importance: "core", quote: "熟悉 ROS" }] }), "2026-10-14");
/** profile matching named this company only from a sheet: a 待补资料 lead, and a 待展开 company */
const lead = (db: any, cid: string) => db.prepare("insert into recommendation(id, company_id, position_id, mode, tag, score, reason, created_at) values (?,?,?,?,?,?,?,?)")
  .run(`r-${cid}`, cid, "", "profile_match", "画像匹配", 50, "待补资料：汇总表只写了专业", "2026-10-14");

describe("「同一岗位」：岗位池的分组规则（现状，抽出后岗位池和工具答复共用）", () => {
  it("one batch listing a title more than once keeps them apart by city; a title seen once merges across sources; a taken-down post stays only while held and is not counted", async () => {
    const { dir, domain, db, s } = setup();
    const three = (keep: number[]) => [listing({ company: "大疆", externalId: "j0", locations: ["深圳"] }), listing({ company: "大疆", externalId: "j1", locations: ["上海"] }), listing({ company: "大疆", externalId: "j2", locations: ["北京"] }), listing({ company: "大疆", externalId: "sim", title: "仿真工程师" })].filter((_, i) => keep.includes(i) || i === 3);
    ingest(domain, dir, "moka", "m1", three([0, 1, 2]), { closeUnseen: true });
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "大疆", externalId: "s1", title: "仿真工程师", grade: "聚合", locations: ["武汉"] })]);
    let c = await company(s, "大疆");
    const ctrl = () => c.positions.filter((p: any) => p.title === "控制算法工程师");
    expect(ctrl().map((p: any) => p.cities.join()).sort()).toEqual(["上海", "北京", "深圳"]);
    const sim = c.positions.filter((p: any) => p.title === "仿真工程师");
    expect(sim).toHaveLength(1);
    expect(sim[0].grades).toEqual(["官方", "聚合"]);
    expect(sim[0].cities.sort()).toEqual(["武汉"].sort());

    // 北京 watched, then the site drops it: it stays (held); 上海 dropped unwatched: gone
    await callTool("position.watch", { positionId: postId(db, "控制算法工程师", "北京"), priority: 2 }, HUMAN, s);
    await tick();
    ingest(domain, dir, "moka", "m1", three([0]), { closeUnseen: true });
    c = await company(s, "大疆");
    // only 深圳 is still open, so the title is "seen once" in the batch: the held 北京 post folds into it
    expect(ctrl()).toHaveLength(1);
    expect(ctrl()[0].cities.sort()).toEqual(["北京", "深圳"].sort());
    expect(ctrl()[0].watched).toBe(true);
  });
});

describe("「同一岗位」：工具答复按岗位池的分组找同一岗位", () => {
  it("same title in three cities of one batch: each post keeps its own day in position.get and position.list, as in the pool", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "moka", "m1", [["深圳", 10], ["上海", 20], ["北京", 30]].map(([city, n], i) => listing({ company: "大疆", externalId: `j${i}`, locations: [city as string], validThrough: day(n as number) })));
    const pool = Object.fromEntries((await company(s, "大疆")).positions.map((p: any) => [p.cities[0], p.deadline.date]));
    expect(pool).toEqual({ 深圳: day(10), 上海: day(20), 北京: day(30) });
    for (const [city, n] of [["深圳", 10], ["上海", 20], ["北京", 30]] as const) {
      const d = (await post(s, postId(db, "控制算法工程师", city))).deadline;
      expect(d).toMatchObject({ date: day(n), conflicts: [] });
    }
    const viaList = ((await callTool("position.list", { query: "控制算法" }, HUMAN, s)) as any).items.map((p: any) => [p.cities[0], p.deadline.date]);
    expect(Object.fromEntries(viaList)).toEqual(pool);
  });

  it("titles that differ only in width, case or spacing are one post in position.get too", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "beisen", "b1", [listing({ company: "示例电子", externalId: "o1", title: "AI算法工程师", validThrough: day(10) })]);
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "示例电子", externalId: "s1", title: "ＡＩ算法 工程师", grade: "聚合", validThrough: day(40) })]);
    const p = (await company(s, "示例电子")).positions;
    expect(p).toHaveLength(1);
    expect(p[0].deadline).toMatchObject({ date: day(10), status: "verified" });
    const sheetPost = (db.prepare("select p.id from position p join campaign c on c.id = p.campaign_id where c.source_grade = '聚合'").get() as any).id;
    const d = (await post(s, sheetPost)).deadline;
    expect(d).toMatchObject({ date: day(10), status: "verified" });
    expect(d.conflicts.map((x: any) => x.date)).toEqual([day(40)]);
  });

  it("a post the site took down but the person watches is the same post in the pool and in position.get, from either side", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "moka", "m1", [listing({ company: "示例重工", externalId: "o1", validThrough: day(5) }), listing({ company: "示例重工", externalId: "o2", title: "别的岗" })], { closeUnseen: true });
    const official = postId(db, "控制算法工程师");
    await callTool("position.watch", { positionId: official, priority: 2 }, HUMAN, s);
    await tick();
    ingest(domain, dir, "moka", "m1", [listing({ company: "示例重工", externalId: "o2", title: "别的岗" })], { closeUnseen: true });
    expect((db.prepare("select status from position where id = ?").get(official) as any).status).toBe("closed");
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "示例重工", externalId: "s1", grade: "聚合", validThrough: day(30) })]);
    const sheet = (db.prepare("select id from position where title = '控制算法工程师' and id != ?").get(official) as any).id;
    const row = (await company(s, "示例重工")).positions.filter((p: any) => p.title === "控制算法工程师");
    expect(row).toHaveLength(1);
    expect(row[0].watched).toBe(true);
    const fromOfficial = (await post(s, official)).deadline, fromSheet = (await post(s, sheet)).deadline;
    expect(fromOfficial.date).toBe(row[0].deadline.date);
    expect(fromSheet.date).toBe(row[0].deadline.date);
    expect(fromSheet.say).toBe(fromOfficial.say);
  });
});

describe("还开着吗：按用途三问，都由解析器回答", () => {
  it("a later day set by the person brings the post back into matching, 机会缺口, position.list, and its company back as a lead and as 待展开", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "乙", externalId: "s1", grade: "聚合", validThrough: day(-3), url: "https://mp.weixin.qq.com/s/abc" })]);
    const pid = postId(db, "控制算法工程师"), cid = companyId(db, "乙");
    assess(db, pid); lead(db, cid);
    expect(candidates(s)).toEqual([]);
    expect(await listed(s)).toEqual([]);
    expect(listGaps(s).assessed).toBe(0);
    expect(listLeads(s)).toEqual([]);
    expect(expandable(s).has(cid)).toBe(false);

    await callTool("campaign.deadline", { companyId: cid, date: day(30), text: "官网写 11 月底截止" }, HUMAN, s);
    expect(candidates(s)).toEqual([pid]);
    expect(await listed(s)).toEqual([pid]);
    expect(listGaps(s).assessed).toBe(1);
    expect(listLeads(s).map((l) => [l.companyId, l.closesAt])).toEqual([[cid, day(30)]]);
    expect(expandable(s).has(cid)).toBe(true);
    expect((await company(s, "乙")).expired).toBe(false);
  });

  it("a post whose own day has passed is closed everywhere, though its batch has no day", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "dayee", "d1", [listing({ company: "戊", externalId: "1", title: "甲岗", validThrough: day(-2) }), listing({ company: "戊", externalId: "2", title: "乙岗", validThrough: day(30) })]);
    const gone = postId(db, "甲岗"), open = postId(db, "乙岗");
    assess(db, gone); assess(db, open);
    expect(candidates(s)).toEqual([open]);
    expect(await listed(s)).toEqual([open]);
    expect(listGaps(s).assessed).toBe(1);
    const c = await company(s, "戊");
    expect(c.positions.find((p: any) => p.id === gone).deadline.expired).toBe(true);
    expect(c.positions.find((p: any) => p.id === open).deadline.expired).toBe(false);
  });

  it("campaign.list keeps saying what the source said, and adds what the batch goes by", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "乙", externalId: "s1", grade: "聚合", validThrough: day(-3) })]);
    const cid = companyId(db, "乙");
    await callTool("campaign.deadline", { companyId: cid, date: day(30) }, HUMAN, s);
    const c = ((await callTool("campaign.list", { query: "乙" }, HUMAN, s)) as any).items[0];
    expect(c.closesAt).toBe(day(-3));
    expect(c.deadline).toMatchObject({ date: day(30), status: "verified", expired: false });
    expect(c.deadline.say).toContain("本人核实");
  });
});

describe("本人的判断只存一份", () => {
  it("campaign.deadline writes deadline_override only; position.get's campaignClosesAt reads it, its meaning unchanged", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "乙", externalId: "s1", grade: "聚合", validThrough: day(-3) })]);
    const pid = postId(db, "控制算法工程师"), cid = companyId(db, "乙");
    expect((await post(s, pid)).campaignClosesAt).toBe(day(-3));
    await callTool("campaign.deadline", { companyId: cid, date: day(30) }, HUMAN, s);
    expect(db.prepare("select count(*) n from campaign where overridden_at is not null or closes_at_override is not null").get()).toEqual({ n: 0 });
    expect((await post(s, pid)).campaignClosesAt).toBe(day(30));
    await callTool("campaign.deadline", { companyId: cid, policy: "until_filled" }, HUMAN, s);
    expect((await post(s, pid)).campaignClosesAt).toBeNull();
    expect(await listed(s, { watchedOnly: false })).toEqual([pid]);
    await callTool("campaign.deadline", { companyId: cid, clear: true }, HUMAN, s);
    expect((await post(s, pid)).campaignClosesAt).toBe(day(-3));
    expect(await listed(s)).toEqual([]);
  });
});

describe("午夜前后：都按北京日期", () => {
  // SQLite's date('now') is the UTC day of the real clock: a day off the Beijing day from 0 to 8 a.m. Beijing. A fake
  // clock cannot move SQLite's, so the test sets the clock to 1 a.m. Beijing three days ahead — a day SQLite's real UTC
  // day cannot be — and asks every caller which day it is. Deadlines are Beijing dates wherever the computer is.
  it("at 1 a.m. Beijing, yesterday's deadline has passed for every caller, today's has not", async () => {
    const { dir, domain, db, s } = setup();
    const at = new Date(beijingDay(new Date(Date.now() + 3 * 86400000)) + "T01:00:00+08:00");
    const yesterday = beijingDay(new Date(at.getTime() - 2 * 3600_000)), today = beijingDay(at);
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "昨天截止", externalId: "a", grade: "聚合", validThrough: yesterday, url: "https://mp.weixin.qq.com/s/a" }), listing({ company: "今天截止", externalId: "b", grade: "聚合", validThrough: today, url: "https://mp.weixin.qq.com/s/b" })]);
    const gone = companyId(db, "昨天截止"), open = companyId(db, "今天截止");
    const goneP = (db.prepare("select p.id from position p join campaign c on c.id = p.campaign_id where c.company_id = ?").get(gone) as any).id;
    const openP = (db.prepare("select p.id from position p join campaign c on c.id = p.campaign_id where c.company_id = ?").get(open) as any).id;
    assess(db, goneP); assess(db, openP); lead(db, gone); lead(db, open);
    vi.useFakeTimers({ toFake: ["Date"] });
    try {
      vi.setSystemTime(at);
      expect(candidates(s)).toEqual([openP]);
      expect(await listed(s)).toEqual([openP]);
      expect(listGaps(s).assessed).toBe(1);
      expect(listLeads(s).map((l) => l.companyId)).toEqual([open]);
      expect([expandable(s).has(gone), expandable(s).has(open)]).toEqual([false, true]);
      expect([(await company(s, "昨天截止")).expired, (await company(s, "今天截止")).expired]).toEqual([true, false]);
      const within = ((await callTool("campaign.list", { deadlineWithinDays: 30 }, HUMAN, s)) as any).items.map((c: any) => c.companyId);
      expect(within).toEqual([open]);
    } finally { vi.useRealTimers(); }
  });
});

describe("公司页黄框「其他来源写的截止」：按 ADR-041 的规则重算", () => {
  it("lists a date that really disagrees; another drive (实习) or another batch of the same kind of source does not", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "beisen", "b1", [listing({ company: "甲", externalId: "o1", validThrough: day(10) })]);
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "甲", externalId: "s1", title: "校招", grade: "聚合", validThrough: day(40) })]);
    ingest(domain, dir, "feishu-base", "f2", [listing({ company: "甲", externalId: "i1", title: "实习生", grade: "聚合", kind: "实习", batch: "实习", publisher: "实习表", validThrough: day(60) })]);
    const c = await company(s, "甲");
    expect(c.conflicts.map((x: any) => [x.value, x.grade])).toEqual([[day(40), "聚合"]]);
  });

  it("the person's word on the batch leaves nothing to disagree with", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "beisen", "b1", [listing({ company: "甲", externalId: "o1", validThrough: day(10) })]);
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "甲", externalId: "s1", title: "校招", grade: "聚合", validThrough: day(40) })]);
    await callTool("campaign.deadline", { companyId: companyId(db, "甲"), date: day(20) }, HUMAN, s);
    expect((await company(s, "甲")).conflicts).toEqual([]);
  });
});
