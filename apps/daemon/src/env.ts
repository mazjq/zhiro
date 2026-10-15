/**
 * The environment variables were named JOBOS_* before the rename (ADR-053). The code still reads the old names; a
 * ZHIRO_* one, when set, fills its JOBOS_* twin. Imported first by every entry point. ZHIRO_DATA is datadir.ts's own.
 */
for (const [k, v] of Object.entries(process.env)) {
  if (!k.startsWith("ZHIRO_") || v === undefined || k === "ZHIRO_DATA") continue;
  const old = `JOBOS_${k.slice(6)}`;
  if (process.env[old] === undefined) process.env[old] = v;
}
export {};
