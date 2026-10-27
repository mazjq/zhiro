import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { ingest, type Listing } from "../data/index.js";
import { resolveFor } from "./deadlines.js";
import { checkNotice, recordCheck, siteKey, readDeadline, kindsIn, batchKinds, type NoticeDoc, type Extract, type CompanyIdentity } from "./notice.js";

const SEASON = { cohort: "2027", since: "2026-03-01", until: "2027-08-31" };
const CO: CompanyIdentity = { name: "示例重工股份有限公司", aliases: ["示例重工"], sites: new Set(["mokahr:acme", "careers.example-heavy.cn"]), accounts: new Set(["MzA5biz"]) };
const doc = (o: Partial<NoticeDoc> = {}): NoticeDoc => ({ url: "https://careers.example-heavy.cn/notice/1", finalUrl: "https://careers.example-heavy.cn/notice/1", via: "http", status: "ok", title: "2027届校园招聘公告",
  text: "示例重工股份有限公司 2027届校园招聘公告。招聘对象：2027届毕业生。网申截止时间：2099年10月31日。投递入口：官网。", images: [], complete: true, ...o });
const ex = (o: Partial<Extract> = {}): Extract => ({ isRecruitment: true, issuer: "示例重工股份有限公司", cohort: "2027届", cohortQuote: "招聘对象：2027届毕业生", cohortImage: null,
  deadlineText: "网申截止时间：2099年10月31日", deadlineDate: "2099-10-31", deadlineImage: null, applyEntry: "官网", scope: "全部", doubts: "",
  seen: { chars: 1_000_000, images: 99, model: "first" }, ...o });
const check = (d: Partial<NoticeDoc> = {}, e: Partial<Extract> = {}) => checkNotice(doc(d), ex(e), CO, SEASON);

describe("批次: the material is the batch's kind of recruitment, both ways", () => {
  const b = (kind: string, batch: string, title: string, batchQuote = "") => checkNotice(doc({ title }), ex({ batchQuote }), CO, SEASON, { kind, batch }).gates.batch;
  it("kinds and rounds", () => {
    expect(kindsIn("2027届秋季校园招聘暨实习生招聘")).toEqual(new Set(["intern", "main"]));
    expect(kindsIn("2027届实习生招聘")).toEqual(new Set(["intern"]));
    expect(kindsIn("某所2027届招聘启事")).toEqual(new Set(["main"]));
    expect(batchKinds({ kind: "校招", batch: "秋招提前批" })).toEqual(new Set(["early"]));
    expect(batchKinds({ kind: "实习", batch: "春招、实习" })).toEqual(new Set(["spring", "intern"]));
    expect(batchKinds({ kind: "校招", batch: "" })).toEqual(new Set(["main"]));
  });
  it("the same recruitment passes; another round or kind does not; one that does not say is left for review", () => {
    expect(b("校招", "秋招", "2027届校园招聘公告").result).toBe("pass");
    expect(b("校招", "秋招", "2027届秋季校园招聘提前批").result).toBe("fail"); // the early round is another batch
    expect(b("校招", "秋招提前批", "2027届秋季校园招聘公告").result).toBe("fail"); // and the other way round
    expect(b("校招", "秋招提前批", "2027届提前批招聘").result).toBe("pass");
    expect(b("校招", "秋招", "2027届暑期实习生招聘").result).toBe("fail");
    expect(b("实习", "春招、实习", "2027届暑期实习生招聘").result).toBe("pass");
    expect(b("校招", "秋招", "2027届春季补录公告").result).toBe("fail");
    expect(b("校招", "2027年度高校毕业生统招公告", "2027年度西藏青海新疆高校毕业生专项招聘公告").result).toBe("fail");
    expect(b("校招", "秋招", "招聘岗位一览").result).toBe("unknown");
    expect(b("校招", "秋招", "招聘岗位一览", "2027届校园招聘").result).toBe("pass"); // the words in the body, on the page
    expect(b("校招", "秋招", "招聘岗位一览", "2027届秋季校园招聘（不在页上）").result).toBe("unknown");
  });
  it("another batch's announcement writes no deadline", () => {
    expect(checkNotice(doc({ title: "2027届暑期实习生招聘" }), ex(), CO, SEASON, { kind: "校招", batch: "秋招" }).outcome).toBe("review");
  });
});

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
    expect(check({}, { issuer: "中国示例重工股份有限公司" }).gates.issuer.result).toBe("pass"); // 「中国」 in front
  });

  it("the sentence must be on the page, and say the day the model gave", () => {
    expect(check({}, { deadlineText: "网申截止：2099年11月15日", deadlineDate: "2099-11-15" }).gates.evidence.result).toBe("fail");
    expect(check({}, { deadlineDate: "2099-11-30" }).gates.evidence.result).toBe("fail");
    expect(check({ text: "招聘对象：2027届毕业生。网申时间：2099年9月1日-11月30日。" }, { deadlineText: "网申时间：2099年9月1日-11月30日", deadlineDate: "2099-11-30" }).outcome).toBe("fact");
  });

  it("a sentence whose day cannot be told by rule is left to a person", () => {
    expect(readDeadline("笔试 10月20日，网申截止 2099年10月31日")).toEqual({ unclear: "一句话里有好几个日期" });
    expect(readDeadline("网申截止 10月31日，笔试 2099年11月5日")).toEqual({ unclear: "一句话里有好几个日期" }); // never the 笔试 day
    expect(readDeadline("2099-10-01、2099-10-31")).toEqual({ unclear: "一句话里有好几个日期" }); // hyphens inside dates are no range
    expect(readDeadline("10月31日截止")).toEqual({ unclear: "原文没写年份" });
    expect(readDeadline("网上报名 9月2日—10月7日")).toEqual({ unclear: "原文没写年份" }); // a range with no year is yearless, not 「several days」
    expect(readDeadline("岗位招满即止")).toEqual({ policy: "until_filled" });
    expect(readDeadline("网申时间 2026 8.10 ▶ 12.31")).toEqual({ policy: "date", date: "2026-12-31" }); // a poster's way
    expect(check({ text: "网申 10月31日截止" }, { deadlineText: "网申 10月31日截止", deadlineDate: "" }).outcome).toBe("review");
  });

  it("a poster counts only when a second model, reading on its own, names the same day, reach and terms", () => {
    const poster = { images: [{ n: 0, hash: "a" }, { n: 1, hash: "b" }], text: "示例重工股份有限公司 2027届校园招聘" };
    const first = { deadlineText: "网申截止：2099年11月30日", deadlineDate: "2099-11-30", deadlineImage: 1, scope: "", cohortQuote: "2027届校园招聘" };
    const second = (o = {}) => ({ poster: { model: "second", deadlineText: "网申截止时间 2099年11月30日", deadlineDate: "2099-11-30", scope: "", image: 1, ...o } });
    expect(check(poster, first).gates.evidence.result).toBe("unknown"); // read once
    expect(check(poster, { ...first, ...second() }).outcome).toBe("fact");
    expect(check(poster, { ...first, ...second() }).fact?.evidence).toBe("海报图 1：网申截止：2099年11月30日");
    expect(check(poster, { ...first, ...second({ model: "first" }) }).gates.evidence.result).toBe("unknown"); // the same model twice
    expect(check(poster, { ...first, ...second({ deadlineText: "网申截止 2099年11月20日" }) }).gates.evidence.result).toBe("unknown");
    expect(check(poster, { ...first, ...second({ scope: "研发类岗位" }) }).gates.evidence.result).toBe("unknown");
    expect(check(poster, { ...first, ...second({ deadlineText: "部分岗位网申截止 2099年11月30日" }) }).gates.evidence.result).toBe("unknown"); // terms differ, not 「contains」
    expect(check(poster, { ...first, deadlineImage: 5 }).gates.evidence.result).toBe("fail");
  });

  it("days that are no days, ranges backwards, a whole that is not whole", () => {
    expect(readDeadline("网申截止 2099年2月30日")).toEqual({ unclear: "原文里没有日期" });
    expect(readDeadline("2099年11月30日至10月1日")).toEqual({ unclear: "日期区间前后颠倒" });
    expect(check({ text: "网申截止时间：2099年10月31日（部分岗位除外）" }, { deadlineText: "网申截止时间：2099年10月31日（部分岗位除外）" }).outcome).toBe("review");
    expect(check({}, { scope: "全部岗位，部分地区另行通知" }).outcome).toBe("review");
  });

  it("the cohort's words must be in the material — its title counts", () => {
    expect(check({}, { cohortQuote: "招聘对象：2027届本科及以上毕业生" }).gates.season.result).toBe("unknown");
    expect(check({ title: "示例重工2027届校园招聘正式启动" }, { cohortQuote: "示例重工2027届校园招聘正式启动" }).gates.season.result).toBe("pass");
  });

  it("「甲（以下简称乙）」 in the material ties a full name to the one on record; a likeness does not", () => {
    const text = "示例装备集团股份有限公司研发总院（以下简称示例重工）2027届校园招聘。招聘对象：2027届毕业生。网申截止时间：2099年10月31日。";
    const named = { issuer: "示例装备集团股份有限公司研发总院", issuerNames: [{ name: "示例重工", quote: "示例装备集团股份有限公司研发总院（以下简称示例重工）" }] };
    expect(check({ text }, named).gates.issuer.result).toBe("pass");
    expect(check({ text: text.replace("（以下简称示例重工）", "") }, named).gates.issuer.result).toBe("fail"); // the sentence is not there
    expect(check({ text }, { ...named, issuerNames: [{ name: "示例重工", quote: "示例装备集团股份有限公司研发总院与示例重工" }] }).gates.issuer.result).toBe("fail"); // no 简称
    const apart = "示例装备集团股份有限公司研发总院（简称研发总院）与示例重工合作";
    expect(check({ text: apart }, { ...named, issuerNames: [{ name: "示例重工", quote: apart }] }).gates.issuer.result).toBe("fail"); // the word ties another name
  });

  it("season: last year's cohort fails; no cohort but a day inside this season passes; neither is unknown", () => {
    expect(check({ text: "招聘对象：2026届毕业生" }, { cohort: "2026届", cohortQuote: "招聘对象：2026届毕业生" }).gates.season.result).toBe("fail");
    expect(check({ text: "面向27届毕业生" }, { cohort: "27届", cohortQuote: "面向27届毕业生" }).gates.season.result).toBe("pass");
    expect(check({ text: "面向26届毕业生" }, { cohort: "26届", cohortQuote: "面向26届毕业生" }).gates.season.result).toBe("fail");
    expect(check({ text: "网申截止时间：2026年10月31日" }, { cohort: "", deadlineText: "网申截止时间：2026年10月31日", deadlineDate: "2026-10-31" }).gates.season.result).toBe("pass");
    expect(check({ text: "网申截止时间：2099年10月31日" }, { cohort: "", deadlineText: "网申截止时间：2099年10月31日" }).gates.season.result).toBe("unknown"); // 2099 is past this season's end
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
    expect(check({}, { ...none, seen: { chars: 10, images: 99, model: "first" } }).outcome).toBe("review"); // the model saw a part
    expect(check({ images: [{ n: 0, hash: "a" }] }, { ...none, seen: { chars: 1_000_000, images: 0, model: "first" } }).outcome).toBe("review"); // nor the poster
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

describe("a central enterprise's own hiring platform carrying a unit's announcement", () => {
  const UNIT: CompanyIdentity = { name: "示例集团有限公司第一研究所", aliases: ["示例一所"], sites: new Set(), accounts: new Set(), groupSites: new Map([["zhaopin.example-group.cn", { group: "示例集团", ids: ["s1"], names: ["示例集团有限公司"] }]]) };
  const on = (issuer: string, text = `${issuer} 2027届校园招聘公告。招聘对象：2027届毕业生。网申截止时间：2099年10月31日。`) =>
    checkNotice(doc({ url: "https://zhaopin.example-group.cn/n/1", finalUrl: "https://zhaopin.example-group.cn/n/1", text }), ex({ issuer }), UNIT, SEASON);
  it("in the unit's exact name, on the page: the group's platform is its publisher, for this announcement", () => {
    const r = on("示例集团有限公司第一研究所");
    expect(r.gates.publisher).toMatchObject({ result: "pass", deps: [{ kind: "site", id: "s1" }] });
    expect(r.outcome).toBe("fact");
  });
  it("in another name, an alias, or a name not on the page: not", () => {
    expect(on("示例集团有限公司").gates.publisher.result).toBe("unknown"); // the group's own announcement
    expect(on("示例一所").gates.publisher.result).toBe("unknown"); // an alias from a sheet vouches for nothing
    expect(on("示例集团有限公司第一研究所", "2027届校园招聘公告。网申截止时间：2099年10月31日。").gates.publisher.result).toBe("unknown");
  });
});
