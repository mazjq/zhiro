/** The person's 「系统填写」 document, and what the first real Moka form showed was wrong (2026-10-14). */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { upsertFact } from "./profile.js";
import { parseReference, parseAward } from "./apply-reference.js";
import { mapFields, refAnswer, pickOption, type FormField } from "./apply.js";
import { planBlocks, valueIn } from "./apply-blocks.js";
import { optionAliases } from "./apply-widgets.js";

const DOC = [
  "主要专业成果", "一、第一作者论文", "1. Z. Ma, … ISA Transactions, 2024.（第一作者，SCI，JCR Q1）",
  "奖惩信息", "一、奖励（按时间倒序）",
  "1. 2026年 湖北省第十四届“挑战杯”大学生创业计划竞赛一等奖（省级，团队项目《定海神针》）",
  "2. 2018年 中国地质大学（武汉）物理竞赛三等奖、数学竞赛三等奖（校级）",
  "3. 2021年 中国地质大学（武汉）校级优秀本科毕业论文（前5%）",
  "二、惩处", "无",
  "*爱好", "网球、滑雪。", "68/2000",
  "*特长", "1. 控制算法设计与仿真", "2. 实时控制与工程部署",
  "自我评价", "控制科学与工程直博。", "另外的版本：", "不该读到的另一版。",
  "网申常见栏目", "说明：下面是 Zhiro 读的", "身高/cm：178", "体重/kg：待填", "高考分数：待填（只写数字）", "参加高考地：湖南省", "MBTI：INTJ",
  "项目经历", "项目名称：定向钻机上位机系统开发项目", "项目描述：校企合作横向项目。", "担任角色：技术负责人", "项目职责：组织完成上位机系统。",
];

function db() {
  const d = openDb(join(mkdtempSync(join(tmpdir(), "jobos-ref-")), "t.db"));
  upsertFact(d, { kind: "basic", data: { field: "英语水平", value: "CET-6" } }, "本人确认");
  upsertFact(d, { kind: "preference", data: { field: "期望薪资", value: "面议" } }, "本人确认");
  upsertFact(d, { kind: "education", data: { school: "中国地质大学（武汉）", degree: "博士", major: "控制科学与工程", period: "2021.09—2027.06" } }, "本人确认");
  upsertFact(d, { kind: "basic", data: { field: "发送动态码", value: "5mha" } }, "本人确认"); // learned once from a form: never offered again
  upsertFact(d, { kind: "award", data: { title: "全国大学生电子设计竞赛 · 全国一等奖", year: "2019" } }, "材料自述");
  upsertFact(d, { kind: "award", data: { title: "全国大学生电子设计竞赛（本科组）· 全国一等奖", year: "2019" } }, "材料自述");
  upsertFact(d, { kind: "project", data: { title: "定向钻机上位机系统开发项目", role: "技术负责人", summary: "组织完成上位机系统。", description: "校企合作横向项目。", period: "2025.10-2026.10" } }, "本人确认");
  return d;
}
const field = (label: string, type = "text", extra: Partial<FormField> = {}): FormField => ({ index: 0, local: 0, frame: "", section: "个人信息", label, type, required: true, options: [], value: "", placeholder: "", name: "", entry: -1, ...extra });

describe("the 系统填写 document", () => {
  it("reads awards (two in one line become two), 爱好, 特长, the first 自我评价, 「栏目：值」 lines and projects; 待填 is no value", () => {
    const r = parseReference(DOC);
    expect(r.awards.map((a) => a.title)).toEqual(["湖北省第十四届“挑战杯”大学生创业计划竞赛一等奖", "中国地质大学（武汉）物理竞赛三等奖", "中国地质大学（武汉）数学竞赛三等奖", "中国地质大学（武汉）校级优秀本科毕业论文（前5%）"]);
    expect(r.awards[0]).toMatchObject({ year: "2026", level: "省级", note: "团队项目《定海神针》" });
    expect(r.fields.get("爱好")).toBe("网球、滑雪。");
    expect(r.fields.get("个人特长")).toBe("1. 控制算法设计与仿真\n2. 实时控制与工程部署");
    expect(r.fields.get("自我评价")).toBe("控制科学与工程直博。");
    expect(r.fields.get("身高/cm")).toBe("178");
    expect(r.fields.has("体重/kg")).toBe(false);
    expect(r.fields.has("高考分数")).toBe(false);
    expect(r.fields.has("说明")).toBe(false);
    expect(r.projects).toEqual([{ title: "定向钻机上位机系统开发项目", description: "校企合作横向项目。", role: "技术负责人", summary: "组织完成上位机系统。" }]);
    expect(parseAward("不是一条奖")).toEqual([]);
    expect(refAnswer(r, "个人特长")?.key).toBe("个人特长");
    expect(refAnswer(r, "身高/cm")?.value).toBe("178");
  });
});

describe("what the first real Moka form got wrong", () => {
  it("fills from the document first; a number box gets a number or nothing; 海外院校毕业 is yes/no; 毕业证 time is the degree's end; codes are never offered", async () => {
    const d = db(), ref = parseReference(DOC);
    const [height, score, salary, abroad, cert, special, code] = await mapFields(d, undefined, [
      field("身高/cm", "number"), field("英语考试成绩", "number"), field("期望月薪", "number", { section: "求职意向" }),
      field("海外院校毕业", "dropdown"), field("取得毕业证时间", "dropdown"), field("个人特长", "text", { section: "自我描述" }), field("发送动态码"),
    ].map((f, i) => ({ ...f, index: i })), ref);
    expect(height).toMatchObject({ status: "可填", proposed: "178", how: "文档" });
    expect(score.status).toBe("画像里没有");
    expect(score.source).toContain("只收数字");
    expect(salary.status).not.toBe("可填");
    expect(abroad).toMatchObject({ status: "可填", proposed: "否" });
    expect(cert).toMatchObject({ status: "可填", proposed: "2027-06" });
    expect(special.proposed).toContain("控制算法设计与仿真");
    expect(code.status).toBe("不代填");
  });

  it("matches English levels across their names", () => {
    expect(optionAliases("CET-6")).toEqual(expect.arrayContaining(["大学英语六级", "英语六级", "六级"]));
    expect(pickOption(["大学英语四级", "大学英语六级", "专业英语八级"], "CET-6")).toBe("大学英语六级");
    expect(pickOption(["四级", "六级"], "英语六级")).toBe("六级");
  });

  it("项目描述 is the project, 职责 is what the person did; one award spelled two ways goes once; the document's list wins", () => {
    const d = db();
    const entry = (labels: string[], section: string) => labels.map((label, i) => ({ ...field(label, "textarea"), section, entry: 0, index: i, local: i }));
    const slot = entry(["项目名称", "项目描述", "项目中职责"], "项目经验");
    const record = { title: "定向钻机上位机系统开发项目", role: "技术负责人", summary: "组织完成上位机系统。", description: "校企合作横向项目。" };
    expect(valueIn("project", record, slot[1], 0, slot)).toBe("校企合作横向项目。");
    expect(valueIn("project", record, slot[2], 0, slot)).toBe("技术负责人：组织完成上位机系统。");
    const alone = entry(["项目名称", "项目描述"], "项目经验");
    expect(valueIn("project", record, alone[1], 0, alone)).toBe("校企合作横向项目。\n本人职责：技术负责人：组织完成上位机系统。");
    // a real Moka form: a one-line 「职责」 beside the 「项目中职责」 paragraph is the role
    const both = entry(["项目名称", "职责", "项目描述", "项目中职责"], "项目经验").map((f, i) => (i === 1 ? { ...f, type: "text" } : f));
    expect(valueIn("project", record, both[1], 0, both)).toBe("技术负责人");
    expect(valueIn("project", record, both[3], 0, both)).toBe("组织完成上位机系统。");
    const awards = entry(["奖项名称"], "获奖经历");
    expect(planBlocks(d, awards).map((p) => p.name)).toEqual(["全国大学生电子设计竞赛 · 全国一等奖"]);
    expect(planBlocks(d, awards, parseReference(DOC)).map((p) => p.name)).toHaveLength(4);
  });
});
