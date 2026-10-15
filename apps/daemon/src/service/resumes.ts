import { ulid } from "ulid";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { extname, join } from "node:path";
import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import type { Db } from "../db.js";
import { json, now, tx } from "../db.js";
import type { Llm } from "../llm.js";
import { DomainError, NotFound } from "./domain.js";
import { extractText, docxHtml } from "./documents.js";

/**
 * 简历库 (ADR-013): resumes are written and polished by the user; Zhiro only keeps them, picks one per job, and — when
 * asked — comments on the fit. It never edits or generates a resume.
 *
 * Picking is rule-based so it is instant, free and explainable: each resume says which 公司类型 and which 岗位关键词 it
 * was written for, and a job is scored against both. The model is only involved when the user presses 分析.
 */
const RESUME_EXT = [".pdf", ".docx", ".html", ".htm", ".tex", ".md", ".txt"];
const low = (s: string) => (s ?? "").normalize("NFKC").toLowerCase();
const list = (v: unknown) => [...new Set((Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean))];

function row(r: any) {
  return { id: r.id as string, name: r.name as string, fileName: r.file_name as string, companyTypes: json.parse(r.company_types, [] as string[]), roleKeywords: json.parse(r.role_keywords, [] as string[]),
    note: r.note as string, isDefault: !!r.is_default, hasText: !!r.text_path && existsSync(r.text_path), filePath: r.file_path as string, createdAt: r.created_at as string };
}

export function listResumes(db: Db) {
  return { items: (db.prepare("select * from resume order by is_default desc, created_at").all() as any[]).map(row) };
}

export interface ResumeInput { id?: string; name?: string; fileName?: string; bytes?: Buffer; companyTypes?: string[]; roleKeywords?: string[]; note?: string; isDefault?: boolean }

export async function saveResume(db: Db, vault: string, p: ResumeInput) {
  const existing = p.id ? (db.prepare("select * from resume where id = ?").get(p.id) as any) : null;
  if (p.id && !existing) throw new NotFound(`resume ${p.id}`);
  const name = (p.name ?? existing?.name ?? "").trim(); // an update by id keeps the name unless a new one is given
  if (!name) throw new DomainError("MISSING_FIELD", "给这份简历起个名字，如「控制算法-民企版」");
  if (db.prepare("select 1 from resume where name = ? and id != ?").get(name, p.id ?? "")) throw new DomainError("DUPLICATE", `已有叫「${name}」的简历`);
  if (!existing && !p.bytes) throw new DomainError("MISSING_FIELD", "需要选择简历文件");
  const id = p.id ?? ulid();
  let filePath = existing?.file_path ?? "", textPath = existing?.text_path ?? "", fileName = existing?.file_name ?? "";
  if (p.bytes) {
    const ext = extname(p.fileName ?? "").toLowerCase();
    if (!RESUME_EXT.includes(ext)) throw new DomainError("UNSUPPORTED_FILE", `简历支持 ${RESUME_EXT.join(" ")}`);
    const dir = join(vault, "resume", "library"); mkdirSync(dir, { recursive: true });
    filePath = join(dir, id + ext); textPath = join(dir, id + ".txt"); fileName = p.fileName ?? "";
    writeFileSync(filePath, p.bytes);
    // text is only needed for the on-demand analysis; a scanned PDF simply has none
    writeFileSync(textPath, (await extractText(filePath, ext).catch(() => ({ text: "" }))).text, "utf8");
  }
  tx(db, () => {
    if (p.isDefault) db.prepare("update resume set is_default = 0").run();
    const first = !(db.prepare("select 1 from resume").get());
    if (existing) db.prepare("update resume set name = ?, file_name = ?, file_path = ?, text_path = ?, company_types = ?, role_keywords = ?, note = ?, is_default = ? where id = ?")
      .run(name, fileName, filePath, textPath, json.str(list(p.companyTypes ?? json.parse(existing.company_types, []))), json.str(list(p.roleKeywords ?? json.parse(existing.role_keywords, []))), p.note ?? existing.note, p.isDefault == null ? existing.is_default : p.isDefault ? 1 : 0, id);
    else db.prepare("insert into resume(id, name, file_name, file_path, text_path, company_types, role_keywords, note, is_default, created_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(id, name, fileName, filePath, textPath, json.str(list(p.companyTypes)), json.str(list(p.roleKeywords)), p.note ?? "", p.isDefault || first ? 1 : 0, now());
  });
  return { resume: row(db.prepare("select * from resume where id = ?").get(id)) };
}

export function removeResume(db: Db, id: string) {
  const r = db.prepare("select * from resume where id = ?").get(id) as any;
  if (!r) throw new NotFound(`resume ${id}`);
  db.prepare("delete from resume where id = ?").run(id);
  for (const f of [r.file_path, r.text_path]) if (f && existsSync(f)) rmSync(f);
  if (r.is_default) db.prepare("update resume set is_default = 1 where id = (select id from resume order by created_at limit 1)").run();
  return { ok: true };
}

const MIME: Record<string, string> = { ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".html": "text/html", ".htm": "text/html", ".tex": "text/plain", ".md": "text/plain", ".txt": "text/plain" };

/** For preview: the file as stored. PDF is shown as is; Word gets a simple HTML rendering (its real layout needs Word). */
export function resumeFile(db: Db, id: string) {
  const r = db.prepare("select * from resume where id = ?").get(id) as any;
  if (!r || !existsSync(r.file_path)) throw new NotFound(`resume ${id}`);
  const ext = extname(r.file_path).toLowerCase(), bytes = readFileSync(r.file_path);
  const html = ext === ".docx" ? docxHtml(bytes) : ext === ".html" || ext === ".htm" ? bytes.toString("utf8") : "";
  const text = ext === ".pdf" || ext === ".docx" || html ? "" : bytes.toString("utf8");
  return { name: r.name as string, fileName: r.file_name as string, mime: MIME[ext] ?? "application/octet-stream", dataBase64: ext === ".pdf" ? bytes.toString("base64") : "", html, text, path: r.file_path as string };
}

/**
 * Score every resume against one job. Both axes count, as the user asked: the 岗位 (keywords in the title weigh most,
 * then the JD) and the 公司类型 (央国企 / 民企 / 外企 / 研究院所 …). A resume with no tags is a generalist: it never
 * wins on merit, only as the default when nothing else matches.
 */
export function pickResume(db: Db, positionId: string) {
  const p = db.prepare(`select p.title, p.jd_text, co.name, co.type, co.industry from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id where p.id = ?`).get(positionId) as any;
  if (!p) throw new NotFound(`position ${positionId}`);
  const title = low(p.title), jd = low(p.jd_text), ctype = low(p.type), industry = low(p.industry);
  const scored = (db.prepare("select * from resume").all() as any[]).map((r) => {
    const x = row(r);
    const inTitle = x.roleKeywords.filter((k) => title.includes(low(k)));
    const inJd = x.roleKeywords.filter((k) => !title.includes(low(k)) && jd.includes(low(k)));
    const types = x.companyTypes.filter((t) => ctype.includes(low(t)) || industry.includes(low(t)));
    const score = 3 * inTitle.length + Math.min(inJd.length, 3) + (types.length ? 2 : 0);
    const reason = [inTitle.length && `岗位名含 ${inTitle.join("/")}`, inJd.length && `JD 提到 ${inJd.join("/")}`, types.length && `公司类型 ${types.join("/")}`].filter(Boolean).join("；");
    return { resume: x, score, reason };
  }).sort((a, b) => b.score - a.score || Number(b.resume.isDefault) - Number(a.resume.isDefault) || a.resume.createdAt.localeCompare(b.resume.createdAt));
  const best = scored[0] ?? null;
  return {
    position: { title: p.title as string, companyName: p.name as string, companyType: p.type as string },
    pick: best && { ...best, reason: best.score > 0 ? best.reason : "没有哪份简历的标签对上这个岗位，先用默认的那份" },
    alternatives: scored.slice(1),
  };
}

const ANALYZE = `你是一位严格的校招简历顾问。给你一份简历和一个岗位，判断匹配度并给修改意见。只输出 JSON：
{"fit":"高|中|低","summary":"一句话结论","strengths":["简历里已有、且岗位看重的点（引用简历原话的要点）"],"gaps":["岗位要求而简历没有体现的点"],"suggestions":["具体到'把哪一条挪到哪里/哪句话怎么调整重点'的修改意见"]}
规则：
- 只依据简历里写了的内容，不要替候选人编经历、数字或技能；简历没有的就放进 gaps，不要建议"补充"不存在的经历。
- suggestions 只谈顺序、取舍、措辞重点、关键词对齐，每条一句话，最多 6 条。
- 不要重写简历，不要输出简历正文。`;

/** On demand only (the 分析 button): resume text + JD go to the model, advice comes back; nothing is changed. */
export async function analyzeResume(db: Db, llm: Llm | undefined, resumeId: string, positionId: string) {
  if (!llm) throw new DomainError("NO_MODEL", "未配置模型，无法分析");
  const r = db.prepare("select * from resume where id = ?").get(resumeId) as any;
  if (!r) throw new NotFound(`resume ${resumeId}`);
  const p = db.prepare(`select p.title, p.jd_text, p.degree_req, c.major_req, co.name, co.type from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id where p.id = ?`).get(positionId) as any;
  if (!p) throw new NotFound(`position ${positionId}`);
  const text = r.text_path && existsSync(r.text_path) ? readFileSync(r.text_path, "utf8") : "";
  if (text.replace(/\s/g, "").length < 100) throw new DomainError("NO_TEXT", "这份简历读不出文字（可能是扫描件 PDF），无法分析；换成 docx 或文字版 PDF");
  const user = `## 岗位\n公司：${p.name}（${p.type || "类型未知"}）\n岗位：${p.title}\n学历/专业要求：${p.degree_req || "未写"} / ${p.major_req || "未写"}\nJD：\n${(p.jd_text || "（来源没有提供 JD 正文，只能按岗位名判断）").slice(0, 4000)}\n\n## 简历「${r.name}」\n${text.slice(0, 12_000)}`;
  const msg = await llm.models.completeSimple(llm.model(), { systemPrompt: ANALYZE, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] }, { reasoning: "low" });
  const o = parseJsonWithRepair<any>(contentText(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 8) : []);
  return { resumeName: r.name as string, hasJd: !!p.jd_text, fit: ["高", "中", "低"].includes(o.fit) ? (o.fit as string) : "中", summary: String(o.summary ?? ""), strengths: arr(o.strengths), gaps: arr(o.gaps), suggestions: arr(o.suggestions) };
}
