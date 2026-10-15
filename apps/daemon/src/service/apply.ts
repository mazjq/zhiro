import { join } from "node:path";
import { mkdirSync } from "node:fs";
import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import type { BrowserContext, Page } from "playwright-core";
import type { Db } from "../db.js";
import type { Llm } from "../llm.js";
import { DomainError } from "./domain.js";
import { listFacts } from "./profile.js";
import { blockKind } from "./apply-blocks.js";
import { optionAliases } from "./apply-widgets.js";
import type { Reference } from "./apply-reference.js";

/**
 * 网申探针 (ADR-017, PLAN §14 B6): read an application form and say what would go where — it types nothing and never
 * clicks. The browser is the user's own Chrome started by Zhiro with a dedicated, persistent profile
 * (<vault>/chrome-profile): logins, saved passwords and history survive; Playwright drives it over a pipe, so no
 * debugging port is opened for other processes to find.
 */
let ctx: BrowserContext | null = null;
let ctxHeadless = false; // a reader instance (page.read) nobody can see; a visible open replaces it
let readerIdle: NodeJS.Timeout | null = null;
let launching: Promise<BrowserContext> | null = null; // parallel readers must not start two Chromes on one profile

async function launch(vault: string, headless: boolean): Promise<BrowserContext> {
  if (launching) { await launching.catch(() => {}); }
  if (ctx && ctxHeadless && !headless) { await ctx.close().catch(() => {}); ctx = null; } // the person wants a window: the same profile cannot be open twice
  if (ctx) return ctx;
  launching = launchNew(vault, headless);
  try { return await launching; } finally { launching = null; }
}

async function launchNew(vault: string, headless: boolean): Promise<BrowserContext> {
  const dir = join(vault, "chrome-profile");
  mkdirSync(dir, { recursive: true });
  if (!ctx) {
    const { chromium } = await import("playwright-core");
    // chromiumSandbox: Playwright turns Chrome's sandbox OFF by default (the "--no-sandbox" warning bar); this is the
    // user's real browser on real sites, so keep the sandbox on.
    try { ctx = await chromium.launchPersistentContext(dir, { channel: "chrome", headless, viewport: null, chromiumSandbox: true, args: ["--no-first-run", "--no-default-browser-check"] }); }
    catch (e: any) { throw new DomainError("BROWSER_FAILED", `启动 Chrome 失败：${String(e?.message ?? e).split("\n")[0]}（需要本机装有 Chrome；同一个专用 profile 不能被两个 Chrome 同时打开）`); }
    ctxHeadless = headless;
    ctx.on("close", () => { ctx = null; ctxHeadless = false; });
  }
  return ctx;
}

/**
 * A tab for reading (page.read, ADR-038): in the window the person has open if there is one, else a headless instance of
 * the same profile (same logins) that closes itself after a quiet minute. `done` closes the tab.
 */
export async function readerPage(vault: string): Promise<{ page: Page; done: () => Promise<void> }> {
  const c = await launch(vault, !ctx || ctxHeadless); // whatever is open is reused (a reader never closes the person's window, nor a sibling reader's instance)
  const page = await c.newPage();
  if (readerIdle) clearTimeout(readerIdle);
  return {
    page,
    done: async () => {
      await page.close().catch(() => {});
      if (ctxHeadless) readerIdle = setTimeout(() => { if (ctxHeadless && ctx && !ctx.pages().some((p) => !p.isClosed() && p.url() !== "about:blank")) closeBrowser(); }, 60_000);
    },
  };
}

export async function openBrowser(vault: string, url: string, opts: { headless?: boolean } = {}) {
  const dir = join(vault, "chrome-profile");
  const c = await launch(vault, !!opts.headless);
  const page = c.pages().find((p) => p.url() === "about:blank") ?? (await c.newPage());
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45_000 }).catch(() => {}); // a slow SPA is still usable
  await page.bringToFront().catch(() => {});
  return { ok: true, profileDir: dir, url: page.url() };
}

export async function closeBrowser() { await ctx?.close().catch(() => {}); ctx = null; return { ok: true }; }
export const browserOpen = () => !!ctx;

/** The tab the user is looking at: the most recently focused page that is not blank. */
export async function activePage(): Promise<Page> {
  if (!ctx) throw new DomainError("BROWSER_NOT_OPEN", "专用浏览器还没打开");
  const pages = ctx.pages().filter((p) => !p.isClosed() && p.url() !== "about:blank");
  if (!pages.length) throw new DomainError("NO_PAGE", "专用浏览器里没有打开的页面");
  for (const p of [...pages].reverse()) if (await p.evaluate(() => document.visibilityState === "visible").catch(() => false)) return p;
  return pages[pages.length - 1];
}

/** `local` is the field's number inside its own frame; the element carries it as data-jobos-i so the filler can find it again. */
/** `entry`: which entry of a repeated block (教育背景 / 实习经历 …) the field sits in, -1 outside one. */
export interface FormField { index: number; local: number; frame: string; section: string; label: string; type: string; required: boolean; options: string[]; value: string; placeholder: string; name: string; disabled?: boolean; entry?: number }

/**
 * Runs inside the page (every frame). Finds the label the way a person would: <label for>, aria-label, the form-item
 * wrapper of the common UI kits (Ant Design, Element, Arco — what Moka / 北森 / company sites are built with), a
 * preceding table cell, then placeholder. Custom dropdowns are recognised by role / class, their options only if rendered.
 */
const READ_FORM = () => {
  const text = (el: Element | null | undefined) => (el?.textContent ?? "").replace(/\s+/g, " ").replace(/[*＊:：]/g, "").trim();
  // off-screen helper inputs (clipboard / focus traps parked at left:-9999px) are not part of the form
  const visible = (el: Element) => { const r = (el as HTMLElement).getBoundingClientRect(); const s = getComputedStyle(el as HTMLElement); return r.width > 3 && r.height > 3 && r.right + window.scrollX > 0 && r.bottom + window.scrollY > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  // Field wrappers and their captions. Besides the public UI kits, career sites ship CSS-module class names with a stable
  // prefix and a hash — Moka: div.apply-field-Q2iJ… > div.title-IWWQ… + div.ctrl-…, section = div.blockTitle-dcm…
  const ITEM = ".atsx-form-item, div.field.ui-field-contain, .ant-form-item, .el-form-item, .arco-form-item, .form-item, .form-group, .field, [class*='formItem'], [class*='form-item'], [class*='FormItem'], [class*='apply-field'], [class*='form-field'], [class*='formField'], [class*='field-item']";
  const LABEL = ".form-item__text, .ant-form-item-label, .el-form-item__label, .arco-form-item-label, [class^='title-'], [class*=' title-'], [class*='field-title'], [class*='fieldTitle'], [class*='label'], [class*='Label'], label";
  // the field wrapper, skipping the inner "control" / "content" boxes whose class names also contain form-item
  // (Ant Design .ant-form-item-control, Element .el-form-item__content)
  const itemOf = (el: Element): Element | null => { let it = el.closest(ITEM); while (it && /(form-item-control|form-item__content|FormItem-control)/i.test(it.className?.toString() ?? "")) it = it.parentElement?.closest(ITEM) ?? null; return it; };
  const SECTION = ".createFormSection-title,h1,h2,h3,h4,h5,legend,[class*='blockTitle'],[class*='block-title'],[class*='section-title'],[class*='sectionTitle'],[class*='group-title'],[class*='groupTitle'],[class*='module-title']";
  // option = a radio / checkbox: the <label> around it names the option, never the question
  const labelOf = (el: Element, option = false): string => {
    const id = el.getAttribute("id");
    if (id) { const l = document.querySelector(`label[for="${CSS.escape(id)}"]`); if (text(l)) return text(l); }
    const aria = el.getAttribute("aria-label") || text(document.getElementById(el.getAttribute("aria-labelledby") ?? ""));
    if (aria) return aria;
    const item = itemOf(el);
    // a caption the platform marks as such (飞书 atsx, 问卷星 topichtml without its number, 北森) wins over any "label"-ish class
    const own = item?.querySelector(":scope > .atsx-form-item-label, .field-label .topichtml, .form-item__text");
    if (own && text(own)) return text(own);
    // a <label> wrapping an input is an option ("是" / "否"), not the field's caption
    const inItem = item && Array.from(item.querySelectorAll(LABEL)).find((l) => !l.contains(el) && !l.querySelector("input") && text(l) && text(l).length <= 30);
    if (inItem) return text(inItem);
    const wrap = option ? null : el.closest("label"); if (wrap && text(wrap)) return text(wrap);
    const td = el.closest("td")?.previousElementSibling; if (td && text(td)) return text(td);
    const prev = (item ?? el).previousElementSibling; if (prev && text(prev) && text(prev).length <= 20) return text(prev);
    return "";
  };
  const sectionOf = (el: Element): string => {
    for (let n: Element | null = el; n && n !== document.body; n = n.parentElement) {
      for (let s = n.previousElementSibling; s; s = s.previousElementSibling) {
        // a caption that belongs to a field (it sits inside a field wrapper) is a label, never a section heading
        const h = [s, ...Array.from(s.querySelectorAll(SECTION))].reverse().find((x) => x.matches(SECTION) && !x.closest(ITEM) && text(x) && text(x).length <= 24);
        if (h) return text(h).replace(/(\s*(添加|新增|\+))+\s*$/, ""); // "教育背景 + 添加" → 教育背景
      }
      const lg = n.matches("fieldset") ? n.querySelector("legend") : null; if (lg && text(lg)) return text(lg);
      // 北森: each block is a div.form (id Recruitment_…) whose heading is the element just before it
      if (n.matches("div.form[id*='Recruitment']")) { const h = n.previousElementSibling; if (h && text(h) && text(h).length <= 24) return text(h).replace(/\s*(添加|新增|\+).*$/, ""); }
    }
    return "";
  };
  // the "required" mark sits in different places per UI kit: on the input, on the item wrapper (Element), or on the
  // label inside the item (Ant Design) — or it is just an asterisk in the label text
  const required = (el: Element) => { const item = itemOf(el); return (el as HTMLInputElement).required || item?.getAttribute("req") === "1" || el.getAttribute("aria-required") === "true" || !!el.closest(".is-required, [class*='required']") || !!item?.querySelector(".ant-form-item-required, [class*='required']") || /[*＊]/.test(item?.querySelector(LABEL)?.textContent ?? ""); };
  const out: any[] = [];
  const seen = new Set<Element>();
  document.querySelectorAll("[data-jobos-i]").forEach((e) => e.removeAttribute("data-jobos-i"));
  const stamp = (el: Element) => { el.setAttribute("data-jobos-i", String(out.length)); return out.length; };
  // Moka: every entry of a block is an apply-fields-* wrapper inside apply-block-*; its position is the entry number
  // 飞书: .createFormSection-formList > .resumeEditForm-item, one per entry
  const entryOf = (el: Element) => {
    const ent = el.closest("[class*='apply-fields-'], .resumeEditForm-item"); if (!ent) return -1;
    const moka = ent.matches("[class*='apply-fields-']");
    const blk = ent.closest(moka ? "[class*='apply-block-']" : ".createFormSection-formList") ?? ent.parentElement;
    return blk ? Array.from(blk.querySelectorAll(moka ? "[class*='apply-fields-']" : ".resumeEditForm-item")).indexOf(ent) : -1;
  };
  // an option's text: its <label>, or the element that names it by id (问卷星: div.label[for=q1_2])
  const optText = (o: Element) => text(o.closest("label")) || text(o.id ? document.querySelector(`[for="${CSS.escape(o.id)}"]`) : null) || o.getAttribute("value") || "";
  // file inputs are almost always hidden behind a styled "上传简历" button; they count even though they are not visible
  const push = (el: Element, type: string, options: string[], value: string) => {
    if (seen.has(el) || (type !== "file" && !visible(el))) return; seen.add(el);
    out.push({ local: stamp(el), section: sectionOf(el), label: labelOf(el), type, required: required(el), options: options.slice(0, 40), value: value.slice(0, 120), placeholder: el.getAttribute("placeholder") ?? "", name: el.getAttribute("name") ?? el.getAttribute("id") ?? "",
      disabled: !!(el as HTMLInputElement).disabled || !!el.closest("[class*='containerDisabled'], [class*='Input-disabled'], .is-disabled, .ant-select-disabled"), entry: entryOf(el) });
  };
  for (const el of Array.from(document.querySelectorAll("input, textarea, select"))) {
    const t = (el.getAttribute("type") ?? el.tagName).toLowerCase();
    if (["hidden", "submit", "button", "image", "reset", "search"].includes(t)) continue;
    if (el.tagName === "SELECT") push(el, "select", Array.from((el as HTMLSelectElement).options).map((o) => o.text.trim()).filter(Boolean), (el as HTMLSelectElement).selectedOptions[0]?.text ?? "");
    else if (t === "radio" || t === "checkbox") {
      const group = itemOf(el) ?? el.parentElement?.parentElement ?? el;
      if (seen.has(group)) continue;
      const opts = Array.from(group.querySelectorAll(`input[type="${t}"]`)).map(optText);
      seen.add(group); if (visible(el) || visible(group)) out.push({ local: stamp(group), value: Array.from(group.querySelectorAll(`input[type="${t}"]`)).filter((o) => (o as HTMLInputElement).checked).map(optText).join("、"), section: sectionOf(group), label: labelOf(el, true) || text(group.querySelector(LABEL)), type: t, required: required(el), options: opts, placeholder: "", name: el.getAttribute("name") ?? "", entry: entryOf(group) });
    } else if (t === "file") push(el, "file", [], "");
    else {
      const custom = el.closest(".atsx-select, .atsx-date-picker, [class*='atsx-date-picker'], .atsx-cascader, .ant-calendar-picker, .ant-select, .el-select, .arco-select, .ant-picker, .el-date-editor, .ant-cascader, .el-cascader, [role='combobox'], [class*='Select-container'], [class*='select-container'], [class*='Dropdown-container'], [class*='DatePicker'], [class*='Cascader'], .phoenix-select, [class*='phoenix-select'], .phoenix-auto-complete-container")
        ?? ((el as HTMLInputElement).readOnly || /^请选择|^选择|^select/i.test(el.getAttribute("placeholder") ?? "") ? el : null); // a read-only "请选择" box is a dropdown whatever it is built from
      const kind = custom ? (/(picker|date)/i.test(custom.className) ? "date" : /cascader/i.test(custom.className) ? "cascader" : "dropdown") : el.tagName === "TEXTAREA" ? "textarea" : t === "textarea" ? "textarea" : ["date", "month", "email", "tel", "number", "url", "password"].includes(t) ? t : "text";
      const shown = custom && (custom.closest("[class*='Dropdown-container']") ?? custom).querySelector("[class*='display-value'], .phoenix-select__tipEle, [class*='singleLabel'], .ant-select-selection-item, .el-select__selected-item");
      const shownText = text(shown); // Moka writes 请选择 / 年 / 月 there while empty
      // the committed value is what the control displays; the inner input of a search box only holds the filter text
      push(el, kind, [], (/^(请选择|年|月|请输入.*)?$/.test(shownText) ? "" : shownText) || (el as HTMLInputElement).value || "");
    }
  }
  for (const el of Array.from(document.querySelectorAll("[role='combobox']:not(input), [contenteditable='true']"))) push(el, el.getAttribute("contenteditable") ? "textarea" : "dropdown", [], text(el));
  return { title: document.title, url: location.href, fields: out, submitButtons: Array.from(document.querySelectorAll("button, input[type=submit], [role=button]")).map((b) => text(b)).filter((s) => /提交|投递|确认投递|submit|apply/i.test(s)).slice(0, 5) };
};

export async function readForm(): Promise<{ title: string; url: string; fields: FormField[]; submitButtons: string[] }> {
  const page = await activePage();
  const fields: FormField[] = []; const submit = new Set<string>();
  for (const frame of page.frames()) {
    const main = frame === page.mainFrame();
    // tsx (the daemon's runtime) compiles with keepNames, which wraps the inner functions of READ_FORM in __name(...)
    // calls; that helper does not exist inside the page, so give it one. Vitest compiles differently and never hit this —
    // `pnpm --filter @zhiro/daemon check:apply` runs the same read under tsx.
    const within = <T,>(p: Promise<T>) => Promise.race([p, new Promise<T>((_, no) => setTimeout(() => no(new Error("读取页面超时")), 15_000))]);
    const r = await within(frame.evaluate("globalThis.__name = globalThis.__name || ((f) => f)").then(() => frame.evaluate(READ_FORM))).catch((e) => {
      // sub-frames (ads, detached, cross-origin) may simply not answer; a failure in the page itself must be seen
      if (main) throw new DomainError("READ_FAILED", `读取页面失败：${String(e?.message ?? e).split("\n")[0]}`);
      return null;
    });
    if (!r) continue;
    for (const f of r.fields) fields.push({ ...f, index: fields.length, frame: frame === page.mainFrame() ? "" : frame.url() });
    r.submitButtons.forEach((s: string) => submit.add(s));
  }
  return { title: await page.title(), url: page.url(), fields, submitButtons: [...submit] };
}

// ---------- mapping: which fact card answers which field

/** Never proposed and never stored, whatever the profile holds. (民族 was here; the user chose to keep it in the profile.) */
// 动态码 / 重新发送: an SMS code box and its button were once learned as profile cards (2026-10-14) — never again
export const SENSITIVE = /身份证|证件号|护照|银行|卡号|密码|验证码|动态码|校验码|短信码|重新发送|发送验证|获取验证|captcha|社保|公积金|紧急联系|家庭成员|与本人关系|父母|父亲|母亲|配偶|亲属|家属|监护人|婚姻|宗教|血型|病史|健康/i;
/** Whole sections about other people: their 姓名 / 电话 are not the user's, whatever the label says. */
const OTHER_PEOPLE = /家庭|家人|亲属|家属|紧急联系|父母|配偶|成员|证明人|推荐人|内推人|联系人|社会关系/;
const FORM_TITLE = /报名|登记|招聘|招募|应聘/; // N5: a form's own title („2027届研发成员招聘报名表“) can end up as the section of its first fields
export const peopleSection = (section: string): boolean => OTHER_PEOPLE.test(section) && !FORM_TITLE.test(section);
/** The user's own choices. Filled only from what the user once answered themselves (意向 cards), never guessed. */
const PERSONAL_CHOICE = /期望|意向|薪资|到岗|入职时间|是否服从|调剂|是否接受|志愿|内推|推荐码|推荐人|了解渠道|从何处|面试站点|面试城市|offer/i;

/** The same question asked in different words, reduced to one name — the key the answer is stored and found under. */
const CANON: [RegExp, string][] = [
  [/^(姓名|中文名|真实姓名|name)$/i, "姓名"], [/邮箱|e-?mail/i, "邮箱"], [/手机|电话|联系方式|mobile|phone/i, "电话"], [/微信/, "微信"],
  [/出生|生日/, "出生年月"], [/^性别$/, "性别"], [/政治面貌/, "政治面貌"], [/籍贯|生源地|户籍/, "籍贯"], [/^民族$/, "民族"],
  [/现居|居住地|^所在地|所在城市|当前城市/, "现居地"], [/预计毕业|毕业年份|毕业届别|届别/, "预计毕业时间"], [/英语|外语等级|cet|四六级/i, "英语水平"],
  [/个人主页|github|博客/i, "个人主页"], [/工作经验|工作年限/, "工作经验"], [/自我描述|自我评价|个人简介|自我介绍/, "自我描述"],
  [/期望(工作)?城市|意向(工作)?城市|工作地点意向/, "期望城市"], [/期望行业/, "期望行业"], [/期望薪|期望月薪|期望年薪/, "期望薪资"], [/到岗|入职时间/, "到岗时间"],
];
/** Fields of the education record. "最高学历" and "最近毕业专业" ask about it from 基本信息 too. */
// N9: the time patterns go first — 「最高学历毕业时间」 is a date, not a degree; a place (「院校所在区域」) is not the school
const EDU: [RegExp, string][] = [
  [/开始时间|入学时间|起始时间/, "start"], [/结束时间|毕业时间|毕业证|学位证/, "end"], [/(就读|起止|在校).*(时间|日期)/, "period"],
  [/学校|院校|school|university/i, "school"], [/学历|学位|degree/i, "degree"], [/专业|major/i, "major"],
];
const NOT_EDU = /区域|地区|所在地|所在省|所在市|城市|省份|国家|地址|代码|编号|类型|类别|排名|海外|境外|是否/;
/** 「海外院校毕业」「是否留学」: a yes / no question about the education records, not the school's name. */
const ABROAD = /海外|境外|留学|国外/;

export const normLabel = (s: string) => s.replace(/[（(][^）)]*[）)]/g, "").replace(/[*＊:：\s]/g, "").replace(/^(您的|你的|请输入|请填写|请选择)/, "").trim();
// 「是否接受意向城市调剂」 is a yes / no question, not the city (it got 「武汉」 on 大疆, 2026-10-14)
export const canonOf = (label: string) => (/是否/.test(label) ? "" : CANON.find(([re]) => re.test(normLabel(label)))?.[1] ?? "");

export interface Mapped extends FormField { factKey: string; proposed: string; source: string; status: "可填" | "由你填写" | "不代填" | "画像里没有" | "上传文件" | "已有内容" | "多段"; how: "规则" | "模型" | "文档" | "" }

/** The person's 「系统填写」 document answers this label: the same name, or one contains the other (特长 ↔ 个人特长). */
export function refAnswer(ref: Reference | null | undefined, label: string): { key: string; value: string } | null {
  if (!ref || !label) return null;
  const l = normLabel(label);
  const alias: Record<string, string[]> = { 个人特长: ["特长"], 特长: ["个人特长"], 自我评价: ["自我描述", "个人简介", "自我介绍"], 兴趣爱好: ["爱好"], 爱好: ["兴趣爱好"] };
  for (const [k, v] of ref.fields) {
    const key = normLabel(k);
    if (key === l || (alias[key] ?? []).includes(l) || (key.length >= 2 && l.length >= 2 && (l.includes(key) || key.includes(l)))) return { key: k, value: v };
  }
  return null;
}

/** "2021.09—2027.06", "2021-9 至 2027-6" → the four boxes of a 年/月 - 年/月 range. */
export function periodParts(p: string): { start: [string, string]; end: [string, string] } | null {
  const m = p.match(/(\d{4})\D{0,2}(\d{1,2})?\D+?(\d{4}|至今|今)\D{0,2}(\d{1,2})?/);
  if (!m) return null;
  const mm = (x?: string) => (x ? String(Number(x)).padStart(2, "0") : "");
  return { start: [m[1], mm(m[2])], end: /今/.test(m[3]) ? ["至今", ""] : [m[3], mm(m[4])] };
}

function valueFor(facts: any[], key: string, section: string, ref?: Reference | null): { value: string; source: string } {
  const [kind, field] = [key.slice(0, key.indexOf(".")), key.slice(key.indexOf(".") + 1)];
  if (kind === "ref") { const v = ref?.fields.get(field) ?? ""; return { value: v, source: v ? "系统填写文档" : "" }; }
  if (kind === "derived" && field === "海外") {
    // every school of the person's records written in Chinese characters: none abroad. No records: no answer.
    const edu = facts.filter((x) => x.kind === "education" && x.data.school);
    return edu.length ? { value: edu.some((e) => !/[\u4e00-\u9fff]/.test(e.data.school)) ? "是" : "否", source: "由教育经历推出" } : { value: "", source: "" };
  }
  if (kind === "basic" || kind === "pref") {
    // the 意向 cards the recommenders use are named 城市 / 行业; a form asks 期望城市 / 期望行业
    const names = [field, ...(field === "期望城市" ? ["城市"] : field === "期望行业" ? ["行业"] : [])];
    const hits = facts.filter((x) => (x.kind === "basic" || x.kind === "preference") && names.includes(normLabel(x.data.field ?? "")));
    return { value: hits.map((h) => h.data.value).join("、"), source: hits.length ? `${hits[0].kind === "basic" ? "基本信息" : "意向"} · ${hits[0].grade}` : "" };
  }
  if (kind === "education") {
    const edu = facts.filter((x) => x.kind === "education");
    const rank = (d: string) => (d.includes("博士") ? 3 : d.includes("硕士") ? 2 : 1);
    const [sec, lab = ""] = section.split("|");
    const stagesIn = (s: string) => [/本科|学士/.test(s) && 1, /硕士/.test(s) && 2, /博士/.test(s) && 3].filter(Boolean) as number[];
    if (stagesIn(lab).length > 1) return { value: "", source: "" }; // 本科 / 硕士就读院校: which one is not ours to guess
    const byLabel = stagesIn(lab)[0];
    const wanted = byLabel ?? (/本科|学士/.test(sec) ? 1 : /硕士|研究生/.test(sec) && !/博士/.test(sec) ? 2 : /博士/.test(sec) ? 3 : 0);
    // 直博: no master's record — a 硕士 field stays empty rather than getting the PhD's school; but a section that only
    // says 研究生 (N11) means the graduate stage, which for a direct PhD is the doctorate
    const f = wanted ? edu.find((e) => rank(e.data.degree) === wanted) ?? (wanted === 2 && /研究生/.test(sec) && !/硕士/.test(sec + lab) ? edu.find((e) => rank(e.data.degree) === 3) : undefined)
      : [...edu].sort((a, b) => rank(b.data.degree) - rank(a.data.degree))[0];
    const parts = periodParts(f?.data.period ?? "");
    const value = field === "start" ? (parts ? parts.start.filter(Boolean).join("-") : "") : field === "end" ? (parts ? parts.end.filter(Boolean).join("-") : "") : f?.data[field] ?? "";
    return { value, source: f ? `教育 · ${f.data.school} ${f.data.degree} · ${f.grade}` : "" };
  }
  return { value: "", source: "" };
}

/** Closest option to a profile value ("博士" → "博士研究生"); empty when nothing is close enough to propose. */
export const pickOption = (options: string[], value: string) => {
  for (const v of optionAliases(value)) { const hit = options.find((o) => o === v) ?? options.find((o) => o.includes(v) || v.includes(o)); if (hit) return hit; }
  return "";
};

const LLM_KEYS = ["basic.姓名", "basic.邮箱", "basic.电话", "basic.微信", "basic.出生年月", "basic.性别", "basic.政治面貌", "basic.籍贯", "basic.民族", "basic.现居地", "basic.预计毕业时间", "basic.英语水平", "basic.个人主页", "basic.工作经验", "basic.自我描述", "education.school", "education.degree", "education.major", "education.period", "publication", "patent", "project", "experience", "award", "skill", "none"];

/** Labels and option lists only — never the user's values — go to the model; it answers with keys, values are filled in locally. */
async function mapWithModel(llm: Llm, fields: FormField[]): Promise<Map<number, string>> {
  const sys = `你在给一个求职网申表单的字段做归类。每个字段给出它对应候选人资料里的哪一项，只输出 JSON：{"map":[{"index":0,"key":""}]}。
key 只能取：${LLM_KEYS.join(" / ")}。publication/patent/project/experience/award/skill 表示这一栏要填的是该类经历（由候选人逐条填写）。拿不准或不属于以上任何一项就填 none。不要猜测字段的值。`;
  const user = JSON.stringify(fields.map((f) => ({ index: f.index, section: f.section, label: f.label || f.placeholder || f.name, type: f.type, options: f.options.slice(0, 12) })));
  const msg = await llm.models.completeSimple(llm.model(), { systemPrompt: sys, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] }, { reasoning: "low" });
  const o = parseJsonWithRepair<{ map?: { index: number; key: string }[] }>(contentText(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  return new Map((o.map ?? []).filter((m) => LLM_KEYS.includes(m.key) && m.key !== "none").map((m) => [m.index, m.key]));
}

/** `ref`: the person's 「系统填写」 document, preferred over the profile for what it answers (apply-reference.ts). */
export async function mapFields(db: Db, llm: Llm | undefined, fields: FormField[], ref?: Reference | null): Promise<Mapped[]> {
  const facts = listFacts(db).items;
  const out: Mapped[] = fields.map((f) => ({ ...f, factKey: "", proposed: "", source: "", status: "画像里没有", how: "" }));
  const open: Mapped[] = [];
  for (const m of out) {
    const label = normLabel(m.label || m.placeholder || m.name);
    if (m.type === "file") { m.status = "上传文件"; continue; }
    if (m.disabled) { m.status = "不代填"; continue; } // locked by the site (account-level or parsed): not ours to change
    if ((m.entry ?? -1) >= 0 && blockKind(m.section)) { m.status = "多段"; continue; } // an entry of 教育背景 / 实习经历 …: filled record by record (apply-blocks)
    if (/手机|电话/.test(label) && m.type === "dropdown") { m.status = "不代填"; continue; } // the +86 box beside the number
    if (SENSITIVE.test(label) || peopleSection(m.section)) { m.status = "不代填"; continue; }
    if (ABROAD.test(label) && /毕业|院校|学历|经历|学校/.test(label)) { m.factKey = "derived.海外"; m.how = "规则"; continue; }
    // the person's own document answers this label: it wins (they keep it for exactly this)
    const fromDoc = refAnswer(ref, label);
    if (fromDoc && !/^(姓名|电话|邮箱)$/.test(canonOf(label))) { m.factKey = `ref.${fromDoc.key}`; m.how = "文档"; continue; }
    const eduBlock = /教育|学历|学校|education/i.test(m.section);
    const eduHit = NOT_EDU.test(label) ? undefined : EDU.find(([re]) => re.test(label));
    // 「取得毕业证时间」「毕业时间」 in 个人信息 ask about the highest degree too
    const edu = eduHit && (eduBlock || ["school", "degree", "major"].includes(eduHit[1]) || (eduHit[1] === "end" && /毕业|学位/.test(label))) ? eduHit : undefined;
    const canon = canonOf(label);
    if (edu) { m.factKey = `education.${edu[1]}`; m.how = "规则"; }
    else if (canon) { m.factKey = `${PERSONAL_CHOICE.test(label) ? "pref" : "basic"}.${canon}`; m.how = "规则"; }
    else if (PERSONAL_CHOICE.test(label)) { m.factKey = `pref.${label}`; m.how = "规则"; }
    // anything the user answered once under this very label, on any site
    else if (label && facts.some((f) => (f.kind === "basic" || f.kind === "preference") && normLabel(f.data.field ?? "") === label)) { m.factKey = `basic.${label}`; m.how = "规则"; }
    else if (!eduBlock && /经历|经验|项目|实习|工作|获奖|论文|专利/.test(m.section)) { m.factKey = /项目/.test(m.section) ? "project" : /获奖/.test(m.section) ? "award" : /论文|专利/.test(m.section) ? "publication" : "experience"; m.how = "规则"; }
    else open.push(m);
  }
  if (llm && open.length) {
    const byModel = await Promise.race([mapWithModel(llm, open), new Promise<Map<number, string>>((r) => setTimeout(() => r(new Map()), 30_000))]).catch(() => new Map<number, string>());
    for (const m of open) { const k = byModel.get(m.index); if (k) { m.factKey = k; m.how = "模型"; } }
  }
  // a repeated block whose entries this platform does not let us tell apart: the first occurrence of each caption is
  // the first entry, the rest are left to the user (filling every entry with the same record was worse than nothing)
  const seenAgain = new Map<string, number>();
  for (const m of out) {
    if (!m.factKey.startsWith("education.") || (m.entry ?? -1) >= 0 || !blockKind(m.section) || /^(年|月|日)$/.test(m.placeholder)) continue;
    const k = `${m.section}|${normLabel(m.label)}`, n = seenAgain.get(k) ?? 0; seenAgain.set(k, n + 1);
    if (n > 0) { m.factKey = ""; m.status = "由你填写"; m.source = "这一段在这个平台还不能逐条对应，请手动填写"; }
  }
  // a 年/月 - 年/月 range is four boxes under one caption: hand each its part, in order
  const partSeen = new Map<string, number>();
  for (const m of out) {
    if (!m.factKey) continue;
    if (!m.factKey.includes(".")) { m.status = "由你填写"; m.source = `对应画像里的「${m.factKey}」类，多条经历逐条填写（下一步支持）`; continue; }
    let { value, source } = valueFor(facts, m.factKey, `${m.section}|${m.label}`, ref);
    if (/^(年|月|日)$/.test(m.placeholder) && m.factKey.startsWith("education.")) {
      const k = `${m.section}|${m.label}`, n = partSeen.get(k) ?? 0; partSeen.set(k, n + 1);
      const p = periodParts(valueFor(facts, "education.period", `${m.section}|${m.label}`).value);
      // 「毕业时间」 as 年 / 月 boxes is the end alone; it got the start (2021年1月 on a real Moka form, 2026-10-14)
      const part = m.factKey === "education.end" ? p?.end : m.factKey === "education.start" ? p?.start : p && [...p.start, ...p.end];
      value = part?.[n] ?? "";
    }
    m.source = source;
    if (!value) { m.status = m.factKey.startsWith("pref.") ? "由你填写" : "画像里没有"; continue; }
    // a select showing "请选择" is empty, not filled
    const filled = m.value && !/^(请选择|请输入|请填写|选择|-+|select|choose|please|年|月)$/i.test(m.value.trim());
    if (filled && m.value !== value && pickOption([m.value], value) === "") { m.status = "已有内容"; m.proposed = value; continue; }
    // a paragraph never goes into a list of options (「MBTI 人格类型」 under a 自我描述 heading got the self-description)
    if (["dropdown", "select", "radio", "cascader"].includes(m.type) && value.length > 30) { m.status = "画像里没有"; m.source = ""; continue; }
    if (m.type === "number") {
      // a box that only takes digits: one number in the answer goes in, anything else is the person's to write
      // the 6 of 「CET-6」 is part of a name, not a score
      const nums = value.replace(/[a-z]+[-\s]?\d+/gi, "").match(/\d+(\.\d+)?/g) ?? [];
      if (nums.length !== 1) { m.status = "画像里没有"; m.source = `这一栏只收数字，画像里是「${value}」`; continue; }
      value = nums[0];
    }
    m.proposed = m.options.length ? pickOption(m.options, value) || value : value;
    m.status = "可填";
  }
  return out;
}
