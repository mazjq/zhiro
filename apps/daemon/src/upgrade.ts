/**
 * Upgrading the database without putting the data at risk (ADR-050).
 *
 * The live database is never migrated in place. Under the data directory's lock: its WAL is folded into the file, a
 * consistent copy (VACUUM INTO) is made beside it, the copy is migrated and checked against the original, and only then
 * do two renames put the copy in place and the untouched original into backups/. A failure anywhere before the renames
 * deletes the copy: the original was never written. The renames are recorded first in `upgrade.json` (inside the data
 * directory, same disk), so a process killed between them is finished or undone at the next start.
 *
 * The check is not "the counts did not shrink": every table that was there keeps its exact row count (unless the
 * migration says otherwise, db.ts COUNTS_MAY_CHANGE), the person's own rows — applications, watches, profile cards,
 * confirm cards, resumes — match row by row on the columns both versions have, and the result has exactly the tables,
 * indexes and triggers a new database of this version has. Only the database changes; the files are not touched.
 */
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, openSync, readdirSync, readFileSync, readSync, renameSync, rmSync, statSync, statfsSync, writeSync } from "node:fs";
import { join, relative } from "node:path";
import { MIGRATIONS, COUNTS_MAY_CHANGE, SCHEMA_VERSION, SchemaMismatch, migrate, schemaOf, type Db } from "./db.js";
import { dbPath } from "./config.js";
import { VERSION } from "./version.js";
import YAML from "yaml";

export class UpgradeFailed extends Error { code = "UPGRADE_FAILED"; }

/** What the person's data must still be after an upgrade, row for row: table → the rows to compare. */
const KEPT: Record<string, string> = {
  application: "1", application_event: "1", stage: "1", fact: "1", proposal: "1", resume: "1", document: "1",
  deadline_override: "1", company: "1", position: "watch_priority is not null",
};

export interface Census { counts: Record<string, number>; digests: Record<string, string>; structure: string[] }

const userTables = (db: Db): string[] =>
  (db.prepare("select name from sqlite_master where type = 'table' and name not like 'sqlite_%' and name <> 'schema_version' order by name").all() as { name: string }[]).map((r) => r.name);
const columns = (db: Db, t: string): string[] => (db.prepare(`pragma table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);

function digest(db: Db, t: string, cols: string[]): string {
  const h = createHash("sha256");
  const list = cols.map((c) => `"${c}"`).join(", ");
  // ordered by every column: VACUUM may renumber rowids, so rowid order is not the same on both sides
  // .all(), not .iterate(): on Node 22.13 a statement nobody holds can be finalized mid-iteration. These tables are small.
  for (const r of db.prepare(`select ${list} from "${t}" where ${KEPT[t]} order by ${list}`).all() as Record<string, unknown>[]) h.update(JSON.stringify(cols.map((c) => r[c])));
  return h.digest("hex");
}

/** Row counts of every table, row digests of the person's own data, and the names of every table / index / trigger. */
export function census(db: Db, only?: Record<string, string[]>): Census {
  const counts: Record<string, number> = {}, digests: Record<string, string> = {};
  for (const t of userTables(db)) counts[t] = (db.prepare(`select count(*) as n from "${t}"`).get() as { n: number }).n;
  for (const t of Object.keys(KEPT)) if (t in counts) digests[t] = digest(db, t, only?.[t] ?? columns(db, t));
  const structure = (db.prepare("select type || ' ' || name as s from sqlite_master where name not like 'sqlite_%' order by s").all() as { s: string }[]).map((r) => r.s);
  return { counts, digests, structure };
}

/** What a new database of this version looks like (tables, indexes, triggers). */
function expectedStructure(migrations: string[]): string[] {
  const db = new DatabaseSync(":memory:");
  try { migrate(db, migrations); return census(db).structure; } finally { db.close(); }
}

/** Every difference between the original and the migrated copy that the migrations did not announce. Empty = fine. */
export function compare(before: Db, after: Db, from: number, migrations: string[]): string[] {
  const problems: string[] = [];
  const may = new Set<string>();
  for (let v = from + 1; v <= migrations.length; v++) for (const t of COUNTS_MAY_CHANGE[v] ?? []) may.add(t);
  const shared: Record<string, string[]> = {};
  for (const t of Object.keys(KEPT)) { const a = columns(after, t); shared[t] = columns(before, t).filter((c) => a.includes(c)); }
  const b = census(before, shared), a = census(after, shared);
  for (const [t, n] of Object.entries(b.counts)) {
    if (may.has(t)) continue;
    if (!(t in a.counts)) problems.push(`表 ${t} 不见了`);
    else if (a.counts[t] !== n) problems.push(`表 ${t}：升级前 ${n} 行，升级后 ${a.counts[t]} 行`);
  }
  for (const [t, d] of Object.entries(b.digests)) if (!may.has(t) && a.digests[t] !== d) problems.push(`表 ${t} 的内容和升级前对不上`);
  const want = expectedStructure(migrations);
  const missing = want.filter((s) => !a.structure.includes(s)), extra = a.structure.filter((s) => !want.includes(s));
  if (missing.length) problems.push(`缺少：${missing.join("、")}`);
  if (extra.length) problems.push(`多出：${extra.join("、")}`);
  const integrity = (after.prepare("pragma integrity_check").all() as { integrity_check: string }[]).map((r) => r.integrity_check);
  if (integrity.join() !== "ok") problems.push(`完整性检查：${integrity.join("；").slice(0, 200)}`);
  const fk = after.prepare("pragma foreign_key_check").all();
  if (fk.length) problems.push(`${fk.length} 条外键指向不存在的行`);
  return problems;
}

// ---------------------------------------------------------------------------------------------------------------------
// the switch, and its record

interface Journal { id: string; candidate: string; backup: string; at: string }
const journalPath = (vault: string) => join(vault, "upgrade.json");

function writeDurable(path: string, text: string): void {
  const tmp = `${path}.tmp`;
  const fd = openSync(tmp, "w");
  try { writeSync(fd, text, null, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
}

/**
 * Bring a data directory whose upgrade was cut short to one definite state. Called (under the lock) before anything
 * opens the database. Without a record, a leftover copy is from an upgrade that never reached the switch: removed.
 */
export function recoverUpgrade(vault: string): "none" | "undone" | "finished" {
  const live = dbPath(vault);
  let j: Journal | null = null;
  try { j = JSON.parse(readFileSync(journalPath(vault), "utf8")) as Journal; }
  catch (e: any) { if (e?.code !== "ENOENT") throw new UpgradeFailed(`升级记录 ${journalPath(vault)} 读不出来；数据没动，请把这个文件发给开发者，别删`); }
  const strays = () => { for (const f of readdirSync(vault)) if (/^jobos\.db\.upgrade-[0-9a-z]+(-wal|-shm)?$/.test(f)) rmSync(join(vault, f), { force: true }); };
  if (!j) { strays(); return "none"; }
  const hasLive = existsSync(live), hasCand = existsSync(j.candidate), hasBackup = existsSync(j.backup);
  let out: "undone" | "finished";
  if (hasLive && hasCand) out = "undone"; // the original never moved: the copy goes
  else if (!hasLive && hasCand && hasBackup) { renameSync(j.candidate, live); out = "finished"; }
  else if (hasLive && !hasCand) out = "finished"; // both renames happened; only the record was left
  else throw new UpgradeFailed(`升级在切换时中断，文件状态认不出来（数据库 ${hasLive ? "在" : "不在"}，升级副本 ${hasCand ? "在" : "不在"}，备份 ${hasBackup ? "在" : "不在"}）。备份 ${j.backup} 是升级前的原库，请不要删除任何文件`);
  rmSync(journalPath(vault), { force: true });
  strays();
  return out;
}

export interface BackupManifest { kind: "pre-upgrade"; fromSchema: number; toSchema: number; fromApp: string; toApp: string; sha256: string; bytes: number; counts: Record<string, number>; at: string }
export const manifestOf = (backup: string) => backup.replace(/\.db$/, ".json");

function sha256(path: string): string {
  const h = createHash("sha256"), fd = openSync(path, "r"), buf = Buffer.alloc(1 << 20);
  try { let n: number; while ((n = readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest("hex");
}

/** Which program version last opened the database (meta.app_version; "" before 0.1). */
function appOf(db: Db): string {
  try { return (db.prepare("select value from meta where key = 'app_version'").get() as { value: string } | undefined)?.value ?? ""; } catch { return ""; }
}

/** The program's backups made before an upgrade: pre-v<from>-v<to>-<time>.db, with a manifest beside each. */
const PRE = /^pre-v(\d+)-v(\d+)-(\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z)\.db$/;
/** Keep the newest three and the oldest one (data that went wrong before the last three upgrades still has a way back). */
export function stalePreUpgrade(names: string[]): string[] {
  const ours = names.filter((f) => PRE.test(f)).sort((a, b) => PRE.exec(a)![3].localeCompare(PRE.exec(b)![3]));
  return ours.slice(1, Math.max(1, ours.length - 3));
}
export const preUpgradeBackups = (vault: string): string[] => {
  try { return readdirSync(join(vault, "backups")).filter((f) => PRE.test(f)).sort((a, b) => PRE.exec(b)![3].localeCompare(PRE.exec(a)![3])); } catch { return []; }
};

export interface UpgradeResult { from: number; to: number; backup: string; ms: number }

/**
 * Upgrade the data directory's database to this program's schema, if it needs it. The caller holds the directory's lock
 * (lock.ts) — the parameter is there so that no caller forgets. `migrations` is for tests only.
 */
export function upgradeVault(vault: string, _lock: { release(): unknown }, opts: { migrations?: string[]; log?: (s: string) => void; failAfterCopy?: () => void } = {}): UpgradeResult | null {
  const migrations = opts.migrations ?? MIGRATIONS;
  const target = migrations.length;
  const log = opts.log ?? (() => {});
  recoverUpgrade(vault);
  const live = dbPath(vault);
  const have = schemaOf(live);
  if (have === 0 || have === target) return null;
  if (have > target) throw new SchemaMismatch("TOO_NEW", have, tooNewMessage(vault, have, target));
  const t0 = Date.now();
  const size = statSync(live).size + (existsSync(live + "-wal") ? statSync(live + "-wal").size : 0);
  const fs = statfsSync(vault);
  if (fs.bavail * fs.bsize < size * 2) throw new UpgradeFailed(`升级要先复制一份数据库，磁盘空间不够（需要约 ${(size * 2 / 1e9).toFixed(1)} GB）。数据没动；腾出空间后再启动`);

  const id = Date.now().toString(36);
  const candidate = `${live}.upgrade-${id}`;
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(vault, "backups", `pre-v${have}-v${target}-${stamp}.db`);
  let before: Census, fromApp: string;
  log(`升级数据库 v${have} → v${target}：先复制一份（原库不动）…`);
  const src = new DatabaseSync(live);
  try {
    src.exec("pragma wal_checkpoint(TRUNCATE)");
    fromApp = appOf(src);
    src.exec(`vacuum into '${candidate.replace(/'/g, "''")}'`);
  } catch (e: any) { src.close(); rmSync(candidate, { force: true }); throw new UpgradeFailed(`复制数据库失败：${e?.message ?? e}。数据没动`); }
  src.close();
  try {
    opts.failAfterCopy?.();
    const cand = new DatabaseSync(candidate);
    const orig = new DatabaseSync(live, { readOnly: true });
    try {
      cand.exec("pragma foreign_keys = on");
      log("在副本上升级…");
      migrate(cand, migrations);
      log("核对…");
      const problems = compare(orig, cand, have, migrations);
      if (problems.length) throw new UpgradeFailed(`升级后的副本没通过核对：${problems.join("；")}`);
      before = census(orig);
      cand.prepare("insert into upgrade_log(at, from_v, to_v, app_version, backup) values (?,?,?,?,?)").run(new Date().toISOString(), have, target, VERSION, relative(vault, backup));
      cand.prepare("insert into meta(key, value) values ('app_version', ?) on conflict(key) do update set value = excluded.value").run(VERSION);
      cand.exec("pragma wal_checkpoint(TRUNCATE)");
    } finally { orig.close(); cand.close(); }
  } catch (e: any) {
    for (const s of ["", "-wal", "-shm"]) rmSync(candidate + s, { force: true });
    if (e instanceof UpgradeFailed) throw e;
    throw new UpgradeFailed(`升级到 v${target} 失败：${String(e?.message ?? e).slice(0, 300)}。数据没动，原库照旧`);
  }
  if (existsSync(live + "-wal") && statSync(live + "-wal").size > 0) { for (const s of ["", "-wal", "-shm"]) rmSync(candidate + s, { force: true }); throw new UpgradeFailed("原库还有没并进去的写入（别的进程在写？），这次不升级，数据没动"); }
  const manifest: BackupManifest = { kind: "pre-upgrade", fromSchema: have, toSchema: target, fromApp, toApp: VERSION, sha256: sha256(live), bytes: statSync(live).size, counts: before.counts, at: new Date().toISOString() };
  writeDurable(manifestOf(backup), JSON.stringify(manifest, null, 2));
  writeDurable(journalPath(vault), JSON.stringify({ id, candidate, backup, at: new Date().toISOString() } satisfies Journal));
  for (const s of ["-wal", "-shm"]) rmSync(live + s, { force: true });
  renameSync(live, backup);
  renameSync(candidate, live);
  rmSync(journalPath(vault), { force: true });
  for (const f of stalePreUpgrade(preUpgradeBackups(vault))) { rmSync(join(vault, "backups", f), { force: true }); rmSync(join(vault, "backups", manifestOf(f)), { force: true }); }
  const ms = Date.now() - t0;
  log(`升级完成（${(ms / 1000).toFixed(1)} 秒）。升级前的库在 ${backup}`);
  return { from: have, to: target, backup, ms };
}

function tooNewMessage(vault: string, have: number, target: number): string {
  let app = "";
  try {
    const db = new DatabaseSync(dbPath(vault), { readOnly: true });
    try { app = appOf(db); } finally { db.close(); }
  } catch { /* the message works without it */ }
  return `数据是更新的版本${app ? `（${app}）` : ""}写的：数据库 v${have}，这个程序（${VERSION}）只认到 v${target}。请装${app ? ` ${app} 或更新的版本` : "新版本"}；要用这个旧版本，先运行 \`zhiro vault rollback\` 回到升级前`;
}

/** Note the program version that opened the database (the daemon, after open). */
export function stampApp(db: Db): void {
  db.prepare("insert into meta(key, value) values ('app_version', ?) on conflict(key) do update set value = excluded.value").run(VERSION);
}

// ---------------------------------------------------------------------------------------------------------------------
// verify and rollback

export interface VerifyReport { ok: boolean; schema: number; program: number; problems: string[]; counts: Record<string, number> }

/**
 * Check a data directory without changing it: one read transaction, so a running daemon's writes do not mix two
 * moments into one report. `quick` uses SQLite's quick_check instead of the full integrity check (seconds on a big file).
 */
export function verifyVault(vault: string, opts: { quick?: boolean } = {}): VerifyReport {
  const live = dbPath(vault), problems: string[] = [];
  if (!existsSync(vault)) throw new Error(`数据目录不存在：${vault}`);
  if (!existsSync(live)) return { ok: false, schema: 0, program: SCHEMA_VERSION, problems: [`没有数据库：${live}`], counts: {} };
  let schema = 0;
  try { schema = schemaOf(live); } catch (e: any) { return { ok: false, schema: 0, program: SCHEMA_VERSION, problems: [String(e?.message ?? e)], counts: {} }; }
  if (schema > SCHEMA_VERSION) problems.push(`数据库 v${schema} 比这个程序（v${SCHEMA_VERSION}）新`);
  if (schema < SCHEMA_VERSION) problems.push(`数据库 v${schema} 还没升级到 v${SCHEMA_VERSION}（启动一次就会升级）`);
  const db = new DatabaseSync(live, { readOnly: true });
  let counts: Record<string, number> = {};
  try {
    db.exec("pragma busy_timeout = 5000; begin");
    const c = census(db);
    counts = c.counts;
    const check = (db.prepare(opts.quick ? "pragma quick_check" : "pragma integrity_check").all() as Record<string, string>[]).map((r) => Object.values(r)[0]);
    if (check.join() !== "ok") problems.push(`完整性检查：${check.join("；").slice(0, 200)}`);
    const fk = db.prepare("pragma foreign_key_check").all();
    if (fk.length) problems.push(`${fk.length} 条外键指向不存在的行`);
    if (schema === SCHEMA_VERSION) {
      const want = expectedStructure(MIGRATIONS);
      const missing = want.filter((s) => !c.structure.includes(s));
      if (missing.length) problems.push(`缺少：${missing.join("、")}`);
    }
    db.exec("commit");
  } finally { db.close(); }
  const cfg = join(vault, "config", "jobos.yaml");
  if (existsSync(cfg)) { try { YAML.parse(readFileSync(cfg, "utf8")); } catch (e: any) { problems.push(`配置文件读不出来：${String(e?.message ?? e).slice(0, 120)}`); } }
  return { ok: problems.length === 0, schema, program: SCHEMA_VERSION, problems, counts };
}

/**
 * Put a pre-upgrade backup back. The daemon must be stopped (the caller holds the lock). The backup is checked against
 * its manifest first and copied, never moved — it stays a way back. The database it replaces is kept beside it.
 */
export function rollbackVault(vault: string, _lock: { release(): unknown }, file?: string): { restored: string; kept: string; manifest: BackupManifest } {
  const name = file ?? preUpgradeBackups(vault)[0];
  if (!name) throw new Error("没有升级前的备份（backups/pre-v*.db），无从回退");
  const backup = name.includes("/") || name.includes("\\") ? name : join(vault, "backups", name);
  if (!existsSync(backup)) throw new Error(`找不到备份：${backup}`);
  let manifest: BackupManifest;
  try { manifest = JSON.parse(readFileSync(manifestOf(backup), "utf8")); } catch { throw new Error(`备份旁边没有清单（${manifestOf(backup)}），不能确认它是完整的，不回退`); }
  if (sha256(backup) !== manifest.sha256) throw new Error("备份文件和它的清单对不上（文件被改过或损坏），不回退");
  const probe = new DatabaseSync(backup, { readOnly: true });
  try { const r = probe.prepare("pragma integrity_check").all() as { integrity_check: string }[]; if (r.map((x) => x.integrity_check).join() !== "ok") throw new Error("备份没通过完整性检查，不回退"); } finally { probe.close(); }
  const live = dbPath(vault);
  const kept = join(vault, "backups", `jobos.db.before-rollback-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  if (existsSync(live)) {
    const cur = new DatabaseSync(live);
    try { cur.exec("pragma wal_checkpoint(TRUNCATE)"); } finally { cur.close(); }
    for (const s of ["-wal", "-shm"]) rmSync(live + s, { force: true });
    renameSync(live, kept);
  }
  copyFileSync(backup, live + ".rollback");
  renameSync(live + ".rollback", live);
  return { restored: backup, kept, manifest };
}

/** sha256 of every file under the data directory except the database and what the program itself rotates. For tests. */
export function fileDigests(vault: string): Record<string, string> {
  const out: Record<string, string> = {};
  const skip = /^(jobos\.db.*|backups|upgrade\.json.*|agent|chat|runs)$/;
  const visit = (abs: string, rel: string) => {
    const st = lstatSync(abs);
    if (st.isDirectory()) { for (const n of readdirSync(abs)) if (rel || !skip.test(n)) visit(join(abs, n), rel ? `${rel}/${n}` : n); }
    else if (st.isFile()) out[rel] = sha256(abs);
  };
  visit(vault, "");
  return out;
}
