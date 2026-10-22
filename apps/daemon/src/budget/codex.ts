/**
 * Codex's allowance, read from `codex app-server` (`account/rateLimits/read`): no model call, ~2 s. The windows are
 * whatever the plan has — a week only on some plans, five hours and a week on others — so they are taken as given
 * (`primary` / `secondary`, each with its own length), never assumed. Measured 2026-10-22 on Codex 0.154.
 */
import { spawn } from "node:child_process";
import type { Reading } from "./index.js";

type Launcher = { cmd: string; args: string[] } | null;

/** The readings, or null when Codex is not installed, not logged in, too old to answer, or slow. */
export function readCodexLimits(launcher: Launcher, timeoutMs = 15_000): Promise<Reading[] | null> {
  if (!launcher) return Promise.resolve(null);
  return new Promise((resolve) => {
    let done = false, buf = "";
    const child = spawn(launcher.cmd, [...launcher.args, "app-server"], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, shell: false });
    const end = (v: Reading[] | null) => { if (done) return; done = true; clearTimeout(t); try { child.kill(); } catch { /* gone */ } resolve(v); };
    const t = setTimeout(() => end(null), timeoutMs);
    child.on("error", () => end(null));
    child.on("exit", () => end(null));
    child.stdout!.on("data", (d) => {
      buf += String(d);
      for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
        const line = buf.slice(0, i); buf = buf.slice(i + 1);
        let m: any; try { m = JSON.parse(line); } catch { continue; }
        if (m.id === 1) { send({ jsonrpc: "2.0", method: "initialized" }); send({ jsonrpc: "2.0", id: 2, method: "account/rateLimits/read" }); }
        if (m.id === 2) end(m.result ? codexReadings(m.result) : null);
      }
    });
    const send = (o: unknown) => { try { child.stdin!.write(JSON.stringify(o) + "\n"); } catch { end(null); } };
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { clientInfo: { name: "zhiro", version: "0" } } });
  });
}

/** `account/rateLimits/read`'s answer as readings (exported for tests). */
export function codexReadings(result: any, at = new Date().toISOString()): Reading[] {
  const rl = result?.rateLimits ?? {};
  return (["primary", "secondary"] as const).flatMap((k) => {
    const w = rl[k];
    if (!w || typeof w.usedPercent !== "number") return [];
    return [{ channel: "codex" as const, win: `${k}:${w.windowDurationMins ?? ""}`, used: w.usedPercent / 100, resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null, durationMins: w.windowDurationMins ?? null, at }];
  });
}
