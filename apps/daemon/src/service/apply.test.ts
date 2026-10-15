import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../db.js";
import { upsertFact, listFacts } from "./profile.js";
import { profileGaps } from "./gaps.js";
import { openBrowser, closeBrowser, readForm, mapFields, type FormField } from "./apply.js";

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].some(existsSync);

function profileDb() {
  const vault = mkdtempSync(join(tmpdir(), "jobos-apply-"));
  const db = openDb(join(vault, "t.db"));
  for (const [field, value] of [["姓名", "李示例"], ["邮箱", "li@example.com"], ["电话", "13800000000"]]) upsertFact(db, { kind: "basic", data: { field, value } }, "本人确认");
  upsertFact(db, { kind: "education", data: { school: "示例大学", degree: "博士", major: "控制科学与工程", period: "2021-2027" } }, "本人确认");
  upsertFact(db, { kind: "education", data: { school: "示例学院", degree: "本科", major: "自动化", period: "2017-2021" } }, "本人确认");
  return { vault, db };
}
const field = (o: Partial<FormField>): FormField => ({ index: 0, local: 0, frame: "", section: "", label: "", type: "text", required: false, options: [], value: "", placeholder: "", name: "", ...o });

describe("apply probe: mapping", () => {
  it("fills what the profile knows, leaves personal choices and sensitive fields to the user, and picks the closest option", async () => {
    const { db } = profileDb();
    const m = await mapFields(db, undefined, [
      field({ index: 0, label: "姓名" }), field({ index: 1, label: "手机号码" }), field({ index: 2, label: "最高学历", type: "select", options: ["本科", "硕士研究生", "博士研究生"] }),
      field({ index: 3, section: "本科教育经历", label: "学校名称" }), field({ index: 4, label: "身份证号" }), field({ index: 5, label: "期望薪资" }),
      field({ index: 6, label: "简历附件", type: "file" }), field({ index: 7, label: "邮箱", value: "old@example.com" }), field({ index: 8, label: "政治面貌" }), field({ index: 9, label: "专业", type: "cascader" }),
    ]);
    const by = (i: number) => m.find((x) => x.index === i)!;
    expect(by(0)).toMatchObject({ proposed: "李示例", status: "可填", how: "规则" });
    expect(by(1)).toMatchObject({ proposed: "13800000000", status: "可填" });
    expect(by(2)).toMatchObject({ proposed: "博士研究生", status: "可填" });
    expect(by(3)).toMatchObject({ proposed: "示例学院", status: "可填" }); // the section heading picks the bachelor's record
    expect(by(4)).toMatchObject({ proposed: "", status: "不代填" });
    expect(by(5)).toMatchObject({ proposed: "", status: "由你填写" });
    expect(by(6).status).toBe("上传文件");
    expect(by(7)).toMatchObject({ proposed: "li@example.com", status: "已有内容" }); // never silently overwrite what is already there
    expect(by(8).status).toBe("画像里没有");
    expect(by(9)).toMatchObject({ proposed: "控制科学与工程", status: "可填" }); // the widget driver decides how to set it
  });

  it("only labels and options reach the model; its keys are filled from the profile locally", async () => {
    const { db } = profileDb();
    let sent = "";
    const llm: any = { model: () => ({}), models: { completeSimple: async (_m: unknown, ctx: any) => { sent = ctx.messages[0].content[0].text; return { content: [{ type: "text", text: JSON.stringify({ map: [{ index: 0, key: "education.school" }, { index: 1, key: "project" }, { index: 2, key: "made.up" }] }) }] }; } } };
    const m = await mapFields(db, llm, [field({ index: 0, label: "就读高校全称" }), field({ index: 1, label: "科研经历描述", type: "textarea" }), field({ index: 2, label: "奇怪的字段" })]);
    expect(sent).not.toContain("李示例");
    expect(sent).not.toContain("示例大学");
    expect(m[0]).toMatchObject({ proposed: "示例大学", how: "模型", status: "可填" });
    expect(m[1]).toMatchObject({ factKey: "project", status: "由你填写" });
    expect(m[2]).toMatchObject({ factKey: "", status: "画像里没有" });
  });
});

describe.skipIf(!CHROME)("apply probe: reading a real page in the dedicated Chrome profile", () => {
  afterAll(() => closeBrowser());

  it("Moka's hashed CSS-module structure: field titles are labels, blockTitle is the section, read-only 请选择 is a dropdown", async () => {
    const { vault } = profileDb();
    // structure copied from app.mokahr.com's apply form (2026-09): class = stable prefix + hash
    const fieldHtml = (title: string, ctrl: string, req = true) => `<div class="apply-field-Q2iJ7AtQGX string_info-UOJxKN5mtC"><div class="title-IWWQ0Xa4L7"><span><span>${title}</span></span>${req ? '<span class="required-asterisk-av7daEKsLS">*</span>' : ""}</div><div class="ctrl-CICMG4Fr4_">${ctrl}</div></div>`;
    const select = (ph: string) => `<div class="sd-Dropdown-container-1CigZ"><label class="sd-Input-container-2S_vM sd-Select-container-1Eq4x"><input class="sd-Input-input-10L0t" placeholder="${ph}"></label></div>`;
    writeFileSync(join(vault, "moka.html"), `<meta charset="utf-8"><title>moka</title><input style="position:absolute;left:-9999px;width:0;height:0">
      <div><div class="blockTitle-dcmrfhpkg1">个人信息</div>${fieldHtml("姓名", '<label class="sd-Input-container-2S_vM"><input class="sd-Input-input-10L0t" placeholder="姓名"></label>')}${fieldHtml("性别", select("请选择"))}</div>
      <div><div class="blockTitle-dcmrfhpkg1">教育背景</div>${fieldHtml("就读时间", `<div class="item-CNFmjn2r6y">${select("年")}</div><div class="item-CNFmjn2r6y">${select("月")}</div>`)}${fieldHtml("兴趣爱好", "<textarea placeholder='请输入兴趣爱好'></textarea>", false)}</div>`);
    await openBrowser(vault, pathToFileURL(join(vault, "moka.html")).href, { headless: true });
    const form = await readForm();
    expect(form.fields.map((f) => `${f.section}/${f.label}/${f.type}${f.required ? "*" : ""}/${f.placeholder}`)).toEqual([
      "个人信息/姓名/text*/姓名", "个人信息/性别/dropdown*/请选择", "教育背景/就读时间/dropdown*/年", "教育背景/就读时间/dropdown*/月", "教育背景/兴趣爱好/textarea/请输入兴趣爱好",
    ]);
  }, 60_000);

  it("reads labels, sections, required marks, options and an iframe — and changes nothing", async () => {
    const { vault, db } = profileDb();
    writeFileSync(join(vault, "inner.html"), `<meta charset="utf-8"><div class="el-form-item is-required"><label class="el-form-item__label">紧急联系人电话</label><div><input class="el-input__inner"></div></div>`);
    writeFileSync(join(vault, "form.html"), `<meta charset="utf-8"><title>示例公司 网申</title>
      <h3>基本信息</h3>
      <div class="ant-form-item"><div class="ant-form-item-label"><label class="ant-form-item-required">姓名</label></div><div><input id="n"></div></div>
      <div class="ant-form-item"><div class="ant-form-item-label"><label>邮箱</label></div><div><input type="email" value=""></div></div>
      <div class="ant-form-item"><div class="ant-form-item-label"><label>性别</label></div><div><label><input type="radio" name="g" value="m">男</label><label><input type="radio" name="g" value="f">女</label></div></div>
      <h3>教育经历</h3>
      <div class="ant-form-item"><div class="ant-form-item-label"><label>学历</label></div><div><select><option>请选择</option><option>硕士研究生</option><option>博士研究生</option></select></div></div>
      <div class="ant-form-item"><div class="ant-form-item-label"><label>入学时间</label></div><div class="ant-picker"><input placeholder="请选择日期"></div></div>
      <div class="ant-form-item"><div class="ant-form-item-label"><label>简历</label></div><div><input type="file"></div></div>
      <input type="hidden" name="csrf" value="x"><div style="display:none"><input name="ghost"></div>
      <iframe src="inner.html" style="width:400px;height:80px"></iframe>
      <button>保存</button><button>提交申请</button>`);
    await openBrowser(vault, pathToFileURL(join(vault, "form.html")).href, { headless: true });
    const form = await readForm();
    expect(form.title).toBe("示例公司 网申");
    expect(form.submitButtons).toEqual(["提交申请"]);
    const labels = form.fields.map((f) => `${f.section}/${f.label}/${f.type}${f.required ? "*" : ""}`);
    expect(labels).toEqual(["基本信息/姓名/text*", "基本信息/邮箱/email", "基本信息/性别/radio", "教育经历/学历/select", "教育经历/入学时间/date", "教育经历/简历/file", "/紧急联系人电话/text*"]);
    expect(form.fields.find((f) => f.label === "性别")!.options).toEqual(["男", "女"]);
    expect(form.fields.at(-1)!.frame).toContain("inner.html");

    const mapped = await mapFields(db, undefined, form.fields);
    expect(mapped.find((f) => f.label === "学历")).toMatchObject({ proposed: "博士研究生", status: "可填" });
    expect(mapped.find((f) => f.label === "紧急联系人电话")!.status).toBe("不代填");
    // read-only: nothing was typed
    expect((await readForm()).fields.every((f) => f.value === "" || f.value === "请选择")).toBe(true);
  }, 60_000);
});

describe("mapping from what the user answered before", () => {
  it("reuses a field under its common name on any site, splits a 年/月 range, and never guesses dates on a form without sections", async () => {
    const { db } = profileDb();
    const phd = listFacts(db).items.find((f) => f.kind === "education" && f.data.degree === "博士")!;
    upsertFact(db, { id: phd.id, kind: "education", data: { ...phd.data, period: "2021.09—2027.06" } }, "本人确认"); // the user edits the card
    upsertFact(db, { kind: "basic", data: { field: "性别", value: "男" } }, "本人确认");
    upsertFact(db, { kind: "basic", data: { field: "民族", value: "汉族" } }, "本人确认");
    upsertFact(db, { kind: "preference", data: { field: "期望城市", value: "武汉" } }, "本人确认");
    upsertFact(db, { kind: "basic", data: { field: "校招面试站点", value: "武汉站" } }, "本人确认");
    const m = await mapFields(db, undefined, [
      field({ index: 0, label: "性别", type: "dropdown" }), field({ index: 1, label: "民族", type: "dropdown" }), field({ index: 2, label: "期望工作城市" }),
      field({ index: 3, label: "校招面试站点（必选）", type: "cascader" }), field({ index: 4, label: "期望薪资" }),
      ...["年", "月", "年", "月"].map((ph, i) => field({ index: 5 + i, section: "教育背景", label: "就读时间", placeholder: ph, type: "dropdown" })),
      field({ index: 9, label: "开始时间" }), field({ index: 10, label: "手机号码" }), field({ index: 13, label: "是否接受意向城市调剂", type: "dropdown" }),
      ...["年", "月"].map((ph, i) => field({ index: 11 + i, section: "个人信息", label: "毕业时间", placeholder: ph, type: "dropdown" })),
    ]);
    const by = (i: number) => m.find((x) => x.index === i)!;
    expect(by(0)).toMatchObject({ proposed: "男", status: "可填" });
    expect(by(1)).toMatchObject({ proposed: "汉族", status: "可填" });
    expect(by(2)).toMatchObject({ proposed: "武汉", status: "可填" });
    expect(by(3)).toMatchObject({ proposed: "武汉站", status: "可填" });
    expect(by(4).status).toBe("由你填写");
    expect([5, 6, 7, 8].map((i) => by(i).proposed)).toEqual(["2021", "09", "2027", "06"]);
    expect(by(9)).toMatchObject({ status: "画像里没有", proposed: "" });
    expect(by(10)).toMatchObject({ proposed: "13800000000" });
    expect(by(13)).toMatchObject({ status: "由你填写", proposed: "" }); // a yes / no question is not the city
    expect([11, 12].map((i) => by(i).proposed)).toEqual(["2027", "06"]); // 毕业时间 as 年 / 月 is the end, not the start
  });
});

describe("profile gaps", () => {
  it("lists what forms asked for first, then the common fields, never an entry's own fields or sensitive ones", async () => {
    const { vault, db } = profileDb();
    upsertFact(db, { kind: "basic", data: { field: "性别", value: "男" } }, "本人确认");
    mkdirSync(join(vault, "runs", "apply"), { recursive: true });
    writeFileSync(join(vault, "runs", "apply", "a.json"), JSON.stringify({ form: [
      { section: "求职意向", label: "期望薪资", type: "text", status: "由你填写" }, { section: "", label: "开始时间", type: "text", status: "由你填写" },
      { section: "个人信息", label: "证件号码", type: "text", status: "画像里没有" }, { section: "个人信息", label: "性别", type: "dropdown", status: "画像里没有" },
    ] }));
    const gaps = profileGaps(db, vault).items;
    expect(gaps[0]).toMatchObject({ kind: "preference", field: "期望薪资", asked: 1 });
    const names = gaps.map((g) => g.field);
    expect(names).toContain("自我描述");
    expect(names).not.toContain("开始时间");
    expect(names).not.toContain("证件号码");
    expect(names).not.toContain("性别"); // the profile has it now
    expect(names).not.toContain("硕士阶段的教育经历"); // bachelor 2017-2021 then PhD 2021-2027: 直博, nothing missing
    const phd = listFacts(db).items.find((f) => f.kind === "education" && f.data.degree === "博士")!;
    upsertFact(db, { id: phd.id, kind: "education", data: { ...phd.data, period: "2023-2027" } }, "本人确认");
    expect(profileGaps(db, vault).items.map((g) => g.field)).toContain("硕士阶段的教育经历"); // a two-year gap: a master's is missing
  });
});
