import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { companyNames, upsertSme } from "./sme.js";
import { hkFinance } from "./intel.js";

describe("专精特新名录 from a list file", () => {
  it("pulls company names out of a pasted table, without headers or serial numbers", () => {
    const text = `序号 企业名称 所在地\n1 深圳拓竹科技有限公司 深圳\n2  武汉华中数控股份有限公司 武汉\n3 中国科学院沈阳自动化研究所 沈阳\n本公司承诺…`;
    expect(companyNames(text)).toEqual(["深圳拓竹科技有限公司", "武汉华中数控股份有限公司", "中国科学院沈阳自动化研究所"]);
  });
  it("upserts per (name, level) and counts new vs updated", () => {
    const db = openDb(join(mkdtempSync(join(tmpdir(), "jobos-sme-")), "t.db"));
    const rows = [{ name: "深圳拓竹科技有限公司", level: "国家级小巨人", batch: "第六批", source_url: "u" }];
    expect(upsertSme(db, rows)).toEqual({ inserted: 1, updated: 0 });
    expect(upsertSme(db, [...rows, { name: "深圳拓竹科技有限公司", level: "省级专精特新" }])).toEqual({ inserted: 1, updated: 1 });
  });
});

describe("港股 financials", () => {
  it("maps 东财 HK main indicators to the A-share card shape", () => {
    const f = hkFinance([
      { REPORT_TYPE: "2026年中报", OPERATE_INCOME: 57.6e9, HOLDER_PROFIT: -1.2e9, OPERATE_INCOME_YOY: 85.7, HOLDER_PROFIT_YOY: 89.9, GROSS_PROFIT_RATIO: 18.7, CURRENCY: "人民币" },
      { REPORT_TYPE: "2025年报", OPERATE_INCOME: 80e9, HOLDER_PROFIT: -20e9 },
      { REPORT_TYPE: "2025年三季报", OPERATE_INCOME: 60e9 },
      { REPORT_TYPE: "2024年报", OPERATE_INCOME: 65e9, HOLDER_PROFIT: -22e9 },
    ]);
    expect(f.latest).toMatchObject({ period: "2026年中报", revenue: 57.6e9, netProfit: -1.2e9 });
    expect(f.annual.map((a) => a.period)).toEqual(["2025年报", "2024年报"]);
  });
});
