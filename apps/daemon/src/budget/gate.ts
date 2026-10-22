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
/** What Zhiro's own model calls used on a channel since midnight (llm_usage). */
export function spentToday(db: Db, channel: Channel): { tokens: number; cost: number } {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const all = [...OF.codex, ...OF.claude];
  const where = channel === "api" ? `provider not in (${all.map(() => "?").join(",")})` : `provider in (${OF[channel].map(() => "?").join(",")})`;
  const r = db.prepare(`select coalesce(sum(total), 0) as t, coalesce(sum(cost), 0) as c from llm_usage where at >= ? and ${where}`).get(d.toISOString(), ...(channel === "api" ? all : OF[channel])) as { t: number; c: number };
  return { tokens: r.t, cost: r.c };
}

let codexReadAt = 0;
/** May background work spend now? Codex is asked afresh at most every ten minutes; Claude is read from its own runs. */
export async function budgetCheck(d: GateDeps, now = Date.now()): Promise<Decision> {
  const ch = await channelOf(d);
  if (!ch) return { ok: true };
  if (ch === "codex" && !d.config.maintenance && now - codexReadAt > 10 * 60_000) { // maintenance mode writes nothing
    codexReadAt = now;
    const r = await readCodexLimits(d.codexLauncher());
    if (r?.length) recordReadings(d.db, r);
  }
  const readings = ch === "api" ? [] : latestReadings(d.db, ch);
  return decide(now, ch, readings, (w) => (ch === "api" ? null : fillPerHour(d.db, ch, w)), spentToday(d.db, ch), budgetSettings(d.config));
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
  const decision = await budgetCheck(d, now);
  const windows = channel && channel !== "api"
    ? latestReadings(d.db, channel).map((r) => ({ win: r.win, used: r.used, resetsAt: r.resetsAt, readAt: r.at, fillPerHour: fillPerHour(d.db, channel, r.win) }))
    : [];
  const quiet = examQuiet(d.db, now, set.quietBeforeMins, set.quietAfterMins) ?? (await screenBusy(now));
  return { channel, windows, spentToday: channel ? spentToday(d.db, channel) : { tokens: 0, cost: 0 }, reserve: set.reserve, decision, quiet };
}
