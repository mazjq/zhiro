import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../db.js";
import { WorkflowEngine } from "../service/workflow.js";
import { lockVault } from "../lock.js";
import { sources } from "./readers/index.js";
import { addSource, saveSources } from "./subscriptions.js";
import { sourceScan, scheduleSources, retryAfter, reasonOf, wakeAfterUpgrade } from "./sync.js";
import { dataCodeFingerprint } from "./fingerprint.js";
import { ingest } from "./ingest.js";
import { incomplete, type DataContext, type Listing, type Source, type SourceConfig } from "./types.js";

/** 「第二天自动刷新」: a subscription that exists keeps being pulled — through failures, a removal and return, a restart. */
let answer: () => Listing[] = () => [];
const L = (id: string, title: string): Listing => ({ externalId: id, url: `https://jobs.flaky.example/acme/${id}`, title, company: "示例重工", locations: [], publisher: "flaky:acme", grade: "官方", isOriginal: true, confidence: 0.9, cohort: "2027届", batch: "校招" });
const flaky: Source = { id: "flaky", name: "示例站", mode: "pull", describe: "测试用", detect: (u) => u.startsWith("https://jobs.flaky.example/"), siteKey: (u) => new URL(u).pathname.split("/")[1], fetch: async () => answer() };
afterEach(() => { delete sources.flaky; });

function open(dir: string) {
  const db = openDb(join(dir, "t.db"));
  const workflows = new WorkflowEngine(db);
  const list: SourceConfig[] = [];
  const ctx: DataContext = { db, vault: dir, sources: list, workflows, platformGapMs: 0 };
  workflows.register(sourceScan(ctx));
  return { db, workflows, ctx };
}
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-sched-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "http:\n  port: 8787\nsources: []\n", "utf8");
  sources.flaky = flaky;
  return { dir, ...open(dir) };
}
const wf = (db: Db) => db.prepare("select state, next_run_at next, attempts from workflow where kind = 'source_scan'").get() as { state: string; next: string | null; attempts: number };
const runs = (db: Db) => db.prepare("select count(*) n, sum(error != '') failed from scan_run").get() as { n: number; failed: number };
const later = (iso: string | null, ms = 1000) => new Date(Date.parse(iso!) + ms).toISOString();

describe("a subscription keeps being pulled", () => {
  it("the day after: the next run is a day away, and when that day comes it reads the site again", async () => {
    const { db, workflows, ctx } = setup();
    answer = () => [L("1", "控制算法工程师"), L("2", "仿真工程师")];
    addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" });
    scheduleSources(ctx);
    expect(await workflows.tick()).toBe(1);
    const first = wf(db);
    expect(first.state).toBe("running");
    expect(Date.parse(first.next!) - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(await workflows.tick()).toBe(0); // not before its time

    answer = () => [L("1", "控制算法工程师"), L("3", "电机控制工程师")]; // the site the next day: one post gone, one new
    expect(await workflows.tick(later(first.next))).toBe(1);
    expect(runs(db)).toEqual({ n: 2, failed: 0 });
    expect(db.prepare("select title, status from position order by title").all()).toEqual([{ title: "仿真工程师", status: "closed" }, { title: "控制算法工程师", status: "open" }, { title: "电机控制工程师", status: "open" }]);
  });

  it("failing six times in a row does not end it: every failure is on record and another try is always scheduled", async () => {
    const { db, workflows, ctx } = setup();
    answer = () => { throw new Error("SITE_DOWN: 官网打不开"); };
    addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" });
    scheduleSources(ctx);
    let at = new Date().toISOString();
    for (let i = 0; i < 6; i++) { expect(await workflows.tick(at)).toBe(1); expect(wf(db).state).toBe("running"); at = later(wf(db).next); }
    expect(runs(db)).toEqual({ n: 6, failed: 6 });
    answer = () => [L("1", "控制算法工程师")];
    expect(await workflows.tick(at)).toBe(1);
    expect(db.prepare("select count(*) n from position").get()).toEqual({ n: 1 });
  });

  it("what a retry cannot fix soon (blocked, changed site) waits a day, then two, four, up to a week; down or empty keeps trying", async () => {
    const day = 24 * 3600_000;
    expect([1, 2, 3, 4, 5].map((n) => retryAfter("BLOCKED: HTTP 403 x", n, day) / day)).toEqual([1, 2, 4, 7, 7]);
    expect(retryAfter("SCHEMA_CHANGED: 大易 listPosition：parameter error", 1, day)).toBe(day); // no hourly retries
    expect([1, 3, 4].map((n) => retryAfter("SITE_DOWN: 官网打不开", n, day) / 3600_000)).toEqual([1, 1, 24]);
    expect(retryAfter("ZERO_POSTS: 官网读到了，但一个岗位都没有", 9, day)).toBe(day); // its season can open any day

    const { db, workflows, ctx } = setup();
    answer = () => { throw new Error("BLOCKED: HTTP 403 https://jobs.flaky.example/acme"); };
    addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" });
    scheduleSources(ctx);
    const at = new Date().toISOString();
    await workflows.tick(at);
    await workflows.tick(at);
    await workflows.tick(later(at, 2 * 3600_000));
    expect(runs(db)).toEqual({ n: 1, failed: 1 }); // not read again within the day
    expect(Date.parse(wf(db).next!) - Date.now()).toBeGreaterThan(23 * 3600_000);
    // what the read cost is on record with it
    expect(db.prepare("select fetch_ms is not null t, requests from scan_run").get()).toEqual({ t: 1, requests: 0 });
  });

  it("a fix to the reading code reads the failing subscriptions again at the next start, not after their backoff", async () => {
    const { db, workflows, ctx } = setup();
    answer = () => { throw new Error("SCHEMA_CHANGED: 大易 listPosition：parameter error"); };
    addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" });
    addSource(ctx, { url: "https://jobs.flaky.example/fine", name: "示例电气" });
    scheduleSources(ctx);
    let n = 0;
    answer = () => { if (n++ === 0) throw new Error("SCHEMA_CHANGED: 大易 listPosition：parameter error"); return [L("1", "控制算法工程师")]; };
    await workflows.tick();
    expect(runs(db)).toEqual({ n: 2, failed: 1 });
    // which of the two is due within the hour, the one that failed first
    const failed = (db.prepare("select config_id from scan_run where error != ''").get() as any).config_id;
    const soon = () => (db.prepare("select subject_id from workflow where kind = 'source_scan' and next_run_at < ?").all(new Date(Date.now() + 3600_000).toISOString()) as any[]).map((r) => r.subject_id);
    expect(soon()).toEqual([]); // both a day away

    expect(wakeAfterUpgrade(ctx, "v1")).toBe(1); // the failing one, now; the one that read fine keeps its day
    expect(soon()).toEqual([failed]);
    await workflows.tick();
    expect(runs(db)).toEqual({ n: 3, failed: 1 });
    expect(wakeAfterUpgrade(ctx, "v1")).toBe(0); // same code: nothing
    expect(dataCodeFingerprint()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("a read that stopped before the end of the list files what it read and closes nothing", async () => {
    const { db, workflows, ctx } = setup();
    answer = () => [L("1", "控制算法工程师"), L("2", "仿真工程师")];
    addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" });
    scheduleSources(ctx);
    await workflows.tick();
    answer = () => incomplete([L("1", "控制算法工程师"), L("3", "电机控制工程师")], "示例站 2/3");
    await workflows.tick(later(wf(db).next));
    expect(db.prepare("select title, status from position order by title").all()).toEqual([{ title: "仿真工程师", status: "open" }, { title: "控制算法工程师", status: "open" }, { title: "电机控制工程师", status: "open" }]);
    expect(db.prepare("select complete from scan_run order by started_at desc limit 1").get()).toEqual({ complete: 0 });
  });

  it("gone is not down: a missing site or page needs a new address, a site that is down needs time", () => {
    expect(["SITE_DOWN: HTTP 404 https://x", "API error: 未找到对应的官网", "SITE_GONE: 大易 listPosition：官网不存在", "SITE_DOWN: HTTP 502 x", "SITE_DOWN: ENOTFOUND x"].map(reasonOf))
      .toEqual(["SITE_GONE", "SITE_GONE", "SITE_GONE", "SITE_DOWN", "SITE_DOWN"]);
  });

  it("what a reader finds out (and what the library knew) is kept on the subscription only when the read works", async () => {
    const { dir, db, workflows, ctx } = setup();
    let fail = true;
    flaky.hint = (cfg) => (cfg.rootId ? null : { rootId: "from-library" });
    flaky.fetch = async (cfg, c) => { c.learn?.({ widenedFrom: cfg.url }); if (fail) throw new Error("SITE_DOWN: x"); return [L("1", `控制算法工程师 ${cfg.rootId}`)]; };
    try {
      addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" });
      scheduleSources(ctx);
      await workflows.tick();
      expect(ctx.sources[0].rootId).toBeUndefined();
      fail = false;
      await workflows.tick(later(wf(db).next));
      expect(ctx.sources[0]).toMatchObject({ rootId: "from-library", widenedFrom: "https://jobs.flaky.example/acme" });
      expect(readFileSync(join(dir, "config", "jobos.yaml"), "utf8")).toContain("from-library");
      expect(db.prepare("select title from position").all()).toEqual([{ title: "控制算法工程师 from-library" }]);
    } finally { delete flaky.hint; flaky.fetch = async () => answer(); }
  });

  it("removed and added back, it is scheduled again; a schedule that had given up under the old rule is revived", async () => {
    const { db, workflows, ctx } = setup();
    answer = () => [L("1", "控制算法工程师")];
    const { id } = addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" });
    scheduleSources(ctx);
    await workflows.tick();
    saveSources(ctx, []);
    expect(wf(db).state).toBe("completed"); // its subscription is gone: at once, not when its next turn comes
    expect(await workflows.tick(new Date(Date.now() + 25 * 3600_000).toISOString())).toBe(0);
    expect(addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" }).id).toBe(id);
    scheduleSources(ctx);
    expect(wf(db).state).toBe("running");
    expect(await workflows.tick()).toBe(1);
    expect(runs(db).n).toBe(2);

    db.prepare("update workflow set state = 'failed', attempts = 5, next_run_at = null where kind = 'source_scan'").run();
    scheduleSources(ctx);
    expect(wf(db)).toMatchObject({ state: "running", attempts: 0 });
  });

  it("survives a restart: another process on the same data directory runs it when its time comes", async () => {
    const { dir, db, workflows, ctx } = setup();
    answer = () => [L("1", "控制算法工程师")];
    addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" });
    scheduleSources(ctx);
    await workflows.tick();
    const next = wf(db).next;
    db.close();

    const again = open(dir);
    again.ctx.sources.push(...(JSON.parse(JSON.stringify(ctx.sources)) as SourceConfig[])); // what loadConfig reads back from the yaml
    scheduleSources(again.ctx);
    expect(await again.workflows.tick()).toBe(0);
    answer = () => [L("1", "控制算法工程师"), L("2", "仿真工程师")];
    expect(await again.workflows.tick(later(next))).toBe(1);
    expect(again.db.prepare("select count(*) n from position").get()).toEqual({ n: 2 });
  });
});

describe("the subscription file", () => {
  it("is replaced whole: the rest of the configuration stays, no half-written file is left", () => {
    const { dir, ctx } = setup();
    addSource(ctx, { url: "https://jobs.flaky.example/acme", name: "示例重工" });
    const text = readFileSync(join(dir, "config", "jobos.yaml"), "utf8");
    expect(text).toContain("port: 8787");
    expect(text).toContain("jobs.flaky.example/acme");
    expect(readdirSync(join(dir, "config")).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });
});

describe("post identity (ADR-041 §6)", () => {
  it("a place on a captured page (url#3) is not the site's id for a post; a real id is", () => {
    const { dir, db } = setup();
    ingest({ db }, dir, "capture", "c1", [{ ...L("https://example.com/notice#3", "控制算法工程师"), publisher: "capture:web" }]);
    ingest({ db }, dir, "flaky", "f1", [L("job-77", "仿真工程师")]);
    expect(db.prepare("select title, source_key k from position order by title").all()).toEqual([{ title: "仿真工程师", k: "job-77" }, { title: "控制算法工程师", k: "" }]);
  });
});

describe("one writing process per data directory", () => {
  it("the second taker is refused and told who holds it; after release it can be taken again", async () => {
    const { dir } = setup();
    const a = await lockVault(dir, "daemon");
    await expect(lockVault(dir, "data watch")).rejects.toMatchObject({ code: "VAULT_BUSY", holder: expect.stringContaining("daemon") });
    a.release();
    await new Promise((r) => setTimeout(r, 50));
    (await lockVault(dir, "data watch")).release();
  });
});
