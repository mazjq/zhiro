import { ulid } from "ulid";
import type { Db } from "../db.js";
import { json, now } from "../db.js";

/**
 * Minimal durable workflow engine on SQLite.
 * A workflow is a named step list; each run resumes at `current_step` with its checkpoint.
 * Step handlers return one of: done | sleep(until) | wait (until an external event resumes it) | fail(err).
 * ponytail: single process, polling every N seconds, leases prevent double-run if two daemons start; no parallel steps yet.
 */
export type StepResult =
  | { type: "done"; checkpoint?: unknown }
  | { type: "sleep"; until: string; checkpoint?: unknown }
  | { type: "wait"; checkpoint?: unknown }
  | { type: "fail"; error: string; retryInMs?: number };

export interface WorkflowDef {
  kind: string;
  steps: Record<string, (ctx: { subjectId: string; checkpoint: any; attempts: number }) => Promise<StepResult>>;
  order: string[];
}

export interface WorkflowRow {
  id: string; kind: string; subjectId: string; state: string; currentStep: string; nextRunAt: string | null; lastError: string;
}

export class WorkflowEngine {
  private defs = new Map<string, WorkflowDef>();
  private timer: NodeJS.Timeout | null = null;
  /** told when a run of some kind finishes or gives up (a research report filed, a lead looked up): the pages hear of it */
  onEnded?: (kind: string, subjectId: string) => void;
  constructor(private db: Db, private pollMs = 15_000) {}
  /**
   * Set by the daemon (budget/gate.ts): before a due run starts, why it should wait and until when. A wait is not a
   * failure — the run keeps its attempts and says what it waits for in last_error.
   */
  gate?: (kind: string) => Promise<{ until: string; why: string } | null>;
  /** Set by the daemon: each step runs inside this (budget/ marks it as background work of its kind). */
  around?: <T>(kind: string, fn: () => Promise<T>) => Promise<T>;

  register(def: WorkflowDef): void {
    this.defs.set(def.kind, def);
  }

  /** Idempotent start: same idempotencyKey → existing workflow id. */
  start(kind: string, subjectId: string, idempotencyKey: string, checkpoint: unknown = {}): string {
    const def = this.defs.get(kind);
    if (!def) throw new Error(`unknown workflow ${kind}`);
    const found = this.db.prepare("select id from workflow where idempotency_key = ?").get(idempotencyKey) as { id: string } | undefined;
    if (found) return found.id;
    const id = ulid();
    const t = now();
    this.db.prepare("insert into workflow(id, kind, subject_id, state, current_step, idempotency_key, checkpoint_json, next_run_at, created_at, updated_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(id, kind, subjectId, "running", def.order[0], idempotencyKey, json.str(checkpoint), t, t, t);
    return id;
  }

  /**
   * For work that must keep going as long as its subject exists (a subscription's daily pull): start it, or — when an
   * earlier run of it ended (its subject was removed and has come back, or it gave up) — set it going again from the
   * first step. `start` alone would hand back the ended run and nothing would ever run again.
   */
  ensure(kind: string, subjectId: string, idempotencyKey: string): string {
    const id = this.start(kind, subjectId, idempotencyKey);
    const t = now();
    this.db.prepare("update workflow set state = 'running', current_step = ?, attempts = 0, next_run_at = ?, lease_until = null, last_error = '', updated_at = ? where id = ? and state in ('completed', 'failed')")
      .run(this.defs.get(kind)!.order[0], t, t, id);
    return id;
  }

  /** Its subject is gone: the work ends now, wherever it was waiting. `ensure` sets it going again if the subject returns. */
  end(idempotencyKey: string): void {
    this.db.prepare("update workflow set state = 'completed', next_run_at = null, lease_until = null, updated_at = ? where idempotency_key = ? and state in ('running', 'waiting')").run(now(), idempotencyKey);
  }

  /** Resume a waiting workflow (e.g. an external event arrived). */
  signal(id: string, patch: Record<string, unknown> = {}): void {
    const r = this.db.prepare("select checkpoint_json from workflow where id = ?").get(id) as any;
    if (!r) return;
    const cp = { ...json.parse(r.checkpoint_json, {}), ...patch };
    this.db.prepare("update workflow set state = 'running', next_run_at = ?, checkpoint_json = ?, updated_at = ? where id = ?").run(now(), json.str(cp), now(), id);
  }

  list(state?: string): WorkflowRow[] {
    const rows = state
      ? this.db.prepare("select * from workflow where state = ? order by updated_at desc").all(state)
      : this.db.prepare("select * from workflow order by updated_at desc limit 200").all();
    return (rows as any[]).map((r) => ({ id: r.id, kind: r.kind, subjectId: r.subject_id, state: r.state, currentStep: r.current_step, nextRunAt: r.next_run_at, lastError: r.last_error }));
  }

  startPolling(): void {
    if (this.timer) return;
    const loop = () => { try { this.pump(); } catch (e) { console.error("[workflow] poll failed", e); } this.timer = setTimeout(loop, this.pollMs); };
    loop();
  }
  stopPolling(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  /**
   * What each poll does: every kind of work that has something due, and is not already at it, is set going — kinds side by
   * side, one kind's workflows one after another. One loop used to run everything in turn, so a career site that takes
   * minutes to read held up a reminder, or a report that only needed filing (2026-10-13: a research answer waited behind a
   * whole-site scan).
   */
  private busy = new Set<string>();
  private pump(): void {
    const t = now();
    const kinds = this.db.prepare("select distinct kind from workflow where state = 'running' and (next_run_at is null or next_run_at <= ?) and (lease_until is null or lease_until < ?)").all(t, t) as { kind: string }[];
    for (const { kind } of kinds) {
      if (this.busy.has(kind)) continue;
      this.busy.add(kind);
      void this.tick(now(), kind).catch((e) => console.error("[workflow] tick failed", kind, e)).finally(() => this.busy.delete(kind));
    }
  }

  /** Run every due workflow once (of one kind, when given), one after another. Exposed for tests. */
  async tick(nowIso = now(), kind?: string): Promise<number> {
    const due = this.db.prepare(`select * from workflow where state = 'running' and (next_run_at is null or next_run_at <= ?) and (lease_until is null or lease_until < ?)${kind ? " and kind = ?" : ""} order by next_run_at limit 20`).all(nowIso, nowIso, ...(kind ? [kind] : [])) as any[];
    let ran = 0;
    for (const w of due) {
      const held = this.gate ? await this.gate(w.kind).catch(() => null) : null;
      if (held) { this.db.prepare("update workflow set next_run_at = ?, last_error = ?, updated_at = ? where id = ? and state = 'running'").run(held.until, `等待：${held.why}`, now(), w.id); continue; }
      const lease = new Date(Date.parse(nowIso) + 60_000).toISOString();
      const claimed = this.db.prepare("update workflow set lease_until = ? where id = ? and (lease_until is null or lease_until < ?)").run(lease, w.id, nowIso);
      if (claimed.changes === 0) continue;
      await this.runOne(w);
      ran++;
    }
    return ran;
  }

  private async runOne(w: any): Promise<void> {
    const def = this.defs.get(w.kind);
    if (!def) { this.finish(w.id, "failed", `no definition for ${w.kind}`); return; }
    let step = w.current_step;
    let checkpoint = json.parse<any>(w.checkpoint_json, {});
    let attempts = w.attempts as number;
    // run consecutive steps until one sleeps/waits/fails
    for (let guard = 0; guard < 20; guard++) {
      const handler = def.steps[step];
      if (!handler) { this.finish(w.id, "completed", ""); return; }
      let res: StepResult;
      try {
        const run = () => handler({ subjectId: w.subject_id, checkpoint, attempts });
        res = await (this.around ? this.around(w.kind, run) : run());
      } catch (e: any) {
        // the allowance or the screen asked it to wait (budget/): a sleep, not a failed attempt
        if (e?.code === "BUDGET_DEFERRED") { this.update(w.id, { state: "running", current_step: step, checkpoint, attempts, next_run_at: e.until, last_error: `等待：${e.message}` }); return; }
        res = { type: "fail", error: String(e?.message ?? e), retryInMs: 5 * 60_000 };
      }
      if ("checkpoint" in res && res.checkpoint !== undefined) checkpoint = res.checkpoint;
      if (res.type === "done") {
        const i = def.order.indexOf(step);
        const next = def.order[i + 1];
        attempts = 0;
        if (!next) { this.update(w.id, { state: "completed", current_step: step, checkpoint, attempts, next_run_at: null, last_error: "" }); this.ended(w); return; }
        step = next;
        this.update(w.id, { state: "running", current_step: step, checkpoint, attempts, next_run_at: now(), last_error: "" });
        continue;
      }
      if (res.type === "sleep") { this.update(w.id, { state: "running", current_step: step, checkpoint, attempts, next_run_at: res.until, last_error: "" }); return; }
      if (res.type === "wait") { this.update(w.id, { state: "waiting", current_step: step, checkpoint, attempts, next_run_at: null, last_error: "" }); return; }
      attempts++;
      if (attempts >= 5) { this.update(w.id, { state: "failed", current_step: step, checkpoint, attempts, next_run_at: null, last_error: res.error }); this.ended(w); return; }
      this.update(w.id, { state: "running", current_step: step, checkpoint, attempts, next_run_at: new Date(Date.now() + (res.retryInMs ?? 60_000)).toISOString(), last_error: res.error });
      return;
    }
  }

  private update(id: string, p: { state: string; current_step: string; checkpoint: unknown; attempts: number; next_run_at: string | null; last_error: string }): void {
    this.db.prepare("update workflow set state = ?, current_step = ?, checkpoint_json = ?, attempts = ?, next_run_at = ?, last_error = ?, lease_until = null, updated_at = ? where id = ?")
      .run(p.state, p.current_step, json.str(p.checkpoint), p.attempts, p.next_run_at, p.last_error, now(), id);
  }
  private ended(w: any): void { try { this.onEnded?.(w.kind, w.subject_id); } catch (e) { console.error("[workflow] onEnded failed", e); } }
  private finish(id: string, state: string, err: string): void {
    this.db.prepare("update workflow set state = ?, last_error = ?, lease_until = null, next_run_at = null, updated_at = ? where id = ?").run(state, err, now(), id);
  }
}
