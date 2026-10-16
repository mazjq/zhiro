/**
 * A chat backend that answers each message by running a harness's command line once (ADR-046): Claude Code or Codex,
 * continued by its session id. The daemon keeps its own record of every turn (chat_turn), hands the process a turn
 * token for the jobos MCP server (so its writes and cards carry the turn id and it can never confirm its own cards),
 * and bounds the process: wall clock, silence, output size, and a kill of the whole tree on cancel or timeout.
 */
import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createInterface } from "node:readline";
import { ulid } from "ulid";
import type { Services } from "../../registry.js";
import type { Auth } from "../../auth.js";
import type { BackendName, ChatBackend, ChatEvent, Turn } from "../backend.js";
import { chatRules, historyPack } from "../rules.js";
import { listActions } from "../../service/tiers.js";

/** What a parsed line means to the runner. Events in pi's shape go to the drawer; the rest steer the turn. */
export type CliLine =
  | { kind: "event"; event: ChatEvent }
  | { kind: "session"; id: string }
  | { kind: "text"; text: string }
  | { kind: "result"; text: string; costUsd?: number; isError: boolean; error?: string; sessionMissing?: boolean }
  | { kind: "ignore" };

export interface CliSpec {
  name: Exclude<BackendName, "builtin">;
  /** The executable, or null when not installed. */
  launcher(): { cmd: string; args: string[] } | null;
  /** The process for one turn. `mcp` is the jobos server with this turn's token in its env. */
  argv(o: { dir: string; sessionId: string | null; rulesFile: string; mcp: { command: string; args: string[]; env: Record<string, string> }; prompt: string; budgetUsd: number; maxTurns: number }): { args: string[]; stdin?: string };
  /** Before the process starts: files the harness reads from its working directory. */
  prepare?(dir: string, rules: string): void;
  parser(): (line: string) => CliLine[];
}

export const LIMITS = { wallMs: 10 * 60_000, idleMs: 2 * 60_000, maxStdoutBytes: 20_000_000, maxEvents: 5_000, budgetUsd: 2, maxTurns: 60 };

/** Kill the process and everything it started (the CLI, node shims, the MCP forwarder). */
export function killTree(pid: number): void {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
    else process.kill(-pid, "SIGKILL");
  } catch { /* already gone */ }
}

/**
 * The model the person chose inside the harness (ADR-057, 「只跟随模型和登录」): the harness is still started without the
 * rest of their settings, so the choice is read and passed on. Claude: `ANTHROPIC_MODEL`, else `model` in
 * ~/.claude/settings.json. Codex: `JOBOS_CODEX_MODEL`, else the top-level `model` in ~/.codex/config.toml. Nothing found:
 * nothing passed, the harness uses its own default.
 */
export function followedModel(name: "claude" | "codex", home = process.env.JOBOS_HARNESS_HOME || homedir()): string {
  if (refused.has(name)) return "";
  return chosen.get(name) || harnessModel(name, home);
}

/**
 * A model picked on Zhiro's settings page (agent.model) instead of the harness's own: used for Zhiro's runs only, the
 * harness's settings are not touched. Held here because every start of a harness asks followedModel; set from the
 * config at daemon start and by agent.model.
 */
const chosen = new Map<string, string>();
export function chooseModel(name: "claude" | "codex", model: string): void {
  if (model) chosen.set(name, model); else chosen.delete(name);
  refused.delete(name); // a refusal was of the model chosen before
}

/** What the harness itself is set to (its own settings), "" when nothing is set: the 跟随 option on the settings page. */
export function harnessModel(name: "claude" | "codex", home = process.env.JOBOS_HARNESS_HOME || homedir()): string {
  try {
    if (name === "claude") return process.env.ANTHROPIC_MODEL || String(JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")).model ?? "");
    if (process.env.JOBOS_CODEX_MODEL) return process.env.JOBOS_CODEX_MODEL;
    const top = readFileSync(join(home, ".codex", "config.toml"), "utf8").split(/^\s*\[/m)[0];
    return /^\s*model\s*=\s*"([^"]+)"/m.exec(top)?.[1] ?? "";
  } catch { return ""; }
}

export interface HarnessModel { id: string; name: string; description: string; older: boolean }
/**
 * The models the harness on this computer offers, read from the list it keeps itself (no network, no login): Claude
 * Code's model catalog cache, Codex's models cache. Newest first; `older` = shown only under 更早的. A harness that has
 * not written its list yet gives none, and the page offers only 跟随.
 */
export function harnessModels(name: "claude" | "codex", home = process.env.JOBOS_HARNESS_HOME || homedir()): HarnessModel[] {
  try {
    if (name === "claude") {
      const dir = join(home, ".claude", "cache", "model-catalog");
      const file = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => join(dir, f)).sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
      const models = JSON.parse(readFileSync(file, "utf8")).catalog?.config?.models ?? [];
      return models.filter((m: any) => m?.id).map((m: any) => ({ id: String(m.id), name: String(m.name ?? m.id), description: String(m.description ?? ""), older: m.section !== "main" }));
    }
    const models = JSON.parse(readFileSync(join(home, ".codex", "models_cache.json"), "utf8")).models ?? [];
    return models.filter((m: any) => m?.slug && m.visibility === "list").sort((a: any, b: any) => (a.priority ?? 99) - (b.priority ?? 99))
      .map((m: any, i: number) => ({ id: String(m.slug), name: String(m.display_name ?? m.slug), description: String(m.description ?? ""), older: i >= 4 }));
  } catch { return []; }
}

/**
 * A followed model the installed command line refuses (seen 2026-10-14: `gpt-6.1-sol` set in ~/.codex/config.toml, which
 * Codex 0.154 rejects for a ChatGPT login while newer Codex accepts it). From then on the harness's own default is used
 * and the settings page says why — the switch is shown, not silent. Cleared by a daemon restart.
 */
const refused = new Map<string, string>();
export const modelRefused = (name: "claude" | "codex"): string | undefined => refused.get(name);
export function noteModelRefused(name: "claude" | "codex", text: string): boolean {
  if (refused.has(name)) return false;
  const m = followedModel(name);
  if (!m || !/model.{0,80}(not supported|does not exist|not found|unknown|invalid)|unsupported model/i.test(text)) return false;
  refused.set(name, m);
  return true;
}

/** Processes a turn left behind (the daemon died mid-turn): their pids are written per turn, killed at the next start. */
export function reapOrphans(vault: string): number {
  const dir = join(vault, "chat");
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const backend of ["claude", "codex", "dsh", "oneshot"]) {
    const f = join(dir, backend, "pids.json");
    if (!existsSync(f)) continue;
    try { for (const pid of JSON.parse(readFileSync(f, "utf8")) as number[]) { killTree(pid); n++; } } catch { /* unreadable */ }
    rmSync(f, { force: true });
  }
  return n;
}

export function cliBackend(s: Services, auth: Auth, spec: CliSpec, relay: () => { command: string; args: string[] }): ChatBackend {
  const listeners = new Set<(e: ChatEvent) => void>();
  const emit = (e: ChatEvent) => { for (const l of listeners) l(e); };
  const dir = () => join(s.config.vault, "chat", spec.name);
  const pidsFile = () => join(dir(), "pids.json");
  let child: ChildProcess | null = null;
  let current: ((why: string) => void) | null = null; // the running turn's stop, for cancel()
  let cancelled = false;
  const db = () => s.domain.db;
  const limits = () => ({ ...LIMITS, wallMs: s.config.chat?.wallMs ?? LIMITS.wallMs, idleMs: s.config.chat?.idleMs ?? LIMITS.idleMs, budgetUsd: s.config.chat?.maxBudgetUsd ?? LIMITS.budgetUsd, maxTurns: s.config.chat?.maxTurns ?? LIMITS.maxTurns });

  const sessionId = (): string | null => (db().prepare("select session_id from chat where id = ?").get(spec.name) as any)?.session_id ?? null;
  const setSession = (id: string) => db().prepare("insert or replace into chat(id, provider, model, session_id, messages_json, updated_at) values (?, ?, '', ?, '[]', ?)").run(spec.name, spec.name, id, new Date().toISOString());
  const recentTurns = () => (db().prepare("select user_text, answer from chat_turn where backend = ? and status = 'completed' order by started_at desc limit 12").all(spec.name) as any[]).reverse();

  /** One process: resolves with what it produced; the caller decides whether to run again. */
  function runOnce(turnId: string, text: string, sid: string | null, prefix: string): Promise<{ answer: string; sessionId: string | null; costUsd?: number; isError: boolean; error: string; toolCalls: number; sessionMissing: boolean; stopped: string }> {
    return new Promise((resolve) => {
      const l = limits();
      const launcher = spec.launcher();
      if (!launcher) return resolve({ answer: "", sessionId: sid, isError: true, error: `${spec.name} 没有装好`, toolCalls: 0, sessionMissing: false, stopped: "launcher" });
      mkdirSync(dir(), { recursive: true });
      const token = auth.issueTurn(turnId, l.wallMs + 60_000);
      const rulesFile = join(dir(), `rules-${turnId}.md`);
      const rules = chatRules(s);
      writeFileSync(rulesFile, rules, "utf8");
      spec.prepare?.(dir(), rules);
      const mcp = { ...relay(), env: { JOBOS_VAULT: s.config.vault, JOBOS_URL: `http://127.0.0.1:${s.config.http.port}`, JOBOS_ACTOR: spec.name, JOBOS_AGENT_TOKEN: token, ...(spec.name === "codex" ? { ZHIRO_RESULT_MODE: "text" } : {}) } }; // Codex: one copy of each result (D-23)
      const { args, stdin } = spec.argv({ dir: dir(), sessionId: sid, rulesFile, mcp, prompt: prefix + text, budgetUsd: l.budgetUsd, maxTurns: l.maxTurns });
      const parse = spec.parser();
      let answer = "", costUsd: number | undefined, isError = false, error = "", toolCalls = 0, sessionMissing = false, stopped = "", bytes = 0, events = 0, newSid: string | null = sid;
      let done = false;
      const finish = (why: string) => {
        if (done) return;
        done = true; stopped = why; current = null;
        clearTimeout(wall); clearTimeout(idle);
        auth.revokeTurn(turnId);
        rmSync(rulesFile, { force: true });
        try { const pids = (JSON.parse(readFileSync(pidsFile(), "utf8")) as number[]).filter((p) => p !== child?.pid); writeFileSync(pidsFile(), JSON.stringify(pids)); } catch { /* no file */ }
        resolve({ answer, sessionId: newSid, costUsd, isError: isError || (why !== "exit" && why !== "result"), error: error || (why === "exit" || why === "result" ? "" : why === "cancelled" ? "已停止" : why === "wall" ? "超过时间上限" : why === "idle" ? "太久没有输出" : why === "size" ? "输出过大" : why), toolCalls, sessionMissing, stopped });
      };
      const stop = (why: string) => { if (child?.pid) killTree(child.pid); finish(why); };
      current = stop;
      const wall = setTimeout(() => stop("wall"), l.wallMs);
      let idle = setTimeout(() => stop("idle"), l.idleMs);
      const touch = () => { clearTimeout(idle); idle = setTimeout(() => stop("idle"), l.idleMs); };
      child = spawn(launcher.cmd, [...launcher.args, ...args], { cwd: dir(), stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, CLAUDECODE: "" } });
      try { const pids = existsSync(pidsFile()) ? (JSON.parse(readFileSync(pidsFile(), "utf8")) as number[]) : []; writeFileSync(pidsFile(), JSON.stringify([...pids, child.pid])); } catch { /* best effort */ }
      child.on("error", (e) => { error = `spawn: ${e.message}`; isError = true; finish("spawn"); });
      if (stdin != null) { child.stdin!.write(stdin); }
      child.stdin!.end();
      const err: string[] = [];
      child.stderr!.on("data", (d) => { if (err.join("").length < 4_000) err.push(String(d)); });
      const rl = createInterface({ input: child.stdout! });
      rl.on("line", (line) => {
        touch();
        bytes += line.length; events++;
        if (bytes > l.maxStdoutBytes || events > l.maxEvents) return stop("size");
        let parsed: CliLine[];
        try { parsed = parse(line); } catch { return; }
        for (const p of parsed) {
          if (p.kind === "event") { emit(p.event); if (p.event?.type === "tool_execution_start") toolCalls++; }
          else if (p.kind === "session") { newSid = p.id; if (p.id !== sid) setSession(p.id); }
          else if (p.kind === "text") { answer = p.text; emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: p.text }] } }); }
          else if (p.kind === "result") { if (p.text) answer = p.text; costUsd = p.costUsd; isError = p.isError; error = p.error ?? ""; sessionMissing = !!p.sessionMissing; }
        }
      });
      child.on("exit", (code) => afterStdout(child!.stdout!, () => rl.close(), () => {
        const stderr = err.join("");
        // the CLI's own words, wherever it put them: Claude "No conversation found with session ID", Codex "no rollout found for thread id"
        if (sid && toolCalls === 0 && /no conversation found|no rollout found|thread .* not found|session .* not found/i.test(stderr)) sessionMissing = true;
        if (!done && code && !isError) { isError = true; error = `退出码 ${code}：${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 300)}`; }
        if (!done && !isError && !answer && spec.name === "codex") { try { answer = readFileSync(join(dir(), "last.md"), "utf8").trim(); } catch { /* no file */ } }
        finish("exit");
      }));
    });
  }

  return {
    name: spec.name,
    status: () => { const l = spec.launcher(); return l ? { available: true, detail: l.args[0] ?? l.cmd } : { available: false, detail: `没找到 ${spec.name} 的命令行` }; },
    onEvent: (l) => { listeners.add(l); return () => listeners.delete(l); },
    history: () => (db().prepare("select user_text, answer, status, error from chat_turn where backend = ? order by started_at limit 200").all(spec.name) as any[])
      .flatMap((t) => [{ role: "user" as const, text: t.user_text, backend: spec.name }, ...(t.answer || t.error ? [{ role: "agent" as const, text: t.answer || `（${t.error}）`, backend: spec.name }] : [])]),
    reset: () => { db().prepare("delete from chat where id = ?").run(spec.name); rmSync(dir(), { recursive: true, force: true }); },
    cancel: () => { cancelled = true; if (current) current("cancelled"); else if (child?.pid) killTree(child.pid); },
    async ask(text, turnId = ulid()): Promise<Turn> {
      cancelled = false;
      const startedAt = new Date().toISOString();
      db().prepare("insert into chat_turn(id, backend, session_id, user_text, started_at) values (?, ?, ?, ?, ?)").run(turnId, spec.name, sessionId() ?? "", text, startedAt);
      let r = await runOnce(turnId, text, sessionId(), "");
      // the session is gone (the harness cleaned it, or its format changed) and nothing has been done yet: start over,
      // with Zhiro's own record of the conversation as material. Any other failure is reported, never replayed.
      let note = "";
      // the model they set is refused by this command line: once more on its default, and the settings page says so
      if (r.isError && r.toolCalls === 0 && !cancelled && spec.name !== "dsh" && noteModelRefused(spec.name, r.error)) r = await runOnce(turnId, text, sessionId(), "");
      if (r.sessionMissing && r.toolCalls === 0 && !cancelled) {
        db().prepare("delete from chat where id = ?").run(spec.name);
        note = "上次的会话续不上了，已带着之前的对话重新开始。";
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: note }] } });
        r = await runOnce(turnId, text, null, historyPack(recentTurns()));
      }
      const status = cancelled ? "cancelled" : r.isError ? "failed" : "completed";
      db().prepare("update chat_turn set session_id = ?, answer = ?, status = ?, cost_usd = ?, cost_kind = ?, error = ?, finished_at = ? where id = ?")
        .run(r.sessionId ?? "", r.answer, status, r.costUsd ?? null, r.costUsd != null ? "estimated" : "unknown", r.error, new Date().toISOString(), turnId);
      const actions = listActions(s, 100).filter((a) => (db().prepare("select turn_id from agent_action where id = ?").get(a.id) as any)?.turn_id === turnId).reverse();
      const proposals = (db().prepare("select id from proposal where turn_id = ? order by created_at").all(turnId) as any[]).map((p) => s.domain.listProposals("pending").find((x) => x.id === p.id)).filter(Boolean);
      if (r.isError && !r.answer) throw new Error(r.error || `${spec.name} 没有回答`);
      return { answer: r.answer || (r.error ? `（${r.error}）` : ""), actions, proposals, cost: { usd: r.costUsd, kind: r.costUsd != null ? "estimated" : "unknown" }, note: [note, r.error].filter(Boolean).join(" ") || undefined };
    },
  };
}

/**
 * `exit` can come before the last lines on stdout are read — under load the final result (the answer) was lost, the
 * flaky 「runs a turn」 test. Run `then` once stdout has ended; after 2 s anyway (a grandchild can keep the pipe open).
 */
export function afterStdout(out: NodeJS.ReadableStream & { readableEnded?: boolean }, close: () => void, then: () => void): void {
  let ran = false;
  const go = () => { if (!ran) { ran = true; clearTimeout(t); then(); } };
  const t = setTimeout(() => { close(); go(); }, 2000);
  if (out.readableEnded) go(); else out.once("end", go);
}
