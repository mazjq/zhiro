import { AsyncLocalStorage } from "node:async_hooks";
import { ulid } from "ulid";
import type { Db } from "../db.js";

/**
 * Token use per model call, tagged with what it was for. The tag is set once where work starts (a tool call, the
 * assistant, the inbox poll) and follows the work through timers and awaits (AsyncLocalStorage), so the call sites
 * that talk to the model do not have to know. `ref` groups the calls of one piece of work — e.g. one 网申 run.
 */
const scope = new AsyncLocalStorage<{ purpose: string; ref: string; caller?: { via: string; live: boolean } }>();
/** Nested purposes keep the caller set by the outer call (ADR-057). */
export const withPurpose = <T>(purpose: string, ref: string, fn: () => T): T => scope.run({ purpose, ref, caller: scope.getStore()?.caller }, fn);
export const currentPurpose = () => scope.getStore() ?? { purpose: "其他", ref: "" };

/**
 * ADR-057 「谁发起，谁来做」: model work inside an external agent's tool call is that agent's to answer. Only while the
 * call lasts: a timer or queue started inside it and still running afterwards is background work like any other.
 */
export async function asAgentCall<T>(via: string, fn: () => Promise<T>): Promise<T> {
  const caller = { via: via.slice(0, 32), live: true };
  return scope.run({ purpose: "其他", ref: "", caller }, async () => { try { return await fn(); } finally { caller.live = false; } });
}
/** The external agent whose call this work belongs to, or null. */
export const callingAgent = (): string | null => { const c = scope.getStore()?.caller; return c?.live ? c.via : null; };

export function recordUsage(db: Db, msg: any, provider: string, model: string): void {
  const u = msg?.usage;
  if (!u) return;
  const s = scope.getStore() ?? { purpose: "其他", ref: "" };
  db.prepare("insert into llm_usage(id, at, purpose, ref, provider, model, input, output, cache_read, total, cost) values (?,?,?,?,?,?,?,?,?,?,?)")
    .run(ulid(), new Date().toISOString(), s.purpose, s.ref, provider, model, u.input ?? 0, u.output ?? 0, u.cacheRead ?? 0, u.totalTokens ?? (u.input ?? 0) + (u.output ?? 0), u.cost?.total ?? 0);
}

/** What each purpose is called on the settings page. */
const LABEL: Record<string, string> = {
  "apply.start": "网申填写", "apply.read": "网申读表", "profile.import": "简历/材料抽取", "profile.scan": "简历/材料抽取", "document.reextract": "简历/材料抽取",
  "resume.save": "简历/材料抽取", "resume.analyze": "简历分析", "inbox.pull": "收件箱分类", "inbox.paste": "收件箱分类", "inbox.poll": "收件箱分类", "inbox.rescue": "收件箱分类",
  "listing.capture": "简章抽取", "chat": "助手", "llm.test": "连通测试", "company.find": "找公司入口",
};

export function usageSummary(db: Db) {
  const since = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
  const rows = db.prepare(`select purpose, count(*) as calls, sum(input) as input, sum(output) as output, sum(total) as total, sum(cost) as cost,
      count(distinct nullif(ref, '')) as jobs, sum(case when at >= ? then total else 0 end) as week
    from llm_usage group by purpose order by total desc`).all(since(7)) as any[];
  const merged = new Map<string, any>();
  for (const r of rows) {
    const label = LABEL[r.purpose] ?? r.purpose;
    const m = merged.get(label) ?? { purpose: label, calls: 0, input: 0, output: 0, total: 0, cost: 0, jobs: 0, week: 0 };
    for (const k of ["calls", "input", "output", "total", "cost", "jobs", "week"]) m[k] += r[k] ?? 0;
    merged.set(label, m);
  }
  const items = [...merged.values()].map((m) => ({ ...m, perJob: m.jobs ? Math.round(m.total / m.jobs) : Math.round(m.total / Math.max(m.calls, 1)) }));
  const t = db.prepare("select count(*) as calls, coalesce(sum(total), 0) as total, coalesce(sum(cost), 0) as cost, min(at) as since from llm_usage").get() as any;
  return { items, total: { calls: t.calls as number, total: t.total as number, cost: t.cost as number, since: (t.since ?? null) as string | null } };
}
