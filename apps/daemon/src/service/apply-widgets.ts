import type { Locator, Page } from "playwright-core";

/**
 * Drivers for the controls a text box can't be typed into (ADR-024, milestone b). Each one: open the control, find the
 * option whose text matches, click it with a real mouse event, then read back what the control now shows.
 *
 * Structure facts come from two MIT-licensed projects that validated them on live forms — apply-assistant-local
 * (zhourunnan1210, v0.4.0 8961a78: extension/content/adapters/moka.js, docs/moka-adapter.md, docs/beisen_real_form_01.md)
 * and ApplyKit (DeepestWind, main 4f3cb1a: src/content/adapters/{moka,beisen}.ts, src/content/controls/*). No code is
 * taken from them; they drive the DOM with synthetic events, we use Playwright's real input.
 *
 * Moka (sd-* components): options render inside the control's own sd-Dropdown-container (not a portal); the committed
 * value is the text of [class*=display-value]; picking a 年 fills the empty 月 with 1, so the month is set right after;
 * a 年/月 box cannot be cleared. 北森 (phoenix-*): lists, calendars and the province picker are portals under
 * .common-unmodeled-layer; exactly one should be visible at a time.
 * Every driver returns "" when the value took, otherwise a short reason for the report. Nothing is ever submitted.
 */

const MONTHS = ["一月", "二月", "三月", "四月", "五月", "六月", "七月", "八月", "九月", "十月", "十一月", "十二月"];

/**
 * Other names an option for this value may carry. English tests above all: a profile says CET-6, a form offers 「大学英语六级」
 * / 「英语六级」 / 「六级」 (seen on Moka, 2026-10-14).
 */
export function optionAliases(value: string): string[] {
  const v = value.trim();
  const cet = v.match(/^(?:cet|大学英语)\s*[-－]?\s*([46四六])\s*级?$/i) ?? v.match(/^(?:英语)?([46四六])级$/);
  if (cet) { const n = /[4四]/.test(cet[1]) ? "四" : "六", d = n === "四" ? "4" : "6"; return [v, `大学英语${n}级`, `英语${n}级`, `${n}级`, `CET-${d}`, `CET${d}`, `CET ${d}`]; }
  if (/^(tem|专业英语)\s*[-－]?\s*([48四八])/i.test(v)) { const n = /[4四]/.test(v.replace(/^\D*/, "")) ? "四" : "八"; return [v, `专业英语${n}级`, `英语专业${n}级`, `TEM-${n === "四" ? 4 : 8}`]; }
  return [v];
}

/** The texts an option for this value may carry: "9" / "09" / "9月" / "09月" for a month, the value and its aliases otherwise. */
function variants(value: string, monthBox: boolean): string[] {
  const v = value.trim();
  if (monthBox && /^\d{1,2}$/.test(v)) { const n = String(Number(v)); return [n, n.padStart(2, "0"), `${n}月`, `${n.padStart(2, "0")}月`]; }
  return optionAliases(v);
}

/**
 * Click the one visible option in `scope` whose own text matches: exactly first, else the single option that
 * contains the value or is contained in it ("博士" ↔ "博士研究生"). Several candidates → nothing is clicked.
 * Runs in the page to find the leaf element, marks it, and clicks it with a real mouse event.
 */
/** the text of the option the last successful pick clicked: what the control should now show */
let lastPicked = "";

async function pick(page: Page, scope: Locator, sel: string, want: string[], fuzzy = true): Promise<string | null> {
  // tsx (the daemon runtime) wraps inner functions in __name(...), which the page does not have — same shim as readForm
  await scope.evaluate(() => { (globalThis as any).__name ??= (f: unknown) => f; });
  const found = await scope.evaluate((root, [sel, want, fuzzy]) => {
    document.querySelectorAll("[data-jobos-pick]").forEach((e) => e.removeAttribute("data-jobos-pick"));
    const vis = (e: Element) => { const r = (e as HTMLElement).getBoundingClientRect(); return r.width > 0 && r.height > 0 && getComputedStyle(e).visibility !== "hidden"; };
    // compared width- and space-insensitively: a site writes 中国地质大学(武汉) where the profile has （武汉）
    const own = (e: Element) => ((e.querySelector("[class*='option-label']") ?? e).textContent ?? "").normalize("NFKC").replace(/\s+/g, "");
    // a greyed-out item (Moka's calendar shows the next decade's first year, faded, at the end of a page: clicking it does
    // not select it — 2026-10-14) is marked on its wrapper, not on the item itself
    const off = (e: Element) => { for (let n: Element | null = e; n && n !== root; n = n.parentElement) if (/disabled|fade/.test(n.className?.toString() ?? "")) return true; return false; };
    const all = Array.from(root.querySelectorAll(sel as string)).filter((e) => vis(e) && !off(e) && !/没有找到|添加.*全称/.test(e.textContent ?? "") && !e.closest("#jobos-banner"));
    // the deepest matching element is the one that reacts to a click
    const opts = all.filter((e) => !all.some((o) => o !== e && e.contains(o)));
    const w = (want as string[]).map((v) => v.normalize("NFKC").replace(/\s+/g, ""));
    let hit = opts.filter((e) => w.includes(own(e)));
    if (!hit.length && fuzzy) hit = opts.filter((e) => w.some((v) => own(e).includes(v) || (own(e).length >= 2 && v.includes(own(e)))));
    if (hit.length !== 1) return hit.length ? `有 ${hit.length} 个相近的选项，没有替你选` : null;
    hit[0].setAttribute("data-jobos-pick", own(hit[0]));
    return "";
  }, [sel, want, fuzzy] as const);
  if (found === "") { const it = page.locator("[data-jobos-pick]").first(); lastPicked = (await it.getAttribute("data-jobos-pick")) ?? ""; await press(it); }
  return found;
}

/**
 * A real click first. If something covers the element (a menu that did not close, a sticky header) or it is off in a
 * scrolled list, fall back to the events the page listens for — the way both reference projects drive these controls.
 */
async function press(loc: Locator): Promise<void> {
  try { await loc.click({ timeout: 2000 }); }
  catch { for (const type of ["mousedown", "mouseup", "click"]) await loc.dispatchEvent(type, { bubbles: true }); }
}

const waitFor = async (fn: () => Promise<boolean>, ms = 5000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn().catch(() => false)) return true; await new Promise((r) => setTimeout(r, 120)); } return false; };
const norm = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").replace(/月$/, "").replace(/^0(\d)$/, "$1");

/** Which component family a field belongs to, from the DOM around it. */
export async function familyOf(el: Locator): Promise<"moka" | "moka-date" | "moka-area" | "beisen" | "feishu" | "wjx" | "generic"> {
  return el.evaluate((e) => {
    if (e.closest(".atsx-select, .atsx-date-picker, [class*='atsx-date-picker'], .atsx-cascader")) return "feishu";
    if (e.closest("div.field.ui-field-contain") && e.getAttribute("verify")) return "wjx";
    if (e.closest("[class*='location_info']")) return "moka-area";
    if (e.closest("[class*='day_info']") || (e.closest("[class*='Dropdown-container']") && e.closest("[class*='date_info']") && !e.closest("[class*='month-range']"))) return "moka-date";
    if (e.closest("[class*='Dropdown-container']") || e.closest("[class*='Select-container']")) return "moka";
    if (e.closest(".phoenix-select, [class*='phoenix-select'], .phoenix-auto-complete-container")) return "beisen";
    return "generic";
  });
}

/** Set a dropdown / date / area control to `value`. `monthBox` = this is the 月 box of a 年/月 pair. */
export async function choose(page: Page, el: Locator, value: string, opts: { monthBox?: boolean } = {}): Promise<string> {
  const family = await familyOf(el);
  if (family === "moka") return moka(page, el, value, !!opts.monthBox);
  if (family === "moka-date") return mokaDate(page, el, value);
  if (family === "moka-area") return mokaArea(page, el, value);
  if (family === "beisen") return beisen(page, el, value, !!opts.monthBox);
  if (family === "feishu") return feishu(page, el, value, !!opts.monthBox);
  if (family === "wjx") return "问卷星的日期 / 地区 / 学校弹层还不会自动操作，请在页面上选";
  return generic(page, el, value, !!opts.monthBox);
}

/** What to type into a place search: the whole "湖南省岳阳市", then 岳阳市 / 岳阳, then 湖南省 / 湖南 — sites index places differently. */
export function searchTerms(value: string): string[] {
  const parts = value.split(/(?<=省|自治区|市|自治州|盟|区|县)|[\s/、,，-]+/).map((p) => p.trim()).filter(Boolean); // 杭州 / 广州 end in 州 but are one name
  const bare = (p: string) => p.replace(/(省|市|自治区|区|县)$/, "");
  const out = [value, ...[...parts].reverse().flatMap((p) => [p, bare(p)])];
  return [...new Set(out.filter((x) => x.length >= 2))];
}

/**
 * Suggestions that render in a pop-up the known selectors do not cover (a cascader panel, a portal with other class
 * names): any visible, short, leaf element inside an absolutely / fixed positioned layer outside the form fields.
 * With mark = true the single best one is marked for a click; otherwise only whether any exists is answered.
 * (Written out in the page function itself: sites with a strict CSP forbid building functions from strings.)
 */
async function overlayFind(page: Page, want: string[], mark: boolean): Promise<string | null> {
  await page.evaluate(() => { (globalThis as any).__name ??= (f: unknown) => f; });
  return page.evaluate(([want, mark]) => {
    document.querySelectorAll("[data-jobos-pick]").forEach((e) => e.removeAttribute("data-jobos-pick"));
    const old: WeakSet<Element> | undefined = (window as any).__jobosOld;
    const hits = Array.from(document.body.querySelectorAll("li, span, div, a, p, td")).filter((e) => {
      if (e.children.length || e.closest("#jobos-banner, input, [class*='display-value'], header, nav, footer")) return false;
      if (old?.has(e)) return false; // it was on the page before we typed: page chrome, not a suggestion
      const link = e.closest("a[href]"); if (link && !/^(javascript:|#)/.test(link.getAttribute("href") ?? "")) return false; // a link navigates away
      const r = (e as HTMLElement).getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0) || getComputedStyle(e).visibility === "hidden") return false;
      const t = (e.textContent ?? "").trim();
      if (t.length < 2 || t.length > 40 || !(want as string[]).some((w) => t.includes(w) || w.includes(t))) return false;
      for (let n: Element | null = e; n && n !== document.body; n = n.parentElement) { const p = getComputedStyle(n).position; if (p === "absolute" || p === "fixed") return true; }
      return false;
    });
    if (!mark) return hits.length ? "" : null;
    const exact = hits.filter((e) => (want as string[]).includes((e.textContent ?? "").trim()));
    const one = exact.length === 1 ? exact[0] : hits.length === 1 ? hits[0] : null;
    if (!one) return hits.length ? `有 ${hits.length} 个相近的选项，没有替你选` : null;
    one.setAttribute("data-jobos-pick", (one.textContent ?? "").trim());
    return "";
  }, [want, mark] as const);
}
const overlayHas = async (page: Page, term: string) => (await overlayFind(page, [term], false)) === "";
async function overlayPick(page: Page, want: string[]): Promise<string | null> {
  const found = await overlayFind(page, want, true);
  if (found === "") { const it = page.locator("[data-jobos-pick]").first(); lastPicked = (await it.getAttribute("data-jobos-pick")) ?? ""; await press(it); }
  return found;
}

// ---------- Moka

const MOKA_OPTION = "[class*='option-label'], span[data-key='sugar.select.label'], [class*='Menu-content-item'], [class*='-item-']";
/** When a menu is mounted outside its control (remote-search suggestions on some forms): only what sits inside a menu or list. */
const MOKA_MENU = "[class*='Select-menu'] [class*='-item-'], [class*='Select-menu'] [class*='option-label'], [class*='Select-menu'] span[data-key='sugar.select.label'], [class*='list-item'], [class*='Menu-content-item']";

async function moka(page: Page, el: Locator, value: string, monthBox: boolean): Promise<string> {
  const box = el.locator("xpath=ancestor::*[contains(@class,'Dropdown-container')][1]");
  const scope = (await box.count()) ? box : el.locator("xpath=ancestor::*[contains(@class,'Select-container')][1]/..");
  const body = page.locator("body");
  const shown = async () => ((await scope.locator("[class*='display-value']").first().textContent({ timeout: 300 }).catch(() => "")) ?? "").trim();
  const want = variants(value, monthBox);
  const opened = async () => (await scope.locator(MOKA_OPTION).count()) > 0 || (await body.locator(MOKA_MENU).evaluateAll((els) => els.some((e) => (e as HTMLElement).getBoundingClientRect().height > 0)));
  const where = async () => ((await scope.locator(MOKA_OPTION).count()) > 0 ? { root: scope, sel: MOKA_OPTION } : { root: body, sel: MOKA_MENU });
  const done = async () => (await waitFor(async () => { const s = norm(await shown()), v = norm(value); return want.map(norm).includes(s) || (!monthBox && (s.includes(v) || (s.length >= 2 && v.includes(s)))) || (!!lastPicked && s.includes(norm(lastPicked))); }, 2000)) ? "" : "选了但页面没有显示";
  const close = () => page.keyboard.press("Escape").catch(() => {});

  const container = scope.locator("[class*='Select-container']").first();
  await press((await container.count()) ? container : el);
  // remote search (学校 / 专业 / 籍贯): the box is a filter and suggestions come from the server as you type — real
  // keystrokes into whatever the control focused. Places are indexed differently per site, so shorter names are tried too.
  const search = !(await el.getAttribute("readonly")) && /请输入/.test((await el.getAttribute("placeholder")) ?? "");
  if (search) {
    // one field never holds the run for long (籍贯 once kept the user waiting): the first name gets 4 s, shorter ones 2 s
    const until = Date.now() + 15_000;
    await page.evaluate(() => { (window as any).__jobosOld = new WeakSet(document.querySelectorAll("*")); }); // what was there before typing
    for (const [i, term] of searchTerms(value).entries()) {
      if (Date.now() > until) break;
      await el.fill("").catch(() => {});
      await el.pressSequentially(term, { delay: 40 }).catch(async () => { await page.keyboard.type(term, { delay: 40 }); });
      if (!(await waitFor(async () => (await opened()) || (await overlayHas(page, term)), i === 0 ? 4000 : 2000))) continue;
      await page.waitForTimeout(300); // the list keeps changing for a moment after the first rows arrive
      let r: string | null = null;
      if (await opened()) { const { root, sel } = await where(); r = await pick(page, root, sel, [value, term]); }
      if (r === null) r = await overlayPick(page, [value, term]);
      if (r === "") return done();
      if (r) { await close(); return r; }
    }
    await close();
    return "网站的候选里没有这一项";
  }
  if (!(await waitFor(opened, 2500))) { await close(); return "选项没有弹出来"; }
  // long lists (years: 201 of them) may be virtualised: typing narrows them when the box accepts input
  let { root, sel } = await where();
  let r = await pick(page, root, sel, want, !monthBox && !/^\d{4}$/.test(value));
  if (r === null && (await el.isEditable().catch(() => false))) { await el.pressSequentially(value, { delay: 40 }).catch(() => {}); await page.waitForTimeout(400); ({ root, sel } = await where()); r = await pick(page, root, sel, want, false); }
  if (r === null) { await close(); return `没有「${value}」这个选项`; }
  if (r) { await close(); return r; }
  return done();
}

/** "湖南省岳阳市" → the levels a cascade shows: 湖南省 / 岳阳市. Compared without the 省 / 市 / 区 suffix: Moka shows 湖南, 岳阳市. */
export function areaLevels(value: string): string[] {
  return value.split(/(?<=省|自治区|特别行政区|市|自治州|盟|地区|区|县|旗)|[\s/、,，-]+/).map((p) => p.trim()).filter(Boolean);
}
const bareArea = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区|地区|区|县|旗|自治州|盟)$/, "");

/**
 * 籍贯 / 所在地 on Moka (location_info): a read-only box opening columns 省 → 市 → 区县. Pick each level the profile
 * knows, by name without suffix. If the site wants a level the profile does not have (区县), stop and say so — the
 * user once waited minutes while the run looked at a city column it did not understand.
 */
async function mokaArea(page: Page, el: Locator, value: string): Promise<string> {
  const box = el.locator("xpath=ancestor::*[contains(@class,'Dropdown-container')][1]");
  const levels = areaLevels(value);
  if (!levels.length) return "地址认不出";
  const shown = async () => ((await el.inputValue().catch(() => "")) || ((await box.locator("[class*='display-value']").first().textContent({ timeout: 300 }).catch(() => "")) ?? "")).trim();
  await press(el);
  for (const [i, level] of levels.entries()) {
    const want = bareArea(level);
    // options of every open column; the wanted one is the leaf whose own text, without suffix, is the level
    const found = await waitFor(async () => (await box.locator("li, div, span").evaluateAll((els, w) => els.some((e) => !e.children.length && (e as HTMLElement).getBoundingClientRect().height > 0 && (e.textContent ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区|地区|区|县|旗|自治州|盟)$/, "") === w), want)), i === 0 ? 3000 : 2000);
    if (!found) { await page.keyboard.press("Escape").catch(() => {}); return i === 0 ? "地区选择框没有弹出来" : `选了「${levels.slice(0, i).join(" ")}」之后没有出现「${level}」`; }
    await box.locator("li, div, span").evaluateAll((els, w) => {
      document.querySelectorAll("[data-jobos-pick]").forEach((e) => e.removeAttribute("data-jobos-pick"));
      const hit = els.filter((e) => !e.children.length && (e as HTMLElement).getBoundingClientRect().height > 0 && (e.textContent ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区|地区|区|县|旗|自治州|盟)$/, "") === w);
      hit[hit.length - 1]?.setAttribute("data-jobos-pick", "1"); // the newest column is the last one
    }, want);
    await press(page.locator("[data-jobos-pick]").first());
    await page.waitForTimeout(400);
  }
  // done if the box now shows the last level; if a further column opened (区县) the profile does not go that deep
  if (await waitFor(async () => bareArea(await shown()).includes(bareArea(levels[levels.length - 1])) || (await shown()).includes(levels[levels.length - 1]), 1500)) return "";
  await page.keyboard.press("Escape").catch(() => {});
  return `这里要选到区/县，画像里只写到「${levels.join("")}」；把画像里这一项写到区县（如 湖南省岳阳市岳阳楼区）就能自动选`;
}

/** 出生日期 (年龄) — a year/month calendar: open, switch to the decade view, page to the year, pick year, pick month. */
async function mokaDate(page: Page, el: Locator, value: string): Promise<string> {
  const m = value.match(/(\d{4})\D{0,2}(\d{1,2})?/);
  if (!m) return "日期格式认不出";
  const year = m[1], n = m[2] ? Number(m[2]) : 0;
  if (!n) return "画像里只有年份，缺月份";
  const box = el.locator("xpath=ancestor::*[contains(@class,'Dropdown-container')][1]");
  await press(el);
  // a calendar of days (年月日): the profile knows the month, not the day — that is the person's to pick
  if (!/\d{4}\D{1,2}\d{1,2}\D{1,2}\d{1,2}/.test(value) && (await waitFor(async () => (await box.locator("[class*='sd-basic-date-item']").count()) > 0, 1200))) {
    await page.keyboard.press("Escape").catch(() => {});
    return `这里要选到具体哪一天，画像里只到 ${year}-${String(n).padStart(2, "0")}`;
  }
  const head = box.locator("[class*='sd-basic-selector-year']").first();
  if (!(await waitFor(() => head.isVisible()))) return "日历没有弹出来";
  await press(head);
  for (let i = 0; i < 15; i++) {
    const r = await pick(page, box, "[class*='sd-basic-year-item']", [year], false);
    if (r === "") break;
    const years = (await box.locator("[class*='sd-basic-year-item']").allTextContents()).map(Number).filter(Boolean);
    if (!years.length || i === 14) { await page.keyboard.press("Escape").catch(() => {}); return "日历里翻不到这一年"; }
    await press(box.locator(`[class*='${Number(year) < Math.min(...years) ? "icondoubleLeft" : "icondoubleRight"}']`).first());
  }
  // the month view's items are named differently across versions; any visible leaf whose text is this month will do
  await page.waitForTimeout(200);
  const months = [MONTHS[n - 1], `${n}月`, `${String(n).padStart(2, "0")}月`, String(n), String(n).padStart(2, "0")];
  const r = await pick(page, box, "[class*='month'], [class*='-item'], td, span, div", months, false);
  if (r !== "") { await page.keyboard.press("Escape").catch(() => {}); return r || "日历里没选上月份"; }
  const shown = (await el.inputValue().catch(() => "")) || ((await box.locator("[class*='display-value']").first().textContent({ timeout: 300 }).catch(() => "")) ?? "");
  return (await waitFor(async () => shown.includes(year) || ((await el.inputValue().catch(() => "")) ?? "").includes(year), 1500)) ? "" : "选了但页面没有显示";
}

// ---------- 北森 (phoenix)

const LAYER = ".common-unmodeled-layer";

async function beisen(page: Page, el: Locator, value: string, monthBox: boolean): Promise<string> {
  const ctl = el.locator("xpath=ancestor-or-self::*[contains(@class,'phoenix-select') or contains(@class,'phoenix-auto-complete-container')][1]");
  const shown = async () => ((await ctl.locator(".phoenix-select__tipEle, [class*='singleLabel']").first().textContent({ timeout: 300 }).catch(() => "")) ?? (await el.inputValue().catch(() => ""))).trim();
  await ctl.click({ timeout: 3000 });
  const layer = page.locator(`${LAYER}:visible`).last();
  if (!(await waitFor(async () => (await layer.count()) > 0, 3000))) {
    // an auto-complete (学校) has no layer until you type
    if (await el.isEditable().catch(() => false)) {
      await el.pressSequentially(value, { delay: 60 });
      const r = await pick(page, page.locator("body"), "[class*='auto-complete'][class*='item']", [value]);
      return r === "" ? "" : r ?? "网站的候选里没有这一项";
    }
    return "选项没有弹出来";
  }
  // what opened decides how to choose
  if (await layer.locator(".area-selector-container").count()) return beisenArea(page, layer, value);
  if (await layer.locator(".phoenix-date-picker__wrap, [class*='phoenix-calendar']").count()) return beisenDate(page, layer, value);
  const r = await pick(page, layer, ".phoenix-selectList__listItem", variants(value, monthBox), !monthBox);
  if (r !== "") { await page.keyboard.press("Escape").catch(() => {}); return r ?? `没有「${value}」这个选项`; }
  return (await waitFor(async () => (await shown()).includes(value) || variants(value, monthBox).map(norm).includes(norm(await shown())), 2000)) ? "" : "选了但页面没有显示";
}

async function beisenDate(page: Page, layer: Locator, value: string): Promise<string> {
  const m = value.match(/(\d{4})\D{0,2}(\d{1,2})?(?:\D{0,2}(\d{1,2}))?/);
  if (!m?.[2]) { await page.keyboard.press("Escape").catch(() => {}); return "画像里缺月份"; }
  const [year, month, day] = [m[1], `${Number(m[2])}月`, m[3]];
  const full = await layer.locator(".phoenix-calendar-date-panel").count();
  if (full && !day) { await page.keyboard.press("Escape").catch(() => {}); return "这里要具体到日，画像里只有年月"; }
  await layer.locator(full ? ".phoenix-calendar-year-select" : ".phoenix-calendar-month-panel-year-select").first().click();
  for (let i = 0; i < 15; i++) {
    if ((await pick(page, layer, ".phoenix-calendar-year-panel-year, .phoenix-calendar-year-panel-cell", [year], false)) === "") break;
    const years = (await layer.locator(".phoenix-calendar-year-panel-year, .phoenix-calendar-year-panel-cell").allTextContents()).map((t) => Number(t.trim())).filter(Boolean);
    if (!years.length || i === 14) { await page.keyboard.press("Escape").catch(() => {}); return "日历里翻不到这一年"; }
    await layer.locator(Number(year) < Math.min(...years) ? "[class*='prev-decade-btn']" : "[class*='next-decade-btn']").first().click({ timeout: 3000 });
  }
  if (full) await layer.locator(".phoenix-calendar-month-select").first().click().catch(() => {});
  if ((await pick(page, layer, ".phoenix-calendar-month-panel-month, [class*='month-panel-cell']", [month], false)) !== "") { await page.keyboard.press("Escape").catch(() => {}); return "日历里没选上月份"; }
  if (full) {
    const d = String(Number(day));
    const cell = layer.locator(".phoenix-calendar-tbody .phoenix-calendar-date").filter({ hasText: new RegExp(`^\\s*${d}\\s*$`) });
    const inMonth = cell.filter({ hasNot: page.locator("[class*='last-month'], [class*='next-month']") });
    if (!(await inMonth.count())) return "日历里没选上日期";
    await inMonth.first().click();
  }
  return "";
}

/** 籍贯 / 现居住地: search the last-level name, tick the one result that matches, confirm. */
async function beisenArea(page: Page, layer: Locator, value: string): Promise<string> {
  const levels = areaLevels(value);
  const last = bareArea(levels[levels.length - 1] ?? value);
  await layer.locator("input[placeholder='搜索']").first().pressSequentially(last, { delay: 60 });
  const items = page.locator(`${LAYER} .area-item-container`).filter({ has: page.locator(".area-text-label", { hasText: last }) });
  if (!(await waitFor(async () => (await items.count()) > 0, 4000))) { await page.keyboard.press("Escape").catch(() => {}); return "地区里搜不到"; }
  if ((await items.count()) > 1) {
    const exact = items.filter({ has: page.locator(".area-item-path", { hasText: bareArea(levels[0] ?? "") }) });
    if ((await exact.count()) !== 1) { await page.keyboard.press("Escape").catch(() => {}); return "同名地区不止一个，没有替你选"; }
    await exact.locator(".icon-container").first().click();
  } else await items.first().locator(".icon-container").first().click();
  await layer.locator(".phoenix-button__content").filter({ hasText: /^\s*确定\s*$/ }).first().click(); // not 「确定投递」 elsewhere
  return "";
}

// ---------- everything else: Ant Design, Element UI, ARIA listboxes

async function generic(page: Page, el: Locator, value: string, monthBox: boolean): Promise<string> {
  const kind = await el.evaluate((e) => {
    const t = (e.getAttribute("type") ?? "").toLowerCase();
    if (t === "date" || t === "month") return "native-" + t;
    if (e.closest(".ant-picker, .ant-calendar-picker, .el-date-editor, .ivu-date-picker, .arco-picker, [class*='date-picker'], [class*='DatePicker']")) return "date";
    if (e.closest(".el-cascader, .ant-cascader, .ivu-cascader, .arco-cascader, [class*='cascader']")) return "cascader";
    return "list";
  });
  if (kind.startsWith("native-")) return nativeDate(el, value, kind === "native-month");
  if (kind === "date") return typedDate(page, el, value);
  if (kind === "cascader") return genericCascade(page, el, value);
  await press(el);
  const popup = ".ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-dropdown-menu-item:not(.ant-select-dropdown-menu-item-disabled), .ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option, .el-select-dropdown__item, [role='option'], [role='menuitem'], .ivu-select-item, .arco-select-option, .van-picker-column__item";
  const anyVisible = () => page.locator(popup).evaluateAll((els) => els.some((e) => (e as HTMLElement).getBoundingClientRect().height > 0));
  if (!(await waitFor(anyVisible, 2500))) {
    if (await el.isEditable().catch(() => false)) { await el.pressSequentially(value, { delay: 60 }); await page.waitForTimeout(600); }
    else return "选项没有弹出来";
  }
  const r = await pick(page, page.locator("body"), popup, variants(value, monthBox), !monthBox);
  if (r !== "") { await page.keyboard.press("Escape").catch(() => {}); return r ?? `没有「${value}」这个选项`; }
  return "";
}

/** "2000.01" / "2021.09—2027.06" → the first date in it, as YYYY-MM or YYYY-MM-DD; null when there is no year. */
function isoOf(value: string): { y: string; m: string; d: string } | null {
  const m = value.match(/(\d{4})\D{0,2}(\d{1,2})?(?:\D{0,2}(\d{1,2}))?/);
  return m ? { y: m[1], m: m[2] ? m[2].padStart(2, "0") : "", d: m[3] ? m[3].padStart(2, "0") : "" } : null;
}

/** <input type="date|month">: the browser takes an ISO string. A full date needs a day the profile may not have. */
async function nativeDate(el: Locator, value: string, month: boolean): Promise<string> {
  const d = isoOf(value);
  if (!d?.m) return "画像里缺月份";
  if (!month && !d.d) return "这里要具体到日，画像里只有年月";
  const iso = month ? `${d.y}-${d.m}` : `${d.y}-${d.m}-${d.d}`;
  await el.fill(iso);
  return (await el.inputValue()) === iso ? "" : "填了但页面没有接受";
}

/**
 * Element / Ant Design / iView date pickers accept a typed date in their input (committed on blur), which is far sturdier than
 * clicking through panels whose markup differs per version. Tried as YYYY-MM, then YYYY-MM-DD when the day is known.
 */
async function typedDate(page: Page, el: Locator, value: string): Promise<string> {
  const d = isoOf(value);
  if (!d?.m) return "画像里缺月份";
  for (const text of [`${d.y}-${d.m}`, ...(d.d ? [`${d.y}-${d.m}-${d.d}`] : [])]) {
    await press(el);
    await el.fill("").catch(() => {});
    await el.pressSequentially(text, { delay: 30 }).catch(() => {});
    // never Enter: in a <form> it is an implicit submit. A blur commits typed dates in antd 3 / Element / iView
    await page.keyboard.press("Tab").catch(() => {});
    await page.waitForTimeout(250);
    const now = ((await el.inputValue().catch(() => "")) ?? "").replace(/\D/g, "");
    if (now.startsWith(`${d.y}${d.m}`)) { await page.keyboard.press("Escape").catch(() => {}); return ""; }
  }
  await page.keyboard.press("Escape").catch(() => {});
  return "日期选择器没有接受输入的日期";
}

/** Element / Ant Design cascaders (省 → 市 → 区): one column per level, names compared without the 省/市/区 suffix. */
async function genericCascade(page: Page, el: Locator, value: string): Promise<string> {
  const levels = areaLevels(value);
  if (!levels.length) return "认不出层级";
  await press(el);
  const nodes = ".el-cascader-node, .ant-cascader-menu-item, .ivu-cascader-menu-item, .arco-cascader-option";
  for (const [i, level] of levels.entries()) {
    const want = bareArea(level);
    const ok = await waitFor(async () => (await page.locator(nodes).evaluateAll((els, w) => els.some((e) => (e as HTMLElement).getBoundingClientRect().height > 0 && (e.textContent ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区|地区|区|县|旗|自治州|盟)$/, "") === w), want)), i === 0 ? 3000 : 2000);
    if (!ok) { await page.keyboard.press("Escape").catch(() => {}); return i === 0 ? "级联选择框没有弹出来" : `选了「${levels.slice(0, i).join(" ")}」之后没有出现「${level}」`; }
    await page.locator(nodes).evaluateAll((els, w) => {
      document.querySelectorAll("[data-jobos-pick]").forEach((e) => e.removeAttribute("data-jobos-pick"));
      const hit = els.filter((e) => (e as HTMLElement).getBoundingClientRect().height > 0 && (e.textContent ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/(省|市|自治区|壮族自治区|回族自治区|维吾尔自治区|特别行政区|地区|区|县|旗|自治州|盟)$/, "") === w);
      hit[hit.length - 1]?.setAttribute("data-jobos-pick", "1");
    }, want);
    await press(page.locator("[data-jobos-pick]").first());
    await page.waitForTimeout(300);
  }
  const shown = ((await el.inputValue().catch(() => "")) || ((await el.locator("xpath=ancestor::*[contains(@class,'cascader')][1]").first().textContent({ timeout: 300 }).catch(() => "")) ?? "")).normalize("NFKC");
  if (bareArea(shown).includes(bareArea(levels[levels.length - 1])) || shown.includes(levels[levels.length - 1])) return "";
  await page.keyboard.press("Escape").catch(() => {});
  return `这里要选到下一级，画像里只写到「${levels.join("")}」`;
}

// ---------- 飞书招聘 (atsx-* components; structure recorded on a live form by ApplyKit, MIT, 4f3cb1a: src/content/adapters/feishu.ts)

const FS_DROP = ".atsx-select-dropdown";
const visibleIn = (page: Page, sel: string) => page.locator(sel).evaluateAll((els) => els.some((e) => (e as HTMLElement).getBoundingClientRect().height > 0));

async function feishu(page: Page, el: Locator, value: string, monthBox: boolean): Promise<string> {
  const kind = await el.evaluate((e) => (e.closest("[class*='atsx-date-picker-period-month']") ? "period" : e.closest("[class*='atsx-date-picker']") ? ((e.getAttribute("placeholder") ?? "") === "YYYY" ? "year" : "period") : "select"));
  const ctl = el.locator("xpath=ancestor-or-self::*[contains(@class,'atsx-select') or contains(@class,'atsx-date-picker') or contains(@class,'atsx-cascader')][1]");
  await press((await ctl.count()) ? ctl : el);
  const close = () => page.keyboard.press("Escape").catch(() => {});
  if (kind === "select") {
    if (!(await waitFor(() => visibleIn(page, FS_DROP), 2500))) { await close(); return "选项没有弹出来"; }
    // an area tree (现居城市 / 籍贯): search the last level, then pick the node with that name
    if (await visibleIn(page, `${FS_DROP} .atsx-tree, ${FS_DROP} .atsx-select-search__field`)) { // a tree is empty until searched
      const last = areaLevels(value).pop() ?? value;
      await page.locator(`${FS_DROP} .atsx-select-search__field`).first().pressSequentially(bareArea(last), { delay: 40 }).catch(() => {});
      await page.waitForTimeout(500);
      const r = await pick(page, page.locator("body"), `${FS_DROP} .atsx-tree [data-cy-value]`, [last, bareArea(last)]);
      if (r !== "") { await close(); return r ?? `地区里没有「${last}」`; }
      return "";
    }
    const r = await pick(page, page.locator("body"), `${FS_DROP} [role='option'], ${FS_DROP} .atsx-select-dropdown-menu-item`, variants(value, monthBox), !monthBox);
    if (r !== "") { await close(); return r ?? `没有「${value}」这个选项`; }
    return "";
  }
  const d = value.match(/(\d{4})\D{0,2}(\d{1,2})?/);
  if (/至今/.test(value)) { const r = await pick(page, page.locator("body"), "[class*='atsx-date-picker'] [data-cy='-']", ["至今"], true); return r === "" ? "" : "没找到「至今」"; }
  if (!d) { await close(); return "日期格式认不出"; }
  if (kind === "year") {
    for (let i = 0; i < 12; i++) {
      if ((await pick(page, page.locator("body"), ".atsx-date-picker-panel-body-cell-content", [d[1]], false)) === "") return "";
      const years = (await page.locator(".atsx-date-picker-panel-body-cell-content").allTextContents()).map(Number).filter(Boolean);
      if (!years.length) break;
      await press(page.locator(`[class*='atsx-date-picker'] [data-cy='${Number(d[1]) < Math.min(...years) ? "prev" : "next"}']`).first());
    }
    await close(); return "日历里翻不到这一年";
  }
  // a year-month period box: its panel lists years, then months
  const item = "[class*='atsx-date-picker-period-month-panel-list-item']";
  if (!(await waitFor(() => visibleIn(page, item), 2500))) { await close(); return "年月面板没有弹出来"; }
  if ((await pick(page, page.locator("body"), item, [d[1], `${d[1]}年`], false)) !== "") { await close(); return "年月面板里没有这一年"; }
  if (!d[2]) { await close(); return "画像里缺月份"; }
  await page.waitForTimeout(200);
  if ((await pick(page, page.locator("body"), item, variants(d[2], true), false)) !== "") { await close(); return "年月面板里没选上月份"; }
  return "";
}
