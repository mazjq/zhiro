/**
 * The data layer on its own: `pnpm --filter @zhiro/daemon data <command>`. No agent, no UI, no model, no HTTP server —
 * the database, the subscriptions, the readers, the daily pull.
 *
 *   probe <链接或文件>             不写库：这个链接归哪个读取器，读出来是什么
 *   add <链接或文件> [--name 名字] [--cohort 2027届]   订阅并马上拉一次
 *   list                          订阅和它们最近一次的结果
 *   sync [订阅 id]                 现在拉一次（不给 id = 全部）
 *   watch                         常驻：按每个订阅的周期拉
 *
 * The data directory is the daemon's (JOBOS_VAULT, else the platform default). Writing commands take the directory's
 * lock, so they refuse to run while the daemon — or another `data watch` — is using it.
 */
import { loadConfig, dbPath, clearConfigTemps } from "../config.js";
import { openDb } from "../db.js";
import { WorkflowEngine } from "../service/workflow.js";
import { lockVault, VaultBusy } from "../lock.js";
import { httpContext } from "./http.js";
import { sourceFor } from "./readers/index.js";
import { addSource } from "./subscriptions.js";
import { listSources, previewSource, runSource, sourceScan, scheduleSources, reasonOf, SYNC_REASONS } from "./sync.js";
import type { DataContext, SourceConfig } from "./types.js";

const [cmd = "", ...args] = process.argv.slice(2);
const flag = (name: string): string | undefined => { const i = args.indexOf(`--${name}`); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
const say = (s: string) => console.log(s);
const why = (error: string) => `${SYNC_REASONS[reasonOf(error)]}（${error.slice(0, 200)}）`;

function open(): DataContext & { workflows: WorkflowEngine } {
  const config = loadConfig();
  const db = openDb(dbPath(config.vault));
  return { db, vault: config.vault, sources: config.sources as SourceConfig[], workflows: new WorkflowEngine(db) };
}
/** For a command that writes: the directory's lock first. */
async function locked(who: string) {
  const ctx = open();
  try { await lockVault(ctx.vault, who); clearConfigTemps(ctx.vault); }
  catch (e) { if (e instanceof VaultBusy) { console.error(`${e.message}\n先停掉它，或者改用它的工具（source.add / scan.run）。`); process.exit(2); } throw e; }
  return ctx;
}
const result = (name: string, r: Awaited<ReturnType<typeof runSource>>) =>
  say(r.ok ? `  ${name}：读到 ${r.result.received} 条，新增岗位 ${r.result.positionsNew}，已有 ${r.result.positionsSeen}，关闭 ${r.result.positionsClosed}` : `  ${name}：没读成 — ${why(r.error)}`);

async function main(): Promise<void> {
  if (cmd === "probe") {
    const url = args[0];
    if (!url) throw new Error("用法：data probe <链接或文件>");
    const src = sourceFor(url);
    if (!src?.fetch) throw new Error(`还认不出这个链接是哪种招聘站或表格：${url}`);
    say(`读取器：${src.name}（${src.id}）`);
    if (src.table) {
      const pv = await previewSource({ db: undefined as never, vault: "", sources: [] }, { url, cohort: flag("cohort") });
      say(`表头：${pv.headers.join("、")}`);
      say(`列对应：${Object.entries(pv.columns).map(([f, h]) => `${pv.fields.find((x) => x.field === f)?.label}←${h}`).join("，") || "（没认出）"}`);
      say(`${pv.rows} 行 → ${pv.posts} 个岗位，${pv.companies} 家公司${pv.problem ? `\n问题：${pv.problem}` : ""}`);
      for (const l of pv.sample) say(`- ${l.company} | ${l.title} | ${l.cities.join(";")} | ${l.deadline || "-"} | ${l.url}`);
      return;
    }
    const t0 = Date.now();
    const listings = await src.fetch({ id: "probe", source: src.id, url, name: flag("name"), maxPages: 3, detailCap: 3 }, httpContext((m) => say(`[log] ${m}`)));
    say(`${listings.length} 个岗位，用时 ${Date.now() - t0} ms`);
    for (const l of listings.slice(0, 6)) say(`- ${l.title} | ${l.orgUnit ?? ""} | ${l.locations.join(";")} | ${l.degreeReq ?? "?"} | ${l.validThrough?.slice(0, 10) ?? "-"}`);
    return;
  }
  if (cmd === "list") {
    const { configured } = listSources(open());
    if (!configured.length) say("还没有订阅。data add <链接或文件> 加一个。");
    for (const c of configured) say(`${c.id}\t${c.source}\t每 ${c.everyHours} 小时\t${c.lastRun ? (c.lastRun.error ? `上次没读成：${SYNC_REASONS[c.health.reason] ?? c.health.reason}` : `上次 ${c.lastRun.at.slice(0, 16)} 读到 ${c.lastRun.found} 条`) : "还没拉过"}\t${c.name}`);
    return;
  }
  if (cmd === "add") {
    const url = args.find((a) => !a.startsWith("--"));
    const name = flag("name"), cohort = flag("cohort");
    if (!url) throw new Error("用法：data add <链接或文件> [--name 名字] [--cohort 2027届]");
    const ctx = await locked("data add");
    const pv = await previewSource(ctx, { url, cohort });
    if (pv.problem) throw new Error(pv.problem);
    const { id } = addSource(ctx, { url, name: name ?? pv.name, cohort, ...(pv.table ? { columns: pv.columns } : {}) });
    say(`已订阅 ${id}（${pv.name}）${pv.table ? `，列对应：${Object.entries(pv.columns).map(([f, h]) => `${f}←${h}`).join("，")}` : ""}`);
    result(id, await runSource(ctx, id));
    return;
  }
  if (cmd === "sync") {
    const ctx = await locked("data sync");
    const ids = args[0] ? [args[0]] : ctx.sources.filter((c) => c.enabled !== false).map((c) => c.id);
    if (!ids.length) say("还没有订阅。");
    for (const id of ids) result(id, await runSource(ctx, id, { quiet: true }));
    return;
  }
  if (cmd === "watch") {
    const ctx = await locked("data watch");
    ctx.workflows.register(sourceScan(ctx));
    ctx.onSourcesChanged = () => { scheduleSources(ctx); };
    say(`data watch：${scheduleSources(ctx)} 个订阅按各自的周期拉取（数据目录 ${ctx.vault}）。Ctrl+C 结束。`);
    ctx.workflows.startPolling();
    process.on("SIGINT", () => { ctx.workflows.stopPolling(); ctx.db.close(); process.exit(0); });
    return; // the poll timer keeps the process alive
  }
  say("用法：data probe <链接或文件> | add <链接或文件> [--name 名字] [--cohort 届次] | list | sync [订阅 id] | watch");
  process.exitCode = cmd ? 1 : 0;
}

main().catch((e) => { const m = /^([A-Z_]{4,}): ([\s\S]*)$/.exec(String(e?.message ?? e)); console.error(m ? m[2] : String(e?.message ?? e)); process.exit(1); });
