import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../db.js";
import { upsertFact } from "./profile.js";
import { openBrowser, closeBrowser, activePage, readForm, mapFields, normLabel, type FormField } from "./apply.js";
import { choose } from "./apply-widgets.js";
import { planBlocks } from "./apply-blocks.js";
import { siteFilled } from "./apply-run.js";

/** Regressions for the defects the independent acceptance found (docs/reports/2026-09-21-autofill-acceptance.md). */
const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].some(existsSync);
const field = (o: Partial<FormField>): FormField => ({ index: 0, local: 0, frame: "", section: "", label: "", type: "text", required: false, options: [], value: "", placeholder: "", name: "", entry: -1, ...o });
function profile() {
  const db = openDb(join(mkdtempSync(join(tmpdir(), "jobos-acc-")), "t.db"));
  for (const [f, v] of [["姓名", "李示例"], ["电话", "13800000000"]]) upsertFact(db, { kind: "basic", data: { field: f, value: v } }, "本人确认");
  upsertFact(db, { kind: "education", data: { school: "示例大学", degree: "博士", major: "控制科学与工程", period: "2021.09—2027.06" } }, "本人确认");
  upsertFact(db, { kind: "education", data: { school: "示例学院", degree: "本科", major: "自动化", period: "2017.09—2021.06" } }, "本人确认");
  return db;
}

describe("acceptance regressions: mapping", () => {
  it("D4: other people's 姓名 / 电话 (家庭成员, 紧急联系人, 父亲…) are never filled from the user's card", async () => {
    const m = await mapFields(profile(), undefined, [field({ index: 0, section: "家庭成员", label: "姓名" }), field({ index: 1, section: "紧急联系人", label: "电话" }), field({ index: 2, section: "其他", label: "父亲姓名" }), field({ index: 3, section: "个人信息", label: "姓名" })]);
    expect(m.map((x) => x.status)).toEqual(["不代填", "不代填", "不代填", "可填"]);
  });

  it("D7: a caption naming a stage picks that record; one naming two stages is not guessed", async () => {
    const m = await mapFields(profile(), undefined, [field({ index: 0, label: "本科就读院校" }), field({ index: 1, label: "博士专业" }), field({ index: 2, label: "本科/硕士就读院校" })]);
    expect(m.map((x) => x.proposed)).toEqual(["示例学院", "控制科学与工程", ""]);
  });

  it("D8: a repeated education block the platform does not delimit fills only its first entry", async () => {
    const m = await mapFields(profile(), undefined, [field({ index: 0, section: "教育经历", label: "学校名称" }), field({ index: 1, section: "教育经历", label: "学校名称" })]);
    expect(m.map((x) => x.status)).toEqual(["可填", "由你填写"]);
  });
  it("N10: 学习经历 / 学历信息 are education blocks too — the second entry is left to the user", async () => {
    const m = await mapFields(profile(), undefined, [
      field({ index: 0, section: "学习经历", label: "学校" }), field({ index: 1, section: "学习经历", label: "学校" }),
      field({ index: 2, section: "学历信息", label: "专业" }), field({ index: 3, section: "学历信息", label: "专业" }),
    ]);
    expect(m.map((x) => x.status)).toEqual(["可填", "由你填写", "可填", "由你填写"]);
  });
  it("N9: 「最高学历毕业时间」 is a date and 「院校所在区域」 a place — neither gets 博士 / the school name as text", async () => {
    const m = await mapFields(profile(), undefined, [field({ index: 0, label: "最高学历毕业时间" }), field({ index: 1, label: "最高学历院校所在区域" }), field({ index: 2, label: "最高学历" })]);
    expect(m[0].factKey).not.toBe("education.degree");
    // 2026-10-14: 「最高学历毕业时间」 / 「取得毕业证时间」 name the highest degree, so its end date is no guess — a date, never 博士
    expect(m[0].proposed).toMatch(/^\d{4}(-\d{2})?$|^$/);
    expect(m[0].proposed).not.toBe("博士");
    expect(m[1].proposed).toBe("");
    expect(m[2].proposed).toBe("博士");
  });

  it("D3: a new entry whose select shows a default is still an empty entry, not one to add another for", () => {
    const entry = [field({ section: "教育背景", label: "学校名称", entry: 0 }), field({ section: "教育背景", label: "学历", type: "select", value: "本科", entry: 0 })];
    const plan = planBlocks(profile(), entry);
    expect(plan.filter((p) => p.slot).length).toBe(1); // the empty entry takes the first record
    expect(plan.filter((p) => !p.slot).length).toBe(1); // only the second needs an addition
  });

  it("N6: an entry the site part-filled without a school is taken, so our record goes to a new entry, never mixed in", () => {
    const entry = [field({ section: "教育背景", label: "学校名称", entry: 0 }), field({ section: "教育背景", label: "专业", value: "计算机", entry: 0 }), field({ section: "教育背景", label: "学历", type: "select", value: "硕士", entry: 0 })];
    const plan = planBlocks(profile(), entry);
    expect(plan.every((p) => p.slot === null)).toBe(true); // both records need additions
    expect(plan).toHaveLength(2);
  });

  it("N11: a section that only says 研究生 takes the doctorate of a direct PhD; 硕士 stays empty", async () => {
    const m = await mapFields(profile(), undefined, [field({ index: 0, section: "研究生教育", label: "学校名称" }), field({ index: 1, section: "研究生阶段", label: "专业" }), field({ index: 2, section: "硕士教育", label: "学校名称" })]);
    expect(m.map((x) => x.proposed)).toEqual(["示例大学", "控制科学与工程", ""]);
  });

  it("D15: what the site filled is counted by caption, so an entry inserted at the top does not shift the count", () => {
    const before = [field({ section: "教育", label: "学校", value: "" }), field({ section: "基本", label: "邀请码", value: "XYZ-001" })];
    const after = [field({ section: "教育", label: "学校", value: "清华大学" }), field({ section: "教育", label: "专业", value: "计算机" }), field({ section: "教育", label: "学校", value: "" }), field({ section: "基本", label: "邀请码", value: "XYZ-001" })];
    expect(siteFilled(before, after)).toBe(2);
  });

  it("D12: 您的姓名 / 请输入姓名 are 姓名", () => {
    expect([normLabel("您的姓名"), normLabel("请输入姓名"), normLabel("姓名（必填）")]).toEqual(["姓名", "姓名", "姓名"]);
  });
});

const PAGE = `<!doctype html><meta charset="utf-8">
<header style="position:fixed;top:0;left:0"><a href="https://example.com/city/wuhan" id="nav">武汉</a></header>
<form id="f" style="margin-top:60px" onsubmit="event.preventDefault(); window.submitted = (window.submitted || 0) + 1">
  <div class="ant-form-item"><div class="ant-form-item-label"><label>入学时间</label></div><div class="ant-form-item-control"><span class="ant-picker"><input id="d" placeholder="请选择日期"></span></div></div>
  <div class="apply-field-a string_info"><div class="title-b">现居地</div><div class="sd-Dropdown-container-1"><label class="sd-Select-container-1"><span class="sd-Input-display-value-1"></span><input placeholder="请输入现居地"></label></div></div>
  <button type="submit">提交</button>
</form>
<script>document.getElementById("d").onblur = (e) => { const m = e.target.value.match(/^(\\d{4})-(\\d{2})/); if (m) e.target.value = m[1] + "-" + m[2]; };</script>`;

describe.skipIf(!CHROME)("acceptance regressions: never submit, never follow a page link", () => {
  afterAll(() => closeBrowser());
  it("D1: a typed date is committed without Enter, so the form is not submitted; D2: page chrome is never taken for a suggestion", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-acc-page-"));
    writeFileSync(join(dir, "p.html"), PAGE, "utf8");
    await openBrowser(dir, pathToFileURL(join(dir, "p.html")).href, { headless: true });
    const page = await activePage();
    page.setDefaultTimeout(5000);
    const form = await readForm();
    const at = (l: string) => page.locator(`[data-jobos-i="${form.fields.find((f) => f.label === l)!.local}"]`);
    expect(await choose(page, at("入学时间"), "2021.09")).toBe("");
    expect(await page.evaluate(() => (window as any).submitted ?? 0)).toBe(0);
    expect(await choose(page, at("现居地"), "湖北省武汉市")).not.toBe(""); // no suggestions ever appear: it says so
    expect(page.url()).toMatch(/p\.html$/); // the header's 「武汉」 link was not clicked
  }, 90_000);
});

describe("re-verification regressions", () => {
  it("D7: a 硕士 field stays empty for a 直博 profile (no master's record), never the PhD's school", async () => {
    const m = await mapFields(profile(), undefined, [field({ index: 0, label: "您的硕士就读院校" }), field({ index: 1, label: "硕士专业" }), field({ index: 2, label: "博士就读院校" })]);
    expect(m.map((x) => x.proposed)).toEqual(["", "", "示例大学"]);
  });
  it("N5: a form titled with 成员 / 联系人 is not taken for a family section", async () => {
    const m = await mapFields(profile(), undefined, [field({ index: 0, section: "2027届研发成员招聘报名表", label: "姓名" }), field({ index: 1, section: "家庭成员", label: "姓名" })]);
    expect(m.map((x) => x.status)).toEqual(["可填", "不代填"]);
  });
  it("N8: every wording of a section about other people is 不代填, while form titles stay fillable", async () => {
    const people = ["家庭状况", "家庭背景", "家人信息", "社会关系", "联系人信息", "推荐人", "内推人信息", "主要家庭成员"];
    const titles = ["新成员招募报名表", "校园招聘联系人登记表", "个人信息"];
    const m = await mapFields(profile(), undefined, [...people, ...titles].map((section, index) => field({ index, section, label: "姓名" })));
    expect(m.map((x) => x.status)).toEqual([...people.map(() => "不代填"), ...titles.map(() => "可填")]);
  });
});
