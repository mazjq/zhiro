import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Credential, CredentialInfo, CredentialStore, MutableModels, Model, Api } from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import type { JobosConfig } from "./config.js";
import type { Db } from "./db.js";
import { delegateComplete } from "./service/model-jobs.js";
import { callingAgent } from "./service/usage.js";
import { backgroundKind, BudgetDeferred, HELD, type Decision } from "./budget/index.js";

/** ADR-032: no model of our own — an external agent answers (llm.pending / llm.reply). Also when nothing is configured. */
export const EXTERNAL = "external";
export const isExternal = (provider: string) => !provider || provider === "none" || provider === EXTERNAL;
const EXTERNAL_MODEL = { id: "agent", name: "外部 agent", provider: EXTERNAL, api: "external", input: ["text"], reasoning: false } as any;

/**
 * File-backed credential store for pi-ai (same shape as pi's auth.json: { [providerId]: Credential }).
 * Lives in vault/config/credentials.json, mode 0600, written atomically. Single-process mutex via a promise chain;
 * ponytail: no cross-process file lock — the daemon is the only writer, the login CLI runs while the daemon is stopped or
 * simply wins the last write.
 */
export class FileCredentialStore implements CredentialStore {
  private chain: Promise<unknown> = Promise.resolve();
  constructor(private path: string) {}

  private load(): Record<string, Credential> {
    if (!existsSync(this.path)) return {};
    try { return JSON.parse(readFileSync(this.path, "utf8")) as Record<string, Credential>; } catch { return {}; }
  }
  private save(all: Record<string, Credential>): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = this.path + ".tmp";
    writeFileSync(tmp, JSON.stringify(all, null, 2), { encoding: "utf8", mode: 0o600 });
    renameSync(tmp, this.path);
  }
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => undefined);
    return next;
  }
  async read(providerId: string): Promise<Credential | undefined> {
    return this.load()[providerId];
  }
  async list(): Promise<readonly CredentialInfo[]> {
    return Object.entries(this.load()).map(([providerId, c]) => ({ providerId, type: c.type }));
  }
  modify(providerId: string, fn: (current: Credential | undefined) => Promise<Credential | undefined>): Promise<Credential | undefined> {
    return this.serialize(async () => {
      const all = this.load();
      const next = await fn(all[providerId]);
      if (next !== undefined) { all[providerId] = next; this.save(all); }
      return all[providerId];
    });
  }
  delete(providerId: string): Promise<void> {
    return this.serialize(async () => {
      const all = this.load();
      delete all[providerId];
      this.save(all);
    });
  }
}

export interface Llm {
  models: MutableModels;
  credentials: FileCredentialStore;
  /** Resolve the configured chat model; throws a readable error listing available ids. */
  model(): Model<Api>;
  /** Non-secret status for the settings page. */
  status(): Promise<{ provider: string; model: string; loggedIn: boolean; credentials: readonly CredentialInfo[] }>;
  /** Set by the daemon: where external-mode jobs are kept. */
  db?: Db;
  /** What the last auth check found for the configured provider; undefined until one has run. */
  loggedIn?: boolean;
  /** Called with every finished reply (it carries token usage); set by the daemon. */
  onUsage?: (message: unknown, model: Model<Api>) => void;
  /** Set by the daemon (ADR-057): who answers model work nobody started from an agent — agent/route.ts. */
  route?: () => { kind: "model" } | { kind: "harness"; name: "claude" | "codex" } | { kind: "waiting" } | { kind: "unavailable"; why: string };
  /** Set by the daemon: ask the chosen harness once, with no tools (agent/backends/oneshot.ts). */
  harness?: (name: "claude" | "codex", ctx: any) => Promise<{ text: string; model: string; usage: { input: number; output: number; cacheRead: number; total: number }; costUsd?: number }>;
  /** Set by the daemon (budget/gate.ts): may background work spend the person's allowance now? */
  gate?: () => Promise<Decision>;
}

export function credentialsPath(vault: string): string {
  return join(vault, "config", "credentials.json");
}

export function createLlm(config: JobosConfig): Llm {
  const credentials = new FileCredentialStore(credentialsPath(config.vault));
  const models = builtinModels({ credentials });
  // every reply passes through here, whichever feature asked: one place to count tokens
  const llm: Llm = {} as Llm;
  const report = (m: any, model: any) => { try { llm.onUsage?.(m, model); } catch { /* counting must never break a call */ } };
  // completeSimple is streamSimple(...).result() inside pi-ai, so wrapping the two stream entry points counts each call once
  for (const name of ["stream", "streamSimple"] as const) {
    const orig = (models as any)[name]?.bind(models);
    if (orig) (models as any)[name] = (model: any, ctx: any, opts?: any) => { const s = orig(model, ctx, opts); s.result?.().then((m: any) => report(m, model)).catch(() => {}); return s; };
  }
  // ADR-057 「谁发起，谁来做」: inside an external agent's call the work goes back to that agent; otherwise to whoever the
  // settings name for background work (agent/route.ts) — never quietly to someone else
  const complete = (models as any).completeSimple.bind(models);
  (models as any).completeSimple = async (model: any, ctx: any, opts?: any) => {
    const job = () => { if (!llm.db) throw new Error("model jobs need the daemon database"); return delegateComplete(llm.db, ctx, { caller: callingAgent() ?? "", imagesDir: join(config.vault, "runs", "model-jobs") }); };
    if (callingAgent()) return job();
    const to = llm.route?.() ?? (isExternal(config.llm.provider) || llm.loggedIn === false ? { kind: "waiting" as const } : { kind: "model" as const });
    if (to.kind === "waiting") return job();
    if (to.kind === "unavailable") throw new Error(`BACKGROUND_UNAVAILABLE: ${to.why}`);
    // background work asks before every call, not only when it starts: a run of thirty pages stops where the allowance ends
    const bg = backgroundKind();
    if (bg && HELD.has(bg) && llm.gate) { const d = await llm.gate(); if (!d.ok) throw new BudgetDeferred(d.until, d.why); }
    if (to.kind === "harness") {
      if (!llm.harness) throw new Error("BACKGROUND_UNAVAILABLE: 后台一次性调用没有接上");
      const a = await llm.harness(to.name, ctx);
      const msg = { role: "assistant", content: [{ type: "text", text: a.text }], api: "cli", provider: to.name, model: a.model || to.name, stopReason: "stop", timestamp: Date.now(),
        usage: { input: a.usage.input, output: a.usage.output, cacheRead: a.usage.cacheRead, cacheWrite: 0, totalTokens: a.usage.total, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: a.costUsd ?? 0 } } };
      report(msg, { provider: to.name, id: a.model || to.name }); // not through pi's streams, so counted here
      return msg;
    }
    return complete(model, ctx, opts);
  };
  const out = Object.assign(llm, {
    models,
    credentials,
    model() {
      const { provider, model } = config.llm;
      // background work answered by the chosen harness: a stand-in the call sites can read capabilities from
      const to = llm.route?.();
      if (to?.kind === "harness" && !callingAgent()) return { id: to.name, name: to.name, provider: to.name, api: "cli", input: ["text", "image"], reasoning: false } as any;
      if (isExternal(provider)) return EXTERNAL_MODEL;
      const m = models.getModel(provider, model);
      if (m) return m;
      const ids = models.getModels(provider).map((x) => x.id);
      throw new Error(`model ${provider}/${model} not found. available for ${provider}: ${ids.slice(0, 20).join(", ") || "(unknown provider)"}`);
    },
    async status() {
      const check = isExternal(config.llm.provider) ? { type: "none" } : await models.checkAuth(config.llm.provider).catch(() => undefined);
      llm.loggedIn = !!check;
      return { provider: config.llm.provider, model: config.llm.model, loggedIn: !!check, credentials: await credentials.list() };
    },
  });
  void out.status().catch(() => {}); // know the login state soon after start, not only once the settings page asks
  return out;
}
