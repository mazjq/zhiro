/**
 * Background model work and the person's own allowance (phase-1 plan P5, v2). The model work Zhiro does on its own — the
 * daily lead lookups, the rechecks of captured notices — is paid from the same allowance the person codes and chats
 * with: a Codex or Claude subscription (windows of five hours, a week, whatever the plan has) or an API key (money).
 * Before such work, and before each of its model calls, this says whether it may go on now:
 *   - a subscription window already past the person's reserve (default 30% left for them) → wait for its reset;
 *   - a window that, at the speed it has been filling (everyone's use, read over time), would pass the reserve before it
 *     resets → wait an hour and look again;
 *   - windows never read yet → a small daily allowance of tokens, until a reading comes;
 *   - an API key → a daily spend.
 * Waiting is a sleep of the work, never a failure. Mail sorting, reminders and notices are not held back by this.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { Db } from "../db.js";

export type Channel = "codex" | "claude" | "api";
export interface Reading { channel: "codex" | "claude"; win: string; used: number; resetsAt: string | null; durationMins?: number | null; at: string }
export type Decision = { ok: true } | { ok: false; until: string; why: string };
export interface BudgetSettings { reserve: number; apiDailyUsd: number; unknownDailyTokens: number; quietBeforeMins: number; quietAfterMins: number }

const clamp = (v: unknown, lo: number, hi: number, d: number) => (typeof v === "number" && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
/** jobos.yaml's `background:` with defaults; out-of-range values are pulled back in, never trusted (A13). */
export function budgetSettings(c: { background?: Partial<BudgetSettings> }): BudgetSettings {
  const b = c.background ?? {};
  return { reserve: clamp(b.reserve, 0, 0.9, 0.3), apiDailyUsd: clamp(b.apiDailyUsd, 0, 1000, 1), unknownDailyTokens: clamp(b.unknownDailyTokens, 0, 10_000_000, 100_000), quietBeforeMins: clamp(b.quietBeforeMins, 0, 240, 30), quietAfterMins: clamp(b.quietAfterMins, 0, 600, 120) };
}

// ---------- readings

export function recordReadings(db: Db, rs: Reading[]): void {
  const ins = db.prepare("insert into budget_reading(at, channel, win, used, resets_at, duration_mins) values (?,?,?,?,?,?)");
  for (const r of rs) if (Number.isFinite(r.used)) ins.run(r.at, r.channel, r.win, Math.max(0, Math.min(1, r.used)), r.resetsAt, r.durationMins ?? null);
  // ponytail: keep a month; the speed only looks at the last few readings of a window
  db.prepare("delete from budget_reading where at < ?").run(new Date(Date.now() - 30 * 86400_000).toISOString());
}

/** The newest reading of each window of a channel, if it is recent enough to go by. */
export function latestReadings(db: Db, channel: "codex" | "claude", maxAgeMs = 6 * 3600_000): Reading[] {
  const since = new Date(Date.now() - maxAgeMs).toISOString();
  const rows = db.prepare(`select r.* from budget_reading r join (select win, max(at) as at from budget_reading where channel = ? and at >= ? group by win) m on m.win = r.win and m.at = r.at where r.channel = ?`).all(channel, since, channel) as any[];
  return rows.map((r) => ({ channel, win: r.win, used: r.used, resetsAt: r.resets_at ?? null, durationMins: r.duration_mins ?? null, at: r.at }));
}

/**
 * How fast a window has been filling, as a share per hour: the newest pairs of readings within the same reset period
 * (a reset in between says nothing of speed), newer pairs weighing more. Null with fewer than one usable pair.
 */
export function fillPerHour(db: Db, channel: "codex" | "claude", win: string): number | null {
  const rows = (db.prepare("select at, used, resets_at from budget_reading where channel = ? and win = ? order by at desc limit 24").all(channel, win) as any[]).reverse();
  let rate: number | null = null;
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1], b = rows[i];
    if (a.resets_at !== b.resets_at) continue;
    const hours = (Date.parse(b.at) - Date.parse(a.at)) / 3600_000;
    if (hours < 5 / 60) continue; // two readings minutes apart are noise
    const r = Math.max(0, b.used - a.used) / hours;
    rate = rate == null ? r : 0.7 * rate + 0.3 * r;
  }
  return rate;
}

/** Claude Code's `rate_limit_event` (stream-json): its unified windows, as readings. */
export function claudeReadings(info: any, at = new Date().toISOString()): Reading[] {
  const w = info?.unifiedWindows ?? {};
  return Object.entries(w).flatMap(([win, v]: [string, any]) =>
    typeof v?.utilization === "number" ? [{ channel: "claude" as const, win, used: v.utilization, resetsAt: v.resetsAt ? new Date(v.resetsAt * 1000).toISOString() : null, at }] : []);
}

// ---------- the decision

const label = (r: Reading) => r.win === "five_hour" || r.durationMins === 300 ? "5 小时额度" : r.win === "seven_day" || r.durationMins === 10080 ? "周额度" : `${r.durationMins ? Math.round(r.durationMins / 60) + " 小时" : r.win}额度`;
const hhmm = (ms: number) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
const tomorrow = (now: number) => { const d = new Date(now); d.setHours(24, 0, 0, 0); return d.getTime(); };

/**
 * Pure: may background work spend on this channel now? `spent` = what Zhiro's own model calls used on it today.
 * `ceiling`: the share a window may reach (default 1 − reserve; sorting mail goes up to 95%, so a test invitation is not
 * left unread for the sake of the reserve). A window whose reset has passed says nothing any more; a reading is aged by
 * the speed its window fills (someone may have used a lot since it was read).
 */
export function decide(now: number, channel: Channel, all: Reading[], fill: (win: string) => number | null, spent: { tokens: number; cost: number }, set: BudgetSettings, ceiling = 1 - set.reserve): Decision {
  const readings = all.filter((r) => !r.resetsAt || Date.parse(r.resetsAt) > now);
  const wait = (until: number, why: string): Decision => ({ ok: false, until: new Date(until).toISOString(), why });
  if (channel === "api") return spent.cost >= set.apiDailyUsd ? wait(tomorrow(now), `今天后台已用 $${spent.cost.toFixed(2)}（上限 $${set.apiDailyUsd}）`) : { ok: true };
  if (!readings.length) return spent.tokens >= set.unknownDailyTokens ? wait(tomorrow(now), `还没读到 ${channel === "codex" ? "Codex" : "Claude"} 的额度，今天后台先只用 ${set.unknownDailyTokens} token`) : { ok: true };
  const limit = ceiling;
  for (const r of readings) {
    const resets = (r.resetsAt && Date.parse(r.resetsAt)) || now + 5 * 3600_000;
    const rate = fill(r.win);
    const used = r.used + (rate ?? 0) * Math.max(0, now - Date.parse(r.at)) / 3600_000; // as it probably is now
    if (used >= limit) return wait(Math.max(resets, now + 60_000), `${label(r)}已用约 ${Math.round(Math.min(1, used) * 100)}%（给你留 ${Math.round((1 - limit) * 100)}%），${hhmm(resets)} 重置后再做`);
    if (rate && used + rate * Math.max(0, resets - now) / 3600_000 >= limit) return wait(now + 3600_000, `按最近的用量速度，${label(r)}到 ${hhmm(resets)} 重置前会用过 ${Math.round(limit * 100)}%，一小时后再看`);
  }
  return { ok: true };
}

// ---------- which work is background work

const scope = new AsyncLocalStorage<string>();
/** Run a workflow step as background work of `kind` (service/workflow.ts). */
export const asBackground = <T>(kind: string, fn: () => T): T => scope.run(kind, fn);
export const backgroundKind = (): string | null => scope.getStore() ?? null;
/**
 * The background work Zhiro schedules by itself and that spends the person's allowance: held by the gate. Sorting mail
 * is not here (it is how nothing gets missed, and small), nor research the person started (they asked for it now).
 */
export const HELD = new Set(["lead_resolve", "capture_recheck", "notice_verify", "source_relocate"]);

/** A provider's refusal for the allowance (a 429, "usage limit reached"), told apart from other failures. */
export const isLimitError = (e: unknown): boolean => /usage limit|rate.?limit|\b429\b|quota|too many requests|usage_limit|limit reached/i.test(String((e as any)?.message ?? e));

export class BudgetDeferred extends Error {
  code = "BUDGET_DEFERRED";
  constructor(public until: string, why: string) { super(why); }
}
