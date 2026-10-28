import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { createServices, testConfig } from "../services.js";
import { callTool, type Actor } from "../registry.js";
import { ingest, type Listing } from "../data/index.js";
import { otherSeeingModels, readNotice } from "./notice-verify.js";

describe("the pictures of a post: each once, as many as one request holds", () => {
  afterEach(() => vi.unstubAllGlobals());
  const IMG = "http://93.184.216.34";
  const post = (n: number) => `<html><body><h1 id="activity-name">2027届校园招聘</h1><div id="js_content">${"示例重工 2027届校园招聘。".repeat(5)}${[...Array(n)].map((_, i) => `<img data-src="${IMG}/p${i}.png">`).join("")}</div></body></html>`;
  const serveWith = (n: number, same: (i: number) => number) => vi.stubGlobal("fetch", vi.fn(async (u: string) => {
    const p = new URL(u).pathname;
    if (p.startsWith("/s/")) return new Response(post(n), { headers: { "content-type": "text/html" } });
    return new Response(Buffer.alloc(3000, same(Number(/p(\d+)/.exec(p)![1]))), { headers: { "content-type": "image/png" } });
  }));
  it("the same picture under two addresses is sent once; one past the limit leaves the reading incomplete", async () => {
    serveWith(3, (i) => (i === 2 ? 0 : i));
    const a = await readNotice({} as any, "https://mp.weixin.qq.com/s/a");
    expect([a.pics.length, a.doc.complete]).toEqual([2, true]);
    serveWith(14, (i) => i);
    const b = await readNotice({} as any, "https://mp.weixin.qq.com/s/b");
    expect([b.pics.length, b.doc.complete]).toEqual([12, false]);
  });
});
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

  it("an empty reply is asked again, then that piece is left unread: the batch's run does not fail", async () => {
    const { s, campaignId } = setup();
    serve({ "/notice/1": { body: page() } });
    let n = 0;
    (s as any).llm.models.completeSimple = async () => { n++; return { content: [], stopReason: "error", errorMessage: "overloaded" }; };
    const r: any = await callTool("notice.verify", { campaignId, url: `${SITE}/notice/1` }, HUMAN, s);
    expect(n).toBe(2);
    expect(r.results[0]).toMatchObject({ outcome: "unreadable", reasons: ["模型这次没给出结果：overloaded"] });
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

describe("a unit's announcement on its group's hiring platform (E2, E3)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("found on the platform by the unit's name, and taken as published by the group", async () => {
    const dir = mkdtempSync(join(tmpdir(), "zhiro-notice-group-"));
    const db = openDb(join(dir, "t.db"));
    const domain = new Domain(db);
    const unit = "示例集团有限公司第一研究所";
    ingest(domain, dir, "capture", "c1", [{ externalId: "u1", url: "https://mp.weixin.qq.com/s/x", title: "控制算法工程师", company: unit, locations: ["武汉"], publisher: "x", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "秋招" } as Listing,
      { externalId: "g1", url: "https://example-group.cn/jobs/1", title: "工程师", company: "示例集团", locations: ["北京"], publisher: "x", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "秋招" } as Listing]);
    const id = (n: string) => (db.prepare("select id from company where name = ?").get(n) as any).id as string;
    const root = addSite(db, { companyId: id("示例集团"), siteKey: "example-group.cn", rootKind: "gov", basisUrl: "http://www.sasac.gov.cn/x", basisQuote: "示例集团有限公司 → example-group.cn", fingerprint: "g" }) as { id: string };
    addSite(db, { companyId: id("示例集团"), siteKey: "93.184.216.34", rootKind: "linked", basisUrl: "https://example-group.cn/", basisQuote: "人才招聘", fingerprint: "l", parentId: root.id });
    const campaignId = (db.prepare("select c.id from campaign c where c.company_id = ?").get(id(unit)) as any).id;
    db.prepare("update campaign set notice_url = ?, apply_url = ? where id = ?").run("https://mp.weixin.qq.com/s/x", "", campaignId);
    const llm: any = { model: () => ({ id: "fake", provider: "p", input: ["text"] }), models: { getModels: () => [], completeSimple: async () => ({ content: [{ type: "text", text: JSON.stringify({ isRecruitment: true, issuer: unit, cohort: "2027届", cohortQuote: "招聘对象：2027届毕业生", deadlineText: "网申截止时间：2099年10月31日", deadlineImage: null, scope: "全部", doubts: "", batchQuote: "2027届校园招聘公告" }) }] }) } };
    const s = createServices({ db, domain, config: testConfig(dir, { sources: [] }) });
    (s as any).llm = llm;
    const body = `<html><head><title>${unit} 2027届校园招聘公告</title></head><body><article>${`${unit} 2027届校园招聘公告。招聘对象：2027届毕业生。`.repeat(40)}网申截止时间：2099年10月31日。</article></body></html>`;
    vi.stubGlobal("fetch", vi.fn(async (u: string) => {
      const url = new URL(u);
      if (url.hostname === "mp.weixin.qq.com") return new Response("", { status: 401 });
      if (url.pathname === "/") return new Response(home([[`${SITE}/n/unit`, `${unit}2027届校园招聘公告`], [`${SITE}/n/other`, "示例集团有限公司第二研究所2027届校园招聘公告"]]), { headers: { "content-type": "text/html" } });
      if (url.pathname === "/n/unit") return new Response(body, { headers: { "content-type": "text/html" } });
      return new Response("", { status: 404 });
    }));
    const r: any = await callTool("notice.verify", { campaignId }, HUMAN, s);
    const found = r.results.filter((x: any) => x.found);
    expect(found.map((x: any) => x.url)).toEqual([`${SITE}/n/unit`]); // the unit's, not its sibling's
    expect(found[0]).toMatchObject({ outcome: "fact" });
    const checks: any = await callTool("notice.checks", { campaignId }, HUMAN, s);
    expect(checks.items.find((k: any) => k.url === `${SITE}/n/unit`).gates.publisher).toContain("「示例集团」自己的招聘平台");
  });
});
