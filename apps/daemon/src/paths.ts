/**
 * Where the program's own files are (ADR-052). Two ways it runs: from the source tree under tsx (`pnpm dev`, tests), or
 * as the built package (`zhiro`, from npm or the install script), where everything is bundled into `dist/` and the
 * build sets `__ZHIRO_BUNDLE__`. Nothing else in the code works out paths from its own file's location.
 *
 *   source tree                         package
 *   <repo>/                             <package>/
 *     apps/daemon/src/…                   dist/zhiro.js, dist/research-data.js, dist/acp-bridge.js
 *     apps/desktop/dist/  (the UI)        ui/
 *     agent-skills/                       agent-skills/
 *     bin/jobos-mcp.cjs                   bin/zhiro.cjs
 */
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION } from "./version.js";

declare const __ZHIRO_BUNDLE__: boolean | undefined;
export const BUNDLED = typeof __ZHIRO_BUNDLE__ !== "undefined";

const here = dirname(fileURLToPath(import.meta.url)); // apps/daemon/src, or <package>/dist
/** The repository root, or the installed package's root. */
export const ROOT = BUNDLED ? resolve(here, "..") : resolve(here, "..", "..", "..");

export const UI_DIST = process.env.ZHIRO_UI_DIST ?? process.env.JOBOS_UI_DIST ?? (BUNDLED ? join(ROOT, "ui") : join(ROOT, "apps", "desktop", "dist"));
export const SKILL_FILE = join(ROOT, "agent-skills", "zhiro", "SKILL.md");

const SOURCES = { "research-data": "mcp/research-data.ts", "acp-bridge": "agent/backends/acp-bridge.ts" } as const;
/** The node arguments that start one of the program's helper processes, either way it runs. */
export function nodeArgs(name: keyof typeof SOURCES): string[] {
  return BUNDLED
    ? ["--no-warnings=ExperimentalWarning", join(here, `${name}.js`)]
    : ["--no-warnings=ExperimentalWarning", "--import", import.meta.resolve("tsx"), join(here, SOURCES[name])];
}

/**
 * How a harness starts the MCP relay. Always this node (the install script's private node is not on anyone's PATH).
 * From npx's cache the path would vanish when the cache is cleared, so then it asks npx for this exact version instead.
 */
export function mcpCommand(): { command: string; args: string[] } {
  if (!BUNDLED) return { command: process.execPath, args: [join(ROOT, "bin", "jobos-mcp.cjs")] };
  if (ROOT.split(sep).includes("_npx")) {
    const npx = ["-y", `zhiro@${VERSION}`, "mcp"];
    return process.platform === "win32" ? { command: "cmd", args: ["/c", "npx", ...npx] } : { command: "npx", args: npx };
  }
  return { command: process.execPath, args: [join(ROOT, "bin", "zhiro.cjs"), "mcp"] };
}
