import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { inflateRawSync } from "node:zlib";
import { mkdirSync, readFileSync, writeFileSync, readdirSync, statSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { basename, extname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import type { Db } from "../db.js";
import { now, tx } from "../db.js";
import type { Llm } from "../llm.js";
import { DomainError, NotFound } from "./domain.js";
import { FACT_KINDS, upsertFact, listFacts } from "./profile.js";
import { articleText } from "./extract.js";

const run = promisify(execFile);
export const SUPPORTED = [".html", ".htm", ".docx", ".tex", ".md", ".txt", ".pdf", ".png", ".jpg", ".jpeg", ".webp"];
const IMAGE_MIME: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };

/** One entry out of a zip (a .docx is a zip). ponytail: no zip64, no encryption — a Word file has neither. */
export function readZipEntry(buf: Buffer, name: string): Buffer | null {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  if (eocd < 0) return null;
  let p = buf.readUInt32LE(eocd + 16);
  for (let n = buf.readUInt16LE(eocd + 10); n > 0 && buf.readUInt32LE(p) === 0x02014b50; n--) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20), nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    if (buf.toString("utf8", p + 46, p + 46 + nameLen) === name) {
      const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      const data = buf.subarray(start, start + csize);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

export function docxText(buf: Buffer): string {
  const xml = readZipEntry(buf, "word/document.xml")?.toString("utf8");
  if (!xml) throw new DomainError("BAD_FILE", "不是有效的 .docx（找不到 word/document.xml）");
  return xml.replace(/<\/w:p>/g, "\n").replace(/<w:tab\/>/g, "\t").replace(/<w:br\/>/g, "\n").replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/\n{3,}/g, "\n\n").trim();
}

/** A readable (not faithful) HTML view of a .docx: paragraphs, bold, tabs, table rows. Layout, fonts and columns are Word's business. */
export function docxHtml(buf: Buffer): string {
  const xml = readZipEntry(buf, "word/document.xml")?.toString("utf8");
  if (!xml) throw new DomainError("BAD_FILE", "不是有效的 .docx");
  const esc = (s: string) => s.replace(/&(?!amp;|lt;|gt;|quot;|apos;)/g, "&amp;");
  const runs = (p: string) => [...p.matchAll(/<w:r[ >][\s\S]*?<\/w:r>/g)].map((m) => {
    // "<w:t" must be followed by ">" or a space: "<w:t[^>]*>" would also swallow "<w:tab/>"
    const text = [...m[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((x) => (x[1] != null ? esc(x[1]) : x[0].startsWith("<w:tab") ? "&emsp;" : "<br>")).join("");
    return /<w:b\/>|<w:b w:val="(1|true)"/.test(m[0]) ? `<b>${text}</b>` : text;
  }).join("");
  const body = xml.replace(/<w:tbl>[\s\S]*?<\/w:tbl>/g, (tbl) => "<table>" + [...tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)].map((tr) => "<tr>" + [...tr[0].matchAll(/<w:tc>[\s\S]*?<\/w:tc>/g)].map((tc) => `<td>${[...tc[0].matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((p) => runs(p[0])).join("<br>")}</td>`).join("") + "</tr>").join("") + "</table>");
  return body.replace(/<w:p[ >][\s\S]*?<\/w:p>/g, (p) => { const h = /<w:pStyle w:val="(Heading|标题|[1-3]$)/.test(p); const t = runs(p); return t ? (h ? `<h3>${t}</h3>` : `<p>${t}</p>`) : ""; })
    .replace(/<\/?w:[^>]*>|<\?xml[^>]*>/g, "");
}

/** File → text, plus page images when the text layer is missing (scans, certificates). */
export async function extractText(file: string, ext: string): Promise<{ text: string; images: { data: string; mimeType: string }[] }> {
  if (IMAGE_MIME[ext]) return { text: "", images: [{ data: readFileSync(file).toString("base64"), mimeType: IMAGE_MIME[ext] }] };
  if (ext === ".docx") return { text: docxText(readFileSync(file)), images: [] };
  if (ext === ".html" || ext === ".htm") return { text: articleText(readFileSync(file, "utf8"), "file://").text, images: [] };
  if (ext !== ".pdf") return { text: readFileSync(file, "utf8"), images: [] };
  const { stdout } = await run("pdftotext", ["-layout", "-enc", "UTF-8", "-l", "12", file, "-"], { maxBuffer: 32 * 1024 * 1024 }).catch((e) => { throw new DomainError("PDFTOTEXT_FAILED", `pdftotext 不可用或失败：${e.message}`); });
  if (stdout.replace(/\s/g, "").length > 200) return { text: stdout, images: [] };
  // no text layer: render the first two pages and let a vision model read them
  const dir = mkdtempSync(join(tmpdir(), "jobos-pdf-"));
  try {
    await run("pdftoppm", ["-png", "-r", "110", "-f", "1", "-l", "2", file, join(dir, "p")]);
    return { text: stdout, images: readdirSync(dir).sort().map((f) => ({ data: readFileSync(join(dir, f)).toString("base64"), mimeType: "image/png" })) };
  } catch { return { text: stdout, images: [] }; } finally { rmSync(dir, { recursive: true, force: true }); }
}

const KIND_SPEC = `basic {field: 姓名|邮箱|电话|微信|出生年月|政治面貌|籍贯|现居地|预计毕业时间|英语水平|个人主页, value}
education {school, degree: 本科|硕士|博士, major, period}
publication {title, venue, year, status: 发表|录用|在审|在投, authorOrder}
patent {title, number, status: 授权|公开|申请, authorOrder}
project {title, role, period, summary}
experience {org, role, period, summary}
award {title, year, level: 国家级|省部级|校级|企业/行业|其他}
skill {name, level: 精通|熟练|了解}`;

const SYSTEM = `你从一个人的求职材料里抽取“事实卡”。只输出 JSON：{"docType":"简历|论文|专利|证书|报告|其他","facts":[{"kind":"…","data":{…},"quote":"…"}]}
可用的 kind 与字段（未知的字段省略，不要编）：
${KIND_SPEC}
规则：
1. 只写材料里明确写出的内容，不推断、不润色、不合并不同的事。数字、时间、名称照抄。
2. quote 是支持这张卡的原文片段，逐字摘录，不超过 80 字。
3. 简历：每段教育、每个项目、每段经历、每篇论文、每项专利、每个奖项、每项技能各一张卡。
4. 论文/专利全文：只出一张 publication / patent 卡（题目、期刊/会议或专利号、年份）。已知候选人姓名时，按作者列表里的位置填 authorOrder（第一作者 / 第二作者 / 第三作者 / 学生一作（导师一作） / 学生二作（导师一作） / 通讯作者 / 其他）；不知道姓名或不在作者列表里就省略 authorOrder。
5. 证书、奖状：一张 award 卡。开题报告、技术报告：一张 project 卡，summary 写报告自己陈述的研究内容。
6. 与求职无关、或看不出属于这个人的材料：facts 为空数组。`;

export interface ExtractedFact { kind: string; data: Record<string, string>; quote: string }

export async function extractFacts(llm: Llm, doc: { name: string; text: string; images: { data: string; mimeType: string }[] }, candidateName: string): Promise<{ docType: string; facts: ExtractedFact[] }> {
  const model = llm.model();
  const canSee = (model as any).input?.includes?.("image");
  if (!doc.text.trim() && (!doc.images.length || !canSee)) throw new DomainError("NO_TEXT", "文件里没有可读文字（扫描件需要支持图片输入的模型）");
  const user = `文件名：${doc.name}\n候选人姓名：${candidateName || "未知"}\n\n内容：\n${doc.text.slice(0, 24_000)}${doc.images.length ? `\n\n（随附 ${doc.images.length} 张页面图片，请从图片读取）` : ""}`;
  const content: any[] = [{ type: "text", text: user }, ...(canSee ? doc.images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType })) : [])];
  const msg = await llm.models.completeSimple(model, { systemPrompt: SYSTEM, messages: [{ role: "user", content, timestamp: Date.now() }] }, { reasoning: "low" });
  const out = parseJsonWithRepair<{ docType?: string; facts?: ExtractedFact[] }>(contentText(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  return { docType: out.docType ?? "其他", facts: (out.facts ?? []).filter((f) => f && FACT_KINDS[f.kind] && f.data && typeof f.data === "object") };
}

// ---------- registry + background queue ----------

export interface Deps { db: Db; vault: string; llm?: Llm; onChanged?: () => void }

function docRow(r: any) {
  return { id: r.id as string, name: r.path as string, kind: r.kind as string, status: r.status as string, stage: r.stage as string, startedAt: (r.started_at ?? null) as string | null, facts: r.facts as number, error: r.error as string, addedAt: r.added_at as string, egress: r.egress as string };
}

export function listDocuments(db: Db) {
  return { items: (db.prepare("select * from document order by added_at desc").all() as any[]).map(docRow) };
}

/**
 * Register a file for extraction. Identity is the content hash, so re-scanning a folder only picks up new or changed files.
 * The original is copied into the vault: fact sources must stay openable after the user tidies their folders.
 */
export function addDocument(d: Deps, name: string, bytes: Buffer): { id: string; added: boolean } {
  const ext = extname(name).toLowerCase();
  if (!SUPPORTED.includes(ext)) throw new DomainError("UNSUPPORTED_FILE", `暂不支持 ${ext || "无扩展名"}（支持 ${SUPPORTED.join(" ")}）`);
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const found = d.db.prepare("select id, status from document where sha256 = ?").get(sha256) as { id: string; status: string } | undefined;
  if (found) {
    if (found.status === "failed") { d.db.prepare("update document set status = 'pending', error = '' where id = ?").run(found.id); void drain(d); }
    return { id: found.id, added: false };
  }
  const dir = join(d.vault, "profile", "documents");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, sha256 + ext), bytes);
  const id = ulid();
  d.db.prepare("insert into document(id, path, sha256, kind, text_path, egress, added_at, status) values (?,?,?,?,?,?,?,?)").run(id, name, sha256, "", "", "allow", now(), "pending");
  void drain(d);
  return { id, added: true };
}

/** Run extraction again on a stored file: cards deleted by mistake come back, existing cards keep their values. */
export function reextract(d: Deps, id: string) {
  if (d.db.prepare("update document set status = 'pending', error = '', stage = '' where id = ? and status in ('done', 'failed')").run(id).changes === 0) throw new NotFound(`document ${id}（不存在或正在处理）`);
  void drain(d);
  return { ok: true };
}

export function scanFolder(d: Deps, dir: string) {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new DomainError("FILE_NOT_FOUND", dir);
  const files: string[] = [];
  const walk = (p: string, depth: number) => { for (const e of readdirSync(p, { withFileTypes: true })) { const full = join(p, e.name); if (e.isDirectory()) { if (depth < 4 && !e.name.startsWith(".")) walk(full, depth + 1); } else if (SUPPORTED.includes(extname(e.name).toLowerCase())) files.push(full); } };
  walk(dir, 0);
  let added = 0;
  for (const f of files.slice(0, 200)) if (addDocument(d, relative(dir, f) || basename(f), readFileSync(f)).added) added++;
  return { found: files.length, added, skipped: files.length - added };
}

let running: Promise<void> | null = null;
/** One file at a time, in-process; concurrent callers share the same run. Rows left 'pending' by a restart are picked up again at startup. */
export function drain(d: Deps): Promise<void> {
  return (running ??= (async () => {
    try {
      await Promise.resolve(); // let the caller finish registering its batch first
      for (;;) {
        const r = d.db.prepare("select * from document where status = 'pending' order by added_at limit 1").get() as any;
        if (!r) break;
        const stage = (s: string) => d.db.prepare("update document set stage = ? where id = ?").run(s, r.id);
        d.db.prepare("update document set status = 'processing', stage = '读取文件', started_at = ? where id = ?").run(now(), r.id);
        try {
          if (r.egress !== "allow") throw new DomainError("EGRESS_DENIED", "这个文件被标记为不外发，未送模型");
          if (!d.llm) throw new DomainError("NO_MODEL", "未配置模型，无法抽取");
          const ext = extname(r.path).toLowerCase();
          const file = join(d.vault, "profile", "documents", r.sha256 + ext);
          const { text, images } = await extractText(file, ext);
          const textPath = join(d.vault, "profile", "documents", r.sha256 + ".txt");
          writeFileSync(textPath, text, "utf8");
          stage(images.length ? "模型读图抽取" : "模型抽取");
          const name = listFacts(d.db, { kind: "basic" }).items.find((f) => f.data.field === "姓名")?.data.value ?? "";
          const out = await extractFacts(d.llm, { name: r.path, text, images }, name);
          stage("写入事实卡");
          let n = 0;
          for (const f of out.facts) {
            try { upsertFact(d.db, { kind: f.kind, data: f.data, source: { documentId: r.id, quote: String(f.quote ?? "").slice(0, 200) } }, "材料自述"); n++; } catch { /* a card missing its required fields is dropped, the rest of the file still counts */ }
          }
          d.db.prepare("update document set status = 'done', kind = ?, text_path = ?, facts = ?, error = '' where id = ?").run(out.docType, textPath, n, r.id);
        } catch (e: any) {
          // ADR-032: waiting for an external agent's answer is not a failure; llm.reply puts the file back in the queue
          if (e?.code === "MODEL_DELEGATED") d.db.prepare("update document set status = 'waiting', stage = '等外部 agent 代答', error = '' where id = ?").run(r.id);
          else d.db.prepare("update document set status = 'failed', error = ? where id = ?").run(String(e?.message ?? e).slice(0, 500), r.id);
        }
        d.onChanged?.();
      }
    } finally { running = null; }
  })());
}

export function resumePending(d: Deps): void {
  d.db.prepare("update document set status = 'pending' where status in ('processing', 'waiting')").run(); // waiting: the model may have been switched meanwhile
  void drain(d);
}

// ---------- fuzzy duplicates: shown to the user, never merged automatically ----------

const bigrams = (s: string) => { const t = s.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ""); const out = new Set<string>(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
const dice = (a: Set<string>, b: Set<string>) => { if (!a.size || !b.size) return 0; let n = 0; for (const x of a) if (b.has(x)) n++; return (2 * n) / (a.size + b.size); };

export function duplicateCandidates(db: Db) {
  const facts = listFacts(db).items.filter((f) => !["basic", "direction", "exclude", "preference"].includes(f.kind));
  const label = (f: (typeof facts)[number]) => f.data.title || f.data.name || `${f.data.school ?? f.data.org ?? ""} ${f.data.degree ?? f.data.role ?? ""}`;
  const grams = new Map(facts.map((f) => [f.id, bigrams(label(f))]));
  const items = [];
  for (let i = 0; i < facts.length; i++) for (let j = i + 1; j < facts.length; j++) {
    if (facts[i].kind !== facts[j].kind) continue;
    if (facts[i].grade === "本人确认" && facts[j].grade === "本人确认") continue;
    const sim = dice(grams.get(facts[i].id)!, grams.get(facts[j].id)!);
    if (sim >= 0.7) items.push({ a: facts[i], b: facts[j], similarity: Math.round(sim * 100) / 100 });
  }
  return { items: items.sort((x, y) => y.similarity - x.similarity).slice(0, 50) };
}

/** Fold `fromId` into `intoId`: sources move, the survivor keeps its values and only gains fields it lacked. */
export function mergeFacts(db: Db, fromId: string, intoId: string) {
  const from = db.prepare("select * from fact where id = ?").get(fromId) as any, into = db.prepare("select * from fact where id = ?").get(intoId) as any;
  if (!from || !into) throw new NotFound(`fact ${from ? intoId : fromId}`);
  if (from.kind !== into.kind) throw new DomainError("KIND_MISMATCH", "只能合并同一类事实卡");
  const data = { ...JSON.parse(from.data_json), ...JSON.parse(into.data_json) };
  return tx(db, () => {
    db.prepare("update fact_source set fact_id = ? where fact_id = ?").run(intoId, fromId);
    db.prepare("update fact set data_json = ?, updated_at = ? where id = ?").run(JSON.stringify(data), now(), intoId);
    db.prepare("delete from fact where id = ?").run(fromId);
    return { ok: true };
  });
}
