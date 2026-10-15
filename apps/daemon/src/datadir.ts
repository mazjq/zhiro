/**
 * Where the data directory is (ADR-051). One answer per process, the same for the daemon, `zhiro mcp`, `data` and
 * `vault`; computed once and kept.
 *
 *   1. `--data <dir>` on the command line
 *   2. ZHIRO_DATA (the old JOBOS_VAULT still works)
 *   3. the pointer file the first start wrote (`zhiro/data-dir` in the system's config folder — not inside the data,
 *      so a move never carries it away)
 *   4. the old JobOS location, if anything is there — a folder, a link (even one whose disk is not connected right now),
 *      or a move record beside it: people who had JobOS keep their data where it is
 *   5. the platform's usual place for app data
 *
 * Nothing here falls back past a place that should hold data: a pointer that leads nowhere, or an old location whose
 * disk is away, stops the start with the reason (move.ts makes the same promise) rather than opening an empty directory
 * somewhere else and making the person's data look gone.
 */
import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { VaultUnavailable } from "./move.js";

export type DataDirSource = "arg" | "env" | "pointer" | "legacy" | "default";
export interface DataDir { dir: string; source: DataDirSource }
interface Where { argv: string[]; env: NodeJS.ProcessEnv; platform: NodeJS.Platform; home: string }

const here = (): Where => ({ argv: process.argv, env: process.env, platform: process.platform, home: homedir() });

/** The system's folder for the program's own settings (where the pointer lives). */
export function configHome(w: Where = here()): string {
  if (w.platform === "win32") return join(w.env.APPDATA ?? join(w.home, "AppData", "Roaming"), "Zhiro");
  if (w.platform === "darwin") return join(w.home, "Library", "Preferences", "Zhiro");
  return join(w.env.XDG_CONFIG_HOME || join(w.home, ".config"), "zhiro");
}
export const pointerFile = (w: Where = here()): string => join(configHome(w), "data-dir");

/** Where JobOS kept the data before the rename. */
export function legacyDir(w: Where = here()): string {
  if (w.platform === "win32") return join(w.env.APPDATA ?? join(w.home, "AppData", "Roaming"), "JobOS", "vault");
  if (w.platform === "darwin") return join(w.home, "Library", "Application Support", "JobOS", "vault");
  return join(w.home, ".local", "share", "jobos", "vault");
}

/** The platform's usual place for a new person's data. */
export function defaultDir(w: Where = here()): string {
  if (w.platform === "win32") return join(w.env.APPDATA ?? join(w.home, "AppData", "Roaming"), "Zhiro", "data");
  if (w.platform === "darwin") return join(w.home, "Library", "Application Support", "Zhiro");
  return join(w.env.XDG_DATA_HOME || join(w.home, ".local", "share"), "zhiro");
}

/** `--data <dir>` or `--data=<dir>`. */
function argOf(argv: string[]): string | undefined {
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--data") return argv[i + 1];
    if (argv[i].startsWith("--data=")) return argv[i].slice(7);
  }
  return undefined;
}

/** Is anything at this path — a folder, a file, or a link whose target is missing (lstat sees the link itself)? */
const present = (p: string) => { try { lstatSync(p); return true; } catch { return false; } };

export function findDataDir(w: Where = here()): DataDir {
  const arg = argOf(w.argv);
  if (arg) return { dir: resolve(arg), source: "arg" };
  const env = w.env.ZHIRO_DATA || w.env.JOBOS_VAULT;
  if (env) {
    if (w.env.ZHIRO_DATA && w.env.JOBOS_VAULT && resolve(w.env.ZHIRO_DATA) !== resolve(w.env.JOBOS_VAULT)) console.warn(`[zhiro] ZHIRO_DATA 和 JOBOS_VAULT 都设了，用 ZHIRO_DATA（${w.env.ZHIRO_DATA}）`);
    return { dir: resolve(env), source: "env" };
  }
  const ptr = pointerFile(w);
  if (existsSync(ptr)) {
    const dir = readFileSync(ptr, "utf8").trim();
    if (!dir) throw new VaultUnavailable(`记着数据位置的文件是空的：${ptr}。删掉它再启动会重新问数据放哪`);
    if (!present(dir)) throw new VaultUnavailable(`数据应该在 ${dir}（记在 ${ptr}），现在找不到（盘没连上，或者文件夹被移走了）。不会在别处新建一份空数据；确实要从头开始的话，删掉 ${ptr}`);
    return { dir, source: "pointer" };
  }
  const old = legacyDir(w);
  if (present(old) || existsSync(`${old}.move.json`)) return { dir: old, source: "legacy" }; // move.ts's ensureEntry stops the start if it cannot be reached
  return { dir: defaultDir(w), source: "default" };
}

let found: DataDir | null = null;
/** The answer for this process (the first call decides). */
export function dataDir(): DataDir { return (found ??= findDataDir()); }
/** Tests, and the first start once the person chose: the answer from here on. */
export function setDataDir(d: DataDir | null): void { found = d; }

/** Remember where the data is: a temporary file, synced, renamed over the old one. */
export function writePointer(dir: string, w: Where = here()): void {
  const p = pointerFile(w);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  const fd = openSync(tmp, "w");
  try { writeSync(fd, resolve(dir) + "\n", null, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, p);
}

/**
 * The first start of a new person (nothing anywhere yet): ask where the data should go when someone is at the terminal;
 * otherwise (an agent installing it) take the usual place and say how to change it.
 */
export async function firstRun(d: DataDir, say: (s: string) => void = console.log): Promise<DataDir> {
  if (d.source !== "default" || existsSync(d.dir)) return d;
  if (!process.stdin.isTTY) {
    say(`[zhiro] 数据放在 ${d.dir}（各平台的惯例位置）。要换：下次加 --data <文件夹> 启动，或在设置页「换个位置」`);
    return d;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`第一次启动：数据存在哪？（直接回车用 ${d.dir}）\n> `)).trim().replace(/^["']|["']$/g, "");
    const dir = answer ? resolve(answer) : d.dir;
    writePointer(dir);
    say(`[zhiro] 数据放在 ${dir}；以后在设置页「换个位置」可以搬`);
    const chosen: DataDir = { dir, source: "pointer" };
    setDataDir(chosen);
    return chosen;
  } finally { rl.close(); }
}
