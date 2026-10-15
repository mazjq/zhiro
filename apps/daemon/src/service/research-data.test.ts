import { describe, it, expect } from "vitest";
import { pickSecurity, pickBoard, laborRows, numbersIn, checkPoints, refIndex, type DataEntry } from "./research-data.js";

/** The research data tools' own judgements — which company a name means, which board, what a sentence's figures are — on answers as the sources give them. */
const hit = (code: string, shortName: string, securityTypeName: string, market: number) => ({ code, shortName, securityTypeName, market });

describe("which listed company a name means", () => {
  it("the same name once endings are set aside; of two exchanges the mainland one; funds and ADRs are not the company", () => {
    const byd = [hit("002594", "比亚迪", "深A", 0), hit("01211", "比亚迪股份", "港股", 116), hit("81211", "比亚迪股份-R", "港股", 116), hit("BYDDY", "比亚迪(ADR)", "粉单", 153)];
    expect(pickSecurity("比亚迪", byd)).toEqual({ status: "listed", approx: false, security: { market: "A股", code: "002594", name: "比亚迪" } });
    expect(pickSecurity("宇树科技", [hit("688836", "宇树科技-W", "科创板", 1)])).toMatchObject({ status: "listed", approx: false, security: { code: "688836" } });
    expect(pickSecurity("英伟达", [hit("NVDA", "英伟达", "美股", 105), hit("NVDL", "二倍做多英伟达ETF-GraniteShares", "美股", 105), hit("BK1161", "英伟达概念", "概念", 90)])).toMatchObject({ status: "listed", security: { market: "美股", code: "NVDA.O" } });
  });
  it("one company whose name begins with what was asked is taken and said to be a near match; several are listed, none taken", () => {
    expect(pickSecurity("宇树", [hit("688836", "宇树科技-W", "科创板", 1)])).toMatchObject({ status: "listed", approx: true, security: { name: "宇树科技-W" } });
    expect(pickSecurity("汇川", [hit("300124", "汇川技术", "深A", 0), hit("873837", "汇川科技", "三板", 0)])).toEqual({ status: "ambiguous", candidates: [{ market: "A股", code: "300124", name: "汇川技术" }, { market: "新三板", code: "873837", name: "汇川科技" }] });
  });
  it("a code is the company with that code; a name only a board carries is not a listed company", () => {
    expect(pickSecurity("09880", [hit("09880", "优必选", "港股", 116), hit("009880", "安信成长动力一年持有混合", "基金", 150)])).toMatchObject({ status: "listed", security: { market: "港股", code: "09880" } });
    expect(pickSecurity("TSLA", [hit("TSLA", "特斯拉", "美股", 105), hit("TSLY", "特斯拉期权收益策略ETF-YieldMax", "美股", 107)])).toMatchObject({ status: "listed", security: { code: "TSLA.O" } });
    expect(pickSecurity("智元机器人", [hit("BK1408", "机器人", "行业", 90)])).toEqual({ status: "not_found" });
  });
});

describe("which board a theme is", () => {
  it("the board called exactly that, not the stock or the funds of the same name; none when there is none", () => {
    const hits = [hit("300024", "机器人", "深A", 0), hit("BK1408", "机器人", "行业", 90), hit("562500", "机器人ETF华夏", "基金", 1), hit("BK1184", "人形机器人", "概念", 90)];
    expect(pickBoard("机器人", hits)).toEqual({ board: { code: "BK1408", name: "机器人", kind: "行业" }, others: ["人形机器人"] });
    expect(pickBoard("人形机器人", hits).board).toMatchObject({ code: "BK1184" });
    expect(pickBoard("工业软件", [hit("980034", "工业软件", "指数", 0), hit("159108", "工业软件ETF博时", "基金", 0)])).toEqual({ board: null, others: [] });
  });
});

describe("US occupation statistics", () => {
  it("one row per code with the name BLS gives it; a code with no data says so", () => {
    const s = (id: string, value: string) => ({ seriesID: id, data: [{ year: "2025", period: "A01", value }] });
    const rows = laborRows(["172141", "999999"], [s("OEUN000000000000017214101", "296810"), s("OEUN000000000000017214104", "113610"), s("OEUN000000000000017214113", "104110")], new Map([["172141", "Mechanical Engineers"]]));
    expect(rows).toEqual([
      { soc: "17-2141", ref: "L:17-2141", title: "Mechanical Engineers", status: "ok", year: "2025", employment: 296810, meanAnnualWage: 113610, medianAnnualWage: 104110 },
      { soc: "99-9999", ref: "", title: "", status: "no_data", year: "", employment: null, meanAnnualWage: null, medianAnnualWage: null },
    ]);
  });
});

describe("a report's 要点 against what its run was given", () => {
  const entries: DataEntry[] = [
    { at: "2026-10-13T00:00:00Z", tool: "company.financials", input: { name: "宇树科技" }, ok: true, output: { ref: "F:A股:688836", query: "宇树科技", security: { market: "A股", code: "688836", name: "宇树科技-W" }, basic: { employees: 516 }, annual: [{ period: "2025年报", revenue: 1699269304.88, netProfit: 280000000, revenueYoy: 332.6, rdExpense: 140000000, currency: "人民币" }], latest: null } },
    { at: "2026-10-13T00:00:00Z", tool: "labor.us", input: { soc: ["17-2141"] }, ok: true, output: { items: [{ soc: "17-2141", ref: "L:17-2141", title: "Mechanical Engineers", year: "2025", employment: 296810, meanAnnualWage: 113610, medianAnnualWage: 104110 }] } },
    { at: "2026-10-13T00:00:00Z", tool: "industry.companies", input: { query: "人形机器人" }, ok: true, output: { ref: "B:BK1184", query: "人形机器人", board: { name: "人形机器人" }, total: 304, items: [{ code: "688836", name: "宇树科技-W", marketCapYi: 1766, industry: "自动化设备" }] } },
    { at: "2026-10-13T00:00:00Z", tool: "industry.reports", input: { query: "x" }, ok: false, error: "HTTP 500" },
  ];
  const index = refIndex(entries);
  it("figures as written: 亿 / 万 / % and thousands separators; years and bare small counts are not figures", () => {
    expect(numbersIn("2025 年营收 17.0 亿元，同比增长 332.6%，员工 516 人，其中 3 家").map((n) => [n.raw, n.value])).toEqual([["17.0 亿", 1.7e9], ["332.6%", 332.6]]);
    expect(numbersIn("年薪中位数 104,110 美元，约 10.4 万").map((n) => n.value)).toEqual([104110, 104000]);
  });
  it("matched when every figure is in the data cited, to the rounding shown; unmatched names the figure that is not", () => {
    const [a, b, c, d, e, f] = checkPoints([
      { text: "宇树科技 2025 年营收 17.0 亿元，同比增长 332.6%，研发 1.4 亿元", refs: ["F:A股:688836"] },
      { text: "宇树科技 2025 年营收 25 亿元", refs: ["F:A股:688836"] },
      { text: "美国机械工程师年薪中位数 104,110 美元，就业约 29.7 万人", refs: ["L:17-2141"] },
      { text: "板块共 304 家，宇树市值 1766 亿", refs: ["B:BK1184"] },
      { text: "行业处在量产前夜", refs: [] },
      { text: "某公司营收 9 亿", refs: ["F:A股:000001"] },
    ], index);
    expect(a).toMatchObject({ status: "matched", unmatched: [], refs: [{ ref: "F:A股:688836", kind: "财报", label: "宇树科技-W（A股 688836）" }] });
    expect(b).toMatchObject({ status: "unmatched", unmatched: ["25 亿"] });
    expect(c).toMatchObject({ status: "matched" });
    expect(d).toMatchObject({ status: "matched" }); // 304 is a bare count and is not looked up; 1766 亿 is in the data as 1766
    expect(e).toMatchObject({ status: "none", refs: [] });
    expect(f).toMatchObject({ status: "unknown", unknownRefs: ["F:A股:000001"] });
    expect(checkPoints([{ text: "宇树是这个板块里主营对口的公司", refs: ["B:BK1184"] }], index)[0].status).toBe("cited");
    // a loss or a fall is said in words, the data carries a minus sign: the size is what is compared
    const loss = refIndex([{ at: "2026-10-13T00:00:00Z", tool: "company.financials", input: { name: "优必选" }, ok: true, output: { ref: "F:港股:09880", query: "优必选", security: { market: "港股", code: "09880", name: "优必选" }, annual: [{ period: "2025年报", revenue: 2000999000, netProfit: -703191000, revenueYoy: -12.2, currency: "HKD" }] } }]);
    expect(checkPoints([{ text: "优必选 2025 年营收 20.0 亿港元，同比下降 12.2%，净亏约 7.03 亿港元", refs: ["F:港股:09880"] }], loss)[0]).toMatchObject({ status: "matched", unmatched: [] });
  });
});
