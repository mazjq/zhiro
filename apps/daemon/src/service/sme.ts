import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Db } from "../db.js";
import { now } from "../db.js";
import type { Services } from "../registry.js";
import type { WorkflowDef } from "./workflow.js";
import { readZipEntry, docxText } from "./documents.js";
import { readBase, parseBaseUrl } from "../data/index.js";
import { spawnRun, readRun } from "../agent/worker.js";

/**
 * 专精特新名录 is DATA, not part of the program (ADR-029 addendum): nothing ships in the repo; each user builds their
 * own roster. Two ways in, both writing sme_list rows that carry their source URL and an update time:
 *  - `intel.smeFromUrl`: a list the user points at (a gov.cn notice, a PDF/Excel/Word attachment, a public 飞书 sheet)
 *  - `intel.smeResearch`: the web worker finds the official list files for a province/batch and returns ONLY their
 *    URLs; the daemon downloads and parses them. The model never copies thousands of names (that was the expensive
 *    part: ~30 output tokens per company), so a whole province costs a few thousand tokens of search, not 100k.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
const run = promisify(execFile);

/** Company names in free text: a Chinese name ending in a legal form. Exported for tests. */
export function companyNames(text: string): string[] {
  const out = new Set<string>();
  // one cell at a time: gluing whitespace away would weld a neighbouring column onto the name
  const re = /[一-龥A-Za-z0-9（）()·]{2,40}?(?:股份有限公司|有限责任公司|集团有限公司|有限公司|研究院|研究所)/g;
  for (const cell of text.split(/[\s,，、;；|]+/)) {
    for (const m of cell.matchAll(re)) {
      const n = m[0].replace(/^(\d+|序号|企业名称|单位名称|名称)+/, "");
      if (n.length >= 6 && !/^(本|该|贵|我|各)/.test(n)) out.add(n);
    }
  }
  return [...out];
}

/** Plain text of a list file or page, whatever its format. */
export async function listText(url: string): Promise<string> {
  if (parseBaseUrl(url)) {
    const { records } = await readBase(url);
    return Object.values(records).map((r) => Object.values(r).map((c: any) => (typeof c?.value === "string" ? c.value : JSON.stringify(c?.value ?? ""))).join(" ")).join("\n");
  }
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const ct = res.headers.get("content-type") ?? "";
  const ext = (/\.(pdf|xlsx|docx|xls|doc|html?)(?:$|\?)/i.exec(url)?.[1] ?? "").toLowerCase();
  if (ct.includes("pdf") || ext === "pdf" || buf.subarray(0, 4).toString() === "%PDF") {
    const dir = mkdtempSync(join(tmpdir(), "jobos-sme-"));
    try { writeFileSync(join(dir, "a.pdf"), buf); return (await run("pdftotext", ["-layout", "-enc", "UTF-8", join(dir, "a.pdf"), "-"], { maxBuffer: 64 * 1024 * 1024 })).stdout; }
    finally { rmSync(dir, { recursive: true, force: true }); }
  }
  if (buf[0] === 0x50 && buf[1] === 0x4b) { // a zip: xlsx keeps cell text in sharedStrings, docx in document.xml
    const shared = readZipEntry(buf, "xl/sharedStrings.xml");
    if (shared) return shared.toString("utf8").replace(/<[^>]+>/g, " ");
    return docxText(buf);
  }
  if (ext === "xls" || ext === "doc") throw new Error("老式 .xls/.doc 读不了，请换成网页、PDF 或 xlsx/docx");
  return buf.toString("utf8").replace(/<script[\s\S]*?<\/script>/g, "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ");
}

export interface SmeSource { url: string; level: string; batch?: string; region?: string; published_at?: string }

export function upsertSme(db: Db, rows: { name: string; level: string; batch?: string; region?: string; source_url?: string; published_at?: string }[]): { inserted: number; updated: number } {
  const t = now();
  const up = db.prepare("insert into sme_list(name, level, batch, region, source_url, published_at, updated_at) values (?,?,?,?,?,?,?) on conflict(name, level) do update set batch = excluded.batch, region = excluded.region, source_url = excluded.source_url, published_at = excluded.published_at, updated_at = excluded.updated_at");
  const exists = db.prepare("select 1 from sme_list where name = ? and level = ?");
  let inserted = 0, updated = 0;
  db.exec("begin");
  try {
    for (const r of rows) {
      if (!r.name || !r.level) continue;
      if (exists.get(r.name, r.level)) updated++; else inserted++;
      up.run(r.name, r.level, r.batch ?? "", r.region ?? "", r.source_url ?? "", r.published_at ?? "", t);
    }
    db.exec("commit");
  } catch (e) { db.exec("rollback"); throw e; }
  return { inserted, updated };
}

/** Parse each source and load its names; a source that fails is reported, the others still land. */
export async function loadSources(db: Db, sources: SmeSource[]) {
  const results: { url: string; names: number; error: string }[] = [];
  let inserted = 0, updated = 0;
  for (const src of sources) {
    try {
      const names = companyNames(await listText(src.url));
      const r = upsertSme(db, names.map((name) => ({ name, level: src.level, batch: src.batch, region: src.region, source_url: src.url, published_at: src.published_at })));
      inserted += r.inserted; updated += r.updated;
      results.push({ url: src.url, names: names.length, error: names.length ? "" : "没从这个文件里认出企业名（可能是扫描件或需要登录）" });
    } catch (e: any) { results.push({ url: src.url, names: 0, error: String(e?.message ?? e).slice(0, 200) }); }
  }
  return { inserted, updated, sources: results };
}

const LEVELS = ["国家级小巨人", "国家级重点小巨人", "省级专精特新", "市级专精特新", "创新型中小企业"];
const SCHEMA = {
  type: "object", required: ["sources", "summary"],
  properties: {
    summary: { type: "string" },
    sources: { type: "array", items: { type: "object", required: ["url", "level"], properties: {
      url: { type: "string", description: "名单本身所在的网页或附件的直接链接（PDF/xlsx/docx/网页表格），不是新闻稿" },
      level: { type: "string", enum: LEVELS }, batch: { type: "string" }, region: { type: "string" }, published_at: { type: "string", description: "公示日期 YYYY-MM-DD 或 YYYY-MM" },
    } } },
  },
};

export function startSmeResearch(s: Services, region: string, hint = ""): { runId: string; workflowId: string } {
  const have = s.domain.db.prepare("select level, batch, count(*) n, max(updated_at) u from sme_list where region like ? group by level, batch order by level, batch").all(`%${region.replace(/(省|市|自治区)$/, "")}%`) as any[];
  const prompt = `任务：找「${region}」的专精特新企业名单文件。${hint ? `用户补充：${hint}\n` : ""}
今天：${now().slice(0, 10)}。只找官方或可靠转载的**名单本身**：工信部/省市工信（经信）厅局公示页、公告附件（PDF、xlsx、docx）、网页表格。
级别：国家级专精特新「小巨人」（本省各批）、国家级重点小巨人、省级专精特新中小企业（各年各批）、必要时市级。
本地已有（不必重复找，除非有更新的批次）：${have.length ? have.map((h) => `${h.level}${h.batch ? " " + h.batch : ""} ${h.n} 家`).join("；") : "无"}。
**只输出链接和元数据，不要把企业名称抄进输出**——系统会自己下载并解析这些文件。优先直链附件；一个批次一条。拿不到的批次在 summary 里说明原因。`;
  const { runId } = spawnRun(s, { runner: "claude", mode: "intel.sme", subjectType: "region", subjectId: region, subjectLabel: region, prompt, schema: SCHEMA, maxTurns: 25, maxBudgetUsd: 1 });
  const workflowId = s.workflows.start("sme_run", runId, `sme_run:${runId}`, { region });
  return { runId, workflowId };
}

export function smeRun(s: Services): WorkflowDef {
  return {
    kind: "sme_run",
    order: ["collect"],
    steps: {
      collect: async ({ subjectId: runId, checkpoint }) => {
        const row = s.domain.db.prepare("select * from agent_run where id = ?").get(runId) as any;
        if (!row) return { type: "fail", error: "agent_run missing" };
        const r = readRun(row.run_dir);
        if (r.status === "running") {
          if (row.runner !== "external" && (Date.now() - Date.parse(row.started_at)) / 60_000 > 25) { finish(s, runId, "failed", "timeout after 25 min"); return { type: "done" }; }
          return { type: "sleep", until: new Date(Date.now() + 20_000).toISOString(), checkpoint };
        }
        if (r.status === "failed" || !Array.isArray(r.structured?.sources)) { finish(s, runId, "failed", r.error ?? "no sources"); return { type: "done" }; }
        const loaded = await loadSources(s.domain.db, r.structured.sources);
        const dir = join(s.config.vault, "research", "sme");
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${now().slice(0, 10)}-${String(checkpoint.region).replace(/[\\/:*?"<>|]+/g, "_")}-${runId}.json`);
        writeFileSync(path, JSON.stringify({ region: checkpoint.region, summary: r.structured.summary, ...loaded }, null, 1), "utf8");
        const summary = `${checkpoint.region}：${loaded.sources.length} 个名单文件，新增 ${loaded.inserted} 家、更新 ${loaded.updated} 家${loaded.sources.some((x) => x.error) ? `；${loaded.sources.filter((x) => x.error).length} 个没读出来` : ""}`;
        s.domain.db.prepare("update agent_run set status = 'done', output_path = ?, summary = ?, session_id = ?, cost_usd = ?, finished_at = ? where id = ?").run(path, summary, r.sessionId ?? "", r.costUsd ?? 0, now(), runId);
        return { type: "done" };
      },
    },
  };
}

function finish(s: Services, runId: string, status: string, error: string) {
  s.domain.db.prepare("update agent_run set status = ?, error = ?, finished_at = ? where id = ?").run(status, error.slice(0, 1000), now(), runId);
}
