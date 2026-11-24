/** The lists beyond 教育 / 实习 / 项目 / 获奖: 技能, 论文, 专利, 语言 — which records go onto a form, and what each box gets. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { upsertFact } from "./profile.js";
import { blockKind, planBlocks, valueIn, leftOut } from "./apply-blocks.js";
import type { FormField } from "./apply.js";

const db = () => openDb(join(mkdtempSync(join(tmpdir(), "jobos-lists-")), "t.db"));
const field = (section: string, label: string, entry: number, extra: Partial<FormField> = {}): FormField => ({ index: 0, local: 0, frame: "", section, label, type: "text", required: false, options: [], value: "", placeholder: "", name: "", entry, ...extra });
/** `entries` entries of one list, each with these captions */
const list = (section: string, labels: string[], entries = 1) => Array.from({ length: entries }).flatMap((_, e) => labels.map((l) => field(section, l, e))).map((f, i) => ({ ...f, index: i, local: i }));
const by = (fields: FormField[], label: string) => fields.find((f) => f.label === label)!;

describe("which list a heading names", () => {
  it("语言技能 is the languages, 编程语言 a skill, 技能证书 neither; 科研项目 stays a project", () => {
    expect(["专业技能", "IT 技能", "编程语言", "语言能力", "语言技能", "外语水平", "技能证书", "论文发表", "学术成果", "专利", "科研项目", "获奖情况", "个人信息"].map(blockKind))
      .toEqual(["skill", "skill", "skill", "language", "language", "language", null, "publication", "publication", "patent", "project", "award", null]);
  });
});

describe("技能", () => {
  const d = db();
  upsertFact(d, { kind: "skill", data: { name: "示例语言甲", level: "精通", note: "只给自己看的备注" } }, "本人确认");
  upsertFact(d, { kind: "skill", data: { name: "示例工具乙", level: "熟练" } }, "本人确认");
  upsertFact(d, { kind: "skill", data: { name: "示例方法丙", level: "在学" } }, "本人确认");
  upsertFact(d, { kind: "skill", data: { name: "示例软件丁" } }, "本人确认");
  const labels = ["技能名称", "掌握程度", "使用时间总计", "技能描述"];

  it("the skills with a stated level, one an entry; a note is never pasted; the rest are said, not dropped silently", () => {
    const fields = list("专业技能", labels);
    const plan = planBlocks(d, fields);
    // in the profile's own order (cards made in one millisecond, as here, have none): the first takes the empty entry
    expect(plan.map((p) => p.name).sort()).toEqual(["示例工具乙", "示例语言甲"]);
    expect(plan.map((p) => [p.kind, p.slot?.entry ?? null])).toEqual([["skill", 0], ["skill", null]]);
    expect(labels.map((l) => valueIn("skill", plan.find((p) => p.name === "示例语言甲")!.record, by(fields, l), 0, fields))).toEqual(["示例语言甲", "精通", "", ""]);
    expect(leftOut(d, fields)).toEqual([{ section: "专业技能", detail: expect.stringMatching(/2 项技能.*示例方法丙、示例软件丁/) }]);
  });

  it("a skill already on the form is not added again", () => {
    const fields = list("专业技能", labels).map((f) => (f.label === "技能名称" ? { ...f, value: "示例语言甲" } : f));
    expect(planBlocks(d, fields).map((p) => [p.name, p.slot])).toEqual([["示例工具乙", null]]);
  });
});

describe("论文 and 专利", () => {
  const d = db();
  upsertFact(d, { kind: "publication", data: { title: "An example method for sample systems", venue: "示例学报", year: "2024", date: "2024-04-01", authorOrder: "第一作者" } }, "本人确认");
  upsertFact(d, { kind: "publication", data: { title: "A second example on sample plants", venue: "示例会议", year: "2023", authorOrder: "第二作者" } }, "本人确认");
  upsertFact(d, { kind: "publication", data: { title: "A later example with a corresponding author", venue: "示例汇刊", year: "2025", authorOrder: "通讯作者" } }, "本人确认");
  upsertFact(d, { kind: "patent", data: { title: "一种示例装置的示例方法", number: "202600000000.0", authorOrder: "第一发明人" } }, "本人确认");
  upsertFact(d, { kind: "patent", data: { title: "示例仿真软件 V1.0（软件著作权）", number: "2026SR0000000" } }, "本人确认");

  it("first and corresponding author papers, newest first; the day where the profile has it, else the year", () => {
    const labels = ["名称", "发布时间", "所属期刊", "作者顺序", "论文类型"];
    const fields = list("论文发表", labels);
    const plan = planBlocks(d, fields);
    expect(plan.map((p) => p.name)).toEqual(["A later example with a corresponding author", "An example method for sample systems"]);
    expect(labels.map((l) => valueIn("publication", plan[1].record, by(fields, l), 0, fields))).toEqual(["An example method for sample systems", "2024-04-01", "示例学报", "第一作者", ""]);
    expect(valueIn("publication", plan[0].record, by(fields, "发布时间"), 0, fields)).toBe("2025");
    const boxes = [field("论文发表", "发表时间", 0, { placeholder: "年" }), field("论文发表", "发表时间", 0, { placeholder: "月" })];
    expect(boxes.map((b, n) => valueIn("publication", plan[1].record, b, n, boxes))).toEqual(["2024", "04"]);
    expect(leftOut(d, fields)).toEqual([{ section: "论文发表", detail: expect.stringContaining("另外 1 篇") }]);
  });

  it("with no word on who wrote what, every paper goes", () => {
    const e = db();
    for (const title of ["An example paper one", "An example paper two"]) upsertFact(e, { kind: "publication", data: { title, year: "2024" } }, "本人确认");
    const fields = list("论文", ["论文题目"]);
    expect(planBlocks(e, fields)).toHaveLength(2);
    expect(leftOut(e, fields)).toEqual([]);
  });

  it("a software copyright is not a patent unless the heading asks for both", () => {
    const labels = ["专利名称", "专利号", "专利类型", "发明人排名"];
    const fields = list("专利", labels);
    const plan = planBlocks(d, fields);
    expect(plan.map((p) => p.name)).toEqual(["一种示例装置的示例方法"]);
    expect(labels.map((l) => valueIn("patent", plan[0].record, by(fields, l), 0, fields))).toEqual(["一种示例装置的示例方法", "202600000000.0", "", "第一发明人"]);
    expect(planBlocks(d, list("专利及软件著作权", labels))).toHaveLength(2);
  });
});

describe("语言", () => {
  it("one entry from the 英语水平 card; a level the profile does not have stays empty", () => {
    const d = db();
    upsertFact(d, { kind: "basic", data: { field: "英语水平", value: "CET-6" } }, "本人确认");
    upsertFact(d, { kind: "basic", data: { field: "六级成绩", value: "520" } }, "本人确认");
    const labels = ["语言类型", "掌握程度", "语言证书", "外语成绩得分"];
    const fields = list("语言能力", labels);
    const plan = planBlocks(d, fields);
    expect(plan.map((p) => [p.kind, p.name])).toEqual([["language", "英语"]]);
    expect(labels.map((l) => valueIn("language", plan[0].record, by(fields, l), 0, fields))).toEqual(["英语", "", "CET-6", "520"]);
    expect(planBlocks(db(), fields)).toEqual([]); // no card, no entry
  });
});
