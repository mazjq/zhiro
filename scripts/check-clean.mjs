#!/usr/bin/env node
/**
 * `node scripts/check-clean.mjs [folder]` — nothing of a person's data or keys goes into the repository (G3, plan §1.8).
 * Without a folder: the files git tracks here. With one: every file under it (an export, an unpacked npm package).
 * `--commits <range>` (e.g. origin/main..HEAD): every line those commits add, and who they say wrote them — a key
 * committed and deleted again is still public once the branch is pushed, and a commit's e-mail is public too.
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

const commitsAt = process.argv.indexOf("--commits");
const range = commitsAt >= 0 ? process.argv[commitsAt + 1] : null;
const folder = !range && process.argv[2] ? resolve(process.argv[2]) : null;
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
const files = range ? [] : (folder ? walk(folder) : execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean).map((rel) => ({ rel })))
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
  // Feishu: a person's id in an app, a group bot's address, an app secret written out
  [/\bou_[a-f0-9]{32}\b/, "a Feishu open_id (a person)"],
  [/open\.feishu\.cn\/open-apis\/bot\/v2\/hook\/[A-Za-z0-9-]{10,}/, "a Feishu group bot address"],
  [/app_?secret["'`\s:=]+["'`]?[A-Za-z0-9]{24,}/i, "an app secret"],
  [/\b(AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,})/, "a cloud key"],
  // a person: a phone number that is not the usual placeholder, an ID number that passes its checksum, an e-mail
  [/(?<![A-Za-z0-9.])1[3-9]\d{9}(?![A-Za-z0-9])/, "a mobile number", (m) => m !== "13800000000" && !/^138001380\d\d$/.test(m)],
  [/(?<![A-Za-z0-9])\d{6}(19|20)\d{2}(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])\d{3}[\dXx](?![A-Za-z0-9])/, "an ID number", (m) => idChecksum(m)],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.(com|cn|net|org|edu|ca|io)\b/, "an e-mail address", (m) => !emailOk(m)],
];
/** A Chinese resident ID whose last character is its checksum: a made-up number almost never is. */
function idChecksum(s) {
  const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2], c = "10X98765432";
  const sum = [...s.slice(0, 17)].reduce((n, d, i) => n + Number(d) * w[i], 0);
  return c[sum % 11] === s[17].toUpperCase();
}
/** E-mails that are not a person's: examples, placeholders, no-reply senders, bots. */
function emailOk(m) {
  const [local, domain] = m.toLowerCase().split("@");
  return /(^|\.)(example\.(com|org|net|cn)|users\.noreply\.github\.com|anthropic\.com|github\.com)$/.test(domain) || /\.example\./.test(domain)
    || /^(a|b|me|you|test|user|name|demo|foo|bar|hr|campus|bank|no-?reply|noreply|notifications?)$/.test(local) || /^(no-?reply|noreply)/.test(local);
}

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
    for (const [re, what, real] of CONTENT) { const m = line.match(re); if (m && (!real || real(m[0]))) problems.push(`${f.rel}:${i + 1}: ${what}: ${line.trim().slice(0, 120)}`); }
    for (const w of deny) if (line.includes(w)) problems.push(`${f.rel}:${i + 1}: a private word from the denylist`);
  });
}

// --commits: every added line of the range, and the e-mail each commit gives
if (range) {
  const git = (...a) => execFileSync("git", a, { encoding: "utf8", maxBuffer: 1 << 30 });
  for (const row of git("log", range, "--format=%h%x09%ae%x09%ce").split("\n").filter(Boolean)) {
    const [h, ae, ce] = row.split("\t");
    for (const e of [ae, ce]) if (!/(@users\.noreply\.github\.com|^noreply@github\.com|\[bot\]@)/.test(e)) problems.push(`commit ${h}: written as ${e} — use your GitHub noreply address (git config user.email <id>+<name>@users.noreply.github.com)`);
  }
  let where = "";
  for (const line of git("log", range, "-p", "--no-color", "--format=@@ %h").split("\n")) {
    if (line.startsWith("@@ ") && !line.startsWith("@@ -")) { where = line.slice(3); continue; }
    if (line.startsWith("+++ b/")) { where = `${where.split(" ")[0]} ${line.slice(6)}`; continue; }
    if (!line.startsWith("+") || line.startsWith("+++") || line.includes("clean:allow")) continue;
    for (const [re, what, real] of CONTENT) { const m = line.match(re); if (m && (!real || real(m[0]))) problems.push(`${where}: ${what}: ${line.slice(1).trim().slice(0, 120)}`); }
    for (const w of deny) if (line.includes(w)) problems.push(`${where}: a private word from the denylist`);
  }
}

if (problems.length) {
  console.error(`✗ ${problems.length} problem(s) — none of this may go into the repository:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log(`✓ clean: ${range ? `commits ${range}` : `${files.length} files`}${deny.length ? `, ${deny.length} private words` : " (no denylist here: general checks only)"}`);
