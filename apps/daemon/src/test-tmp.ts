/**
 * Every test makes its own data directory under the system temp folder and nothing removed them: by 2026-10-13 that
 * was 17,889 directories, 37.6 GB on the user's C: drive. One run now gets one folder — the temp variables point at it
 * before the test workers start, so every mkdtempSync(tmpdir()) lands inside — and the folder goes when the run ends.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export default function setup(): () => void {
  const run = mkdtempSync(join(tmpdir(), "jobos-test-run-"));
  for (const k of ["TEMP", "TMP", "TMPDIR"]) process.env[k] = run;
  process.env.JOBOS_HARNESS_HOME = run; // never the person's real ~/.claude or ~/.codex settings (ADR-057 「跟随模型」 reads them)
  for (const k of ["ANTHROPIC_MODEL", "JOBOS_CODEX_MODEL"]) delete process.env[k];
  return () => {
    // a database file a worker closed a moment ago can still be held on Windows: retry briefly, then leave it (the next run does not depend on it)
    try { rmSync(run, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* left behind: one folder, named, easy to find */ }
  };
}
