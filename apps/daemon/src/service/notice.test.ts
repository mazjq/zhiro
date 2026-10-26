import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { ingest, type Listing } from "../data/index.js";
import { resolveFor } from "./deadlines.js";
import { checkNotice, recordCheck, siteKey, readDeadline, type NoticeDoc, type Extract, type CompanyIdentity } from "./notice.js";

const SEASON = { cohort: "2027", since: "2026-03-01" };
const CO: CompanyIdentity = { name: "示例重工股份有限公司", aliases: ["示例重工"], sites: new Set(["mokahr:acme", "careers.example-heavy.cn"]), accounts: new Set(["MzA5biz"]) };
const doc = (o: Partial<NoticeDoc> = {}): NoticeDoc => ({ url: "https://careers.example-heavy.cn/notice/1", finalUrl: "https://careers.example-heavy.cn/notice/1", via: "http", status: "ok", title: "2027届校园招聘公告",
  text: "示例重工股份有限公司 2027届校园招聘公告。招聘对象：2027届毕业生。网申截止时间：2099年10月31日。投递入口：官网。", images: [], complete: true, ...o });
const ex = (o: Partial<Extract> = {}): Extract => ({ isRecruitment: true, issuer: "示例重工股份有限公司", cohort: "2027届", cohortQuote: "招聘对象：2027届毕业生", cohortImage: null,
  deadlineText: "网申截止时间：2099年10月31日", deadlineDate: "2099-10-31", deadlineImage: null, applyEntry: "官网", scope: "全部", doubts: "", ...o });
const check = (d: Partial<NoticeDoc> = {}, e: Partial<Extract> = {}) => checkNotice(doc(d), ex(e), CO, SEASON);

describe("公告核实: only a deadline that passes all four checks becomes a fact", () => {
  it("the company's own announcement, sentence on the page, this season → a fact", () => {
    const r = check();
    expect(r.outcome).toBe("fact");
    expect(r.fact).toEqual({ policy: "date", date: "2099-10-31", evidence: "网申截止时间：2099年10月31日" });
  });

  it("whose page it is: another tenant of the same hiring system, a shared host, an account not on record", () => {
    expect(check({ finalUrl: "https://app.mokahr.com/campus-recruitment/other/1" }).gates.publisher.result).toBe("unknown");
    expect(check({ finalUrl: "https://app.mokahr.com/campus-recruitment/acme/9#/job/1" }).gates.publisher.result).toBe("pass");
    expect(check({ finalUrl: "https://www.zhaopin.com/notice/1" }).gates.publisher.result).toBe("unknown");
    expect(check({ via: "wechat", url: "https://mp.weixin.qq.com/s/x", finalUrl: "https://mp.weixin.qq.com/s/x", account: { id: "MzOther", name: "示例重工招聘" } }).outcome).toBe("review"); // a name alone proves nothing
    expect(check({ via: "wechat", url: "https://mp.weixin.qq.com/s/x", finalUrl: "https://mp.weixin.qq.com/s/x", account: { id: "MzA5biz", name: "示例重工招聘" } }).outcome).toBe("fact");
    // the page it ended on counts, not the link it started from
    expect(check({ finalUrl: "https://elsewhere.example.org/x" }).gates.publisher.result).toBe("unknown");
  });

  it("whose announcement it is: a group or a part of it is not this company", () => {
    expect(check({}, { issuer: "示例重工集团" }).gates.issuer.result).toBe("unknown");
    expect(check({}, { issuer: "示例重工集团" }).outcome).toBe("review");
    expect(check({}, { issuer: "另一家机械有限公司" }).gates.issuer.result).toBe("fail");
    expect(check({}, { issuer: "示例重工" }).gates.issuer.result).toBe("pass"); // a recorded alias
  });

  it("the sentence must be on the page, and say the day the model gave", () => {
    expect(check({}, { deadlineText: "网申截止：2099年11月15日", deadlineDate: "2099-11-15" }).gates.evidence.result).toBe("fail");
    expect(check({}, { deadlineDate: "2099-11-30" }).gates.evidence.result).toBe("fail");
    expect(check({ text: "网申时间：2099年9月1日-11月30日。" }, { deadlineText: "网申时间：2099年9月1日-11月30日", deadlineDate: "2099-11-30" }).outcome).toBe("fact");
  });

  it("a sentence whose day cannot be told by rule is left to a person", () => {
    expect(readDeadline("笔试 10月20日，网申截止 2099年10月31日")).toEqual({ unclear: "一句话里有好几个日期" });
    expect(readDeadline("网申截止 10月31日，笔试 2099年11月5日")).toEqual({ unclear: "一句话里有好几个日期" }); // never the 笔试 day
    expect(readDeadline("2099-10-01、2099-10-31")).toEqual({ unclear: "一句话里有好几个日期" }); // hyphens inside dates are no range
    expect(readDeadline("10月31日截止")).toEqual({ unclear: "原文没写年份" });
    expect(readDeadline("网上报名 9月2日—10月7日")).toEqual({ unclear: "原文没写年份" }); // a range with no year is yearless, not 「several days」
    expect(readDeadline("岗位招满即止")).toEqual({ policy: "until_filled" });
    expect(check({ text: "网申 10月31日截止" }, { deadlineText: "网申 10月31日截止", deadlineDate: "" }).outcome).toBe("review");
  });

  it("a poster is a person's to confirm; an image the material does not have is wrong", () => {
    const poster = { images: [{ n: 0, hash: "a" }, { n: 1, hash: "b" }], text: "" };
    expect(check(poster, { deadlineText: "网申截止 11月30日", deadlineImage: 1 }).outcome).toBe("review");
    expect(check(poster, { deadlineText: "网申截止 11月30日", deadlineImage: 5 }).gates.evidence.result).toBe("fail");
  });

  it("season: last year's cohort fails; no cohort but a day inside this season passes; neither is unknown", () => {
    expect(check({}, { cohort: "2026届" }).gates.season.result).toBe("fail");
    expect(check({}, { cohort: "27届" }).gates.season.result).toBe("pass");
    expect(check({}, { cohort: "26届" }).gates.season.result).toBe("fail");
    expect(check({}, { cohort: "" }).gates.season.result).toBe("pass");
    expect(check({}, { cohort: "", deadlineText: "", deadlineDate: "" }).gates.season.result).toBe("unknown");
  });

  it("a deadline for some posts only, or one the model doubted, is not written", () => {
    expect(check({}, { scope: "仅限研发类岗位" }).outcome).toBe("review");
    expect(check({}, { doubts: "图片模糊" }).outcome).toBe("review");
  });

  it("「没写截止」 only of a whole, official reading; never of a cut-off one", () => {
    const none = { deadlineText: "", deadlineDate: "" };
    expect(check({}, none).outcome).toBe("not_stated");
    expect(check({ complete: false }, none).outcome).toBe("review");
    expect(check({ status: "partial" }, none).outcome).toBe("review");
    expect(check({ finalUrl: "https://elsewhere.example.org/x" }, none).outcome).toBe("review");
    expect(check({ status: "login" }).outcome).toBe("unreadable");
  });

  it("siteKey: tenants, not hosts, on shared hiring systems", () => {
    expect(siteKey("https://app.mokahr.com/campus-recruitment/ACME/1")).toBe("mokahr:acme");
    expect(siteKey("https://acme.jobs.feishu.cn/campus")).toBe("acme.jobs.feishu.cn");
    expect(siteKey("https://www.example-heavy.cn/a")).toBe("example-heavy.cn");
    expect(siteKey("https://mp.weixin.qq.com/s/x")).toBeNull();
  });
});

describe("filing a check", () => {
  const listing = (o: Partial<Listing>): Listing => ({ externalId: "j1", url: "https://app.mokahr.com/campus-recruitment/acme/1#/job/j1", title: "控制算法工程师", company: "示例重工股份有限公司", locations: ["武汉"],
    publisher: "moka:acme", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "校招", ...o });
  function setup() {
    const dir = mkdtempSync(join(tmpdir(), "zhiro-notice-"));
    const db = openDb(join(dir, "t.db"));
    ingest({ db }, dir, "moka", "m", [listing({})], { closeUnseen: true });
    ingest({ db }, dir, "feishu-base", "f", [listing({ externalId: "s1", url: "https://example.com/sheet", deadlineText: "2099-12-20", publisher: "飞书校招汇总表", grade: "校方转载", isOriginal: false, confidence: 0.7, batch: "秋招" })], { closeUnseen: true });
    const official = (db.prepare("select id from campaign where source_kind = 'moka'").get() as any).id;
    const post = (db.prepare("select id from position where campaign_id = ?").get(official) as any).id;
    return { s: { db, vault: dir }, db, official, post };
  }
  const say = (db: any, post: string) => resolveFor(db, [post]).get(post)!;

  it("「没写截止」 does not outweigh the date another source gives", () => {
    const { s, db, official, post } = setup();
    const before = say(db, post);
    const e = ex({ deadlineText: "", deadlineDate: "" });
    const r = recordCheck(s, { type: "campaign", id: official }, doc(), e, checkNotice(doc(), e, CO, SEASON));
    expect(r.factId).toBeUndefined();
    expect(say(db, post)).toEqual(before);
    expect((db.prepare("select outcome from notice_check where id = ?").get(r.checkId) as any).outcome).toBe("not_stated");
  });

  it("a passing check writes the fact it came from; a failed reading afterwards replaces nothing", () => {
    const { s, db, official, post } = setup();
    const r = recordCheck(s, { type: "campaign", id: official }, doc(), ex(), check());
    expect(say(db, post)).toMatchObject({ date: "2099-10-31", status: "verified" });
    expect((db.prepare("select check_id from deadline_fact where id = ?").get(r.factId!) as any).check_id).toBe(r.checkId);
    const failed = doc({ status: "blocked", text: "" });
    recordCheck(s, { type: "campaign", id: official }, failed, null, null);
    expect(say(db, post)).toMatchObject({ date: "2099-10-31", status: "verified" });
  });
});
