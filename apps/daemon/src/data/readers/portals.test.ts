import { describe, it, expect } from "vitest";
import { zhilianUrl, itemToListing } from "./zhilian.js";
import { iguopinUrl, pickNav, postToListing } from "./iguopin.js";
import { sourceFor, siteKeyOf } from "./index.js";

describe("智联校园 reader, offline parts", () => {
  it("claims branded group sites and campus job links, not the 社招 site", () => {
    expect(zhilianUrl("https://cssc.zhaopin.com/")).toEqual({ host: "cssc.zhaopin.com", job: undefined });
    expect(zhilianUrl("https://xiaoyuan.zhaopin.com/job/CCL1226837610J40895569705")?.job).toBe("CCL1226837610J40895569705");
    expect(zhilianUrl("https://www.zhaopin.com/companydetail/CZL1226837610.htm")).toBeNull();
    expect(sourceFor("https://cssc.zhaopin.com/index.html")?.id).toBe("zhilian");
    expect(siteKeyOf("https://cssc.zhaopin.com/a")).toBe(siteKeyOf("https://cssc.zhaopin.com/b"));
  });
  it("a post keeps its hiring unit as the company and loses the HTML", () => {
    const l = itemToListing({ company: { campusOrgName: "中国船舶集团有限公司第七一二研究所", campusDepartment: { name: "武汉氢能与燃料电池产业技术研究院有限公司" } },
      job: { jobNumber: "CCL1J2", title: "氢能与燃料电池研发工程师", cityName: "武汉", minEducationName: "博士", needMajor: "控制科学与工程", detail: "岗位职责<br>1、研发&nbsp;<b>燃料电池</b>" } }, "105924", { id: "c", source: "zhilian", name: "中船集团" })!;
    expect(l).toMatchObject({ company: "中国船舶集团有限公司第七一二研究所", orgUnit: "武汉氢能与燃料电池产业技术研究院有限公司", locations: ["武汉"], kind: "博士专项", publisher: "zhilian:105924", grade: "官方", description: "岗位职责\n1、研发 燃料电池" });
  });
});

describe("国聘 reader, offline parts", () => {
  it("tells tenant, company and job links apart", () => {
    expect(iguopinUrl("https://spic2027.iguopin.com/job")).toEqual({ tenant: "spic2027", path: "/job", kind: "tenant" });
    expect(iguopinUrl("https://www.iguopin.com/company?id=10685293389548626")).toMatchObject({ kind: "company", id: "10685293389548626" });
    expect(iguopinUrl("https://www.iguopin.com/job/detail?id=215454023531103815")).toMatchObject({ kind: "job" });
    expect(iguopinUrl("https://www.iguopin.com/")).toBeNull();
  });
  it("picks the job tab at the URL's path, else the 校招 one", () => {
    const nav = [{ route: "/", title: "首页", props: {} }, { route: "/job1", title: "培优计划", props: { projectId: "1" } }, { route: "/job", title: "校园招聘", props: { projectId: "2" } }];
    expect(pickNav(nav, "/job1").props.projectId).toBe("1");
    expect(pickNav(nav, "/").props.projectId).toBe("2");
  });
  it("a post carries its unit, cities without district, majors and the deadline", () => {
    const l = postToListing({ job_id: "215", job_name: "电气工程师", company_name: "中国能源建设集团湖南省电力设计院有限公司", education_cn: "硕士", major_cn: ["电气工程类", "自动化类"],
      end_time: "2027-01-31 23:59:59", district_list: [{ area_cn: "长沙-雨花区" }, { area_cn: "长沙-岳麓区" }], contents: "1.硕士研究生" }, { id: "c", source: "iguopin" })!;
    expect(l).toMatchObject({ company: "中国能源建设集团湖南省电力设计院有限公司", locations: ["长沙"], majorReq: "电气工程类、自动化类", validThrough: "2027-01-31", url: "https://www.iguopin.com/job/detail?id=215" });
  });
});

describe("one crawl per group portal", () => {
  it("the same key within six hours reuses the first pull", async () => {
    const { pullOnce } = await import("../types.js");
    let n = 0;
    const pull = async () => { n++; return []; };
    await pullOnce("t:1", pull); await pullOnce("t:1", pull); await pullOnce("t:2", pull);
    expect(n).toBe(2);
  });
});

describe("智联 campus id in site bundles", () => {
  it("finds the id under every name the templates use, not the 社招 company numbers", async () => {
    const { idsIn } = await import("./zhilian.js");
    expect(idsIn(`globalData={companyId:"CZL1226837610",companyNumber:"122683761",xiaozhaoId:"105924",scene:"cam"}`)).toEqual(["105924"]);
    expect(idsIn(`n=globalData.companyId,j="106169";x={companyXzId:106566,companyOutId:"104680",rootCompanyId:105645,orgNumber:105813}`).sort()).toEqual(["104680", "105645", "105813", "106169", "106566"]);
    expect(idsIn(`companyId:"CZ131123510",companyNumber:"13112351"`)).toEqual([]);
  });
});

describe("大易 and 51job, offline parts", () => {
  it("大易: a closed or earlier project is dropped; the JD, unit and deadline are kept", async () => {
    const { rowToListing, dayeeSuite } = await import("./dayee.js");
    expect(dayeeSuite("https://wecruit.hotjob.cn/SU6056b00a0dcad424d03e153c/pb/posDetail.html?postId=abc&postType=campus")).toMatchObject({ su: "SU6056b00a0dcad424d03e153c", postId: "abc", recruitType: "1" });
    const row = { postId: "p1", postName: "控制算法工程师", company: "中电科普天", workPlaceStr: "南京市-江宁区", endDate: "2099-10-31", projectName: "2027年校园招聘", subject: "控制科学与工程" };
    const l = rowToListing(row, { workContent: "负责控制", serviceCondition: "硕士及以上" }, "SU1", { id: "c", source: "dayee" }, "2026-09-30")!;
    expect(l).toMatchObject({ company: "中电科普天", locations: ["南京市"], validThrough: "2099-10-31", majorReq: "控制科学与工程", description: "岗位职责\n负责控制\n\n任职要求\n硕士及以上" });
    expect(rowToListing({ ...row, projectName: "2026年校园招聘" }, null, "SU1", { id: "c", source: "dayee" }, "2026-09-30")).toBeNull();
    expect(rowToListing({ ...row, endDate: "2026-09-01" }, null, "SU1", { id: "c", source: "dayee" }, "2026-09-30")).toBeNull();
  });
  it("51job: its JS-literal answers become JSON without eval, and the unit path names the company", async () => {
    const { literalToJson, jobToListing, job51Url, siteLinks } = await import("./job51.js");
    // splash pages: js redirect + scripts (the ctmid lives in js/data.js); CDN, jquery and other sites are not followed
    expect(siteLinks(`<script src="https://campus.51job.com/51job-ideal-cdn/jquery/x/jquery.js"></script><script src="js/data.js"></script><script src="./js/main.js?v=2"></script>
      <a href="about.html">x</a><script>location.href = "job.html"</script><a href="https://slb.tupu360.com/p.html">y</a>`, "https://campus.51job.com/nxp/graduates.html"))
      .toEqual(["https://campus.51job.com/nxp/js/data.js", "https://campus.51job.com/nxp/js/main.js", "https://campus.51job.com/nxp/about.html", "https://campus.51job.com/nxp/job.html"]);
    expect(JSON.parse(literalToJson(`{status:'ok',data:{pagecount:2,records:[{JobID:'g1',CjobName:'电气工程师\\'A\\'',ok:true}]}}`))).toEqual({ status: "ok", data: { pagecount: 2, records: [{ JobID: "g1", CjobName: "电气工程师'A'", ok: true }] } });
    expect(job51Url("https://campus.51job.com/cofco/campus.html")).toBe(true);
    expect(job51Url("https://jobs.51job.com/campus/x.html")).toBe(false);
    const l = jobToListing({ JobID: "g1", CjobName: "海外研究", JobAreaname: "北京", DegreeFrom: "硕士" }, { OrgName: "中粮集团有限公司/中粮糖业控股股份有限公司/进出口业务部", CJobInfo: "<p>专业要求：经济</p>", Url: "//xym.51job.com/apply?jobid=1" }, { id: "c", source: "job51" }, "中粮集团")!;
    expect(l).toMatchObject({ company: "中粮糖业控股股份有限公司", orgUnit: "进出口业务部", locations: ["北京"], description: "专业要求：经济", url: "https://xym.51job.com/apply?jobid=1" });
  });
});

describe("国家能源 reader: a stale station list under a new announcement", () => {
  it("skips an announcement whose posts closed before it was published, keeps the current one", async () => {
    const { chnenergy } = await import("./chnenergy.js");
    const ann = (id: string, title: string, date: string) => `<a href="/annc/showgg?id=${id}" title="x">${title}</a><span>${date.replace(/-/g, "年").replace(/年(\d\d)$/, "月$1日").replace(/^(\d{4})年(\d\d)年/, "$1年$2月")}</span>`;
    const list = ann("cur", "国家能源集团2027年度高校毕业生统招公告", "2026-09-10") + ann("old", "国家能源集团2027年度西藏青海新疆高校毕业生专项招聘公告", "2026-09-02");
    const station = (id: string) => `共<b>1</b>条，共<b>1</b>页<a href="/annc/showgw?id=${id}" title="控制岗"></a><small>科技创新</small><p class="list-group-item-text">研究院 | 自动化 | 博士研究生 | 北京 | 1</p>`;
    const detail = (y: string) => `截止时间：<strong>${y}</strong>`;
    const ctx = {
      sleep: async () => {}, log: () => {}, fetchJson: async () => ({}),
      fetchText: async (url: string, opts?: any) => {
        if (url.endsWith("/annc/annclist")) return list;
        if (url.endsWith("/annc/showggStationList")) return station(String(opts?.body).includes("id=old") ? "p-old" : "p-cur");
        return detail(url.includes("p-old") ? "2025年10月13日" : "2026年10月07日");
      },
    };
    const out = await chnenergy.fetch!({ id: "c", source: "chnenergy" } as any, ctx as any);
    expect(out.map((l) => l.externalId)).toEqual(["p-cur"]);
    expect(out[0].validThrough).toBe("2026-10-07");
  });
});
