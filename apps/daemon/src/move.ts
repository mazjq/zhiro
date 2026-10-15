/**
 * Moving the data directory to another disk (ADR-058).
 *
 * The directory keeps its address: after a move the old path (the "entry") is a directory junction to the new place.
 * So the absolute paths the database holds (about 146,000 of them on the first real vault), the agent directory the
 * person's harnesses remember, and everything that computes `<vault>/…` go on working, unchanged.
 *
 * The move runs at daemon start, before anything opens the directory: lock, checkpoint, copy, compare every file by
 * hash, and only then switch. A move that cannot be finished leaves the data where it was. The record of where the data
 * is and how far a move got lives *beside* the entry (`<entry>.move.json`), never inside the directory being copied —
 * a record that travelled with the copy would describe the wrong side after the switch.
 *
 * Nothing here deletes the person's data: the old copy stays until they remove it themselves. The only directory this
 * code ever removes is a target it created and marked during a move that did not complete.
 */
import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { closeSync, copyFileSync, existsSync, lstatSync, utimesSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, rmdirSync, statSync, statfsSync, symlinkSync, writeFileSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { lockVault, VaultBusy } from "./lock.js";

export type MovePhase = "requested" | "copying" | "verified" | "switched" | "done" | "failed";
/**
 * `from` is where the data really was when the move was asked for, `to` where it goes. Where the data is now: `to` once
 * the phase is "done", `from` in every other phase but "switched" (which only a start of the daemon resolves).
 * `old`: the copy left behind by a finished move — the person's to delete.
 */
export interface MoveLog { id: string; entry: string; from: string; to: string; phase: MovePhase; old?: string; error?: string; at: string }

/** The data cannot be reached and must not be replaced by an empty directory: the caller says why and exits. */
export class VaultUnavailable extends Error { code = "VAULT_UNAVAILABLE"; }

const logPath = (entry: string) => `${resolve(entry)}.move.json`;
const mark = (log: MoveLog) => join(log.to, `.jobos-move-${log.id}`);
const probeName = (log: MoveLog) => `${resolve(log.entry)}.moving-${log.id}`;
const norm = (p: string) => (process.platform === "win32" ? resolve(p).toLowerCase() : resolve(p));
const same = (a: string, b: string) => norm(a) === norm(b);
const within = (dir: string, p: string) => { const r = relative(norm(dir), norm(p)); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const real = (p: string) => { try { return realpathSync(p); } catch { return resolve(p); } };
const gb = (n: number) => `${(n / 1e9).toFixed(1)} GB`;
const codeOf = (e: any) => String(e?.code ?? e?.message ?? e).split("\n")[0].slice(0, 120);

export function readLog(entry: string): MoveLog | null {
  let text: string;
  try { text = readFileSync(logPath(entry), "utf8"); } catch { return null; }
  try { return JSON.parse(text) as MoveLog; }
  catch { throw new VaultUnavailable(`搬数据的记录读不出来：${logPath(entry)}。它记着数据现在在哪，Zhiro 不会在读不出来的时候猜`); }
}

function writeLog(entry: string, log: MoveLog): MoveLog {
  const p = logPath(entry), next = { ...log, at: new Date().toISOString() };
  writeFileSync(p + ".tmp", JSON.stringify(next, null, 2), "utf8");
  renameSync(p + ".tmp", p);
  return next;
}

/** Every file under a directory with its size, by relative path. A link is listed, never followed. */
function files(root: string): Map<string, number> {
  const out = new Map<string, number>();
  const walk = (dir: string, rel: string) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (e.isDirectory()) walk(join(dir, e.name), r);
      else out.set(r, e.isFile() ? statSync(join(dir, e.name)).size : -1);
    }
  };
  walk(root, "");
  return out;
}

/**
 * Folders and plain files, one by one, with their times. Not `fs.cpSync`: on Node 22.14 it ends the process without an
 * error or an exit code when the destination already exists directly under a drive root — which is exactly
 * a data folder on a second disk with this move's mark in it (the first real move died that way, 2026-10-13; the data
 * was untouched).
 * A link inside the data directory is refused rather than guessed at (the real one has none).
 */
function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true });
  for (const e of readdirSync(from, { withFileTypes: true })) {
    const a = join(from, e.name), b = join(to, e.name);
    if (e.isDirectory()) copyTree(a, b);
    else if (e.isFile()) { copyFileSync(a, b); const st = statSync(a); utimesSync(b, st.atime, st.mtime); }
    else throw new Error(`数据文件夹里有一个不是普通文件的东西，没法照原样复制：${a}`);
  }
}

export function dirSize(root: string): number {
  let n = 0;
  try { for (const s of files(root).values()) if (s > 0) n += s; } catch { /* not there */ }
  return n;
}

function sha(path: string): string {
  const h = createHash("sha256"), buf = Buffer.allocUnsafe(1 << 22), fd = openSync(path, "r");
  try { for (let n: number; (n = readSync(fd, buf, 0, buf.length, null)) > 0;) h.update(buf.subarray(0, n)); } finally { closeSync(fd); }
  return h.digest("hex");
}

export interface Drive { root: string; label: string; freeBytes: number }

/**
 * The disks a move may go to: built into the machine and NTFS. Windows reports a USB SSD as a "fixed" volume (seen
 * 2026-10-13), so what counts is the bus of the disk the volume sits on. A disk that can be unplugged would leave the
 * entry pointing at nothing.
 * ponytail: Windows only — elsewhere any writable folder is accepted; a removable-disk check there is the upgrade.
 */
const DRIVES_PS = "Get-Partition | Where-Object DriveLetter | ForEach-Object { $v = Get-Volume -Partition $_; [pscustomobject]@{ letter = [string]$_.DriveLetter; bus = [string](Get-Disk -Number $_.DiskNumber).BusType; fs = [string]$v.FileSystemType; free = [double]$v.SizeRemaining; label = [string]$v.FileSystemLabel } } | ConvertTo-Json -Compress";
const DRIVES_ARGS = ["-NoProfile", "-NonInteractive", "-Command", DRIVES_PS];
const parseDrives = (out: string): Drive[] => ([JSON.parse(out)].flat() as any[]).filter((d) => d.fs === "NTFS" && d.bus !== "USB").map((d) => ({ root: `${d.letter}:\\`, label: d.label ?? "", freeBytes: Number(d.free) || 0 })).sort((x, y) => x.root.localeCompare(y.root));

export function drives(): Drive[] {
  if (process.platform !== "win32") return [];
  try { return parseDrives(execFileSync("powershell", DRIVES_ARGS, { encoding: "utf8", timeout: 20_000, windowsHide: true })); } catch { return []; }
}
/** The same list without holding the daemon's one thread for the second or two PowerShell takes. */
const drivesLater = (): Promise<Drive[]> => new Promise((done) => {
  if (process.platform !== "win32") return done([]);
  execFile("powershell", DRIVES_ARGS, { encoding: "utf8", timeout: 20_000, windowsHide: true }, (err, out) => { try { done(err ? [] : parseDrives(out)); } catch { done([]); } });
});

/** Bytes under a directory, read without blocking (13,000 files take two seconds; the settings page asks every time it opens). */
async function sizeLater(root: string): Promise<number> {
  let n = 0;
  try {
    const all = (await readdir(root, { recursive: true, withFileTypes: true })).filter((e) => e.isFile());
    for (let i = 0; i < all.length; i += 256) for (const s of await Promise.all(all.slice(i, i + 256).map((e) => stat(join(e.parentPath, e.name)).then((x) => x.size, () => 0)))) n += s;
  } catch { /* not there */ }
  return n;
}

/** Why the data cannot go to `to`, or null when it can. `need`: bytes to be copied. */
export function checkTarget(entry: string, to: string, need: number, ok: Drive[] = drives()): string | null {
  if (!isAbsolute(to)) return "要写完整路径，例如 E:\\Zhiro数据";
  const parent = dirname(resolve(to));
  if (same(parent, to)) return "不能直接用整个盘，写一个文件夹，例如 E:\\Zhiro数据";
  if (!existsSync(parent)) return `上一级文件夹不存在：${parent}`;
  if (isLink(to)) return "目标要是一个普通的空文件夹，或者还不存在";
  if (existsSync(to)) {
    if (!lstatSync(to).isDirectory()) return "目标要是一个普通的空文件夹，或者还不存在";
    if (readdirSync(to).length) return "目标文件夹里已经有东西了，换一个空的";
  }
  const target = join(real(parent), basename(resolve(to)));
  const log = readLog(entry);
  for (const p of [real(entry), resolve(entry), ...(log?.old ? [log.old] : [])]) if (within(p, target) || within(target, p)) return "目标不能在现在的数据文件夹里面，也不能包住它";
  if (log?.old && existsSync(log.old)) return `上次搬家留下的旧的一份还在：${log.old}。确认不要了，先把它删掉再搬`;
  if (process.platform === "win32" && !ok.some((d) => norm(target).startsWith(norm(d.root)))) return "只能搬到机内硬盘（NTFS 格式，不是 USB 移动硬盘）";
  let free = 0;
  try { const s = statfsSync(real(parent)); free = Number(s.bavail) * Number(s.bsize); } catch (e) { return `读不到那个盘的剩余空间：${codeOf(e)}`; }
  if (free < need * 1.1) return `那个盘剩余空间不够：要 ${gb(need * 1.1)}，只剩 ${gb(free)}`;
  try { const probe = join(real(parent), `.jobos-probe-${randomBytes(4).toString("hex")}`); mkdirSync(probe); rmdirSync(probe); } catch (e) { return `那个位置写不进去：${codeOf(e)}`; }
  return null;
}

/** Record that the data should move to `to` at the next start. Throws with the reason when it cannot. */
export function requestMove(entry: string, to: string, ok?: Drive[]): MoveLog {
  const from = real(entry);
  const why = checkTarget(entry, to, dirSize(from), ok);
  if (why) throw new Error(`BAD_TARGET: ${why}`);
  return writeLog(entry, { id: randomBytes(6).toString("hex"), entry: resolve(entry), from, to: resolve(to), phase: "requested", at: "" });
}

/** Take back a move that has not started. */
export function cancelMove(entry: string): void {
  const log = readLog(entry);
  if (log?.phase === "requested") writeLog(entry, { ...log, phase: "failed", error: "" });
}

/** Remove a target this move created (it carries this move's mark). Anything else is left alone. */
function dropTarget(log: MoveLog): void {
  if (existsSync(mark(log))) rmSync(log.to, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}

/**
 * Called by `loadConfig` before it creates anything: when a move record says the data lives somewhere, the entry must
 * lead there. A missing entry is linked again; data that cannot be reached stops the start — an empty directory is
 * never made in its place.
 */
export function ensureEntry(entry: string): void {
  const log = readLog(entry);
  if (!log) return;
  if (log.phase === "switched") throw new VaultUnavailable("上次搬数据停在了切换那一步：启动一次 Zhiro，它会接着处理");
  const home = log.phase === "done" ? log.to : log.from;
  if (existsSync(entry) && same(real(entry), real(home))) return; // the data itself, or a link to it
  const reachable = existsSync(join(home, "jobos.db"));
  const gone = `数据应该在 ${home}，现在够不着（盘没连上，或者文件夹被移走了）。Zhiro 不会在它的位置新建一份空数据。确实要从头开始的话，删掉 ${logPath(entry)}`;
  if (isLink(entry)) {
    // pointed somewhere else by hand: their call, as long as there is data behind it
    if (existsSync(join(entry, "jobos.db"))) return;
    throw new VaultUnavailable(gone);
  }
  if (!reachable) throw new VaultUnavailable(gone);
  if (existsSync(entry)) {
    // a plain folder where the link should be: only an empty one is ours to replace
    try { rmdirSync(entry); } catch { throw new VaultUnavailable(`数据在 ${home}，但 ${entry} 现在是一个有内容的普通文件夹。Zhiro 不会猜哪一份是对的：把其中一个挪走再启动`); }
  }
  symlinkSync(home, entry, "junction");
}

/**
 * At daemon start, before the directory is opened: carry out a requested move, or tidy up after one that was cut short.
 * Returns normally whenever the data is usable through the entry afterwards (moved or not).
 */
export async function resolveVault(entry: string, say: (m: string) => void = (m) => console.log(`[zhiro] ${m}`), ok?: Drive[]): Promise<void> {
  const log = readLog(entry);
  if (!log) return;
  // the "can it be renamed" probe was cut between its two renames
  if (!existsSync(entry) && !isLink(entry) && existsSync(probeName(log))) renameSync(probeName(log), entry);
  if (log.phase === "requested") return runMove(entry, log, say, ok);
  if (log.phase === "copying" || log.phase === "verified") {
    // cut short before the switch: the data at the entry was never touched
    dropTarget(log);
    writeLog(entry, { ...log, phase: "failed", error: "上次搬到一半被打断了。数据还在原位置，没有丢" });
    return;
  }
  if (log.phase === "switched") settle(entry, log, say);
}

/** The process died somewhere in the switch. The target had passed every check before the switch began. */
function settle(entry: string, log: MoveLog, say: (m: string) => void): void {
  const done = () => { rmSync(mark(log), { force: true }); writeLog(entry, { ...log, phase: "done" }); say(`数据已在 ${log.to}`); };
  const failed = () => { writeLog(entry, { ...log, phase: "failed", old: undefined, error: "上次搬到最后一步被打断了。数据还在原位置，没有丢" }); };
  if (existsSync(entry) && same(real(entry), real(log.to))) return done();
  if (existsSync(entry) || isLink(entry)) { dropTarget(log); return failed(); } // the entry is still what it was
  // the entry was taken away and the link not made yet
  if (existsSync(join(log.to, "jobos.db")) && existsSync(mark(log))) { symlinkSync(log.to, entry, "junction"); return done(); }
  const firstMove = !!log.old && same(dirname(log.old), dirname(resolve(entry)));
  if (firstMove && existsSync(log.old!)) { renameSync(log.old!, entry); return failed(); }
  if (!firstMove && existsSync(join(log.from, "jobos.db"))) { symlinkSync(log.from, entry, "junction"); return failed(); }
  throw new VaultUnavailable(`上次搬数据停在了切换那一步，两边都够不着：${log.from}、${log.to}`);
}

async function runMove(entry: string, start: MoveLog, say: (m: string) => void, ok?: Drive[]): Promise<void> {
  let log = start;
  const fail = (why: string) => { writeLog(entry, { ...log, phase: "failed", old: undefined, error: why }); say(`数据没有搬：${why}`); };
  let lock: { release(): void | Promise<void> };
  try { lock = await lockVault(log.from, "搬数据"); }
  catch (e) { return fail(e instanceof VaultBusy ? e.message : `拿不到数据目录的锁：${codeOf(e)}`); }
  try {
    const need = dirSize(log.from);
    const why = checkTarget(entry, log.to, need, ok); // again: things may have changed since it was asked for
    if (why) return fail(why);
    // everything written so far goes into the main database file, and the file is sound before it is copied
    const dbFile = join(log.from, "jobos.db");
    if (existsSync(dbFile)) {
      const db = new DatabaseSync(dbFile);
      try {
        if ((db.prepare("pragma wal_checkpoint(truncate)").get() as any)?.busy) return fail("数据库正被别的程序用着");
        const r = db.prepare("pragma integrity_check").all() as any[];
        if (r.length !== 1 || r[0].integrity_check !== "ok") return fail(`数据库自检没通过（和搬家无关，原位置的库本身有问题）：${r.map((x) => x.integrity_check).join("; ").slice(0, 200)}`);
      } finally { db.close(); }
    }
    // a file or folder inside that some program holds open shows up here, before anything is copied
    if (!isLink(entry)) {
      try { renameSync(entry, probeName(log)); } catch (e) { return fail(`数据文件夹正被别的程序开着（${codeOf(e)}）。关掉在里面打开的 Claude Code / Codex 窗口和 Zhiro 打开的网申浏览器，再试`); }
      try { renameSync(probeName(log), entry); } catch (e) { throw new VaultUnavailable(`没能把数据文件夹改回原名（${codeOf(e)}）：手工把 ${probeName(log)} 改名为 ${entry} 再启动`); }
    }
    mkdirSync(log.to, { recursive: true });
    writeFileSync(mark(log), "", "utf8");
    log = writeLog(entry, { ...log, phase: "copying" });
    say(`正在把数据（${gb(need)}）复制到 ${log.to} …`);
    try { copyTree(log.from, log.to); }
    catch (e) { dropTarget(log); return fail(`复制时出错：${codeOf(e)}`); }
    say("复制完了，正在逐个文件比对 …");
    const a = files(log.from), b = files(log.to);
    b.delete(basename(mark(log)));
    let bad = a.size !== b.size ? `文件个数不一样（${a.size} / ${b.size}）` : "";
    for (const [rel, size] of a) {
      if (bad) break;
      if (b.get(rel) !== size) bad = `大小不一样：${rel}`;
      else if (size >= 0 && sha(join(log.from, rel)) !== sha(join(log.to, rel))) bad = `内容不一样：${rel}`;
    }
    if (bad) { dropTarget(log); return fail(`复制出来的和原来的不一致（${bad}）。可能有程序在复制期间改了文件`); }
    log = writeLog(entry, { ...log, phase: "verified" });
    // the switch: the intent is on record first, so a start after a crash in here knows exactly what to finish or undo
    const linked = isLink(entry);
    const old = linked ? log.from : `${resolve(entry)}.old-${log.id}`;
    log = writeLog(entry, { ...log, phase: "switched", old });
    try {
      if (linked) rmSync(entry); else renameSync(entry, old);
      symlinkSync(log.to, entry, "junction");
    } catch (e) {
      try { if (!existsSync(entry) && !isLink(entry)) { if (linked) symlinkSync(log.from, entry, "junction"); else renameSync(old, entry); } }
      catch { throw new VaultUnavailable(`切换到一半出错（${codeOf(e)}），也没能恢复原状。数据完好，在 ${linked ? log.from : old}：${linked ? `在 ${entry} 重建指向它的目录联接` : `手工把它改名为 ${entry}`} 再启动`); }
      dropTarget(log);
      return fail(`切换时出错（${codeOf(e)}）。多半是数据文件夹刚被别的程序打开了：关掉再试`);
    }
    rmSync(mark(log), { force: true });
    writeLog(entry, { ...log, phase: "done" });
    say(`数据已搬到 ${log.to}（${a.size} 个文件逐个核对一致）。旧的一份留在 ${old}，确认没问题后由你自己删`);
  } finally { await lock.release(); }
}

/** For the settings page: where the data is, how big, what the disk has left, where it could go, and how a move stands. */
export async function locationInfo(entry: string, ok?: Drive[]) {
  const log = readLog(entry), path = real(entry);
  let freeBytes = 0;
  try { const s = statfsSync(path); freeBytes = Number(s.bavail) * Number(s.bsize); } catch { /* unknown */ }
  const oldPath = log?.phase === "done" && log.old && existsSync(log.old) ? log.old : null;
  const [bytes, backupsBytes, oldBytes, list] = await Promise.all([sizeLater(path), sizeLater(join(path, "backups")), oldPath ? sizeLater(oldPath) : 0, ok ?? drivesLater()]);
  return {
    entry: resolve(entry), path, bytes, backupsBytes, freeBytes, drives: list,
    pending: log?.phase === "requested" ? log.to : null,
    lastError: log?.phase === "failed" ? log.error ?? "" : "",
    old: oldPath ? { path: oldPath, bytes: oldBytes } : null,
  };
}
