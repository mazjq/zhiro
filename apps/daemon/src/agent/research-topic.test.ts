import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { openDb } from "../db.js";
import { Domain } from "../service/domain.js";
import { WorkflowEngine } from "../service/workflow.js";
import { createLlm } from "../llm.js";
import { callTool, type Services } from "../registry.js";
import { ingest, type Listing } from "../data/index.js";
import { checkTopic, topicRun, buildTopicPrompt } from "./research-topic.js";

/** 主题调研: an agent looks into a direction, the daemon files what it hands back, and the report is tied to the pool when opened. */
const AGENT = { kind: "agent" as const, via: "mcp" as const, cred: "agent" as const };
const HUMAN = { kind: "human" as const, via: "desktop" as const };

/** The data sources as they answer, reduced to what these tests ask them: a board, a broker's report, one company's filings. */
function sources(url: string): Response {
  const u = decodeURIComponent(String(url));
  if (u.includes("search-codetable")) {
    const k = /keyword=([^&]*)/.exec(u)?.[1] ?? "";
    return Response.json({ result: k === "人形机器人" ? [{ code: "BK1184", shortName: "人形机器人", securityTypeName: "概念", market: 90 }] : k === "优必选" ? [{ code: "09880", shortName: "优必选", securityTypeName: "港股", market: 116 }] : [] });
  }
  if (u.includes("push2.eastmoney.com/api/qt/clist")) return Response.json({ data: { total: 304, diff: [{ f12: "688836", f14: "宇树科技-W", f20: 176600000000, f100: "自动化设备" }] } });
  if (u.includes("reportapi.eastmoney.com/report/list")) return Response.json({ data: u.includes("pageNo=1&") ? [{ infoCode: "AP1", title: "人形机器人周报：量产在即", orgSName: "某证券", publishDate: "2026-10-01 00:00:00", industryName: "机器人", emRatingName: "买入", attachPages: 12 }] : [] });
  if (u.includes("RPT_HKF10_FN_MAININDICATOR")) return Response.json({ result: { data: [{ REPORT_TYPE: "2025年报", OPERATE_INCOME: 2001000000, HOLDER_PROFIT: -700000000, OPERATE_INCOME_YOY: 53.3, HOLDER_PROFIT_YOY: 37.5, GROSS_PROFIT_RATIO: 31.2, CURRENCY: "HKD" }] } });
  return Response.json({});
}
beforeEach(() => vi.stubGlobal("fetch", async (url: string) => sources(url)));
afterEach(() => vi.unstubAllGlobals());

function setup(provider = "external") {
  const dir = mkdtempSync(join(tmpdir(), "jobos-topic-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), `llm:\n  provider: ${provider}\n  model: agent\n`, "utf8");
  const db = openDb(join(dir, "t.db"));
  const config: any = { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider, model: "agent" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], agent: { mode: "default", maxWritesPerTurn: 10 } };
  const llm = createLlm(config);
  llm.db = db;
  const s: Services = { domain: new Domain(db), workflows: new WorkflowEngine(db), config, llm };
  s.workflows.register(topicRun(s));
  return { s, db, dir };
}
const L = (company: string, title: string, id: string): Listing => ({ externalId: id, url: `https://jobs.example.com/${id}`, title, company, locations: ["深圳"], description: "运动控制算法", publisher: `site:${company}`, grade: "官方", isOriginal: true, confidence: 0.9, cohort: "2027届", batch: "校招" });

const ANSWER = {
  summary: "人形机器人处在量产前夜，运动控制岗位需求增长，但多数公司尚未盈利。",
  report_markdown: "## 行业现状\n2025 年出货量……（来源：某券商研报，2026-09）\n\n## 适合的岗位类型\n运动控制算法工程师……",
  companies: [
    { name: "优必选", why: "上市的人形机器人公司，在招运动控制", source_url: "https://www.ubtrobot.com/cn/careers", region: "中国" },
    { name: "优必选", why: "重复的一条", source_url: "https://www.ubtrobot.com/" },
    { name: "中船七二二所", why: "做舰船通信，报告里作为对照", source_url: "https://example.org/722" },
    { name: "云岫机器人", why: "新创公司，还没查到招聘页", source_url: "http://127.0.0.1/internal" },
    { name: "公司", why: "不是名字", source_url: "https://example.org/x" },
  ],
  roles: [{ title: "运动控制算法工程师", why: "与控制方向直接对口" }],
  sources: [{ url: "https://data.stats.gov.cn/", title: "国家统计局", grade: "官方", quote: "分行业平均工资" }, { url: "javascript:alert(1)", title: "bad", grade: "聚合" }],
  key_points: [
    { text: "优必选 2025 年营收 20.0 亿港元，同比增长 53.3%，仍在亏损", refs: ["F:港股:09880"] },
    { text: "优必选 2025 年营收 35 亿", refs: ["F:港股:09880"] },
    { text: "券商认为量产在即", refs: ["R:AP1"] },
    { text: "多数公司尚未盈利", refs: [] },
    { text: "某公司营收 9 亿", refs: ["F:A股:000001"] },
  ],
};

describe("what the daemon keeps of an answer", () => {
  it("a company needs a real name, counts once, and a source that is not a public page is no source", () => {
    const t = checkTopic(ANSWER);
    expect(t.mentions.map((m) => [m.name, m.sourceUrl])).toEqual([["优必选", "https://www.ubtrobot.com/cn/careers"], ["中船七二二所", "https://example.org/722"], ["云岫机器人", ""]]);
    expect(t.sources.map((x) => x.url)).toEqual(["https://data.stats.gov.cn/"]);
    expect(() => checkTopic({ summary: "x", companies: [] })).toThrow(/report_markdown/);
  });
});

describe("主题调研，由用户自己的 agent 来查（外部 agent 代答）", () => {
  it("the brief goes to the agent, its answer is filed as a report, and the pool is not touched; the report shows what the pool has", async () => {
    const { s, db, dir } = setup();
    ingest(s.domain, dir, "moka", "ubt", [L("优必选", "运动控制算法工程师", "p1"), L("优必选", "结构工程师", "p2")]);
    ingest(s.domain, dir, "beisen", "c722", [L("中国船舶集团有限公司第七二二研究所", "通信算法工程师", "p3")]);
    const before = JSON.stringify(db.prepare("select (select count(*) from company) c, (select count(*) from campaign) k, (select count(*) from position) p, (select count(*) from recommendation) r").get());
    // the rule layer found one of 优必选's posts 可迁移 for this person (what the recommender writes)
    const post = (db.prepare("select p.id from position p where p.title = '运动控制算法工程师'").get() as { id: string }).id;
    const co = (db.prepare("select id from company where name = '优必选'").get() as { id: string }).id;
    db.prepare("insert into recommendation(id, company_id, position_id, mode, tag, score, reason, run_id, created_at) values (?,?,?,?,?,?,?,?,?)").run(ulid(), co, post, "profile_match", "画像匹配", 130, "可迁移：做过运动控制", "", new Date().toISOString());

    // the agent starts it: with no model of Zhiro's own this is the agent's own work, done at once and on record
    const started: any = await callTool("research.topic", { topic: "人形机器人", region: "中国" }, AGENT, s);
    expect(started.runId).toBeTruthy();
    expect(started.proposal).toBeUndefined();
    const job = ((await callTool("llm.pending", {}, AGENT, s)) as any).items.find((j: any) => j.id === started.runId);
    expect(job.kind).toBe("run");
    expect(job.user).toContain("人形机器人");
    expect(job.user).toContain("国家统计局"); // the source list rides along
    // what Zhiro fetched before anyone started is in the brief, with the refs to cite it by; and the tools, to be called with this run's id
    expect(job.user).toContain("[R:AP1] 某证券 2026-10-01 买入《人形机器人周报：量产在即》");
    expect(job.user).toContain("[B:BK1184] 东方财富「人形机器人」概念板块，共 304 家");
    expect(job.user).toContain(`company.financials、industry.companies、industry.reports、labor.us。**每次调用都带上 runId: "${started.runId}"**`);
    // the agent looks a company up as part of this run: kept with the run. A run id that is not a research under way is refused
    expect(await callTool("company.financials", { name: "优必选", runId: started.runId }, AGENT, s)).toMatchObject({ status: "listed", ref: "F:港股:09880", security: { market: "港股", code: "09880" }, annual: [{ period: "2025年报", revenue: 2001000000, currency: "HKD" }] });
    await expect(callTool("company.financials", { name: "优必选", runId: "01NOTARUN0000000000000000" }, AGENT, s)).rejects.toMatchObject({ code: "BAD_RUN" });
    expect(await callTool("company.financials", { name: "云岫机器人" }, AGENT, s)).toMatchObject({ status: "not_found", ref: "" }); // without a run nothing is kept
    expect(((await callTool("research.report", { runId: started.runId }, AGENT, s)) as any)).toMatchObject({ status: "running", companies: [] });

    await callTool("llm.reply", { jobId: started.runId, text: JSON.stringify(ANSWER) }, AGENT, s);
    await s.workflows.tick();
    const listed: any = await callTool("research.topics", {}, HUMAN, s);
    expect(listed.items[0]).toMatchObject({ runId: started.runId, topic: "人形机器人", status: "done", runner: "external" });

    // filed: a file under research/主题/, its head naming what it is of; the pool exactly as it was (but for the one row the test put in)
    const row = db.prepare("select output_path p from agent_run where id = ?").get(started.runId) as { p: string };
    expect(row.p.replace(/\\/g, "/")).toContain("/research/主题/人形机器人/");
    expect(readFileSync(row.p, "utf8")).toMatch(/^---\ntopic: 人形机器人\nregion: 中国\n/);
    expect(JSON.stringify(db.prepare("select (select count(*) from company) c, (select count(*) from campaign) k, (select count(*) from position) p, (select count(*) - 1 from recommendation) r").get())).toBe(before);
    expect(s.config.sources).toEqual([]);

    // each company's filings are fetched by the daemon itself once the report is filed; the page says how many are still on their way
    await vi.waitFor(async () => expect(((await callTool("research.report", { runId: started.runId }, HUMAN, s)) as any).data.pending).toBe(0), { timeout: 10_000, interval: 200 });
    const r: any = await callTool("research.report", { runId: started.runId }, HUMAN, s);
    expect(r.markdown).toContain("## 行业现状");
    // the 要点 against what this run was given: the figure that is in the filings, the one that is not, a broker's view, a judgement, a ref made up
    expect(r.keyPoints.map((p: any) => [p.status, p.unmatched, p.refs.map((x: any) => x.kind), p.unknownRefs])).toEqual([
      ["matched", [], ["财报"], []], ["unmatched", ["35 亿"], ["财报"], []], ["cited", [], ["研报"], []], ["none", [], [], []], ["unknown", [], [], ["F:A股:000001"]],
    ]);
    expect(r.data.items.map((d: any) => d.kind).sort()).toEqual(["板块", "研报", "财报"]);
    expect(r.companies[0].financials).toMatchObject({ status: "listed", security: { market: "港股", code: "09880", name: "优必选" }, approx: false, year: { period: "2025年报", revenue: 2001000000, revenueYoy: 53.3, currency: "HKD" } });
    expect(r.companies[2].financials).toMatchObject({ status: "not_found", security: null }); // 没查到上市信息 — not said to be unlisted
    expect(r.roles).toEqual([{ title: "运动控制算法工程师", why: "与控制方向直接对口" }]);
    expect(r.sources).toEqual([{ grade: "官方", url: "https://data.stats.gov.cn/", title: "国家统计局", quote: "分行业平均工资" }]);
    const [ubt, c722, yunxiu] = r.companies;
    // in the pool: its open posts, and the ones the existing matching finds suitable
    expect(ubt).toMatchObject({ name: "优必选", status: "in", companyId: co, openPosts: 2, suitableTotal: 1, applyUrl: expect.stringContaining("https://jobs.example.com/p") }); // and where to apply, one click away
    expect(ubt.suitable.map((p: any) => [p.title, p.reason])).toEqual([["运动控制算法工程师", "可迁移：做过运动控制"]]);
    // another spelling of a unit in the pool: shown as a maybe with what that company has, not taken for it
    expect(c722).toMatchObject({ status: "maybe", companyId: "", openPosts: 0 });
    expect(c722.candidates).toEqual([{ companyId: expect.any(String), companyName: "中国船舶集团有限公司第七二二研究所", openPosts: 1, applyUrl: expect.stringContaining("https://jobs.example.com/"), noticeUrl: expect.any(String) }]);
    // the person says it is that one: the name becomes its alias and the report finds it from then on; an agent has to ask
    expect(((await callTool("company.alias", { companyId: c722.candidates[0].companyId, alias: "中船七二二所" }, AGENT, s)) as any).proposal).toMatchObject({ kind: "company.alias" });
    await expect(callTool("company.alias", { companyId: c722.candidates[0].companyId, alias: "优必选" }, HUMAN, s)).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await callTool("company.alias", { companyId: c722.candidates[0].companyId, alias: "中船七二二所" }, HUMAN, s)).toMatchObject({ ok: true, aliases: ["中船七二二所"] });
    expect((((await callTool("research.report", { runId: started.runId }, HUMAN, s)) as any).companies[1])).toMatchObject({ status: "in", companyName: "中国船舶集团有限公司第七二二研究所", openPosts: 1 });
    // not in the pool, and the report gave no page that can be checked
    expect(yunxiu).toMatchObject({ name: "云岫机器人", status: "out", sourceUrl: "", candidates: [], finding: "" });

    // the pool moves, the report follows: nothing about the match was stored
    ingest(s.domain, dir, "capture", "yx", [L("云岫机器人", "机器人算法工程师", "p9")]);
    expect((((await callTool("research.report", { runId: started.runId }, HUMAN, s)) as any).companies[2])).toMatchObject({ status: "in", openPosts: 1 });
  });

  it("an answer that is not a report is refused and the run says why; a second round on the same topic is a report of its own", async () => {
    const { s, db } = setup();
    const a: any = await callTool("research.topic", { topic: "工业软件" }, AGENT, s);
    await callTool("llm.reply", { jobId: a.runId, text: JSON.stringify({ summary: "只有一句话" }) }, AGENT, s);
    await s.workflows.tick();
    expect(db.prepare("select status, error from agent_run where id = ?").get(a.runId)).toMatchObject({ status: "failed", error: expect.stringContaining("report_markdown") });
    const b: any = await callTool("research.topic", { topic: "工业软件" }, AGENT, s);
    await callTool("llm.reply", { jobId: b.runId, text: JSON.stringify({ ...ANSWER, companies: [], key_points: undefined }) }, AGENT, s);
    await s.workflows.tick();
    const items = ((await callTool("research.topics", {}, HUMAN, s)) as any).items;
    expect(items.map((x: any) => x.status).sort()).toEqual(["done", "failed"]);
    expect(existsSync((db.prepare("select output_path p from agent_run where id = ?").get(b.runId) as { p: string }).p)).toBe(true);
    // a report with no 要点 and no company (as every report before 2026-10-13 was) opens as it did, with nothing to check
    expect((await callTool("research.report", { runId: b.runId }, HUMAN, s)) as any).toMatchObject({ status: "done", keyPoints: [], companies: [], data: { pending: 0 } });
    await expect(callTool("research.topic", { topic: "  " }, HUMAN, s)).rejects.toMatchObject({ code: "MISSING_FIELD" });
    await expect(callTool("research.report", { runId: "nope" }, HUMAN, s)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("主题调研，由后台的联网 worker 来查", () => {
  it("costs that worker's quota and sends the profile out, so a request from a chat turn becomes a confirm card", async () => {
    const { s } = setup("openai-codex");
    // an embedded chat turn would set the worker going: that needs the person's yes. (The person's own external agent
    // is different — it researches itself, ADR-057 — see the describe above.)
    const asked: any = await callTool("research.topic", { topic: "人形机器人" }, { kind: "agent", via: "claude", cred: "turn", turnId: "T1" }, s);
    expect(asked.proposal).toMatchObject({ kind: "research.topic", decision: "pending", payload: { topic: "人形机器人" } });
    expect(((await callTool("research.topics", {}, HUMAN, s)) as any).items).toEqual([]);
  });
  it("the brief carries the person's profile, names the data tools as that worker sees them, and asks for points that cite data", () => {
    const { s } = setup();
    s.domain.db.prepare("insert into fact(id, kind, data_json, statement, grade, dedup_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)").run(ulid(), "direction", '{"keyword":"运动控制"}', "方向：运动控制", "本人确认", "运动控制", "2026-10-13", "2026-10-13");
    const p = buildTopicPrompt(s, "人形机器人", "美国", "");
    expect(p).toContain("方向：运动控制");
    expect(p).toContain("地区：美国");
    expect(p).toContain("company_financials、industry_companies、industry_reports、labor_us（前面带 mcp__jobosdata__）");
    expect(p).not.toContain("runId"); // the worker's tools are tied to its run already
    expect(p).toContain("key_points");
    expect(buildTopicPrompt(s, "人形机器人", "", "", { runId: "RUN1" })).toContain('runId: "RUN1"');
  });
});
