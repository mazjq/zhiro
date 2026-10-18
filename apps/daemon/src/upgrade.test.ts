/** ADR-050: an upgrade never changes the original database; a cut-short one comes back to one state; rollback is checked. */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { MIGRATIONS, SCHEMA_VERSION, SchemaMismatch, openDb, schemaOf, migrate } from "./db.js";
import { census, fileDigests, preUpgradeBackups, recoverUpgrade, rollbackVault, stalePreUpgrade, upgradeVault, verifyVault, manifestOf, UpgradeFailed } from "./upgrade.js";
import { zipRead } from "./service/zip.js";
import { Domain } from "./service/domain.js";
import { counts } from "./service/export.js";
import { upsertFact } from "./service/profile.js";

const LOCK = { release() {} }; // test directories nobody else opens
const FIXTURES = resolve(import.meta.dirname, "..", "test", "fixtures");

/** Unpack an export-format sample into a fresh data directory, as the version that made it left it. */
function unpack(zip: string): string {
  const dir = mkdtempSync(join(tmpdir(), "zhiro-upgrade-"));
  for (const e of zipRead(readFileSync(zip))) {
    if (e.name === "manifest.json") continue;
    const rel = e.name === "jobos.db" ? "jobos.db" : e.name.startsWith("files/") ? e.name.slice(6) : e.name;
    const p = join(dir, rel);
    mkdirSync(resolve(p, ".."), { recursive: true });
    writeFileSync(p, e.data);
  }
  mkdirSync(join(dir, "backups"), { recursive: true });
  return dir;
}

/** A data directory at this program's schema with some of the person's rows in it. */
function current(): string {
  const dir = mkdtempSync(join(tmpdir(), "zhiro-upgrade-"));
  mkdirSync(join(dir, "backups"), { recursive: true });
  const db = openDb(join(dir, "jobos.db"));
  new Domain(db).upsertCompany("示例汽车");
  upsertFact(db, { kind: "skill", data: { name: "MATLAB" } }, "本人确认");
  db.close();
  return dir;
}

const raw = (dir: string) => readFileSync(join(dir, "jobos.db"));

describe("upgrade from every sample in test/fixtures", () => {
  const all = readdirSync(FIXTURES).filter((f) => /^vault-v\d+\.zip$/.test(f));
  const schemaOfName = (f: string) => Number(/v(\d+)/.exec(f)![1]);
  // a release that adds a migration ships a sample of its own schema, so the next release has it to upgrade from
  it(`has a sample of the current schema (v${SCHEMA_VERSION}): after adding a migration, run \`pnpm --filter @zhiro/daemon make-fixture\``, () => {
    expect(all.map(schemaOfName)).toContain(SCHEMA_VERSION);
    const dir = unpack(join(FIXTURES, `vault-v${SCHEMA_VERSION}.zip`));
    expect(upgradeVault(dir, LOCK)).toBeNull();
    expect(verifyVault(dir)).toMatchObject({ ok: true });
  });
  const samples = all.filter((f) => schemaOfName(f) < SCHEMA_VERSION);
  it("has a sample for at least one earlier schema", () => expect(samples.length).toBeGreaterThan(0));
  for (const f of samples) {
    it(`${f}: same rows, same files, verify passes, the original kept as the backup`, () => {
      const dir = unpack(join(FIXTURES, f));
      const want = JSON.parse(readFileSync(join(FIXTURES, f.replace(/\.zip$/, ".json")), "utf8")) as { schema: number; tables: Record<string, number> };
      expect(schemaOf(join(dir, "jobos.db"))).toBe(want.schema);
      const files = fileDigests(dir);
      const original = raw(dir);
      expect(() => openDb(join(dir, "jobos.db"))).toThrow(/需要先升级/);

      const r = upgradeVault(dir, LOCK)!;
      expect(r).toMatchObject({ from: want.schema, to: SCHEMA_VERSION });
      expect(readFileSync(r.backup).equals(original)).toBe(true); // the untouched original is the backup
      const m = JSON.parse(readFileSync(manifestOf(r.backup), "utf8"));
      expect(m).toMatchObject({ kind: "pre-upgrade", fromSchema: want.schema, toSchema: SCHEMA_VERSION });

      const db = openDb(join(dir, "jobos.db"));
      const now = census(db).counts;
      // meta: the upgrade notes the program version; upgrade_log: it adds its own line (checked below) — first seen
      // when a sample that already had the table (v36) was upgraded
      for (const [t, n] of Object.entries(want.tables)) if (t !== "meta" && t !== "upgrade_log") expect([t, now[t]]).toEqual([t, n]);
      // the person's things read back through the program, not just counted
      const d = new Domain(db);
      expect(counts(db)).toMatchObject({ application: want.tables.application, fact: want.tables.fact });
      expect((db.prepare("select count(*) as n from position where watch_priority is not null").get() as any).n).toBeGreaterThan(0);
      expect((db.prepare("select from_v, to_v from upgrade_log").all() as any[]).map((x) => [x.from_v, x.to_v])).toEqual([[want.schema, SCHEMA_VERSION]]);
      void d;
      db.close();
      expect(fileDigests(dir)).toEqual(files); // only the database changed
      expect(verifyVault(dir)).toMatchObject({ ok: true, schema: SCHEMA_VERSION });
      expect(existsSync(join(dir, "upgrade.json"))).toBe(false);
      expect(readdirSync(dir).filter((x) => x.includes(".upgrade-"))).toEqual([]);
    });
  }
});

describe("a failed upgrade leaves the original as it was", () => {
  it("a migration that throws: the copy is gone, the database is byte for byte the same, nothing in backups", () => {
    const dir = current(), before = raw(dir);
    expect(() => upgradeVault(dir, LOCK, { migrations: [...MIGRATIONS, "select no_such_function()"] })).toThrow(UpgradeFailed);
    expect(raw(dir).equals(before)).toBe(true);
    expect(readdirSync(dir).filter((x) => x.includes(".upgrade-"))).toEqual([]);
    expect(preUpgradeBackups(dir)).toEqual([]);
    expect(schemaOf(join(dir, "jobos.db"))).toBe(SCHEMA_VERSION);
  });

  it("a migration that loses rows it did not announce is caught by the check", () => {
    const dir = current(), before = raw(dir);
    expect(() => upgradeVault(dir, LOCK, { migrations: [...MIGRATIONS, "delete from fact"] })).toThrow(/fact：升级前 1 行，升级后 0 行/);
    expect(raw(dir).equals(before)).toBe(true);
  });

  it("a migration that changes the person's rows (same count) is caught", () => {
    const dir = current();
    expect(() => upgradeVault(dir, LOCK, { migrations: [...MIGRATIONS, "update company set name = '别的公司'"] })).toThrow(/company 的内容和升级前对不上/);
  });

  it("an upgrade that passes: new table there, rows kept", () => {
    const dir = current();
    const r = upgradeVault(dir, LOCK, { migrations: [...MIGRATIONS, "create table extra_thing (x text)"] })!;
    expect(r.to).toBe(SCHEMA_VERSION + 1);
    const db = new DatabaseSync(join(dir, "jobos.db"), { readOnly: true });
    expect((db.prepare("select count(*) as n from fact").get() as any).n).toBe(1);
    db.close();
  });

  it("killed after the copy, before the switch: the next start removes the leftover copy", () => {
    const dir = current(), before = raw(dir);
    expect(() => upgradeVault(dir, LOCK, { migrations: [...MIGRATIONS, "create table x2 (x)"], failAfterCopy: () => { throw new Error("killed"); } })).toThrow();
    // what a kill would have left: a copy and no record
    copyFileSync(join(dir, "jobos.db"), join(dir, "jobos.db.upgrade-abc"));
    expect(recoverUpgrade(dir)).toBe("none");
    expect(existsSync(join(dir, "jobos.db.upgrade-abc"))).toBe(false);
    expect(raw(dir).equals(before)).toBe(true);
  });
});

describe("an upgrade cut short during the switch comes back to one state", () => {
  function staged(): { dir: string; cand: string; backup: string } {
    const dir = current();
    const cand = join(dir, "jobos.db.upgrade-k1"), backup = join(dir, "backups", "pre-v35-v36-2026-10-14T00-00-00-000Z.db");
    copyFileSync(join(dir, "jobos.db"), cand);
    const c = new DatabaseSync(cand); migrate(c, [...MIGRATIONS, "create table x3 (x)"]); c.close();
    writeFileSync(join(dir, "upgrade.json"), JSON.stringify({ id: "k1", candidate: cand, backup, at: "" }));
    return { dir, cand, backup };
  }
  it("record written, nothing renamed yet: the copy goes, the original stays", () => {
    const { dir, cand } = staged(), before = raw(dir);
    expect(recoverUpgrade(dir)).toBe("undone");
    expect(existsSync(cand)).toBe(false);
    expect(raw(dir).equals(before)).toBe(true);
    expect(existsSync(join(dir, "upgrade.json"))).toBe(false);
  });
  it("original moved to backups, copy not yet in place: the copy is put in place", () => {
    const { dir, cand, backup } = staged();
    renameSync(join(dir, "jobos.db"), backup);
    expect(recoverUpgrade(dir)).toBe("finished");
    expect(schemaOf(join(dir, "jobos.db"))).toBe(SCHEMA_VERSION + 1);
    expect(existsSync(cand)).toBe(false);
  });
  it("both renamed, only the record left: the record goes", () => {
    const { dir, cand, backup } = staged();
    renameSync(join(dir, "jobos.db"), backup); renameSync(cand, join(dir, "jobos.db"));
    expect(recoverUpgrade(dir)).toBe("finished");
    expect(existsSync(join(dir, "upgrade.json"))).toBe(false);
  });
  it("a state it cannot read: refuses and touches nothing", () => {
    const { dir, cand, backup } = staged();
    renameSync(join(dir, "jobos.db"), backup); renameSync(backup, join(dir, "elsewhere.db")); // original and backup both missing
    expect(() => recoverUpgrade(dir)).toThrow(/认不出来/);
    expect(existsSync(cand)).toBe(true);
  });
});

describe("versions", () => {
  it("a database newer than the program is refused before anything is written", () => {
    const dir = current();
    const db = new DatabaseSync(join(dir, "jobos.db")); db.exec("pragma wal_checkpoint(TRUNCATE)"); db.prepare("insert into schema_version(v) values (?)").run(SCHEMA_VERSION + 1); db.close();
    const before = raw(dir);
    expect(() => openDb(join(dir, "jobos.db"))).toThrow(SchemaMismatch);
    expect(() => upgradeVault(dir, LOCK)).toThrow(/更新的版本/);
    expect(raw(dir).equals(before)).toBe(true);
  });
  it("a hole in the version record is refused", () => {
    const dir = current();
    const db = new DatabaseSync(join(dir, "jobos.db")); db.prepare("delete from schema_version where v = 3").run(); db.close();
    expect(() => openDb(join(dir, "jobos.db"))).toThrow(/不连续/);
  });
});

describe("rollback", () => {
  it("puts the pre-upgrade database back (a copy; the backup stays) and keeps the one it replaces", () => {
    const dir = current(), before = raw(dir);
    const up = upgradeVault(dir, LOCK, { migrations: [...MIGRATIONS, "create table x4 (x)"] })!;
    const r = rollbackVault(dir, LOCK);
    expect(r.restored).toBe(up.backup);
    expect(raw(dir).equals(before)).toBe(true);
    expect(existsSync(up.backup)).toBe(true);
    expect(schemaOf(r.kept)).toBe(SCHEMA_VERSION + 1);
    expect(r.manifest.fromSchema).toBe(SCHEMA_VERSION);
  });
  it("refuses a backup that does not match its manifest", () => {
    const dir = current();
    const up = upgradeVault(dir, LOCK, { migrations: [...MIGRATIONS, "create table x5 (x)"] })!;
    const db = new DatabaseSync(up.backup); db.exec("pragma journal_mode = delete; create table tampered (x)"); db.close();
    const live = raw(dir);
    expect(() => rollbackVault(dir, LOCK)).toThrow(/对不上/);
    expect(raw(dir).equals(live)).toBe(true);
  });
});

describe("pre-upgrade backups kept", () => {
  it("the newest three and the oldest", () => {
    const n = (d: number) => `pre-v1-v2-2026-10-${String(d).padStart(2, "0")}T00-00-00-000Z.db`;
    expect(stalePreUpgrade([1, 2, 3, 4, 5, 6].map(n)).sort()).toEqual([n(2), n(3)]);
    expect(stalePreUpgrade([1, 2, 3].map(n))).toEqual([]);
    expect(stalePreUpgrade(["pre-v9-20260918-193937-jobos.db", "jobos.db.pre-v14-20260920-213409"])).toEqual([]); // not ours by this name: never
  });
});
