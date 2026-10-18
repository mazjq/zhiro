import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { WorkflowEngine } from "./workflow.js";
import { callTool, type Services } from "../registry.js";
import { canonical, riskOf, parseDetail, parseSearch, permit, consume, handlePage, status, resume, pause } from "./boss.js";

/** Made-up pages with the shape BOSS's pages have (2026-10-18): a status line first, a recruiter card after the
 * description, the person's own masked phone and 竞争力分析 block, and a list of other posts at the end. */
const DETAIL = `首页
职位
消息
简历
182****0000
招聘中
四足运动控制实习生 200-300元/天
武汉 5天/周 4个月 硕士
感兴趣 立即沟通
五险一金带薪年假
公司基本信息
青岚机器人
A轮
100-499人
智能硬件
职位描述
C/C++
强化学习
岗位职责：
1. 参与四足机器人运动控制算法研发，搭建强化学习训练与部署流程。
2. 解决仿真到真机的各类问题。
任职要求：
1. 硕士在读，控制、自动化相关专业。
王女士
3日内活跃
青岚机器人
·
招聘经理
竞争力分析
个人综合排名：在人中排名第
BOSS 安全提示
公司介绍
青岚机器人是一家做四足机器人的公司。
工商信息
公司名称
武汉青岚机器人科技有限公司
法定代表人
张某
工作地址
武汉洪山区示例路 1 号
看过该职位的人还看了
算法实习生
150-200元/天
别家公司`;

const SEARCH = `首页
职位
182****0000
搜索
武汉
四足运动控制实习生
-元/天
5天/周
4个月
硕士
青岚机器人
武汉·洪山区·光谷
控制算法工程师（2027届校招）
-K·薪
在校/应届
硕士
远澜智能
武汉·江夏区
完善信息提醒
热门职位`;

const T0 = Date.parse("2026-10-20T02:00:00Z"); // 10:00 Beijing
const fixed = (v: number) => () => v;

function setup(boss?: Services["config"]["boss"]) {
  const dir = mkdtempSync(join(tmpdir(), "zhiro-boss-"));
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const s: Services = { domain, workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], boss } };
  return { dir, db, domain, s };
}
const FULL = { rampDays: 0 }; // tests of the plain budget: no half-budget start

describe("BOSS 直聘 (D-27)", () => {
  it("knows its pages by one spelling and refuses anything else", () => {
    expect(canonical("https://www.zhipin.com/web/geek/jobs?query=控制&city=101200100&ka=x")).toEqual({ kind: "search", target: "https://www.zhipin.com/web/geek/jobs?query=%E6%8E%A7%E5%88%B6&city=101200100" });
    expect(canonical("https://www.zhipin.com/job_detail/abc123_X.html?ka=y#z")).toMatchObject({ kind: "detail", jobId: "abc123_X" });
    expect(canonical("https://www.zhipin.com/wuhan/").kind).toBe("home");
    for (const bad of ["http://www.zhipin.com/wuhan/", "https://notzhipin.com/wuhan/", "https://www.zhipin.com/web/geek/chat", "not a url"]) expect(() => canonical(bad)).toThrow();
  });

  it("stops on page-level checks, not on words in a job description", () => {
    expect(riskOf("安全验证\n请拖动滑块完成验证……" + "x".repeat(60))).toMatch(/安全验证/);
    expect(riskOf("")).toMatch(/空的/);
    expect(riskOf(DETAIL, "https://www.zhipin.com/web/user/safe/verify-slider")).toMatch(/验证或登录/);
    expect(riskOf(DETAIL.replace("2. 解决", "2. 负责登录模块与验证码识别，解决"))).toBeNull();
  });

  it("reads a job page by its blocks: the post only, without the recruiter, the person, or other posts", () => {
    const { post, missing } = parseDetail(DETAIL);
    expect(missing).toEqual([]);
    expect(post).toMatchObject({ title: "四足运动控制实习生", salary: "200-300元/天", city: "武汉", daysPerWeek: "5天/周", months: "4个月", degree: "硕士",
      brand: "青岚机器人", company: "武汉青岚机器人科技有限公司", address: "武汉洪山区示例路 1 号", intern: true });
    expect(post.jd).toContain("搭建强化学习训练与部署流程");
    for (const gone of ["王女士", "3日内活跃", "182", "竞争力分析", "算法实习生", "招聘经理"]) expect(post.jd).not.toContain(gone);
    // the card without an activity line (seen on another page): name, brand, ·, role
    expect(parseDetail(DETAIL.replace("3日内活跃\n", "")).post.jd).not.toContain("王女士");
    expect(parseDetail("招聘中\n只有一行").missing).toEqual(["岗位名", "公司", "职位描述"]);
  });

  it("lists a search page's posts for the person to pick from", () => {
    expect(parseSearch(SEARCH)).toEqual([
      { title: "四足运动控制实习生", company: "青岚机器人", place: "武汉·洪山区·光谷", tags: ["5天/周", "4个月", "硕士"] },
      { title: "控制算法工程师（2027届校招）", company: "远澜智能", place: "武汉·江夏区", tags: ["在校/应届", "硕士"] },
    ]);
  });

  it("a session opens on a city page, details come after a search, each page waits its turn, each permit is used once", () => {
    const { db } = setup();
    expect(() => permit(db, FULL, "https://www.zhipin.com/web/geek/jobs?query=a&city=1", T0, fixed(0.5))).toThrow(/首页/);
    const home = permit(db, FULL, "https://www.zhipin.com/wuhan/", T0, fixed(0.5));
    expect(home.waitSeconds).toBe(0);
    expect(() => permit(db, FULL, "https://www.zhipin.com/web/geek/jobs?query=a&city=1", T0, fixed(0.5))).toThrow(/还没交回/);
    consume(db, home.permitId, "https://www.zhipin.com/wuhan/", T0 + 1000);
    expect(() => permit(db, FULL, "https://www.zhipin.com/job_detail/j1.html", T0 + 2000, fixed(0.5))).toThrow(/先打开搜索页/);
    const search = permit(db, FULL, "https://www.zhipin.com/web/geek/jobs?query=a&city=1", T0 + 2000, fixed(0.5));
    expect(search.waitSeconds).toBe(6); // home → search: 4–10 s, here the middle; minus the second already gone
    expect(() => consume(db, search.permitId, "https://www.zhipin.com/web/geek/jobs?query=a&city=1", T0 + 3000)).toThrow(/还没到时间/);
    expect(() => consume(db, search.permitId, "https://www.zhipin.com/web/geek/jobs?query=b&city=1", T0 + 9000)).toThrow(/不是/);
    consume(db, search.permitId, "https://www.zhipin.com/web/geek/jobs?query=a&city=1", T0 + 9000);
    expect(() => consume(db, search.permitId, "https://www.zhipin.com/web/geek/jobs?query=a&city=1", T0 + 9500)).toThrow(/用过/);
    const late = permit(db, FULL, "https://www.zhipin.com/job_detail/j1.html", T0 + 10_000, fixed(0.5));
    expect(() => consume(db, late.permitId, "https://www.zhipin.com/job_detail/j1.html", Date.parse(late.expiresAt) + 1)).toThrow(/过期/);
  });

  it("pauses like a person: a page after a list, after a page, now and then a long look elsewhere", () => {
    expect(pause(null, "home", fixed(0.9))).toBe(0);
    expect(pause("search", "detail", fixed(0))).toBe(8 + 40); // rnd 0 < 0.08: the long look too
    expect(pause("detail", "detail", fixed(0.99))).toBe(45);
  });

  it("holds each session and each day to the budget, and starts at half while new", () => {
    const { db } = setup();
    const cfg = { rampDays: 0, sessionsPerDay: 1, perSession: { home: 1, search: 1, detail: 1 } };
    let t = T0;
    const visit = (url: string) => { const p = permit(db, cfg, url, t, fixed(0.5)); t = Date.parse(p.notBefore) + 500; consume(db, p.permitId, url, t); t += 500; };
    visit("https://www.zhipin.com/wuhan/");
    visit("https://www.zhipin.com/web/geek/jobs?query=a&city=1");
    expect(() => permit(db, cfg, "https://www.zhipin.com/web/geek/jobs?query=a&city=1&page=2", t, fixed(0.5))).toThrow(/额度/);
    visit("https://www.zhipin.com/job_detail/j1.html");
    expect(() => permit(db, cfg, "https://www.zhipin.com/job_detail/j2.html", t, fixed(0.5))).toThrow(/额度/);
    expect(() => permit(db, cfg, "https://www.zhipin.com/wuhan/", t + 40 * 60_000, fixed(0.5))).toThrow(/会话已经用完/); // a new session the same day
    const fresh = setup().db; // a new library: half of 4 sessions and of 5 searches
    const st = status(fresh, {}, T0);
    expect(st.halfWhileNew).toBe(true);
    expect(st.limits).toMatchObject({ sessionsPerDay: 2, perSession: { home: 1, search: 3, detail: 8 } });
  });

  it("a check stops visits for a day; the person can lift it", () => {
    const { db, domain, dir } = setup(FULL);
    const p = permit(db, FULL, "https://www.zhipin.com/wuhan/", T0, fixed(0.5));
    const r = handlePage(domain, dir, { permitId: p.permitId, url: "https://www.zhipin.com/wuhan/", text: "安全验证 请完成验证" + "x".repeat(60) }, T0 + 1000);
    expect(r.outcome).toBe("stopped");
    expect(() => permit(db, FULL, "https://www.zhipin.com/wuhan/", T0 + 3600_000, fixed(0.5))).toThrow(/暂停/);
    resume(db, T0 + 2 * 3600_000);
    expect(permit(db, FULL, "https://www.zhipin.com/wuhan/", T0 + 3 * 3600_000, fixed(0.5)).kind).toBe("home");
  });

  it("files a job page as one reprinted post, keeps nothing of the person, and completes a preview only with what the page says", async () => {
    const { db, domain, dir, s } = setup(FULL);
    let t = T0;
    const visit = (url: string, text: string, fields?: Record<string, string>) => { const p = permit(db, FULL, url, t, fixed(0.5)); t = Date.parse(p.notBefore) + 500; const r = handlePage(domain, dir, { permitId: p.permitId, url, text, fields }, t); t += 500; return { r, p }; };
    visit("https://www.zhipin.com/wuhan/", "城市首页" + "x".repeat(60));
    const list = visit("https://www.zhipin.com/web/geek/jobs?query=a&city=1", SEARCH).r as any;
    expect(list.items).toHaveLength(2);
    const filed = visit("https://www.zhipin.com/job_detail/j1.html", DETAIL).r as any;
    expect(filed).toMatchObject({ outcome: "filed", company: "武汉青岚机器人科技有限公司", intern: true });
    const pos: any = await callTool("position.get", { id: filed.positionId }, { kind: "human", via: "desktop" }, s);
    expect(pos.position.jdText).toContain("200-300元/天 · 5天/周 · 4个月 · 硕士");
    for (const gone of ["182", "王女士", "竞争力分析", "个人综合排名"]) expect(JSON.stringify(pos)).not.toContain(gone);
    expect(domain.listPositions({ internship: true }).items.map((p: any) => p.title)).toContain("四足运动控制实习生");
    // a page whose description block is gone: a preview, completed from the same page within the permit's life, no second permit
    const thin = DETAIL.replace("职位描述", "岗位详情");
    const { r: pre, p } = visit("https://www.zhipin.com/job_detail/j2.html", thin);
    expect(pre).toMatchObject({ outcome: "preview", missing: ["职位描述"] });
    expect(() => handlePage(domain, dir, { permitId: p.permitId, url: "https://www.zhipin.com/job_detail/j2.html", text: thin, fields: { jd: "这一句页面上没有，是编的，而且足够长，超过三十个字符了吧" } }, t)).toThrow(/找不到/);
    const done = handlePage(domain, dir, { permitId: p.permitId, url: "https://www.zhipin.com/job_detail/j2.html", text: thin, fields: { jd: "岗位职责：\n1. 参与四足机器人运动控制算法研发，搭建强化学习训练与部署流程。" } }, t) as any;
    expect(done.outcome).toBe("filed");
  });

  it("an agent's BOSS link goes through boss.page, not listing.capture", async () => {
    const { s } = setup();
    await expect(callTool("listing.capture", { url: "https://www.zhipin.com/job_detail/j1.html", text: DETAIL }, { kind: "agent", via: "claude", cred: "agent" } as any, s)).rejects.toMatchObject({ code: "USE_BOSS_PAGE" });
  });
});
