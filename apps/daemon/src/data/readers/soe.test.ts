import { describe, it, expect } from "vitest";
import { parseAnnouncements, parseStations } from "./chnenergy.js";
import { positionToListing } from "./chng.js";
import { sourceFor, siteKeyOf } from "./index.js";

describe("国家能源集团招聘网 parsing (markup as served 2026-09-29)", () => {
  it("announcements with dates, and station rows with the full major list from the title attribute", () => {
    expect(parseAnnouncements(`<li><a href="/annc/showgg?id=6a152f40-7fe5" target="_self">国家能源集团2027年度高校毕业生统招公告</a><span class="pull-right">2026年09月02日</span></li>`))
      .toEqual([{ id: "6a152f40-7fe5", title: "国家能源集团2027年度高校毕业生统招公告", date: "2026-09-02" }]);
    const html = `共<b>2413</b>条，共<b>242</b>页 <li class="list-group-item"><h4 class="list-group-item-heading"><a href="/annc/showgw?id=5a79-a7a7" target="_self" class="showNewpage" title="高温热泵设计工程师">高温热泵设计工程师</a> <span class="pull-right"> <small>科研</small> </span></h4> <p class="list-group-item-text"> <span title="储能技术研究中心">储能技术研究中心</span> &nbsp;|&nbsp; <span title="机械类相关专业,能源与动力工程,机械制造及其自动化">机械类相关专业,能源...</span> &nbsp;|&nbsp; 博士研究生 &nbsp;|&nbsp; 北京 &nbsp;|&nbsp; 1人 <!-- <span class="pull-right"> 2026年09月02日 </span> --></p></li>`;
    expect(parseStations(html)).toEqual({ pages: 242, rows: [{ id: "5a79-a7a7", title: "高温热泵设计工程师", category: "科研", unit: "储能技术研究中心", major: "机械类相关专业,能源与动力工程,机械制造及其自动化", degree: "博士研究生", city: "北京", headcount: "1人" }] });
  });
  it("any page of the site is one subscription", () => {
    expect(sourceFor("https://zhaopin.chnenergy.com.cn/annc/showgg?id=x")?.id).toBe("chnenergy");
    expect(siteKeyOf("https://zhaopin.chnenergy.com.cn/annc/showgg?id=x")).toBe(siteKeyOf("https://zhaopin.chnenergy.com.cn/"));
  });
});

describe("华能招聘网 position mapping", () => {
  it("unit, city, degree code, majors, HTML JD and the deadline", () => {
    const l = positionToListing({ id: 2000320, positionName: "工艺系统设计岗", recruitCompanyName: "华能核能技术研究院有限公司", address: "上海", eduType: "5", endDate: "2026-10-31 18:00:00",
      majors: [{ majorName: "过程装备与控制工程" }, { majorName: "核工程与核技术" }], jobReq: "<p>1.硕士研究生</p><p>2.相关专业</p>" }, { id: 2000101, taskType: 0, recruitCompanyName: "华能" }, "2027届")!;
    expect(l).toMatchObject({ company: "华能核能技术研究院有限公司", locations: ["上海"], degreeReq: "硕士研究生", majorReq: "过程装备与控制工程、核工程与核技术", validThrough: "2026-10-31",
      description: "1.硕士研究生\n2.相关专业", url: "https://zhaopin.chng.com.cn/CampusRecruit?positionId=2000320", batch: "校招" });
  });
});
