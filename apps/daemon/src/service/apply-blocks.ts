import type { Page } from "playwright-core";
import type { Db } from "../db.js";
import { listFacts } from "./profile.js";
import { periodParts, normLabel, type FormField } from "./apply.js";
import type { Reference } from "./apply-reference.js";

/**
 * 多段经历 (ADR-024, milestone c): 教育背景 / 实习经历 / 项目经验 / 获奖经历 hold one entry per record. The rule the
 * review insisted on: never add blindly. An entry that already holds something is matched to a record by name (school /
 * company / project / award) and left alone; empty entries are filled first; only then is 「添加」 clicked — once, and
 * the next entry is filled only after the new block has appeared. A re-run therefore adds nothing twice.
 */
export interface Slot { section: string; entry: number; fields: FormField[] }
export interface Plan { kind: Kind; section: string; record: Record<string, string>; name: string; slot: Slot | null }
type Kind = "education" | "experience" | "project" | "award" | "publication" | "patent" | "language" | "skill";

// N10: 「学习经历」「学历信息」「求学经历」 are the same block as 「教育经历」
// The lists a real form left wholly to the person (2026-11-17): 论文, 专利, 语言, 技能. 「语言技能」 is the languages and
// 「编程语言」 is a skill; 「技能证书」 is certificates, which the profile does not keep as a list.
const BLOCKS: [RegExp, Kind][] = [[/教育|学习经历|学历信息|学历背景|求学/, "education"], [/实习/, "experience"], [/项目/, "project"], [/获奖|奖项|荣誉/, "award"],
  [/论文|发表|学术成果|科研成果|专著/, "publication"], [/专利/, "patent"], [/(?<!编程|程序|开发)语言|外语|语种/, "language"], [/技能(?!.*证)|编程语言/, "skill"]];
export const blockKind = (section: string): Kind | null => BLOCKS.find(([re]) => re.test(section))?.[1] ?? null;

/** Which part of a record a field inside an entry asks for. */
export function partOf(kind: Kind, label: string): string {
  const l = normLabel(label);
  if (/起止|就读|时间|日期/.test(l)) return "period";
  if (kind === "education") return /学校|院校/.test(l) ? "school" : /专业/.test(l) ? "major" : /学历|学位/.test(l) ? "degree" : "";
  if (kind === "experience") return /公司|单位|企业|机构/.test(l) ? "org" : /职位|岗位|职务/.test(l) ? "role" : /职责|内容|描述/.test(l) ? "summary" : "";
  // 项目描述 is the project itself (what, at which level, why); 职责 / 角色 is what the person did in it (user, 2026-10-14)
  if (kind === "project") return /名称/.test(l) ? "title" : /职责|角色|职务|担任|负责|个人工作|本人工作/.test(l) ? "duty" : /描述|简介|介绍|内容|背景/.test(l) ? "description" : "";
  // a caption that only contains the list's own word (「论文类型」, 「专利类型」, 「技能类别」) is not its name
  if (kind === "publication") return /作者|署名|排名|位次/.test(l) ? "authorOrder" : /期刊|刊物|刊名|会议|出版|发表于/.test(l) ? "venue" : /名称|题目|标题|^(论文|著作|成果)$/.test(l) ? "title" : "";
  if (kind === "patent") return /发明人|作者|署名|排名|位次/.test(l) ? "authorOrder" : /专利号|申请号|授权号|登记号|编号/.test(l) ? "number" : /名称|题目|^专利$/.test(l) ? "title" : "";
  if (kind === "language") return /证书|等级|考试/.test(l) ? "cert" : /掌握|熟练|水平|程度/.test(l) ? "level" : /分数|成绩|得分/.test(l) ? "score" : /语言|语种|外语/.test(l) ? "name" : "";
  if (kind === "skill") return /掌握|熟练|水平|程度|等级/.test(l) ? "level" : /描述|说明|备注/.test(l) ? "" : /名称|^(技能|专业技能|编程语言)$/.test(l) ? "name" : "";
  return /颁发|授予|主办|发证/.test(l) ? "issuer" : /名称|奖项/.test(l) ? "title" : /级别/.test(l) ? "level" : "";
}

/** 「职责」 one line beside 「项目中职责」 a paragraph (a real Moka form, 2026-10-14): the line is the role, the paragraph what was done. */
export function projectPart(f: FormField, siblings: FormField[]): string {
  const p = partOf("project", f.label);
  return p === "duty" && f.type !== "textarea" && siblings.some((x) => x.type === "textarea" && partOf("project", x.label) === "duty") ? "role" : p;
}

const nameOf = (kind: Kind, d: Record<string, string>) => (kind === "education" ? d.school : kind === "experience" ? d.org : kind === "skill" || kind === "language" ? d.name : d.title) ?? "";
export const sameName = (a: string, b: string) => same(a, b);
const same = (a: string, b: string) => { const n = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase(); return !!a && !!b && (n(a).includes(n(b)) || n(b).includes(n(a))); };
/** One award spelled two ways on the profile (「…（本科组）· 全国二等奖」 / 「… · 全国二等奖」): compared without brackets, dots, the institution. */
const core = (s: string) => s.normalize("NFKC").replace(/\([^)]*\)|（[^）]*）|[·\s“”"']/g, "").replace(/^[一-鿿]{2,12}?(?:大学(?!生)|学院)(?=.)/, "").replace(/赛区|省/g, "").toLowerCase();
/** most recent first — what Moka's own parse does and what an HR reads first */
const startOf = (d: Record<string, string>) => { const p = periodParts(d.period ?? d.year ?? ""); return p ? Number(p.start[0]) * 12 + Number(p.start[1] || 1) : 0; };

export function slotsOf(fields: FormField[]): Slot[] {
  const slots = new Map<string, Slot>();
  for (const f of fields) {
    if ((f.entry ?? -1) < 0 || !blockKind(f.section)) continue;
    const k = `${f.section}|${f.entry}`;
    (slots.get(k) ?? slots.set(k, { section: f.section, entry: f.entry!, fields: [] }).get(k)!).fields.push(f);
  }
  return [...slots.values()];
}

const empty = (v: string) => /^(请选择|请输入|年|月|-+)?$/.test(v.trim());
/** An entry the site or the user already filled: the text that says what it is (the school, the company…). */
const filledName = (kind: Kind, s: Slot) => s.fields.find((f) => ["school", "org", "title", "name"].includes(partOf(kind, f.label)) && !empty(f.value))?.value ?? "";
/** Nothing typed in any free-text box; a select showing its default (D3) does not make an entry occupied. */
const blank = (s: Slot) => s.fields.every((f) => ["select", "dropdown", "checkbox", "radio", "file"].includes(f.type) || empty(f.value));

/** 学历 in one word: a bachelor's and a doctorate at the same school are two records, not one spelled twice. */
const level = (s = "") => (/博士/.test(s) ? "博士" : /硕士/.test(s) ? "硕士" : /本科|学士/.test(s) ? "本科" : /专科|大专/.test(s) ? "专科" : s.trim());
/** 联合培养 / 访问 / 交换: time spent at a school, not a degree programme of it — left out of an application's 教育背景 (user, 2026-11-16). */
export const notDegree = (d: Record<string, string>) => /联合培养|访问|访学|交换|交流|不授学位|非学位/.test(d.degree ?? "");
const planName = (kind: Kind, d: Record<string, string>) => (kind === "education" && d.degree ? `${d.school ?? ""}（${level(d.degree)}）` : nameOf(kind, d));

/** One school written two ways (「阿尔伯塔大学（University of Alberta）」 on the profile, 「University of Alberta(加拿大)」 on the form): any of its names. */
const sameSchool = (a: string, b: string) => {
  const parts = (s: string) => s.normalize("NFKC").toLowerCase().split(/[()]/).map((p) => p.replace(/\s+/g, "")).filter((p) => p.length >= 4);
  return parts(a).some((x) => parts(b).includes(x)); // a whole name of it, not a piece: 「示例大学」 is not 「海外示例大学」
};
/** Entries of 教育背景 already on the form that are a stay with no degree on the profile (the site parsed them out of the resume). */
export function visitEntries(db: Db, fields: FormField[]): { section: string; name: string }[] {
  const visits = listFacts(db).items.filter((f) => f.kind === "education" && notDegree(f.data as Record<string, string>)).map((f) => String(f.data.school ?? "")).filter(Boolean);
  if (!visits.length) return [];
  return slotsOf(fields).filter((s) => blockKind(s.section) === "education").map((s) => ({ section: s.section, name: filledName("education", s) }))
    .filter((e) => e.name && visits.some((v) => sameSchool(v, e.name)));
}

/**
 * For every block the form has and the profile has records for: which record goes into which entry, and which records
 * still need a new entry (slot = null). Records already present in a filled entry are dropped from the plan.
 */
export function planBlocks(db: Db, fields: FormField[], ref?: Reference | null): Plan[] {
  const facts = listFacts(db).items;
  const slots = slotsOf(fields);
  const plans: Plan[] = [];
  for (const section of [...new Set(slots.map((s) => s.section))]) {
    const kind = blockKind(section)!;
    // experience cards: only those that are internships go to 实习经历 (a campus job is not one)
    const records = recordsOf(facts, kind, ref, section);
    const mine = slots.filter((s) => s.section === section).sort((a, b) => a.entry - b.entry);
    // N6: an entry the site already part-filled (专业 but no 学校) is taken, not a blank to put our record into
    const open = mine.filter((s) => !filledName(kind, s) && blank(s));
    const taken = mine.filter((s) => !open.includes(s)).map((s) => ({ name: filledName(kind, s), degree: kind === "education" ? s.fields.find((f) => partOf(kind, f.label) === "degree" && !empty(f.value))?.value ?? "" : "" }));
    for (const record of records) {
      const name = nameOf(kind, record);
      // already on the form. Education: one filled entry is one record — 本科 and 博士 at one school are two entries
      const i = taken.findIndex((t) => same(t.name, name) && (kind !== "education" || !t.degree || !record.degree || level(t.degree) === level(record.degree)));
      if (i >= 0) { if (kind === "education") taken.splice(i, 1); continue; }
      plans.push({ kind, section, record, name: planName(kind, record), slot: open.shift() ?? null });
    }
  }
  return plans;
}

/** A skill goes onto a form with the level the person gave it: none given, or still learning, and it is not theirs to claim there. */
const statedLevel = (d: Record<string, string>) => !!d.level?.trim() && !/在学|学习中|入门中|了解中/.test(d.level);
/** 第一作者 / 通讯作者 / 共同第一: the papers a form's list is filled with when the profile says who wrote what. */
const leadAuthor = (d: Record<string, string>) => /第一|一作|通讯|first|corresponding/i.test(d.authorOrder ?? "");
const softwareRight = (d: Record<string, string>) => /软件著作权|软著/.test(d.title ?? "");
/** ponytail: one language, read from the 英语水平 card; a card kind of its own when a profile needs a second one */
function languages(facts: any[]): Record<string, string>[] {
  const basic = (re: RegExp) => String(facts.find((f) => f.kind === "basic" && re.test(normLabel(f.data.field ?? "")))?.data.value ?? "");
  const cert = basic(/^英语水平$/);
  return cert ? [{ name: "英语", cert, score: basic(/(英语|外语|四级|六级|cet).{0,6}(成绩|分数|得分)/i) }] : [];
}

/** The records of one kind, newest first: the person's document when it has the list, else the profile without near-duplicates. */
function recordsOf(facts: any[], kind: Kind, ref?: Reference | null, section = ""): Record<string, string>[] {
  if (kind === "language") return languages(facts);
  let records = facts.filter((f) => f.kind === kind && (kind !== "experience" || /实习/.test(`${f.data.role ?? ""}${f.data.summary ?? ""}${f.data.type ?? ""}`)) && (kind !== "education" || !notDegree(f.data)))
    .map((f) => f.data as Record<string, string>);
  if (kind === "skill") records = records.filter(statedLevel);
  if (kind === "patent" && !/著作权|软著/.test(section)) records = records.filter((r) => !softwareRight(r));
  if (kind === "publication" && records.some(leadAuthor)) records = records.filter(leadAuthor);
  // the person's own document is the list when it has one (their curated awards, their projects)
  if (kind === "award" && ref?.awards.length) records = ref.awards as unknown as Record<string, string>[];
  if (kind === "project" && ref?.projects.length) records = ref.projects.map((p) => ({ ...(records.find((r) => same(r.title, p.title)) ?? {}), ...p }) as Record<string, string>);
  // near-duplicates on the profile go once (education: the same school at the same 学历)
  const key = (r: Record<string, string>) => core(nameOf(kind, r)) + (kind === "education" ? `|${level(r.degree)}` : "");
  // a paper has a date or a year, not a period
  const at = (r: Record<string, string>) => { const m = kind === "publication" ? String(r.date ?? r.year ?? "").match(/(\d{4})\D*(\d{1,2})?/) : null; return m ? Number(m[1]) * 12 + Number(m[2] || 1) : startOf(r); };
  return records.filter((r, i) => !records.slice(0, i).some((o) => key(o) === key(r))).sort((a, b) => at(b) - at(a));
}
export const planRecords = (db: Db, kind: Kind, ref?: Reference | null) => recordsOf(listFacts(db).items, kind, ref);

/** What a list on this form was not filled with, and why — said once a list, so nothing is left out silently. */
export function leftOut(db: Db, fields: FormField[]): { section: string; detail: string }[] {
  const facts = listFacts(db).items, out: { section: string; detail: string }[] = [];
  const names = (rs: Record<string, string>[], key: string) => `${rs.slice(0, 5).map((r) => r[key]).join("、")}${rs.length > 5 ? " 等" : ""}`;
  for (const section of new Set(slotsOf(fields).map((s) => s.section))) {
    const kind = blockKind(section), all = facts.filter((f) => f.kind === kind).map((f) => f.data as Record<string, string>);
    if (kind === "skill") {
      const rest = all.filter((r) => !statedLevel(r));
      if (rest.length) out.push({ section, detail: `资料里有 ${rest.length} 项技能没写掌握程度（或写的是在学），没有填进来：${names(rest, "name")}。要填的话，先在求职资料里给它们写上掌握程度` });
    }
    if (kind === "publication" && all.some(leadAuthor)) {
      const rest = all.filter((r) => !leadAuthor(r));
      if (rest.length) out.push({ section, detail: `只填了第一作者 / 通讯作者的论文，另外 ${rest.length} 篇没有填，需要的话请手动添加` });
    }
  }
  return out;
}

/** The value one field of an entry should get from a record; for a 年/月 range, the n-th box of it. */
/** A 「至今」 box of an entry, however the site names it (the option, or the box itself). */
export const isOngoingBox = (f: FormField) => f.type === "checkbox" && /至今/.test(f.label + f.options.join(""));
/**
 * When the person's own degree programme ends: what 「至今」 becomes on a form with no 「至今」 box — a project that runs
 * on is theirs until they leave (user, 2026-11-16).
 */
export function studyEnd(facts: any[]): [string, string] | undefined {
  const ends = facts.filter((x) => x.kind === "education" && !notDegree(x.data)).map((x) => periodParts(x.data.period ?? "")?.end)
    .filter((e): e is [string, string] => !!e && /^\d{4}$/.test(e[0]));
  return ends.sort((a, b) => (b[0] + b[1]).localeCompare(a[0] + a[1]))[0];
}

/** `until`: the end a period that runs on (「2024.01-至今」) takes where the entry has no 「至今」 box (studyEnd). */
export function valueIn(kind: Kind, record: Record<string, string>, f: FormField, nth: number, siblings: FormField[] = [], until?: [string, string]): string {
  const part = kind === "project" ? projectPart(f, siblings) : partOf(kind, f.label);
  if (kind === "project" && part === "role") return record.role ?? "";
  // with a role box of its own, the duty box is what was done; otherwise role and what was done together
  if (kind === "project" && part === "duty") return siblings.some((x) => projectPart(x, siblings) === "role") && record.summary ? record.summary : [record.role, record.summary].filter(Boolean).join("：");
  if (kind === "project" && part === "description") {
    // no separate 职责 box in this entry: one paragraph — what the project is, then what the person did in it. No
    // 「本人职责：」 and no role in front (user, 2026-11-16: it read like a form, not like a description)
    const hasDuty = siblings.some((x) => partOf(kind, x.label) === "duty");
    const what = (record.description ?? "").trim(), did = (record.summary ?? "").trim();
    return hasDuty || !did ? what : what ? `${what}${/[。！？.!?；;]$/.test(what) ? "" : "。"}${did}` : did;
  }
  // who gave an award: `issuer` in the person's document, `org` on a profile card
  if (kind === "award" && part === "issuer") return record.issuer ?? record.org ?? "";
  // a paper's 发表时间: the day where the profile has it, else the year — one box, or 年 / 月 boxes
  if (kind === "publication" && part === "period") { const d = String(record.date ?? record.year ?? ""); return /^(年|月)$/.test(f.placeholder) ? (d.match(/\d+/g) ?? [])[nth] ?? "" : d; }
  if (part !== "period") return part ? record[part] ?? "" : "";
  const p = periodParts(record.period ?? (record.year ? `${record.year}-${record.year}` : ""));
  if (!p) return "";
  // runs on: the entry's own 「至今」 box says it (the end stays empty); with no such box, the end of the person's studies
  const end: [string, string] = p.end[0] === "至今" ? (siblings.some(isOngoingBox) ? ["", ""] : until ?? ["", ""]) : p.end;
  const boxes = [...p.start, ...end];
  if (/^(年|月)$/.test(f.placeholder)) return boxes[nth] ?? "";
  // 开始时间 / 结束时间 as one box each (北森)
  return /结束|毕业|离校|离职|截止/.test(f.label) ? end.filter(Boolean).join("-") : p.start.filter(Boolean).join("-");
}

/** Click the block's 「添加」 once and wait until one more entry exists. False if nothing appeared. */
export async function addEntry(page: Page, section: string, before: number, count: () => Promise<number>): Promise<boolean> {
  await page.evaluate(() => { (globalThis as any).__name ??= (f: unknown) => f; }); // tsx keepNames, as in readForm
  const clicked = await page.evaluate((section) => {
    const text = (e: Element | null) => (e?.textContent ?? "").replace(/\s+/g, "");
    // D14: the closest title wins — 「实习经历」 must not pick the button of a block called 「经历」; a bare 「经历」 title never matches a longer section
    const want = section.replace(/\s+/g, "");
    // 北森 (2022 form): the group's own button, #<group id>_addButton, reads 「添加」 + the group's title
    const own = Array.from(document.querySelectorAll("[id$='_addButton']")).find((b) => text(b).replace(/^.*(添加|新增)/, "") === want && (b as HTMLElement).offsetHeight > 0);
    if (own) { own.setAttribute("data-jobos-add", "1"); return true; }
    const titled = Array.from(document.querySelectorAll("[class*='blockTitle'], [class*='block-title'], .createFormSection-title")).map((t) => ({ t, name: text(t).replace(/(添加|新增|\+).*$/, "") }))
      .filter(({ name }) => name === want || (name.length >= 2 && (name.includes(want) || (want.includes(name) && name.length >= want.length - 1))))
      .sort((a, b) => Math.abs(a.name.length - want.length) - Math.abs(b.name.length - want.length));
    const titles = titled.map(({ t }) => t);
    for (const t of titles) {
      // 飞书 puts the button beside the title, in the section: .createFormSection-addBtn / .formOperate-addBtn
      const scope = t.matches(".createFormSection-title") ? t.closest(".createFormSection") ?? t.parentElement! : t;
      const btn = scope.querySelector(".createFormSection-addBtn, .formOperate-addBtn") ?? Array.from(scope.querySelectorAll("*")).reverse().find((e) => /^(\+)?(添加|新增)$/.test(text(e)) && (e as HTMLElement).offsetHeight > 0);
      if (btn) { (btn as HTMLElement).setAttribute("data-jobos-add", "1"); return true; }
    }
    return false;
  }, section).catch(() => false);
  if (!clicked) return false;
  await page.locator("[data-jobos-add]").first().click({ timeout: 3000 }).catch(() => {});
  await page.evaluate(() => document.querySelectorAll("[data-jobos-add]").forEach((e) => e.removeAttribute("data-jobos-add"))).catch(() => {});
  for (let t = Date.now(); Date.now() - t < 3000; ) { if ((await count()) > before) return true; await page.waitForTimeout(200); }
  return false;
}
