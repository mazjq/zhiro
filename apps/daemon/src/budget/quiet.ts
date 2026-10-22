/**
 * When heavy background work (a browser, a form, a pool rebuild) must not start on this computer (phase-1 plan v3):
 *   - around a written test, an assessment or an interview on record — online tests are taken full screen, often under a
 *     camera, and a window opening could count as leaving the test: from `before` minutes ahead until `after` minutes
 *     past its start, nothing opens, even minimised;
 *   - while Windows says a full-screen app, a game or a presentation is running (SHQueryUserNotificationState, ~0.1 s
 *     in a running PowerShell; asked at most once a minute, only when such work is about to start).
 * Light work (mail, reminders, notices) is not held back. Nothing is stopped half way.
 */
import { spawn } from "node:child_process";
import { constants, setPriority } from "node:os";
import type { Db } from "../db.js";

const QUIET_KINDS = new Set(["笔试", "测评", "面试", "一面", "二面", "三面", "终面", "HR面", "群面", "电话面"]);
const hm = (ms: number) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });

/** A test or interview whose quiet span holds `now`, said in a line; null when none. */
export function examQuiet(db: Db, now: number, beforeMins: number, afterMins: number): string | null {
  const from = new Date(now - afterMins * 60_000 - 86400_000).toISOString().slice(0, 10);
  const rows = db.prepare("select kind, scheduled_at from stage where scheduled_at >= ? and (result is null or result = '')").all(from) as { kind: string; scheduled_at: string }[];
  for (const r of rows) {
    const at = Date.parse(r.scheduled_at);
    if (!Number.isFinite(at) || !(QUIET_KINDS.has(r.kind) || /面|笔试|测评/.test(r.kind))) continue;
    if (now >= at - beforeMins * 60_000 && now <= at + afterMins * 60_000) return `${r.kind}（${hm(at)} 开始）安静中，到 ${hm(at + afterMins * 60_000)}`;
  }
  return null;
}

const STATE: Record<number, string> = { 2: "有全屏应用在运行", 3: "游戏在全屏运行", 4: "演示模式" };
let cached: { at: number; why: string | null } | null = null;

/** What Windows says of the screen, cached a minute; null elsewhere or when it cannot be asked. */
export function screenBusy(now = Date.now()): Promise<string | null> {
  if (process.platform !== "win32") return Promise.resolve(null);
  if (cached && now - cached.at < 60_000) return Promise.resolve(cached.why);
  const ps = `Add-Type -Namespace Z -Name Q -MemberDefinition '[DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int s);'; $s=0; [void][Z.Q]::SHQueryUserNotificationState([ref]$s); $s`;
  return new Promise((resolve) => {
    let out = "";
    const child = spawn("powershell", ["-NoProfile", "-NonInteractive", "-Command", ps], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const t = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 10_000);
    child.stdout!.on("data", (d) => { out += String(d); });
    child.on("error", () => { clearTimeout(t); resolve(null); });
    child.on("exit", () => { clearTimeout(t); const why = STATE[Number(out.trim())] ?? null; cached = { at: now, why }; resolve(why); });
  });
}

/**
 * A process Zhiro starts for background work runs below normal priority: when the person plays or builds something the
 * system gives them the processor first, and nothing has to be paused for it. ponytail: set right after spawn, so a
 * grandchild started in the first milliseconds keeps normal priority; the application browser is not covered yet.
 */
export function lowerPriority(pid?: number): void {
  if (!pid) return;
  try { setPriority(pid, constants.priority.PRIORITY_BELOW_NORMAL); } catch { /* gone already, or not allowed */ }
}
