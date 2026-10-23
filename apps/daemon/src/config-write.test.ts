import { describe, it, expect } from "vitest";
import { createServices, testConfig } from "./services.js";
import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";
import { openDb } from "./db.js";
import { callTool, type Services } from "./registry.js";
import { updateConfig, replaceConfig, clearConfigTemps } from "./config.js";
import { runBackup } from "./service/backup.js";
import { addSource } from "./data/index.js";

/** The one way jobos.yaml is rewritten (tech-debt plan item 3): whole, through a temporary file, never half. */

const HUMAN = { kind: "human" as const, via: "desktop" as const };
const START = "http:\n  port: 8787\nfeishu:\n  webhookUrl: https://hook.example/secret\n  appSecret: s3cr3t\n  receiveId: ou_1\nagent:\n  mode: default\nsources:\n  - id: moka-a\n    source: moka\n    name: 示例汽车\n    url: https://app.mokahr.com/campus-recruitment/demo/1\n";

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-cfg-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), START, "utf8");
  const db = openDb(join(dir, "t.db"));
  const s: Services = createServices({ db: db, config: testConfig(dir, { sources: [], agent: { mode: "default", maxWritesPerTurn: 10 } }) });
  return { dir, db, s };
}
const doc = (dir: string) => YAML.parse(readFileSync(join(dir, "config", "jobos.yaml"), "utf8"));
const leftovers = (dir: string) => readdirSync(join(dir, "config")).filter((f) => f !== "jobos.yaml");

describe("writing jobos.yaml", () => {
  it("changes one part and keeps the rest; no temporary file is left", () => {
    const { dir } = setup();
    updateConfig(dir, (d) => { d.agent = { ...d.agent, mode: "conservative" }; });
    const d = doc(dir);
    expect(d.agent.mode).toBe("conservative");
    expect(d.sources).toHaveLength(1);
    expect(d.feishu.appSecret).toBe("s3cr3t");
    expect(leftovers(dir)).toEqual([]);
  });

  it("a change that fails, or a file it cannot read, leaves the file as it was", () => {
    const { dir } = setup();
    expect(() => updateConfig(dir, () => { throw new Error("change refused"); })).toThrow("change refused");
    expect(readFileSync(join(dir, "config", "jobos.yaml"), "utf8")).toBe(START);
    const broken = "sources: [\n  - id: a\n";
    writeFileSync(join(dir, "config", "jobos.yaml"), broken, "utf8");
    expect(() => updateConfig(dir, (d) => { d.agent = { mode: "default" }; })).toThrow();
    expect(readFileSync(join(dir, "config", "jobos.yaml"), "utf8")).toBe(broken); // never "empty, so start from nothing"
    expect(leftovers(dir)).toEqual([]);
  });

  it("replaces the whole document (import)", () => {
    const { dir } = setup();
    replaceConfig(dir, { agent: { mode: "default" }, sources: [] });
    expect(doc(dir)).toEqual({ agent: { mode: "default" }, sources: [] });
    expect(leftovers(dir)).toEqual([]);
  });

  it("clears what an interrupted write left behind, and nothing else", () => {
    const { dir } = setup();
    for (const f of ["jobos.yaml.tmp", "jobos.yaml.4242.9f3a1c.tmp", ".agent-token", "notes.yaml"]) writeFileSync(join(dir, "config", f), "x", "utf8");
    clearConfigTemps(dir);
    expect(leftovers(dir).sort()).toEqual([".agent-token", "notes.yaml"]);
  });

  it("every setting that is saved keeps the subscriptions and the secrets", async () => {
    const { dir, s } = setup();
    await callTool("agent.mode", { mode: "conservative" }, HUMAN, s);
    await callTool("agent.harnessConfirm", { where: "window" }, HUMAN, s);
    await callTool("agent.background", { useModel: false }, HUMAN, s);
    await callTool("apply.reference", { path: "" }, HUMAN, s);
    const d = doc(dir);
    expect(d.agent).toMatchObject({ mode: "conservative", harnessConfirm: "window" });
    expect(d.llm.forBackground).toBe(false);
    expect(d.sources.map((x: any) => x.id)).toEqual(["moka-a"]);
    expect(d.feishu.appSecret).toBe("s3cr3t");
    expect(leftovers(dir)).toEqual([]);
  });

  it("a new subscription keeps the settings", () => {
    const { dir, db } = setup();
    const sources = doc(dir).sources;
    addSource({ db, vault: dir, sources }, { url: "https://app.mokahr.com/campus-recruitment/acme/9", name: "示例重工" });
    const d = doc(dir);
    expect(d.sources).toHaveLength(2);
    expect(d.http.port).toBe(8787);
    expect(leftovers(dir)).toEqual([]);
  });
});

describe("the backup keeps the configuration", () => {
  const backups = (dir: string) => readdirSync(join(dir, "backups")).sort();

  it("beside each database copy, a copy of jobos.yaml without its secrets, with the same name", () => {
    const { dir, db } = setup();
    const r = runBackup(db, dir);
    expect(r.config).toBe(r.path.replace(/\.db$/, ".yaml"));
    const saved = YAML.parse(readFileSync(r.config, "utf8"));
    expect(saved.sources.map((x: any) => x.id)).toEqual(["moka-a"]);
    expect(saved.feishu).toEqual({ webhookUrl: "", appSecret: "", receiveId: "ou_1" });
    expect(readFileSync(r.config, "utf8")).not.toContain("s3cr3t");
  });

  it("a configuration it could not save fails the backup, and no half of the pair stays", () => {
    const { dir, db } = setup();
    writeFileSync(join(dir, "config", "jobos.yaml"), "sources: [\n  - id: a\n", "utf8");
    expect(() => runBackup(db, dir)).toThrow();
    expect(existsSync(join(dir, "backups")) ? backups(dir) : []).toEqual([]);
  });

  it("old backups go with their configuration; what is not ours stays", () => {
    const { dir, db } = setup();
    mkdirSync(join(dir, "backups"), { recursive: true });
    const old = Array.from({ length: 6 }, (_, i) => `jobos-2020-01-0${i + 1}T00-00-00-000Z`);
    for (const f of old) { writeFileSync(join(dir, "backups", f + ".db"), "x", "utf8"); writeFileSync(join(dir, "backups", f + ".yaml"), "x", "utf8"); }
    writeFileSync(join(dir, "backups", "pre-import-2020-01-01T00-00-00-000Z.yaml"), "x", "utf8");
    const r = runBackup(db, dir);
    const left = backups(dir);
    // as before: the new one, the four newest old ones, the newest of the rest — each with its .yaml
    expect(left.filter((f) => f.startsWith("jobos-2020"))).toEqual(old.slice(1).flatMap((f) => [f + ".db", f + ".yaml"]));
    expect(left).toContain("pre-import-2020-01-01T00-00-00-000Z.yaml");
    expect(left).toContain(r.path.split(/[\\/]/).pop());
    expect(left).toContain(r.config.split(/[\\/]/).pop());
  });
});
