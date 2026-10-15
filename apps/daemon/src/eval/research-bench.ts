/**
 * 调研对比 (vault/research/2026-10-01-research-benchmark.md): the assistant runs the same single message dots / Muse got,
 * with its own tools only (page.read, pool.list, listing.capture …). Output = the answer plus a tool log, to be scored
 * by hand against the answer key like the other two.
 *   pnpm --filter @zhiro/daemon eval:research -- --model anthropic/claude-opus-5-5 --prompt <file> --out <file> [--max-tools 200] [--timeout 2700]
 * A fresh temp vault (seed.ts) and chrome profile: no login state, the person's real vault is only read for credentials.
 */
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, copyFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { CareerAgent } from "../agent/career.js";
import { createLlm } from "../llm.js";
import type { JobosConfig } from "../config.js";
import { seedWorld } from "./seed.js";

const a = process.argv.slice(2).filter((x) => x !== "--");
const get = (k: string, d: string) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
const spec = get("--model", "anthropic/claude-opus-5-5"), [provider, ...rest] = spec.split("/"), model = rest.join("/");
const promptPath = get("--prompt", ""), out = get("--out", "");
const maxTools = Number(get("--max-tools", "200")), timeout = Number(get("--timeout", "2700"));
if (!promptPath || !out) { console.error("--prompt and --out are required"); process.exit(2); }
const realVault = join(process.env.APPDATA ?? "", "Zhiro", "vault");

const dir = mkdtempSync(join(tmpdir(), "jobos-bench-"));
// the folder can hold a copy of the real database (--with-pool) and was never removed: ~0.7 GB a run (2026-10-14)
process.on("exit", () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* a file still held: one named folder left */ } });
// --with-pool: a COPY of the real database, so the assistant has what Zhiro really has (the pool, the official readers'
// posts, the company entrances); the copy is thrown away, the real vault is never written
if (a.includes("--with-pool")) for (const f of ["jobos.db", "jobos.db-wal", "jobos.db-shm"]) { const src = join(realVault, f); if (existsSync(src)) copyFileSync(src, join(dir, f)); }
const w = await seedWorld(dir);
const llm = createLlm({ ...w.s.config, vault: realVault, llm: { provider, model } } as JobosConfig);
const usage = { total: 0, cost: 0, replies: 0 };
llm.onUsage = (m: any) => { const u = m?.usage; if (!u) return; usage.total += u.totalTokens ?? 0; usage.cost += u.cost?.total ?? 0; usage.replies++; };
w.s.llm = llm;
w.s.config.llm = { provider, model };
w.s.config.pages = { dailyBudget: 400 };

const career = new CareerAgent(w.s, llm);
const log: string[] = [];
let calls = 0, aborted = "";
const started = Date.now();
const stamp = () => `${Math.round((Date.now() - started) / 1000)}s`;
career.onEvent((e: any) => {
  if (e.type === "tool_execution_start") {
    calls++;
    log.push(`[${stamp()}] #${calls} ${String(e.toolName).replace(/_/g, ".")} ${JSON.stringify(e.args).slice(0, 300)}`);
    if (calls > maxTools) { aborted = `超过 ${maxTools} 次工具调用上限`; (career as any).agent?.abort(); }
  } else if (e.type === "tool_execution_end") {
    const text = (e.result?.content ?? []).map((x: any) => x.text ?? "").join("");
    log.push(`    → ${e.isError ? "ERR " : ""}${text.replace(/\s+/g, " ").slice(0, 200)}`);
  } else if (e.type === "message_end" && e.message?.role === "assistant") {
    const tx = (e.message.content ?? []).filter((x: any) => x.type === "text").map((x: any) => x.text).join("");
    const m = e.message;
    log.push(`[${stamp()}] assistant stop=${m.stopReason ?? "?"} content=[${(m.content ?? []).map((x: any) => x.type + (x.type === "thinking" ? `:${String(x.thinking ?? "").length}` : "")).join(",")}]${m.errorMessage ? " error=" + String(m.errorMessage).slice(0, 300) : ""} in=${m.usage?.input ?? "?"} out=${m.usage?.output ?? "?"} cacheRead=${m.usage?.cacheRead ?? "?"}${tx ? " text: " + tx.replace(/\s+/g, " ").slice(0, 300) : ""}`);
  } else if (e.type === "agent_end" || e.type === "turn_end") {
    log.push(`[${stamp()}] ${e.type}${e.errorMessage ? " error=" + e.errorMessage : ""}`);
  }
});
const timer = setTimeout(() => { aborted = `超过 ${timeout} 秒`; (career as any).agent?.abort(); }, timeout * 1000);
let answer = "", error = "";
try { answer = (await career.ask(readFileSync(promptPath, "utf8"))).answer; } catch (e: any) { error = String(e?.message ?? e).slice(0, 500); }
clearTimeout(timer);
const agentErr = (career as any).agent?.state?.errorMessage;
if (agentErr && !error) error = `agent: ${String(agentErr).slice(0, 500)}`;
const minutes = Math.round((Date.now() - started) / 6000) / 10;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, `# Zhiro 助手回答（${spec}，${new Date().toISOString().slice(0, 16)}，${minutes} 分钟，工具 ${calls} 次，${usage.total} tok，$${usage.cost.toFixed(2)}${aborted ? "，中止：" + aborted : ""}${error ? "，错误：" + error : ""}）\n\n${answer}\n\n---\n## 工具日志\n\n${log.join("\n")}\n`, "utf8");
console.log(`done: ${minutes} min, ${calls} tools, ${usage.total} tok, $${usage.cost.toFixed(2)}${aborted ? ", aborted: " + aborted : ""}${error ? ", error: " + error : ""} → ${out}`);
process.exit(0);
