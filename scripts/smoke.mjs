#!/usr/bin/env node
/**
 * `node scripts/smoke.mjs` — does the built package install and run for a stranger? (G3, plan §1.7)
 * Packs out/npm, installs it into an empty folder, and with a fresh data directory and a free port: --version, start,
 * /health, the UI page, MCP (list tools, one read-only call), `data probe` on a local CSV, `vault verify`, and whether a
 * browser for 网申 can be started. Run `pnpm build` first. Leaves nothing behind but its temp folder (removed at the end).
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = mkdtempSync(join(tmpdir(), "zhiro-smoke-"));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const sh = process.platform === "win32"; // npm.cmd needs a shell on Windows
const step = (s) => console.log(`\n▶ ${s}`);
let daemon;
const fail = (why) => { console.error(`✗ ${why}`); daemon?.kill(); process.exit(1); };

try {
  step("npm pack");
  execFileSync(npm, ["pack", "--pack-destination", tmp], { cwd: join(root, "out", "npm"), stdio: "inherit", shell: sh });
  const tgz = join(tmp, readdirSync(tmp).find((f) => f.endsWith(".tgz")));

  step("install into an empty folder");
  const app = join(tmp, "app");
  mkdirSync(app);
  writeFileSync(join(app, "package.json"), "{}");
  execFileSync(npm, ["install", "--no-audit", "--no-fund", tgz], { cwd: app, stdio: "inherit", shell: sh });
  const bin = join(app, "node_modules", "zhiro", "bin", "zhiro.cjs");
  const data = join(tmp, "data");
  const port = String(18000 + Math.floor(Math.random() * 1000));
  const env = { ...process.env, ZHIRO_PORT: port, JOBOS_VAULT: "", ZHIRO_DATA: "" };
  const zhiro = (...args) => execFileSync(process.execPath, [bin, ...args], { cwd: tmp, env, encoding: "utf8" });

  step("zhiro --version");
  const v = zhiro("--version").trim();
  if (!/^\d+\.\d+\.\d+/.test(v)) fail(`--version said ${v}`);
  console.log(v);

  step("zhiro --data <new folder> (start)");
  daemon = spawn(process.execPath, [bin, "--data", data, "--no-open"], { cwd: tmp, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  daemon.stdout.on("data", (d) => (log += d));
  daemon.stderr.on("data", (d) => (log += d));
  const base = `http://127.0.0.1:${port}`;
  let health;
  for (let i = 0; i < 120 && !health; i++) {
    await new Promise((r) => setTimeout(r, 500));
    if (daemon.exitCode !== null) fail(`the daemon exited:\n${log}`);
    try { health = await (await fetch(`${base}/health`)).json(); } catch { /* not up yet */ }
  }
  if (!health?.ok) fail(`no /health after 60 s:\n${log}`);
  console.log(`health ok, version ${health.version}`);

  step("the UI page");
  const page = await fetch(`${base}/app/`);
  if (page.status !== 200 || !/<div id="root">/.test(await page.text())) fail(`/app/ answered ${page.status}`);

  step("MCP: list tools, one read-only call");
  const req = createRequire(join(root, "apps", "daemon", "package.json"));
  const load = (p) => import(pathToFileURL(p).href);
  const { Client } = await load(req.resolve("@modelcontextprotocol/sdk/client/index.js"));
  const { StdioClientTransport } = await load(req.resolve("@modelcontextprotocol/sdk/client/stdio.js"));
  const client = new Client({ name: "smoke", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [bin, "mcp"], env: { ...env, ZHIRO_DATA: data, JOBOS_URL: base } }));
  const tools = (await client.listTools()).tools;
  if (tools.length < 20) fail(`only ${tools.length} tools over MCP`);
  const today = await client.callTool({ name: tools.find((t) => /today/.test(t.name)).name, arguments: {} });
  if (today.isError) fail(`today.summary over MCP: ${JSON.stringify(today.content).slice(0, 300)}`);
  await client.close();
  console.log(`${tools.length} tools; today.summary answered`);

  step("zhiro data probe <local CSV>");
  const csv = join(tmp, "jobs.csv");
  writeFileSync(csv, "公司,岗位,工作地点,截止时间,投递链接\n示例科技,算法工程师,武汉,2030-01-01,https://jobs.example.com/1\n", "utf8");
  const probe = zhiro("data", "probe", csv, "--data", data);
  if (!/示例科技/.test(probe)) fail(`probe did not read the CSV:\n${probe}`);

  step("zhiro vault verify (beside the running daemon)");
  const verify = zhiro("vault", "verify", "--data", data);
  if (!/检查通过/.test(verify)) fail(verify);

  step("a browser for 网申");
  try {
    const pw = await import(pathToFileURL(createRequire(join(app, "package.json")).resolve("playwright-core")).href);
    const chromium = pw.chromium ?? pw.default.chromium;
    const b = await chromium.launch({ channel: "chrome", headless: true });
    await b.close();
    console.log("Chrome starts");
  } catch (e) {
    if (process.env.CI) fail(`no Chrome to fill applications with: ${e?.message ?? e}`);
    console.warn(`(no Chrome here — 网申 needs one: ${String(e?.message ?? e).split("\n")[0]})`);
  }

  console.log("\n✓ smoke passed");
} finally {
  daemon?.kill();
  await new Promise((r) => setTimeout(r, 1000));
  try { rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { console.warn(`left ${tmp}`); }
}
