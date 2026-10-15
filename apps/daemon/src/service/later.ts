/**
 * Follow-up work that must not run inside the call that caused it, and must not run for every cause either. A call
 * runs the work `delay` ms later — soon enough that a person's own write shows up — and never more than once per
 * `gap`: a call inside the gap runs at the gap's end, however many calls come meanwhile. Re-matching the pool takes
 * ~6 s on 13 万 posts and rebuilding its rows ~2 s, on the thread that answers pages: a page opened right after a scan
 * waited 8 s (measured on the trial instance, 2026-10-13); the real library's subscriptions bring ~350 such scans a day.
 */
export function coalesce(fn: () => void, delay = 300, gap = 60_000, clock: () => number = Date.now): () => void {
  let timer: ReturnType<typeof setTimeout> | undefined, lastRun = -Infinity;
  return () => {
    clearTimeout(timer);
    const wait = Math.max(delay, lastRun + gap - clock());
    timer = setTimeout(() => { lastRun = clock(); fn(); }, wait);
  };
}
