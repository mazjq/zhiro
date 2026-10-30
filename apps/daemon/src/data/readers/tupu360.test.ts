import { describe, it, expect } from "vitest";
import { tupuTenant, tabsOf, parseList, parseDetail, toListing, tupu360 } from "./tupu360.js";
import { incompleteWhy } from "../types.js";

// the two list templates seen live (2026-10-30): cards with pid="…" (西门子, 康明斯) and table rows linking positionId= (IQVIA)
const CARDS = `<div class="position-item" pid="6aa14c0d7280da28da07983f" recruitment="CAMPUSRECRUITMENT"><h4 class="title"><span class="txt">管理培训生-产品战略 Graduate Program</span></h4>
  <ul class="extend"><li><span class="txt">工作地点：北京</span></li></ul><div class="time">发布于: 2026-10-28</div><button data-action="positionApplyType" pid="6aa14c0d7280da28da07983f">申请</button></div>
  <div class="position-item" pid="6a9fde107280da28da0796c0" recruitment="CAMPUSRECRUITMENT"><h4 class="title"><span class="txt">产品管理方向管理培训生 上海</span></h4><div class="time">发布于: 2026-10-20</div></div>`;
const ROWS = `<div class="position-item"><div class="ele e-title" title="大连2027日语PV校招实习生"><a href='/iqvia/position/detail?positionId=6a9005d87280da28da078e36&recruitmentType=CAMPUSRECRUITMENT&currentLang=zh_CN'>大连2027日语PV校招实习生</a></div>
  <div class="ele e-salary">药物警戒</div><div class="ele e-date">2026-10-15</div></div>`;

describe("tupu360", () => {
  it("finds the tenant in each link shape", () => {
    expect(tupuTenant("https://careersite.tupu360.com/iqvia/position/index?recruitmentType=CAMPUSRECRUITMENT")).toEqual({ tenant: "iqvia", wechat: false });
    expect(tupuTenant("https://careersite.tupu360.com/lilly/#/index")).toEqual({ tenant: "lilly", wechat: false });
    expect(tupuTenant("https://slb.tupu360.com/pageQrCode?targetUrl=a7f4739eb94ec9ef3d29")).toEqual({ tenant: "slb", wechat: true });
    expect(tupuTenant("https://schaeffler.tupu360.com/position/list?type=TECHNOLOGYRUITMENT&lang=zh_CN")).toEqual({ tenant: "schaeffler", wechat: true });
    expect(tupuTenant("https://sony.tupu360.com/position/detail/6a3e32dbcf856c3f733f704d?type=INTERNSHIPRECRUITMENT")).toEqual({ tenant: "sony", wechat: true, post: "6a3e32dbcf856c3f733f704d" });
    // a WeChat site and a careersite tenant of the same name are two sites until shown otherwise (siemens: 西门子医疗 vs 西门子)
    expect(tupu360.siteKey!("https://siemens.tupu360.com/pageQrCode?targetUrl=ab")).not.toBe(tupu360.siteKey!("https://careersite.tupu360.com/siemens/position/index"));
    expect(tupuTenant("https://cdn.careersite.tupu360.com/x.js")).toBeNull();
    expect(tupuTenant("https://www.tupu360.com/")).toBeNull();
    expect(tupuTenant("https://app.mokahr.com/campus-recruitment/x/1")).toBeNull();
  });
  it("reads a tenant's own tabs, without 社招 and 校园大使", () => {
    const nav = `<script>p.subTitleList=[{"href":"/x/position/index?recruitmentType=CAMPUSRECRUITMENT","title":"1"}]; $.ajax({data:{recruitmentType:'CAMPUSAMBASSADORRECRUITMENT'}})</script>
      <a href="/x/position/index?recruitmentType=CAMPUSRECRUITMENT"  >校招职位</a><a href="/x/position/index?recruitmentType=INTERNSHIPRECRUITMENT">实习生职位</a>
      <a href="/x/position/index?recruitmentType=SOCIALRECRUITMENT">社招职位</a><a href="/x/position/index?recruitmentType=CAMPUSAMBASSADORRECRUITMENT">校园大使</a>
      <li recruitmentType=MANAGEMENTRUITMENT" headTitle="管理培训生项目">管理培训生项目</li>`;
    expect(tabsOf(nav)).toEqual([{ type: "CAMPUSRECRUITMENT", label: "校招职位" }, { type: "INTERNSHIPRECRUITMENT", label: "实习生职位" }, { type: "MANAGEMENTRUITMENT", label: "管理培训生项目" }]);
  });
  it("parses both list templates", () => {
    expect(parseList(CARDS)).toEqual([
      { id: "6aa14c0d7280da28da07983f", title: "管理培训生-产品战略 Graduate Program", date: "2026-10-28" },
      { id: "6a9fde107280da28da0796c0", title: "产品管理方向管理培训生 上海", date: "2026-10-20" },
    ]);
    expect(parseList(ROWS)).toEqual([{ id: "6a9005d87280da28da078e36", title: "大连2027日语PV校招实习生", date: "2026-10-15" }]);
  });
  it("takes the JD, place and date from a post's page", () => {
    const page = `<div class="position-detail-container"><h3>OSS Project Intern</h3><a>分享</a><a>复制链接</a><span>上海-静安区</span>
      <div class="position-description mt-4"><p>工作职责：</p><div><p>协助项目跟进</p></div><p>任职要求：本科及以上</p></div><dl><dt>发布时间：</dt><dd>2026-10-26</dd></dl></div>`;
    expect(parseDetail(page)).toEqual({ description: "工作职责：\n协助项目跟进\n任职要求：本科及以上", place: "上海-静安区", date: "2026-10-26" });
    expect(parseDetail(`<li>工作城市：</li><li>上海</li><div class="position-description">x</div>`).place).toBe("上海");
    const l = toListing({ id: "6a9005d87280da28da078e36", title: "大连2027日语PV校招实习生", date: "2026-10-15" }, { place: "辽宁省-大连" }, { type: "INTERNSHIPRECRUITMENT", label: "实习生职位" }, "iqvia", { id: "t", source: "tupu360", name: "IQVIA 艾昆纬" });
    expect(l).toMatchObject({ externalId: "6a9005d87280da28da078e36", company: "IQVIA 艾昆纬", locations: ["辽宁省-大连"], kind: "实习", publisher: "tupu360:iqvia", grade: "官方", datePosted: "2026-10-15T00:00:00+08:00" });
    expect(l.url).toBe("https://careersite.tupu360.com/iqvia/position/detail?positionId=6a9005d87280da28da078e36&recruitmentType=INTERNSHIPRECRUITMENT");
  });
  it("a WeChat-only tenant is blocked, and a tab still going at the page cap is marked unfinished", async () => {
    const ctx = (index: string, learnt: any[] = []) => ({ sleep: async () => {}, log: () => {}, fetchJson: async () => ({}), learn: (p: any) => learnt.push(p),
      fetchText: async (url: string, o?: any) => {
        if (url.includes("/position/index")) return index;
        if (url.includes("positionId=6a3e32dbcf856c3f733f7000")) return "<p>职位不存在</p>";
        if (url.includes("/nextPageList")) { const off = Number(new URLSearchParams(o.body).get("offset")); return `<div pid="${off.toString(16).padStart(24, "0")}"><span>岗位${off}</span></div>`; }
        return `<div class="position-description">JD</div>`;
      } });
    await expect(tupu360.fetch!({ id: "a", source: "tupu360", url: "https://wxonly.tupu360.com/pageQrCode?targetUrl=ab" }, ctx("<title>公告</title>抱歉，该网站已停用") as any)).rejects.toThrow(/^BLOCKED: 图谱：wxonly/);
    const out = await tupu360.fetch!({ id: "b", source: "tupu360", url: "https://careersite.tupu360.com/capped/position/index", maxPages: 2 }, ctx(`<a href="?recruitmentType=CAMPUSRECRUITMENT">校招职位</a>`) as any);
    expect([out.length, incompleteWhy(out)]).toEqual([2, "图谱 校招职位 读满 2 页，可能还有"]);
    // a WeChat link is read on careersite only when its own post opens there; then the subscription keeps the careersite link
    const tabs = `<a href="?recruitmentType=CAMPUSRECRUITMENT">校招职位</a>`;
    await expect(tupu360.fetch!({ id: "c", source: "tupu360", url: "https://samename.tupu360.com/pageQrCode?targetUrl=ab" }, ctx(tabs) as any)).rejects.toThrow(/^LINK_STALE: .*careersite\.tupu360\.com\/samename\/position\/index/);
    // …even right after a read of the careersite tenant of that name, whose answer is shared for six hours
    await tupu360.fetch!({ id: "c2", source: "tupu360", url: "https://careersite.tupu360.com/dupname/position/index", maxPages: 1 }, ctx(tabs) as any);
    await expect(tupu360.fetch!({ id: "c3", source: "tupu360", url: "https://dupname.tupu360.com/pageQrCode?targetUrl=ab" }, ctx(tabs) as any)).rejects.toThrow(/^LINK_STALE/);
    await expect(tupu360.fetch!({ id: "d", source: "tupu360", url: "https://othername.tupu360.com/position/detail/6a3e32dbcf856c3f733f7000" }, ctx(tabs) as any)).rejects.toThrow(/^LINK_STALE/);
    const learnt: any[] = [];
    const own = await tupu360.fetch!({ id: "e", source: "tupu360", url: "https://ownpost.tupu360.com/position/detail/6a3e32dbcf856c3f733f704d", maxPages: 1 }, ctx(tabs, learnt) as any);
    expect([own.length, learnt]).toEqual([1, [{ url: "https://careersite.tupu360.com/ownpost/position/index", widenedFrom: "https://ownpost.tupu360.com/position/detail/6a3e32dbcf856c3f733f704d" }]]);
  });
});
