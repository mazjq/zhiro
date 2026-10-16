/** ADR-048: the data directory as one zip — what goes in, what never does, and that an import puts it back. */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "../service/domain.js";
import { importCsv } from "../service/import-csv.js";
import { exportVault, importVault, counts } from "./export.js";
import { zipRead, zipWrite } from "./zip.js";

const NOLOCK = { release() {} }; // a test directory nobody else opens

const CSV = `更新时间,公司,企业类型,行业类别,批次,招聘届次,工作地点,招聘岗位,学历要求,专业要求,开始时间,截止时间,简历投递链接,公告链接,是否笔试,公告来源,备注
2026-09-01,示例汽车,民企,汽车,2027届博士专项,2027届,武汉,"底盘控制算法工程师,仿真建模工程师",博士,控制/车辆,2026-08-20,2030-10-15,https://app.mokahr.com/campus-recruitment/demo/1,https://example.com/n,否,校园招聘网,
`;

function vault() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-export-"));
  for (const d of ["config", "research/示例汽车", "resume/templates", "backups", "runs/r1", "chat/claude", "agent"]) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, "config", "jobos.yaml"), "feishu:\n  webhookUrl: https://hook.example/secret\n  appSecret: s3cr3t\n  receiveId: ou_1\nagent:\n  mode: default\n", "utf8");
  writeFileSync(join(dir, "config", ".daemon-token"), "HUMANTOKEN", "utf8");
  writeFileSync(join(dir, "config", ".agent-token"), "AGENTTOKEN", "utf8");
  writeFileSync(join(dir, "research", "示例汽车", "report.md"), "# 报告\n", "utf8");
  writeFileSync(join(dir, "resume", "templates", "cv.md"), "简历", "utf8");
  writeFileSync(join(dir, "runs", "r1", "brief.md"), "worker brief", "utf8");
  writeFileSync(join(dir, "chat", "claude", "mcp.json"), "{}", "utf8");
  writeFileSync(join(dir, "backups", "old.db"), "x", "utf8");
  const db = openDb(join(dir, "jobos.db"));
  const csv = join(dir, "a.csv"); writeFileSync(csv, CSV, "utf8"); importCsv(new Domain(db), csv);
  return { dir, db };
}

describe("zip", () => {
  it("round-trips, deflated or stored, and refuses a damaged entry", () => {
    const entries = [{ name: "a/b.txt", data: Buffer.from("hello hello hello hello") }, { name: "r.bin", data: Buffer.from([1, 2, 3]) }, { name: "中文.md", data: Buffer.from("文") }];
    const zip = zipWrite(entries);
    expect(zipRead(zip).map((e) => [e.name, e.data.toString()])).toEqual(entries.map((e) => [e.name, e.data.toString()]));
    const bad = Buffer.from(zip); bad[30 + "a/b.txt".length + 2] ^= 0xff; // inside the first entry's data (after its 30-byte header and name)
    expect(() => zipRead(bad)).toThrow(/校验失败/);
  });
});

describe("export", () => {
  it("packs a checked snapshot, the redacted config and the person's files — and nothing secret, transient or live", () => {
    const { dir, db } = vault();
    const to = join(mkdtempSync(join(tmpdir(), "jobos-out-")), "out.zip");
    const r = exportVault(db, dir, to);
    expect(existsSync(to)).toBe(true);
    expect(existsSync(to + ".part")).toBe(false);
    const entries = zipRead(readFileSync(to));
    const names = entries.map((e) => e.name).sort();
    expect(names).toEqual(["config/jobos.yaml", "files/research/示例汽车/report.md", "files/resume/templates/cv.md", "jobos.db", "manifest.json"]);
    const cfg = entries.find((e) => e.name === "config/jobos.yaml")!.data.toString();
    expect(cfg).not.toMatch(/s3cr3t|hook\.example/);
    expect(cfg).toMatch(/receiveId: ou_1/);
    const all = Buffer.concat(entries.map((e) => e.data)).toString("latin1");
    expect(all).not.toMatch(/HUMANTOKEN|AGENTTOKEN/);
    expect(r.manifest.counts.campaign).toBe(1);
    expect(r.manifest.counts.position).toBe(2);
    expect(r.manifest.files).toBe(2);
    expect(existsSync(join(dir, "backups"))).toBe(true);
    expect((require("node:fs").readdirSync(join(dir, "backups")) as string[]).some((f) => f.startsWith("export-"))).toBe(false); // the snapshot is cleaned up
  });
  it("refuses a target inside the vault, an existing file, a non-zip name", () => {
    const { dir, db } = vault();
    expect(() => exportVault(db, dir, join(dir, "x.zip"))).toThrow(/BAD_PATH/);
    expect(() => exportVault(db, dir, join(dir, "backups", "x.zip"))).toThrow(/BAD_PATH/);
    const out = mkdtempSync(join(tmpdir(), "jobos-out-"));
    expect(() => exportVault(db, dir, join(out, "x.tar"))).toThrow(/BAD_PATH/);
    writeFileSync(join(out, "y.zip"), "");
    expect(() => exportVault(db, dir, join(out, "y.zip"))).toThrow(/EXISTS/);
  });
  it("does not follow a link out of the vault", () => {
    const { dir, db } = vault();
    const outside = mkdtempSync(join(tmpdir(), "jobos-outside-")); writeFileSync(join(outside, "secret.txt"), "no", "utf8");
    try { symlinkSync(outside, join(dir, "research", "link"), "junction"); } catch { return; } // no permission to link: nothing to test
    const to = join(mkdtempSync(join(tmpdir(), "jobos-out-")), "out.zip");
    exportVault(db, dir, to);
    expect(zipRead(readFileSync(to)).map((e) => e.name)).not.toContain("files/research/link/secret.txt");
  });
});

describe("import", () => {
  it("puts an export back: the database and files replaced, the current database kept, secrets kept, counts reported", () => {
    const src = vault();
    const to = join(mkdtempSync(join(tmpdir(), "jobos-out-")), "out.zip");
    exportVault(src.db, src.dir, to);
    src.db.close();
    // a different vault with its own, different data and its own secrets
    const dst = vault();
    const d = new Domain(dst.db);
    const p = d.listPositions({ query: "底盘" }).items[0];
    d.createApplication(p.id, "official", "", "human:desktop");
    expect(counts(dst.db).application).toBe(1);
    dst.db.close();
    writeFileSync(join(dst.dir, "research", "示例汽车", "report.md"), "旧报告", "utf8");
    const r = importVault(dst.dir, to, NOLOCK);
    expect(r.before.application).toBe(1);
    expect(r.after.application).toBe(0);
    expect(r.after.campaign).toBe(1);
    expect(r.files).toBe(2);
    expect(existsSync(r.backup)).toBe(true);
    expect(readFileSync(join(dst.dir, "research", "示例汽车", "report.md"), "utf8")).toBe("# 报告\n");
    const cfg = readFileSync(join(dst.dir, "config", "jobos.yaml"), "utf8");
    expect(cfg).toMatch(/appSecret: s3cr3t/); // the destination's own secret survives
    expect(cfg).toMatch(/receiveId: ou_1/);
    expect(readFileSync(join(dst.dir, "config", ".daemon-token"), "utf8")).toBe("HUMANTOKEN"); // untouched
    const db = openDb(join(dst.dir, "jobos.db")); expect(counts(db).position).toBe(2); db.close();
  });
  it("refuses what is not a Zhiro export, or is damaged, before touching anything", () => {
    const dst = vault(); dst.db.close();
    const out = mkdtempSync(join(tmpdir(), "jobos-out-"));
    writeFileSync(join(out, "notours.zip"), zipWrite([{ name: "readme.txt", data: Buffer.from("x") }]));
    expect(() => importVault(dst.dir, join(out, "notours.zip"), NOLOCK)).toThrow(/NOT_EXPORT/);
    const src = vault(); const good = join(out, "good.zip"); exportVault(src.db, src.dir, good); src.db.close();
    const entries = zipRead(readFileSync(good)); entries.find((e) => e.name === "jobos.db")!.data[100] ^= 0xff;
    writeFileSync(join(out, "tampered.zip"), zipWrite(entries));
    expect(() => importVault(dst.dir, join(out, "tampered.zip"), NOLOCK)).toThrow(/CORRUPT/);
    const db = openDb(join(dst.dir, "jobos.db")); expect(counts(db).campaign).toBe(1); db.close(); // still the destination's own
  });
});
