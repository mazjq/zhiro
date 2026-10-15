import type { Db } from "../db.js";
import { emit } from "../events.js";
import { refreshPool } from "./pool.js";
import { coalesce } from "./later.js";

/**
 * Data that changed with nobody calling a tool — a scheduled pull that brought or edited posts, the matcher's rerun, a
 * research run or a mail that came in — reaches the open pages as one `data` event (tech-debt 5B), and the page on
 * screen fetches again in place (desktop refresh.ts).
 *
 * Sent only once a read returns the new rows: the pool answers a read after a background write from the rows it holds
 * and rebuilds behind it, so an event sent at the write would have the page fetch the old rows and never hear again.
 * Each event first puts the pool's new rows in place (`refreshPool`), then says what changed. A burst is one event, and
 * after one, the next comes no sooner than `gap` later: rebuilding the pool takes ~2 s on the real library, and half the
 * pulls edit something (live, 2026-10-14: 5 of 10) — 10 s apart was up to a fifth of the time frozen in the daily burst.
 *
 * `what` names the kind of change ("posts", "matches", "inbox", or the kind of work that ended); pages need not look.
 */
export function announcer(db: Db, o: { delay?: number; gap?: number } = {}): (what: string) => void {
  const pending = new Set<string>();
  const send = coalesce(() => {
    const what = [...pending];
    pending.clear();
    try { refreshPool(db); } catch (e: any) { console.error("[zhiro] pool rebuild failed", e?.message ?? e); }
    emit("data", { what });
  }, o.delay ?? 300, o.gap ?? 60_000);
  return (what) => { pending.add(what); send(); };
}
