import { describe, it, expect } from "vitest";
import { rowsToListings } from "./feishu-base.js";

/**
 * The built-in 17-column 汇总表 layout must read exactly as it did before column mapping existed (ADR-044): the
 * snapshot beside this file was written by the code of 2026-10-12 (commit f39c4c9), before sheet.ts took the logic over.
 */
const text = (s: string) => ({ value: [{ type: "text", text: s }] });
const link = (s: string, href: string) => ({ value: [{ type: "url", text: s, link: href }] });
const fieldMap = {
  f0: { name: "更新时间", type: 5 }, f1: { name: "公司", type: 1 },
  f2: { name: "企业类型", type: 3, property: { options: [{ id: "t1", name: "央国企" }, { id: "t2", name: "民企" }] } },
  f3: { name: "行业类别", type: 1 }, f4: { name: "批次", type: 1 },
  f5: { name: "招聘届次", type: 4, property: { options: [{ id: "o27", name: "2027届" }, { id: "o26", name: "2026届" }] } },
  f6: { name: "工作地点", type: 4, property: { options: [{ id: "c1", name: "武汉" }, { id: "c2", name: "上海" }, { id: "c3", name: "深圳" }] } },
  f7: { name: "招聘岗位", type: 1 }, f8: { name: "学历要求", type: 1 }, f9: { name: "专业要求", type: 1 }, f10: { name: "开始时间", type: 5 },
  f11: { name: "截止时间", type: 1 }, f12: { name: "简历投递链接", type: 15 }, f13: { name: "公告链接", type: 15 }, f14: { name: "是否笔试", type: 1 },
  f15: { name: "公告来源", type: 1 }, f16: { name: "备注", type: 1 },
};
const records = {
  // the full row: every column, two titles, option cells, link cells
  r1: { f1: text("示例重工"), f2: { value: "t1" }, f3: text("装备制造"), f4: text("秋招"), f5: { value: ["o27"] }, f6: { value: ["c1", "c2"] }, f7: text("控制算法工程师、仿真工程师"), f8: text("硕士及以上"), f9: text("控制/自动化"), f11: text("2099-10-31"), f12: link("投递", "https://apply.example.com/a"), f13: link("公告", "https://notice.example.com/a"), f15: text("官网") },
  // 博士 batch, 招满为止, plain-text link, a source that is a school
  r2: { f1: text("示例研究院"), f2: { value: "t1" }, f4: text("2027届博士专项"), f5: { value: ["o27"] }, f6: { value: ["c3"] }, f7: text("博士后研究员"), f8: text("博士"), f11: text("招满为止"), f12: text("https://careers.example.org/phd"), f15: text("某大学就业网") },
  // no title: the batch stands in; a date cell as a number; 公众号 source
  r3: { f1: text("示例电子"), f2: { value: "t2" }, f4: text("实习"), f5: { value: ["o27", "o26"] }, f11: { value: 4102358400000 }, f13: link("公告", "https://mp.weixin.qq.com/s/abc"), f15: text("公众号") },
  // dropped: another cohort; already closed; no company
  r4: { f1: text("去年公司"), f5: { value: ["o26"] }, f7: text("工程师"), f11: text("2099-01-01") },
  r5: { f1: text("过期公司"), f5: { value: ["o27"] }, f7: text("工程师"), f11: text("2020-01-01") },
  r6: { f5: { value: ["o27"] }, f7: text("无主岗位") },
  // no batch, no title, no deadline, no link
  r7: { f1: text("示例光学"), f5: { value: ["o27"] } },
};

describe("飞书汇总表，内置 17 列格式", () => {
  it("reads row for row as it always has", () => {
    expect(rowsToListings(fieldMap, records as any, { cohort: "2027届", name: "校招汇总表" }, "2026-10-12")).toMatchSnapshot();
    expect(rowsToListings(fieldMap, records as any, { name: "" }, "2026-10-12").map((l) => `${l.company}|${l.title}`)).toMatchSnapshot("no cohort filter, no name");
  });
});
