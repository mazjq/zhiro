/** ADR-058: moving the data directory — the path stays, the data goes; a move that cannot finish leaves everything where it was. */
import { describe, it, expect } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { closeSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, parse } from "node:path";
import { checkTarget, cancelMove, ensureEntry, locationInfo, readLog, requestMove, resolveVault, VaultUnavailable, type Drive, type MoveLog } from "./move.js";
import { loadConfig } from "./config.js";

/** A data directory with a database (in WAL mode, with a row that holds an absolute path into the directory) and a few files. */
function vault() {
  const base = mkdtempSync(join(tmpdir(), "jobos-move-"));
  const entry = join(base, "vault");
  for (const d of ["config", "resume/library", "backups"]) mkdirSync(join(entry, d), { recursive: true });
  const cv = join(entry, "resume", "library", "简历.pdf");
  writeFileSync(cv, "PDF 内容", "utf8");
  writeFileSync(join(entry, "config", ".daemon-token"), "TOKEN", "utf8");
  const db = new DatabaseSync(join(entry, "jobos.db"));
  db.exec("pragma journal_mode = wal; create table resume(file_path text); ");
  db.prepare("insert into resume values (?)").run(cv);
  db.close();
  const ok: Drive[] = [{ root: parse(base).root, label: "", freeBytes: 1e12 }];
  return { base, entry, cv, ok, to: join(base, "新位置") };
}
const quiet = () => {};
const log = (entry: string) => readLog(entry)!;
const isLink = (p: string) => { try { return lstatSync(p).isSymbolicLink(); } catch { return false; } };
const writeLog = (entry: string, l: Partial<MoveLog>) => writeFileSync(`${entry}.move.json`, JSON.stringify({ at: "", ...l }), "utf8");

describe("moving the data directory", () => {
  it("copies, compares, switches: the old path leads to the new place and the absolute paths in the database still open", async () => {
    const v = vault();
    requestMove(v.entry, v.to, v.ok);
    expect((await locationInfo(v.entry, v.ok)).pending).toBe(v.to);
    await resolveVault(v.entry, quiet, v.ok);
    const l = log(v.entry);
    expect(l.phase).toBe("done");
    expect(isLink(v.entry)).toBe(true);
    expect(realpathSync(v.entry).toLowerCase()).toBe(realpathSync(v.to).toLowerCase());
    // the path the database remembers is the old one; it reads the file at the new place
    const db = new DatabaseSync(join(v.entry, "jobos.db"));
    const stored = (db.prepare("select file_path from resume").get() as any).file_path as string;
    db.close();
    expect(stored).toBe(v.cv);
    expect(readFileSync(stored, "utf8")).toBe("PDF 内容");
    expect(readFileSync(join(v.to, "resume", "library", "简历.pdf"), "utf8")).toBe("PDF 内容");
    // the old copy is kept, whole, for the person to delete; the mark of the move is gone
    expect(readFileSync(join(l.old!, "config", ".daemon-token"), "utf8")).toBe("TOKEN");
    expect(readdirSync(v.to).some((f) => f.startsWith(".jobos-move-"))).toBe(false);
    const info = (await locationInfo(v.entry, v.ok));
    expect(info.old?.path).toBe(l.old);
    expect(info.pending).toBeNull();
    expect(() => loadConfig(v.entry)).not.toThrow();
  });

  it("refuses a target that is not an empty plain folder on a built-in disk, outside the data", () => {
    const v = vault();
    const need = 10;
    expect(checkTarget(v.entry, "相对路径", need, v.ok)).toMatch(/完整路径/);
    expect(checkTarget(v.entry, parse(v.base).root, need, v.ok)).toMatch(/整个盘/);
    expect(checkTarget(v.entry, join(v.entry, "里面"), need, v.ok)).toMatch(/里面/);
    expect(checkTarget(v.entry, v.base, need, v.ok)).toMatch(/已经有东西|包住/);
    mkdirSync(v.to); writeFileSync(join(v.to, "别人的文件.txt"), "x", "utf8");
    expect(checkTarget(v.entry, v.to, need, v.ok)).toMatch(/已经有东西/);
    const link = join(v.base, "link");
    symlinkSync(v.entry, link, "junction");
    expect(checkTarget(v.entry, link, need, v.ok)).toMatch(/普通的空文件夹/);
    expect(checkTarget(v.entry, join(link, "子目录"), need, v.ok)).toMatch(/里面/); // by where it really is
    expect(checkTarget(v.entry, join(v.base, "空的"), 1e15, v.ok)).toMatch(/空间不够/);
    if (process.platform === "win32") expect(checkTarget(v.entry, join(v.base, "空的"), need, [])).toMatch(/机内硬盘/);
    expect(checkTarget(v.entry, join(v.base, "空的"), need, v.ok)).toBeNull();
    expect(() => requestMove(v.entry, v.to, v.ok)).toThrow(/BAD_TARGET/);
    expect(readLog(v.entry)).toBeNull();
  });

  it("a file that came out different stops the move: the target is removed, the data stays where it was", async () => {
    const v = vault();
    requestMove(v.entry, v.to, v.ok);
    // the copy is done when this is said; change one byte's worth before the comparison
    await resolveVault(v.entry, (m) => { if (m.includes("比对")) writeFileSync(join(v.to, "resume", "library", "简历.pdf"), "PDF 内害", "utf8"); }, v.ok);
    expect(log(v.entry).phase).toBe("failed");
    expect(log(v.entry).error).toMatch(/内容不一样/);
    expect(existsSync(v.to)).toBe(false);
    expect(isLink(v.entry)).toBe(false);
    expect(readFileSync(v.cv, "utf8")).toBe("PDF 内容");
    expect((await locationInfo(v.entry, v.ok)).lastError).toMatch(/不一致/);
    expect(() => loadConfig(v.entry)).not.toThrow();
  });

  it.runIf(process.platform === "win32")("a file held open inside the data stops the move before anything is copied", async () => {
    const v = vault();
    requestMove(v.entry, v.to, v.ok);
    const fd = openSync(v.cv, "r");
    try { await resolveVault(v.entry, quiet, v.ok); } finally { closeSync(fd); }
    expect(log(v.entry).phase).toBe("failed");
    expect(log(v.entry).error).toMatch(/正被别的程序开着/);
    expect(existsSync(v.to)).toBe(false);
    expect(existsSync(v.cv)).toBe(true);
  });

  it("cut short before the switch: the half copy goes (only one it marked), the data never moved", async () => {
    const v = vault();
    mkdirSync(v.to); writeFileSync(join(v.to, ".jobos-move-abc"), "", "utf8"); writeFileSync(join(v.to, "jobos.db"), "half", "utf8");
    writeLog(v.entry, { id: "abc", entry: v.entry, from: realpathSync(v.entry), to: v.to, phase: "copying" });
    await resolveVault(v.entry, quiet, v.ok);
    expect(log(v.entry).phase).toBe("failed");
    expect(existsSync(v.to)).toBe(false);
    expect(readFileSync(v.cv, "utf8")).toBe("PDF 内容");
    // a target without this move's mark is somebody else's folder: left alone
    const other = join(v.base, "别人的");
    mkdirSync(other); writeFileSync(join(other, "keep.txt"), "x", "utf8");
    writeLog(v.entry, { id: "xyz", entry: v.entry, from: realpathSync(v.entry), to: other, phase: "verified" });
    await resolveVault(v.entry, quiet, v.ok);
    expect(readFileSync(join(other, "keep.txt"), "utf8")).toBe("x");
  });

  it("cut short inside the switch: finished when the entry was already taken away, undone when it was not", async () => {
    // the entry was renamed, the link not made yet; the target had passed its checks
    const a = vault();
    requestMove(a.entry, a.to, a.ok);
    await resolveVault(a.entry, quiet, a.ok);
    const done = log(a.entry);
    rmSync(a.entry); // the link only
    writeFileSync(join(a.to, `.jobos-move-${done.id}`), "", "utf8");
    writeLog(a.entry, { ...done, phase: "switched" });
    expect(() => ensureEntry(a.entry)).toThrow(VaultUnavailable); // any other entry point waits for a daemon start
    await resolveVault(a.entry, quiet, a.ok);
    expect(log(a.entry).phase).toBe("done");
    expect(readFileSync(a.cv, "utf8")).toBe("PDF 内容");

    // the intent was written but nothing was switched
    const b = vault();
    mkdirSync(b.to); writeFileSync(join(b.to, ".jobos-move-abc"), "", "utf8");
    writeLog(b.entry, { id: "abc", entry: b.entry, from: realpathSync(b.entry), to: b.to, phase: "switched", old: `${b.entry}.old-abc` });
    await resolveVault(b.entry, quiet, b.ok);
    expect(log(b.entry).phase).toBe("failed");
    expect(existsSync(b.to)).toBe(false);
    expect(isLink(b.entry)).toBe(false);
    expect(readFileSync(b.cv, "utf8")).toBe("PDF 内容");
  });

  it("after a move: a deleted entry is linked again; data that cannot be reached is never replaced by an empty directory", async () => {
    const v = vault();
    requestMove(v.entry, v.to, v.ok);
    await resolveVault(v.entry, quiet, v.ok);
    rmSync(v.entry); // deleted in the file manager: only the link goes
    expect(existsSync(join(v.to, "jobos.db"))).toBe(true);
    loadConfig(v.entry);
    expect(isLink(v.entry)).toBe(true);
    expect(readFileSync(v.cv, "utf8")).toBe("PDF 内容");
    // the disk is gone (here: the folder renamed away) — with the link dangling, and with the link deleted too
    renameSync(v.to, v.to + "-拔掉了");
    expect(() => loadConfig(v.entry)).toThrow(VaultUnavailable);
    rmSync(v.entry);
    expect(() => loadConfig(v.entry)).toThrow(VaultUnavailable);
    expect(existsSync(v.entry)).toBe(false);
    // an empty folder something made where the link should be is replaced once the data is back
    renameSync(v.to + "-拔掉了", v.to);
    mkdirSync(v.entry);
    loadConfig(v.entry);
    expect(isLink(v.entry)).toBe(true);
  });

  it("a second move waits until the old copy of the first is gone, then moves the link", async () => {
    const v = vault();
    requestMove(v.entry, v.to, v.ok);
    await resolveVault(v.entry, quiet, v.ok);
    const first = log(v.entry);
    const to2 = join(v.base, "第二个位置");
    expect(() => requestMove(v.entry, to2, v.ok)).toThrow(/旧的一份还在/);
    expect(log(v.entry).phase).toBe("done");
    rmSync(first.old!, { recursive: true, force: true });
    requestMove(v.entry, to2, v.ok);
    cancelMove(v.entry);
    expect((await locationInfo(v.entry, v.ok)).pending).toBeNull();
    expect((await locationInfo(v.entry, v.ok)).lastError).toBe("");
    expect(() => loadConfig(v.entry)).not.toThrow(); // still at the first place
    requestMove(v.entry, to2, v.ok);
    await resolveVault(v.entry, quiet, v.ok);
    expect(log(v.entry).phase).toBe("done");
    expect(realpathSync(v.entry).toLowerCase()).toBe(realpathSync(to2).toLowerCase());
    expect(log(v.entry).old?.toLowerCase()).toBe(realpathSync(v.to).toLowerCase()); // the first place is now the old copy
    expect(readFileSync(v.cv, "utf8")).toBe("PDF 内容");
  });
});
