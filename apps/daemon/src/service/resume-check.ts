import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { extname } from "node:path";
import type { Db } from "../db.js";
import { NotFound } from "./domain.js";
import { readZipEntry, docxText } from "./documents.js";

const run = promisify(execFile);

/**
 * What an HR person could see in the file besides the page itself: document properties (标题 / 作者 / 主题 / 关键词 /
 * 生成软件) and leftovers in the text. Flags AI tool names, draft/version/template words ("通用 v6"), someone else as
 * author, and markdown or placeholder remnants. It only reports — the user's file is never changed.
 */
export interface Trace { where: string; found: string; advice: string }

const AI = /codex|chat\s*gpt|\bgpt[-\s]?\d|claude|openai|gemini|copilot|kimi|豆包|文心|通义|deepseek|智谱|ai\s*生成|人工智能生成/i;
const DRAFT = /\bv\d+(\.\d+)*\b|版本|模板|通用|定向|草稿|副本|修改|final|draft|copy|test/i;
const GENERATOR = /python|reportlab|docx4j|pandoc|wkhtmltopdf|puppeteer|playwright|headless|weasyprint|typst|skia/i;

async function pdfProps(file: string): Promise<Record<string, string>> {
  const { stdout } = await run("pdfinfo", ["-enc", "UTF-8", "-custom", file]).catch(() => ({ stdout: "" }));
  return Object.fromEntries(stdout.split(/\r?\n/).map((l) => l.match(/^([A-Za-z]+):\s*(.*)$/)).filter(Boolean).map((m) => [m![1], m![2].trim()]));
}

function docxProps(buf: Buffer): Record<string, string> {
  const xml = (readZipEntry(buf, "docProps/core.xml")?.toString("utf8") ?? "") + (readZipEntry(buf, "docProps/app.xml")?.toString("utf8") ?? "");
  const tag = (t: string) => xml.match(new RegExp(`<(?:\\w+:)?${t}[^>]*>([^<]*)<`))?.[1]?.trim() ?? "";
  return { Title: tag("title"), Subject: tag("subject"), Keywords: tag("keywords"), Comments: tag("description"), Author: tag("creator"), LastModifiedBy: tag("lastModifiedBy"), Creator: tag("Application"), Company: tag("Company") };
}

const NAMES: Record<string, string> = { Title: "标题", Subject: "主题", Keywords: "关键词", Comments: "备注", Author: "作者", LastModifiedBy: "最后修改者", Creator: "生成软件", Producer: "PDF 生成器", Company: "单位" };

export async function checkResume(db: Db, id: string): Promise<{ items: Trace[] }> {
  const r = db.prepare("select file_path from resume where id = ?").get(id) as { file_path: string } | undefined;
  if (!r) throw new NotFound(`resume ${id}`);
  if (!r.file_path || !existsSync(r.file_path)) return { items: [] };
  const docx = extname(r.file_path).toLowerCase() === ".docx";
  const buf = docx ? readFileSync(r.file_path) : null;
  const props = docx ? docxProps(buf!) : await pdfProps(r.file_path);
  const owner = (db.prepare("select data_json from fact where kind = 'basic'").all() as { data_json: string }[]).map((x) => JSON.parse(x.data_json)).find((d) => d.field === "姓名")?.value ?? "";

  const items: Trace[] = [];
  const prop = (key: string, advice: string) => items.push({ where: `文件属性 · ${NAMES[key] ?? key}`, found: props[key], advice });
  for (const key of Object.keys(NAMES)) {
    const v = props[key] ?? "";
    if (!v) continue;
    if (AI.test(v)) prop(key, "含 AI 工具名，改掉或清空");
    else if (["Title", "Subject", "Keywords", "Comments"].includes(key) && DRAFT.test(v)) prop(key, `看得出是某个版本/模板，建议改成「${owner || "姓名"}简历」或清空`);
    else if (["Author", "LastModifiedBy"].includes(key) && owner && !v.includes(owner)) prop(key, "不是你本人的名字，改成你的名字或清空");
    else if (["Creator", "Producer"].includes(key) && GENERATOR.test(v)) prop(key, "看得出是程序生成的，用 WPS / Word 另存一次 PDF 可以换掉");
  }

  const text = docx ? docxText(buf!) : (await run("pdftotext", ["-layout", "-enc", "UTF-8", r.file_path, "-"], { maxBuffer: 16 * 1024 * 1024 }).catch(() => ({ stdout: "" }))).stdout;
  const line = (re: RegExp) => text.split(/\r?\n/).find((l) => re.test(l))?.trim().slice(0, 60) ?? "";
  if (AI.test(text)) items.push({ where: "正文", found: line(AI), advice: "正文里出现了 AI 工具名，确认是否有意写上" });
  const md = /\*\*[^*\n]+\*\*|^#{1,4}\s|```|^\s*[-*]\s\[[ x]\]/m;
  if (md.test(text)) items.push({ where: "正文", found: line(md), advice: "像是 Markdown 的残留符号（** / ## / ```），删掉" });
  const ph = /X{3,}|［\s*］|\[\s*(姓名|名字|公司|学校|日期|职位)\s*\]|（示例）|\(示例\)|TODO|待补充|待填写/;
  if (ph.test(text)) items.push({ where: "正文", found: line(ph), advice: "像是没替换掉的占位符" });
  return { items };
}
