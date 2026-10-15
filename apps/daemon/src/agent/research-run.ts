/**
 * Research run controller (2026-10-02, Codex review in vault/research/2026-10-02-execution-layer-codex-review.md): the
 * guard rails around one long assistant turn so it always ends with an answer and never spins. Three kinds of checks —
 * resource budgets, call fingerprints (identical calls, A/B cycles), business progress (checkpoints per item) — and an
 * irreversible RUNNING → STOPPING → FINALIZING → DONE state. Pure: no model, no browser; the agent wires it in.
 */
export const LIMITS = {
  wallMs: 30 * 60_000, toolCalls: 200, modelTurns: 80, // 36 turns ended a healthy ten-item run after the first item; the wall clock is the real cap
  browserCalls: 80, browserPerSite: 24,
  identical: 3, cycle: 2, stagnant: 25, autoContinues: 2, // ponytail: 25 = a few reads per item before the first checkpoint; 10 cut a healthy run short
};
export type ItemStatus = "answered" | "partial" | "blocked" | "not_found";
export interface Checkpoint { itemId: string; status: ItemStatus; answer: string; evidence: { url: string; title?: string; excerpt?: string }[]; reason?: string }
export type RunState = "RUNNING" | "STOPPING" | "FINALIZING" | "DONE";
export type Gate = { allow: true } | { allow: false; scope: "call" | "site" | "run"; reason: string; message: string };

const stable = (v: unknown): string => (v && typeof v === "object" && !Array.isArray(v) ? "{" + Object.keys(v as any).sort().map((k) => `${k}:${stable((v as any)[k])}`).join(",") + "}" : JSON.stringify(v));
const BROWSER_READ = (args: any) => !!(args?.browser || args?.steps?.length || args?.mode === "open" || args?.mode === "continue");
const hostOf = (u: unknown) => { try { return new URL(String(u)).host; } catch { return ""; } };

export class ResearchRun {
  state: RunState = "RUNNING";
  reason = "";
  readonly started = Date.now();
  toolCalls = 0; modelTurns = 0; browserCalls = 0;
  continues = 0; finished = false;
  private perSite = new Map<string, number>();
  private sigCount = new Map<string, number>();
  private recent: string[] = [];
  private lastProgressCall = 0;
  private progressSinceContinue = true;
  readonly ledger = new Map<string, Checkpoint>();
  private deadSites = new Set<string>();
  private walls = new Map<string, Set<string>>(); // host|status → the distinct pages that showed it

  constructor(private limits = LIMITS) {}

  /** Every tool call passes here first. A denied call never runs; a run-scoped denial also moves the run to STOPPING. */
  beforeCall(name: string, args: unknown): Gate {
    if (this.state !== "RUNNING") return this.deny("run", this.reason || "run_stopping", "工具阶段已结束；现有记录将用于生成最终答案。");
    this.toolCalls++;
    if (Date.now() - this.started > this.limits.wallMs) return this.stop("wall_time_exceeded", "本轮时间已到 30 分钟");
    if (this.toolCalls > this.limits.toolCalls) return this.stop("tool_calls_exceeded", `本轮工具调用已达 ${this.limits.toolCalls} 次`);
    if (this.ledger.size && this.toolCalls - this.lastProgressCall > this.limits.stagnant) return this.stop("stagnant", `连续 ${this.limits.stagnant} 次调用没有任何题目取得进展`);
    const sig = name + stable(args);
    const n = (this.sigCount.get(sig) ?? 0) + 1;
    this.sigCount.set(sig, n);
    if (n >= this.limits.identical) return this.deny("call", "identical_call", `同样的调用已做过 ${n - 1} 次，不再执行：换个做法，或把这一题用 research_checkpoint 标为 blocked / not_found 并写明原因`);
    this.recent.push(sig);
    if (this.recent.length > 12) this.recent.shift();
    if (this.isCycle()) return this.deny("call", "ab_cycle", "最近的调用在两个页面之间来回循环，不再执行：把拿到的结果记入 research_checkpoint，或换个站点");
    if (name === "page_read") {
      const host = hostOf((args as any)?.url);
      if (host && this.deadSites.has(host)) return this.deny("site", "site_fused", `${host} 已判定读不到（登录墙 / 拦截），不再读这个站：把相关题目标为 blocked`);
      if (BROWSER_READ(args)) {
        this.browserCalls++;
        if (this.browserCalls > this.limits.browserCalls) return this.stop("browser_budget_exceeded", `本轮浏览器读页已达 ${this.limits.browserCalls} 次`);
        if (host) { const c = (this.perSite.get(host) ?? 0) + 1; this.perSite.set(host, c); if (c > this.limits.browserPerSite) return this.deny("site", "site_budget_exceeded", `${host} 本轮已读 ${this.limits.browserPerSite} 页，不再读这个站：用已有内容作答或标 partial`); }
      }
    }
    return { allow: true };
  }

  /** Tool results feed the site fuses: a login wall or a block on two different pages of a site. An empty page never fuses (splash roots are empty while the site works). */
  afterCall(name: string, args: unknown, result: any): void {
    if (name !== "page_read" || !result || !["needsLogin", "blocked"].includes(result.status)) return;
    const host = hostOf((args as any)?.url) || hostOf(result.finalUrl);
    if (!host) return;
    const key = `${host}|${result.status}`;
    const urls = this.walls.get(key) ?? new Set<string>();
    urls.add(String((args as any)?.url ?? result.url ?? "").split("#")[0]);
    this.walls.set(key, urls);
    if (urls.size >= 2) this.deadSites.add(host);
  }

  onModelTurn(): Gate | null {
    this.modelTurns++;
    return this.modelTurns > this.limits.modelTurns ? this.stop("model_turns_exceeded", `本轮模型回合已达 ${this.limits.modelTurns} 次`) : null;
  }

  /** A checkpoint is progress only when it adds an item, new evidence or a terminal status; re-saying the same thing is not. */
  checkpoint(c: Checkpoint): { ok: true; progress: boolean; items: number } {
    const prev = this.ledger.get(c.itemId);
    const urls = new Set(c.evidence.map((e) => e.url));
    const progress = !prev || (prev.status === "partial" && c.status !== "partial") || c.evidence.some((e) => !prev.evidence.some((p) => p.url === e.url)) || (c.answer !== prev.answer && urls.size > 0);
    this.ledger.set(c.itemId, { ...c, answer: c.answer.slice(0, 2_000), evidence: c.evidence.slice(0, 5).map((e) => ({ ...e, excerpt: e.excerpt?.slice(0, 500) })) });
    if (progress) { this.lastProgressCall = this.toolCalls; this.progressSinceContinue = true; }
    return { ok: true, progress, items: this.ledger.size };
  }

  /** Accepted only when no item is still partial; otherwise names what is missing. */
  finish(): { ok: boolean; missing: string[] } {
    const missing = [...this.ledger.values()].filter((c) => c.status === "partial").map((c) => c.itemId);
    if (!missing.length) { this.finished = true; this.state = "STOPPING"; this.reason = "finished"; }
    return { ok: !missing.length, missing };
  }

  /** After the model ended a turn with text: continue only while something is open, progress was made and the cap holds. */
  shouldAutoContinue(): boolean {
    if (this.state !== "RUNNING" || this.finished || !this.ledger.size || this.continues >= this.limits.autoContinues || !this.progressSinceContinue) return false;
    this.continues++;
    this.progressSinceContinue = false;
    return true;
  }

  /** The run must be wrapped up by the finalizer when checkpoints exist and the model did not finish on its own. */
  needsFinalize(): boolean { return this.ledger.size > 0 && !this.finished; }

  stop(reason: string, message: string): Gate {
    if (this.state === "RUNNING") { this.state = "STOPPING"; this.reason = reason; }
    return { allow: false, scope: "run", reason, message: `${message}；工具阶段已结束，现有记录将用于生成最终答案。` };
  }

  ledgerText(): string {
    if (!this.ledger.size) return "（没有记录）";
    return [...this.ledger.values()].map((c) => `## ${c.itemId} · ${c.status}${c.reason ? "（" + c.reason + "）" : ""}\n${c.answer}\n证据：${c.evidence.map((e) => `${e.title ? e.title + " " : ""}${e.url}${e.excerpt ? "「" + e.excerpt + "」" : ""}`).join("；") || "无"}`).join("\n\n");
  }

  private deny(scope: "call" | "site" | "run", reason: string, message: string): Gate { return { allow: false, scope, reason, message }; }
  private isCycle(): boolean {
    const r = this.recent;
    if (r.length < 4) return false;
    const [a, b] = r.slice(-2);
    if (a === b) return false;
    let reps = 0;
    for (let i = r.length - 2; i >= 1; i -= 2) { if (r[i] === a && r[i - 1] === b) reps++; else break; }
    return reps >= this.limits.cycle;
  }
}
