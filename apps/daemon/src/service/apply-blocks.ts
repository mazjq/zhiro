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
type Kind = "education" | "experience" | "project" | "award";

// N10: 「学习经历」「学历信息」「求学经历」 are the same block as 「教育经历」
const BLOCKS: [RegExp, Kind][] = [[/教育|学习经历|学历信息|学历背景|求学/, "education"], [/实习/, "experience"], [/项目/, "project"], [/获奖|奖项|荣誉/, "award"]];
export const blockKind = (section: string): Kind | null => BLOCKS.find(([re]) => re.test(section))?.[1] ?? null;

/** Which part of a record a field inside an entry asks for. */
export function partOf(kind: Kind, label: string): string {
  const l = normLabel(label);
  if (/起止|就读|时间|日期/.test(l)) return "period";
  if (kind === "education") return /学校|院校/.test(l) ? "school" : /专业/.test(l) ? "major" : /学历|学位/.test(l) ? "degree" : "";
  if (kind === "experience") return /公司|单位|企业|机构/.test(l) ? "org" : /职位|岗位|职务/.test(l) ? "role" : /职责|内容|描述/.test(l) ? "summary" : "";
  // 项目描述 is the project itself (what, at which level, why); 职责 / 角色 is what the person did in it (user, 2026-10-14)
  if (kind === "project") return /名称/.test(l) ? "title" : /职责|角色|职务|担任|负责|个人工作|本人工作/.test(l) ? "duty" : /描述|简介|介绍|内容|背景/.test(l) ? "description" : "";
  return /名称|奖项/.test(l) ? "title" : /级别/.test(l) ? "level" : "";
}

/** 「职责」 one line beside 「项目中职责」 a paragraph (a real Moka form, 2026-10-14): the line is the role, the paragraph what was done. */
export function projectPart(f: FormField, siblings: FormField[]): string {
  const p = partOf("project", f.label);
  return p === "duty" && f.type !== "textarea" && siblings.some((x) => x.type === "textarea" && partOf("project", x.label) === "duty") ? "role" : p;
}

const nameOf = (kind: Kind, d: Record<string, string>) => (kind === "education" ? d.school : kind === "experience" ? d.org : d.title) ?? "";
export const sameName = (a: string, b: string) => same(a, b);
const same = (a: string, b: string) => { const n = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase(); return !!a && !!b && (n(a).includes(n(b)) || n(b).includes(n(a))); };
/** One award spelled two ways on the profile (「…（本科组）· 全国一等奖」 / 「… · 全国一等奖」): compared without brackets, dots, the institution. */
const core = (s: string) => s.normalize("NFKC").replace(/\([^)]*\)|（[^）]*）|[·\s“”"']/g, "").replace(/^中国地质大学/, "").replace(/赛区|省/g, "").toLowerCase();
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
const filledName = (kind: Kind, s: Slot) => s.fields.find((f) => ["school", "org", "title"].includes(partOf(kind, f.label)) && !empty(f.value))?.value ?? "";
/** Nothing typed in any free-text box; a select showing its default (D3) does not make an entry occupied. */
const blank = (s: Slot) => s.fields.every((f) => ["select", "dropdown", "checkbox", "radio", "file"].includes(f.type) || empty(f.value));

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
    const records = recordsOf(facts, kind, ref);
    const mine = slots.filter((s) => s.section === section).sort((a, b) => a.entry - b.entry);
    // N6: an entry the site already part-filled (专业 but no 学校) is taken, not a blank to put our record into
    const open = mine.filter((s) => !filledName(kind, s) && blank(s));
    const taken = mine.filter((s) => !open.includes(s)).map((s) => filledName(kind, s));
    for (const record of records) {
      const name = nameOf(kind, record);
      if (taken.some((t) => same(t, name))) continue; // already on the form
      plans.push({ kind, section, record, name, slot: open.shift() ?? null });
    }
  }
  return plans;
}

/** The records of one kind, newest first: the person's document when it has the list, else the profile without near-duplicates. */
function recordsOf(facts: any[], kind: Kind, ref?: Reference | null): Record<string, string>[] {
  let records = facts.filter((f) => f.kind === kind && (kind !== "experience" || /实习/.test(`${f.data.role ?? ""}${f.data.summary ?? ""}${f.data.type ?? ""}`)))
    .map((f) => f.data as Record<string, string>);
  // the person's own document is the list when it has one (their curated awards, their projects)
  if (kind === "award" && ref?.awards.length) records = ref.awards as unknown as Record<string, string>[];
  if (kind === "project" && ref?.projects.length) records = ref.projects.map((p) => ({ ...(records.find((r) => same(r.title, p.title)) ?? {}), ...p }) as Record<string, string>);
  // near-duplicates on the profile go once
  return records.filter((r, i) => !records.slice(0, i).some((o) => core(nameOf(kind, o)) === core(nameOf(kind, r)))).sort((a, b) => startOf(b) - startOf(a));
}
export const planRecords = (db: Db, kind: Kind, ref?: Reference | null) => recordsOf(listFacts(db).items, kind, ref);

/** The value one field of an entry should get from a record; for a 年/月 range, the n-th box of it. */
export function valueIn(kind: Kind, record: Record<string, string>, f: FormField, nth: number, siblings: FormField[] = []): string {
  const part = kind === "project" ? projectPart(f, siblings) : partOf(kind, f.label);
  if (kind === "project" && part === "role") return record.role ?? "";
  // with a role box of its own, the duty box is what was done; otherwise role and what was done together
  if (kind === "project" && part === "duty") return siblings.some((x) => projectPart(x, siblings) === "role") && record.summary ? record.summary : [record.role, record.summary].filter(Boolean).join("：");
  if (kind === "project" && part === "description") {
    // no separate 职责 box in this entry: the project and what the person did, both here
    const hasDuty = siblings.some((x) => partOf(kind, x.label) === "duty");
    const duty = [record.role, record.summary].filter(Boolean).join("：");
    return hasDuty ? record.description ?? "" : [record.description, duty && `本人职责：${duty}`].filter(Boolean).join("\n");
  }
  if (part !== "period") return part ? record[part] ?? "" : "";
  const p = periodParts(record.period ?? (record.year ? `${record.year}-${record.year}` : ""));
  if (!p) return "";
  const boxes = [...p.start, ...p.end];
  if (/^(年|月)$/.test(f.placeholder)) return boxes[nth] ?? "";
  // 开始时间 / 结束时间 as one box each (北森)
  return /结束|毕业|离校|离职|截止/.test(f.label) ? p.end.filter(Boolean).join("-") : p.start.filter(Boolean).join("-");
}

/** Click the block's 「添加」 once and wait until one more entry exists. False if nothing appeared. */
export async function addEntry(page: Page, section: string, before: number, count: () => Promise<number>): Promise<boolean> {
  await page.evaluate(() => { (globalThis as any).__name ??= (f: unknown) => f; }); // tsx keepNames, as in readForm
  const clicked = await page.evaluate((section) => {
    const text = (e: Element | null) => (e?.textContent ?? "").replace(/\s+/g, "");
    // D14: the closest title wins — 「实习经历」 must not pick the button of a block called 「经历」; a bare 「经历」 title never matches a longer section
    const want = section.replace(/\s+/g, "");
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
