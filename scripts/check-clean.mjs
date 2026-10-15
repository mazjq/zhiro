#!/usr/bin/env node
/**
 * `node scripts/check-clean.mjs [folder]` — nothing of a person's data or keys goes into the repository (G3, plan §1.8).
 * Without a folder: the files git tracks here. With one: every file under it (an export, an unpacked npm package).
 * Runs in CI, before each commit (.githooks/pre-commit), on the public export and on the packed npm tarball.
 *
 * Names and private words are not in this file: put them one per line in a file outside the repository and point
 * ZHIRO_DENYLIST at it (or keep it at ~/.zhiro-denylist). CI runs the general checks only.
 * A line that must mention something on purpose (an example path in an error message) carries `clean:allow`.
 */
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, relative, resolve, sep } from "node:path";

const folder = process.argv[2] ? resolve(process.argv[2]) : null;
const root = folder ?? process.cwd();

function walk(dir, out = []) {
  for (const n of readdirSync(dir)) {
    if (n === ".git" || n === "node_modules") continue;
    const p = join(dir, n), st = lstatSync(p);
    if (st.isSymbolicLink()) { out.push({ rel: relative(root, p), link: true }); continue; }
    if (st.isDirectory()) walk(p, out); else out.push({ rel: relative(root, p) });
  }
  return out;
}
const files = (folder ? walk(folder) : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).map((rel) => ({ rel })))
  .map((f) => ({ ...f, rel: f.rel.split(sep).join("/") }));

// --- what may never be here, by name ---
const FORBIDDEN = [
  [/(^|\/)[^/]*\.(db|sqlite|sqlite3)(-wal|-shm|-journal)?$/i, "a database file"],
  [/(^|\/)\.(daemon-token|agent-token|capture-key)$/, "a key file"],
  [/(^|\/)credentials\.json$/, "model login credentials"],
  [/(^|\/)\.env(\..*)?$/, "an environment file"],
  [/\.(pem|p12|pfx|key)$/i, "a private key"],
  [/\.har$/i, "a browser network recording"],
  [/(^|\/)(storage-state|auth-state|cookies)[^/]*\.json$/i, "browser login state"],
  [/(^|\/)vault\//, "a data directory (vault/)"],
  [/(^|\/)backups\//, "a backups folder"],
];
// binary files: only in these places
const BINARY = /\.(png|jpe?g|gif|webp|ico|icns|pdf|docx?|xlsx?|pptx?|zip|gz|tgz|7z|rar)$/i;
const BINARY_OK = [/^apps\/desktop\/src-tauri\/icons\//, /^apps\/desktop\/public\//, /^docs\/assets\//, /^apps\/daemon\/test\/fixtures\/vault-v\d+\.zip$/];

// --- what may never be inside a text file ---
const CONTENT = [
  [/https?:\/\/(?!example\.)[a-z0-9-]+\.(feishu\.cn|larksuite\.com)\/(base|wiki|sheets|docx|docs|drive|file)\/[A-Za-z0-9]{8,}/i, "a Feishu / Lark share link"],
  [/https?:\/\/docs\.qq\.com\/(sheet|doc|smartsheet)\/[A-Za-z0-9]{6,}/i, "a Tencent Docs link"],
  [/https?:\/\/(www\.)?notion\.(so|site)\/[^\s"')]*[0-9a-f]{32}/i, "a Notion page link"],
  // an upper-case drive letter (code says "60 s:\n"); the examples the UI shows (E:\Zhiro数据, D:\…) are fine
  [/(?<![\w%])[A-Z]:(\\\\|\\)(?!\\|…|Zhiro数据)[^\s"'`<>|*?]{2,}/, "a path on this machine (drive letter)"],
  [/\\\\[A-Za-z0-9.-]+\\[A-Za-z0-9$]/, "a network share path"],
  [/\/(Users|home)\/(?!runner\b|<|\$|\{|example|user\b|me\b)[a-z][a-z0-9._-]{1,}\//i, "a home folder path"],
  [/\/mnt\/[a-z]\/(?!\.\.\.)[^\s"'`]+/i, "a WSL path"],
  [/\b(gho|ghp|github_pat|npm|sk-ant|sk-proj|xox[bap])_[A-Za-z0-9_]{20,}/, "an access token"],
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, "a private key"],
];

const deny = (() => {
  const p = process.env.ZHIRO_DENYLIST || join(homedir(), ".zhiro-denylist");
  if (!existsSync(p)) return [];
  return readFileSync(p, "utf8").split(/\r?\n/).map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
})();

const problems = [];
for (const f of files) {
  if (f.link) { problems.push(`${f.rel}: a link (exports never follow links)`); continue; }
  for (const [re, what] of FORBIDDEN) if (re.test(f.rel) && !/^vault\.example\//.test(f.rel)) problems.push(`${f.rel}: ${what}`);
  if (/(^|\/)jobos\.yaml$/.test(f.rel) && !/^vault\.example\//.test(f.rel)) problems.push(`${f.rel}: a settings file outside vault.example/`);
  const abs = join(root, f.rel);
  if (!existsSync(abs)) continue; // deleted in the work tree, still tracked: git will say
  if (BINARY.test(f.rel)) {
    if (!BINARY_OK.some((re) => re.test(f.rel))) problems.push(`${f.rel}: a binary file outside the allowed places`);
    if (/\.zip$/.test(f.rel)) {
      const side = abs.replace(/\.zip$/, ".json");
      if (!existsSync(side) || !/"synthetic":\s*true/.test(readFileSync(side, "utf8"))) problems.push(`${f.rel}: a test sample without its "synthetic": true record`);
    }
    continue;
  }
  let text;
  try { text = readFileSync(abs, "utf8"); } catch { continue; }
  if (text.includes("\0")) { problems.push(`${f.rel}: binary content in a file that should be text`); continue; }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes("clean:allow")) return;
    for (const [re, what] of CONTENT) if (re.test(line)) problems.push(`${f.rel}:${i + 1}: ${what}: ${line.trim().slice(0, 120)}`);
    for (const w of deny) if (line.includes(w)) problems.push(`${f.rel}:${i + 1}: a private word from the denylist`);
  });
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s) — none of this may go into the repository:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`✓ clean: ${files.length} files${deny.length ? `, ${deny.length} private words` : " (no denylist here: general checks only)"}`);
