import { describe, it, expect } from "vitest";
import { pickUsListing, usBasic, usFinance } from "./us-stock.js";

/** Offline parts of 美股 企业情况; the rows are what 东财 answered on 2026-10-13 (trimmed). */
const hit = (Name: string, Code: string, SecurityTypeName: string, MktNum: string) => ({ Name, Code, SecurityTypeName, MktNum });

describe("美股 企业情况", () => {
  it("a name is a US-listed company only when it is that company's name; funds named after it are not it", () => {
    const nvda = [hit("英伟达", "NVDA", "美股", "105"), hit("英伟达周收益ETF-Roundhill", "NVDW", "美股", "107"), hit("英伟达概念", "BK1161", "板块", "90"), hit("二倍做多英伟达ETF-Corgi", "NVC", "美股", "107")];
    expect(pickUsListing("英伟达", nvda)).toEqual({ code: "NVDA.O", orgId: "", market: "美股", name: "英伟达" });
    expect(pickUsListing("英伟达（上海）有限公司", nvda)).toBeNull(); // a subsidiary is not looked up as its parent
    expect(pickUsListing("蔚来汽车", [hit("蔚来", "NIO", "美股", "106")])).toMatchObject({ code: "NIO.N" });
    expect(pickUsListing("阿里巴巴集团", [hit("阿里巴巴", "BABA", "美股", "106"), hit("阿里巴巴-W", "09988", "港股", "116")])).toMatchObject({ code: "BABA.N", market: "美股" });
    // containing a listed company's name is not being it; a 港股 hit is not a 美股 listing; an ETF alone is nothing
    expect(pickUsListing("苹果园科技", [hit("苹果", "AAPL", "美股", "105")])).toBeNull();
    expect(pickUsListing("腾讯", [hit("腾讯控股", "00700", "港股", "116"), hit("腾讯音乐", "TME", "美股", "106")])).toBeNull();
    expect(pickUsListing("拼多多", [hit("二倍做多拼多多ETF-KraneShares", "KPDD", "美股", "105")])).toBeNull();
  });

  it("maps the profile and the reports to the card's shape, each amount with its currency", () => {
    expect(usBasic({ ORG_NAME: "英伟达公司", ORG_EN_ABBR: "NVIDIA Corporation", BELONG_INDUSTRY: "半导体产品", FOUND_DATE: "1993-04", BELONG_MARKET: "纳斯达克", EMP_NUM: 42000, ORG_WEB: "www.nvidia.com", ADDRESS: "2788 San Tomas Expressway, Santa Clara, California, USA" }))
      .toMatchObject({ orgName: "英伟达公司", enName: "NVIDIA Corporation", industry: "半导体产品", employees: 42000, market: "纳斯达克", founded: "1993-04", province: "" });

    const row = (date: string, DATE_TYPE: string, REPORT_DATA_TYPE: string, income: number, profit: number) => ({ REPORT_DATE: `${date} 00:00:00`, DATE_TYPE, REPORT_DATA_TYPE, CURRENCY: "美元", OPERATE_INCOME: income, OPERATE_INCOME_YOY: 65.47, PARENT_HOLDER_NETPROFIT: profit, PARENT_HOLDER_NETPROFIT_YOY: 64.75, GROSS_PROFIT_RATIO: 71.07, ROE_AVG: 101.49 });
    const rows = [
      row("2026-07-26", "单季报", "2026年 第二季报", 96_221e6, 59_688e6), row("2026-07-26", "累计季报", "2026年 中报", 177_837e6, 118_010e6), row("2026-04-26", "单季报", "2026年 一季报", 81_615e6, 58_321e6),
      row("2026-01-25", "年报", "2025年 年报", 215_938e6, 120_067e6), row("2025-10-26", "累计季报", "2025年 三季报", 147_811e6, 77_107e6), row("2025-01-26", "年报", "2024年 年报", 130_497e6, 72_880e6),
      row("2024-01-28", "年报", "2023年 年报", 60_922e6, 29_760e6), row("2023-01-29", "年报", "2022年 年报", 26_974e6, 4_368e6),
    ];
    const rd = [{ REPORT_DATE: "2026-01-25 00:00:00", AMOUNT: 18_497e6 }, { REPORT_DATE: "2025-01-26 00:00:00", AMOUNT: 12_914e6 }, { REPORT_DATE: "2024-01-28 00:00:00", AMOUNT: 8_675e6 }];
    const f = usFinance(rows, rd);
    expect(f.annual.map((a) => [a.period, a.revenue, a.netProfit, a.rdExpense, a.currency])).toEqual([["2025年报", 215_938e6, 120_067e6, 18_497e6, "美元"], ["2024年报", 130_497e6, 72_880e6, 12_914e6, "美元"], ["2023年报", 60_922e6, 29_760e6, 8_675e6, "美元"]]);
    // the latest since the annual report is the half-year, not the second quarter alone
    expect(f.latest).toMatchObject({ period: "2026年中报", revenue: 177_837e6, currency: "美元" });
    // right after an annual report there is nothing newer to show
    expect(usFinance(rows.slice(3), rd).latest).toBeNull();
  });
});
