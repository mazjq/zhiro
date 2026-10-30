import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** A hash of the code that reads and files posts (this folder, tests left out): it changes when a reader is fixed. */
export function dataCodeFingerprint(dir = dirname(fileURLToPath(import.meta.url))): string {
  const h = createHash("sha1");
  for (const f of (readdirSync(dir, { recursive: true }) as string[]).filter((f) => /\.[cm]?[jt]s$/.test(f) && !/\.test\./.test(f)).sort()) h.update(f).update(readFileSync(join(dir, f)));
  return h.digest("hex");
}
