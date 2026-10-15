import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openBrowser, closeBrowser, activePage, readForm, mapFields } from "./apply.js";
import { openDb } from "../db.js";
const profile = () => openDb(join(mkdtempSync(join(tmpdir(), "jobos-w-")), "t.db"));
import { choose } from "./apply-widgets.js";

const CHROME = ["C:/Program Files/Google/Chrome/Application/chrome.exe", "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].some(existsSync);

/**
 * Stand-ins for the real components, built from the structure recorded by apply-assistant-local and ApplyKit on live
 * forms: Moka's sd-* dropdown renders its menu inside its own container and shows the choice in display-value; picking
 * a year sets an empty month to 1; the school box asks the server as you type; 北森's list and month panel are portals.
 */
const PAGE = `<!doctype html><meta charset="utf-8"><style>.hide{display:none}</style>
<div class="apply-field-a select_info"><div class="title-b">性别</div>
  <div class="sd-Dropdown-container-1" id="sex"><label class="sd-Select-container-1"><span class="sd-Input-display-value-1">请选择</span><input readonly placeholder="请选择"></label></div></div>
<div class="apply-field-a"><div class="title-b">就读时间</div><div class="month-range-select">
  <div class="sd-Dropdown-container-1 ym" data-kind="year"><label class="sd-Select-container-1"><span class="sd-Input-display-value-1">年</span><input readonly placeholder="年"></label></div>
  <div class="sd-Dropdown-container-1 ym" data-kind="month"><label class="sd-Select-container-1"><span class="sd-Input-display-value-1">月</span><input readonly placeholder="月"></label></div></div></div>
<div class="apply-field-a string_info"><div class="title-b">学校名称</div>
  <div class="sd-Dropdown-container-1" id="school"><label class="sd-Select-container-1"><span class="sd-Input-display-value-1"></span><input placeholder="请输入就读学校"></label></div></div>
<div class="apply-field-a string_info"><div class="title-b">专业名称</div>
  <div class="sd-Dropdown-container-1" id="major"><label class="sd-Select-container-1"><span class="sd-Input-display-value-1"></span><input placeholder="请输入专业名称"></label></div></div>
<div class="apply-field-a string_info"><div class="title-b">籍贯</div>
  <div class="sd-Dropdown-container-1" id="home"><label class="sd-Select-container-1"><span class="sd-Input-display-value-1"></span><input placeholder="请输入籍贯"></label></div></div>
<div class="apply-field-a string_info"><div class="title-b">所在地</div>
  <div class="sd-Dropdown-container-1" id="live"><label class="sd-Select-container-1"><span class="sd-Input-display-value-1"></span><input placeholder="请输入所在地"></label></div></div>
<div class="apply-field-a location_info"><div class="title-b">户口所在地</div>
  <div class="sd-Dropdown-container-1" id="hukou"><label class="sd-Input-container-1 sd-Input-readonly-1"><input readonly placeholder="请输入户口所在地"></label><span></span></div></div>
<div class="apply-field-a day_info"><div class="title-b">出生日期</div>
  <div class="sd-Dropdown-container-1" id="birth"><input readonly placeholder="出生日期"></div></div>
<div class="form-item"><div class="form-item__title"><span class="form-item__text">学历</span></div>
  <div class="form-item__control"><div class="phoenix-select" id="deg"><input placeholder="请选择"><span class="phoenix-select__tipEle"></span></div></div></div>
<div class="form-item"><div class="form-item__title"><span class="form-item__text">开始时间</span></div>
  <div class="form-item__control"><div class="phoenix-select" id="start"><input placeholder="请选择"><span class="phoenix-select__tipEle"></span></div></div></div>
<script>
const $ = (s, r = document) => r.querySelector(s);
function menu(box, items, onPick) {
  box.querySelector("[class^='sd-Select-menu']")?.remove(); // a click on a <label> also clicks its input: open once
  const m = document.createElement("div"); m.className = "sd-Select-menu-1";
  for (const t of items) { const it = document.createElement("div"); it.className = "sd-Menu-content-item-1"; it.innerHTML = '<span class="option-label-1">' + t + "</span>"; it.onclick = (e) => { e.stopPropagation(); onPick(t); m.remove(); }; m.appendChild(it); }
  box.appendChild(m);
}
const show = (box, t) => box.querySelector("[class*=display-value]").textContent = t;
$("#sex label").onclick = () => menu($("#sex"), ["男", "女"], (t) => show($("#sex"), t));
const [yb, mb] = document.querySelectorAll(".ym");
const years = []; for (let y = 2126; y >= 1926; y--) years.push(String(y));
yb.querySelector("label").onclick = () => menu(yb, years, (t) => { show(yb, t); if (mb.textContent.trim() === "月") show(mb, "1"); }); // Moka's quirk
mb.querySelector("label").onclick = () => menu(mb, Array.from({ length: 12 }, (_, i) => String(i + 1)), (t) => show(mb, t));
const schools = ["中国地质大学(武汉)", "中国地质大学(北京)", "武汉大学"]; // the real list writes half-width parentheses
$("#school input").oninput = (e) => setTimeout(() => menu($("#school"), schools.filter((s) => s.normalize("NFKC").includes(e.target.value.normalize("NFKC"))).concat(["没有找到学校？添加学校全称"]), (t) => { show($("#school"), t); e.target.value = ""; }), 300);
// suggestions in a portal at the end of <body>, not inside the control
$("#major input").oninput = (e) => setTimeout(() => { document.querySelector(".portal")?.remove(); const p = document.createElement("div"); p.className = "portal sd-Select-menu-9";
  for (const t of ["控制科学与工程", "控制工程"].filter((s) => s.startsWith(e.target.value))) { const it = document.createElement("div"); it.className = "sd-list-item-1"; it.innerHTML = '<div class="sd-Menu-common-item-1">' + t + "</div>"; it.onclick = () => { show($("#major"), t); p.remove(); }; p.appendChild(it); }
  document.body.appendChild(p); }, 200);
// the site indexes places by city name only
const cities = { 岳阳: "湖南-岳阳", 长沙: "湖南-长沙" };
$("#home input").oninput = (e) => setTimeout(() => menu($("#home"), cities[e.target.value] ? [cities[e.target.value]] : [], (t) => show($("#home"), t)), 150);
// a pop-up with class names no selector knows, positioned absolutely at the end of <body>; indexed by city only
$("#live input").oninput = (e) => setTimeout(() => { document.querySelector(".location-pop")?.remove(); if (e.target.value !== "武汉") return;
  const p = document.createElement("div"); p.className = "location-pop"; p.style.cssText = "position:absolute;top:10px;left:10px;background:#fff";
  p.innerHTML = "<ul><li>湖北省 / 武汉市</li></ul>"; p.querySelector("li").onclick = () => { show($("#live"), "湖北省 / 武汉市"); p.remove(); }; document.body.appendChild(p); }, 150);
const tree = { 湖南: { 岳阳市: ["岳阳楼区", "君山区"], 长沙市: ["岳麓区"] }, 湖北: { 武汉市: ["洪山区"] } };
$("#hukou input").onclick = () => { const host = $("#hukou > span"); host.innerHTML = ""; const path = [];
  const col = (items, next) => { const c = document.createElement("ul"); c.className = "col"; for (const t of items) { const li = document.createElement("li"); li.textContent = t; li.onclick = () => next(t); c.appendChild(li); } host.appendChild(c); };
  col(Object.keys(tree), (p) => { path.push(p); col(Object.keys(tree[p]), (c) => { path.push(c); col(tree[p][c], (d) => { path.push(d); $("#hukou input").value = path.join(" "); host.innerHTML = ""; }); }); }); };
$("#birth input").onclick = () => {
  const box = $("#birth"); box.querySelector(".cal")?.remove();
  const cal = document.createElement("div"); cal.className = "cal";
  let decade = 2020;
  const head = document.createElement("div"); head.className = "sd-basic-selector-year-1"; head.textContent = "2026年"; cal.appendChild(head);
  const body = document.createElement("div"); cal.appendChild(body);
  const years = () => { body.innerHTML = '<i class="icondoubleLeft">«</i><i class="icondoubleRight">»</i>'; body.children[0].onclick = () => { decade -= 10; years(); }; body.children[1].onclick = () => { decade += 10; years(); };
    for (let y = decade; y < decade + 10; y++) { const w = document.createElement("div"); w.className = "sd-basic-year-wrapper"; w.innerHTML = '<span class="sd-basic-year-item">' + y + "</span>"; w.firstChild.onclick = () => months(y); body.appendChild(w); } };
  const months = (y) => { body.innerHTML = ""; Array.from({ length: 12 }, (_, i) => (i + 1) + "月").forEach((t, i) => { const s = document.createElement("span"); s.className = "sd-basic-month-item"; s.textContent = t; s.onclick = () => { $("#birth input").value = y + "-" + String(i + 1).padStart(2, "0"); cal.remove(); }; body.appendChild(s); }); };
  head.onclick = years; box.appendChild(cal);
};
function layer(html) { document.querySelector(".common-unmodeled-layer")?.remove(); const l = document.createElement("div"); l.className = "common-unmodeled-layer"; l.innerHTML = html; document.body.appendChild(l); return l; }
$("#deg").onclick = () => { const l = layer('<div class="phoenix-selectList">' + ["本科", "硕士", "博士"].map((t) => '<div class="phoenix-selectList__listItem">' + t + "</div>").join("") + "</div>");
  l.querySelectorAll(".phoenix-selectList__listItem").forEach((it) => it.onclick = () => { $("#deg .phoenix-select__tipEle").textContent = it.textContent; l.remove(); }); };
$("#start").onclick = () => { let dec = 2020; let year = 0;
  const l = layer('<div class="phoenix-date-picker__wrap"><div class="phoenix-calendar-month-panel"><span class="phoenix-calendar-month-panel-year-select">2026</span><div class="body"></div></div></div>');
  const body = l.querySelector(".body");
  const monthsView = () => { body.innerHTML = ""; for (let m = 1; m <= 12; m++) { const c = document.createElement("span"); c.className = "phoenix-calendar-month-panel-month"; c.textContent = m + "月"; c.onclick = () => { $("#start .phoenix-select__tipEle").textContent = year + "-" + String(m).padStart(2, "0"); l.remove(); }; body.appendChild(c); } };
  const yearsView = () => { body.innerHTML = '<span class="phoenix-calendar-year-panel-prev-decade-btn">«</span><span class="phoenix-calendar-year-panel-next-decade-btn">»</span>';
    body.children[0].onclick = () => { dec -= 10; yearsView(); }; body.children[1].onclick = () => { dec += 10; yearsView(); };
    for (let y = dec; y < dec + 10; y++) { const c = document.createElement("span"); c.className = "phoenix-calendar-year-panel-year"; c.textContent = y; c.onclick = () => { year = y; monthsView(); }; body.appendChild(c); } };
  l.querySelector(".phoenix-calendar-month-panel-year-select").onclick = yearsView; };
</script>`;

describe.skipIf(!CHROME)("widget drivers (Moka sd-*, 北森 phoenix-*)", () => {
  let page: any;
  const box = (label: string, nth = 0) => readForm().then((f) => f.fields.filter((x) => x.label === label)[nth]).then((f) => page.locator(`[data-jobos-i="${f!.local}"]`));
  beforeAll(async () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-widgets-"));
    writeFileSync(join(dir, "w.html"), PAGE, "utf8");
    await openBrowser(dir, pathToFileURL(join(dir, "w.html")).href, { headless: true });
    page = await activePage();
    page.setDefaultTimeout(5000); // as in a run
  });
  afterAll(() => closeBrowser());

  it("reads what custom controls display, and sets them by picking the matching option", async () => {
    const form = await readForm();
    expect(form.fields.map((f) => [f.label, f.type])).toEqual([["性别", "dropdown"], ["就读时间", "dropdown"], ["就读时间", "dropdown"], ["学校名称", "dropdown"], ["专业名称", "dropdown"], ["籍贯", "dropdown"], ["所在地", "dropdown"], ["户口所在地", "dropdown"], ["出生日期", "dropdown"], ["学历", "dropdown"], ["开始时间", "dropdown"]]);
    expect(form.fields.every((f) => f.value === "")).toBe(true); // 请选择 / 年 / 月 are placeholders, not values

    expect(await choose(page, await box("性别"), "男")).toBe("");
    // year first; Moka then sets the empty month to 1, which the month driver overwrites
    expect(await choose(page, await box("就读时间", 0), "2021")).toBe("");
    expect(await choose(page, await box("就读时间", 1), "09", { monthBox: true })).toBe("");
    expect(await choose(page, await box("学校名称"), "中国地质大学（武汉）")).toBe("");
    expect(await choose(page, await box("专业名称"), "控制科学与工程")).toBe(""); // suggestions outside the control
    expect(await choose(page, await box("籍贯"), "湖南省岳阳市")).toBe(""); // found as 岳阳 after the full name gave nothing
    expect(await choose(page, await box("所在地"), "湖北省武汉市")).toBe(""); // found in an unknown pop-up, as 武汉
    expect(await choose(page, await box("户口所在地"), "湖南省岳阳市")).toMatch(/要选到区\/县/); // one level short: says so, does not hang
    await page.keyboard.press("Escape");
    expect(await choose(page, await box("户口所在地"), "湖南省岳阳市岳阳楼区")).toBe("");
    expect(await choose(page, await box("出生日期"), "2000.01")).toBe("");
    expect(await choose(page, await box("学历"), "博士")).toBe("");
    expect(await choose(page, await box("开始时间"), "2021-09")).toBe("");

    const shown = await page.evaluate(() => [
      ...Array.from(document.querySelectorAll("[class*=display-value]")).map((e) => e.textContent), (document.querySelector("#birth input") as HTMLInputElement).value,
      ...Array.from(document.querySelectorAll(".phoenix-select__tipEle")).map((e) => e.textContent)]);
    expect(shown).toEqual(["男", "2021", "9", "中国地质大学(武汉)", "控制科学与工程", "湖南-岳阳", "湖北省 / 武汉市", "2000-01", "博士", "2021-09"]);
    expect((await readForm()).fields.map((f) => f.value)).toEqual(["男", "2021", "9", "中国地质大学(武汉)", "控制科学与工程", "湖南-岳阳", "湖北省 / 武汉市", "湖南 岳阳市 岳阳楼区", "2000-01", "博士", "2021-09"]);
  }, 60_000);

  it("never picks among several near matches, and says when an option does not exist", async () => {
    await page.reload();
    expect(await choose(page, await box("学校名称"), "中国地质大学")).toMatch(/2 个相近/);
    // a field the site has locked (account-level, or taken from the parsed resume) is never one to fill
    expect((await mapFields(profile(), undefined, [{ index: 0, local: 0, frame: "", section: "个人信息", label: "最高学历", type: "dropdown", required: true, options: [], value: "博士", placeholder: "", name: "", disabled: true }]))[0].status).toBe("不代填");
    await page.reload();
    expect(await choose(page, await box("学历"), "大专")).toMatch(/没有「大专」/);
  }, 30_000);
});
