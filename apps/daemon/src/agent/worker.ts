import { spawn } from "node:child_process";
import { lowerPriority } from "../budget/quiet.js";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync, openSync, statSync } from "node:fs";
import { join } from "node:path";
import { nodeArgs } from "../paths.js";
import { ulid } from "ulid";
import { now } from "../db.js";
import type { Services } from "../registry.js";
import { callingAgent } from "../service/usage.js";
import { researchTarget } from "./route.js";
import { codexLauncher } from "./backends/codex.js";
import { CODEX_TOOLS_OFF } from "./backends/oneshot.js";
import { followedModel, killTree, noteModelRefused } from "./backends/cli.js";
import { delegateRun } from "../service/model-jobs.js";
import { DATA_TOOLS } from "../service/research-data.js";

/**
 * System-side worker dispatch (PLAN §5.2): a coding agent with web access does research the daemon cannot do itself.
 * Runner = Claude Code headless (`claude -p`): it has WebSearch/WebFetch built in and `--json-schema` structured output.
 * Isolation (Codex review 2.5): each run gets vault/runs/<id>/ containing only a brief + schema; the worker may read/write
 * there and nothing else; its output is a candidate the daemon validates and copies into vault/research/.
 * Ledger: agent_run table (session_id kept for --resume) + .orchestration/agents.yaml is NOT written here (single-user, DB is enough).
 */
/** maxTurns / maxBudgetUsd override the configured research limits for a narrower job (a list hunt needs fewer turns). */
/**
 * `prompt` may be made once the run exists (a brief that names its own run, or files what it starts from in the run's
 * directory). `dataTools`: the worker is also given the research data tools (ADR-056), see dataServer below.
 */
export interface RunSpec { runner?: "claude" | "codex"; mode: "research.company" | "research.topic" | "company.find" | "intel.sme"; subjectType: "company" | "region" | "topic"; subjectId: string; subjectLabel: string; prompt: string | ((run: { runId: string; dir: string; external: boolean }) => string); schema: object; maxTurns?: number; maxBudgetUsd?: number; dataTools?: boolean }

/**
 * How the worker starts the data-tool server (mcp/research-data.ts): the node that runs this daemon, the way this
 * daemon is run — under tsx from source, or as built JavaScript — and the run's directory to write its record to.
 * Nothing else is handed over: no token, no data directory. The names are what the worker's tool list shows.
 */
export const DATA_SERVER = "jobosdata";
export const dataToolNames = () => Object.keys(DATA_TOOLS).map((n) => `mcp__${DATA_SERVER}__${n.replace(".", "_")}`);
export function dataServer(dir: string): { command: string; args: string[]; env: Record<string, string> } {
  return { command: process.execPath, args: nodeArgs("research-data"), env: { JOBOS_RUN_DIR: dir } };
}

/**
 * Windows: spawning a .cmd shim without a shell throws EINVAL (Node ≥ 18.20), and a shell would mangle the JSON schema
 * argument. So resolve the npm shim to its JS entry and run it with the current node binary. Override with JOBOS_CLAUDE_CLI.
 */
function claudeLauncher(): { cmd: string; args: string[] } {
  const override = process.env.JOBOS_CLAUDE_CLI;
  if (override) return override.endsWith(".js") ? { cmd: process.execPath, args: [override] } : { cmd: override, args: [] };
  const pkg = join(process.env.APPDATA ?? "", "npm", "node_modules", "@anthropic-ai", "claude-code");
  for (const c of [join(pkg, "bin", "claude.exe"), join(pkg, "cli-wrapper.cjs"), join(pkg, "cli.js")]) {
    if (existsSync(c)) return c.endsWith(".js") ? { cmd: process.execPath, args: [c] } : { cmd: c, args: [] };
  }
  return { cmd: process.platform === "win32" ? "claude.cmd" : "claude", args: [] };
}

/** For the settings page: is the web-capable worker installed, and what would be launched. */
export function workerStatus(): { available: boolean; launcher: string } {
  const l = claudeLauncher();
  const path = l.args[0] ?? l.cmd;
  return { available: existsSync(path), launcher: path };
}

export function runDir(vault: string, id: string): string {
  return join(vault, "runs", id);
}

/**
 * Create the run directory, write brief + schema, start the research detached; returns immediately. Who researches
 * (ADR-057): an external agent that asked inside its own call does it itself (the brief waits in llm.pending for it);
 * otherwise the chosen harness's research worker — Codex's when Codex is chosen, else Claude Code's; with neither
 * installed the brief waits for the person's own agent.
 */
export function spawnRun(s: Services, spec: RunSpec): { runId: string; runDir: string } {
  const runId = ulid();
  const dir = runDir(s.config.vault, runId);
  mkdirSync(dir, { recursive: true });
  const asker = callingAgent();
  const target = asker ? { kind: "waiting" as const } : researchTarget(s);
  const external = target.kind === "waiting";
  const prompt = typeof spec.prompt === "function" ? spec.prompt({ runId, dir, external }) : spec.prompt;
  writeFileSync(join(dir, "brief.md"), prompt, "utf8");
  writeFileSync(join(dir, "schema.json"), JSON.stringify(spec.schema), "utf8");
  const runner = target.kind === "worker" ? target.runner : "external";
  s.domain.db.prepare("insert into agent_run(id, runner, mode, subject_type, subject_id, subject_label, run_dir, status, started_at) values (?,?,?,?,?,?,?,?,?)")
    .run(runId, runner, spec.mode, spec.subjectType, spec.subjectId, spec.subjectLabel, dir, "running", now());
  if (target.kind === "waiting") { delegateRun(s.domain.db, runId, spec.mode, prompt, spec.schema, asker ?? ""); return { runId, runDir: dir }; }
  const launcher = target.runner === "codex" ? codexLauncher() : claudeLauncher();
  const args = target.runner === "codex" ? codexArgs(s, spec, dir) : claudeArgs(s, spec, dir);
  try {
    if (!launcher) throw new Error(`没找到 ${target.runner} 的命令行`);
    // kept so a Codex run whose model is refused can start once more on Codex's default (readCodexRun)
    if (target.runner === "codex") writeFileSync(join(dir, "launch.json"), JSON.stringify({ cmd: launcher.cmd, args: [...launcher.args, ...args] }), "utf8");
    startDetached(dir, launcher.cmd, [...launcher.args, ...args], prompt, target.runner === "codex" ? "events.jsonl" : "out.json");
  } catch (e: any) {
    writeFileSync(join(dir, "spawn-error.txt"), String(e?.message ?? e), "utf8");
    s.domain.db.prepare("update agent_run set status = 'failed', error = ?, finished_at = ? where id = ?").run(`spawn ${target.runner}: ${e?.message ?? e}`, now(), runId);
    throw Object.assign(new Error(`RUNNER_UNAVAILABLE: ${e?.message ?? e}`), { code: "RUNNER_UNAVAILABLE" });
  }
  return { runId, runDir: dir };
}

function startDetached(dir: string, cmd: string, args: string[], prompt: string, outFile: string): void {
  const out = openSync(join(dir, outFile), "w");
  const err = openSync(join(dir, "stderr.log"), "w");
  const child = spawn(cmd, args, { cwd: dir, stdio: ["pipe", out, err], detached: true, shell: false, windowsHide: true, env: { ...process.env, CLAUDECODE: "" } });
  child.stdin!.write(prompt);
  child.stdin!.end();
  lowerPriority(child.pid); // research runs in the background: the person's own programs come first
  if (child.pid) writeFileSync(join(dir, "pid.txt"), String(child.pid), "utf8");
  child.on("error", (e) => writeFileSync(join(dir, "spawn-error.txt"), String(e), "utf8"));
  child.on("exit", (code) => writeFileSync(join(dir, "exit.txt"), String(code ?? -1), "utf8"));
  child.unref();
}

function claudeArgs(s: Services, spec: RunSpec, dir: string): string[] {
  return [
    "-p", "--output-format", "json", "--json-schema", JSON.stringify(spec.schema),
    "--tools", "WebSearch,WebFetch,Read", "--allowedTools", "WebSearch", "WebFetch", "Read", ...(spec.dataTools ? dataToolNames() : []),
    "--permission-mode", "dontAsk", "--permission-prompts", "none",
    "--max-turns", String(spec.maxTurns ?? (s.config as any).research?.maxTurns ?? 40),
    "--max-budget-usd", String(spec.maxBudgetUsd ?? (s.config as any).research?.maxBudgetUsd ?? 2),
    ...((s.config as any).research?.model ? ["--model", String((s.config as any).research.model)] : followedModel("claude") ? ["--model", followedModel("claude")] : []),
    // none of the person's settings (their hooks fired inside the worker, 2026-10-13); the model is passed above, the login is not a setting
    "--setting-sources", "",
    // no MCP server of the user's own reaches the worker; the one it may be given is the data-tool server
    "--strict-mcp-config", ...(spec.dataTools ? ["--mcp-config", JSON.stringify({ mcpServers: { [DATA_SERVER]: dataServer(dir) } })] : []),
  ];
}

/**
 * Codex as the research worker: web search on, its command / file / image / browser features off, the data-tool server
 * the only MCP server, the answer held to the schema and written to last.md. The event stream is checked while it runs
 * (readRun): anything beyond its messages, web searches and the data tools ends the run.
 */
function codexArgs(s: Services, spec: RunSpec, dir: string): string[] {
  const toml = (v: string) => JSON.stringify(v);
  const ds = dataServer(dir), model = followedModel("codex");
  return [
    "exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "-s", "read-only", "-C", dir,
    "--output-schema", join(dir, "schema.json"), "-c", 'approval_policy="never"', "-c", 'web_search="live"',
    ...(model ? ["-c", `model=${toml(model)}`] : []), ...CODEX_TOOLS_OFF.flatMap((f) => ["--disable", f]),
    ...(spec.dataTools ? [
      "-c", `mcp_servers.${DATA_SERVER}.command=${toml(ds.command)}`,
      "-c", `mcp_servers.${DATA_SERVER}.args=[${ds.args.map(toml).join(",")}]`,
      "-c", `mcp_servers.${DATA_SERVER}.env={${Object.entries(ds.env).map(([k, v]) => `${k}=${toml(v)}`).join(",")}}`,
      "-c", `mcp_servers.${DATA_SERVER}.default_tools_approval_mode="approve"`,
    ] : []),
    "-o", join(dir, "last.md"), "-",
  ];
}

/** What a Codex research run may do: talk, think, search the web, and call the data tools. */
const CODEX_RESEARCH_ITEMS = new Set(["agent_message", "reasoning", "error", "web_search", "mcp_tool_call"]);
const CODEX_RUN_MS = 30 * 60_000;

export interface RunResult { status: "running" | "done" | "failed"; structured?: any; sessionId?: string; costUsd?: number; error?: string; resultText?: string }

/** Non-blocking status read: done when exit.txt exists and out.json parses. */
export function readRun(dir: string): RunResult {
  if (existsSync(join(dir, "spawn-error.txt"))) return { status: "failed", error: "spawn: " + readFileSync(join(dir, "spawn-error.txt"), "utf8") };
  if (existsSync(join(dir, "events.jsonl"))) return readCodexRun(dir);
  if (!existsSync(join(dir, "exit.txt"))) return { status: "running" };
  const raw = existsSync(join(dir, "out.json")) ? readFileSync(join(dir, "out.json"), "utf8").trim() : "";
  if (!raw) return { status: "failed", error: "worker produced no output; see stderr.log: " + (existsSync(join(dir, "stderr.log")) ? readFileSync(join(dir, "stderr.log"), "utf8").slice(-600) : "") };
  let j: any;
  try { j = JSON.parse(raw); } catch { return { status: "failed", error: "worker output is not JSON: " + raw.slice(0, 300) }; }
  if (j.is_error) return { status: "failed", error: String(j.result ?? j.error ?? "is_error"), sessionId: j.session_id };
  return { status: "done", structured: j.structured_output, resultText: j.result, sessionId: j.session_id, costUsd: j.total_cost_usd };
}

/** A Codex research run: stopped if it reached for anything but search and the data tools, or ran past half an hour. */
function readCodexRun(dir: string): RunResult {
  const stop = (why: string): RunResult => {
    const pid = Number(existsSync(join(dir, "pid.txt")) ? readFileSync(join(dir, "pid.txt"), "utf8") : 0);
    if (pid && !existsSync(join(dir, "exit.txt"))) killTree(pid);
    writeFileSync(join(dir, "exit.txt"), "-1", "utf8");
    writeFileSync(join(dir, "stopped.txt"), why, "utf8");
    return { status: "failed", error: why };
  };
  if (existsSync(join(dir, "stopped.txt"))) return { status: "failed", error: readFileSync(join(dir, "stopped.txt"), "utf8") };
  for (const line of readFileSync(join(dir, "events.jsonl"), "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const it = e.item;
    if (it && !CODEX_RESEARCH_ITEMS.has(it.type)) return stop(`Codex 调研用了不该用的能力（${it.type}），已停止`);
    if (it?.type === "mcp_tool_call" && it.server && it.server !== DATA_SERVER) return stop(`Codex 调研调了数据工具以外的 MCP（${it.server}），已停止`);
  }
  if (!existsSync(join(dir, "exit.txt"))) {
    const started = existsSync(join(dir, "pid.txt")) ? statSync(join(dir, "pid.txt")).mtimeMs : Date.now();
    return Date.now() - started > CODEX_RUN_MS ? stop("Codex 调研超过半小时，已停止") : { status: "running" };
  }
  const raw = existsSync(join(dir, "last.md")) ? readFileSync(join(dir, "last.md"), "utf8").trim() : "";
  if (!raw) {
    const said = errorsOf(dir);
    // the model set in their Codex config is refused by the installed Codex: once more on its default (said on the settings page)
    if (!existsSync(join(dir, "retried.txt")) && existsSync(join(dir, "launch.json")) && noteModelRefused("codex", said)) {
      const l = JSON.parse(readFileSync(join(dir, "launch.json"), "utf8")) as { cmd: string; args: string[] };
      const args = l.args.filter((a, i) => !(a.startsWith("model=") && l.args[i - 1] === "-c") && !(a === "-c" && String(l.args[i + 1]).startsWith("model=")));
      writeFileSync(join(dir, "retried.txt"), said.slice(0, 300), "utf8");
      for (const f of ["exit.txt", "pid.txt"]) rmSync(join(dir, f), { force: true });
      startDetached(dir, l.cmd, args, readFileSync(join(dir, "brief.md"), "utf8"), "events.jsonl");
      return { status: "running" };
    }
    return { status: "failed", error: `Codex 没有给出结果：${said || (existsSync(join(dir, "stderr.log")) ? readFileSync(join(dir, "stderr.log"), "utf8").slice(-300) : "")}` };
  }
  try { return { status: "done", structured: JSON.parse(raw.replace(/^```(?:json)?\s*|\s*```$/g, "")), resultText: raw }; }
  catch { return { status: "failed", error: "Codex 的结果不是 JSON：" + raw.slice(0, 300) }; }
}

/** What Codex said went wrong, without its routine warnings. */
function errorsOf(dir: string): string {
  const out: string[] = [];
  for (const line of readFileSync(join(dir, "events.jsonl"), "utf8").split("\n")) {
    if (!line.startsWith("{")) continue;
    let e: any; try { e = JSON.parse(line); } catch { continue; }
    const msg = e.type === "error" ? e.message : e.type === "turn.failed" ? e.error?.message : e.item?.type === "error" ? e.item.message : "";
    if (msg && !/skill descriptions were shortened|model metadata for/i.test(String(msg))) out.push(String(msg));
  }
  return out.join(" ").slice(0, 400);
}
