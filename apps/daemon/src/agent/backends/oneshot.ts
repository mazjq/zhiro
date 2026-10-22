/**
 * Background model work answered by the person's harness (ADR-057): one question, one answer, no tools at all.
 *
 * The input is often foreign — a mail, a recruiting page — so the harness must have nothing it could be talked into
 * using. Claude Code is started with `--tools ""`, Codex with its command, file, image and browser features switched
 * off. That is checked on every run, not trusted: Claude's first event lists the tools it has (must be none); Codex's
 * event stream must hold nothing but its answer. Anything else ends the run and the call fails.
 *
 * One at a time (a queue), bounded in time and output, its process tree killed on timeout, its pid written down so a
 * daemon that died mid-run cleans up at the next start. The prompt never touches the disk for Claude (stdin, as one
 * JSON line with every non-ASCII character escaped — Windows would garble it otherwise); Codex gets its images as files
 * in a fresh temporary directory outside the data directory, removed afterwards.
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLauncher } from "./claude.js";
import { codexLauncher } from "./codex.js";
import { killTree, followedModel, noteModelRefused, afterStdout } from "./cli.js";
import { lowerPriority } from "../../budget/quiet.js";

export type OneshotName = "claude" | "codex";
export const ONESHOT_LIMITS = { wallMs: 120_000, idleMs: 60_000, maxStdout: 5_000_000, maxStderr: 20_000, maxImages: 8, maxImageBytes: 5_000_000 };
const IMAGE_TYPES: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
/** Codex features that give it a way to act: commands, files, pictures, browsers, apps. */
export const CODEX_TOOLS_OFF = ["shell_tool", "unified_exec", "view_image", "apps", "browser_use", "browser_use_external", "computer_use", "image_generation", "sleep_tool", "tool_suggest", "hooks", "goals"];

export interface OneshotAnswer { text: string; model: string; usage: { input: number; output: number; cacheRead: number; total: number }; costUsd?: number; /** Claude Code's rate_limit_event, when it sent one */ rateLimit?: unknown }

/** What a context holds: the system prompt, the text, the images (each checked against the limits). */
export function promptParts(ctx: any): { system: string; text: string; images: { data: string; mimeType: string }[]; dropped: number } {
  const texts: string[] = [], images: { data: string; mimeType: string }[] = [];
  let dropped = 0;
  for (const m of ctx.messages ?? []) for (const c of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []) {
    if (c.type === "text") texts.push(c.text);
    else if (c.type === "image") {
      const ok = IMAGE_TYPES[c.mimeType] && images.length < ONESHOT_LIMITS.maxImages && Buffer.byteLength(c.data ?? "", "base64") <= ONESHOT_LIMITS.maxImageBytes;
      if (ok) images.push({ data: c.data, mimeType: c.mimeType }); else dropped++;
    }
  }
  const text = texts.join("\n\n") + (dropped ? `\n\n（另有 ${dropped} 张图片超出限制没有附上）` : "");
  return { system: String(ctx.systemPrompt ?? ""), text, images, dropped };
}

/** One JSON line in pure ASCII: what Claude reads on stdin. */
export const asciiJson = (v: unknown) => JSON.stringify(v).replace(/[\u0080-￿]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"));

/** The process for one answer. */
export function oneshotArgv(name: OneshotName, p: ReturnType<typeof promptParts>, dir: string, model: string): { args: string[]; stdin: string } {
  if (name === "claude") {
    const content = [{ type: "text", text: p.text }, ...p.images.map((im) => ({ type: "image", source: { type: "base64", media_type: im.mimeType, data: im.data } }))];
    return {
      args: ["-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--system-prompt", p.system || "按要求作答。", "--tools", "", "--permission-mode", "dontAsk", "--setting-sources", "", "--strict-mcp-config", "--max-turns", "2", ...(model ? ["--model", model] : [])],
      stdin: asciiJson({ type: "user", message: { role: "user", content } }) + "\n",
    };
  }
  const files = p.images.map((im, i) => { const f = join(dir, `image-${i + 1}.${IMAGE_TYPES[im.mimeType]}`); writeFileSync(f, Buffer.from(im.data, "base64")); return f; });
  return {
    args: ["exec", "--json", "--skip-git-repo-check", "--ignore-user-config", "--ephemeral", "-s", "read-only", "-C", dir, "-c", 'approval_policy="never"',
      ...(model ? ["-c", `model=${JSON.stringify(model)}`] : []), ...CODEX_TOOLS_OFF.flatMap((f) => ["--disable", f]), "-o", join(dir, "last.md"), ...files.flatMap((f) => ["-i", f]), "-"],
    stdin: (p.system ? `${p.system}\n\n---\n\n` : "") + p.text,
  };
}

/** Read one line of the harness's output: the answer, the reported model, or a reason to stop the run now. */
export function oneshotLine(name: OneshotName, line: string, st: { text: string; model: string; usage?: any; costUsd?: number; error?: string; done?: boolean; rateLimit?: unknown }): string | null {
  if (!line.trim().startsWith("{")) return null;
  let e: any; try { e = JSON.parse(line); } catch { return null; }
  if (name === "claude") {
    if (e.type === "system" && e.subtype === "init") {
      if (Array.isArray(e.tools) && e.tools.length) return `它带着工具启动了（${e.tools.slice(0, 5).join("、")}），不用它回答外来内容`;
      st.model = String(e.model ?? st.model);
    } else if (e.type === "assistant") {
      for (const b of e.message?.content ?? []) { if (b.type === "tool_use") return `它想用工具 ${b.name}`; if (b.type === "text" && b.text) st.text = b.text; }
    } else if (e.type === "rate_limit_event") {
      st.rateLimit = e.rate_limit_info; // the person's windows, read for free on every run (budget/)
    } else if (e.type === "result") {
      if (e.is_error) st.error = String(e.result || e.subtype || "出错了").slice(0, 300); else if (typeof e.result === "string" && e.result) st.text = e.result;
      st.costUsd = typeof e.total_cost_usd === "number" ? e.total_cost_usd : undefined;
      const u = e.usage ?? {};
      st.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cache_read_input_tokens ?? 0 };
      st.done = true;
    }
    return null;
  }
  const it = e.item;
  if ((e.type === "item.started" || e.type === "item.completed") && it && !["agent_message", "reasoning", "error"].includes(it.type)) return `它用了 ${it.type}`;
  if (e.type === "item.completed" && it?.type === "agent_message" && it.text) st.text = it.text;
  if (e.type === "turn.completed") { const u = e.usage ?? {}; st.usage = { input: u.input_tokens ?? 0, output: u.output_tokens ?? 0, cacheRead: u.cached_input_tokens ?? 0 }; st.done = true; }
  if (e.type === "turn.failed" || e.type === "error") st.error = String(e.error?.message ?? e.message ?? "出错了").slice(0, 300);
  return null;
}

let queue: Promise<unknown> = Promise.resolve();

/** Ask the harness once. Rejects with the reason when it cannot answer (not installed, timed out, reached for a tool). */
export function oneshot(name: OneshotName, ctx: any, pidsFile?: string): Promise<OneshotAnswer> {
  const run = queue.then(() => runOnce(name, ctx, pidsFile).catch((e) => {
    if (noteModelRefused(name, String(e?.message ?? e))) return runOnce(name, ctx, pidsFile); // their model refused here: its default, said on the settings page
    throw e;
  }));
  queue = run.catch(() => undefined);
  return run;
}

function runOnce(name: OneshotName, ctx: any, pidsFile?: string): Promise<OneshotAnswer> {
  return new Promise((resolve, reject) => {
    const launcher = name === "claude" ? claudeLauncher() : codexLauncher();
    if (!launcher) return reject(new Error(`BACKGROUND_UNAVAILABLE: 没找到 ${name} 的命令行`));
    const dir = mkdtempSync(join(tmpdir(), "jobos-oneshot-"));
    const model = followedModel(name);
    let argv: { args: string[]; stdin: string };
    try { argv = oneshotArgv(name, promptParts(ctx), dir, model); } catch (e) { rmSync(dir, { recursive: true, force: true }); return reject(e); }
    const child = spawn(launcher.cmd, [...launcher.args, ...argv.args], { cwd: dir, stdio: ["pipe", "pipe", "pipe"], shell: false, windowsHide: true, detached: process.platform !== "win32", env: { ...process.env, CLAUDECODE: "" } });
    const remember = (add: boolean) => { if (!pidsFile || !child.pid) return; try { const cur = existsSync(pidsFile) ? (JSON.parse(readFileSync(pidsFile, "utf8")) as number[]) : []; mkdirSync(join(pidsFile, ".."), { recursive: true }); writeFileSync(pidsFile, JSON.stringify(add ? [...cur, child.pid] : cur.filter((p) => p !== child.pid))); } catch { /* best effort */ } };
    remember(true);
    lowerPriority(child.pid); // background work gives way to whatever the person runs (phase-1 plan v3)
    const st: { text: string; model: string; usage?: any; costUsd?: number; error?: string; done?: boolean; rateLimit?: unknown } = { text: "", model };
    let out = "", err = "", bytes = 0, finished = false;
    const finish = (why?: string) => {
      if (finished) return;
      finished = true;
      clearTimeout(wall); clearTimeout(idle);
      if (why && child.pid) killTree(child.pid);
      remember(false);
      if (!st.text && name === "codex") { try { st.text = readFileSync(join(dir, "last.md"), "utf8").trim(); } catch { /* none */ } }
      rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
      if (why) return reject(new Error(`BACKGROUND_FAILED: ${name}：${why}`));
      if (st.error && !st.text) return reject(new Error(`BACKGROUND_FAILED: ${name}：${st.error}`));
      if (!st.text) return reject(new Error(`BACKGROUND_FAILED: ${name} 没有给出回答${err ? `（${err.trim().split("\n").slice(-2).join(" ").slice(0, 200)}）` : ""}`));
      const u = st.usage ?? { input: 0, output: 0, cacheRead: 0 };
      resolve({ text: st.text, model: st.model, usage: { ...u, total: u.input + u.output + u.cacheRead }, costUsd: st.costUsd, rateLimit: st.rateLimit });
    };
    const wall = setTimeout(() => finish("超过两分钟没答完"), ONESHOT_LIMITS.wallMs);
    let idle = setTimeout(() => finish("一分钟没有任何输出"), ONESHOT_LIMITS.idleMs);
    child.on("error", (e) => finish(`起不来：${e.message}`));
    child.stderr!.on("data", (d) => { if (err.length < ONESHOT_LIMITS.maxStderr) err += String(d); });
    child.stdout!.on("data", (d) => {
      clearTimeout(idle); idle = setTimeout(() => finish("一分钟没有任何输出"), ONESHOT_LIMITS.idleMs);
      bytes += d.length;
      if (bytes > ONESHOT_LIMITS.maxStdout) return finish("输出过大");
      out += String(d);
      let nl: number;
      while ((nl = out.indexOf("\n")) >= 0) {
        const line = out.slice(0, nl); out = out.slice(nl + 1);
        const stop = oneshotLine(name, line, st);
        if (stop) return finish(stop);
      }
    });
    child.on("exit", () => afterStdout(child.stdout!, () => {}, () => { if (out) { const stop = oneshotLine(name, out, st); if (stop) return finish(stop); } finish(); }));
    child.stdin!.end(argv.stdin);
  });
}
