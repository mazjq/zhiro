import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { compare, percentile, measures, moved, labels, placeUnder, notOutdone, sampleWeights, findCompany, latestYear, type PeerRow } from "./employer.js";

const yr = (revenue: number, netProfit: number, rd: number, staffCash: number) => ({ revenue, netProfit, rd, opCost: revenue * 0.7, staffCash, dividendCash: null, capex: null });
const firm = (code: string, name: string, employees: number | null, years: Record<string, ReturnType<typeof yr>>): PeerRow => ({ code, name, org: `${name}股份有限公司`, industry: "机械设备-自动化设备-机器人", employees, years });

describe("comparing employers: measures, places and how they move (D-29)", () => {
  it("measures a year: growth over three years, shares of revenue, staff cash per person; changes that came together", () => {
    const r = firm("300001.SZ", "甲", 1000, { 2025: yr(133.1, 10, 13.31, 200), 2024: yr(121, 12, 12, 220), 2022: yr(100, 8, 9, 180) });
    const m = measures(r, 2025);
    expect(m.main.growth).toBeCloseTo(0.1, 6);
    expect(m.main.rd).toBeCloseTo(0.1, 6);
    expect(m.main.pay).toBe(0.2);
    expect(m.main.profit).toBeCloseTo(10 / 133.1, 6);
    expect(moved(m.more)).toEqual(["营收增长、利润下降（增收不增利）"]);
    const cut = measures(firm("x", "乙", 10, { 2025: yr(90, 12, 5, 150), 2024: yr(100, 10, 6, 200) }), 2025);
    expect(cut.main.growth).toBeNull(); // no 2022: not guessed
    expect(moved(cut.more)[0]).toMatch(/营收下降、利润增长；同期职工现金、研发费用减少/);
    expect(measures(firm("y", "丙", null, { 2025: yr(10, 1, 1, 1) }), 2025).main.pay).toBeNull();
  });

  it("percentiles count half the ties; labels say their rule", () => {
    expect(percentile([1, 2, 3, 4], 3)).toBe(63);
    expect(percentile([5, 5, 5, 5], 5)).toBe(50);
    expect(labels({ growth: 60, rd: 80, pay: 90, profit: 10 }).map((l) => l.label)).toEqual(["研发驱动", "职工现金支出靠前"]);
    expect(labels({ growth: 30, rd: 10, pay: 10, profit: 80 })).toEqual([{ label: "稳健盈利", rule: "盈利百分位 ≥ 75 且成长 < 50" }]);
  });

  it("draws weights near the chosen ones, the same every time", () => {
    const c = { growth: 0.25, rd: 0.25, pay: 0.25, profit: 0.25 };
    const a = sampleWeights(c, 0.1, 200), b = sampleWeights(c, 0.1, 200);
    expect(a).toHaveLength(200);
    expect(a).toEqual(b);
    for (const w of a) { expect(Object.values(w).reduce((x, y) => x + y, 0)).toBeCloseTo(1, 9); for (const v of Object.values(w)) expect(Math.abs(v - 0.25)).toBeLessThanOrEqual(0.1); }
  });

  it("places: a clear leader stays first; close ones trade places; a missing measure gives bounds, not a guess", () => {
    const picks = [
      { code: "A", pct: { growth: 90, rd: 90, pay: 90, profit: 90 } },
      { code: "B", pct: { growth: 80, rd: 20, pay: 50, profit: 50 } },
      { code: "C", pct: { growth: 20, rd: 80, pay: 50, profit: 50 } },
      { code: "D", pct: { growth: 10, rd: 10, pay: 10, profit: 10 } },
      { code: "E", pct: { growth: 70, rd: null, pay: 60, profit: 60 } },
    ];
    const r = placeUnder(picks, { growth: 0.25, rd: 0.25, pay: 0.25, profit: 0.25 }, 1, 1000);
    expect(r.places.get("A")).toMatchObject({ place: 1, usually: [1, 1], top3Share: 100 });
    expect(r.places.get("D")).toMatchObject({ place: 4, top3Share: 0 });
    const b = r.places.get("B"), c = r.places.get("C");
    expect(b.usually).toEqual([2, 3]);
    expect(c.usually).toEqual([2, 3]);
    expect(r.places.get("E")).toMatchObject({ place: null, missing: ["rd"], best: 2, worst: 4 });
    expect(notOutdone(picks)).toEqual(new Map([["A", []], ["B", ["A"]], ["C", ["A"]], ["D", ["A", "B", "C"]]]));
  });

  it("finds a company by code, short name or legal name; asks when names are close", () => {
    const all = [{ code: "300124.SZ", name: "汇川技术", org: "深圳市汇川技术股份有限公司", industry: "机械设备-自动化设备-工控设备", employees: 1 }, { code: "688001.SH", name: "华兴源创", org: "苏州华兴源创科技股份有限公司", industry: "电子", employees: 1 }, { code: "688002.SH", name: "华兴源创B", org: "华兴源创某某股份有限公司", industry: "电子", employees: 1 }];
    expect(findCompany(all, "300124")).toMatchObject({ name: "汇川技术" });
    expect(findCompany(all, "深圳市汇川技术股份有限公司")).toMatchObject({ code: "300124.SZ" });
    expect(findCompany(all, "汇川技术有限公司")).toMatchObject({ code: "300124.SZ" });
    expect(findCompany(all, "华兴源创")).toMatchObject({ code: "688001.SH" });
    expect(findCompany(all, "宇树")).toBeNull();
    expect(latestYear(Date.parse("2026-04-30T16:00:00Z"))).toBe(2025); // 1 May in Beijing
    expect(latestYear(Date.parse("2026-04-30T12:00:00Z"))).toBe(2024);
  });
});

describe("employer.compare over the network's shape, without the network", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("reads the list and one industry's statements once, keeps them, ranks only listed ones", async () => {
    const orgs = [
      { SECUCODE: "300001.SZ", SECURITY_NAME_ABBR: "甲机器人", ORG_NAME: "甲机器人股份有限公司", BOARD_NAME_LEVEL: "机械设备-自动化设备-机器人", EMP_NUM: 100 },
      { SECUCODE: "300002.SZ", SECURITY_NAME_ABBR: "乙装备", ORG_NAME: "乙装备股份有限公司", BOARD_NAME_LEVEL: "机械设备-通用设备-机床工具", EMP_NUM: 200 },
      { SECUCODE: "300003.SZ", SECURITY_NAME_ABBR: "丙新上市", ORG_NAME: "丙新上市股份有限公司", BOARD_NAME_LEVEL: "机械设备-专用设备-其他", EMP_NUM: 50 },
      { SECUCODE: "600001.SH", SECURITY_NAME_ABBR: "丁银行", ORG_NAME: "丁银行股份有限公司", BOARD_NAME_LEVEL: "银行-银行Ⅱ-股份制银行Ⅲ", EMP_NUM: 9 },
    ];
    const inc = (code: string, y: number, rev: number, np: number, rd: number) => ({ SECUCODE: code, REPORT_DATE: `${y}-12-31 00:00:00`, TOTAL_OPERATE_INCOME: rev, PARENT_NETPROFIT: np, RESEARCH_EXPENSE: rd, OPERATE_COST: rev / 2 });
    const cash = (code: string, y: number, staff: number) => ({ SECUCODE: code, REPORT_DATE: `${y}-12-31 00:00:00`, PAY_STAFF_CASH: staff, ASSIGN_DIVIDEND_PORFIT: 1, CONSTRUCT_LONG_ASSET: 2 });
    const income = [inc("300001.SZ", 2025, 200, 20, 30), inc("300001.SZ", 2024, 150, 10, 20), inc("300001.SZ", 2022, 100, 5, 10), inc("300002.SZ", 2025, 100, 2, 3), inc("300002.SZ", 2024, 110, 4, 4), inc("300002.SZ", 2022, 120, 6, 5)];
    const cashflow = [cash("300001.SZ", 2025, 30), cash("300001.SZ", 2024, 25), cash("300002.SZ", 2025, 20), cash("300002.SZ", 2024, 22)];
    const asked: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url), report = u.searchParams.get("reportName")!, filter = u.searchParams.get("filter") ?? "";
      asked.push(report);
      const pick = (rows: any[]) => rows.filter((r) => filter.includes(r.SECUCODE));
      const data = report === "RPT_F10_BASIC_ORGINFO" ? orgs : report === "RPT_F10_FINANCE_GINCOME" ? pick(income) : pick(cashflow);
      return { json: async () => ({ success: true, result: { pages: 1, data } }), status: 200 } as any;
    });
    const db = openDb(join(mkdtempSync(join(tmpdir(), "zhiro-emp-")), "t.db"));
    const now = Date.parse("2026-10-18T00:00:00Z");
    const r: any = await compare(db, { companies: ["甲机器人", "300002", "丙新上市", "宇树科技"], weights: { growth: 3, rd: 1 } }, now);
    expect(r.year).toBe(2025);
    expect(r.data.pools).toEqual({ 机械设备: { at: "2026-10-18T00:00:00.000Z", companies: 2 } }); // 丙 has no 2025 revenue; 丁 is another industry
    const [a, b, c] = r.companies;
    expect(a).toMatchObject({ name: "甲机器人", coverage: "4/4", percentile: { growth: 75, rd: 75, pay: 75, profit: 75 }, peers: { growth: 2 }, outdoneBy: [] });
    expect(b.outdoneBy).toEqual(["甲机器人"]);
    expect(b).toMatchObject({ name: "乙装备", percentile: { growth: 25, rd: 25, pay: 25, profit: 25 } });
    expect(b.movedTogether).toEqual(["营收和利润同时下降"]);
    expect(c).toMatchObject({ name: "丙新上市", note: expect.stringContaining("2025") });
    expect(Object.keys(a.under)).toEqual(["成长研发优先", "均衡", "稳定回报优先", "你设的权重"]);
    expect(r.scenarios.你设的权重.weights).toEqual({ growth: 0.75, rd: 0.25, pay: 0, profit: 0 });
    expect(a.under.均衡).toMatchObject({ place: 1, top3Share: 100 });
    expect(r.notFound).toEqual([expect.objectContaining({ query: "宇树科技" })]);
    const calls = asked.length;
    await compare(db, { companies: ["甲机器人"] }, now + 86400_000);
    expect(asked.length).toBe(calls); // the same data for 30 days
  });
});
