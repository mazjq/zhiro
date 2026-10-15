#!/usr/bin/env node
/**
 * `zhiro` (the installed package). CommonJS on purpose: it must run, and say something useful, on a Node too old for the
 * rest — the database is Node's own SQLite, which needs 22.13 or newer.
 */
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`Zhiro 需要 Node 22.13 或更新（现在是 ${process.versions.node}）。到 https://nodejs.org 装 LTS 版，或用不需要 Node 的安装脚本：https://github.com/mazjq/zhiro#install`);
  console.error(`Zhiro needs Node 22.13 or newer (this is ${process.versions.node}). Get the LTS from https://nodejs.org, or use the install script.`);
  process.exit(1);
}
// Node's SQLite still calls itself experimental: that warning is not for the person using the program
const emit = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === "string" ? rest[0] : rest[0] && rest[0].type;
  if (type === "ExperimentalWarning" && /SQLite/i.test(String(warning))) return;
  return emit.call(process, warning, ...rest);
};
const { pathToFileURL } = require("node:url");
const { join } = require("node:path");
import(pathToFileURL(join(__dirname, "..", "dist", "zhiro.js")).href);
