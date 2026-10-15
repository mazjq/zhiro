/**
 * `pnpm --filter @zhiro/daemon vault <export|import> <zip>` — the data directory as one zip (ADR-048).
 * export: any time (a consistent snapshot of the live database). import: the daemon must be stopped — this takes the
 * directory's lock and refuses while it is held.
 * `vault backup` — the same backup the settings page makes (ADR-058), for use before an upgrade: any time, beside a
 * running daemon too. It opens the database as it is (no migration), so it is safe to run with newer code checked out.
 * `vault move <folder>` — what 「换个位置」 on the settings page does: note that the data should move there; the daemon
 * carries it out at its next start. `vault move --cancel` takes it back.
 * `vault verify [--quick]` — check the data without changing it (any time). `vault upgrade` — what the daemon does at its
 * start when the program is newer (ADR-050); daemon stopped. `vault rollback [backup]` — put the database from before the
 * last upgrade back; daemon stopped.
 */
import { DatabaseSync } from "node:sqlite";
import { lockVault, VaultBusy } from "../lock.js";
import { defaultVaultDir, dbPath } from "../config.js";
import { openDb } from "../db.js";
import { exportVault, importVault, defaultExportPath } from "../service/export.js";
import { runBackup } from "../service/backup.js";
import { requestMove, cancelMove } from "../move.js";
import { verifyVault, upgradeVault, rollbackVault, preUpgradeBackups } from "../upgrade.js";
import { writePointer, pointerFile } from "../datadir.js";
import { existsSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

const [cmd, arg] = process.argv.slice(2);
const vault = defaultVaultDir();
/** The directory's lock, or a plain refusal: these change the data and the daemon must not be running on it. */
async function locked(who: string) {
  try { return await lockVault(vault, who); }
  catch (e: any) { console.error(e instanceof VaultBusy ? `${e.message}\n先停掉 daemon 再做。` : String(e?.message ?? e)); process.exit(1); }
}

if (cmd === "export") {
  const db = openDb(dbPath(vault));
  const r = exportVault(db, vault, arg ?? defaultExportPath());
  db.close();
  console.log(`exported ${r.path} (${(r.bytes / 1e6).toFixed(1)} MB): ${Object.entries(r.manifest.counts).map(([k, v]) => `${k} ${v}`).join(", ")}; ${r.manifest.files} files`);
} else if (cmd === "verify") {
  const r = verifyVault(vault, { quick: arg === "--quick" });
  console.log(`数据目录 ${vault}：数据库 v${r.schema}，程序 v${r.program}`);
  console.log(Object.entries(r.counts).filter(([, n]) => n).map(([k, n]) => `${k} ${n}`).join(", "));
  console.log(r.ok ? "检查通过" : `有问题：\n- ${r.problems.join("\n- ")}`);
  process.exitCode = r.ok ? 0 : 1;
} else if (cmd === "upgrade" || cmd === "rollback") {
  const lock = await locked(`vault ${cmd}`);
  try {
    if (cmd === "upgrade") {
      const r = upgradeVault(vault, lock, { log: console.log });
      if (!r) console.log("不用升级");
    } else {
      if (!arg) console.log(`升级前的备份：${preUpgradeBackups(vault).join("、") || "（没有）"}；用最新的那份`);
      const r = rollbackVault(vault, lock, arg);
      console.log(`已换回 ${r.restored}（数据库 v${r.manifest.fromSchema}）。换下来的库留在 ${r.kept}`);
      console.log(r.manifest.fromApp ? `这份数据配 ${r.manifest.fromApp}：npm i -g @mazjq/zhiro@${r.manifest.fromApp}` : "这份数据配升级前用的那个版本（它没有记下版本号）；装回那个版本再启动");
    }
  } catch (e: any) { console.error(String(e?.message ?? e)); process.exitCode = 1; }
  finally { await lock.release(); }
} else if (cmd === "import" && arg) {
  const lock = await locked("vault import");
  try {
    const r = importVault(vault, arg, lock);
    console.log(`imported into ${vault}; the previous database is at ${r.backup}`);
    console.log(`before: ${Object.entries(r.before).map(([k, v]) => `${k} ${v}`).join(", ") || "(none)"}`);
    console.log(`after:  ${Object.entries(r.after).map(([k, v]) => `${k} ${v}`).join(", ")}; ${r.files} files; schema v${r.schemaVersion}`);
  } finally { lock.release(); }
} else if (cmd === "backup") {
  const db = new DatabaseSync(dbPath(vault), { readOnly: true });
  try { const r = runBackup(db, vault); console.log(`backup ${r.path} (${(r.bytes / 1e6).toFixed(1)} MB), checked${r.config ? `; config without secrets ${r.config}` : ""}`); }
  catch (e: any) { console.error(String(e?.message ?? e)); process.exitCode = 1; }
  finally { db.close(); }
} else if (cmd === "use" && arg) {
  // remember a data folder for every later start, `zhiro mcp` included (a new one, or data already there)
  const dir = resolve(arg);
  if (existsSync(dir) && readdirSync(dir).length && !existsSync(dbPath(dir))) { console.error(`${dir} 里已经有别的东西，又不是 Zhiro 的数据文件夹：换一个空文件夹`); process.exit(1); }
  writePointer(dir);
  console.log(`以后用 ${dir}（记在 ${pointerFile()}）`);
} else if (cmd === "move" && arg) {
  try {
    if (arg === "--cancel") { cancelMove(vault); console.log("cancelled"); }
    else console.log(`noted: at the next start of the daemon the data moves to ${requestMove(vault, arg).to}`);
  } catch (e: any) { console.error(String(e?.message ?? e)); process.exitCode = 1; }
} else {
  console.error("usage: vault verify [--quick] | vault use <folder> | vault backup | vault upgrade | vault rollback [backup] | vault move <folder> | vault export [file.zip] | vault import <file.zip>");
  process.exit(2);
}
