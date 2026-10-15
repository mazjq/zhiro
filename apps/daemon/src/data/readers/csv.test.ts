import { describe, it, expect, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../../db.js";
import { WorkflowEngine } from "../../service/workflow.js";
import { isLocalPath } from "../http.js";
import { csv } from "./csv.js";
import { sourceFor, siteKeyOf, isAggregate } from "./index.js";
import { addSource } from "../subscriptions.js";
import { previewSource, forgetPreviews, runSource, sourceScan, scheduleSources, reasonOf } from "../sync.js";
import type { DataContext, SourceConfig } from "../types.js";

afterEach(() => { vi.unstubAllGlobals(); forgetPreviews(); });

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-csv-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "sources: []\n", "utf8");
  const db = openDb(join(dir, "t.db"));
  const workflows = new WorkflowEngine(db);
  const ctx: DataContext = { db, vault: dir, sources: [] as SourceConfig[], workflows };
  workflows.register(sourceScan(ctx));
  return { dir, db, workflows, ctx };
}
const OWN = `企业名称,岗位,ddl,网申地址,城市,学历,毕业年份
示例重工,"控制算法工程师、仿真工程师",2099-10-31,https://apply.example.com/a,武汉 上海,硕士及以上,2027届
示例电子,电机控制工程师,招满为止,https://apply.example.com/b,深圳,本科及以上,2027届
去年公司,工程师,2020-01-01,https://apply.example.com/c,北京,本科,2027届
,无主岗位,,,,,2027届
`;
const answering = (body: () => string, type = "text/csv") => vi.stubGlobal("fetch", async (url: string) => Object.defineProperty(new Response(body(), { headers: { "content-type": type } }), "url", { value: String(url) }));

describe("CSV 表格", () => {
  it("is recognised as a link or as a file on this machine; one table is one subscription; its rows are a transcription", () => {
    for (const u of ["https://raw.githubusercontent.com/a/b/main/jobs.csv", "https://docs.google.com/spreadsheets/d/e/x/pub?gid=0&single=true&output=csv", "https://docs.google.com/spreadsheets/d/x/export?format=csv", "D:\\校招\\岗位.csv", "/home/me/jobs.CSV"]) expect(sourceFor(u)?.id).toBe("csv"); // clean:allow (made-up paths)
    for (const u of ["https://example.com/jobs.html", "D:\\校招\\岗位.xlsx", "jobs.csv", "ftp://example.com/jobs.csv"]) expect(csv.detect!(u)).toBe(false); // clean:allow (made-up paths)
    expect(isLocalPath("D:\\a.csv")).toBe(true); // clean:allow (made-up paths)
    expect(isLocalPath("https://example.com/a.csv")).toBe(false);
    expect(siteKeyOf("https://example.com/jobs.csv#sheet1")).toBe(siteKeyOf("https://example.com/jobs.csv"));
    expect(isAggregate("csv")).toBe(true);
  });

  it("a file saved by Excel in GBK reads the same as one in UTF-8", async () => {
    const { dir } = setup();
    const gbk = join(dir, "gbk.csv");
    // 「公司,岗位\r\n示例,工程师」 in GBK
    writeFileSync(gbk, Buffer.from([0xb9, 0xab, 0xcb, 0xbe, 0x2c, 0xb8, 0xda, 0xce, 0xbb, 0x0d, 0x0a, 0xca, 0xbe, 0xc0, 0xfd, 0x2c, 0xb9, 0xa4, 0xb3, 0xcc, 0xca, 0xa6]));
    const t = await csv.table!({ id: "x", source: "csv", url: gbk }, { fetchJson: async () => ({}), fetchText: async () => "", sleep: async () => {}, log: () => {} });
    expect(t.headers).toEqual(["公司", "岗位"]);
    expect(t.rows[0].get("公司")).toBe("示例");
  });

  it("a link with its own column names: previewed, subscribed with the mapping, filed, and read again the next day", async () => {
    const { db, workflows, ctx } = setup();
    let body = OWN;
    answering(() => body);
    const url = "https://sheets.example.com/jobs.csv";

    const pv = await previewSource(ctx, { url });
    expect(pv).toMatchObject({ source: "csv", table: true, subscribed: null, rows: 4, posts: 3, companies: 2, problem: "" });
    expect(pv.columns).toMatchObject({ company: "企业名称", positions: "岗位", deadline: "ddl" });
    expect(pv.sample[0]).toEqual({ company: "示例重工", title: "控制算法工程师", deadline: "2099-10-31", cities: ["武汉", "上海"], url: "https://apply.example.com/a" });
    expect(db.prepare("select count(*) n from position").get()).toEqual({ n: 0 }); // a preview files nothing
    // another look right after (a column changed in the form) does not read the table again
    const answered = vi.fn(async (u: string) => Object.defineProperty(new Response(body, { headers: { "content-type": "text/csv" } }), "url", { value: String(u) }));
    vi.stubGlobal("fetch", answered);
    expect((await previewSource(ctx, { url, columns: { company: "企业名称" } })).posts).toBe(3); // with no deadline column read, the row that had closed counts too
    expect(answered).not.toHaveBeenCalled();

    const { id } = addSource(ctx, { url, name: "我的表", columns: pv.columns });
    expect(ctx.sources[0].columns).toEqual(pv.columns);
    scheduleSources(ctx);
    expect(await workflows.tick()).toBe(1);
    expect(db.prepare("select co.name, p.title, p.status from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id order by co.name, p.title").all())
      .toEqual([{ name: "示例电子", title: "电机控制工程师", status: "open" }, { name: "示例重工", title: "仿真工程师", status: "open" }, { name: "示例重工", title: "控制算法工程师", status: "open" }]);
    expect(db.prepare("select source_kind k, source_grade g from campaign limit 1").get()).toEqual({ k: "csv", g: "聚合" });

    // the next day the table has changed: one post gone, one company new
    body = OWN.replace("控制算法工程师、仿真工程师", "控制算法工程师") + "示例光学,光学工程师,2099-12-31,https://apply.example.com/d,苏州,硕士,2027届\n";
    const next = (db.prepare("select next_run_at n from workflow").get() as { n: string }).n;
    expect(Date.parse(next) - Date.now()).toBeGreaterThan(23 * 3600_000);
    expect(await workflows.tick(new Date(Date.parse(next) + 1000).toISOString())).toBe(1);
    expect(db.prepare("select p.title, p.status from position p order by p.title").all())
      .toEqual([{ title: "仿真工程师", status: "closed" }, { title: "光学工程师", status: "open" }, { title: "控制算法工程师", status: "open" }, { title: "电机控制工程师", status: "open" }]);
    expect(db.prepare("select count(*) n from scan_run where config_id = ? and error = ''").get(id)).toEqual({ n: 2 });
  });

  it("a file on this machine is read again each time: an edit to the file shows up at the next pull", async () => {
    const { dir, db, ctx } = setup();
    const file = join(dir, "jobs.csv");
    writeFileSync(file, "公司,招聘岗位\n示例重工,控制算法工程师\n", "utf8");
    const { id } = addSource(ctx, { url: file, name: "本机表" });
    expect((await runSource(ctx, id)).ok).toBe(true);
    writeFileSync(file, "公司,招聘岗位\n示例重工,控制算法工程师\n示例电子,电机控制工程师\n", "utf8");
    expect((await runSource(ctx, id)).ok).toBe(true);
    expect(db.prepare("select count(*) n from position where status = 'open'").get()).toEqual({ n: 2 });
  });

  it("says in plain words why a table cannot be read", async () => {
    const { dir, ctx } = setup();
    const noCompany = join(dir, "x.csv");
    writeFileSync(noCompany, "序号,说明\n1,abc\n", "utf8");
    expect((await previewSource(ctx, { url: noCompany })).problem).toContain("没认出哪一列是公司");
    await expect(previewSource(ctx, { url: join(dir, "missing.csv") })).rejects.toThrow(/FILE_NOT_FOUND/);
    await expect(previewSource(ctx, { url: "https://example.com/page.html" })).rejects.toMatchObject({ code: "UNSUPPORTED_URL" });
    // a link that points back at this machine or the local network is not read
    await expect(previewSource(ctx, { url: "http://127.0.0.1:8787/x.csv" })).rejects.toThrow(/BLOCKED/);
    await expect(previewSource(ctx, { url: "http://192.168.1.5/x.csv" })).rejects.toThrow(/BLOCKED/);
    // a login page instead of the table
    answering(() => "<html>登录</html>", "text/html; charset=utf-8");
    await expect(previewSource(ctx, { url: "https://sheets.example.com/private.csv" })).rejects.toThrow(/NOT_PUBLIC/);

    // a link that is no longer there
    vi.stubGlobal("fetch", async (url: string) => Object.defineProperty(new Response("Not Found", { status: 404 }), "url", { value: String(url) }));
    await expect(previewSource(ctx, { url: "https://sheets.example.com/gone.csv" })).rejects.toThrow(/SITE_DOWN: 这个链接打不开（HTTP 404）/);

    // a subscription whose mapping no longer fits the table fails with its reason, and closes nothing
    addSource(ctx, { url: noCompany, name: "坏表", columns: { company: "公司" } });
    const r = await runSource(ctx, ctx.sources[0].id);
    expect(r.ok).toBe(false);
    expect(reasonOf((r as { error: string }).error)).toBe("NO_COMPANY_COLUMN");
  });
});
