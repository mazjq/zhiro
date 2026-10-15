#!/usr/bin/env node
/**
 * `node scripts/export-public.mjs <empty folder>` — the public repository's first commit, from this (private) one
 * (plan §1.9). Only files git tracks here, only those the list below names; a tracked file the list does not mention
 * (neither in nor out) stops the export, so nothing new slips through unseen. Links are refused. The result is checked
 * with scripts/check-clean.mjs (including the private denylist outside the repository) before it is committed.
 * Run on a clean working tree: the export is HEAD.
 */
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const src = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dest = process.argv[2] && resolve(process.argv[2]);
if (!dest) throw new Error("usage: node scripts/export-public.mjs <empty folder>");
if (existsSync(dest) && readdirSync(dest).length) throw new Error(`${dest} is not empty`);

const IN = [
  // root files, one by one
  /^(\.gitignore|\.gitattributes|\.npmrc|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|biome\.json)$/,
  /^(release-please-config\.json|\.release-please-manifest\.json)$/,
  /^(README\.md|README\.zh-CN\.md|LICENSE|SECURITY\.md|CONTRIBUTING\.md|AGENTS\.md|llms-install\.md)$/,
  // folders
  /^\.github\//, /^\.githooks\//, /^apps\/daemon\//, /^apps\/desktop\//, /^packages\//, /^bin\//, /^agent-skills\//, /^scripts\//, /^vault\.example\//,
  // the docs written for people outside
  /^docs\/(README\.md|data\.md|data-sources\.md)$/, /^docs\/(harness|contrib|assets)\//,
];
const OUT = [
  /^\.claude\//, /^\.mcp\.json$/, /^\.gitmodules$/, /^vendor\//, // dev settings with local paths; upstream copies (one licence conflicts)
  /^docs\//, // the private working notes: hand-offs, progress, plans, reports, decision log
];
/** inside a folder that goes, but not these */
const DROP = [/^apps\/desktop\/src-tauri\/(target|gen)\//];

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: src, encoding: "utf8" }).split("\0").filter(Boolean);
const dirty = execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], { cwd: src, encoding: "utf8" }).trim();
if (dirty) throw new Error(`commit or stash first — the export is HEAD:\n${dirty}`);

const take = [], unknown = [];
for (const f of tracked) {
  if (DROP.some((re) => re.test(f))) continue;
  if (IN.some((re) => re.test(f))) take.push(f);
  else if (!OUT.some((re) => re.test(f))) unknown.push(f);
}
if (unknown.length) throw new Error(`tracked files the export list does not mention (add them to IN or OUT):\n  ${unknown.join("\n  ")}`);
for (const must of ["package.json", "pnpm-lock.yaml", "LICENSE", "README.md", "apps/daemon/src/main.ts", ".github/workflows/ci.yml"]) if (!take.includes(must)) throw new Error(`missing ${must}`);

mkdirSync(dest, { recursive: true });
for (const f of take) {
  const from = join(src, f);
  if (lstatSync(from).isSymbolicLink()) throw new Error(`a link: ${f}`);
  mkdirSync(dirname(join(dest, f)), { recursive: true });
  copyFileSync(from, join(dest, f));
}
console.log(`copied ${take.length} files (left out ${tracked.length - take.length})`);

const git = (...a) => execFileSync("git", a, { cwd: dest, stdio: "inherit" });
git("init", "-q", "-b", "main");
git("add", "-A");
execFileSync(process.execPath, [join(src, "scripts", "check-clean.mjs")], { cwd: dest, stdio: "inherit" }); // tracked files of the new repo
console.log(`ready in ${dest}: review, then commit`);
