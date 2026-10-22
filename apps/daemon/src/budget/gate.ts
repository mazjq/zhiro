/**
 * The two questions background work asks (budget/index.ts, budget/quiet.ts), put together with what the daemon knows:
 * who would answer (agent/route.ts), and whose allowance that spends.
 */
import type { Db } from "../db.js";
import type { JobosConfig } from "../config.js";
import type { BackgroundTarget } from "../agent/route.js";
import { budgetSettings, decide, fillPerHour, latestReadings, recordReadings, HELD, type Channel, type Decision } from "./index.js";
import { readCodexLimits } from "./codex.js";
import { examQuiet, screenBusy } from "./quiet.js";

export interface GateDeps {
  db: Db;
  config: JobosConfig;
  target: () => BackgroundTarget;
  /** the type of the built-in model's login ("oauth" = a subscription) */
  credentialType: (provider: string) => Promise<string | undefined>;
  codexLauncher: () => { cmd: string; args: string[] } | null;
}

/**
 * Whose allowance background model work spends now; null when nobody's (it waits for the person's own agent, or cannot
 * run at all). ponytail: the built-in model logged in to ChatGPT is taken to be the account Codex's command line uses —
 * a person logged in to two different accounts would see the Codex account's windows.
 */
export async function channelOf(d: GateDeps): Promise<Channel | null> {
  const t = d.target();
  if (t.kind === "harness") return t.name;
  if (t.kind !== "model") return null;
  const p = d.config.llm.provider;
  if (p === "openai-codex") return "codex";
  if (p === "anthropic" && (await d.credentialType(p)) === "oauth") return "claude";
  return "api";
}

const OF: Record<"codex" | "claude", string[]> = { codex: ["codex", "openai-codex"], claude: ["claude", "anthropic"] };
/** What Zhiro's own model calls used on a channel since midnight (llm_usage); on a key, the built-in model's provider. */
export function spentToday(db: Db, channel: Channel, apiProvider = ""): { tokens: number; cost: number } {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const ps = channel === "api" ? [apiProvider] : OF[channel];
  const r = db.prepare(`select coalesce(sum(total), 0) as t, coalesce(sum(cost), 0) as c from llm_usage where at >= ? and provider in (${ps.map(() => "?").join(",")})`).get(d.toISOString(), ...ps) as { t: number; c: number };
  return { tokens: r.t, cost: r.c };
}

let codexReadAt = 0;
let codexReading: Promise<void> | null = null;
/** Ask Codex afresh at most every ten minutes; callers arriving meanwhile wait for the same answer. */
function refreshCodex(d: GateDeps, now: number): Promise<void> {
  if (d.config.maintenance || now - codexReadAt <= 10 * 60_000) return codexReading ?? Promise.resolve(); // maintenance mode writes nothing
  codexReadAt = now;
  codexReading = readCodexLimits(d.codexLauncher()).then((r) => { if (r?.length) recordReadings(d.db, r); }).finally(() => { codexReading = null; });
  return codexReading;
}

/**
 * May background work spend now? `refresh: false` for a look that must not read anything new (budget.status).
 * ponytail: no reservation — two held kinds may pass the same check at once, so a window can go one call past the
 * line; at most two such calls run together (one per kind), each a few thousand tokens.
 */
export async function budgetCheck(d: GateDeps, now = Date.now(), opts: { refresh?: boolean; ceiling?: number } = {}): Promise<Decision> {
  const ch = await channelOf(d);
  if (!ch) return { ok: true };
  if (ch === "codex" && opts.refresh !== false) await refreshCodex(d, now);
  const readings = ch === "api" ? [] : latestReadings(d.db, ch);
  const set = budgetSettings(d.config);
  return decide(now, ch, readings, (w) => (ch === "api" ? null : fillPerHour(d.db, ch, w)), spentToday(d.db, ch, d.config.llm.provider), set, opts.ceiling ?? 1 - set.reserve);
}

/** Sorting mail goes on until a window is nearly empty: a missed test invitation costs more than the reserve. */
export const MAIL_CEILING = 0.95;

/** Before each model call of background work: held work asks about the screen, tests and the allowance; mail only its own ceiling. */
export async function callGate(d: GateDeps, kind: string, now = Date.now()): Promise<Decision> {
  if (kind === "inbox_poll") return budgetCheck(d, now, { ceiling: MAIL_CEILING });
  if (!HELD.has(kind)) return { ok: true };
  const held = await backgroundGate(d, kind, now);
  return held ? { ok: false, ...held } : { ok: true };
}

/** Before a due workflow starts: why it should wait, and until when; null to run it. */
export async function backgroundGate(d: GateDeps, kind: string, now = Date.now()): Promise<{ until: string; why: string } | null> {
  if (!HELD.has(kind)) return null;
  const set = budgetSettings(d.config);
  const later = new Date(now + 10 * 60_000).toISOString();
  const exam = examQuiet(d.db, now, set.quietBeforeMins, set.quietAfterMins);
  if (exam) return { until: later, why: exam };
  const screen = await screenBusy(now);
  if (screen) return { until: later, why: `${screen}，退出后再做` };
  const b = await budgetCheck(d, now);
  return b.ok ? null : { until: b.until, why: b.why };
}

/** budget.status: what the gate sees, for the settings page and the person's agent. */
export async function budgetStatus(d: GateDeps, now = Date.now()) {
  const set = budgetSettings(d.config);
  const channel = await channelOf(d);
  const decision = await budgetCheck(d, now, { refresh: false });
  const windows = channel && channel !== "api"
    ? latestReadings(d.db, channel).map((r) => ({ win: r.win, used: r.used, resetsAt: r.resetsAt, readAt: r.at, fillPerHour: fillPerHour(d.db, channel, r.win) }))
    : [];
  const quiet = examQuiet(d.db, now, set.quietBeforeMins, set.quietAfterMins) ?? (await screenBusy(now));
  return { channel, windows, spentToday: channel ? spentToday(d.db, channel, d.config.llm.provider) : { tokens: 0, cost: 0 }, reserve: set.reserve, decision, quiet };
}
