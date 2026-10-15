import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openBrowser, closeBrowser, activePage, readForm } from "./apply.js";
import { choose } from "./apply-widgets.js";
import { slotsOf } from "./apply-blocks.js";

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].some(existsSync);

/**
 * Replicas built from structure recorded on live forms. Sources: ApplyKit https://github.com/DeepestWind/ApplyKit
 * (MIT, 4f3cb1a); 大易's public vendor css at wecruit.hotjob.cn; public 问卷星 forms such as https://v.wjx.cn/vm/Q0r0xpd.aspx.
 * They prove the drivers' logic against that structure, not that every tenant's page looks like this.
 * 飞书招聘 — ApplyKit (MIT, 4f3cb1a) src/content/adapters/feishu.ts: .atsx-form-item / -label / -required, sections
 *   .createFormSection-title + .createFormSection-formList > .resumeEditForm-item, dropdown .atsx-select-dropdown with
 *   [role=option], area tree .atsx-tree [data-cy-value] with .atsx-select-search__field, year-month period panel
 *   .atsx-date-picker-period-month-panel-list-item, add button .createFormSection-addBtn.
 * 大易 (hotjob new) — antd 3 per its public vendor css: .ant-select-dropdown-menu-item in a body portal, .ant-calendar-picker.
 * 问卷星 — public forms fetched and read: div.field.ui-field-contain[req], .field-label .topichtml, hidden radio +
 *   a.jqradio + div.label[for], verify="省市区" read-only boxes.
 */
const FEISHU = `<!doctype html><meta charset="utf-8"><div class="resumeEditForm-wrapper">
<div class="createFormSection"><div class="createFormSection-title">基本信息</div><div class="createFormSection-formList"><div class="resumeEditForm-item">
  <div class="atsx-form-item"><div class="atsx-form-item-label"><span class="atsx-form-item-required">*</span>姓名</div><input id="name"></div>
  <div class="atsx-form-item"><div class="atsx-form-item-label">性别</div><div class="atsx-select" id="sex"><input readonly placeholder="请选择"><span class="v"></span></div></div>
  <div class="atsx-form-item"><div class="atsx-form-item-label">现居城市</div><div class="atsx-select" id="city"><input readonly placeholder="请选择"><span class="v"></span></div></div>
</div></div></div>
<div class="createFormSection"><div class="createFormSection-title">教育经历</div><button class="createFormSection-addBtn">添加</button><div class="createFormSection-formList" id="edu"></div></div>
</div>
<script>
const $ = (s, r = document) => r.querySelector(s);
function drop(html, after) { document.querySelector(".atsx-select-dropdown")?.remove(); const d = document.createElement("div"); d.className = "atsx-select-dropdown"; d.style.cssText = "position:absolute;top:0;left:400px"; d.innerHTML = html; document.body.appendChild(d); after(d); }
$("#sex").onclick = () => drop('<div role="option">男</div><div role="option">女</div>', (d) => d.querySelectorAll("[role=option]").forEach((o) => o.onclick = () => { $("#sex .v").textContent = o.textContent; $("#sex input").value = o.textContent; d.remove(); }));
$("#city").onclick = () => drop('<input class="atsx-select-search__field"><div class="atsx-tree"></div>', (d) => { const s = d.querySelector("input"); s.oninput = () => { d.querySelector(".atsx-tree").innerHTML = s.value === "武汉" ? '<span data-cy-value="420100">武汉市</span>' : ""; d.querySelectorAll("[data-cy-value]").forEach((n) => n.onclick = () => { $("#city input").value = n.textContent; d.remove(); }); }; });
function eduEntry() { const i = document.querySelectorAll("#edu .resumeEditForm-item").length; const e = document.createElement("div"); e.className = "resumeEditForm-item";
  e.innerHTML = '<div class="atsx-form-item"><div class="atsx-form-item-label">学校</div><input id="education[' + i + '].school"></div>'
    + '<div class="atsx-form-item"><div class="atsx-form-item-label">就读时间</div><div class="atsx-date-picker atsx-date-picker-period-month"><input readonly placeholder="开始时间"></div></div>';
  e.querySelector(".atsx-date-picker").onclick = function () { const box = this; document.querySelector(".pp")?.remove(); const p = document.createElement("div"); p.className = "pp"; p.style.cssText = "position:absolute;top:0;left:600px"; document.body.appendChild(p);
    const list = (items, next) => { p.innerHTML = ""; for (const t of items) { const li = document.createElement("div"); li.className = "atsx-date-picker-period-month-panel-list-item"; li.setAttribute("data-cy", t); li.textContent = t; li.onclick = () => next(t); p.appendChild(li); } };
    list(["2027", "2021", "2017"], (y) => list(["1", "6", "9", "12"], (m) => { box.querySelector("input").value = y + "-" + m.padStart(2, "0"); p.remove(); })); };
  $("#edu").appendChild(e); }
eduEntry();
$(".createFormSection-addBtn").onclick = eduEntry;
</script>`;

const DAYEE = `<!doctype html><meta charset="utf-8"><form class="ant-form">
<div class="ant-form-item"><div class="ant-form-item-label"><label class="ant-form-item-required">学历</label></div><div class="ant-form-item-control">
  <div class="ant-select" id="deg"><div class="ant-select-selection"><input readonly placeholder="请选择"></div></div></div></div>
<div class="ant-form-item"><div class="ant-form-item-label"><label>入学时间</label></div><div class="ant-form-item-control">
  <span class="ant-calendar-picker" id="d"><input placeholder="请选择日期"></span></div></div>
</form>
<script>
const $ = (s) => document.querySelector(s);
$("#deg input").onclick = () => { const d = document.createElement("div"); d.className = "ant-select-dropdown"; d.style.cssText = "position:absolute;top:0;left:400px";
  d.innerHTML = '<ul><li class="ant-select-dropdown-menu-item">本科</li><li class="ant-select-dropdown-menu-item">硕士研究生</li><li class="ant-select-dropdown-menu-item">博士研究生</li><li class="ant-select-dropdown-menu-item ant-select-dropdown-menu-item-disabled">博士后</li></ul>';
  d.querySelectorAll("li").forEach((li) => li.onclick = () => { $("#deg input").value = li.textContent; d.classList.add("ant-select-dropdown-hidden"); }); document.body.appendChild(d); };
// antd 3: a typed date is committed on blur
$("#d input").onblur = (e) => { const m = e.target.value.match(/^(\\d{4})-(\\d{2})/); e.target.value = m ? m[1] + "-" + m[2] + "-01" : ""; };
</script>`;

const WJX = `<!doctype html><meta charset="utf-8"><div id="divQuestion">
<div class="field ui-field-contain" topic="1" id="div1" req="1" type="1"><div class="field-label"><span class="topicnumber">1.</span><div class="topichtml">姓名</div><span class="req">*</span></div><input id="q1" type="text"></div>
<div class="field ui-field-contain" topic="2" id="div2" req="1" type="3"><div class="field-label"><span class="topicnumber">2.</span><div class="topichtml">性别</div><span class="req">*</span></div>
  <div class="ui-controlgroup"><div class="ui-radio"><span class="jqradiowrapper"><input type="radio" id="q2_1" name="q2" value="1" style="display:none"><a class="jqradio" href="javascript:;"></a></span><div class="label" for="q2_1">男</div></div>
  <div class="ui-radio"><span class="jqradiowrapper"><input type="radio" id="q2_2" name="q2" value="2" style="display:none"><a class="jqradio" href="javascript:;"></a></span><div class="label" for="q2_2">女</div></div></div></div>
<div class="field ui-field-contain" topic="3" id="div3" req="0" type="1"><div class="field-label"><span class="topicnumber">3.</span><div class="topichtml">籍贯</div></div><input id="q3" readonly verify="省市区" onclick="void 0"></div>
<a id="ctlNext">提交</a></div>
<script>document.querySelectorAll(".ui-radio .label").forEach((l) => l.onclick = () => { document.getElementById(l.getAttribute("for")).checked = true; });</script>`;

async function open(html: string) {
  const dir = mkdtempSync(join(tmpdir(), "jobos-plat-"));
  writeFileSync(join(dir, "p.html"), html, "utf8");
  await openBrowser(dir, pathToFileURL(join(dir, "p.html")).href, { headless: true });
  const page = await activePage();
  await page.goto(pathToFileURL(join(dir, "p.html")).href);
  page.setDefaultTimeout(5000);
  return page;
}
const at = (page: any, f: { local: number }) => page.locator(`[data-jobos-i="${f.local}"]`);

describe.skipIf(!CHROME)("platform replicas", () => {
  afterAll(() => closeBrowser());

  it("飞书招聘: captions, required, sections and entries; atsx select, area tree, year-month panel", async () => {
    const page = await open(FEISHU);
    const form = await readForm();
    expect(form.fields.map((f) => [f.section, f.label, f.required])).toEqual([["基本信息", "姓名", true], ["基本信息", "性别", false], ["基本信息", "现居城市", false], ["教育经历", "学校", false], ["教育经历", "就读时间", false]]);
    expect(slotsOf(form.fields).map((s) => [s.section, s.entry])).toEqual([["教育经历", 0]]);
    const by = (l: string) => at(page, form.fields.find((f) => f.label === l)!);
    expect(await choose(page, by("性别"), "男")).toBe("");
    expect(await choose(page, by("现居城市"), "湖北省武汉市")).toBe("");
    expect(await choose(page, by("就读时间"), "2021-09")).toBe("");
    expect(await page.evaluate(() => Array.from(document.querySelectorAll("input:not(.atsx-select-search__field)")).map((i) => (i as HTMLInputElement).value))).toEqual(["", "男", "武汉市", "", "2021-09"]);
  }, 60_000);

  it("大易 (antd 3): portal options with a disabled one, typed date committed on blur", async () => {
    const page = await open(DAYEE);
    const form = await readForm();
    expect(form.fields.map((f) => [f.label, f.type, f.required])).toEqual([["学历", "dropdown", true], ["入学时间", "date", false]]);
    expect(await choose(page, at(page, form.fields[0]), "博士")).toMatch(/^$/); // 博士研究生 is the one reachable match; 博士后 is disabled
    expect(await choose(page, at(page, form.fields[1]), "2021.09")).toBe("");
    expect(await page.evaluate(() => Array.from(document.querySelectorAll("input")).map((i) => i.value))).toEqual(["博士研究生", "2021-09-01"]);
  }, 60_000);

  it("问卷星: question text without its number, required from req, radio by its div.label, read-only popups left to the user", async () => {
    const page = await open(WJX);
    const form = await readForm();
    expect(form.fields.map((f) => [f.label, f.type, f.required, f.options])).toEqual([["姓名", "text", true, []], ["性别", "radio", true, ["男", "女"]], ["籍贯", "dropdown", false, []]]);
    expect(await choose(page, at(page, form.fields[2]), "湖南省岳阳市")).toMatch(/问卷星/);
    // the radio goes through the run's own writer; here: clicking the named option checks the hidden input
    await page.locator("#div2 [for]", { hasText: "女" }).first().click();
    expect(await page.evaluate(() => (document.getElementById("q2_2") as HTMLInputElement).checked)).toBe(true);
  }, 60_000);
});
