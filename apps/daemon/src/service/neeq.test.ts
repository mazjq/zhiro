import { describe, it, expect } from "vitest";
import { parseStaff, pickNeeq, neeqFinance } from "./neeq.js";

describe("新三板 企业情况 offline parts", () => {
  it("reads 期末 headcount and R&D staff from a pdftotext -raw annual report, where blank cells vanish", () => {
    // 吉田股份 2025 年报 as pdftotext -raw prints it (CRLF on Windows)
    const text = ["第七节 公司治理", "(一) 在职员工（公司及控股子公司）情况", "按工作性质分类 期初人数 本期新增 本期减少 期末人数", "管理人员 16 2 3 15", "技术人员 34 7 27", "生产人员 136 24 33 127", "员工总计 222 27 45 204", "按教育程度分类 期初人数 期末人数", "员工总计 222 204",
      "……", "研发人员合计 34 27"].join("\r\n");
    expect(parseStaff(text)).toEqual({ employees: 204, rdStaff: 27, techStaff: 27 });
    expect(parseStaff("没有这一节")).toEqual({ employees: null, rdStaff: null, techStaff: null });
  });
  it("takes only a 三板 hit (not the 北交所 listing of the same name) and matches the name without the legal suffix", () => {
    const hits = [{ code: "920819", shortName: "颖泰生物", securityTypeName: "京A" }, { code: "834793", shortName: "华强方特", securityTypeName: "三板" }];
    expect(pickNeeq("华强方特文化科技集团股份有限公司", hits)?.code).toBe("834793");
    expect(pickNeeq("颖泰生物", hits)).toBeNull();
    expect(pickNeeq("吉田香料", [{ code: "871258", shortName: "吉田股份", securityTypeName: "三板" }])?.code).toBe("871258");
    expect(pickNeeq("田园香料", [{ code: "871258", shortName: "吉田股份", securityTypeName: "三板" }])).toBeNull();
  });
  it("finance: annual rows with yoy from the year before, the latest interim apart, staff cash joined by date", () => {
    const lrb = [{ REPORTDATE: "2026-06-30 00:00:00", OPERATEREVE: "110", PARENTNETPROFIT: "11" }, { REPORTDATE: "2025-12-31 00:00:00", OPERATEREVE: "200", PARENTNETPROFIT: "20", RDEXP: "5" },
      { REPORTDATE: "2025-06-30 00:00:00", OPERATEREVE: "100", PARENTNETPROFIT: "10" }, { REPORTDATE: "2024-12-31 00:00:00", OPERATEREVE: "160", PARENTNETPROFIT: "25" }];
    const f = neeqFinance(lrb, [{ REPORTDATE: "2025-12-31 00:00:00", EMPLOYEEPAY: "30" }]);
    expect(f.annual[0]).toMatchObject({ period: "2025年报", revenue: 200, revenueYoy: 25, netProfitYoy: -20, rdExpense: 5, staffCash: 30 });
    expect(f.latest).toMatchObject({ period: "2026-06-30", revenueYoy: 10 });
  });
});
