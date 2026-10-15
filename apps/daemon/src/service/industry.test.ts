import { describe, it, expect } from "vitest";
import { matchIndustries, mergeReports, toReport } from "./industry.js";

/** 行业研报, offline parts; row shapes as 东财's report centre answered on 2026-10-13. */
const row = (infoCode: string, title: string, publishDate: string, industryName = "通用设备") => ({ infoCode, title, publishDate: `${publishDate} 00:00:00.000`, industryName, orgSName: "某某证券", emRatingName: "增持", attachPages: 21 });

describe("行业研报", () => {
  it("an industry is found by its name, by part of it, or when what was asked contains it", () => {
    const all = [{ bkCode: "1", bkName: "机器人" }, { bkCode: "2", bkName: "汽车零部件" }, { bkCode: "3", bkName: "综合Ⅱ" }, { bkCode: "4", bkName: "通用设备" }];
    expect(matchIndustries("机器人", all)).toEqual([{ code: "1", name: "机器人" }]);
    expect(matchIndustries("人形机器人", all)).toEqual([{ code: "1", name: "机器人" }]);
    expect(matchIndustries("汽车零部件行业", all)).toEqual([{ code: "2", name: "汽车零部件" }]);
    expect(matchIndustries("综合", all)).toEqual([{ code: "3", name: "综合Ⅱ" }]);
    expect(matchIndustries("光", all)).toEqual([]);
  });

  it("a report is listed once, title hits first, then the newest; each with where to read it", () => {
    const byTitle = [row("A1", "人形机器人行业深度：量产元年", "2026-09-20"), row("A2", "人形机器人周报", "2026-10-10")];
    const byIndustry = [row("A2", "人形机器人周报", "2026-10-10"), row("B1", "通用设备行业月报", "2026-10-11"), row("B2", "工业母机跟踪", "2026-08-01")];
    const out = mergeReports("人形机器人", byTitle, byIndustry, 3);
    expect(out.map((r) => r.title)).toEqual(["人形机器人周报", "人形机器人行业深度：量产元年", "通用设备行业月报"]);
    expect(toReport(byTitle[0])).toEqual({ title: "人形机器人行业深度：量产元年", org: "某某证券", date: "2026-09-20", industry: "通用设备", rating: "增持", pages: 21, url: "https://data.eastmoney.com/report/zw_industry.jshtml?infocode=A1", pdf: "https://pdf.dfcfw.com/pdf/H3_A1_1.pdf" });
  });
});
