/**
 * The person's own 「系统填写」 document (a .docx they keep for application forms): when it is configured
 * (`apply.referenceDoc` in jobos.yaml), it is read afresh at every run and wins over the profile for what it covers —
 * their awards list, projects, 特长 / 爱好 / 自我评价, and a 「网申常见栏目」 section of 「栏目：值」 lines. It is theirs and
 * curated; the profile's cards were extracted from many documents and carry near-duplicates.
 *
 * Reading is deterministic (no model): paragraphs of word/document.xml, recognised by their headings. Lines it does not
 * understand are ignored, never guessed at. A value written as 待填 / 空 is no value.
 */
import { readFileSync, statSync } from "node:fs";
import { zipRead } from "./zip.js";

export interface ReferenceRecord { title: string; year?: string; level?: string; note?: string; period?: string; description?: string; role?: string; summary?: string }
export interface Reference { path: string; fields: Map<string, string>; awards: ReferenceRecord[]; projects: ReferenceRecord[] }

/** 「待填」, 「待填（省份，如 湖南省）」, 空, —: not answered yet */
const BLANK = /^((待填|待补).*|空|无|-+|—+|\?+|？+)?$/;
/** The paragraphs of a .docx, as text. */
export function docxParagraphs(buf: Buffer): string[] {
  const xml = zipRead(buf).find((e) => e.name === "word/document.xml")?.data.toString("utf8") ?? "";
  const body = xml.slice(Math.max(0, xml.indexOf("<w:body")));
  return body.split("</w:p>").map((chunk) => [...chunk.matchAll(/<w:t(?:\s[^>]*)?>([^<]*)<\/w:t>/g)].map((m) => m[1]).join("")
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'").replace(/&amp;/g, "&").trim());
}

/** 「2026年 湖北省…一等奖（省级，团队项目《…》）」 → title, year, level, note. Two awards in one line (「物理竞赛三等奖、数学竞赛三等奖」) are two. */
export function parseAward(line: string): ReferenceRecord[] {
  const m = line.match(/^\s*\d+[.、．]\s*(\d{4})\s*年\s*(.+)$/);
  if (!m) return [];
  let rest = m[2].trim(), level = "", note = "";
  const tail = rest.match(/（([^（）]*)）\s*$/);
  if (tail && /级|国际|国家|省|校|院|团队/.test(tail[1])) {
    rest = rest.slice(0, tail.index).trim();
    const parts = tail[1].split(/[，,]/).map((p) => p.trim());
    level = parts.find((p) => /级$|^国际/.test(p)) ?? "";
    note = parts.filter((p) => p !== level).join("，");
  }
  const pieces = rest.split("、").map((p) => p.trim()).filter(Boolean);
  const titles = pieces.length > 1 && pieces.every((p) => /奖|员|生|题/.test(p)) ? pieces : [rest];
  // 「中国地质大学（武汉）物理竞赛三等奖、数学竞赛三等奖」: the second one keeps the first one's institution
  const org = titles.length > 1 ? (titles[0].match(/^(.*?(大学|学院)(（[^）]*）)?)/)?.[1] ?? "") : "";
  return titles.map((t, i) => ({ title: i > 0 && org && !t.startsWith(org) ? org + t : t, year: m[1], ...(level ? { level } : {}), ...(note ? { note } : {}) }));
}

const KEY = /^\s*([^：:]{1,24})[：:]\s*(.*)$/;
const PROJECT_KEYS: [RegExp, keyof ReferenceRecord][] = [[/项目名称|^名称$/, "title"], [/起止|时间/, "period"], [/项目(描述|简介|介绍)|^描述$|项目层次|层次/, "description"], [/担任|角色|身份/, "role"], [/职责|工作内容|负责/, "summary"]];

export function parseReference(paragraphs: string[], path = ""): Reference {
  const fields = new Map<string, string>(), awards: ReferenceRecord[] = [], projects: ReferenceRecord[] = [];
  let section = "", project: ReferenceRecord | null = null;
  const lines = paragraphs.filter((p) => p && !/^\d+\/\d+$/.test(p)); // 「68/2000」: a character counter copied from a form
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i], bare = l.replace(/^[*＊\s]+/, "");
    // headings
    if (/^奖励/.test(bare) || /^一、奖励/.test(bare)) { section = "awards"; continue; }
    if (/惩处|^主要专业成果|^奖惩信息$/.test(bare)) { section = ""; continue; }
    if (/^(网申常见栏目|常见栏目|基本信息补充)/.test(bare)) { section = "fields"; continue; }
    if (/^项目经历|^项目经验/.test(bare)) { section = "projects"; continue; }
    if (/^爱好$/.test(bare)) { const v = lines[i + 1] ?? ""; if (v && !BLANK.test(v)) fields.set("爱好", v); i++; continue; }
    if (/^(特长|个人特长)$/.test(bare)) {
      const out: string[] = [];
      while (i + 1 < lines.length && /^\s*\d+[.、．]/.test(lines[i + 1])) out.push(lines[++i]);
      if (out.length) { fields.set("个人特长", out.join("\n")); fields.set("特长", out.join("\n")); }
      continue;
    }
    if (/^(自我评价|自我描述)$/.test(bare)) {
      const out: string[] = [];
      while (i + 1 < lines.length && !/^(另外的版本|其他版本|[*＊]?\S{1,8}$)/.test(lines[i + 1])) out.push(lines[++i]);
      if (out.length) fields.set("自我评价", out.join("\n"));
      continue;
    }
    if (section === "awards") { awards.push(...parseAward(l)); continue; }
    if (section === "fields") { const m = l.match(KEY); if (m && !BLANK.test(m[2].trim()) && !/^(说明|备注|注)$/.test(m[1].trim())) fields.set(m[1].trim(), m[2].trim()); continue; }
    if (section === "projects") {
      const m = l.match(KEY);
      if (!m) continue;
      const key = PROJECT_KEYS.find(([re]) => re.test(m[1].trim()))?.[1];
      if (!key) continue;
      if (key === "title") { project = { title: m[2].trim() }; projects.push(project); continue; }
      if (project && !BLANK.test(m[2].trim())) (project as any)[key] = m[2].trim();
    }
  }
  return { path, fields, awards, projects };
}

let cache: { path: string; mtime: number; ref: Reference } | null = null;
/** The configured document, read again whenever it changed. Null when none is configured or it cannot be read. */
export function readReference(path: string | undefined): Reference | null {
  if (!path) return null;
  try {
    const mtime = statSync(path).mtimeMs;
    if (cache && cache.path === path && cache.mtime === mtime) return cache.ref;
    const ref = parseReference(docxParagraphs(readFileSync(path)), path);
    cache = { path, mtime, ref };
    return ref;
  } catch { return null; }
}
