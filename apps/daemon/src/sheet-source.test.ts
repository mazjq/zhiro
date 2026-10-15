import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { openDb } from "./db.js";
import { Domain } from "./service/domain.js";
import { WorkflowEngine } from "./service/workflow.js";
import { callTool, dataOf, type Services } from "./registry.js";
import { sourceScan, scheduleSources, forgetPreviews, sources, csvToTable, listingsFromTable, isLocalPath, type Source } from "./data/index.js";

/**
 * G1: 「一个没碰过代码的人接一个在线表格，岗位出现在库里，第二天自动刷新」 — the same steps the settings page and an
 * agent take, through the tools: preview → add → the daily pull. And what an agent may and may not do on the way.
 */
const HUMAN = { kind: "human" as const, via: "desktop" as const };
const AGENT = { kind: "agent" as const, via: "mcp" as const };
afterEach(() => { vi.unstubAllGlobals(); delete sources.localtable; forgetPreviews(); });

/** A reader of tables kept in a file on this machine — the rules below are about any such reader, whichever it is. */
const localTable: Source = {
  id: "localtable", name: "本机表", aggregate: true, mode: "pull", describe: "测试用",
  detect: (u) => isLocalPath(u) && u.endsWith(".table"), siteKey: (u) => u,
  async table(cfg) { if (!existsSync(cfg.url!)) throw new Error(`FILE_NOT_FOUND: 找不到这个文件：${cfg.url}`); return csvToTable(readFileSync(cfg.url!, "utf8")); },
  async fetch(cfg, ctx) { return listingsFromTable(await this.table!(cfg, ctx), cfg, "本机表"); },
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-sheetsrc-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "sources: []\n", "utf8");
  const db = openDb(join(dir, "t.db"));
  const s: Services = { domain: new Domain(db), workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], agent: { mode: "default", maxWritesPerTurn: 10 } } };
  s.workflows.register(sourceScan(dataOf(s)));
  s.onSourcesChanged = () => scheduleSources(dataOf(s)); // as the daemon wires it
  return { dir, db, s };
}
const posts = (db: Services["domain"]["db"]) => db.prepare("select co.name, p.title, p.status from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id order by co.name, p.title").all();

/** A public 飞书多维表格 as its web client is answered: an anonymous session, the fields, the rows (gzip + base64). */
function feishu(fields: string[], rows: string[][]) {
  const zip = (o: unknown) => gzipSync(Buffer.from(JSON.stringify(o))).toString("base64");
  const fieldMap = Object.fromEntries(fields.map((name, i) => [`f${i}`, { name, type: 1 }]));
  const recordMap = () => Object.fromEntries(rows.map((r, n) => [`rec${n}`, Object.fromEntries(r.map((v, i) => [`f${i}`, { value: [{ type: "text", text: v }] }]))]));
  vi.stubGlobal("fetch", async (url: string) => {
    const u = String(url);
    if (u.includes("/clientvars")) return Response.json({ code: 0, data: { table: zip({ meta: { recordsNum: rows.length }, fieldMap }) } });
    if (u.includes("/records")) return Response.json({ code: 0, data: { records: zip({ recordMap: recordMap() }) } });
    return new Response("", { headers: { "set-cookie": "session=anon; Path=/" } });
  });
  return rows;
}
const BASE = "https://example.feishu.cn/base/AbCdEf123?table=tblXyz&view=vewAbc";

describe("接一张在线表格（飞书多维表，自己的列名）", () => {
  it("preview shows what would come in; with the mapping confirmed it is subscribed, filed, and refreshed the next day", async () => {
    const { db, s } = setup();
    const rows = feishu(["单位名称", "招聘职位", "网申截止", "投递地址", "工作城市", "备注"], [
      ["示例重工", "控制算法工程师、仿真工程师", "2099-10-31", "https://apply.example.com/a", "武汉", ""],
      ["示例电子", "电机控制工程师", "招满为止", "https://apply.example.com/b", "深圳", ""],
    ]);

    const pv: any = await callTool("source.preview", { url: BASE }, HUMAN, s);
    expect(pv).toMatchObject({ source: "feishu-base", name: "飞书多维表格", table: true, subscribed: null, rows: 2, posts: 3, companies: 2, problem: "" });
    expect(pv.columns).toEqual({ company: "单位名称", positions: "招聘职位", deadline: "网申截止", applyUrl: "投递地址", cities: "工作城市" });
    expect(pv.fields.find((f: any) => f.field === "company")).toEqual({ field: "company", label: "公司", required: true });
    expect(posts(db)).toEqual([]);

    // the person changes one line of the mapping in the form (here: leaves the city column out) and confirms
    const { cities: _drop, ...columns } = pv.columns;
    const added: any = await callTool("source.add", { url: BASE, name: "我的校招表", columns }, HUMAN, s);
    expect(added.source).toBe("feishu-base");
    expect(((await callTool("source.preview", { url: BASE }, HUMAN, s)) as any).subscribed).toBe(added.id);
    const run: any = await callTool("scan.run", { configId: added.id }, HUMAN, s);
    expect(run).toMatchObject({ received: 3, positionsNew: 3 });
    expect(posts(db)).toEqual([{ name: "示例电子", title: "电机控制工程师", status: "open" }, { name: "示例重工", title: "仿真工程师", status: "open" }, { name: "示例重工", title: "控制算法工程师", status: "open" }]);
    const listed: any = await callTool("source.list", {}, HUMAN, s);
    expect(listed.configured[0]).toMatchObject({ id: added.id, name: "我的校招表", everyHours: 24, lastRun: { found: 3, error: "" } });

    // its daily pull was scheduled when it was added; the next day the sheet has a new row and has lost a post
    await s.workflows.tick();
    const next = (db.prepare("select next_run_at n from workflow where kind = 'source_scan'").get() as { n: string }).n;
    expect(Date.parse(next) - Date.now()).toBeGreaterThan(23 * 3600_000);
    rows[0][1] = "控制算法工程师";
    rows.push(["示例光学", "光学工程师", "2099-12-31", "https://apply.example.com/d", "苏州", ""]);
    expect(await s.workflows.tick(new Date(Date.parse(next) + 1000).toISOString())).toBe(1);
    expect(posts(db)).toEqual([{ name: "示例光学", title: "光学工程师", status: "open" }, { name: "示例电子", title: "电机控制工程师", status: "open" }, { name: "示例重工", title: "仿真工程师", status: "closed" }, { name: "示例重工", title: "控制算法工程师", status: "open" }]);
  });

  it("without a mapping the columns are guessed at add; a sheet with no company column is refused with the reason", async () => {
    const { db, s } = setup();
    feishu(["企业", "岗位"], [["示例重工", "控制算法工程师"]]);
    const added: any = await callTool("source.add", { url: BASE, name: "表" }, AGENT, s);
    expect(s.config.sources[0]).toMatchObject({ id: added.id, columns: { company: "企业", positions: "岗位" } });
    expect(added.action).toBeTruthy(); // an agent adds a public link at once, on record
    feishu(["序号", "说明"], [["1", "abc"]]);
    await expect(callTool("source.add", { url: BASE.replace("tblXyz", "tblOther"), name: "坏表" }, HUMAN, s)).rejects.toMatchObject({ code: "BAD_TABLE", message: expect.stringContaining("没认出哪一列是公司") });
    expect(db.prepare("select count(*) n from position").get()).toEqual({ n: 0 });
  });

  it("a sheet that is not public says so", async () => {
    const { s } = setup();
    vi.stubGlobal("fetch", async () => new Response("", {})); // no anonymous session handed out
    await expect(callTool("source.preview", { url: BASE }, HUMAN, s)).rejects.toMatchObject({ code: "NOT_PUBLIC", message: expect.stringContaining("互联网上获得链接的人可阅读") });
  });
});

describe("本机文件与删除：agent 的边界", () => {
  const CSV = "公司,招聘岗位,截止时间\n示例重工,控制算法工程师,2099-10-31\n示例电子,电机控制工程师,2099-10-31\n";
  it("a file on this machine: only the person previews it; an agent's add becomes a confirm card that names the path", async () => {
    const { dir, s } = setup();
    sources.localtable = localTable;
    const file = join(dir, "jobs.table");
    writeFileSync(file, CSV, "utf8");
    await expect(callTool("source.preview", { url: file }, AGENT, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const asked: any = await callTool("source.add", { url: file, name: "本机表" }, AGENT, s);
    expect(asked.proposal).toMatchObject({ kind: "source.add", decision: "pending", payload: { url: file } });
    expect(s.config.sources).toEqual([]);
    expect(((await callTool("source.preview", { url: file }, HUMAN, s)) as any)).toMatchObject({ source: "localtable", posts: 2, problem: "" });
    // the person confirms the card: the subscription exists
    await callTool("proposal.decide", { id: asked.proposal.id, decision: "approved", payloadHash: asked.proposal.payloadHash }, HUMAN, s);
    expect(s.config.sources.map((c) => c.url)).toEqual([file]);

    // a card whose work fails goes back to waiting with the reason, instead of counting as done
    const gone: any = await callTool("source.add", { url: join(dir, "moved-away.table"), name: "不在了" }, AGENT, s);
    await expect(callTool("proposal.decide", { id: gone.proposal.id, decision: "approved", payloadHash: gone.proposal.payloadHash }, HUMAN, s)).rejects.toMatchObject({ code: "FILE_NOT_FOUND" });
    expect(((await callTool("proposal.list", {}, HUMAN, s)) as any).items.map((p: any) => p.id)).toEqual([gone.proposal.id]);
  });

  it("removing a subscription clears what only it brought, keeps what the person holds, and an agent has to ask", async () => {
    const { dir, db, s } = setup();
    sources.localtable = localTable;
    const file = join(dir, "jobs.table");
    writeFileSync(file, CSV, "utf8");
    const { id }: any = await callTool("source.add", { url: file, name: "本机表" }, HUMAN, s);
    await callTool("scan.run", { configId: id }, HUMAN, s);
    const held = (db.prepare("select p.id from position p where p.title = '控制算法工程师'").get() as { id: string }).id;
    await callTool("position.watch", { positionId: held, priority: 2 }, HUMAN, s);

    const asked: any = await callTool("source.remove", { id }, AGENT, s);
    expect(asked.proposal).toMatchObject({ kind: "source.remove", decision: "pending" });
    expect(s.config.sources).toHaveLength(1);

    const removed: any = await callTool("source.remove", { id }, HUMAN, s);
    expect(removed).toMatchObject({ id, name: "本机表", droppedCampaigns: 1 });
    expect(s.config.sources).toEqual([]);
    expect(posts(db)).toEqual([{ name: "示例重工", title: "控制算法工程师", status: "open" }]);
    await expect(callTool("source.remove", { id }, HUMAN, s)).rejects.toMatchObject({ code: "NOT_FOUND" });

    // its schedule ends with it — at once — and starts again if the same table is added back the same day
    expect(db.prepare("select state from workflow where kind = 'source_scan'").all()).toEqual([{ state: "completed" }]);
    await callTool("source.add", { url: file, name: "本机表" }, HUMAN, s);
    expect(db.prepare("select state from workflow where kind = 'source_scan'").all()).toEqual([{ state: "running" }]);
    expect(await s.workflows.tick()).toBe(1);
    expect(posts(db)).toHaveLength(2);
  });
});
