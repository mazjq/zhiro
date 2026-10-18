import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { now } from "../db.js";
import type { Services } from "../registry.js";
import type { WorkflowDef } from "../service/workflow.js";
import { spawnRun, readRun } from "./worker.js";
import { INTEL_QUESTION } from "../service/intel.js";
import { compare, factsMarkdown } from "../service/employer.js";
import { profileText } from "../service/fit.js";

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

/** 就业评估 (D-29): what the agent must hand back. Zhiro writes section 一 (the facts) itself. */
export const EMPLOYER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "report_markdown", "evidence", "claims", "match"],
  properties: {
    summary: { type: "string", description: "3 句以内：这家公司作为雇主的要点，不打分" },
    report_markdown: { type: "string", description: "中文 Markdown，从「## 二、利润为什么变」写起：二、利润为什么变 / 三、钱去了哪 / 四、激励和技术人员 / 五、上市与资本 / 六、求职信号 / 七、和你的匹配 / 八、证据清单" },
    evidence: RESEARCH_SCHEMA.properties.evidence,
    claims: {
      type: "array", description: "报告里每条定性结论",
      items: {
        type: "object", additionalProperties: false, required: ["text", "type", "urls", "counter", "limits"],
        properties: { text: { type: "string" }, type: { type: "string", enum: ["事实", "解读", "推断"] }, urls: { type: "array", items: { type: "string" } }, counter: { type: "string", description: "找过的反面说法；没找到就写「没找到」" }, limits: { type: "string", description: "这条结论的限制" } },
      },
    },
    match: {
      type: "object", additionalProperties: false, required: ["strengths", "risks", "unknowns"],
      properties: { strengths: { type: "array", items: { type: "string" } }, risks: { type: "array", items: { type: "string" } }, unknowns: { type: "array", items: { type: "string" } } },
    },
  },
} as const;

/** Pull the company's facts from Zhiro's own numbers; a company that is not an A-share listing gets a line saying so. */
async function employerFacts(s: Services, companyName: string): Promise<string> {
  try {
    const r: any = await compare(s.domain.db, { companies: [companyName] });
    return r.companies[0] ? factsMarkdown(r.companies[0], r) : factsMarkdown({ note: r.notFound[0]?.reason ?? "不是 A 股上市公司" }, r);
  } catch (e: any) {
    return `## 一、事实（职路取数）

这次没取到行业数据（${String(e?.message ?? e).slice(0, 120)}），下面的数字都来自调研员给的来源。
`;
  }
}

function employerPrompt(s: Services, companyName: string, facts: string): string {
  const db = s.domain.db;
  const co = db.prepare("select id from company where name = ?").get(companyName) as { id: string } | undefined;
  const intel = co ? (db.prepare("select kind, data_json from company_intel where company_id = ? and kind in ('announcements','dividends','ipo','listing','reports')").all(co.id) as any[]) : [];
  const card = intel.map((r) => {
    const d = JSON.parse(r.data_json);
    if (r.kind === "listing") return d.none ? "上市：巨潮、股转、美股都没查到" : `上市：${d.market} ${d.code}`;
    if (r.kind === "ipo") return `深交所项目库：${d.szse ? `${d.szse.stage}（${d.szse.date ?? ""}）` : "未检出"}`;
    if (r.kind === "dividends") return `已实施的分红：${(d.items ?? []).map((x: any) => `${x.period} ${x.plan}`).join("；") || "无"}`;
    if (r.kind === "announcements") return `近一年相关公告：
${(d.hits ?? []).filter((h: any) => /激励|持股|回购|减持|增持|上市|辅导|募集/.test(h.title)).slice(0, 20).map((h: any) => `  - ${h.date} ${h.title} ${h.url}`).join("\n") || "  （无）"}`;
    if (r.kind === "reports") return `近一年研报标题：${(d.items ?? []).slice(0, 5).map((x: any) => x.title).join("；")}`;
    return "";
  }).filter(Boolean).join("\n");
  const posts = co ? (db.prepare("select p.title from position p join campaign c on c.id = p.campaign_id where c.company_id = ? and p.status = 'open' limit 40").all(co.id) as any[]).map((p) => p.title) : [];
  const profile = profileText(s).split("\n").filter((l) => !l.startsWith("- basic")).join("\n");
  return `你是就业调研员，替一位求职者评估「${companyName}」这家雇主。今天：${now().slice(0, 10)}。

## 职路已经算好的事实（报告第一节由职路放，你不用重写；引用时数字照抄，别的数字要给来源）
${facts}
## 企业情况卡里已有的
${card || "（还没有）"}

## 这家公司在岗位库里在招的
${posts.length ? posts.join("、") : "（库里没有）"}

## 求职者画像
${profile || "（画像是空的）"}

## 要回答的（证据不够就写「依据不足」，不要编）
二、利润为什么变：营收、成本、人数分开说。只有年报「管理层讨论与分析」或公告写明的才说是原因，否则写「同时发生」并标待核实。是不是靠减员、降薪省出来的：查年报「员工情况」近几年在职员工数，和支付给职工的现金对照。
三、钱去了哪：研发、分红和回购、资本开支、并购，按上面的事实表和公告说。
四、激励和技术人员：近三年的股权激励、员工持股计划，读公告原文，摘出激励对象（核心技术人员几人、占员工比例）、授予价格、考核条件；写明有没有覆盖技术人员。研发人员占比、技术岗在公司里的分量。
五、上市与资本：已上市的写板块和近期再融资、减持；未上市的查深交所、上交所、北交所的 IPO 项目库和证监会辅导备案，写「截至今天，以哪些名称在哪些库里没检出」，或者给出所处阶段和日期。
六、求职信号：在招什么方向、口碑与风险（裁员、欠薪、诉讼、减持等新闻，注明日期和来源）。
七、和这位求职者的匹配：优势、风险、未知各几条，单列，不并入对公司本身的判断。也放进 match 字段。

规则：
- 每条定性结论放进 claims：类型（事实 / 解读 / 推断）、证据 URL、找过的反面说法（没找到写「没找到」）、限制。
- 不打分、不给总分、不写「推荐指数」，不替求职者决定去不去。
${GRADE_RULES}
最终只输出符合 schema 的 JSON（report_markdown 从「## 二、利润为什么变」写起，最后一节「八、证据清单」把 evidence 再列一遍）。`;
}

/** 就业评估: Zhiro's facts first, then the agent's reading of them; same run and storage as research.company. */
export async function startEmployerReport(s: Services, companyName: string): Promise<{ runId: string; workflowId: string }> {
  const company = s.domain.db.prepare("select id from company where name = ?").get(companyName) as { id: string } | undefined;
  const companyId = company?.id ?? s.domain.upsertCompany(companyName);
  const facts = await employerFacts(s, companyName);
  const { runId } = spawnRun(s, { runner: "claude", mode: "research.company", subjectType: "company", subjectId: companyId, subjectLabel: companyName, prompt: employerPrompt(s, companyName, facts), schema: EMPLOYER_SCHEMA, maxTurns: 50 });
  const workflowId = s.workflows.start("research_run", runId, `research_run:${runId}`, { companyName, companyId, prefix: facts });
  return { runId, workflowId };
}

/** The agent's claims and match as tables under its report, so each conclusion shows its evidence and limits. */
export function claimsMarkdown(so: any): string {
  const cell = (x: string) => String(x ?? "").replace(/\|/g, "/").replace(/\s*\n\s*/g, " ");
  const claims = (so.claims ?? []) as any[];
  const m = so.match;
  return [
    ...(claims.length ? ["", "## 结论核对", "", "| 结论 | 类型 | 证据 | 反面说法 | 限制 |", "|---|---|---|---|---|", ...claims.map((c) => `| ${cell(c.text)} | ${cell(c.type)} | ${(c.urls ?? []).map((u: string, i: number) => `[${i + 1}](${u})`).join(" ") || "无"} | ${cell(c.counter)} | ${cell(c.limits)} |`)] : []),
    ...(m ? ["", "## 和你的匹配（单列）", "", ...(["strengths", "risks", "unknowns"] as const).map((k) => `**${({ strengths: "优势", risks: "风险", unknowns: "未知" })[k]}**：${(m[k] ?? []).join("；") || "—"}`)] : []),
  ].join("\n");
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
        writeFileSync(path, header + (checkpoint.prefix ? `${checkpoint.prefix}\n` : "") + so.report_markdown + claimsMarkdown(so) + "\n", "utf8");
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
