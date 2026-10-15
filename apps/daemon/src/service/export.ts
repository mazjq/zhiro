/**
 * Export and import of a data directory (ADR-048): one zip the person can carry to another machine or keep.
 * What goes in is a list, not "everything but": a consistent snapshot of the database (VACUUM INTO, integrity-checked),
 * the configuration with its secrets removed, and the person's files. Never: tokens, model logins, browser state, the
 * harness working directories, backups, worker runs.
 */
import { DatabaseSync } from "node:sqlite";
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import YAML from "yaml";
import { zipRead, zipWrite, type ZipEntry } from "./zip.js";
import { openDb, type Db } from "../db.js";
import { upgradeVault } from "../upgrade.js";
import { replaceConfig } from "../config.js";

export const FORMAT = 1;
/** The directories of the person's own files that travel. Everything else in the vault stays. */
export const FILE_DIRS = ["research", "resume", "profile", "captures", "snapshots", "submissions"];
/** Configuration keys whose values are secrets: removed on export, kept from the existing file on import. */
const SECRET_KEY = /secret|password|token|webhook|cookie|apikey|api_key/i;
const COUNTED = ["company", "campaign", "position", "application", "fact", "proposal", "agent_action"];

export interface Manifest { format: number; exportedAt: string; schemaVersion: number; counts: Record<string, number>; files: number; dbSha256: string }

export function counts(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of COUNTED) { try { out[t] = (db.prepare(`select count(*) as n from ${t}`).get() as any).n; } catch { /* a table an older version lacks */ } }
  return out;
}

export function redact(v: any): any {
  if (Array.isArray(v)) return v.map(redact);
  if (v && typeof v === "object") { const o: any = {}; for (const [k, x] of Object.entries(v)) o[k] = SECRET_KEY.test(k) ? "" : redact(x); return o; }
  return v;
}

/** Files under the listed directories, never following links out of the vault. */
function walk(vault: string): { rel: string; abs: string }[] {
  const out: { rel: string; abs: string }[] = [];
  const visit = (abs: string, rel: string) => {
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) return;
    if (st.isDirectory()) { for (const n of readdirSync(abs)) visit(join(abs, n), rel ? `${rel}/${n}` : n); }
    else if (st.isFile()) out.push({ rel, abs });
  };
  for (const d of FILE_DIRS) if (existsSync(join(vault, d))) visit(join(vault, d), d);
  return out;
}

/**
 * Is `p` the directory itself or under it — by where they really are: the data directory may be a link to another disk
 * (ADR-058), and a path given by its real location is inside it all the same. `p` need not exist yet.
 */
const realOf = (p: string): string => { try { return realpathSync(p); } catch { const up = resolve(p, ".."); return up === resolve(p) ? up : join(realOf(up), relative(up, resolve(p))); } };
const inside = (dir: string, p: string) => { const r = relative(realOf(dir), realOf(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

/** A consistent, checked copy of the live database into `to`. The same thing the backup does. */
export function snapshotDb(db: Db, to: string): void {
  rmSync(to, { force: true });
  db.exec(`vacuum into '${to.replace(/'/g, "''")}'`);
  const copy = new DatabaseSync(to, { readOnly: true });
  try {
    const r = copy.prepare("pragma integrity_check").all() as any[];
    if (r.length !== 1 || r[0].integrity_check !== "ok") throw new Error(`SNAPSHOT_BAD: ${r.map((x) => x.integrity_check).join("; ").slice(0, 200)}`);
  } finally { copy.close(); }
}

export function exportVault(db: Db, vault: string, to: string): { path: string; bytes: number; manifest: Manifest } {
  if (!/\.zip$/i.test(to)) throw new Error("BAD_PATH: 导出文件名要以 .zip 结尾");
  if (inside(vault, to)) throw new Error("BAD_PATH: 不能导出到数据目录里面");
  if (existsSync(to)) throw new Error("EXISTS: 已有同名文件，换个名字");
  mkdirSync(join(vault, "backups"), { recursive: true });
  const snap = join(vault, "backups", `export-${Date.now()}.db`);
  snapshotDb(db, snap);
  try {
    const dbBuf = readFileSync(snap);
    const schemaVersion = (db.prepare("select max(v) as v from schema_version").get() as any).v ?? 0;
    const files = walk(vault);
    const entries: ZipEntry[] = [{ name: "jobos.db", data: dbBuf }];
    const cfg = join(vault, "config", "jobos.yaml");
    if (existsSync(cfg)) entries.push({ name: "config/jobos.yaml", data: Buffer.from(YAML.stringify(redact(YAML.parse(readFileSync(cfg, "utf8")) ?? {})), "utf8") });
    for (const f of files) entries.push({ name: `files/${f.rel}`, data: readFileSync(f.abs), mtime: statSync(f.abs).mtime });
    const manifest: Manifest = { format: FORMAT, exportedAt: new Date().toISOString(), schemaVersion, counts: counts(db), files: files.length, dbSha256: createHash("sha256").update(dbBuf).digest("hex") };
    entries.unshift({ name: "manifest.json", data: Buffer.from(JSON.stringify(manifest, null, 2), "utf8") });
    const zip = zipWrite(entries);
    mkdirSync(resolve(to, ".."), { recursive: true });
    writeFileSync(to + ".part", zip);
    renameSync(to + ".part", to);
    return { path: to, bytes: zip.length, manifest };
  } finally { rmSync(snap, { force: true }); }
}

/**
 * Replace the data directory's database, files and configuration with an export's. The daemon must not be running on
 * it (the caller holds the directory lock). The current database is kept in backups/ first. Secrets the current
 * configuration has stay (the export never carries them).
 */
export function importVault(vault: string, from: string, lock: { release(): unknown }): { backup: string; before: Record<string, number>; after: Record<string, number>; files: number; schemaVersion: number } {
  const entries = zipRead(readFileSync(from));
  const byName = new Map(entries.map((e) => [e.name, e]));
  const mf = byName.get("manifest.json"), dbe = byName.get("jobos.db");
  if (!mf || !dbe) throw new Error("NOT_EXPORT: 这不是 Zhiro 导出的 zip（缺 manifest.json 或 jobos.db）");
  const manifest = JSON.parse(mf.data.toString("utf8")) as Manifest;
  if (manifest.format !== FORMAT) throw new Error(`FORMAT: 导出格式 ${manifest.format}，这个版本只认 ${FORMAT}`);
  if (createHash("sha256").update(dbe.data).digest("hex") !== manifest.dbSha256) throw new Error("CORRUPT: 数据库与清单的校验和不符");
  for (const e of entries) if (/(^|\/)\.\.(\/|$)|^[A-Za-z]:|^\//.test(e.name)) throw new Error(`CORRUPT: 路径不对 ${e.name}`);
  mkdirSync(join(vault, "backups"), { recursive: true });
  mkdirSync(join(vault, "config"), { recursive: true });
  // the incoming database must open and pass its checks before anything of the current one is touched
  const incoming = join(vault, "backups", `import-${Date.now()}.db`);
  writeFileSync(incoming, dbe.data);
  const probe = new DatabaseSync(incoming, { readOnly: true });
  try { const r = probe.prepare("pragma integrity_check").all() as any[]; if (r.length !== 1 || r[0].integrity_check !== "ok") throw new Error("CORRUPT: 导出里的数据库没通过完整性检查"); } finally { probe.close(); }
  // keep what is there now
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backup = join(vault, "backups", `pre-import-${stamp}.db`);
  const dbPath = join(vault, "jobos.db");
  let before: Record<string, number> = {};
  // read as it is, whatever its version: this copy is only kept, never opened by the program again
  if (existsSync(dbPath)) { const cur = new DatabaseSync(dbPath, { readOnly: true }); try { before = counts(cur); snapshotDb(cur, backup); } finally { cur.close(); } }
  const cfg = join(vault, "config", "jobos.yaml");
  if (existsSync(cfg)) copyFileSync(cfg, join(vault, "backups", `pre-import-${stamp}.yaml`));
  // replace
  for (const s of ["", "-wal", "-shm"]) rmSync(dbPath + s, { force: true });
  renameSync(incoming, dbPath);
  let files = 0;
  for (const e of entries) {
    if (!e.name.startsWith("files/")) continue;
    const p = join(vault, e.name.slice(6));
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, e.data);
    files++;
  }
  const cfge = byName.get("config/jobos.yaml");
  if (cfge) {
    const incomingCfg = (YAML.parse(cfge.data.toString("utf8")) as any) ?? {};
    const current = existsSync(cfg) ? ((YAML.parse(readFileSync(cfg, "utf8")) as any) ?? {}) : {};
    const keepSecrets = (into: any, from: any) => { if (!from || typeof from !== "object") return; for (const [k, v] of Object.entries(from)) { if (SECRET_KEY.test(k) && v && !into?.[k]) into[k] = v; else if (v && typeof v === "object" && !Array.isArray(v) && into?.[k] && typeof into[k] === "object") keepSecrets(into[k], v); } };
    keepSecrets(incomingCfg, current);
    replaceConfig(vault, incomingCfg);
  }
  // the imported database is brought to this version's schema the same way an upgrade does it (on a copy, checked), and counted
  upgradeVault(vault, lock);
  const db = openDb(dbPath);
  try { const after = counts(db); const schemaVersion = (db.prepare("select max(v) as v from schema_version").get() as any).v ?? 0; return { backup, before, after, files, schemaVersion }; }
  finally { db.close(); }
}

export const defaultExportPath = (): string => { const d = new Date(); return join(process.env.USERPROFILE ?? process.env.HOME ?? ".", "Downloads", `Zhiro-${d.toISOString().slice(0, 10)}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}.zip`); };
