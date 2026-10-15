import { describe, it, expect } from "vitest";
import { apiRowToListing, parseCmsList, parseCmsDetail, beisenTenant } from "./beisen.js";

const cfg = { id: "b", source: "beisen", url: "https://hzncc.zhiye.com/campus/jobs", name: "华中数控", cohort: "2027届" };

describe("beisen", () => {
  it("detects tenants", () => {
    expect(beisenTenant("https://cssc717.zhiye.com/")).toBe("cssc717");
    expect(beisenTenant("https://jingce.zhiye.com/campus")).toBe("jingce");
    expect(beisenTenant("https://app.mokahr.com/x")).toBeNull();
  });
  it("maps an API row", () => {
    const l = apiRowToListing({ Id: "22b6", JobAdName: "嵌入式软件工程师(J1)", Org: "软件开发部", Category: "校园招聘", LocNames: ["湖北省·武汉市·东湖新技术开发区"], Duty: "<p>1、开发</p>", Require: "1、硕士及以上", PostDate: "0001-01-01T00:00:00", EndTime: "2026-10-31T00:00:00" }, "hzncc", cfg);
    expect(l).toMatchObject({ externalId: "22b6", company: "华中数控", orgUnit: "软件开发部", degreeReq: "硕士及以上", kind: "校招", publisher: "beisen:hzncc", grade: "官方", datePosted: undefined });
    expect(l.validThrough).toMatch(/^2026-10-3/);
    expect(l.locations).toEqual(["湖北省 武汉市 东湖新技术开发区"]);
    expect(l.description).toContain("岗位职责");
  });
  it("parses a CmsPortal list", () => {
    const html = `<tr><td><a title="嵌入式工程师（2027校招）(J12268)" href="/zpdetail/390867148" >嵌入式工程师</a></td><td title="研发类">研发类</td><td title="湖北省-武汉市,江苏省-苏州市">湖北省-武汉市,...</td><td>2026-09-15</td></tr>
    <tr><td><a title="AI工程师(J12242)" href="/zpdetail/390854898" >AI工程师</a></td><td title=""></td><td title="湖北省-武汉市-东湖">湖北省-武汉市-...</td><td>2026-08-17</td></tr>`;
    expect(parseCmsList(html)).toEqual([
      { id: "390867148", title: "嵌入式工程师（2027校招）(J12268)", dept: "研发类", loc: "湖北省-武汉市,江苏省-苏州市", date: "2026-09-15" },
      { id: "390854898", title: "AI工程师(J12242)", dept: "", loc: "湖北省-武汉市-东湖", date: "2026-08-17" },
    ]);
    expect(parseCmsDetail("<div>x</div><h3>岗位职责</h3><p>1、做事</p><h3>任职要求</h3><p>博士</p><script>bad()</script>")).toContain("岗位职责 1、做事 任职要求 博士");
  });
});
