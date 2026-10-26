import { describe, it, expect, afterEach } from "vitest";
import { createServices, testConfig } from "./services.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { WorkflowEngine } from "./service/workflow.js";
import { dataOf, type Services } from "./registry.js";
import { ingest, runSource, sources, type DataContext, type Listing, type Source } from "./data/index.js";
import { listPool } from "./service/pool.js";
import { announcer } from "./service/background.js";
import { bus } from "./events.js";

/**
 * Tech-debt 5B: data that changes in the background (a scheduled pull, the matcher's rerun, a research run finishing)
 * reaches the open pages as one `data` event — sent only once a read returns the new rows, never for a pull that changed
 * nothing, and once for a burst.
 */
const post = (company: string, title: string, over: Partial<Listing> = {}): Listing => ({
  externalId: `${company}|${title}`, url: `https://example.com/${encodeURIComponent(title)}`, title, company, locations: ["武汉"], description: "jd",
  publisher: company, grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "校招", ...over,
});
const tick = (ms = 20) => new Promise((ok) => setTimeout(ok, ms));
/** wait for what a timer will do, however busy the machine running the tests */
const until = async (ok: () => boolean) => { for (let i = 0; i < 200 && !ok(); i++) await tick(10); };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-bg-"));
  const db = openDb(join(dir, "t.db"));
  const s: Services = createServices({ db: db, config: testConfig(dir, { sources: [] }) });
  return { dir, db, s };
}
/** every `data` event, with what a page asking for the pool at that very moment would get */
function watch(db: ReturnType<typeof openDb>) {
  const seen: { what: string[]; companies: string[] }[] = [];
  const on = (ev: { type: string; data: any }) => { if (ev.type === "data") seen.push({ what: ev.data.what, companies: listPool(db).items.map((c: any) => c.companyName) }); };
  bus.on("event", on);
  return { seen, off: () => bus.off("event", on) };
}

let stop = () => {};
afterEach(() => { stop(); stop = () => {}; delete sources.fake; });

describe("background changes reach the open pages (5B)", () => {
  it("is sent only after the pool has the new rows — a page asking right then sees them", async () => {
    const { dir, db } = setup();
    ingest({ db }, dir, "moka", "m1", [post("甲公司", "控制算法工程师")]);
    expect(listPool(db).items.map((c: any) => c.companyName)).toEqual(["甲公司"]); // the pool is built and kept
    const w = watch(db); stop = w.off;
    const announce = announcer(db, { delay: 0, gap: 0 });
    // a scheduled pull files a new company: written, but the pool held is still the old one
    ingest({ db }, dir, "moka", "m2", [post("乙公司", "仿真工程师")]);
    announce("posts");
    expect(w.seen).toEqual([]); // not before the new rows are in place
    await until(() => w.seen.length > 0);
    expect(w.seen).toHaveLength(1);
    expect(w.seen[0].companies.sort()).toEqual(["乙公司", "甲公司"]);
    expect(w.seen[0].what).toEqual(["posts"]);
  });

  it("a burst is one event naming everything in it", async () => {
    const { db } = setup();
    const w = watch(db); stop = w.off;
    const announce = announcer(db, { delay: 10, gap: 0 });
    announce("posts"); announce("matches"); announce("posts");
    await until(() => w.seen.length > 0);
    await tick(50);
    expect(w.seen.map((x) => x.what.sort())).toEqual([["matches", "posts"]]);
  });

  it("a pull that changed nothing says nothing; one that edited a post says so without re-matching", async () => {
    const { dir, db } = setup();
    const table = [post("甲公司", "控制算法工程师"), post("甲公司", "仿真工程师")];
    sources.fake = { id: "fake", name: "测试站", mode: "pull", describe: "测试用", fetch: async () => table } as Source;
    const calls: string[] = [];
    const ctx: DataContext = { db, vault: dir, sources: [{ id: "f1", source: "fake", name: "测试站" }], onDataChanged: () => calls.push("data"), onPostsEdited: () => calls.push("edited"), onPull: (id, running) => calls.push(`pull:${id}:${running ? "start" : "end"}`) };
    const first = await runSource(ctx, "f1");
    expect(first).toMatchObject({ ok: true, result: { positionsNew: 2, updated: 0 } });
    expect(calls).toEqual(["pull:f1:start", "data", "pull:f1:end"]);

    calls.length = 0;
    const same = await runSource(ctx, "f1");
    expect(same).toMatchObject({ ok: true, result: { positionsNew: 0, positionsClosed: 0, updated: 0 } });
    expect(calls).toEqual(["pull:f1:start", "pull:f1:end"]); // only that a pull ran (「更新情况」), no change

    calls.length = 0;
    table[1] = post("甲公司", "仿真工程师", { validThrough: "2099-11-30" });
    const edited = await runSource(ctx, "f1");
    expect(edited).toMatchObject({ ok: true, result: { positionsNew: 0, positionsClosed: 0, updated: 2 } }); // the post, and its batch's date
    expect(calls).toEqual(["pull:f1:start", "edited", "pull:f1:end"]);
  });

  it("the daemon's wiring: an edited post announces, a pull's start is its own event", async () => {
    const { s } = setup();
    const said: string[] = [];
    s.onBackgroundChanged = (what) => said.push(what);
    const scans: any[] = [];
    const on = (ev: { type: string; data: any }) => { if (ev.type === "scan") scans.push(ev.data); };
    bus.on("event", on); stop = () => bus.off("event", on);
    dataOf(s).onPostsEdited?.();
    dataOf(s).onPull?.("f1", true);
    expect(said).toEqual(["posts"]);
    expect(scans).toEqual([{ configId: "f1", running: true }]);
  });

  it("background work that ends (a research run, a lead looked up) is reported once, when it ends", async () => {
    const { db } = setup();
    const ended: string[] = [];
    const wf = new WorkflowEngine(db);
    wf.onEnded = (kind) => ended.push(kind);
    let n = 0;
    wf.register({ kind: "research_run", order: ["collect"], steps: { collect: async () => (++n < 2 ? { type: "sleep", until: new Date(0).toISOString() } : { type: "done" }) } });
    wf.start("research_run", "r1", "research_run:r1");
    await wf.tick();
    expect(ended).toEqual([]); // still collecting
    await wf.tick();
    expect(ended).toEqual(["research_run"]);
  });
});
