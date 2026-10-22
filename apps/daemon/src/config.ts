import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import YAML from "yaml";
import { ensureEntry } from "./move.js";
import { dataDir } from "./datadir.js";

export interface JobosConfig {
  vault: string;
  /** S1: started with --maintenance / ZHIRO_MAINTENANCE=1 — read only: no schedules, no tidying, no writes (set at start, never in jobos.yaml) */
  maintenance?: boolean;
  http: { host: string; port: number };
  /** forBackground (ADR-057): the background tidying uses this built-in model instead of the chosen harness; on unless turned off */
  llm: { provider: string; model: string; thinking?: string; forBackground?: boolean };
  feishu: { webhookUrl?: string; appId?: string; appSecret?: string; receiveId?: string; receiveIdType?: string };
  reminders: { daysBefore: number[] };
  /**
   * ADR-025: how much the assistant does without asking (service/tiers.ts); maxWritesPerTurn = ⑤ the bulk threshold.
   * harnessConfirm (ADR-047): where the person's own harness confirms its cards and undoes — in the harness ("harness",
   * default: the agent asks the person in its own chat, then decides) or only in the Zhiro window ("window").
   */
  agent?: { mode?: "default" | "conservative"; maxWritesPerTurn?: number; harnessConfirm?: "harness" | "window"; backend?: "builtin" | "claude" | "codex" | "dsh"; models?: { claude?: string; codex?: string } };
  /** the chat backends that run a harness's command line (ADR-046): per-message budget and limits */
  chat?: { maxBudgetUsd?: number; maxTurns?: number; wallMs?: number; idleMs?: number };
  /** 待补资料 leads the model reads per day (ADR-035); 0 turns the daily job off */
  leads?: { dailyBudget?: number };
  /** pages the browser reads per day for page.read (ADR-038); HTTP reads are not counted */
  pages?: { dailyBudget?: number };
  /** 网申: the person's own 「系统填写」 document (.docx), read at every run and preferred for what it covers (apply-reference.ts) */
  apply?: { referenceDoc?: string };
  /**
   * P5: background model work and the person's allowance. reserve: the share of every window left for the person (0.3);
   * apiDailyUsd: what background work may spend a day on an API key; unknownDailyTokens: a day's background tokens on a
   * subscription whose windows have not been read yet; quietBeforeMins / quietAfterMins: around a written test, an
   * assessment or an interview nothing opens on this computer.
   */
  /** P2b: recruiting mail is filed on its own (a stage added, an application moved) when it is clear; off = confirm cards as before */
  inbox?: { auto?: boolean };
  /** P1: how the notice center may press about an unread notice — sms on unless turned off, a phone call only when turned on */
  notify?: { sms?: boolean; phone?: boolean };
  background?: { reserve?: number; apiDailyUsd?: number; unknownDailyTokens?: number; quietBeforeMins?: number; quietAfterMins?: number };
  /** the application season: applications since this date count against a company's exploration slots (ADR-036) */
  season?: { key?: string; since?: string };
  /** configured data-source instances; see sources/types.ts SourceConfig */
  sources: Array<{ id: string; source: string; name?: string; url?: string; cohort?: string; batch?: string; kind?: string; keywords?: string[]; maxPages?: number; everyHours?: number; enabled?: boolean; auto?: boolean; discover?: boolean }>;
}

const DEFAULTS: JobosConfig = {
  vault: "",
  http: { host: "127.0.0.1", port: 8787 },
  llm: { provider: "openai-codex", model: "gpt-6-astra" },
  feishu: {},
  reminders: { daysBefore: [7, 3, 1] },
  agent: { mode: "default", maxWritesPerTurn: 10, harnessConfirm: "harness", backend: "builtin" },
  sources: [],
};

/** The data directory of this process (datadir.ts: --data, ZHIRO_DATA / JOBOS_VAULT, the remembered choice, the old place, the default). */
export function defaultVaultDir(): string {
  return dataDir().dir;
}

export function loadConfig(vault = defaultVaultDir()): JobosConfig {
  ensureEntry(vault); // moved data (ADR-058): the path must lead to it — never an empty directory made in its place
  for (const d of ["config", "captures", "snapshots", "submissions", "backups", "runs", "profile", "resume/templates", "resume/variants", "research"]) {
    mkdirSync(join(vault, d), { recursive: true });
  }
  const file = configFile(vault);
  let user: Partial<JobosConfig> = {};
  if (existsSync(file)) user = (YAML.parse(readFileSync(file, "utf8")) as Partial<JobosConfig>) ?? {};
  else replaceConfig(vault, { ...DEFAULTS, vault: undefined });
  return {
    ...DEFAULTS,
    ...user,
    vault,
    // ZHIRO_PORT: another port for this run (8787 taken, a second instance for a test) without touching the settings
    http: { ...DEFAULTS.http, ...(user.http ?? {}), ...(process.env.ZHIRO_PORT ? { port: Number(process.env.ZHIRO_PORT) } : {}) },
    llm: { ...DEFAULTS.llm, ...(user.llm ?? {}) },
    feishu: { ...(user.feishu ?? {}) },
    reminders: { ...DEFAULTS.reminders, ...(user.reminders ?? {}) },
    agent: { ...DEFAULTS.agent, ...(user.agent ?? {}) },
    sources: Array.isArray(user.sources) ? user.sources : [],
  };
}

export const configFile = (vault: string): string => join(vault, "config", "jobos.yaml");

/**
 * The only two ways jobos.yaml is rewritten. It holds the subscriptions (1,600 of them) next to the settings, so a write
 * cut short must leave the old file, never half of a new one: the text goes to a temporary file of its own (process id
 * and a random part — two writers never share one) and is renamed over the file. One writing process per data
 * directory (lock.ts, ADR-043), so there is no lost update between processes to guard against.
 */
function writeWhole(vault: string, doc: unknown): void {
  const file = configFile(vault);
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx");
    try { writeSync(fd, YAML.stringify(doc), null, "utf8"); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, file);
  } catch (e) { rmSync(tmp, { force: true }); throw e; }
}

/**
 * Change part of jobos.yaml (one setting, the subscription list): read the file, let `change` edit the document, write it
 * back whole. A file that is there but cannot be read or parsed is an error, never "empty, so start from nothing" —
 * that would write the subscriptions away.
 */
export function updateConfig(vault: string, change: (doc: any) => void): void {
  const file = configFile(vault);
  let doc: any = {};
  try { doc = YAML.parse(readFileSync(file, "utf8")) ?? {}; }
  catch (e: any) { if (e?.code !== "ENOENT") throw e; }
  change(doc);
  writeWhole(vault, doc);
}

/** Replace jobos.yaml with `doc` as it is (import; which secrets to keep is the importer's rule, export.ts). */
export function replaceConfig(vault: string, doc: unknown): void {
  writeWhole(vault, doc);
}

/** What an interrupted write left in config/. Only for the process that holds the directory's lock, at its start. */
export function clearConfigTemps(vault: string): void {
  const dir = join(vault, "config");
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const f of names) if (/^jobos\.yaml\.(\d+\.[0-9a-f]+\.)?tmp$/.test(f)) rmSync(join(dir, f), { force: true });
}

/** The person's loopback token (.daemon-token). The other credentials live in auth.ts (ADR-045). */
export function loadOrCreateToken(vault: string): string {
  const p = join(vault, "config", ".daemon-token");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  const t = randomBytes(24).toString("hex");
  writeFileSync(p, t, { encoding: "utf8", mode: 0o600 });
  return t;
}

export function dbPath(vault: string): string {
  return join(vault, "jobos.db");
}
