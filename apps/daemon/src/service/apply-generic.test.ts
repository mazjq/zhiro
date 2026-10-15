import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openBrowser, closeBrowser, activePage, readForm } from "./apply.js";
import { choose } from "./apply-widgets.js";
import { platformOf } from "./platforms.js";

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].some(existsSync);

describe("platform of a link", () => {
  it("names the platform, and says when there is no form at all", () => {
    expect(platformOf("https://app.mokahr.com/campus-recruitment/x/1#/job/abc/apply")).toMatchObject({ id: "moka", level: "实测通过" });
    expect(platformOf("https://hzncc.zhiye.com/campus/jobs/1")).toMatchObject({ id: "beisen" });
    expect(platformOf("https://mp.weixin.qq.com/s/abc")).toMatchObject({ level: "不支持" });
    expect(platformOf("https://www.zhipin.com/job_detail/1")).toMatchObject({ level: "不支持" });
    expect(platformOf("https://career.mindray.com/apply")).toMatchObject({ id: "self", level: "通用填写" });
  });
});

/**
 * A self-built careers site on Element UI, the most common kit on them: the select's options live in a popper at the
 * end of <body>; the date editor takes a typed date + Enter; the cascader shows one column per level.
 */
const PAGE = `<!doctype html><meta charset="utf-8">
<form>
<div class="el-form-item is-required"><label class="el-form-item__label">性别</label><div class="el-form-item__content">
  <div class="el-select" id="sex"><div class="el-input"><input readonly placeholder="请选择" class="el-input__inner"></div></div></div></div>
<div class="el-form-item"><label class="el-form-item__label">出生年月</label><div class="el-form-item__content">
  <div class="el-date-editor el-input" id="birth"><input placeholder="选择月份" class="el-input__inner"></div></div></div>
<div class="el-form-item"><label class="el-form-item__label">籍贯</label><div class="el-form-item__content">
  <div class="el-cascader" id="home"><div class="el-input"><input readonly placeholder="请选择" class="el-input__inner"></div></div></div></div>
<div class="el-form-item"><label class="el-form-item__label">入学年月</label><div class="el-form-item__content"><input type="month" id="m"></div></div>
<div class="el-form-item"><label class="el-form-item__label">是否服从调剂</label><div class="el-form-item__content">
  <label><input type="radio" name="t" value="是">是</label><label><input type="radio" name="t" value="否">否</label></div></div>
</form>
<script>
const $ = (s) => document.querySelector(s);
function popper(items, onPick) { document.querySelector(".el-popper")?.remove(); const p = document.createElement("div"); p.className = "el-popper el-select-dropdown";
  p.style.cssText = "position:absolute;top:0;left:300px"; for (const t of items) { const li = document.createElement("li"); li.className = "el-select-dropdown__item"; li.innerHTML = "<span>" + t + "</span>"; li.onclick = () => { onPick(t); p.remove(); }; p.appendChild(li); } document.body.appendChild(p); }
$("#sex input").onclick = () => popper(["男", "女"], (t) => $("#sex input").value = t);
// the date editor: a typed value is taken on Enter, normalised to YYYY-MM
$("#birth input").onkeydown = (e) => { if (e.key === "Enter") { const m = e.target.value.match(/(\\d{4})-(\\d{2})/); e.target.value = m ? m[1] + "-" + m[2] : ""; } };
const tree = { 湖南省: { 岳阳市: ["岳阳楼区"] }, 湖北省: { 武汉市: ["洪山区"] } };
$("#home input").onclick = () => { document.querySelector(".el-cascader__dropdown")?.remove(); const d = document.createElement("div"); d.className = "el-cascader__dropdown"; d.style.cssText = "position:absolute;top:0;left:500px"; document.body.appendChild(d); const path = [];
  const col = (items, next) => { const c = document.createElement("ul"); c.className = "el-cascader-menu"; for (const t of items) { const li = document.createElement("li"); li.className = "el-cascader-node"; li.innerHTML = '<span class="el-cascader-node__label">' + t + "</span>"; li.onclick = () => next(t); c.appendChild(li); } d.appendChild(c); };
  col(Object.keys(tree), (p) => { path.push(p); col(Object.keys(tree[p]), (c) => { path.push(c); col(tree[p][c], (x) => { path.push(x); $("#home input").value = path.join(" / "); d.remove(); }); }); }); };
</script>`;

describe.skipIf(!CHROME)("generic driver on an Element UI site", () => {
  let page: any;
  const box = (label: string) => readForm().then((f) => f.fields.find((x) => x.label === label)).then((f) => page.locator(`[data-jobos-i="${f!.local}"]`));
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-generic-"));
    writeFileSync(join(dir, "g.html"), PAGE, "utf8");
    await openBrowser(dir, pathToFileURL(join(dir, "g.html")).href, { headless: true });
    page = await activePage();
    page.setDefaultTimeout(5000);
  });
  afterAll(() => closeBrowser());

  it("reads the Element form and sets its select, date editor, cascader and month input", async () => {
    const form = await readForm();
    expect(form.fields.map((f) => [f.label, f.type, f.required])).toEqual([["性别", "dropdown", true], ["出生年月", "date", false], ["籍贯", "cascader", false], ["入学年月", "month", false], ["是否服从调剂", "radio", false]]);
    expect(await choose(page, await box("性别"), "男")).toBe("");
    expect(await choose(page, await box("出生年月"), "2000.01")).toBe("");
    expect(await choose(page, await box("籍贯"), "湖南省岳阳市岳阳楼区")).toBe("");
    expect(await choose(page, await box("入学年月"), "2021.09")).toBe("");
    const values = await page.evaluate(() => Array.from(document.querySelectorAll("form input:not([type=radio])")).map((i) => (i as HTMLInputElement).value));
    expect(values).toEqual(["男", "2000-01", "湖南省 / 岳阳市 / 岳阳楼区", "2021-09"]);
  }, 60_000);
});
