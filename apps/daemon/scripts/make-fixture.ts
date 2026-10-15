/**
 * `pnpm --filter @zhiro/daemon make-fixture` — a data directory as this version leaves it, for the upgrade test (ADR-050).
 * Run once per release whose schema changed; commit the zip. Everything in it is the synthetic eval world (eval/seed.ts)
 * plus two made-up files — built in a fresh temp folder, never from a real data directory.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedWorld } from "../src/eval/seed.js";
import { exportVault } from "../src/service/export.js";
import { SCHEMA_VERSION } from "../src/db.js";
import { census } from "../src/upgrade.js";

const out = resolve(import.meta.dirname, "..", "test", "fixtures");
const dir = mkdtempSync(join(tmpdir(), "zhiro-fixture-"));
try {
  const w = await seedWorld(dir);
  // the person's own files: an upgrade must leave them byte for byte
  mkdirSync(join(dir, "resume"), { recursive: true });
  writeFileSync(join(dir, "resume", "fixture-resume.md"), "# 张三（合成样本）\n\n示例理工大学 · 控制科学与工程\n", "utf8");
  mkdirSync(join(dir, "research"), { recursive: true });
  writeFileSync(join(dir, "research", "fixture-report.md"), "# 合成调研报告\n\n这是升级测试用的样本，不是真实数据。\n", "utf8");
  const name = `vault-v${SCHEMA_VERSION}`;
  mkdirSync(out, { recursive: true });
  rmSync(join(out, `${name}.zip`), { force: true });
  exportVault(w.s.domain.db, dir, join(out, `${name}.zip`));
  const expect = { synthetic: true, schema: SCHEMA_VERSION, tables: census(w.s.domain.db).counts };
  writeFileSync(join(out, `${name}.json`), JSON.stringify(expect, null, 2) + "\n", "utf8");
  w.s.domain.db.close();
  console.log(`wrote ${join(out, name)}.zip/.json`);
} finally { rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
