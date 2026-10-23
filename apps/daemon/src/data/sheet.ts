import type { Listing, SourceConfig } from "./types.js";
import { sha } from "./catalog.js";

/** What a table of postings is made of: CSV text, a deadline cell, a list cell, the grade its 来源 column implies. */

/** Minimal RFC4180 parser: quotes, escaped quotes, CRLF, BOM. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQ = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQ) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = ""; rows.push(row); row = [];
    } else field += c;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((f) => f.trim() !== ""));
}

export function parseDeadline(text: string): { closesAt: string | null; kind: "date" | "rolling" | "until_filled" | "unknown" } {
  const t = (text ?? "").trim();
  if (!t) return { closesAt: null, kind: "unknown" };
  if (/招满|长期|滚动|持续|尽快|随时/.test(t)) return { closesAt: null, kind: /滚动|持续|尽快|随时/.test(t) ? "rolling" : "until_filled" };
  const m = t.match(/(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/);
  if (m) return { closesAt: `${m[1]}-${m[2].padStart(2, "0")}-${m[3].padStart(2, "0")}`, kind: "date" };
  const md = t.match(/(\d{1,2})月(\d{1,2})日?/);
  if (md) {
    const y = new Date().getFullYear();
    return { closesAt: `${y}-${md[1].padStart(2, "0")}-${md[2].padStart(2, "0")}`, kind: "date" };
  }
  return { closesAt: null, kind: "unknown" };
}

export function splitList(s: string): string[] {
  return (s ?? "").split(/[，,、;；|\s]+/).map((x) => x.trim()).filter(Boolean);
}

export function gradeFromSource(source: string, noticeUrl: string): string {
  if (/官网|官方|校园招聘网|careers|mokahr|beisen|zhiye/i.test(source + noticeUrl)) return "官方";
  if (/就业|高校|大学|学院/.test(source)) return "校方转载";
  if (/mp\.weixin|公众号/.test(source + noticeUrl)) return "校方转载";
  return "聚合";
}

// ---------- a table of postings, whatever it came from ----------

/** A table as a reader hands it over: its column names, and rows that answer by column name. */
export interface Table { headers: string[]; rows: TableRow[] }
export interface TableRow {
  /** the table's own id for the row when it has one (a Bitable record id); "" otherwise */
  id: string;
  /** the cell under a column; `link` asks for the address behind a link cell where the table knows one */
  get(header: string, want?: "text" | "link"): string;
}

/** What a row can say about a posting, with the word a person sees for it. Only 公司 is required. */
export const FIELDS = {
  company: "公司", positions: "岗位", deadline: "截止时间", applyUrl: "投递链接", noticeUrl: "公告链接", cities: "工作地点", degree: "学历要求",
  major: "专业要求", cohort: "届次", batch: "批次", companyType: "企业类型", industry: "行业", source: "信息来源",
} as const;
export type Field = keyof typeof FIELDS;
/** field → the column that holds it */
export type Columns = Partial<Record<Field, string>>;

/** The 17-column 校招汇总表 layout this system started with. A subscription with no mapping of its own reads by exactly these names. */
export const BUILTIN_COLUMNS: Record<Field, string> = {
  company: "公司", positions: "招聘岗位", deadline: "截止时间", applyUrl: "简历投递链接", noticeUrl: "公告链接", cities: "工作地点", degree: "学历要求",
  major: "专业要求", cohort: "招聘届次", batch: "批次", companyType: "企业类型", industry: "行业类别", source: "公告来源",
};

/** What people call these columns. The first of each list is the built-in name. */
const ALIASES: Record<Field, string[]> = {
  company: ["公司", "公司名称", "企业", "企业名称", "单位", "单位名称", "用人单位", "招聘单位", "company", "employer"],
  positions: ["招聘岗位", "岗位", "岗位名称", "职位", "职位名称", "招聘职位", "岗位类别", "position", "title", "job"],
  deadline: ["截止时间", "截止日期", "截止", "网申截止", "投递截止", "报名截止", "ddl", "deadline"],
  applyUrl: ["简历投递链接", "投递链接", "网申链接", "网申地址", "投递地址", "申请链接", "投递方式", "apply"],
  noticeUrl: ["公告链接", "招聘公告", "原文链接", "详情链接", "公告", "链接", "notice", "url", "link"],
  cities: ["工作地点", "地点", "城市", "工作城市", "location", "city"],
  degree: ["学历要求", "学历", "degree"],
  major: ["专业要求", "专业", "major"],
  cohort: ["招聘届次", "届次", "届别", "毕业年份", "cohort"],
  batch: ["批次", "招聘批次", "招聘类型", "batch"],
  companyType: ["企业类型", "公司类型", "单位性质", "企业性质"],
  industry: ["行业类别", "行业", "所属行业", "industry"],
  source: ["公告来源", "信息来源", "来源", "source"],
};
const plain = (s: string) => s.normalize("NFKC").replace(/[\s:：()（）_\-/]/g, "").toLowerCase();

/**
 * Which column is which, from the column names alone: a name that is one of the usual ones first, then a name that
 * contains one. A guess — the person sees it before anything is filed and can change it; it is then kept with the
 * subscription and never guessed again.
 */
export function guessColumns(headers: string[]): Columns {
  const out: Columns = {}, taken = new Set<string>();
  for (const exact of [true, false]) for (const f of Object.keys(ALIASES) as Field[]) {
    if (out[f]) continue;
    const h = headers.find((h) => !taken.has(h) && ALIASES[f].some((a) => (exact ? plain(h) === plain(a) : plain(h).includes(plain(a)))));
    if (h) { out[f] = h; taken.add(h); }
  }
  return out;
}

/**
 * A cell that lists several things: separated by 、，,；; | or a line break — and by spaces only where every word is
 * Chinese (「武汉 上海」 is two cities, 「算法工程师 测试工程师」 two posts; "Saint Paul" is one, "AI Computing Software
 * Development Intern" one post, 「算法工程师 AI」 one). The built-in layout used to split on every space: NVIDIA's one
 * English post became five (「AI」「Computing」…; 2026-10-23).
 */
export function splitCell(s: string): string[] {
  const han = /[㐀-鿿]/;
  return (s ?? "").split(/[，,、;；|\n\r]+/).flatMap((part) => {
    const words = part.trim().split(/\s+/).filter(Boolean);
    return words.length > 1 && words.every((w) => han.test(w)) ? words : [part.trim()];
  }).filter(Boolean);
}

/**
 * Rows → listings, one per job title in a row. A row with no company is nobody's; a row whose deadline has passed has
 * nothing to apply to (and would triple the pool); with a cohort asked for, other cohorts are left out. A row that cites
 * the official site is still someone's transcription of it: never graded 官方 (ADR-015).
 */
export function tableToListings(table: Table, columns: Columns, cfg: { cohort?: string; name?: string }, today = new Date().toISOString().slice(0, 10), publisher = "汇总表"): Listing[] {
  const get = (row: TableRow, f: Field, want?: "text" | "link") => (columns[f] ? row.get(columns[f]!, want) : "");
  const wantCohort = (cfg.cohort ?? "").replace(/\D/g, "");
  const split = splitCell;
  const out: Listing[] = [];
  for (const row of table.rows) {
    const company = get(row, "company").trim();
    const cohort = get(row, "cohort");
    if (!company || (wantCohort && columns.cohort && !cohort.includes(wantCohort))) continue;
    const deadlineText = get(row, "deadline");
    const dl = parseDeadline(deadlineText);
    if (dl.closesAt && dl.closesAt < today) continue;
    const batch = get(row, "batch"), sourceText = get(row, "source");
    const noticeUrl = get(row, "noticeUrl", "link") || get(row, "noticeUrl");
    const applyUrl = get(row, "applyUrl", "link") || get(row, "applyUrl");
    const titles = split(get(row, "positions")).slice(0, 40);
    const g = gradeFromSource(sourceText, noticeUrl);
    // a table with no ids of its own: the row is the company's row for that batch
    const rowId = row.id || sha(`${company}|${cohort}|${batch}`).slice(0, 16);
    for (const title of titles.length ? titles : [batch || "校招"]) {
      out.push({
        externalId: `${rowId}|${title}`, url: applyUrl || noticeUrl, noticeUrl, title, company,
        companyType: get(row, "companyType"), industry: get(row, "industry"),
        locations: split(get(row, "cities")), deadlineText, degreeReq: get(row, "degree"), majorReq: get(row, "major"),
        cohort, batch, kind: /博士/.test(batch + title) ? "博士专项" : /实习/.test(batch) ? "实习" : "校招",
        publisher: cfg.name || publisher, grade: (g === "官方" ? "聚合" : g) as Listing["grade"],
        isOriginal: false, confidence: 0.7,
      });
    }
  }
  return out;
}

/** What a table reader's `fetch` is: the table, read by the subscription's own mapping (the built-in one when it has none). */
export function listingsFromTable(table: Table, cfg: SourceConfig, publisher: string): Listing[] {
  const columns = (cfg.columns as Columns | undefined) ?? BUILTIN_COLUMNS;
  if (!columns.company || !table.headers.includes(columns.company)) throw new Error(`NO_COMPANY_COLUMN: 表里没有「${columns.company ?? "公司"}」这一列（现有的列：${table.headers.slice(0, 12).join("、")}）`);
  return tableToListings(table, columns, cfg, undefined, publisher);
}

/** CSV text as a table: the first row names the columns. */
export function csvToTable(text: string): Table {
  const [head = [], ...rows] = parseCsv(text);
  const headers = head.map((h) => h.trim());
  const at = new Map(headers.map((h, i) => [h, i]));
  return { headers, rows: rows.map((r) => ({ id: "", get: (h) => (r[at.get(h) ?? -1] ?? "").trim() })) };
}
