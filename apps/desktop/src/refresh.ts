/**
 * In-place refresh (tech-debt item 5A, 2026-10-14). When data changes elsewhere — another window, the person's own agent
 * through MCP, the chat drawer — the page on screen fetches again and keeps everything local: scroll position, what is
 * expanded or selected, half-typed text. It used to be thrown away and rebuilt (`key={tick}` in App), which lost all of that.
 *
 * App calls `dataChanged()` for each such event; a burst (an agent doing twenty writes) becomes one refresh. Each part of a
 * page that shows daemon data calls `useOnDataChange(load)`; `useLatest()` drops an older answer that arrives after a newer one.
 */
import { useCallback, useEffect, useRef, useSyncExternalStore } from "react";

let version = 0;
const subs = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let since = 0; // when the oldest change not yet passed on came in

const QUIET_MS = 300; // wait this long after the last change in a burst…
const MAX_WAIT_MS = 1500; // …but never longer than this after the first one, so a long burst still shows as it goes

export function dataChanged(): void {
  const now = Date.now();
  if (!timer) since = now;
  clearTimeout(timer);
  timer = setTimeout(() => { timer = undefined; version++; for (const f of [...subs]) f(); }, Math.max(0, Math.min(QUIET_MS, since + MAX_WAIT_MS - now)));
}

const subscribe = (f: () => void) => { subs.add(f); return () => { subs.delete(f); }; };
export function useDataVersion(): number { return useSyncExternalStore(subscribe, () => version); }

/** Calls `fn` (the latest one passed) each time data changed elsewhere — not on mount: the component's own effect loads first. */
export function useOnDataChange(fn: () => unknown): void {
  const v = useDataVersion();
  const latest = useRef(fn);
  latest.current = fn;
  const seen = useRef(v);
  useEffect(() => {
    if (v === seen.current) return;
    seen.current = v;
    void latest.current();
  }, [v]);
}

/**
 * `latest(key, promise)`: settles like `promise` only if no newer call with the same key was made meanwhile; an
 * overtaken answer never settles, so it can neither overwrite newer data nor report a stale error.
 */
export function useLatest(): <T>(key: string, p: Promise<T>) => Promise<T> {
  const seq = useRef(new Map<string, number>());
  return useCallback(<T,>(key: string, p: Promise<T>) => {
    const n = (seq.current.get(key) ?? 0) + 1;
    seq.current.set(key, n);
    const mine = () => seq.current.get(key) === n;
    return new Promise<T>((ok, fail) => { p.then((v) => { if (mine()) ok(v); }, (e) => { if (mine()) fail(e); }); });
  }, []);
}
