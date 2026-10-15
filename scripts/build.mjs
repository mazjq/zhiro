#!/usr/bin/env node
/**
 * `pnpm build` — the npm package `zhiro` in out/npm/ (ADR-052). Run after the UI is built (`pnpm --filter @zhiro/desktop
 * build`; `pnpm build` at the root does both). The daemon is bundled by esbuild into dist/ (the contracts package goes in;
 * the npm dependencies stay dependencies), next to the UI, the agent skill, the launcher, the licence and the READMEs.
 */
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const daemon = join(root, "apps", "daemon");
const out = join(root, "out", "npm");
const pkg = JSON.parse(readFileSync(join(daemon, "package.json"), "utf8"));
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8")); // the one version number (release-please bumps it)
const ui = join(root, "apps", "desktop", "dist");
if (!existsSync(join(ui, "index.html"))) throw new Error("the UI is not built: pnpm --filter @zhiro/desktop build");

rmSync(out, { recursive: true, force: true });
const deps = Object.fromEntries(Object.entries(pkg.dependencies).filter(([n]) => !n.startsWith("@zhiro/")));
await build({
  entryPoints: { zhiro: join(daemon, "src", "cli", "zhiro.ts"), "research-data": join(daemon, "src", "mcp", "research-data.ts"), "acp-bridge": join(daemon, "src", "agent", "backends", "acp-bridge.ts") },
  outdir: join(out, "dist"),
  bundle: true, splitting: true, format: "esm", platform: "node", target: "node22.13",
  external: Object.keys(deps),
  define: { __ZHIRO_BUNDLE__: "true", __ZHIRO_VERSION__: JSON.stringify(version) },
  sourcemap: false, legalComments: "inline", logLevel: "warning", charset: "utf8",
  // ponytail: the bundle keeps function names — the browser-injected helpers rely on them (apply.ts has the __name shim)
  keepNames: true,
});

cpSync(ui, join(out, "ui"), { recursive: true });
mkdirSync(join(out, "agent-skills", "zhiro"), { recursive: true });
cpSync(join(root, "agent-skills", "zhiro", "SKILL.md"), join(out, "agent-skills", "zhiro", "SKILL.md"));
mkdirSync(join(out, "bin"), { recursive: true });
cpSync(join(root, "bin", "zhiro.cjs"), join(out, "bin", "zhiro.cjs"));
for (const f of ["LICENSE", "README.md", "README.zh-CN.md"]) if (existsSync(join(root, f))) cpSync(join(root, f), join(out, f));

writeFileSync(join(out, "package.json"), JSON.stringify({
  name: "@mazjq/zhiro", // npm refused the bare name (too close to "tjiro"); the command is still `zhiro`
  version,
  description: "Zhiro · 职路 — local-first AI career research and job hunting, with your own agent (Claude Code, Codex, …) over MCP",
  license: "MIT",
  author: "mazjq",
  homepage: "https://github.com/mazjq/zhiro",
  repository: { type: "git", url: "git+https://github.com/mazjq/zhiro.git" },
  bugs: "https://github.com/mazjq/zhiro/issues",
  keywords: ["job-search", "career", "campus-recruiting", "mcp", "agent", "local-first", "校招", "求职"],
  type: "module",
  bin: { zhiro: "bin/zhiro.cjs" },
  files: ["bin", "dist", "ui", "agent-skills", "LICENSE", "README.md", "README.zh-CN.md"],
  engines: { node: ">=22.13" },
  dependencies: deps,
}, null, 2) + "\n");
console.log(`out/npm: @mazjq/zhiro@${version}`);
