import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { WorkflowEngine } from "./workflow.js";
import { ingest } from "../data/index.js";
import { upsertFact, listFacts } from "./profile.js";
import { closeBrowser, activePage, readForm } from "./apply.js";
import { planBlocks } from "./apply-blocks.js";
import { startRun, currentRun, stopRun, submittedNow } from "./apply-run.js";
import type { Services } from "../registry.js";

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].some(existsSync);

// Moka's shape: hashed CSS-module classes, a caption div per field, a block title per section
const FORM = `<!doctype html><meta charset="utf-8"><title>申请职位</title>
<div class="blockTitle-x1">基本信息</div>
<div class="apply-field-a1"><div class="title-b1">姓名<span class="required-asterisk-c1">*</span></div><input></div>
<div class="apply-field-a1"><div class="title-b1">邮箱</div><input value="old@example.com"></div>
<div class="apply-field-a1"><div class="title-b1">手机号码</div><input></div>
<div class="apply-field-a1"><div class="title-b1">政治面貌</div><input></div>
<div class="apply-field-a1"><div class="title-b1">身份证号</div><input></div>
<div class="apply-field-a1"><div class="title-b1">最高学历</div><select><option>请选择</option><option>本科</option><option>博士研究生</option></select></div>
<div class="blockTitle-x1">上传</div>
<div class="apply-field-a1"><div class="title-b1">上传简历</div><div class="upload-btn">上传简历<input type="file" style="display:none"></div></div>
<div class="apply-field-a1"><div class="title-b1">上传附件</div><div class="upload-btn">上传<input type="file" style="display:none"></div></div>
<button onclick="document.body.innerHTML='<h1>投递成功</h1><p>感谢你的申请</p>'">提交</button>`;

const until = async (ok: () => boolean, ms = 20_000) => { const t = Date.now(); while (!ok()) { if (Date.now() - t > ms) throw new Error(`timed out in state ${currentRun()?.state} / ${currentRun()?.reason}`); await new Promise((r) => setTimeout(r, 100)); } };

describe.skipIf(!CHROME)("开始网申 (ADR-024)", () => {
  afterAll(async () => { stopRun(); await closeBrowser(); });

  it("fills what it is sure of, overwrites nothing, uploads the chosen resume, never submits; then sees the submission and learns what the user added", async () => {
    const vault = mkdtempSync(join(tmpdir(), "jobos-run-"));
    const db = openDb(join(vault, "t.db"));
    const domain = new Domain(db);
    const s: Services = { domain, workflows: new WorkflowEngine(db), config: { vault, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [] }, sources: [] } };
    for (const [field, value] of [["姓名", "李示例"], ["邮箱", "li@example.com"], ["电话", "13800000000"]]) upsertFact(db, { kind: "basic", data: { field, value } }, "本人确认");
    upsertFact(db, { kind: "education", data: { school: "示例大学", degree: "博士", major: "控制科学与工程" } }, "本人确认");
    const pdf = join(vault, "cv.pdf"); writeFileSync(pdf, "%PDF-1.4 test");
    db.prepare("insert into resume(id, name, file_name, file_path, is_default, created_at) values ('r1', '通用版', 'cv.pdf', ?, 1, '2026-01-01')").run(pdf);
    ingest(domain, vault, "moka", "demo", [{ externalId: "1", url: "https://example.com/j", title: "控制算法工程师", company: "示例汽车", locations: ["武汉"], publisher: "示例汽车", grade: "官方", isOriginal: true, confidence: 1 } as any]);
    const positionId = (db.prepare("select id from position").get() as any).id;
    const app = domain.createApplication(positionId);
    const html = join(vault, "form.html"); writeFileSync(html, FORM, "utf8");

    await startRun(s, app.id, { tickMs: 100, headless: true, url: pathToFileURL(html).href });
    await until(() => currentRun()?.state === "待你提交");
    const page = await activePage();
    const values = await page.evaluate(() => ({ inputs: Array.from(document.querySelectorAll("input:not([type=file])")).map((i) => (i as HTMLInputElement).value), degree: (document.querySelector("select") as HTMLSelectElement).selectedOptions[0].text, files: Array.from(document.querySelectorAll("input[type=file]")).map((i) => (i as HTMLInputElement).files?.length ?? 0) }));
    expect(values).toEqual({ inputs: ["李示例", "old@example.com", "13800000000", "", ""], degree: "博士研究生", files: [1, 0] });
    const run = currentRun()!;
    expect(run.filled).toBe(3);
    expect(run.resume).toBe("通用版");
    expect(run.attention).toEqual([expect.objectContaining({ label: "邮箱", kind: "和画像不同" })]);

    // the user completes the form and submits
    await page.locator("input").nth(3).fill("中共党员");
    await page.locator("input").nth(4).fill("420100200001010000");
    await new Promise((r) => setTimeout(r, 500));
    await page.locator("button").click();
    await until(() => currentRun()?.state === "已投递");
    expect(domain.getApplication(app.id)).toMatchObject({ state: "submitted", resumeLabel: "通用版" });
    expect(currentRun()!.learned).toEqual(["政治面貌"]);
    const basics = listFacts(db).items.filter((f) => f.kind === "basic").map((f) => `${f.data.field}=${f.data.value}`);
    expect(basics).toContain("政治面貌=中共党员");
    expect(basics.join()).not.toContain("4201");
  }, 60_000);
});

// Moka's repeated blocks: apply-block-* > blockTitle-* (with 添加) + one apply-fields-* per entry; 添加 appends an empty entry
const ENTRY = (school = "") => `<div class="apply-fields-1 multi-1">
  <div class="apply-field-a"><div class="title-b">学校名称</div><input value="${school}"></div>
  <div class="apply-field-a"><div class="title-b">专业名称</div><input></div>
  <div class="apply-field-a"><div class="title-b">学历</div><select><option>请选择</option><option>本科</option><option>博士</option></select></div>
  <div class="apply-field-a"><div class="title-b">就读时间</div><input placeholder="年"><input placeholder="月"><input placeholder="年"><input placeholder="月"></div></div>`;
const BLOCKS = `<!doctype html><meta charset="utf-8"><title>申请职位</title>
<div class="blockTitle-x1">个人信息</div>
${["姓名", "邮箱", "手机号码", "政治面貌", "民族"].map((l) => `<div class="apply-field-a"><div class="title-b">${l}</div><input></div>`).join("")}
<div class="apply-block-1" id="edu"><div class="blockTitle-1">教育背景 <span class="add"><span>添加</span></span></div>${ENTRY("示例学院")}</div>
<div class="apply-block-1" id="intern"><div class="blockTitle-1">实习经历 <span class="add"><span>添加</span></span></div><div class="apply-fields-1 multi-1">
  <div class="apply-field-a"><div class="title-b">公司名称</div><input></div><div class="apply-field-a"><div class="title-b">职位名称</div><input></div>
  <div class="apply-field-a"><div class="title-b">起止时间</div><input placeholder="年"><input placeholder="月"><input placeholder="年"><input placeholder="月"></div>
  <div class="apply-field-a"><div class="title-b">工作职责</div><textarea></textarea></div></div></div>
<script>
document.querySelector("#edu .add").onclick = () => { const d = document.createElement("div"); d.innerHTML = ${JSON.stringify(ENTRY())}; document.querySelector("#edu").appendChild(d.firstElementChild); };
document.querySelector("#intern .add").onclick = () => { throw new Error("nothing to add here"); };
</script>`;

describe.skipIf(!CHROME)("多段经历 (milestone c)", () => {
  afterAll(async () => { stopRun(); await closeBrowser(); });

  it("leaves the entry the site already filled, adds exactly one entry for the missing record, fills it, and adds nothing on the next pass", async () => {
    const vault = mkdtempSync(join(tmpdir(), "jobos-blocks-"));
    const db = openDb(join(vault, "t.db"));
    const domain = new Domain(db);
    const s: Services = { domain, workflows: new WorkflowEngine(db), config: { vault, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [] }, sources: [] } };
    upsertFact(db, { kind: "basic", data: { field: "姓名", value: "李示例" } }, "本人确认");
    upsertFact(db, { kind: "education", data: { school: "示例大学", degree: "博士", major: "控制科学与工程", period: "2021.09—2027.06" } }, "本人确认");
    upsertFact(db, { kind: "education", data: { school: "示例学院", degree: "本科", major: "自动化", period: "2017.09—2021.06" } }, "本人确认");
    upsertFact(db, { kind: "experience", data: { org: "示例科技", role: "算法实习生", period: "2024.07-2024.09", summary: "控制算法实习" } }, "本人确认");
    upsertFact(db, { kind: "experience", data: { org: "工程研究中心", role: "助管", period: "2021.9-2023.6" } }, "本人确认"); // not an internship
    ingest(domain, vault, "moka", "demo", [{ externalId: "1", url: "https://example.com/j", title: "控制算法工程师", company: "示例汽车", locations: [], publisher: "示例汽车", grade: "官方", isOriginal: true, confidence: 1 } as any]);
    const app = domain.createApplication((db.prepare("select id from position").get() as any).id);
    const html = join(vault, "form.html"); writeFileSync(html, BLOCKS, "utf8");

    await startRun(s, app.id, { tickMs: 100, headless: true, url: pathToFileURL(html).href });
    await until(() => currentRun()?.state === "待你提交", 30_000);
    const page = await activePage();
    const entries = await page.evaluate(() => Array.from(document.querySelectorAll("#edu .apply-fields-1")).map((e) => Array.from(e.querySelectorAll("input, select")).map((i) => (i as HTMLInputElement).value || "").join("|")));
    expect(entries).toEqual(["示例学院||请选择||||", "示例大学|控制科学与工程|博士|2021|09|2027|06"]);
    const intern = await page.evaluate(() => Array.from(document.querySelectorAll("#intern input, #intern textarea")).map((i) => (i as HTMLInputElement).value));
    expect(intern).toEqual(["示例科技", "算法实习生", "2024", "07", "2024", "09", "控制算法实习"]);
    const form = await readForm();
    expect(planBlocks(db, form.fields)).toEqual([]); // nothing left: a second pass adds nothing
    stopRun();
  }, 60_000);
});

// N1: the page after submitting has a few labelled inputs (a job filter) and a success message: that is success, not a next step
const LANDED = `<!doctype html><meta charset="utf-8"><title>申请职位</title>
<div class="blockTitle-x1">个人信息</div>
${["姓名", "邮箱", "手机号码", "政治面貌", "民族"].map((l) => `<div class="apply-field-a"><div class="title-b">${l}</div><input></div>`).join("")}
<button onclick="document.body.innerHTML = '<h1>投递成功</h1>' + ['关键词', '城市', '职位类别'].map((l) => '<div class=apply-field-a><div class=title-b>' + l + '</div><input></div>').join('')">提交</button>`;

describe.skipIf(!CHROME)("提交之后 (N1)", () => {
  afterAll(async () => { stopRun(); await closeBrowser(); });
  it("a success page that also has a few inputs is recognised as success", async () => {
    const vault = mkdtempSync(join(tmpdir(), "jobos-landed-"));
    const db = openDb(join(vault, "t.db"));
    const domain = new Domain(db);
    const s: Services = { domain, workflows: new WorkflowEngine(db), config: { vault, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [] }, sources: [] } };
    upsertFact(db, { kind: "basic", data: { field: "姓名", value: "李示例" } }, "本人确认");
    ingest(domain, vault, "moka", "demo", [{ externalId: "1", url: "https://example.com/j", title: "工程师", company: "示例", locations: [], publisher: "示例", grade: "官方", isOriginal: true, confidence: 1 } as any]);
    const app = domain.createApplication((db.prepare("select id from position").get() as any).id);
    const html = join(vault, "form.html"); writeFileSync(html, LANDED, "utf8");
    await startRun(s, app.id, { tickMs: 100, headless: true, url: pathToFileURL(html).href });
    await until(() => currentRun()?.state === "待你提交");
    await (await activePage()).locator("button").click();
    await until(() => currentRun()?.state === "已投递");
    expect(domain.getApplication(app.id).state).toBe("submitted");
  }, 60_000);
});

describe("提交之后 (N7): success beside a form that is still there", () => {
  const f = (label: string, disabled = false) => ({ label, disabled });
  const known = new Set(["姓名", "邮箱", "手机号码", "最高学历"]);
  const form = [f("姓名"), f("邮箱"), f("手机号码"), f("最高学历")];
  it("a success dialog over the form counts, a success hint that was there all along does not", () => {
    expect(submittedNow("投递成功 感谢你的申请 姓名 邮箱", "姓名 邮箱 手机号码", form, known)).toBe(true);
    expect(submittedNow("提交成功后请等待通知 姓名 邮箱", "提交成功后请等待通知 姓名 邮箱", form, known)).toBe(false);
    expect(submittedNow("姓名 邮箱 手机号码", "姓名 邮箱", form, known)).toBe(false);
  });
  it("a success page that only echoes read-only fields counts; the form gone with a success message counts", () => {
    expect(submittedNow("提交成功，请等待通知", "姓名 邮箱", [f("姓名", true), f("邮箱", true), f("手机号码", true)], known)).toBe(true);
    expect(submittedNow("投递成功", "", [f("搜索")], known)).toBe(true);
  });
});

describe("提交之前 (N14/N16): prompts that mention success are not success", () => {
  const f = (label: string, disabled = false) => ({ label, disabled });
  const known = new Set(["姓名", "邮箱", "手机号码", "最高学历"]);
  const form = [f("姓名"), f("邮箱"), f("手机号码"), f("最高学历")];
  it("a confirm dialog over the form, or a read-only check page, is not submitted", () => {
    expect(submittedNow("确定要提交吗？提交成功后将无法修改 取消 确定 姓名 邮箱 手机号码", "姓名 邮箱", form, known)).toBe(false);
    expect(submittedNow("请核对信息，提交成功后不可修改 确认提交", "姓名", [f("姓名", true), f("邮箱", true), f("手机号码", true)], known)).toBe(false);
  });
  it("a form-borne hint 「提交成功后…」 never counts, so the real dialog after it still does", () => {
    const hint = "提交成功后请留意邮件 姓名 邮箱 手机号码";
    expect(submittedNow(hint, hint, form, known)).toBe(false);
    expect(submittedNow("投递成功！感谢你的申请 " + hint, hint, form, known)).toBe(true);
  });
});

describe("提交之前/之后 (N18): only what appeared since the hand-over decides", () => {
  const f = (label: string, disabled = false) => ({ label, disabled });
  const known = new Set(["姓名", "邮箱", "手机号码", "最高学历"]);
  const form = [f("姓名"), f("邮箱"), f("手机号码"), f("最高学历")];
  it("a form that always said 「提交成功后不可修改」 still gets its real success dialog recognised", () => {
    const atFill = "请仔细填写，提交成功后不可修改\n姓名\n邮箱\n手机号码";
    expect(submittedNow(atFill, atFill, form, known)).toBe(false);
    expect(submittedNow("投递成功！\n" + atFill, atFill, form, known)).toBe(true);
    expect(submittedNow("确定要提交吗？\n" + atFill, atFill, form, known)).toBe(false);
  });
  it("a success sentence that asks to 核对 is still a success", () => {
    expect(submittedNow("投递成功，请核对您的信息\n姓名\n邮箱\n手机号码", "姓名\n邮箱\n手机号码", form, known)).toBe(true);
  });
});

describe("提交之后 (N20/N22): whole-line comparison and what is new since the last look", () => {
  const f = (label: string, disabled = false) => ({ label, disabled });
  const known = new Set(["姓名", "邮箱", "手机号码", "最高学历"]);
  const form = [f("姓名"), f("邮箱"), f("手机号码"), f("最高学历")];
  const hint = "请仔细填写，提交成功后不可修改\n姓名\n邮箱\n手机号码";
  it("N20: a bare 「提交成功」 line is new even though it is a substring of the hint", () => {
    expect(submittedNow("提交成功\n我知道了\n" + hint, hint, form, known)).toBe(true);
  });
  it("N22: a success dialog stacked over the confirm dialog counts, judged by what appeared since the last look", () => {
    const confirming = "确定要提交吗？\n取消\n确定\n" + hint;
    expect(submittedNow(confirming, hint, form, known, hint)).toBe(false);
    expect(submittedNow("投递成功\n" + confirming, hint, form, known, confirming)).toBe(true);
  });
});

describe("提交之后 (N23): a line the form had at hand-over is never news, even after it scrolled away and back", () => {
  const f = (label: string) => ({ label });
  const known = new Set(["姓名", "邮箱", "手机号码", "最高学历"]);
  const form = [f("姓名"), f("邮箱"), f("手机号码"), f("最高学历")];
  const atFill = "感谢您申请示例汽车\n姓名\n邮箱\n手机号码";
  it("welcome banner gone then back: still 待你提交; a real success dialog still counts", () => {
    const without = "姓名\n邮箱\n手机号码";
    expect(submittedNow(atFill, atFill, form, known, without)).toBe(false);
    expect(submittedNow("投递成功\n" + atFill, atFill, form, known, atFill)).toBe(true);
  });
});

describe("提交之后 (N27–N29): a welcome header is not success on any page; more check-page wordings", () => {
  const f = (label: string) => ({ label });
  const known = new Set(["姓名", "邮箱", "手机号码", "最高学历"]);
  const form = [f("姓名"), f("邮箱"), f("手机号码"), f("最高学历")];
  it("N27: the header 「感谢您申请…」 that follows the user to a thin page or a check page is not a submission", () => {
    const atFill = "感谢您申请示例汽车\n姓名\n邮箱\n手机号码";
    expect(submittedNow("感谢您申请示例汽车\n兴趣爱好\n特长", atFill, [f("兴趣爱好"), f("特长")], known, atFill)).toBe(false);
    expect(submittedNow("投递成功\n感谢您申请示例汽车", atFill, [], known, atFill)).toBe(true);
  });
  it("N28: a welcome line rendered after the hand-over is still not success; real thanks are", () => {
    const atFill = "姓名\n邮箱\n手机号码";
    expect(submittedNow("感谢您申请示例汽车\n" + atFill, atFill, form, known, atFill)).toBe(false);
    expect(submittedNow("感谢您的投递\n" + atFill, atFill, form, known, atFill)).toBe(true);
  });
});
