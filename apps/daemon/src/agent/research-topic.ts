import { mkdirSync, writeFileSync, readFileSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import YAML from "yaml";
import { now } from "../db.js";
import type { Services } from "../services.js";
import type { WorkflowDef } from "../service/workflow.js";
import { spawnRun, readRun } from "./worker.js";
import { companyKey, genericCompany, publicUrl, sha } from "../data/index.js";
import { listPool } from "../service/pool.js";
import { profileText } from "../service/fit.js";
import { unitIndex, unitKey } from "../service/same-company.js";
import { RESEARCH_SOURCES } from "../service/research-sources.js";
import { DATA_TOOLS, callData, checkPoints, dataFile, keepData, readData, refIndex, type DataEntry, type DataTool } from "../service/research-data.js";

/**
 * 主题调研 (docs/plans/2026-10-13-research-loop.md): an industry or a direction looked into — is it worth going for,
 * which companies, which kinds of post — and then tied to the pool. It travels the road 调研一家公司 already has: a
 * web-capable worker, or (ADR-032) the person's own agent answering the brief; either way the daemon takes the answer in,
 * checks it against the schema and files it. Filing a report changes nothing in the pool: no company row, no tag, no
 * subscription. What the report's companies have in the pool is worked out each time the report is opened.
 */
export const TOPIC_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["summary", "report_markdown", "companies", "sources"],
  properties: {
    summary: { type: "string", description: "3 句以内的结论：这个方向对这个人值不值得去、主要依据" },
    report_markdown: { type: "string", description: "完整中文报告（Markdown）：行业现状与趋势 / 就业与薪资 / 主要公司与各自在做什么 / 适合这个人的岗位类型与理由 / 风险与未知 / 信源清单。每个数字和判断后面注明出处" },
    companies: {
      type: "array", maxItems: 60,
      description: "报告里提到、值得这个人去看招聘的公司。只列真实存在、你在信源里读到的公司",
      items: {
        type: "object", additionalProperties: false, required: ["name", "why", "source_url"],
        properties: { name: { type: "string", description: "公司通用的中文名（没有就用英文名），不要带「集团旗下」之类的说明" }, why: { type: "string", description: "为什么提它，60 字内" }, source_url: { type: "string", description: "读到这家公司的那个网页" }, region: { type: "string", description: "主要招聘地区，如 中国 / 美国" } },
      },
    },
    roles: { type: "array", maxItems: 30, items: { type: "object", additionalProperties: false, required: ["title", "why"], properties: { title: { type: "string", description: "岗位类型，如 运动控制算法工程师" }, why: { type: "string" } } } },
    key_points: {
      type: "array", maxItems: 40,
      description: "报告的主要结论，一条一句话。refs 写这条结论依据的数据编号（数据工具返回里的 ref）；依据是网页或你自己的判断的，refs 留空",
      items: { type: "object", additionalProperties: false, required: ["text", "refs"], properties: { text: { type: "string", description: "一句话，带上数字和它的财年 / 单位" }, refs: { type: "array", items: { type: "string" }, description: "如 F:A股:688836、R:AP2026…、L:17-2141、B:BK1184" } } },
    },
    sources: {
      type: "array", maxItems: 60,
      items: { type: "object", additionalProperties: false, required: ["url", "title", "grade"], properties: { url: { type: "string" }, title: { type: "string" }, grade: { type: "string", enum: ["官方", "校方转载", "聚合", "行业线索", "推断"] }, quote: { type: "string", description: "原文摘录，40 字内" }, date: { type: "string" } } },
    },
  },
} as const;

export interface Mention { name: string; why: string; sourceUrl: string; region: string }

/**
 * What Zhiro fetches before anyone starts looking (ADR-056): brokers' recent reports on the topic and the listed
 * companies the stock market files under it. A place to start from, not the research: which companies matter is the
 * researcher's call, and their filings are one tool call away. A source that does not answer is said, not hidden.
 */
export type Starter = { tool: DataTool; input: unknown; output?: any; error?: string }[];
export async function starterPack(topic: string): Promise<Starter> {
  const asks: [DataTool, unknown][] = [["industry.reports", { query: topic, limit: 15 }], ["industry.companies", { query: topic, limit: 30 }]];
  return Promise.all(asks.map(([tool, input]) => (DATA_TOOLS[tool] as (i: any) => Promise<any>)(input).then((output) => ({ tool, input, output }), (e) => ({ tool, input, error: String(e?.message ?? e).slice(0, 200) }))));
}
function starterText(pack: Starter): string {
  const reports = pack.find((x) => x.tool === "industry.reports"), board = pack.find((x) => x.tool === "industry.companies");
  const r = reports?.output?.items?.length
    ? (reports.output.items as any[]).map((it) => `- [${it.ref}] ${it.org} ${it.date}${it.rating ? ` ${it.rating}` : ""}《${it.title}》 ${it.url}`).join("\n")
    : `（没有取到：${reports?.error ?? "最近 90 天没有标题含这个词、也没有对上行业分类的研报"}。可以换个说法再用研报工具查）`;
  const b = board?.output?.board
    ? `[${board.output.ref}] 东方财富「${board.output.board.name}」${board.output.board.kind}板块，共 ${board.output.total} 家，市值前 ${board.output.items.length} 家（名称 / 市值亿元 / 主营行业）：\n${(board.output.items as any[]).map((it) => `${it.name}（${it.code}）/ ${it.marketCapYi ?? "?"} / ${it.industry}`).join("；")}`
    : `（没有对上的板块：${board?.error ?? board?.output?.message ?? ""}）`;
  return `### 券商研报（最近 90 天，标题含主题词的在前；研报是观点，要内容就打开链接读）\n${r}\n\n### 股市里这个主题下的上市公司（候选名单，不是行业样本：排前面的常是只沾边的大公司；只含 A 股）\n${b}`;
}

/** The brief: who it is for, what to answer, the data tools and what was already fetched — and little about how. */
export function buildTopicPrompt(s: Services, topic: string, region: string, question: string, given: { pack?: Starter; runId?: string } = {}): string {
  const me = profileText(s).slice(0, 8000); // cards come sorted by kind; at 3,000 the skills (last) were cut off behind two dozen awards
  // an agent of the person's own calls the daemon's tools (dotted names, and the run's id so the data is kept with it);
  // the background worker sees the same tools in its list under its own prefix, already tied to this run
  const call = given.runId
    ? `工具名：company.financials、industry.companies、industry.reports、labor.us。**每次调用都带上 runId: "${given.runId}"**——这样取到的数据才记在这份调研名下，你的要点才能引用它。`
    // the worker runs under a hard cap on turns and spend, and a run that hits it hands back nothing at all
    : "它们在你的工具列表里，名字是 company_financials、industry_companies、industry_reports、labor_us（前面带 mcp__jobosdata__）。\n你这次的额度有上限，用完还没交报告就等于白做：取数和联网合起来控制在 30 次调用左右，到那时就动笔，把已经查到的写清楚、没查到的写「未查到」。";
  return `你是就业方向调研员。调研主题：**${topic}**${region ? `（地区：${region}）` : ""}。今天：${now().slice(0, 10)}。
要回答的问题：${question || "这个行业 / 方向现在的状况和未来两三年的走向；在招什么样的人、薪资水平；有哪些公司值得去看、它们各自经营得怎么样；对下面这个人，哪些岗位类型合适，哪些不合适，为什么。"}

## 这个人（来自他的画像，只用来判断合不合适，不要写进报告以外的地方）
${me || "（画像还是空的：按一般应届硕博来写，并在报告开头说明这一点）"}

## 你手里的数据工具（直接取数，免费；这些数据不用再去网页上找）
- 查一家上市公司的经营数据（company financials）：给公司名或股票代码，返回上市地、行业、员工数、近三个财年和最近一期的营收 / 净利润 / 同比 / 毛利率 / 研发费用。A 股、港股、美股、新三板都能查，公司不必有名气。查不到不等于没上市——换简称或代码再试。
- 查一个主题或行业在股市里有哪些上市公司（industry companies）：按市值排的成分股和各自的主营行业。
- 查券商最近的行业研报（industry reports）：标题、机构、日期、评级、原文链接。
- 查美国某个职业的就业人数和年薪（labor us）：美国劳工统计局的官方统计，按 SOC 职业代码。
${call}
每个返回里都有 ref（如 F:A股:688836、R:AP2026…、B:BK1184、L:17-2141），引用这条数据时用它。
其余的——研报正文、招聘平台报告、新闻、未上市公司的融资与估值、中国的就业与工资统计——用你的联网能力查，下面有一份信源清单。

## 已经替你取好的（起步用；想查别的公司、别的板块、别的关键词，直接用工具）
${given.pack ? starterText(given.pack) : "（这次没有预取）"}

## 怎么查、怎么写由你定。只有这几条要求
- 结论落在数据上：说一家公司怎么样，先取它的经营数据（上市的）；说行业怎么样，看研报并读原文；说就业和薪资，用官方统计。查不到就写「未查到」，不要估。
- 谁是这个行业的主角由你判断——板块名单里排前面的未必是，没上市的也可能是。
- 「值不值得去」给证据和两面的理由，不要替他下决定。
- companies 里只列你确实读到的公司，每家给出读到它的网页。不确定是否在招的也可以列，在 why 里说明。
- key_points：把报告的主要结论列成要点，一条一句话，refs 写它依据的数据的 ref。依据是网页或你自己的判断的，refs 留空。用户会看到每条要点和它引的数据，系统会核对句子里的数字在不在那条数据里——所以数字要是数据里的数，带上财年和币种；金额写成人读的样子（「营收 17.0 亿元」，不要写 1699269304.88 元），核对时按你写出的位数舍入。不要把推算或估计出来的数写成数据里的数。
- 证据等级：官方（统计局、公司官网、财报）/ 校方转载 / 聚合（招聘平台报告、汇总页）/ 行业线索（媒体、论坛、研报观点）/ 推断（你的分析）。

## 联网时可以用的信源（按问题挑着用，不必都看）
${RESEARCH_SOURCES}

最终只输出符合 schema 的 JSON。`;
}

const topicKey = (topic: string, region: string) => sha(`${topic.trim()}|${region.trim()}`).slice(0, 16);

export async function startTopicResearch(s: Services, p: { topic: string; region?: string; question?: string }): Promise<{ runId: string; workflowId: string }> {
  const topic = p.topic.trim(), region = (p.region ?? "").trim();
  if (!topic) throw Object.assign(new Error("MISSING_FIELD: 要说明调研什么主题"), { code: "MISSING_FIELD" });
  const pack = await starterPack(topic);
  const { runId } = spawnRun(s, {
    runner: "claude", mode: "research.topic", subjectType: "topic", subjectId: topicKey(topic, region), subjectLabel: topic, schema: TOPIC_SCHEMA, dataTools: true, maxTurns: (s.config as any).research?.maxTurns ?? 60,
    // the run exists now: what was fetched for it goes into its record, and an agent of the person's own is told its id
    prompt: ({ runId, dir, external }) => {
      for (const x of pack) keepData(dataFile(dir), x.error ? { tool: x.tool, input: x.input, ok: false, error: x.error } : { tool: x.tool, input: x.input, ok: true, output: x.output });
      return buildTopicPrompt(s, topic, region, p.question ?? "", { pack, runId: external ? runId : undefined });
    },
  });
  const workflowId = s.workflows.start("topic_run", runId, `topic_run:${runId}`, { topic, region });
  return { runId, workflowId };
}

const clip = (v: unknown, n: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, n);

/**
 * What the daemon keeps of an answer. A company needs a name that is a name; its source has to be a page out on the
 * internet, or the entry stays and says it has none. The same company twice is once. Exported for tests.
 */
export function checkTopic(so: any): { summary: string; markdown: string; mentions: Mention[]; roles: { title: string; why: string }[]; points: { text: string; refs: string[] }[]; sources: { url: string; title: string; grade: string; quote: string }[] } {
  const markdown = String(so?.report_markdown ?? "").trim();
  if (!markdown) throw new Error("no structured_output.report_markdown");
  const seen = new Set<string>(), mentions: Mention[] = [];
  for (const c of Array.isArray(so.companies) ? so.companies.slice(0, 60) : []) {
    const name = clip(c?.name, 60);
    if (!name || genericCompany(name) || seen.has(companyKey(name))) continue;
    seen.add(companyKey(name));
    const url = String(c?.source_url ?? "").trim();
    mentions.push({ name, why: clip(c?.why, 300), sourceUrl: publicUrl(url) ? url : "", region: clip(c?.region, 20) });
  }
  const roles = (Array.isArray(so.roles) ? so.roles.slice(0, 30) : []).map((r: any) => ({ title: clip(r?.title, 60), why: clip(r?.why, 300) })).filter((r: { title: string }) => r.title);
  const sources = (Array.isArray(so.sources) ? so.sources.slice(0, 60) : []).filter((e: any) => publicUrl(String(e?.url ?? ""))).map((e: any) => ({ url: String(e.url), title: clip(e.title, 200), grade: clip(e.grade, 10) || "推断", quote: clip(e.quote, 200) }));
  const points = (Array.isArray(so.key_points) ? so.key_points.slice(0, 40) : []).map((p: any) => ({ text: clip(p?.text, 400), refs: (Array.isArray(p?.refs) ? p.refs : []).map((r: unknown) => clip(r, 60)).filter(Boolean).slice(0, 8) })).filter((p: { text: string }) => p.text);
  return { summary: clip(so.summary, 600), markdown: markdown.slice(0, 200_000), mentions, roles, points, sources };
}

/** The data a report was given, kept beside it: what the run fetched, then the filings of the companies it names. */
const dataBeside = (reportPath: string) => `${reportPath}.data.jsonl`;

/**
 * File a checked answer: the report as a file whose head carries what the report is of, whom it names and its 要点; the
 * run and its sources in the ledgers research already has; what the run was given (`runDir`'s data file) beside it.
 */
export function fileTopic(s: Services, runId: string, meta: { topic: string; region: string; runner: string; runDir?: string }, so: any): string {
  const t = checkTopic(so);
  const safe = meta.topic.replace(/[\\/:*?"<>|]+/g, "_").slice(0, 60);
  const dir = join(s.config.vault, "research", "主题", safe);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${now().slice(0, 10)}-${runId}.md`);
  const head = { topic: meta.topic, region: meta.region, run: runId, runner: meta.runner, date: now().slice(0, 10), hash: sha(t.markdown).slice(0, 16), summary: t.summary, companies: t.mentions, roles: t.roles, points: t.points };
  writeFileSync(path, `---\n${YAML.stringify(head)}---\n\n${t.markdown}\n`, "utf8");
  if (meta.runDir && existsSync(dataFile(meta.runDir))) copyFileSync(dataFile(meta.runDir), dataBeside(path));
  const ins = s.domain.db.prepare("insert into evidence(id, subject_type, subject_id, grade, url, title, quote, fetched_at, report_path, run_id) values (?,?,?,?,?,?,?,?,?,?)");
  for (const e of t.sources) ins.run(ulid(), "topic", topicKey(meta.topic, meta.region), e.grade, e.url, e.title, e.quote, now(), path, runId);
  return path;
}

const fail = (s: Services, runId: string, error: string) => s.domain.db.prepare("update agent_run set status = 'failed', error = ?, finished_at = ? where id = ?").run(error.slice(0, 1000), now(), runId);

export function topicRun(s: Services): WorkflowDef {
  return {
    kind: "topic_run",
    order: ["collect"],
    steps: {
      collect: async ({ subjectId: runId, checkpoint }) => {
        const row = s.domain.db.prepare("select * from agent_run where id = ?").get(runId) as any;
        if (!row) return { type: "fail", error: "agent_run missing" };
        const r = readRun(row.run_dir);
        if (r.status === "running") {
          if ((Date.now() - Date.parse(row.started_at)) / 60_000 > 25 && row.runner !== "external") { fail(s, runId, "timeout after 25 min"); return { type: "done" }; }
          return { type: "sleep", until: new Date(Date.now() + 20_000).toISOString(), checkpoint };
        }
        if (r.status === "failed") { fail(s, runId, r.error ?? "failed"); return { type: "done" }; }
        try {
          const path = fileTopic(s, runId, { topic: checkpoint.topic, region: checkpoint.region ?? "", runner: row.runner, runDir: row.run_dir }, r.structured);
          s.domain.db.prepare("update agent_run set status = 'done', output_path = ?, summary = ?, session_id = ?, cost_usd = ?, finished_at = ? where id = ?")
            .run(path, String(r.structured?.summary ?? "").slice(0, 500), r.sessionId ?? "", r.costUsd ?? 0, now(), runId);
          void enrichTopic(path); // the report is there to read now; its companies' filings follow
        } catch (e: any) { fail(s, runId, `${e?.message ?? e}; raw: ${String(r.resultText ?? "").slice(0, 200)}`); }
        return { type: "done" };
      },
    },
  };
}

export function listTopics(s: Services) {
  const rows = s.domain.db.prepare("select * from agent_run where mode = 'research.topic' order by started_at desc limit 100").all() as any[];
  return rows.map((r) => ({ runId: r.id as string, topic: r.subject_label as string, status: r.status as string, summary: r.summary as string, error: r.error as string, runner: r.runner as string, costUsd: r.cost_usd as number, startedAt: r.started_at as string, finishedAt: (r.finished_at ?? null) as string | null }));
}

function readReport(path: string): { head: any; markdown: string } {
  const text = readFileSync(path, "utf8");
  const m = /^---\n([\s\S]*?)\n---\n\n?([\s\S]*)$/.exec(text);
  return m ? { head: YAML.parse(m[1]) ?? {}, markdown: m[2] } : { head: {}, markdown: text };
}

/**
 * The companies a report names, against the pool as it is now. In the pool: the name is a company's name, its
 * normalised name or one of its aliases — the rule every source's rows are filed by. Maybe: another spelling of the same
 * unit, or one name inside the other; shown, never taken for the same. Anything else is not in the pool. Nothing is
 * written. Exported for tests.
 */
export function linkMentions(s: Services, mentions: Mention[]) {
  const db = s.domain.db;
  const exact = db.prepare("select id, name from company where name = ? or norm = ? or aliases like ? limit 1");
  const near = db.prepare("select id, name from company where name like ? order by length(name) limit 3");
  const posts = db.prepare("select count(*) n from position p join campaign c on c.id = p.campaign_id where c.company_id = ? and p.status = 'open'");
  const finding = db.prepare("select status from agent_run where mode = 'company.find' and subject_label = ? order by started_at desc limit 1");
  const units = unitIndex(db);
  return mentions.map((m) => {
    const hit = exact.get(m.name, companyKey(m.name), `%${JSON.stringify(m.name)}%`) as { id: string; name: string } | undefined;
    const base = { name: m.name, why: m.why, sourceUrl: m.sourceUrl, region: m.region };
    if (hit) {
      const all = listPool(db, { companyId: hit.id }).items[0];
      const fits = ((listPool(db, { companyId: hit.id, minTier: "可迁移", hideExpectationFail: true }).items[0]?.positions ?? []) as any[]).filter((p) => !p.deadline?.expired);
      // counted from the table, not the pool's cached rows: a company that was found and read a moment ago is there already
      return {
        ...base, status: "in" as const, companyId: hit.id, companyName: hit.name, openPosts: Number((posts.get(hit.id) as { n: number }).n), closesAt: (all?.closesAt ?? null) as string | null, deadline: (all?.deadlineText ?? "") as string,
        // where its posts are applied for, as the pool has it: a report that names a company is one click from its careers page
        applyUrl: String(all?.applyUrl ?? ""), noticeUrl: String(all?.noticeUrl ?? ""),
        // five are shown; how many there are is said, so five is not taken for all (智元: 16 on the real profile)
        suitableTotal: fits.length, suitable: fits.slice(0, 5).map((p) => ({ positionId: p.id as string, title: p.title as string, cities: (p.cities ?? []) as string[], reason: String(p.match?.reason ?? "").slice(0, 80), deadline: String(p.deadline?.say ?? ""), watched: !!p.watched, applicationState: (p.applicationState ?? null) as string | null })),
        candidates: [] as { companyId: string; companyName: string; openPosts: number; applyUrl: string; noticeUrl: string }[], finding: "",
      };
    }
    const k = unitKey(m.name);
    const maybe = [...(k.length >= 3 ? units.get(k) ?? [] : []), ...(m.name.length >= 3 ? (near.all(`%${m.name}%`) as { id: string; name: string }[]) : [])];
    const candidates = [...new Map(maybe.map((c) => [c.id, c])).values()].slice(0, 3).map((c) => { const it = listPool(db, { companyId: c.id }).items[0]; return { companyId: c.id, companyName: c.name, openPosts: Number((posts.get(c.id) as { n: number }).n), applyUrl: String(it?.applyUrl ?? ""), noticeUrl: String(it?.noticeUrl ?? "") }; });
    return { ...base, status: (candidates.length ? "maybe" : "out") as "maybe" | "out", companyId: "", companyName: "", openPosts: 0, closesAt: null as string | null, deadline: "", applyUrl: "", noticeUrl: "", suitableTotal: 0, suitable: [], candidates, finding: String((finding.get(m.name) as { status: string } | undefined)?.status ?? "") };
  });
}

/**
 * The filings of every company a report names, fetched by Zhiro itself (no model) and kept beside the report: what the
 * company table shows is what the data source says, not what a model wrote. One company after another, with a pause —
 * the source limits how often it is asked. A company already fetched is not fetched again, so this can be run any
 * number of times: when the report is filed, and whenever a report that lacks them is opened (the ones from before).
 */
const enriching = new Set<string>();
export async function enrichTopic(reportPath: string): Promise<void> {
  if (enriching.has(reportPath) || !existsSync(reportPath)) return;
  enriching.add(reportPath);
  try {
    const have = new Set(readData(dataBeside(reportPath)).map((e) => e.for).filter(Boolean));
    for (const m of ((readReport(reportPath).head.companies ?? []) as Mention[]).filter((m) => !have.has(m.name))) {
      await callData("company.financials", { name: m.name }, dataBeside(reportPath), m.name).catch(() => undefined); // the failure is on record
      await new Promise((ok) => setTimeout(ok, 400));
    }
  } finally { enriching.delete(reportPath); }
}

/** What the page shows of one company's filings: which listed company it was taken for, and its latest full year. */
function financialsOf(e: DataEntry | undefined) {
  if (!e) return null;
  if (!e.ok) return { status: "failed" as const, message: `没取成：${e.error ?? ""}`, fetchedAt: e.at, security: null, approx: false, candidates: [] as string[], industry: "", employees: null as number | null, year: null as any, latest: null as any };
  const o = e.output ?? {};
  return {
    status: o.status as "listed" | "not_found" | "ambiguous" | "failed", message: String(o.message ?? (o.errors ?? []).join("；") ?? ""), fetchedAt: e.at,
    security: (o.security ?? null) as { market: string; code: string; name: string } | null, approx: !!o.approx, candidates: ((o.candidates ?? []) as any[]).map((c) => `${c.name}（${c.market} ${c.code}）`),
    industry: String(o.basic?.industry ?? ""), employees: (o.basic?.employees ?? null) as number | null, year: (o.annual?.[0] ?? null) as any, latest: (o.latest ?? null) as any,
  };
}

export function getTopic(s: Services, runId: string) {
  const r = s.domain.db.prepare("select * from agent_run where id = ? and mode = 'research.topic'").get(runId) as any;
  if (!r) return null;
  const base = { runId, topic: r.subject_label as string, status: r.status as string, summary: r.summary as string, error: r.error as string, runner: r.runner as string, costUsd: r.cost_usd as number, startedAt: r.started_at as string, finishedAt: (r.finished_at ?? null) as string | null };
  const none = { keyPoints: [] as ReturnType<typeof checkPoints>, data: { items: [] as { ref: string; kind: string; label: string; at: string }[], failed: [] as string[], pending: 0 } };
  if (!r.output_path) return { ...base, region: "", markdown: "", roles: [] as { title: string; why: string }[], companies: [] as (ReturnType<typeof linkMentions>[number] & { financials: ReturnType<typeof financialsOf> })[], sources: [] as { grade: string; url: string; title: string; quote: string }[], ...none };
  const { head, markdown } = readReport(r.output_path);
  const sources = s.domain.db.prepare("select grade, url, title, quote from evidence where run_id = ?").all(runId) as { grade: string; url: string; title: string; quote: string }[];
  // what the run was given, and its companies' filings: read each time, like the match against the pool
  const entries = readData(dataBeside(r.output_path)), index = refIndex(entries);
  const mentions = (head.companies ?? []) as Mention[];
  const fetched = new Map(entries.filter((e) => e.for).map((e) => [e.for!, e]));
  const pending = mentions.filter((m) => !fetched.has(m.name)).length;
  if (pending) void enrichTopic(r.output_path); // a report filed before this existed, or one whose fetching a restart cut short
  return {
    ...base, region: String(head.region ?? ""), markdown, roles: (head.roles ?? []) as { title: string; why: string }[],
    companies: linkMentions(s, mentions).map((c) => ({ ...c, financials: financialsOf(fetched.get(c.name)) })), sources,
    keyPoints: checkPoints((head.points ?? []) as { text: string; refs: string[] }[], index),
    data: { items: [...index].map(([ref, v]) => ({ ref, kind: v.kind as string, label: v.label, at: v.at })), failed: entries.filter((e) => !e.ok && !e.for).map((e) => `${e.tool}：${e.error ?? ""}`), pending },
  };
}
