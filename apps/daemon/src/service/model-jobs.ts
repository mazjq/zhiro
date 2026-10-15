import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { now, type Db } from "../db.js";
import { DomainError, NotFound } from "./domain.js";
import { currentPurpose } from "./usage.js";

/**
 * ADR-032: an external agent (Claude Code, Codex… over MCP) stands in for the built-in model. Every model call site
 * goes through llm.models.completeSimple; in external mode that call becomes a job keyed by the hash of its prompt.
 * First call: the job is stored pending and MODEL_DELEGATED is thrown — the tool answers an agent with the prompt,
 * background work (inbox poll, document queue, apply run) simply retries later. The agent answers with llm.reply; the
 * same call made again finds the answer and goes on exactly as if a model had replied. ponytail: pull-based, not MCP
 * sampling — most clients (Claude Code included) do not implement sampling.
 */
export interface Job { id: string; kind: "complete" | "run"; purpose: string; ref: string; system: string; user: string; status: string; createdAt: string; caller: string }
const row = (r: any): Job => ({ id: r.id, kind: r.kind, purpose: r.purpose, ref: r.ref, system: r.system, user: r.user_text, status: r.status, createdAt: r.created_at, caller: r.caller ?? "" });

export class ModelDelegated extends DomainError {
  constructor(public job: Job) { super("MODEL_DELEGATED", `等外部 agent 代答：llm.pending 查看、llm.reply 回答（任务 ${job.id}）`); }
}

const EXT: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/** The prompt's text parts, and its images with a digest each (the digests are part of the job's identity). */
function promptOf(ctx: any): { text: string; images: { data: string; mimeType: string; sha: string }[] } {
  const parts: string[] = [], images: { data: string; mimeType: string; sha: string }[] = [];
  for (const m of ctx.messages ?? []) {
    for (const c of typeof m.content === "string" ? [{ type: "text", text: m.content }] : m.content ?? []) {
      if (c.type === "text") parts.push(c.text);
      else if (c.type === "image" && EXT[c.mimeType]) images.push({ data: c.data, mimeType: c.mimeType, sha: createHash("sha256").update(String(c.data)).digest("hex").slice(0, 16) });
    }
  }
  return { text: parts.join("\n\n"), images };
}

/**
 * A model call answered by an external agent (ADR-032, ADR-057): the stored answer as an assistant message, or a pending
 * job and MODEL_DELEGATED. `caller`: the agent whose call it came from (its audit label; the agents share one key, so this
 * sorts, it does not authorise). Images are written next to the job and named in the prompt for the agent to open.
 */
export function delegateComplete(db: Db, ctx: any, o: { caller?: string; imagesDir?: string } = {}) {
  const system = String(ctx.systemPrompt ?? ""), p = promptOf(ctx);
  // ISO timestamps are left out of the key: a pasted mail is stamped "now" each time, and the retry must find its answer
  const hash = createHash("sha256").update(system + "\u0000" + p.text.replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "") + "\u0000" + p.images.map((i) => i.sha).join(",")).digest("hex");
  const r = db.prepare("select * from model_job where hash = ?").get(hash) as any;
  if (r && r.status !== "pending") {
    db.prepare("update model_job set status = 'used' where id = ?").run(r.id);
    return { role: "assistant", content: [{ type: "text", text: r.answer ?? "" }], api: "external", provider: "external", model: "agent", stopReason: "stop", timestamp: Date.now(),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
  }
  if (r) throw new ModelDelegated(row(r));
  const { purpose, ref } = currentPurpose();
  const id = ulid();
  let user = p.text;
  if (p.images.length) {
    if (o.imagesDir) {
      const dir = join(o.imagesDir, id);
      mkdirSync(dir, { recursive: true });
      const files = p.images.map((im, i) => { const f = join(dir, `image-${i + 1}.${EXT[im.mimeType]}`); writeFileSync(f, Buffer.from(im.data, "base64")); return f; });
      user += `\n\n（随附 ${files.length} 张图片，用你自己的读图能力打开：\n${files.join("\n")}）`;
    } else user += `\n\n（原请求随附 ${p.images.length} 张图片未转发）`;
  }
  db.prepare("insert into model_job(id, kind, hash, purpose, ref, system, user_text, created_at, caller) values (?,?,?,?,?,?,?,?,?)").run(id, "complete", hash, purpose, ref, system, user, now(), o.caller ?? "");
  throw new ModelDelegated(row(db.prepare("select * from model_job where id = ?").get(id)));
}

/** A research worker run in external mode: the brief and the schema wait for the agent instead of spawning claude. */
export function delegateRun(db: Db, runId: string, mode: string, prompt: string, schema: object, caller = "") {
  db.prepare("insert into model_job(id, kind, purpose, system, user_text, created_at, caller) values (?,?,?,?,?,?,?)")
    .run(runId, "run", mode, `自己联网调研后，调 llm.reply 提交一个符合下面 JSON Schema 的 JSON 对象（text 就是这个 JSON）：\n${JSON.stringify(schema)}`, prompt, now(), caller);
}

/** Pending jobs; an agent sees the ones from its own calls and the ones nobody in particular started. */
export const pendingJobs = (db: Db, caller?: string) => ({
  items: ((caller === undefined
    ? db.prepare("select * from model_job where status = 'pending' order by created_at").all()
    : db.prepare("select * from model_job where status = 'pending' and caller in ('', ?) order by created_at").all(caller)) as any[]).map(row),
});

/** Store the agent's answer. A run's answer becomes the worker output its workflow already polls for. */
export function replyJob(db: Db, jobId: string, text: string): Job {
  const r = db.prepare("select * from model_job where id = ?").get(jobId) as any;
  if (!r) throw new NotFound(`model job ${jobId}`);
  if (r.kind === "run") {
    let structured: unknown;
    try { structured = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/g, "")); } catch { throw new DomainError("BAD_ANSWER", "调研结果要是一个 JSON 对象（按任务里的 Schema）"); }
    const run = db.prepare("select run_dir from agent_run where id = ?").get(jobId) as any;
    if (!run || !existsSync(run.run_dir)) throw new NotFound(`run ${jobId}`);
    writeFileSync(join(run.run_dir, "out.json"), JSON.stringify({ structured_output: structured, result: "", session_id: "", total_cost_usd: 0 }), "utf8");
    writeFileSync(join(run.run_dir, "exit.txt"), "0", "utf8");
  }
  db.prepare("update model_job set status = 'answered', answer = ?, answered_at = ? where id = ?").run(text, now(), jobId);
  return row(db.prepare("select * from model_job where id = ?").get(jobId));
}

/** Oldest mail date still waiting for (or holding an unused) answer: the inbox pull looks back at least that far. */
export function oldestWaitingMail(db: Db): string | null {
  return ((db.prepare("select min(ref) as r from model_job where purpose like 'inbox%' and status in ('pending', 'answered') and ref != ''").get() as any)?.r as string) ?? null;
}
