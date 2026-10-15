import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { now } from "../db.js";
import type { Services } from "../registry.js";
import type { WorkflowDef } from "../service/workflow.js";
import { spawnRun, readRun } from "./worker.js";
import { INTEL_QUESTION } from "../service/intel.js";

/** Structured output the worker must return (also used as --json-schema). */
export const RESEARCH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "report_markdown", "evidence", "deadlines", "eligibility", "risks"],
  properties: {
    summary: { type: "string", description: "3 句以内的结论" },
    report_markdown: { type: "string", description: "完整中文报告（Markdown），按：公司概况 / 本届校招安排 / 目标方向岗位 / 流程与时间线 / 薪酬与地点线索 / 风险与未知 / 证据清单" },
    evidence: {
      type: "array",
      items: {
        type: "object", additionalProperties: false, required: ["url", "title", "grade", "quote"],
        properties: { url: { type: "string" }, title: { type: "string" }, grade: { type: "string", enum: ["官方", "校方转载", "聚合", "行业线索", "推断"] }, quote: { type: "string", description: "原文摘录，40 字内" }, date: { type: "string" } },
      },
    },
    deadlines: { type: "array", items: { type: "object", additionalProperties: false, required: ["text", "confidence"], properties: { text: { type: "string" }, date: { type: "string", description: "YYYY-MM-DD，未知留空" }, confidence: { type: "string", enum: ["high", "medium", "low"] }, source_url: { type: "string" } } } },
    eligibility: { type: "string", description: "届次/学历/专业/应届身份要求原文与判断" },
    risks: { type: "array", items: { type: "string" } },
  },
} as const;

const GRADE_RULES = `证据等级（每条来源必须标一个）：
- 官方：企业官网/企业招聘系统（Moka、北森、官网 careers）页面直接读取
- 校方转载：高校就业网、企业/高校公众号转载的招聘简章
- 聚合：牛客、超级简历、HI 简历等第三方汇总页，只作线索，截止与薪酬需回官方核
- 行业线索：知乎、媒体报道、论坛，不作岗位事实
- 推断：你的分析，不是来源陈述
规则：不编造；截止日期没有官方来源就标 low；薪酬没有来源就写未知；区分 2027 届校招与社招；每条事实给 URL。`;

export function buildResearchPrompt(s: Services, companyName: string, question: string): string {
  if (question === "企业情况") return intelPrompt(s, companyName); // the card's canned brief (ADR-029)
  const db = s.domain.db;
  const campaigns = db.prepare(`select c.id, c.kind, c.batch, c.cohort, c.closes_at, c.deadline_text, c.apply_url, c.source_grade, c.cities from campaign c join company co on co.id = c.company_id where co.name = ? order by c.updated_at desc limit 5`).all(companyName) as any[];
  const positions = campaigns.length
    ? (db.prepare(`select p.title, p.cities, p.degree_req from position p where p.campaign_id in (${campaigns.map(() => "?").join(",")}) limit 60`).all(...campaigns.map((c) => c.id)) as any[])
    : [];
  const known = campaigns.length
    ? `## 岗位库里已有的记录（来自 ${campaigns.map((c) => c.source_grade).join("/")} 来源，可作起点，仍需核实）\n${campaigns.map((c) => `- ${c.kind} ${c.batch} ${c.cohort} 截止:${c.closes_at ?? c.deadline_text ?? "未知"} 入口:${c.apply_url} 城市:${c.cities}`).join("\n")}\n岗位（${positions.length}）：${positions.slice(0, 40).map((p) => p.title).join("、")}`
    : "## 岗位库里还没有这家公司的记录";
  return `你是校招调研员。目标公司：**${companyName}**。今天：${now().slice(0, 10)}。
调研问题：${question || "这家公司 2027 届校招（尤其控制/仿真/算法/机器人方向的硕博岗位）的安排、入口、时间线、资格要求、薪酬与工作地点线索、口碑与风险。"}

${known}

要求：用 WebSearch/WebFetch 查官网、招聘系统、高校就业网、公众号转载、牛客/知乎；优先官方来源；每条事实附 URL 与证据等级。
${GRADE_RULES}
最终只输出符合 schema 的 JSON（report_markdown 用中文，含"证据清单"一节把 evidence 再列一遍）。`;
}

/**
 * 企业情况 brief: what the free endpoints already put on the card is handed over so the worker spends its turns only on
 * what they cannot get (funding, 参股, local policy, expansion, 口碑); no job listings in the prompt.
 */
function intelPrompt(s: Services, companyName: string): string {
  const co = s.domain.db.prepare("select id from company where name = ?").get(companyName) as { id: string } | undefined;
  const rows = co ? (s.domain.db.prepare("select kind, data_json, fetched_at from company_intel where company_id = ?").all(co.id) as any[]) : [];
  const known = rows.map((r) => {
    const d = JSON.parse(r.data_json);
    if (r.kind === "listing") return d.none ? "上市：否（巨潮查无）" : `上市：${d.market} ${d.code}`;
    if (r.kind === "ipo") return `深交所审核：${d.szse ? d.szse.stage : "无"}`;
    if (r.kind === "news") return `已有新闻标题：${(d.items ?? []).map((i: any) => i.date + " " + i.title).join("；")}`;
    if (r.kind === "finance") return "财报：已有（不用再查）";
    return "";
  }).filter(Boolean).join("\n");
  return `你是企业调研员。目标公司：**${companyName}**。今天：${now().slice(0, 10)}。
系统已经拿到的（不要重复查）：
${known || "（还没有）"}

${INTEL_QUESTION}
只查上面没有的；每项最多 3 次搜索。
${GRADE_RULES}
最终只输出符合 schema 的 JSON（report_markdown 用中文，按上面 6 项分节，含"证据清单"一节把 evidence 再列一遍）。`;
}

/** Tool entry: create workflow that spawns the worker and collects the result. Returns ids immediately. */
export function startResearch(s: Services, companyName: string, question = ""): { runId: string; workflowId: string } {
  const company = s.domain.db.prepare("select id from company where name = ?").get(companyName) as { id: string } | undefined;
  const companyId = company?.id ?? s.domain.upsertCompany(companyName);
  const { runId } = spawnRun(s, { runner: "claude", mode: "research.company", subjectType: "company", subjectId: companyId, subjectLabel: companyName, prompt: buildResearchPrompt(s, companyName, question), schema: RESEARCH_SCHEMA, ...(question === "企业情况" ? { maxTurns: 25, maxBudgetUsd: 1 } : {}) });
  const workflowId = s.workflows.start("research_run", runId, `research_run:${runId}`, { companyName, companyId });
  return { runId, workflowId };
}

export function researchRun(s: Services): WorkflowDef {
  return {
    kind: "research_run",
    order: ["collect"],
    steps: {
      collect: async ({ subjectId: runId, checkpoint, attempts }) => {
        const row = s.domain.db.prepare("select * from agent_run where id = ?").get(runId) as any;
        if (!row) return { type: "fail", error: "agent_run missing" };
        const r = readRun(row.run_dir);
        const elapsedMin = (Date.now() - Date.parse(row.started_at)) / 60_000;
        if (r.status === "running") {
          if (elapsedMin > 25 && row.runner !== "external") { fail(s, runId, "timeout after 25 min"); return { type: "done" }; } // an agent answering (ADR-032) takes its time
          return { type: "sleep", until: new Date(Date.now() + 20_000).toISOString(), checkpoint };
        }
        if (r.status === "failed") { fail(s, runId, r.error ?? "failed", r.sessionId); return { type: "done" }; }
        const so = r.structured;
        if (!so?.report_markdown) { fail(s, runId, "no structured_output.report_markdown; raw: " + String(r.resultText ?? "").slice(0, 200), r.sessionId); return { type: "done" }; }
        // persist: knowledge file (canonical) + evidence rows (index) + agent_run
        const safe = String(checkpoint.companyName).replace(/[\\/:*?"<>|]+/g, "_");
        const dir = join(s.config.vault, "research", safe);
        mkdirSync(dir, { recursive: true });
        const path = join(dir, `${now().slice(0, 10)}-${runId}.md`);
        const header = `---\ncompany: ${checkpoint.companyName}\nrun: ${runId}\nrunner: claude\ndate: ${now().slice(0, 10)}\nsummary: ${JSON.stringify(so.summary ?? "")}\n---\n\n`;
        writeFileSync(path, header + so.report_markdown + "\n", "utf8");
        const ins = s.domain.db.prepare("insert into evidence(id, subject_type, subject_id, grade, url, title, quote, fetched_at, report_path, run_id) values (?,?,?,?,?,?,?,?,?,?)");
        for (const e of so.evidence ?? []) ins.run(ulid(), "company", checkpoint.companyId, e.grade ?? "推断", e.url ?? "", e.title ?? "", e.quote ?? "", now(), path, runId);
        s.domain.db.prepare("update agent_run set status = 'done', output_path = ?, summary = ?, session_id = ?, cost_usd = ?, finished_at = ? where id = ?")
          .run(path, String(so.summary ?? "").slice(0, 500), r.sessionId ?? "", r.costUsd ?? 0, now(), runId);
        // deadlines with an official/high-confidence date → proposal to update campaign closes_at (never auto-write)
        for (const d of so.deadlines ?? []) {
          if (d.date && /^\d{4}-\d{2}-\d{2}$/.test(d.date) && d.confidence === "high") {
            s.domain.createProposal("campaign.deadline", { companyId: checkpoint.companyId, companyName: checkpoint.companyName, date: d.date, text: d.text, sourceUrl: d.source_url ?? "" }, `agent:research:${runId}`, `调研发现截止 ${d.date}：${d.text}`);
          }
        }
        return { type: "done" };
      },
    },
  };
}

function fail(s: Services, runId: string, error: string, sessionId = ""): void {
  s.domain.db.prepare("update agent_run set status = 'failed', error = ?, session_id = coalesce(nullif(?, ''), session_id), finished_at = ? where id = ?").run(error.slice(0, 1000), sessionId, now(), runId);
}

export function listResearch(s: Services, companyName?: string) {
  const rows = companyName
    ? s.domain.db.prepare("select * from agent_run where mode = 'research.company' and subject_label = ? order by started_at desc limit 20").all(companyName)
    : s.domain.db.prepare("select * from agent_run where mode = 'research.company' order by started_at desc limit 50").all();
  return (rows as any[]).map((r) => ({ runId: r.id, companyName: r.subject_label, status: r.status, summary: r.summary, reportPath: r.output_path, error: r.error, costUsd: r.cost_usd, startedAt: r.started_at, finishedAt: r.finished_at }));
}

export function getResearch(s: Services, runId: string) {
  const r = s.domain.db.prepare("select * from agent_run where id = ?").get(runId) as any;
  if (!r) return null;
  const live = r.status === "running" ? readRun(r.run_dir) : null;
  const markdown = r.output_path ? (() => { try { return readFileSync(r.output_path, "utf8"); } catch { return ""; } })() : "";
  const evidence = (s.domain.db.prepare("select grade, url, title, quote from evidence where run_id = ?").all(runId) as any[]);
  return { runId, companyName: r.subject_label, status: live?.status === "done" ? "collecting" : r.status, summary: r.summary, reportPath: r.output_path, markdown, evidence, error: r.error, costUsd: r.cost_usd, startedAt: r.started_at, finishedAt: r.finished_at };
}
