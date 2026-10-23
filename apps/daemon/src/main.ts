import "./env.js"; // ZHIRO_* names (before anything reads the environment)
import { serve } from "@hono/node-server";
import { openDb, SchemaMismatch } from "./db.js";
import { upgradeVault, UpgradeFailed, stampApp } from "./upgrade.js";
import { lockVault, VaultBusy } from "./lock.js";
import { loadConfig, dbPath, defaultVaultDir, clearConfigTemps, type JobosConfig } from "./config.js";
import { resolveVault, VaultUnavailable } from "./move.js";
import { dataDir, firstRun } from "./datadir.js";
import { Auth, loadCredentials } from "./auth.js";
import { writeAgentDir } from "./agent/agent-dir.js";
import { BUNDLED, ROOT, mcpCommand } from "./paths.js";
import { ChatHub, builtinBackend } from "./agent/backend.js";
import { chooseModel, cliBackend, reapOrphans } from "./agent/backends/cli.js";
import { claudeSpec } from "./agent/backends/claude.js";
import { codexSpec } from "./agent/backends/codex.js";
import { dshSpec } from "./agent/backends/acp.js";
import { oneshot } from "./agent/backends/oneshot.js";
import { backgroundTarget } from "./agent/route.js";
import { codexLauncher } from "./agent/backends/codex.js";
import { join, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { Domain } from "./service/domain.js";
import { WorkflowEngine } from "./service/workflow.js";
import { deadlineReminder, scheduleAllDeadlines } from "./workflows/deadline.js";
import { sourceScan, scheduleSources } from "./data/index.js";
import { researchRun } from "./agent/research.js";
import { companyFind } from "./agent/find-company.js";
import { topicRun } from "./agent/research-topic.js";
import { smeRun } from "./service/sme.js";
import { captureRecheck, scheduleRechecks } from "./workflows/recheck.js";
import { CareerAgent } from "./agent/career.js";
import { createLlm } from "./llm.js";
import { recordUsage } from "./service/usage.js";
import { createApp } from "./http.js";
import type { Services } from "./registry.js";
import { rerunAuto } from "./recommenders/index.js";
import { resumePending } from "./service/documents.js";
import { syncRelevantOfficial, pruneAutoSources } from "./service/official.js";
import { tidyPool } from "./service/tidy.js";
import { listPool } from "./service/pool.js";
import { inboxPoll, scheduleInbox } from "./workflows/inbox.js";
import { noticeDeliver, scheduleNotices } from "./workflows/notify.js";
import { dailyBrief, scheduleBrief } from "./workflows/daily.js";
import { leadResolve, scheduleLeads } from "./workflows/leads.js";
import { feedPull, scheduleFeeds } from "./workflows/feed.js";
import { docDeps, dataOf } from "./registry.js";
import { coalesce } from "./service/later.js";
import { announcer } from "./service/background.js";
import { enterMaintenance } from "./maintenance.js";
import { asBackground, claudeReadings, recordReadings } from "./budget/index.js";
import { backgroundGate, callGate, type GateDeps } from "./budget/gate.js";

// a move of the data directory asked for on the settings page happens here, before anything opens it (ADR-058)
// data and code apart: a data folder inside the program's own folder would end up in a commit or a package one day
{ const d = resolve(dataDir().dir), code = resolve(ROOT); if (!BUNDLED && (d === code || d.startsWith(code + sep)) && process.env.ZHIRO_ALLOW_DATA_IN_CODE !== "1") { console.error(`[zhiro] 数据目录 ${d} 在程序目录里面，不启动：把数据放到程序目录之外（--data <文件夹> 或 ZHIRO_DATA）`); process.exit(1); } }
let config: JobosConfig;
try { await firstRun(dataDir()); await resolveVault(defaultVaultDir()); config = loadConfig(); }
catch (e: any) { if (e instanceof VaultUnavailable) { console.error(`[zhiro] ${e.message}`); process.exit(1); } throw e; }
// S1 maintenance mode: open the data read only — no schedules, no tidying, no writes. For checking an upgrade or a switch
// of the running program against a copy (or the real folder) without changing a row.
const maintenance = process.env.ZHIRO_MAINTENANCE === "1" || process.argv.includes("--maintenance");
config.maintenance = maintenance;
if (maintenance) { enterMaintenance(); console.log("[zhiro] maintenance mode: read only, nothing scheduled, nothing written, no network"); }
for (const n of ["claude", "codex"] as const) chooseModel(n, config.agent?.models?.[n] ?? ""); // picked on the settings page
// one writing process per data directory (a second daemon, or `data watch` already running on it). Without the lock
// nothing starts: an upgrade or a second writer on the same files is how data gets lost (ADR-050).
let lock: Awaited<ReturnType<typeof lockVault>>;
try { lock = await lockVault(config.vault, "daemon"); clearConfigTemps(config.vault); }
catch (e: any) {
  console.error(`[zhiro] ${e instanceof VaultBusy ? e.message : `拿不到数据目录的锁，不启动：${e?.message ?? e}`}`);
  process.exit(1);
}
// a newer program: the database is upgraded on a copy and checked before it replaces the original (ADR-050)
try { upgradeVault(config.vault, lock, { log: (s) => console.log(`[zhiro] ${s}`) }); }
catch (e: any) {
  if (e instanceof UpgradeFailed || e instanceof SchemaMismatch) { console.error(`[zhiro] ${e.message}`); process.exit(1); }
  throw e;
}
const auth = new Auth(loadCredentials(config.vault), Date.now, config.vault);
const db = openDb(dbPath(config.vault));
if (!maintenance) stampApp(db);
const domain = new Domain(db, { readOnly: maintenance });
// a confirm card whose work was running when the daemon stopped: shown on 今日 as interrupted, never re-run by itself (ADR-062)
if (!maintenance) { const n = domain.interruptRunningProposals(); if (n) console.log(`[zhiro] ${n} confirm card(s) interrupted mid-run, waiting for the person`); }
const workflows = new WorkflowEngine(db);
// Follow-up work never runs inside the tool call that caused it: re-matching the pool blocks the event loop for seconds,
// which the user felt as "关注 takes a second to show". Deferred, a burst recomputes once, and never more than once a
// minute while scans keep coming in (service/later.ts).
// maintenance mode: a follow-up never fires (nothing is written to cause one, and nothing may be written by one)
const later = (fn: () => void) => (maintenance ? () => {} : coalesce(fn));
// data changed with nobody calling a tool: the open pages hear of it once the pool shows it (tech-debt 5B)
const announce = announcer(db);
const services: Services = {
  domain, workflows, config,
  // the pool or the profile changed. Tags decide which deadlines get reminders, so recompute them first; the pages hear of it
  // when the posts and their new matches are both in place (announce rebuilds the pool first)
  onDataChanged: later(() => { scheduleRechecks(services); void rerunAuto(services).then(() => { scheduleAllDeadlines(services); announce("matches"); void syncRelevantOfficial(services); }); }),
  onBackgroundChanged: maintenance ? () => {} : announce,
  // only what the user cares about changed (关注, 准备申请, a manual tag): the matching itself is unaffected
  onRelevanceChanged: later(() => { scheduleAllDeadlines(services); void syncRelevantOfficial(services); }),
  onSourcesChanged: () => { if (!maintenance) scheduleSources(dataOf(services)); },
  onInboxChanged: () => { if (!maintenance) scheduleInbox(services); },
};
// P5: background work waits while a test is on, the screen is taken, or the person's allowance is short (budget/)
const gateDeps: GateDeps = { db, config, target: () => backgroundTarget(services), credentialType: async (p) => (await services.llm?.credentials.read(p))?.type, codexLauncher };
workflows.gate = (kind) => backgroundGate(gateDeps, kind);
workflows.around = asBackground;
// a research report filed, a company found, a lead looked up: the pages hear of it (a subscription's pull says so itself)
workflows.onEnded = (kind) => { if (kind !== "source_scan") announce(kind); };
workflows.register(deadlineReminder(services));
workflows.register(sourceScan(dataOf(services)));
workflows.register(researchRun(services));
workflows.register(companyFind(services));
workflows.register(topicRun(services));
workflows.register(smeRun(services));
workflows.register(captureRecheck(services));
workflows.register(inboxPoll(services));
workflows.register(leadResolve(services));
workflows.register(feedPull(services));
workflows.register(noticeDeliver(services));
workflows.register(dailyBrief(services));
if (!maintenance) {
  scheduleRechecks(services);
  scheduleAllDeadlines(services);
  if (!config.keepAutoSources) { const pr = pruneAutoSources(services); if (pr.before !== pr.after) console.log(`[zhiro] auto sources pruned ${pr.before} -> ${pr.after}`); }
  // evidence-based tidy at start and once a day: orphan campaigns of pruned subscriptions, one unit spelled two ways
  const tidy = () => { try { const t = tidyPool(services); if (t.droppedCampaigns || t.merged.length) console.log(`[zhiro] tidy: ${t.droppedCampaigns} orphan campaigns dropped, merged ${t.merged.map((m) => `${m.from}→${m.into}`).join(", ") || "none"}`); } catch (e: any) { console.error("[zhiro] tidy failed", e?.message ?? e); } };
  setTimeout(tidy, 5_000).unref(); // after the server is listening: browsing never waits for housekeeping
  setInterval(tidy, 24 * 3600_000).unref();
  console.log(`[zhiro] pull sources scheduled: ${scheduleSources(dataOf(services))}`);
  workflows.startPolling();
}

const llm = createLlm(config);
services.llm = llm;
llm.db = domain.db; // ADR-032 external-mode jobs
llm.onUsage = (m, model) => recordUsage(domain.db, m, (model as any).provider ?? config.llm.provider, (model as any).id ?? config.llm.model);
// ADR-057: background model work goes to whoever the settings name; a harness answers it once, with no tools
llm.route = () => backgroundTarget(services);
// P5: each Claude run says how full the person's windows are — kept, so background work can see how fast they fill
const keepReading = (info: unknown) => { if (info && !maintenance) recordReadings(db, claudeReadings(info)); };
llm.harness = async (name, ctx) => {
  try { const a = await oneshot(name, ctx, join(config.vault, "chat", "oneshot", "pids.json")); keepReading(a.rateLimit); return a; }
  catch (e: any) { keepReading(e?.rateLimit); throw e; } // a refusal reports the windows too: the next check sees them full
};
llm.gate = (kind) => callGate(gateDeps, kind);
if (!maintenance) {
  scheduleInbox(services);
  scheduleLeads(services);
  scheduleFeeds(services);
  scheduleNotices(services);
  scheduleBrief(services);
  void syncRelevantOfficial(services);
}
setTimeout(() => listPool(domain.db), 500); // build the pool cache before the first page asks for it
if (!maintenance) resumePending(docDeps(services)); // files left mid-extraction by a restart
const career = new CareerAgent(services, llm);
// the drawer's backends (ADR-046): the built-in assistant, or a harness the person has (Claude Code, Codex) run per message
const launcher = mcpCommand;
const chat = new ChatHub(services, {
  builtin: builtinBackend(career, services),
  claude: cliBackend(services, auth, claudeSpec, launcher),
  codex: cliBackend(services, auth, codexSpec, launcher),
  dsh: cliBackend(services, auth, dshSpec, launcher), // over ACP (acp-bridge.ts)
});
services.chat = chat;
if (!maintenance) { const n = reapOrphans(config.vault); if (n) console.log(`[zhiro] chat: killed ${n} process(es) left by an earlier run`); }
const app = createApp(services, auth, chat);

serve({ fetch: app.fetch, hostname: config.http.host, port: config.http.port }, (info) => {
  console.log(`[zhiro] daemon http://${info.address}:${info.port}  vault=${config.vault}`);
  console.log(`[zhiro] credentials in ${config.vault}\\config\\ (.daemon-token = you, .agent-token = your agents)`);
  console.log(`[zhiro] open the UI (link good once, 10 minutes): http://${info.address}:${info.port}/api/launch?code=${auth.newLaunch()}`);
  // `zhiro` started at a terminal: open the page too (with a link of its own — the printed one stays good)
  if (process.env.ZHIRO_OPEN === "1") openBrowser(`http://${info.address}:${info.port}/api/launch?code=${auth.newLaunch()}`);
  if (!maintenance) {
    try { console.log(`[zhiro] agent directory (open your own agent here): ${writeAgentDir(config.vault, `http://${info.address}:${info.port}`)}`); }
    catch (e: any) { console.error("[zhiro] could not write the agent directory:", e?.message ?? e); }
  }
});

process.on("SIGINT", () => { workflows.stopPolling(); db.close(); process.exit(0); });

function openBrowser(url: string): void {
  const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(cmd, args as string[], { stdio: "ignore", detached: true, windowsHide: true }).on("error", () => {}).unref(); } catch { /* no browser to open: the printed link is there */ }
}
