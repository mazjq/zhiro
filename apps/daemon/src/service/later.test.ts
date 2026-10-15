import { describe, it, expect, vi } from "vitest";
import { coalesce } from "./later.js";

describe("follow-up work after a change", () => {
  it("runs soon after a call, once for a burst, and at most once per gap while calls keep coming", () => {
    vi.useFakeTimers();
    try {
      const runs: number[] = [];
      const kick = coalesce(() => runs.push(Date.now()), 300, 60_000);
      const t0 = Date.now();
      kick(); kick(); kick();
      vi.advanceTimersByTime(299); expect(runs).toEqual([]);
      vi.advanceTimersByTime(1); expect(runs).toEqual([t0 + 300]); // a burst: once, soon
      // scans every 20 s for two minutes, then a minute of quiet: the work runs once a minute (four times in three
      // minutes), not after each of the six scans
      for (let i = 0; i < 6; i++) { vi.advanceTimersByTime(20_000); kick(); }
      vi.advanceTimersByTime(60_000);
      expect(runs).toHaveLength(4);
      for (let i = 1; i < runs.length; i++) expect(runs[i] - runs[i - 1]).toBeGreaterThanOrEqual(60_000);
      // quiet for a while, then one call: soon again
      vi.advanceTimersByTime(600_000);
      kick(); vi.advanceTimersByTime(300);
      expect(runs).toHaveLength(5);
    } finally { vi.useRealTimers(); }
  });
});
