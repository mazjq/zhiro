/**
 * S3: does a new build show the same data as the old one, and leave it the same? Both builds are started in maintenance
 * mode (read only, no schedules, no network) on their own copy of one snapshot; every read tool that needs no input —
 * plus each application's timeline and each watched post — is asked of both and the answers compared; then both copies
 * are compared table by table, row by row, definition by definition, with each other and with the snapshot.
 *
 *   pnpm --filter @zhiro/daemon eval:compare -- --old <repo root> --new <repo root> --snapshot <copy of jobos.db> --work <empty folder>
 *
 * The snapshot must be a copy (sqlite backup), never the live file; it is only read. Nothing here reads credentials or a
 * data folder's keys: each side's folder is made fresh under --work and its own key is created by the daemon. A build
 * without maintenance mode cannot be compared (it would start its schedules) — the run refuses it.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { tools, type ToolContract } from "@zhiro/contracts";
import { OUTSIDE_TOOLS } from "../maintenance.js";

const argv = process.argv.slice(2).filter((x) => x !== "--");
const arg = (k: string) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : ""; };
const oldRoot = arg("--old"), newRoot = arg("--new"), snapshot = arg("--snapshot"), work = arg("--work");
const portBase = Number(arg("--port-base") || 18950);
if (!oldRoot || !newRoot || !snapshot || !work) { console.error("--old, --new, --snapshot and --work are all required"); process.exit(2); }

// ---------- guards: a copy, an empty work folder, builds that know maintenance mode
const snap = realpathSync(snapshot);
if (existsSync(snap + "-wal") || existsSync(join(dirname(snap), "config", ".daemon-token"))) {
  console.error("the snapshot looks like a live database (a -wal file or a data folder's key beside it): make a copy with sqlite backup first");
  process.exit(2);
}
mkdirSync(work, { recursive: true });
const w = realpathSync(work);
if (readdirSync(w).length) { console.error(`--work must be an empty folder: ${w}`); process.exit(2); }
if ((snap + sep).startsWith(w + sep)) { console.error("the snapshot must not be inside --work"); process.exit(2); }
writeFileSync(join(w, ".zhiro-compare"), "a throwaway folder of eval:compare\n");
for (const r of [oldRoot, newRoot]) if (!readFileSync(join(r, "apps", "daemon", "src", "main.ts"), "utf8").includes("ZHIRO_MAINTENANCE")) {
  console.error(`${r} has no maintenance mode: it would start its schedules on the copy`);
  process.exit(2);
}

// ---------- the two daemons
interface Side { name: string; root: string; dir: string; port: number; proc?: ChildProcess; token?: string }
const sides: Side[] = [{ name: "old", root: resolve(oldRoot), dir: join(w, "old"), port: portBase }, { name: "new", root: resolve(newRoot), dir: join(w, "new"), port: portBase + 1 }];

async function start(s: Side): Promise<void> {
  mkdirSync(join(s.dir, "config"), { recursive: true });
  copyFileSync(snap, join(s.dir, "jobos.db"));
  writeFileSync(join(s.dir, "config", "jobos.yaml"), `http:\n  host: 127.0.0.1\n  port: ${s.port}\n`, "utf8");
  s.proc = spawn(process.execPath, ["--no-warnings=ExperimentalWarning", "--import", "tsx", "src/main.ts", "--data", s.dir, "--maintenance"], {
    cwd: join(s.root, "apps", "daemon"), env: { ...process.env, ZHIRO_MAINTENANCE: "1", ZHIRO_DATA: s.dir, ZHIRO_OPEN: "0" }, stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
  });
  let log = "";
  await new Promise<void>((ok, fail) => {
    const t = setTimeout(() => fail(new Error(`${s.name}: no start in 120 s\n${log}`)), 120_000);
    const hear = (b: Buffer) => { log += b; if (log.includes("[zhiro] daemon http")) { clearTimeout(t); ok(); } };
    s.proc!.stdout!.on("data", hear); s.proc!.stderr!.on("data", hear);
    s.proc!.on("exit", (c) => { clearTimeout(t); fail(new Error(`${s.name} exited (${c})\n${log}`)); });
  });
  if (!log.includes("maintenance mode")) throw new Error(`${s.name} did not start in maintenance mode`);
  s.token = readFileSync(join(s.dir, "config", ".daemon-token"), "utf8").trim();
}

async function ask(s: Side, name: string, input: unknown): Promise<unknown> {
  const r = await fetch(`http://127.0.0.1:${s.port}/api/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.token}`, "x-jobos-actor": "cli" }, body: JSON.stringify(input) });
  // each side has its own folder: its path in an answer is the same fact on both sides
  const text = (await r.text()).split(JSON.stringify(s.dir).slice(1, -1)).join("<data>").split(s.dir.replaceAll("\\", "/")).join("<data>");
  const out = JSON.parse(text);
  if (name === "config.get" && out?.config?.http) delete out.config.http.port; // each side listens on its own port
  return out;
}

/** Key order is not meaning; array order is. */
const canon = (v: unknown): unknown => (Array.isArray(v) ? v.map(canon) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canon((v as any)[k])])) : v);
function firstDiff(a: unknown, b: unknown, path = ""): string | null {
  if (JSON.stringify(a) === JSON.stringify(b)) return null;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) { const d = firstDiff((a as any)[k], (b as any)[k], `${path}/${k}`); if (d) return d; }
  }
  return `${path || "/"}: ${JSON.stringify(a)?.slice(0, 120)} ≠ ${JSON.stringify(b)?.slice(0, 120)}`;
}

// ---------- every table, every column, every definition
interface Picture { tables: Record<string, { rows: number; digest: string }>; schema: Record<string, string> }
function picture(file: string): Picture {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const schema: Record<string, string> = {};
    for (const r of db.prepare("select type, name, sql from sqlite_master where name not like 'sqlite_%' order by name").all() as any[]) schema[`${r.type} ${r.name}`] = String(r.sql ?? "").replace(/\s+/g, " ");
    const tables: Picture["tables"] = {};
    for (const k of Object.keys(schema).filter((k) => k.startsWith("table "))) {
      const t = k.slice(6), cols = (db.prepare(`pragma table_info("${t}")`).all() as any[]).map((c) => `"${c.name}"`).join(", ");
      const h = createHash("sha256");
      const rows = db.prepare(`select ${cols} from "${t}" order by ${cols}`).all() as any[];
      for (const r of rows) h.update(JSON.stringify(Object.values(r), (_k, v) => (typeof v === "bigint" ? String(v) : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v)));
      tables[t] = { rows: rows.length, digest: h.digest("hex") };
    }
    return { tables, schema };
  } finally { db.close(); }
}
function comparePictures(a: Picture, b: Picture, an: string, bn: string): string[] {
  const out: string[] = [];
  for (const k of new Set([...Object.keys(a.schema), ...Object.keys(b.schema)])) {
    if (!(k in b.schema)) out.push(`${k}：${bn} 没有`);
    else if (!(k in a.schema)) out.push(`${k}：${bn} 新增`);
    else if (a.schema[k] !== b.schema[k]) out.push(`${k}：定义不同`);
  }
  for (const t of Object.keys(a.tables)) if (b.tables[t] && a.tables[t].digest !== b.tables[t].digest) out.push(`表 ${t}：${an} ${a.tables[t].rows} 行，${bn} ${b.tables[t].rows} 行，内容${a.tables[t].rows === b.tables[t].rows ? "不同" : ""}`);
  return out;
}

// ---------- run
const report: { tools: { name: string; input: unknown; diff: string | null }[]; db: Record<string, string[]> } = { tools: [], db: {} };
try {
  for (const s of sides) await start(s);
  const plain = (Object.values(tools) as ToolContract[]).filter((c) => !c.effects.localWrite && !c.effects.externalAction && !c.effects.dataEgress && !OUTSIDE_TOOLS.test(c.name) && c.name !== "data.location" /* free disk space moves between calls */ &&!((c.input as any).required?.length));
  const calls: [string, unknown][] = plain.flatMap((c) => (c.name.endsWith(".list") && (c.input as any).properties?.detail ? [[c.name, {}], [c.name, { detail: "brief" }]] : [[c.name, {}]]) as [string, unknown][]);
  const apps = ((await ask(sides[0], "application.list", { detail: "brief" })) as any).items ?? [];
  for (const a of apps) calls.push(["application.timeline", { id: a.application.id }]);
  const watched = ((await ask(sides[0], "position.list", { watchedOnly: true, detail: "brief", limit: 500 })) as any).items ?? [];
  for (const p of watched) calls.push(["position.get", { id: p.id }]);
  for (const [name, input] of calls) {
    const [a, b] = await Promise.all(sides.map((s) => ask(s, name, input)));
    report.tools.push({ name, input, diff: firstDiff(canon(a), canon(b)) });
  }
} finally {
  for (const s of sides) s.proc?.kill();
  await new Promise((r) => setTimeout(r, 1500)); // the files are let go
}
const snapPic = picture(snap), [oldPic, newPic] = sides.map((s) => picture(join(s.dir, "jobos.db")));
report.db["old vs snapshot"] = comparePictures(snapPic, oldPic, "快照", "旧版");
report.db["new vs snapshot"] = comparePictures(snapPic, newPic, "快照", "新版");
report.db["new vs old"] = comparePictures(oldPic, newPic, "旧版", "新版");
writeFileSync(join(w, "report.json"), JSON.stringify(report, null, 2), "utf8");

const differing = report.tools.filter((t) => t.diff);
console.log(`工具：比了 ${report.tools.length} 次，${report.tools.length - differing.length} 次完全一致，${differing.length} 次不同`);
for (const t of differing.slice(0, 40)) console.log(`  ${t.name} ${JSON.stringify(t.input)}  ${t.diff}`);
for (const [k, v] of Object.entries(report.db)) console.log(`库（${k}）：${v.length ? "\n  " + v.join("\n  ") : "完全一致"}`);
console.log(`报告：${join(w, "report.json")}（含真实数据时用完删掉整个 --work 文件夹）`);
process.exit(differing.length || Object.values(report.db).some((v) => v.length) ? 1 : 0);
