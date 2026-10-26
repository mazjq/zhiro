import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { createServices, testConfig } from "../services.js";
import { callTool, type Actor } from "../registry.js";
import { ingest, type Listing } from "../data/index.js";
import { otherSeeingModels } from "./notice-verify.js";

// a public address written as a number: no name to look up, so the guard lets the stubbed fetch answer
const SITE = "http://93.184.216.34";
const HUMAN: Actor = { kind: "human", via: "desktop" };
const AGENT: Actor = { kind: "agent", via: "test", cred: "agent" } as Actor;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "zhiro-notice-run-"));
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const listing: Listing = { externalId: "j1", url: `${SITE}/jobs/j1`, title: "控制算法工程师", company: "示例重工股份有限公司", locations: ["武汉"], publisher: "site:example", grade: "官方",
    isOriginal: true, confidence: 1, cohort: "2027届", batch: "校招", noticeUrl: `${SITE}/notice/1` } as Listing;
  ingest(domain, dir, "capture", "c1", [listing]);
  const campaignId = (db.prepare("select id from campaign").get() as any).id;
  db.prepare("update campaign set source_grade = '官方', notice_url = ?, apply_url = ? where id = ?").run(`${SITE}/notice/1`, `${SITE}/jobs/j1`, campaignId);
  const calls: string[] = [];
  const answer: any = { isRecruitment: true, issuer: "示例重工股份有限公司", cohort: "2027届", cohortQuote: "招聘对象：2027届毕业生", deadlineText: "网申截止时间：2099年10月31日", deadlineDate: "2099-10-31", deadlineImage: null, scope: "全部", doubts: "" };
  const llm: any = { model: () => ({ id: "fake", provider: "p", input: ["text"] }), models: { getModels: () => [], completeSimple: async (_m: any, req: any) => { calls.push(req.messages[0].content[0].text); return { content: [{ type: "text", text: JSON.stringify(answer) }] }; } } };
  const s = createServices({ db, domain, config: testConfig(dir, { sources: [] }) });
  (s as any).llm = llm;
  return { s, db, campaignId, calls, answer };
}
const page = (deadline = "2099年10月31日") => `<html><head><title>示例重工 2027届校园招聘公告</title></head><body><article>${"示例重工股份有限公司 2027届校园招聘公告。招聘对象：2027届毕业生。".repeat(80)}网申截止时间：${deadline}。投递入口：官网。</article></body></html>`;
function serve(pages: Record<string, { status?: number; body?: string }>) {
  vi.stubGlobal("fetch", vi.fn(async (u: string) => { const p = pages[new URL(u).pathname] ?? { status: 404 }; return new Response(p.body ?? "", { status: p.status ?? 200, headers: { "content-type": "text/html" } }); }));
}

describe("notice.verify: read, ask once, check, file", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("an official announcement becomes the batch's deadline; the same page again is not sent to the model", async () => {
    const { s, campaignId, calls } = setup();
    serve({ "/notice/1": { body: page() } });
    const r: any = await callTool("notice.verify", { campaignId, url: `${SITE}/notice/1` }, HUMAN, s);
    expect(r.results).toEqual([expect.objectContaining({ outcome: "fact", unchanged: false, factId: expect.any(String) })]);
    expect(r.now).toBe("官网截止 2099 年 10 月 31 日");
    expect(calls).toHaveLength(1);
    const again: any = await callTool("notice.verify", { campaignId, url: `${SITE}/notice/1` }, HUMAN, s);
    expect(again.results[0]).toMatchObject({ outcome: "fact", unchanged: true });
    expect(calls).toHaveLength(1);
    const checks: any = await callTool("notice.checks", { campaignId }, HUMAN, s);
    expect(checks.items).toHaveLength(2);
    expect(checks.items[0]).toMatchObject({ unchanged: true, deadline: "网申截止时间：2099年10月31日" });
  });

  it("a page that changed goes to the model again", async () => {
    const { s, campaignId, calls } = setup();
    serve({ "/notice/1": { body: page() } });
    await callTool("notice.verify", { campaignId, url: `${SITE}/notice/1` }, HUMAN, s);
    serve({ "/notice/1": { body: page("2099年10月31日（延期说明见后）") } });
    await callTool("notice.verify", { campaignId, url: `${SITE}/notice/1` }, HUMAN, s);
    expect(calls).toHaveLength(2);
  });

  it("a page that asks for a login is read as such: no model, nothing it said before is undone", async () => {
    const { s, db, campaignId, calls } = setup();
    serve({ "/notice/1": { body: page() } });
    await callTool("notice.verify", { campaignId, url: `${SITE}/notice/1` }, HUMAN, s);
    serve({ "/notice/1": { status: 401 } });
    const r: any = await callTool("notice.verify", { campaignId, url: `${SITE}/notice/1` }, HUMAN, s);
    expect(r.results[0]).toMatchObject({ outcome: "unreadable" });
    expect(calls).toHaveLength(1);
    expect((db.prepare("select count(*) n from deadline_fact where superseded_at is null and check_id is not null").get() as any).n).toBe(1);
  });

  it("the model's doubts are said among the reasons; nobody is asked to put a name on record", async () => {
    const { s, campaignId, answer } = setup();
    answer.issuer = "示例装备集团股份有限公司研发总院"; answer.doubts = "截止只写了月日";
    serve({ "/notice/1": { body: page() } });
    const r: any = await callTool("notice.verify", { campaignId, url: `${SITE}/notice/1` }, HUMAN, s);
    expect(r.results[0].outcome).toBe("review");
    expect(r.results[0].reasons).toContain("模型存疑：截止只写了月日");
    expect(r.results[0].aliasHint).toBeUndefined();
    expect(r.results[0].reasons.join("")).not.toContain("company.alias");
  });

  it("only the person puts an account on record", async () => {
    const { s, db } = setup();
    const companyId = (db.prepare("select id from company").get() as any).id;
    await expect(callTool("notice.account", { companyId, accountId: "MzA5", basis: "官网链到它" }, AGENT, s)).rejects.toThrow();
    expect(await callTool("notice.account", { companyId, accountId: "MzA5", basis: "官网链到它" }, HUMAN, s)).toEqual({ ok: true });
  });
});

describe("the second reader of a poster", () => {
  const first = { id: "a", provider: "p", input: ["text", "image"] };
  const llm = (models: any[], route?: string): any => ({ route: route ? () => ({ kind: route, name: "codex" }) : undefined, models: { getModels: () => models } });
  it("is another model of the provider that can see; none when a harness answers or there is no other", () => {
    expect(otherSeeingModels(llm([first, { id: "b", input: ["text"] }, { id: "c", input: ["text", "image"] }, { id: "d", input: ["image"] }]), first).map((m) => m.id)).toEqual(["c", "d"]);
    expect(otherSeeingModels(llm([first, { id: "b", input: ["text"] }]), first)).toEqual([]);
    expect(otherSeeingModels(llm([first, { id: "c", input: ["text", "image"] }], "harness"), first)).toEqual([]);
  });
});
