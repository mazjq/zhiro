import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { readJoblist, pageFail, search, detail, candidates, cityCode, postOf } from "./boss-search.js";
import { stopOf } from "./boss.js";
import type { Cdp, CdpEvent } from "./boss-cdp.js";

/** Made-up jobs in the shape BOSS's joblist.json had on 2026-10-18. */
const job = (n: number, extra: Record<string, unknown> = {}) => ({ encryptJobId: `job${n}`, jobName: `运动控制实习生${n}`, salaryDesc: "200-300元/天", cityName: "武汉", areaDistrict: "洪山区", businessDistrict: "光谷",
  jobExperience: "", jobDegree: "硕士", daysPerWeekDesc: "5天/周", leastMonthDesc: "4个月", brandName: `青岚机器人${n}`, brandScaleName: "100-499人", brandStageName: "A轮", brandIndustry: "智能硬件", skills: ["MPC", "强化学习"], jobLabels: [], ...extra });
const page = (jobs: unknown[], hasMore = true, code = 0, message = "Success") => ({ code, message, zpData: { jobList: jobs, hasMore } });

/**
 * A browser that answers like BOSS: opening the search page makes the page POST its first joblist; scrolling far enough
 * makes it POST the next one; a job page shows what READ_DETAIL reads. `script` decides what comes back.
 */
function fakeBrowser(script: { pages: unknown[]; detail?: Record<string, string>; href?: string; wheelsPerPage?: number }): Cdp & { navigations: string[] } {
  const events: CdpEvent[] = [], navigations: string[] = [];
  let served = 0, wheels = 0, n = 0, href = "about:blank";
  const serve = () => {
    const body = script.pages[served];
    if (body === undefined) return;
    served++;
    const id = `r${++n}`, url = "https://www.zhipin.com/wapi/zpgeek/search/joblist.json?_=1";
    events.push({ method: "Network.requestWillBeSent", params: { requestId: id, request: { url, postData: `page=${served}&pageSize=15&city=101200100&query=${encodeURIComponent("运动控制 实习")}` } } });
    events.push({ method: "Network.responseReceived", params: { requestId: id, response: { url, status: 200 } } });
    bodies.set(id, body);
  };
  const bodies = new Map<string, unknown>();
  return {
    events, navigations, close() {},
    async send(method, params: any = {}) {
      if (method === "Page.navigate") { navigations.push(params.url); href = script.href ?? params.url; if (/\/web\/geek\/jobs/.test(params.url)) serve(); return {}; }
      if (method === "Input.dispatchMouseEvent" && ++wheels % (script.wheelsPerPage ?? 3) === 0) serve();
      if (method === "Network.getResponseBody") return { body: JSON.stringify(bodies.get(params.requestId)) };
      if (method === "Runtime.evaluate") return { result: { value: /location\.href/.test(params.expression) ? href : script.detail ?? {} } };
      return {};
    },
  };
}
const fast = { sleep: async () => {}, rnd: () => 0.5 };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "zhiro-bv2-"));
  const domain = new Domain(openDb(join(dir, "t.db")));
  return { dir, domain, db: domain.db };
}

describe("BOSS v2: Zhiro listens to the page's own job data (D-28)", () => {
  it("reads a joblist body, and tells a check by BOSS from a login and from a changed format", () => {
    const r = readJoblist(page([job(1)], false)) as any;
    expect(r.jobs[0]).toMatchObject({ jobId: "job1", title: "运动控制实习生1", salary: "200-300元/天", district: "洪山区·光谷", days: "5天/周", months: "4个月", brand: "青岚机器人1", skills: ["MPC", "强化学习"] });
    expect(readJoblist(page([], false, 37, "您的环境存在异常"))).toMatchObject({ fail: "RISK_BLOCKED" });
    expect(readJoblist(page([], false, 7, "请先登录"))).toMatchObject({ fail: "AUTH_REQUIRED" });
    expect(readJoblist({ code: 0, zpData: {} })).toMatchObject({ fail: "SCHEMA_CHANGED" });
    expect(pageFail("https://www.zhipin.com/web/user/safe/verify-slider")).toMatchObject({ fail: "RISK_BLOCKED" });
    expect(pageFail("https://login.zhipin.com/?ka=header-login")).toBeNull(); // the host is not the path: a login host alone…
    expect(pageFail("https://www.zhipin.com/web/user/?ka=login")).toBeNull();
    expect(pageFail("https://www.zhipin.com/web/passport/login")).toMatchObject({ fail: "AUTH_REQUIRED" });
    expect(cityCode("武汉市")).toBe("101200100");
    expect(cityCode("101280600")).toBe("101280600");
    expect(cityCode("火星")).toBeNull();
  });

  it("opens the home page first in a new session, reads two screens, keeps candidates, files nothing", async () => {
    const { db, domain, dir } = setup();
    const cdp = fakeBrowser({ pages: [page([job(1), job(2)]), page([job(2), job(3)], false)] });
    const r = await search({ db, cdp, vault: dir, cfg: { rampDays: 0 }, ...fast }, domain, { query: "运动控制 实习", city: "武汉", pages: 3 });
    expect(cdp.navigations[0]).toBe("https://www.zhipin.com/");
    expect(r).toMatchObject({ screens: 2, found: 3, duplicates: 1, complete: true, stopped: null, newCandidates: 3 });
    expect(r.items.map((x: any) => x.ref)).toEqual(["job1", "job2", "job3"]);
    expect(db.prepare("select count(*) n from position").get()).toMatchObject({ n: 0 });
    expect(candidates(db, { internOnly: true }).map((c) => c.ref).sort()).toEqual(["job1", "job2", "job3"]);
  });

  it("a check by BOSS stops visits for a day; a timeout is said and stops nothing", async () => {
    const { db, domain, dir } = setup();
    const blocked = await search({ db, cdp: fakeBrowser({ pages: [page([], false, 37, "您的环境存在异常")] }), vault: dir, cfg: { rampDays: 0 }, ...fast }, domain, { query: "运动控制 实习", city: "武汉" });
    expect(blocked.stopped).toMatchObject({ code: "RISK_BLOCKED", stoppedVisits: true });
    expect(stopOf(db, Date.now())).not.toBeNull();
    await expect(search({ db, cdp: fakeBrowser({ pages: [] }), vault: dir, cfg: { rampDays: 0 }, ...fast }, domain, { query: "运动控制 实习", city: "武汉" })).rejects.toMatchObject({ code: "STOPPED" });

    const b = setup();
    const quiet = await search({ db: b.db, cdp: fakeBrowser({ pages: [page([job(1)])], wheelsPerPage: 1000 }), vault: b.dir, cfg: { rampDays: 0 }, ...fast }, b.domain, { query: "运动控制 实习", city: "武汉", pages: 2 });
    expect(quiet).toMatchObject({ screens: 1, found: 1, complete: false, stopped: { code: "CAPTURE_TIMEOUT", stoppedVisits: false } });
    expect(stopOf(b.db, Date.now())).toBeNull();
  });

  it("holds the session's budget before opening anything", async () => {
    const { db, domain, dir } = setup();
    const cdp = fakeBrowser({ pages: [] });
    await expect(search({ db, cdp, vault: dir, cfg: { rampDays: 0, perSession: { search: 1 } }, ...fast }, domain, { query: "运动控制 实习", city: "武汉", pages: 2 })).rejects.toMatchObject({ code: "BUDGET" });
    expect(cdp.navigations).toEqual([]);
  });

  it("files a candidate once its job page is read: the registered name, the description, the address", async () => {
    const { db, domain, dir } = setup();
    await search({ db, cdp: fakeBrowser({ pages: [page([job(1), job(2)], false)] }), vault: dir, cfg: { rampDays: 0 }, ...fast }, domain, { query: "运动控制 实习", city: "武汉", pages: 1 });
    const cdp = fakeBrowser({ pages: [], detail: { title: "运动控制实习生1", salary: "200-300元/天", jd: "岗位职责：参与四足机器人运动控制与强化学习训练，解决仿真到真机的问题。任职要求：硕士在读。", address: "武汉洪山区示例路 1 号", company: "武汉青岚机器人科技有限公司" } });
    const r = await detail({ db, cdp, vault: dir, cfg: { rampDays: 0 }, ...fast }, ["job1"]);
    expect(r.results[0]).toMatchObject({ outcome: "filed", company: "武汉青岚机器人科技有限公司" });
    const p = db.prepare("select title, jd_text from position").get() as any;
    expect(p.title).toBe("运动控制实习生1");
    expect(p.jd_text).toContain("200-300元/天 · 5天/周 · 4个月 · 硕士");
    expect(domain.listPositions({ internship: true }).items).toHaveLength(1);
    expect(candidates(db).map((c) => c.ref)).toEqual(["job2"]); // job1 is a post now
    const empty = await detail({ db, cdp: fakeBrowser({ pages: [], detail: { title: "x", jd: "" } }), vault: dir, cfg: { rampDays: 0 }, ...fast }, ["job2"]);
    expect(empty.results[0]).toMatchObject({ outcome: "NO_DESCRIPTION" });
  });

  it("a post's pay and degree come from the job page, then from the list", () => {
    const post = postOf({ title: "列表里的名", salary: "150-200元/天", days: "3天/周", months: "3个月", degree: "本科", experience: "", city: "武汉", brand: "青岚" }, { title: "详情里的名", jd: "x".repeat(40), company: "某某有限公司" });
    expect(post).toMatchObject({ title: "详情里的名", salary: "150-200元/天", company: "某某有限公司", intern: true });
  });
});
