import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, readFileSync, statSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import YAML from "yaml";
import type { Db } from "../db.js";
import { configFile } from "../config.js";
import { snapshotDb, counts, redact } from "./export.js";

/** The program's own backups: one self-contained file each, named by the moment it was taken (UTC). */
const OWN = /^jobos-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.db$/;
const takenAt = (f: string) => Date.parse(f.slice(6, 16) + "T" + f.slice(17, 25).replace(/-/g, ":") + "." + f.slice(26, 29) + "Z");

/**
 * Which backups go (ADR-058): of the program's own, all but the newest `keep` and — among the rest — the newest one
 * taken a week or more ago. Five restarts in one evening make five backups; if the data went wrong before that evening
 * all five carry it, so one older copy stays to go back to. Anything else in the folder is not ours to delete.
 */
export function staleBackups(names: string[], now = Date.now(), keep = 5): string[] {
  const rest = names.filter((f) => OWN.test(f)).sort().reverse().slice(keep);
  const older = rest.find((f) => now - takenAt(f) >= 7 * 86_400_000);
  return rest.filter((f) => f !== older);
}

/** The configuration saved with a database backup: same name, `.yaml`. */
const pairOf = (db: string) => db.replace(/\.db$/, ".yaml");

/**
 * A consistent copy of the live database (VACUUM INTO) that passed its own integrity check and holds the same rows,
 * and beside it jobos.yaml — the subscriptions live there, not in the database — with its secrets removed (the same
 * removal as an export; webhooks and app secrets are not worth more copies). The two are one backup: if either cannot
 * be made, neither stays and the call fails; old ones go in pairs. Nothing restores the yaml by itself: to get lost
 * subscriptions back, put its `sources:` into config/jobos.yaml by hand (docs/data-sources.md).
 * Only a backup that checked out lets older ones go.
 */
export function runBackup(db: Db, vault: string): { path: string; bytes: number; verified: boolean; config: string } {
  const dir = join(vault, "backups");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `jobos-${new Date().toISOString().replace(/[:.]/g, "-")}.db`);
  const cfg = configFile(vault);
  const config = existsSync(cfg) ? pairOf(path) : ""; // a data directory always has one (loadConfig writes it)
  try {
    snapshotDb(db, path);
    const copy = new DatabaseSync(path, { readOnly: true });
    let same: boolean;
    try { same = JSON.stringify(counts(copy)) === JSON.stringify(counts(db)); } finally { copy.close(); }
    // only another process writing in between can make these differ (the `vault backup` command beside a running daemon)
    if (!same) throw new Error("BACKUP_BAD: 备份里的条数和库里对不上（备份期间库被写入了？），再跑一次");
    if (config) writeFileSync(config, YAML.stringify(redact(YAML.parse(readFileSync(cfg, "utf8")) ?? {})), "utf8");
  } catch (e) { rmSync(path, { force: true }); if (config) rmSync(config, { force: true }); throw e; }
  for (const f of staleBackups(readdirSync(dir))) { rmSync(join(dir, f), { force: true }); rmSync(join(dir, pairOf(f)), { force: true }); }
  return { path, bytes: statSync(path).size, verified: true, config };
}
