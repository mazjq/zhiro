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
import { addSite } from "./trust.js";
import { noticeVerify } from "../workflows/notice.js";

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
  // the company's site on record, as an exchange disclosure would put it (trust.ts): only such sites count as its own
  addSite(db, { companyId: (db.prepare("select id from company").get() as any).id, siteKey: "93.184.216.34", rootKind: "exchange", basisUrl: "https://example.org/disclosure", basisQuote: "公司网址：93.184.216.34", fingerprint: "test" });
  const calls: string[] = [];
  const answer: any = { isRecruitment: true, issuer: "示例重工股份有限公司", cohort: "2027届", cohortQuote: "招聘对象：2027届毕业生", deadlineText: "网申截止时间：2099年10月31日", deadlineDate: "2099-10-31", deadlineImage: null, scope: "全部", doubts: "" };
  const llm: any = { model: () => ({ id: "fake", provider: "p", input: ["text"] }), models: { getModels: () => [], completeSimple: async (_m: any, req: any) => { calls.push(req.messages[0].content[0].text); return { content: [{ type: "text", text: JSON.stringify(answer) }] }; } } };
  const s = createServices({ db, domain, config: testConfig(dir, { sources: [] }) });
  (s as any).llm = llm;
  return { s, db, campaignId, calls, answer };
}
const page = (deadline = "2099年10月31日") => `<html><head><title>示例重工 2027届校园招聘公告</title></head><body><article>${"示例重工股份有限公司 2027届校园招聘公告。招聘对象：2027届毕业生。".repeat(80)}网申截止时间：${deadline}。投递入口：官网。</article></body></html>`;
// a site's home page: a few links of its own, and the ones given
const home = (links: [string, string][]) => `<html><head><title>示例重工</title></head><body>${["关于我们", "新闻", "产品", "联系我们", "投资者"].map((w, n) => `<a href="${SITE}/p${n}">${w}</a>`).join("")}${links.map(([href, text]) => `<a href="${href}">${text}</a>`).join("")}</body></html>`;
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

describe("preparing an application checks its announcement; the post's page says what was found", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("one check per batch an hour, in the background; three lines on the post", async () => {
    const { s, db, campaignId } = setup();
    const post = (db.prepare("select id from position where campaign_id = ?").get(campaignId) as any).id;
    const started: string[] = [];
    s.workflows.register(noticeVerify(s));
    const real = s.workflows.start.bind(s.workflows);
    (s.workflows as any).start = (kind: string, subject: string, key: string, ...rest: any[]) => { if (kind === "notice_verify") started.push(key); return real(kind, subject, key, ...rest); };
    await callTool("application.create", { positionId: post }, HUMAN, s);
    expect(started).toHaveLength(1);
    expect(started[0]).toContain(campaignId);
    serve({ "/notice/1": { body: page() }, "/jobs/j1": { body: page() } });
    await callTool("notice.verify", { campaignId }, HUMAN, s);
    const p: any = await callTool("position.get", { id: post }, HUMAN, s);
    expect(p.notice.lines).toEqual([expect.stringMatching(/^公告复查于 \d\d-\d\d：网申截止时间：2099年10月31日$/), expect.stringMatching(/^网申入口能打开（\d\d-\d\d）$/), "是否还在收申请：没确认"]);
    // a later check of the same page is what the post goes by, not the first one
    serve({ "/notice/1": { status: 401 }, "/jobs/j1": { body: page() } });
    await callTool("notice.verify", { campaignId }, HUMAN, s);
    const later: any = await callTool("position.get", { id: post }, HUMAN, s);
    expect(later.notice.lines[0]).toMatch(/^公告复查于 \d\d-\d\d：网申截止时间：2099年10月31日$/); // the application page still says it
    serve({ "/notice/1": { status: 401 }, "/jobs/j1": { status: 401 }, "/": { body: home([]) } });
    await callTool("notice.verify", { campaignId }, HUMAN, s);
    const none: any = await callTool("position.get", { id: post }, HUMAN, s);
    expect(none.notice.lines[0]).toMatch(/^这次没读到公告（\d\d-\d\d）；上次 \d\d-\d\d 的记录仍在$/);
    expect(none.notice.lines[1]).toMatch(/^网申入口这次没打开/);
  });
});

describe("not taken from the batch's own links: look on the company's own sites (D1)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("an announcement linked from its site's home page is found and checked; once a week", async () => {
    const { s, campaignId, calls } = setup();
    serve({ "/notice/1": { status: 401 }, "/jobs/j1": { status: 401 },
      "/": { body: home([[`${SITE}/notice/2`, "2027届校园招聘公告"], [`${SITE}/notice/old`, "2025届校园招聘公告"], ["https://elsewhere.example.org/n", "2027届校园招聘公告"]]) },
      "/notice/2": { body: page() } });
    const r: any = await callTool("notice.verify", { campaignId }, HUMAN, s);
    const found = r.results.filter((x: any) => x.found);
    expect(found.map((x: any) => x.url)).toEqual([`${SITE}/notice/2`]); // not an earlier cohort's, not another site's
    expect(found[0]).toMatchObject({ outcome: "fact", factId: expect.any(String) });
    expect(r.now).toBe("官网截止 2099 年 10 月 31 日");
    const n = calls.length;
    serve({ "/notice/1": { status: 401 }, "/jobs/j1": { status: 401 } });
    const again: any = await callTool("notice.verify", { campaignId }, HUMAN, s);
    expect(again.results.some((x: any) => x.found)).toBe(false); // looked this week already
    expect(calls).toHaveLength(n);
  });

  it("two pieces saying different deadlines: neither is taken", async () => {
    const { s, campaignId } = setup();
    let n = 0;
    serve({ "/notice/1": { body: page() }, "/jobs/j1": { body: page("2099年11月30日") } });
    (s as any).llm.models.completeSimple = async (_m: any, req: any) => {
      const late = req.messages[0].content[0].text.includes("11月30日");
      n++;
      return { content: [{ type: "text", text: JSON.stringify({ isRecruitment: true, issuer: "示例重工股份有限公司", cohort: "2027届", cohortQuote: "招聘对象：2027届毕业生", deadlineText: `网申截止时间：2099年${late ? "11月30日" : "10月31日"}`, deadlineImage: null, scope: "全部", doubts: "" }) }] };
    };
    const r: any = await callTool("notice.verify", { campaignId }, HUMAN, s);
    expect(n).toBe(2);
    expect(r.results.map((x: any) => x.outcome)).toEqual(["review", "review"]);
    expect(r.results[0].reasons.join()).toContain("几份材料写的截止不同");
  });
});
