import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve, relative, dirname } from "node:path";

/**
 * The line the data layer keeps (ADR-042): it stands on the base (database, workflow engine, config) and on the shared
 * contracts, and on nothing above — no tools, no agent, no model, no HTTP server, no browser. And the other way round:
 * code outside reaches the layer only through data/index.ts.
 */
const SRC = resolve(import.meta.dirname, "..");
const DATA = join(SRC, "data");
const BASE = ["db.ts", "config.ts", "datadir.ts", "lock.ts", "move.ts", "service/workflow.ts"]; // what the layer may stand on
const PACKAGES = ["ulid", "yaml", "@zhiro/contracts"];
const TEST_ONLY = ["vitest"];

const walk = (d: string): string[] => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : /\.ts$/.test(p) ? [p] : []; });
const rel = (p: string) => relative(SRC, p).replace(/\\/g, "/");
/** every module a file names in an import / export-from statement or a dynamic import of a literal */
const imports = (file: string) => [...readFileSync(file, "utf8").matchAll(/^\s*(?:import|export)\b[^"';]*?\bfrom\s*["']([^"']+)["']|^\s*import\s*["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm)].map((m) => m[1] ?? m[2] ?? m[3]);
const target = (file: string, spec: string) => rel(resolve(dirname(file), spec)).replace(/\.js$/, ".ts");

describe("the data layer stands alone", () => {
  it("nothing in data/ (nor the base under it) imports from above", () => {
    expect(imports(join(DATA, "ingest.ts"))).toContain("./catalog.js"); // the reading of imports itself works
    const bad: string[] = [];
    for (const file of [...walk(DATA), ...BASE.map((b) => join(SRC, b))]) {
      const isTest = /\.test\.ts$/.test(file);
      for (const spec of imports(file)) {
        if (spec.startsWith("node:")) continue;
        if (!spec.startsWith(".")) { if (!PACKAGES.includes(spec) && !(isTest && TEST_ONLY.includes(spec))) bad.push(`${rel(file)} → ${spec}`); continue; }
        const t = target(file, spec);
        if (!t.startsWith("data/") && !BASE.includes(t)) bad.push(`${rel(file)} → ${t}`);
      }
    }
    expect(bad).toEqual([]);
  });

  it("code outside data/ comes in through data/index.ts only", () => {
    const bad: string[] = [];
    for (const file of walk(SRC).filter((f) => !rel(f).startsWith("data/"))) {
      for (const spec of imports(file)) {
        if (!spec.startsWith(".")) continue;
        const t = target(file, spec);
        // the `zhiro` command starts the `data` command as it is (its own entry point, run as a program, not used as a module)
        if (t.startsWith("data/") && t !== "data/index.ts" && !(rel(file) === "cli/zhiro.ts" && t === "data/cli.ts")) bad.push(`${rel(file)} → ${t}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
