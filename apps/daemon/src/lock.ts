import net from "node:net";
import { createHash } from "node:crypto";
import { realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * One writing process per data directory. The daemon and the stand-alone `data` command both take this before they
 * touch the database: two writers would pull every subscription twice, and the daemon's pool cache only sees the
 * writes of its own connection.
 *
 * The lock is a listening local endpoint (a named pipe on Windows, a unix socket elsewhere) whose name is derived from
 * the directory. The operating system frees it when the process ends, however it ends — no stale lock file, no PID to
 * second-guess. Whoever is refused is told who holds it.
 */
export class VaultBusy extends Error {
  code = "VAULT_BUSY";
  constructor(public holder: string, vault: string) { super(`数据目录已被${holder || "另一个 Zhiro 进程"}占用：${vault}`); }
}

function endpoint(vault: string): string {
  let dir = vault;
  try { dir = realpathSync(vault); } catch { /* not there yet: its spelling will do */ }
  const key = createHash("sha256").update(process.platform === "win32" ? dir.toLowerCase() : dir).digest("hex").slice(0, 24);
  return process.platform === "win32" ? `\\\\.\\pipe\\jobos-${key}` : join(tmpdir(), `jobos-${key}.sock`);
}

/** Ask the endpoint who is there; "" when nobody answers (a socket file left by a process that was killed). */
function holderOf(path: string): Promise<string | null> {
  return new Promise((done) => {
    const c = net.connect(path);
    let said = "";
    c.setEncoding("utf8");
    c.on("data", (d) => (said += d));
    c.on("end", () => done(said.trim()));
    c.on("error", () => done(null));
    setTimeout(() => { c.destroy(); done(said.trim() || null); }, 1500).unref();
  });
}

export async function lockVault(vault: string, who: string): Promise<{ release(): Promise<void> }> {
  const path = endpoint(vault);
  const label = `${who}（进程 ${process.pid}）`;
  for (let attempt = 0; attempt < 2; attempt++) {
    const server = net.createServer((c) => { c.on("error", () => {}); c.end(label); }); // whoever asked may be gone before the answer: not our problem
    const got = await new Promise<NodeJS.ErrnoException | null>((done) => { server.once("error", done); server.listen(path, () => done(null)); });
    if (!got) { server.unref(); return { release: () => new Promise<void>((done) => server.close(() => done())) }; }
    if (got.code !== "EADDRINUSE") throw got;
    const holder = await holderOf(path);
    if (holder !== null) throw new VaultBusy(holder, vault);
    if (process.platform === "win32") throw new VaultBusy("", vault); // a pipe nobody answers on is still somebody's
    rmSync(path, { force: true }); // a dead process's socket file: clear it and try once more
  }
  throw new VaultBusy("", vault);
}
