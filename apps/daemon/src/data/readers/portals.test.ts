import { describe, it, expect, vi } from "vitest";
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

describe("智联: a job link that is blocked or gone", () => {
  const JOB = "https://xiaoyuan.zhaopin.com/job/CCL1226837610J40891746705";
  const ctxOf = (jobPage: string, total: number, learned: any[] = []) => ({
    sleep: async () => {}, log: () => {}, learn: (p: any) => learned.push(p),
    fetchText: async () => jobPage,
    fetchJson: async (_u: string, o: any) => ({ code: 200, data: { pageInfo: { totalNum: total, totalPage: 1 }, jobList: JSON.parse(o.body).pageSize === 1 ? [] : [{ job: { jobNumber: "CCL1226837610J1", title: "控制工程师" }, company: { campusOrgName: "七〇五所" } }] } }),
  });
  it("tells the bot check, a post that is gone and a unit with nothing open apart", async () => {
    const { zhilian } = await import("./zhilian.js");
    const run = (page: string, total: number) => zhilian.fetch!({ id: "z", source: "zhilian", url: JOB }, ctxOf(page, total) as any).then(() => "ok", (e) => String(e.message).split(":")[0]);
    expect(await run(`<script>EO_Bot_Ssid=1</script>`, 5)).toBe("BLOCKED");
    expect(await run(`<html>${"x".repeat(6000)}</html>`, 5)).toBe("LINK_STALE");
    expect(await run(`<html>"companyRootId":105924 ${"x".repeat(6000)}</html>`, 0)).toBe("ZERO_POSTS");
  });
  it("keeps the campus id it found, and knows it from the library without the job page", async () => {
    const { zhilian } = await import("./zhilian.js");
    const learned: any[] = [];
    const posts = await zhilian.fetch!({ id: "z", source: "zhilian", url: JOB + "?x=1" }, ctxOf(`<html>"companyRootId":105925 ${"x".repeat(6000)}</html>`, 3, learned) as any);
    expect(posts.map((p) => p.company)).toEqual(["七〇五所"]);
    expect(learned).toEqual([{ rootId: "105925" }]);
    const db = { prepare: (sql: string) => ({ get: (like: string) => (/source_listing/.test(sql) && like === "CCL1226837610J%" ? { publisher: "zhilian:105924" } : undefined) }) };
    expect(zhilian.hint!({ id: "z", source: "zhilian", url: JOB }, db as any)).toEqual({ rootId: "105924" });
    expect(zhilian.hint!({ id: "z", source: "zhilian", url: JOB, rootId: "1" }, db as any)).toBeNull();
    expect(zhilian.hint!({ id: "z", source: "zhilian", url: "https://cssc.zhaopin.com/" }, db as any)).toBeNull();
    // a group site: the ids its own earlier reads came under (its snapshots end in -<subscription id>.json)
    const own = { prepare: (sql: string) => ({ get: (like: string) => (/content_path like/.test(sql) && like === "%-zhilian-河北建投集团.json" ? { publisher: "zhilian:106566,106565" } : undefined) }) };
    expect(zhilian.hint!({ id: "zhilian-河北建投集团", source: "zhilian", url: "https://hecic2027.zhaopin.com/jobs/index.html" }, own as any)).toEqual({ rootId: "106566,106565" });
  });
  it("a group site Zhilian answers 403 for is gone, not blocked", async () => {
    const { zhilian } = await import("./zhilian.js");
    const ctx = { sleep: async () => {}, log: () => {}, fetchText: async (u: string) => { throw new Error(`BLOCKED: HTTP 403 ${u}`); }, fetchJson: async () => ({}) };
    await expect(zhilian.fetch!({ id: "z", source: "zhilian", url: "https://gone2027.zhaopin.com/" }, ctx as any)).rejects.toThrow(/^SITE_GONE: /);
  });
});

describe("Moka on a DingTalk host", () => {
  it("reads the tenant from its own host when app.mokahr.com does not know it", async () => {
    const { moka } = await import("./moka.js");
    const asked: string[] = [];
    const ctx = { sleep: async () => {}, log: () => {}, fetchText: async () => "",
      fetchJson: async (u: string) => {
        asked.push(new URL(u).host);
        if (u.startsWith("https://app.mokahr.com")) throw new Error("API error: 未找到对应的官网");
        return { code: 0, data: { jobs: [{ id: "j1", title: "嵌入式工程师", commitment: "校招", locations: [{ provinceName: "浙江", cityName: "杭州" }] }] } };
      } };
    const out = await moka.fetch!({ id: "m", source: "moka", name: "示例科技", url: "https://app135149.eapps.dingtalkcloud.com/campus-recruitment/demo/100004103#/" }, ctx as any);
    expect(asked).toEqual(["app.mokahr.com", "app135149.eapps.dingtalkcloud.com"]);
    expect(out.map((l) => [l.title, l.url, l.publisher, l.locations])).toEqual([["嵌入式工程师", "https://app135149.eapps.dingtalkcloud.com/campus-recruitment/demo/100004103#/job/j1", "moka:demo", ["浙江 杭州"]]]);
  });
});

describe("飞书招聘: a link narrowed to a project that ended", () => {
  it("reads the whole portal when the project has nothing, and keeps the wider link", async () => {
    const { feishuJobs } = await import("./feishu-jobs.js");
    const learned: any[] = [];
    const post = { id: "p1", title: "机器人算法实习生", recruit_type: { name: "实习" } };
    const ctx = { sleep: async () => {}, log: () => {}, fetchText: async () => "", learn: (p: any) => learned.push(p),
      fetchJson: async (u: string, o: any) => (/csrf/.test(u) ? { data: { token: "t" } } : { code: 0, data: { count: 1, job_post_list: JSON.parse(o.body).subject_id_list.length ? [] : [post] } }) };
    const url = "https://x2-robot.jobs.feishu.cn/912130/position/list?keywords=&project=7650350869535869227&type=";
    const out = await feishuJobs.fetch!({ id: "f", source: "feishu-jobs", url, name: "自变量机器人" }, ctx as any);
    expect(out.map((l) => l.title)).toEqual(["机器人算法实习生"]);
    expect(learned).toEqual([{ url: "https://x2-robot.jobs.feishu.cn/912130/position/list?keywords=&type=", widenedFrom: url }]);
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
  it("大易: the word a link carries for the recruit type becomes the number the API takes", async () => {
    const { dayeeSuite } = await import("./dayee.js");
    const su = "https://wecruit.hotjob.cn/SU6135d6092f9d245c993d009e/mc/detail?postId=6ab0&recruitType=";
    expect(["campus", "intern", "12", "2", ""].map((w) => dayeeSuite(su + w)!.recruitType)).toEqual(["1", "12", "12", "2", "1"]);
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
  it("51job: unquoted script tags and a webpack runtime's lazy chunks are followed", async () => {
    const { siteLinks } = await import("./job51.js");
    const base = "https://campus.51job.com/demo2023/";
    expect(siteLinks(`<script defer=defer src=js/runtime.a73.bundle.js?5d98></script><script src=js/vendor.e9a.bundle.js?5d98></script>`, base)).toEqual([base + "js/runtime.a73.bundle.js"]);
    expect(siteLinks(`o.u=e=>"js/"+(886===e?"inline":e)+"."+{272:"d5ef79b1",670:"9e7f4af4"}[e]+".chunk.js",o.miniCssF=e=>"css/"+e+".css"`, base)).toEqual([base + "js/272.d5ef79b1.chunk.js", base + "js/670.9e7f4af4.chunk.js"]);
  });
  it("51job: a page that only sends applicants to another hiring system says where", async () => {
    const { job51 } = await import("./job51.js");
    const pages: Record<string, string> = { "https://campus.51job.com/demoslb/": `<script src="js/job.js"></script>`, "https://campus.51job.com/demoslb/js/job.js": `let jobdata=[{name:'现场作业岗',attr5:'https://demo.tupu360.com/position/detail/68be?type=CAMPUSRECRUITMENT'}]` };
    const ctx = { sleep: async () => {}, log: () => {}, fetchText: async (u: string) => pages[u] ?? "", fetchJson: async () => ({}) };
    await expect(job51.fetch!({ id: "j", source: "job51", url: "https://campus.51job.com/demoslb/" }, ctx as any)).rejects.toThrow("ELSEWHERE: 51job：这里只是宣传页，岗位和投递在 https://demo.tupu360.com/position/detail/68be?type=CAMPUSRECRUITMENT");
  });
  it("51job: a built site's ctmid is found in its lazy chunk past the source paths its bundle names, and kept", async () => {
    const { job51 } = await import("./job51.js");
    const b = "https://campus.51job.com/demoapp/";
    const pages: Record<string, string> = {
      [b]: `<script src=js/main.143ad6fa.bundle.js?1></script><script src=js/runtime.a7351eab.bundle.js?1></script>`,
      [`${b}js/main.143ad6fa.bundle.js`]: Array.from({ length: 30 }, (_, i) => `"./core/m${i}.js"`).join(","),
      [`${b}js/runtime.a7351eab.bundle.js`]: `o.u=e=>"js/"+e+"."+{670:"9e7f4af4"}[e]+".chunk.js"`,
      [`${b}js/670.9e7f4af4.chunk.js`]: `params:{ctmid:"7469956",pagesize:1999}`,
    };
    const learned: any[] = [];
    const ctx = { sleep: async () => {}, log: () => {}, fetchJson: async () => ({}), learn: (p: any) => learned.push(p),
      fetchText: async (u: string) => { if (u.includes("job_list.php")) throw new Error("stop here"); return pages[u] ?? ""; } };
    vi.stubGlobal("fetch", async () => ({ headers: { get: () => null } }));
    try { await expect(job51.fetch!({ id: "j", source: "job51", url: b }, ctx as any)).rejects.toThrow("stop here"); } finally { vi.unstubAllGlobals(); }
    expect(learned).toEqual([{ ctmid: "7469956" }]);
  });
  it("51job coapi: a mixed site's 社会招聘 rows say so; dates and the JD are kept", async () => {
    const { coapiToListing } = await import("./job51.js");
    const l = coapiToListing({ jobid: "159609474", jobname: "社会招聘-电气专业工程师", coname: "示例电力设计院有限公司", divname: "电气部", jobareaname: "西安", issuedate: "2026-09-10", degreefrom: "本科" }, { jobinfo: "岗位职责：<br>1、设计", jumpurl: "" }, { id: "j", source: "job51" })!;
    expect(l).toMatchObject({ externalId: "159609474", company: "示例电力设计院有限公司", orgUnit: "电气部", kind: "社招", batch: "社招", datePosted: "2026-09-10", description: "岗位职责：\n1、设计", url: "https://jobs.51job.com/all/159609474.html" });
    expect(coapiToListing({ jobid: "2", jobname: "校园招聘-结构工程师" }, null, { id: "j", source: "job51" })!.kind).toBe("校招");
  });
  it("51job: an employer number with no recruiting GUID is read through coapi, and a list short of its total says so", async () => {
    const { job51 } = await import("./job51.js");
    const { incompleteWhy } = await import("../types.js");
    vi.stubGlobal("fetch", async () => ({ headers: { get: () => null } })); // the apply link gives no GUID
    const joblist = { a: { jobid: "1", jobname: "校园招聘-甲" }, b: { jobid: "2", jobname: "社会招聘-乙" } };
    const ctx = { sleep: async () => {}, log: () => {}, fetchJson: async () => ({}),
      fetchText: async (u: string) => u.includes("job_list.php") ? `jsoncallback(${JSON.stringify({ status: "1", resultbody: { totalnum: "3", joblist } })})`
        : u.includes("job_detail.php") ? `jsoncallback({"status":"1","resultbody":{"jobinfo":"做事"}})` : "" };
    try {
      const out = await job51.fetch!({ id: "j", source: "job51", url: "https://ideal.51job.com/demo/campus.html?ctmid=1234567" }, ctx as any);
      expect([out.map((l) => l.kind), out[0].description, incompleteWhy(out)]).toEqual([["校招", "社招"], "做事", "51job 2/3"]);
    } finally { vi.unstubAllGlobals(); }
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
