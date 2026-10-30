import { describe, it, expect } from "vitest";
import { createServices, testConfig } from "../services.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { callTool, type Services, type Actor } from "../registry.js";
import { ingest } from "../data/index.js";
import type { Listing } from "../data/index.js";
import { beijingDay, recordFact } from "./deadlines.js";

const HUMAN: Actor = { kind: "human", via: "desktop" };
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-deadline-"));
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const s: Services = createServices({ db: db, domain, config: testConfig(dir, { sources: [] }) });
  return { dir, domain, db, s };
}
const listing = (o: Partial<Listing>): Listing => ({ externalId: o.title ?? "x", url: "https://example.com/j", title: "控制算法工程师", company: "示例", locations: ["武汉"], publisher: "示例", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "秋招", ...o });
/** n days from today, local */
const day = (n: number) => beijingDay(new Date(Date.now() + n * 86400000));
const company = async (s: Services, name: string) => ((await callTool("pool.list", { query: name }, HUMAN, s)) as any).items[0];
const post = async (s: Services, id: string) => ((await callTool("position.get", { id }, HUMAN, s)) as any);

describe("截止：事实、解析、怎么说 (ADR-041)", () => {
  it("a post's own date beats its batch's; a batch with several dates leaves an undated post 未确认, never the earliest", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "capture", "c1", [listing({ company: "荣耀", title: "机器人决策规划算法工程师", externalId: "a" }), listing({ company: "荣耀", title: "嵌入式软件工程师", externalId: "b", validThrough: day(40) })]);
    db.prepare("update campaign set closes_at = ?, deadline_kind = 'date', deadline_text = ?").run(day(3), `各岗位截止：${day(3)}、${day(20)}、${day(300)}`);
    const c = await company(s, "荣耀");
    const undated = c.positions.find((p: any) => p.title.includes("机器人")), dated = c.positions.find((p: any) => p.title.includes("嵌入式"));
    expect(undated.deadline).toMatchObject({ date: null, status: "unverified", scope: "unspecified" });
    expect(undated.deadline.say).toContain("未确认");
    expect(dated.deadline).toMatchObject({ date: day(40), status: "verified", scope: "post" });
    // the company line is a range over its posts, not the batch's earliest day
    expect(c.closesAt).toBe(day(40));
    expect(c.deadline.unverified).toBe(1);

    // the official post page says this post's own day: now it is known
    const r: any = await callTool("deadline.report", { positionId: undated.id, policy: "date", date: day(300), grade: "官方", url: "https://career.example.com/p/1", evidence: `投递截止时间 ${day(300)}` }, HUMAN, s);
    expect(r.created).toBe(true);
    expect((await post(s, undated.id)).deadline).toMatchObject({ date: day(300), status: "verified", scope: "post" });
    expect((await company(s, "荣耀")).deadline).toMatchObject({ earliest: day(40), latest: day(300), unverified: 0 });
  });

  it("官网 招满即止 goes first and the 汇总表 date is shown as a disagreement; a sheet alone is 待核实", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "moka", "m1", [listing({ company: "大疆", externalId: "d1", deadlineText: "招满即止" })]);
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "大疆", externalId: "s1", title: "校招", grade: "聚合", validThrough: day(10) }), listing({ company: "只在表里", externalId: "s2", title: "校招", grade: "聚合", validThrough: day(12) })]);
    const p = (await company(s, "大疆")).positions.find((x: any) => x.title === "控制算法工程师");
    expect(p.deadline).toMatchObject({ policy: "until_filled", date: null, status: "verified" });
    expect(p.deadline.say).toMatch(/^招满即止，宜尽早；来源有分歧：汇总表/);
    expect(p.deadline.conflicts[0].date).toBe(day(10));
    const only = (await company(s, "只在表里")).positions[0];
    expect(only.deadline).toMatchObject({ date: day(12), status: "unverified" });
    expect(only.deadline.say).toMatch(/^仅来自汇总表：.*待核实$/);
  });

  it("官网 date vs 汇总表 date: official wins, the other is named; 「月底」 agrees with a day inside it", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "beisen", "b1", [listing({ company: "示例云科", externalId: "o1", validThrough: day(10) })]);
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "示例云科", externalId: "s1", title: "校招", grade: "聚合", validThrough: day(50) })]);
    const c = await company(s, "示例云科"), p = c.positions.find((x: any) => x.title === "控制算法工程师");
    expect(p.deadline).toMatchObject({ date: day(10), status: "verified" });
    expect(p.deadline.conflicts.map((x: any) => x.date)).toEqual([day(50)]);
    expect(p.deadline.say).toContain("来源有分歧：汇总表");

    // 「月底」 and a day in that month's last third are the same statement; a day weeks earlier is not
    const end = `${day(80).slice(0, 8)}${new Date(Number(day(80).slice(0, 4)), Number(day(80).slice(5, 7)), 0).getDate()}`;
    const { dir: d2, domain: dom2, s: s2 } = setup();
    ingest(dom2, d2, "feishu-base", "f1", [listing({ company: "月底公司", externalId: "s1", grade: "聚合", validThrough: end.slice(0, 8) + "28" })]);
    const pid = (await company(s2, "月底公司")).positions[0].id;
    await callTool("deadline.report", { positionId: pid, policy: "date", date: end, precision: "month_end", grade: "官方", evidence: "网申将于月底结束" }, HUMAN, s2);
    expect((await post(s2, pid)).deadline).toMatchObject({ date: end, status: "verified", conflicts: [] });
    await callTool("deadline.report", { positionId: pid, policy: "date", date: end.slice(0, 8) + "02", grade: "校方转载", evidence: "2 日截止" }, HUMAN, s2);
    expect((await post(s2, pid)).deadline.conflicts).toHaveLength(1);
  });

  it("a 报名开始 date is never a deadline; a fact needs its sentence", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "beisen", "b1", [listing({ company: "甲", externalId: "o1" })]);
    const pid = (await company(s, "甲")).positions[0].id;
    await callTool("deadline.report", { positionId: pid, event: "application_open", policy: "date", date: day(2), grade: "官方", evidence: `${day(2)} 开始报名` }, HUMAN, s);
    expect((await post(s, pid)).deadline).toMatchObject({ date: null, say: "截止未核实" });
    await expect(callTool("deadline.report", { positionId: pid, policy: "date", date: day(9), grade: "官方", evidence: " " }, HUMAN, s)).rejects.toMatchObject({ code: "MISSING_FIELD" });
    await expect(callTool("deadline.report", { positionId: pid, policy: "date", grade: "官方", evidence: "截止见官网" }, HUMAN, s)).rejects.toMatchObject({ code: "BAD_DATE" });
  });

  it("the person's word outranks every source, on a post or a whole company, also on an expired batch, and can be taken back", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "乙", externalId: "s1", grade: "聚合", validThrough: day(-3) }), listing({ company: "乙", externalId: "s2", title: "仿真工程师", grade: "聚合", validThrough: day(-3) })]);
    const companyId = (db.prepare("select id from company where name = '乙'").get() as any).id;
    const [a, b] = (db.prepare("select id from position order by title").all() as any[]).map((r) => r.id);
    expect((await post(s, a)).deadline.expired).toBe(true);

    expect(await callTool("campaign.deadline", { companyId, policy: "no_fixed_date", sourceUrl: "https://campus.example.com" }, HUMAN, s)).toEqual({ updated: 1 });
    expect((await post(s, a)).deadline).toMatchObject({ policy: "no_fixed_date", date: null, status: "verified", expired: false, say: "本人核实：官网未设截止，宜尽早" });
    // the company's posts with no date of their own are still 在招: the stored "" once compared as a past date and they
    // left 关注中 and position.list (2026-10-14)
    expect(domain.listPositions({}).items.map((p) => p.id).sort()).toEqual([a, b].sort());
    await callTool("campaign.deadline", { companyId, positionId: b, date: day(30) }, HUMAN, s);
    expect((await post(s, b)).deadline).toMatchObject({ date: day(30), scope: "post" });
    expect((await post(s, a)).deadline.date).toBeNull();
    // a refresh of the sheet does not undo it
    ingest(domain, dir, "feishu-base", "f1", [listing({ company: "乙", externalId: "s1", grade: "聚合", validThrough: day(-3) }), listing({ company: "乙", externalId: "s2", title: "仿真工程师", grade: "聚合", validThrough: day(-3) })]);
    expect((await post(s, b)).deadline.date).toBe(day(30));

    await callTool("campaign.deadline", { companyId, clear: true }, HUMAN, s);
    await callTool("campaign.deadline", { companyId, positionId: b, clear: true }, HUMAN, s);
    expect((await post(s, a)).deadline).toMatchObject({ date: day(-3), status: "unverified", expired: true });
    await expect(callTool("campaign.deadline", { companyId, date: "下周" }, HUMAN, s)).rejects.toMatchObject({ code: "BAD_DATE" });
  });
});

describe("同一个岗位出现在两张表里，日期不同", () => {
  it("goes by the earlier day and says the sources disagree; where it is, is everywhere either says; the same day is no disagreement", async () => {
    const { dir, domain, s } = setup();
    const row = (publisher: string, company: string, title: string, deadlineText: string, city: string) => listing({ company, title, externalId: `${publisher}|${company}|${title}`, publisher, grade: "聚合", validThrough: undefined, deadlineText, locations: [city] });
    // a sheet row is one company with its posts and one deadline; 表B lists one of 示例重工's two posts, twenty days earlier
    ingest(domain, dir, "feishu-base", "sheet-a", [row("表A", "示例重工", "控制算法工程师", day(40), "武汉"), row("表A", "示例重工", "仿真工程师", day(40), "武汉"), row("表A", "示例电子", "电机控制工程师", day(30), "深圳")]);
    ingest(domain, dir, "feishu-base", "sheet-b", [row("表B", "示例重工", "控制算法工程师", day(20), "上海"), row("表B", "示例电子", "电机控制工程师", day(30), "深圳")]);
    const c = await company(s, "示例重工");
    const both = c.positions.find((p: any) => p.title === "控制算法工程师"), onlyA = c.positions.find((p: any) => p.title === "仿真工程师");
    expect(both.deadline).toMatchObject({ date: day(20), status: "unverified" });
    expect(both.deadline.say).toContain("来源有分歧");
    expect(both.deadline.conflicts.map((x: any) => x.date)).toEqual([day(40)]);
    expect(both.cities.sort()).toEqual(["上海", "武汉"]);
    // a post only one of them lists goes by that one; the other sheet's day for its own posts is not about it
    expect(onlyA.deadline).toMatchObject({ date: day(40), conflicts: [] });
    // both sheets say the same day: nothing to disagree about
    expect((await company(s, "示例电子")).positions[0].deadline).toMatchObject({ date: day(30), conflicts: [] });
    // the tool that answers for single posts says the same
    const listed: any = await callTool("position.list", { companyId: c.companyId, query: "控制算法" }, HUMAN, s);
    expect(new Set(listed.items.map((p: any) => p.deadline.date))).toEqual(new Set([day(20)]));
  });
});

describe("岗位身份：来源编号优先于标题 (ADR-041)", () => {
  it("one title, three posts with three ids stay three; a post first seen without an id is adopted, its watch kept", async () => {
    const { dir, domain, db, s } = setup();
    // read once from a captured page: one post, no id
    ingest(domain, dir, "capture", "c1", [listing({ company: "大疆", externalId: "https://example.com/j#0", grade: "官方" })]);
    const first = (db.prepare("select id from position").get() as any).id;
    await callTool("position.watch", { positionId: first, priority: 2 }, HUMAN, s);
    const three = () => ["深圳", "上海", "北京"].map((city, i) => listing({ company: "大疆", externalId: `job-${i}`, locations: [city], publisher: "示例", validThrough: undefined }));
    const campaignOf = (id: string) => (db.prepare("select campaign_id c from position where id = ?").get(id) as any).c;
    // the captured batch and the site's batch are different sources → different campaigns; inside the site's own batch:
    ingest(domain, dir, "moka", "m1", three());
    ingest(domain, dir, "moka", "m1", three());
    const rows = db.prepare("select id, source_key k, cities from position where campaign_id != ? order by source_key").all(campaignOf(first)) as any[];
    expect(rows.map((r) => r.k)).toEqual(["job-0", "job-1", "job-2"]);
    const c = await company(s, "大疆");
    const same = c.positions.filter((p: any) => p.title === "控制算法工程师");
    expect(same.map((p: any) => p.cities.join()).sort()).toEqual(["上海", "北京", "深圳", "武汉"].sort());

    // within one batch: a key-less row of the same title is adopted by the first id, not duplicated
    ingest(domain, dir, "beisen", "b1", [listing({ company: "丁", externalId: "丁-控制" , title: "丁-控制" })]);
    const keyless = (db.prepare("select id, source_key k from position where title = '丁-控制'").get() as any);
    expect(keyless.k).toBe("");
    await callTool("position.watch", { positionId: keyless.id, priority: 2 }, HUMAN, s);
    ingest(domain, dir, "beisen", "b1", [listing({ company: "丁", externalId: "9001", title: "丁-控制" }), listing({ company: "丁", externalId: "9002", title: "丁-控制", locations: ["上海"] })]);
    const after = db.prepare("select id, source_key k, watch_priority w from position where title = '丁-控制' order by source_key").all() as any[];
    expect(after.map((r) => [r.k, r.id === keyless.id, r.w > 0])).toEqual([["9001", true, true], ["9002", false, false]]);
  });

  it("posts that each carry their own day leave the batch without one", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "dayee", "d1", [listing({ company: "戊", externalId: "1", title: "甲岗", validThrough: day(5) }), listing({ company: "戊", externalId: "2", title: "乙岗", validThrough: day(200) }), listing({ company: "戊", externalId: "3", title: "丙岗" })]);
    expect(db.prepare("select closes_at, deadline_kind from campaign").get()).toMatchObject({ closes_at: null, deadline_kind: "unknown" });
    const c = await company(s, "戊");
    expect(Object.fromEntries(c.positions.map((p: any) => [p.title, p.deadline.date]))).toEqual({ 甲岗: day(5), 乙岗: day(200), 丙岗: null });
    expect(c.deadline).toMatchObject({ earliest: day(5), latest: day(200), unverified: 1 });
  });
});

describe("搜索、公司名、进度链接 (ADR-041 第 5 步)", () => {
  it("a search opens with the company of that name, then names containing it, then companies that merely have such a post", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "beisen", "a", [listing({ company: "拓竹科技", externalId: "1", title: "小红书运营" })]);
    ingest(domain, dir, "beisen", "b", [listing({ company: "小红书社区工程", externalId: "2" })]);
    ingest(domain, dir, "beisen", "c", [listing({ company: "小红书", externalId: "3" })]);
    const items = ((await callTool("pool.list", { query: "小红书" }, HUMAN, s)) as any).items;
    expect(items.map((x: any) => [x.companyName, x.matchedBy])).toEqual([["小红书", "公司名"], ["小红书社区工程", "公司名开头"], ["拓竹科技", "岗位名"]]);
    expect(((await callTool("company.search", { query: "小红书" }, HUMAN, s)) as any).items.map((x: any) => x.companyName)).toEqual(["小红书", "小红书社区工程"]);
  });

  it("a page that only calls itself 公司 is not filed under a company named 公司", async () => {
    const { dir, domain, db, s } = setup();
    ingest(domain, dir, "csv", "x", [listing({ company: "公司", externalId: "1" }), listing({ company: "本公司", externalId: "2" }), listing({ company: "国望光学", externalId: "3" })]);
    expect((db.prepare("select name from company").all() as any[]).map((r) => r.name)).toEqual(["国望光学"]);
    const text = "公司 2027届校园招聘\n招聘单位：公司\n岗位：\n1. 光学工程师\n工作地点：北京";
    await expect(callTool("listing.capture", { url: "https://example.com/n1", title: "2027届校园招聘", text }, HUMAN, s)).rejects.toMatchObject({ code: "COMPANY_UNKNOWN" });
    const r: any = await callTool("listing.capture", { url: "https://example.com/n1", title: "2027届校园招聘", text, companyName: "宇量昇" }, HUMAN, s);
    expect(r.note).toContain("宇量昇");
  });

  it("an application keeps the link where its progress is checked", async () => {
    const { dir, domain, s } = setup();
    ingest(domain, dir, "beisen", "a", [listing({ company: "甲", externalId: "1" })]);
    const pid = (await company(s, "甲")).positions[0].id;
    const app = ((await callTool("application.create", { positionId: pid }, HUMAN, s)) as any).application;
    const up: any = await callTool("application.update", { id: app.id, progressUrl: "https://careers.example.com/my" }, HUMAN, s);
    expect(up.application.progressUrl).toBe("https://careers.example.com/my");
    expect(((await callTool("application.list", {}, HUMAN, s)) as any).items[0].application.progressUrl).toBe("https://careers.example.com/my");
  });
});

describe("campaign.move", () => {
  it("a batch filed under 「公司」 moves to its real company with its posts and watches, and the next scan finds it there", async () => {
    const { dir, domain, db, s } = setup();
    db.prepare("insert into company(id, name, norm, type, industry, created_at) values ('C0', '公司', '公司', '', '', '2026-01-01')").run();
    ingest(domain, dir, "dayee", "d1", [listing({ company: "临时名", externalId: "1", publisher: "dayee:SU1" })]);
    db.prepare("update campaign set company_id = 'C0'").run();
    const cid = (db.prepare("select id from campaign").get() as any).id, pid = (db.prepare("select id from position").get() as any).id;
    await callTool("position.watch", { positionId: pid, priority: 2 }, HUMAN, s);
    await expect(callTool("campaign.move", { campaignId: cid, companyName: "本公司" }, HUMAN, s)).rejects.toMatchObject({ code: "COMPANY_UNKNOWN" });
    const r: any = await callTool("campaign.move", { campaignId: cid, companyName: "国望光学" }, HUMAN, s);
    expect(r).toMatchObject({ campaignId: cid, companyName: "国望光学", fromCompanyId: "C0" });
    // the reader, now naming the company right, feeds the same batch and the same post
    ingest(domain, dir, "dayee", "d1", [listing({ company: "国望光学", externalId: "1", publisher: "dayee:SU1" })]);
    expect(db.prepare("select count(*) n from campaign").get()).toEqual({ n: 1 });
    expect((await company(s, "国望光学")).positions).toEqual([expect.objectContaining({ id: pid, watched: true })]);
  });
});

describe("a page's statements replace its own earlier ones, and only those", () => {
  const active = (db: any, cid: string) => (db.prepare("select date_end, applies from deadline_fact where subject_type = 'campaign' and subject_id = ? and superseded_at is null order by date_end").all(cid) as any[]).map((r) => `${r.date_end} ${r.applies}`);
  it("A → B → A leaves A alone standing; another reach on the same page stays", () => {
    const { dir, domain, db } = setup();
    ingest(domain, dir, "capture", "c1", [listing({ company: "示例重工" })]);
    const cid = (db.prepare("select id from campaign").get() as any).id;
    const say = (date: string, applies?: "all_campaign_positions" | "campaign_unspecified") => recordFact(db, { campaignId: cid, policy: "date", date, applies, grade: "官方", url: "https://example.com/notice", evidence: `网申截止 ${date}` });
    say("2099-10-31");
    say("2099-11-15");
    expect(active(db, cid)).toEqual(["2099-11-15 all_campaign_positions"]);
    say("2099-10-31");
    expect(active(db, cid)).toEqual(["2099-10-31 all_campaign_positions"]);
    say("2099-12-01", "campaign_unspecified");
    expect(active(db, cid)).toEqual(["2099-10-31 all_campaign_positions", "2099-12-01 campaign_unspecified"]);
  });
});
