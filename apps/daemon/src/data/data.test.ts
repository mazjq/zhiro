import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { ingest } from "./ingest.js";
import { toListing, mokaTenant } from "./readers/moka.js";
import type { Listing } from "./types.js";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-src-"));
  return { dir, domain: { db: openDb(join(dir, "t.db")) } };
}
const L = (over: Partial<Listing> = {}): Listing => ({
  externalId: "j1", url: "https://app.mokahr.com/campus-recruitment/x/1#/job/j1", title: "控制算法工程师", company: "示例", locations: ["湖北 武汉市"],
  description: "jd", publisher: "moka:x", grade: "官方", isOriginal: true, confidence: 0.9, cohort: "2027届", batch: "秋招", ...over,
});

describe("ingest", () => {
  it("is idempotent per source+publisher+company+cohort+batch and counts new vs seen", () => {
    const { dir, domain } = setup();
    const a = ingest(domain, dir, "moka", "cfg1", [L(), L({ externalId: "j2", title: "仿真工程师", url: "https://x/#/job/j2" })]);
    expect(a).toMatchObject({ received: 2, campaigns: 1, positionsNew: 2, positionsSeen: 0 });
    const b = ingest(domain, dir, "moka", "cfg1", [L(), L({ externalId: "j2", title: "仿真工程师", url: "https://x/#/job/j2" }), L({ externalId: "j3", title: "新岗位", url: "https://x/#/job/j3" })]);
    expect(b).toMatchObject({ campaigns: 1, positionsNew: 1, positionsSeen: 2 });
    expect(domain.db.prepare("select count(*) as n from source_listing").get()).toEqual({ n: 3 });
    expect(domain.db.prepare("select count(*) as n from scan_run").get()).toEqual({ n: 2 });
    expect(domain.db.prepare("select co.name companyName, c.source_grade sourceGrade, c.source_kind sourceKind, c.batch from campaign c join company co on co.id = c.company_id").get()).toEqual({ companyName: "示例", sourceGrade: "官方", sourceKind: "moka", batch: "秋招" });
  });
  it("a different batch is a different campaign", () => {
    const { dir, domain } = setup();
    ingest(domain, dir, "moka", "c", [L()]);
    ingest(domain, dir, "moka", "c", [L({ batch: "提前批" })]);
    expect(domain.db.prepare("select count(*) n from campaign").get()).toEqual({ n: 2 });
  });
});

describe("moka mapping", () => {
  it("parses tenant and maps vendor job → listing", () => {
    expect(mokaTenant("https://apply.careers.dji.com/campus-recruitment/dji/143359#/jobs")).toEqual({ orgId: "dji", siteId: "143359", canonical: "https://app.mokahr.com/campus-recruitment/dji/143359" });
    expect(mokaTenant("https://example.com/apply/x/1")).toBeNull();
    expect(mokaTenant("https://app.mokahr.com/campus-recruitment/voyah/146293")).toMatchObject({ orgId: "voyah", siteId: "146293" });
    expect(mokaTenant("https://example.com")).toBeNull();
    const l = toListing(
      { title: "底盘控制", url: "https://app.mokahr.com/campus-recruitment/voyah/146293#/job/abc%2F1", company: "voyah", location: "湖北 武汉市/上海 浦东", description: "类型: 全职\n部门: 智能底盘\n要求 博士" },
      { id: "m", source: "moka", url: "https://app.mokahr.com/campus-recruitment/voyah/146293", name: "岚图汽车", cohort: "2027届" },
    );
    expect(l).toMatchObject({ externalId: "abc/1", company: "岚图汽车", orgUnit: "智能底盘", employmentType: "全职", degreeReq: "博士", kind: "博士专项", batch: "校招", grade: "官方", publisher: "moka:voyah" });
    expect(l.locations).toEqual(["湖北 武汉市", "上海 浦东"]);
  });
});

import { rowsToListings, parseBaseUrl } from "./readers/feishu-base.js";

describe("feishu-base", () => {
  it("recognises a shared base link", () => {
    expect(parseBaseUrl("https://x.feishu.cn/base/AbC123?table=tbl1&view=vew1")).toEqual({ origin: "https://x.feishu.cn", base: "AbC123", table: "tbl1", view: "vew1" });
    expect(parseBaseUrl("https://x.feishu.cn/docx/AbC123")).toBeNull();
  });
  it("maps rows to listings: cohort filter, expired rows dropped, never graded 官方", () => {
    const fieldMap = {
      f1: { name: "公司", type: 1 }, f2: { name: "招聘届次", type: 4, property: { options: [{ id: "o27", name: "2027届" }, { id: "o26", name: "2026届" }] } },
      f3: { name: "招聘岗位", type: 1 }, f4: { name: "截止时间", type: 1 }, f5: { name: "简历投递链接", type: 1 }, f6: { name: "公告来源", type: 20 },
      f7: { name: "工作地点", type: 4, property: { options: [{ id: "c1", name: "武汉" }, { id: "c2", name: "上海" }] } }, f8: { name: "企业类型", type: 3, property: { options: [{ id: "t1", name: "央国企" }] } },
    };
    const text = (s: string) => ({ value: [{ type: "text", text: s }] });
    const row = (o: Record<string, { value: unknown }>) => ({ f1: text("示例重工"), f3: text("控制算法工程师、仿真工程师"), f6: text("官网"), f7: { value: ["c1", "c2"] }, f8: { value: "t1" }, ...o });
    const records = {
      r1: row({ f2: { value: ["o27"] }, f4: text("2099-10-31"), f5: { value: [{ type: "url", text: "投递", link: "https://apply.example.com/a" }] } }),
      r2: row({ f2: { value: ["o26"] }, f4: text("2099-10-31") }),
      r3: row({ f2: { value: ["o27"] }, f4: text("2020-01-01") }),
    };
    const out = rowsToListings(fieldMap, records, { cohort: "2027届", name: "汇总表" });
    expect(out.map((l) => l.title)).toEqual(["控制算法工程师", "仿真工程师"]);
    expect(out[0]).toMatchObject({ company: "示例重工", url: "https://apply.example.com/a", locations: ["武汉", "上海"], companyType: "央国企", grade: "聚合", cohort: "2027届", externalId: "r1|控制算法工程师" });
  });
});

import { campaignUrl } from "./ingest.js";

describe("campaignUrl", () => {
  it("keeps SPA routes, turns a single-job route into the job list, and gives bare Moka tenants a route", () => {
    expect(campaignUrl("https://app.mokahr.com/campus-recruitment/dfmc/168424#/jobs")).toBe("https://app.mokahr.com/campus-recruitment/dfmc/168424#/jobs");
    expect(campaignUrl("https://app.mokahr.com/campus-recruitment/dfmc/168424#/job/abc-123")).toBe("https://app.mokahr.com/campus-recruitment/dfmc/168424#/jobs");
    expect(campaignUrl("https://app.mokahr.com/campus-recruitment/dfmc/168424")).toBe("https://app.mokahr.com/campus-recruitment/dfmc/168424#/jobs");
    expect(campaignUrl("https://app.mokahr.com/social-recruitment/x/1?locale=zh-CN#/")).toBe("https://app.mokahr.com/social-recruitment/x/1?locale=zh-CN#/jobs");
    expect(campaignUrl("https://zhaopin.smg.cn/recruitment/#/recruitment/list/3?code=103")).toBe("https://zhaopin.smg.cn/recruitment/#/recruitment/list/3?code=103");
    expect(campaignUrl("https://mp.weixin.qq.com/s/abc")).toBe("https://mp.weixin.qq.com/s/abc");
  });
});

describe("feishu-jobs", () => {
  it("parses portal urls: path, project, root", async () => {
    const { feishuTenant } = await import("./readers/feishu-jobs.js");
    expect(feishuTenant("https://bambulab.jobs.feishu.cn/campus/?keywords=&project=7597705140384434458&current=1")).toEqual({ tenant: "bambulab", path: "campus", project: "7597705140384434458" });
    expect(feishuTenant("https://qcraft.jobs.feishu.cn/")).toEqual({ tenant: "qcraft", path: "index", project: undefined });
    expect(feishuTenant("https://pecivkvtit.jobs.feishu.cn/252342/")).toMatchObject({ tenant: "pecivkvtit", path: "252342" });
    expect(feishuTenant("https://app.mokahr.com/campus-recruitment/x/1")).toBeNull();
  });
  it("maps a post → listing: cities, 校招 kind, cohort from the 招聘项目 name, jd + requirement", async () => {
    const { postToListing } = await import("./readers/feishu-jobs.js");
    const l = postToListing({
      id: "7686816813698681139", title: "AI算法工程师", description: "1. 做算法", requirement: "硕士及以上学历", publish_time: 1758000000000,
      city_list: [{ name: "深圳" }, { name: "上海" }], recruit_type: { name: "正式", parent: { name: "校招" } }, job_subject: { id: "s1", name: { zh_cn: "26届春招补录" } }, job_function: { name: "算法" },
    }, { tenant: "bambulab", path: "campus" }, { id: "c", source: "feishu-jobs", url: "https://bambulab.jobs.feishu.cn/campus" });
    expect(l).toMatchObject({ externalId: "7686816813698681139", url: "https://bambulab.jobs.feishu.cn/campus/position/7686816813698681139/detail/", title: "AI算法工程师", company: "bambulab", locations: ["深圳", "上海"], employmentType: "正式", kind: "校招", batch: "26届春招补录", cohort: "2026届", degreeReq: "硕士及以上", orgUnit: "算法", publisher: "feishu-jobs:bambulab", grade: "官方" });
    expect(l.description).toContain("任职要求\n硕士及以上学历");
  });
});

describe("feishu-jobs: 校招 only", () => {
  it("a 社招 portal is not detected; a 社招 post maps to kind 社招 (fetch drops it unless asked for)", async () => {
    const { feishuTenant, postToListing } = await import("./readers/feishu-jobs.js");
    expect(feishuTenant("https://bambulab.jobs.feishu.cn/experienced/?keywords=x")).toBeNull();
    expect(feishuTenant("https://bambulab.jobs.feishu.cn/socialrecruitment")).toBeNull();
    const l = postToListing({ id: "1", title: "高级算法工程师", recruit_type: { name: "社招", parent: { name: "社招" } } }, { tenant: "bambulab", path: "index" }, { id: "c", source: "feishu-jobs", url: "https://bambulab.jobs.feishu.cn/index" });
    expect(l.kind).toBe("社招");
  });
});

describe("one subscription per site", () => {
  it("different pages of one career site share a site key", async () => {
    const { siteKeyOf } = await import("./readers/index.js");
    expect(siteKeyOf("https://jobtaikang.zhiye.com/campus/jobs/123")).toBe(siteKeyOf("https://jobtaikang.zhiye.com/"));
    expect(siteKeyOf("https://app.mokahr.com/campus-recruitment/voyah/146293#/job/abc")).toBe(siteKeyOf("https://app.mokahr.com/campus-recruitment/voyah/146293"));
    expect(siteKeyOf("https://qcraft.jobs.feishu.cn/")).toBe(siteKeyOf("https://qcraft.jobs.feishu.cn/campus"));
    expect(siteKeyOf("https://bambulab.jobs.feishu.cn/campus/?project=1")).not.toBe(siteKeyOf("https://bambulab.jobs.feishu.cn/campus"));
    expect(siteKeyOf("https://hzncc.zhiye.com/")).not.toBe(siteKeyOf("https://jingce.zhiye.com/"));
  });
});

describe("own career sites and tenants on their own domain (ADR-041)", () => {
  it("快手 / 小红书 posts map to listings with the site's own id; 荣耀's 大易 site is one company", async () => {
    const { ksListing, xhsListing, kuaishou, xiaohongshu } = await import("./readers/own-sites.js");
    const { dayeeSuite, rowToListing } = await import("./readers/dayee.js");
    const ks = ksListing({ id: 13977, name: "策略开发工程师", description: "做策略", positionDemand: "本科及以上学历", positionNatureCode: "fulltime", recruitSubProjectCode: "a", workLocationDicts: [{ name: "北京" }, { name: "杭州" }] }, new Map([["a", "2027应届生"]]), { id: "k", source: "kuaishou" } as any);
    expect(ks).toMatchObject({ externalId: "13977", company: "快手", locations: ["北京", "杭州"], cohort: "2027届", batch: "2027应届生", kind: "校招", degreeReq: "本科及以上", grade: "官方" });
    const xhs = xhsListing({ positionId: 22037, positionName: "【2027校招】多模态数据库研发", workplace: "北京市，上海市", jobProjectName: "2027 校园招聘", duty: "研发", qualification: "硕士" }, { id: "x", source: "xiaohongshu" } as any);
    expect(xhs).toMatchObject({ externalId: "22037", company: "小红书", locations: ["北京", "上海"], cohort: "2027届", kind: "校招" });
    expect(kuaishou.detect!("https://campus.kuaishou.cn/#/campus/jobs")).toBe(true);
    expect(xiaohongshu.detect!("https://job.xiaohongshu.com/campus/position")).toBe(true);
    expect(xiaohongshu.detect!("https://job.xiaohongshu.com/social")).toBe(false);

    expect(dayeeSuite("https://career.honor.com/SU60ee9e002f9d247b98da489e/mc/position/campus")?.su).toBe("SU60ee9e002f9d247b98da489e");
    const row = { postId: "p1", postName: "机器人决策规划算法工程师", company: "Marketing与销售服务部", endDate: "2099-08-18 23:59:59", projectName: "2027届应届本硕" };
    expect(rowToListing(row, null, "SU60ee9e002f9d247b98da489e", { id: "d", source: "dayee", name: "荣耀", url: "https://career.honor.com/SU60ee9e002f9d247b98da489e/mc/position/campus" } as any)).toMatchObject({ company: "荣耀", orgUnit: "Marketing与销售服务部", validThrough: "2099-08-18" });
    expect(rowToListing(row, null, "SU60ee9e002f9d247b98da489e", { id: "d", source: "dayee", name: "某集团", url: "https://wecruit.hotjob.cn/SU60ee9e002f9d247b98da489e/pb/school.html" } as any)?.company).toBe("Marketing与销售服务部");
  });
});
