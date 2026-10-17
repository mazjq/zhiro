import { describe, it, expect } from "vitest";
import { gaoxiaojob, columnOf, dayOf, parseNotice, stillOpen, noticeListings } from "./gaoxiaojob.js";
import type { SourceContext } from "../types.js";

/** The 基本信息 block and body as the desktop announcement page has them (437877, 2026-10-15, trimmed). */
const PAGE = (deadline: string, posted = "2026-10-15") => `<div class="detail-subtitle is-basic">基本信息</div>
<ul class="detail-content el-row announcement">
<li class="el-col">发布时间：${posted}</li>
<li class="el-col">截止日期：${deadline}</li>
<li class="el-col">学历要求：博士研究生</li>
<li class="el-row"><div class="el-col"><span class="label">所属省份：</span><div class="value"><a href="/column/28.html">湖北</a></div></div>
<div class="el-col"><span class="label">工作地点：</span><div class="value"><a href="/column/48.html">武汉</a></div></div></li>
<li class="el-row"><div class="el-col"><span class="label">报名方式：</span><div class="value">电子邮件</div></div></li>
</ul>
<div class="detail-subtitle">公告详情</div><p>团队聚焦机器人视觉测量与加工。</p><p>应聘材料发送至邮箱。</p>
<p>来源于网络，如有变更请以原发布者为准。 来源链接： https://mse.hust.edu.cn/info/1181/19643.htm </p>`;
const JOB = { jobId: "2361038", jobName: "博士后", companyName: "华中科技大学#", city: "武汉", education: "博士研究生", major: "机械工程", url: "/job/detail/2361038.html" };
const TODAY = new Date("2026-10-17T04:00:00Z");

describe("高校人才网", () => {
  it("takes a column link from either site, and two columns are two subscriptions", () => {
    expect(columnOf("https://www.gaoxiaojob.com/column/509.html")).toBe("509");
    expect(columnOf("https://m.gaoxiaojob.com/column/48.html")).toBe("48");
    expect(gaoxiaojob.detect!("https://www.gaoxiaojob.com/announcement/detail/437877.html")).toBe(false);
    expect(gaoxiaojob.siteKey!("https://www.gaoxiaojob.com/column/509.html")).toBe(gaoxiaojob.siteKey!("https://m.gaoxiaojob.com/column/509.html"));
    expect(gaoxiaojob.siteKey!("https://www.gaoxiaojob.com/column/509.html")).not.toBe(gaoxiaojob.siteKey!("https://www.gaoxiaojob.com/column/511.html"));
  });

  it("a list day without a year is the latest such day not in the future", () => {
    expect(dayOf("10-16", TODAY)).toBe("2026-10-16");
    expect(dayOf("12-30", TODAY)).toBe("2025-12-30");
    expect(dayOf("昨天", TODAY)).toBeNull();
  });

  it("reads the page's dates, place, body and original notice; only a whole date is a deadline", () => {
    const n = parseNotice("437877", "华中科技大学丁汉院士团队2026年诚聘博士后", PAGE("详见正文"));
    expect(n).toMatchObject({ posted: "2026-10-15", deadlineText: "详见正文", closesAt: null, place: "武汉", source: "https://mse.hust.edu.cn/info/1181/19643.htm" });
    expect(n.body).toContain("机器人视觉测量");
    expect(parseNotice("1", "t", PAGE("2026年11月30日")).closesAt).toBe("2026-11-30");
    expect(parseNotice("1", "t", PAGE("11月30日")).closesAt).toBeNull(); // no year: kept as text, never given one
  });

  it("returns what is still open by the fixed rule", () => {
    const at = (deadlineText: string, posted: string, closesAt: string | null = null) => stillOpen({ deadlineText, posted, closesAt }, null, TODAY);
    expect(at("2026-10-20", "2026-01-01", "2026-10-20")).toBe(true); // dated, not passed
    expect(at("2026-10-10", "2026-10-01", "2026-10-10")).toBe(false); // dated, passed
    expect(at("长期有效", "2026-05-01")).toBe(true); // 169 days
    expect(at("长期有效", "2026-03-01")).toBe(false); // 230 days
    expect(at("详见正文", "2026-08-01")).toBe(true); // 77 days
    expect(at("详见正文", "2026-07-01")).toBe(false); // 108 days
  });

  it("files each job under the site's own id, as a reprint, one campaign per announcement", () => {
    const n = parseNotice("437877", "华中科技大学丁汉院士团队2026年诚聘博士后", PAGE("详见正文"));
    const [l] = noticeListings(n, [JOB], { id: "s", source: "gaoxiaojob" });
    expect(l).toMatchObject({ externalId: "job:2361038", company: "华中科技大学", title: "博士后", grade: "聚合", isOriginal: false, publisher: "gaoxiaojob",
      noticeUrl: "https://www.gaoxiaojob.com/announcement/detail/437877.html", url: "https://www.gaoxiaojob.com/job/detail/2361038.html",
      locations: ["武汉"], degreeReq: "博士研究生", deadlineText: "详见正文", batch: "华中科技大学丁汉院士团队2026年诚聘博士后" });
    expect(l.validThrough).toBeUndefined();
    expect(l.description).toContain("原公告：https://mse.hust.edu.cn/info/1181/19643.htm");
    const [only] = noticeListings(n, [], { id: "s", source: "gaoxiaojob" }); // no job list: the announcement is the post
    expect(only).toMatchObject({ externalId: "ann:437877", company: "华中科技大学丁汉院士团队" });
    expect(noticeListings({ ...n, title: "某研究院2026年暑期实习生招聘" }, [{ ...JOB, jobName: "实习生" }], { id: "s", source: "gaoxiaojob" })[0].kind).toBe("实习");
  });

  it("stops after two pages older than 180 days, and fails rather than return half a column", async () => {
    const page = (refreshTime: string, id: string) => ({ code: 200, data: [{ id, title: "某研究院2026年招聘公告", refreshTime }] });
    const ctx = (pages: any[]): SourceContext => ({
      fetchJson: async (url: string) => (url.includes("get-job-list") ? { data: { list: [JOB], count: 1 } } : pages[Number(/page=(\d+)/.exec(url)![1]) - 1] ?? { code: 200, data: [] }),
      fetchText: async () => PAGE("长期有效", "2026-10-10"), sleep: async () => {}, log: () => {},
    });
    const out = await gaoxiaojob.fetch!({ id: "s", source: "gaoxiaojob", url: "https://www.gaoxiaojob.com/column/509.html" }, ctx([page("10-10", "1"), page("01-02", "2"), page("01-01", "3"), page("10-11", "4")]));
    expect(out.map((l) => l.externalId)).toEqual(["job:2361038"]); // page 4 is never read
    await expect(gaoxiaojob.fetch!({ id: "s", source: "gaoxiaojob", url: "https://www.gaoxiaojob.com/column/509.html", maxPages: 2 }, ctx([page("10-10", "1"), page("10-09", "2"), page("10-08", "3")]))).rejects.toThrow(/TIMEOUT/);
  });
});
