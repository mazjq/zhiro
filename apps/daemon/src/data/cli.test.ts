import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { lockVault } from "../lock.js";

/**
 * 「数据层能单独启动」: the `data` command is a process of its own — no daemon, no agent, no UI — that subscribes to a
 * table, files its posts, keeps pulling, and steps aside when something else holds the data directory.
 */
const DAEMON = resolve(import.meta.dirname, "../..");
const node = (_vault: string, ...args: string[]) => ["--no-warnings=ExperimentalWarning", "--import", "tsx", "src/data/cli.ts", ...args];
// not spawnSync: this process holds the lock in one step below and has to stay able to answer who it is
const run = (vault: string, ...args: string[]) => new Promise<{ status: number | null; stdout: string; stderr: string }>((done) => {
  const c = spawn(process.execPath, node(vault, ...args), { cwd: DAEMON, env: { ...process.env, JOBOS_VAULT: vault } });
  let stdout = "", stderr = "";
  c.stdout.on("data", (d) => (stdout += d));
  c.stderr.on("data", (d) => (stderr += d));
  c.on("exit", (status) => done({ status, stdout, stderr }));
});

describe("the data layer runs on its own", () => {
  it("add → list → sync on an empty data directory; refuses while another process holds it; watch keeps pulling", async () => {
    const vault = mkdtempSync(join(tmpdir(), "jobos-cli-"));
    const file = join(vault, "jobs.csv");
    writeFileSync(file, "企业名称,岗位\n示例重工,控制算法工程师\n示例电子,电机控制工程师\n", "utf8");

    const probe = await run(vault, "probe", file);
    expect(probe.stdout).toContain("2 行 → 2 个岗位");

    const add = await run(vault, "add", file, "--name", "我的表");
    expect(add.status, add.stderr).toBe(0);
    expect(add.stdout).toContain("已订阅");
    expect(add.stdout).toContain("读到 2 条，新增岗位 2");
    expect((await run(vault, "list")).stdout).toContain("我的表");

    const db = new DatabaseSync(join(vault, "jobos.db"), { readOnly: true });
    expect(db.prepare("select count(*) n from position").get()).toEqual({ n: 2 });
    db.close();

    // something else is using the directory (the daemon takes the same lock): a writing command steps aside and says who
    const held = await lockVault(vault, "daemon");
    const refused = await run(vault, "sync");
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain("数据目录已被daemon");
    held.release();
    await new Promise((r) => setTimeout(r, 100));

    writeFileSync(file, "企业名称,岗位\n示例重工,控制算法工程师\n示例电子,电机控制工程师\n示例光学,光学工程师\n", "utf8");
    const sync = await run(vault, "sync");
    expect(sync.stdout).toContain("读到 3 条，新增岗位 1");

    // watch: a process that stays, with the subscription on its schedule
    const watch = spawn(process.execPath, node(vault, "watch"), { cwd: DAEMON, env: { ...process.env, JOBOS_VAULT: vault } });
    const out = await new Promise<string>((done) => { let s = ""; watch.stdout.on("data", (d) => { s += d; if (s.includes("data watch")) done(s); }); watch.on("exit", () => done(s)); setTimeout(() => done(s), 30_000); });
    expect(out).toContain("1 个订阅按各自的周期拉取");
    expect((await run(vault, "sync")).status).toBe(2); // and it holds the directory while it runs
    watch.kill();
  }, 180_000);
});
