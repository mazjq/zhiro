/**
 * The environment variables were named JOBOS_* before the rename (ADR-053). The code still reads the old names; a
 * ZHIRO_* one, when set, fills its JOBOS_* twin. Imported first by every entry point. ZHIRO_DATA is datadir.ts's own.
 */
import { execFileSync } from "node:child_process";

for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("ZHIRO_") || v === undefined || k === "ZHIRO_DATA") continue;
  const old = `JOBOS_${k.slice(6)}`;
  if (process.env[old] === undefined) process.env[old] = v;
}

/** Windows zones newer than the time-zone table Node carries, by the zone they are. */
const NEWER_ZONES: Record<string, string> = {
  "Alberta Standard Time": "America/Edmonton", // Windows 2026: Alberta on UTC-6 all year from March 2026
};

/**
 * The zone to run in when Node cannot name the computer's own (a Windows zone newer than its table): the known one,
 * else the computer's offset right now. `activeBias` is Windows' minutes from local time to UTC (360 = UTC-6).
 * ponytail: the offset fallback is fixed until the next start — a zone whose clocks change mid-run is an hour off
 * until then; add it to NEWER_ZONES when one turns up.
 */
export function zoneFor(windowsId: string, activeBias: number | null): string | null {
  if (NEWER_ZONES[windowsId]) return NEWER_ZONES[windowsId];
  if (activeBias === null || activeBias % 60 !== 0) return null;
  const h = activeBias / 60; // Etc/GMT+6 is UTC-6
  return h === 0 ? "Etc/UTC" : `Etc/GMT${h > 0 ? "+" : "-"}${Math.abs(h)}`;
}

// Node names no zone and falls back to the zone's old base offset — an hour off for Alberta since 2026 (the person's
// computer said 16:49, Zhiro 15:49). Follow the computer: ask Windows which zone it is in.
if (process.platform === "win32" && !process.env.TZ && !Intl.DateTimeFormat().resolvedOptions().timeZone) {
  try {
    const run = (cmd: string, args: string[]) => execFileSync(cmd, args, { encoding: "utf8", windowsHide: true, timeout: 5000 });
    const id = run("tzutil", ["/g"]).trim();
    const bias = /ActiveTimeBias\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(run("reg", ["query", "HKLM\\SYSTEM\\CurrentControlSet\\Control\\TimeZoneInformation", "/v", "ActiveTimeBias"]));
    const raw = bias ? Number.parseInt(bias[1], 16) : null;
    const tz = zoneFor(id, raw === null ? null : raw | 0); // a DWORD: east of UTC is negative
    if (tz) process.env.TZ = tz;
  } catch { /* stay as Node has it */ }
}
