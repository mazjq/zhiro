/**
 * Agents that speak ACP natively, as chat backends (ADR-057's next step): each is a launch command; the turn itself is
 * acp-bridge.ts, which prints Claude-style JSON lines, so the runner and the parser are Claude Code's. Adding another
 * native ACP agent = one more entry here (and its name in BackendName).
 */
import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { nodeArgs } from "../../paths.js";
import { claudeSpec } from "./claude.js";
import type { CliSpec } from "./cli.js";

/** 「mcp__jobos__today_summary」「jobos/today.summary」「today_summary」→ today.summary; null when it is not a Zhiro tool. */
export const jobosTool = (title: string): string | null => {
  const m = /(?:^|mcp__|\b)jobos(?:__|[/:.\s]+)([A-Za-z][\w.]*)/i.exec(title);
  return m ? m[1].replace(/_/g, ".") : null;
};

/** dsh needs import.meta.main and zstd in zlib: Node 22.15 or later (2026-10-14 spike). */
export const nodeFitsDsh = (v = process.versions.node) => { const [a, b] = v.split(".").map(Number); return a > 22 || (a === 22 && b >= 15); };

export function dshLauncher(): { cmd: string; args: string[] } | null {
  const bin = process.env.JOBOS_DSH_CLI ?? join(process.env.APPDATA ?? join(process.env.HOME ?? "", ".npm-global"), "npm", "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  return existsSync(bin) && nodeFitsDsh() ? { cmd: process.execPath, args: [bin, "--profile", "acp"] } : null;
}

export function acpSpec(name: CliSpec["name"], agent: () => { cmd: string; args: string[] } | null): CliSpec {
  return {
    name,
    launcher: () => (agent() ? { cmd: process.execPath, args: nodeArgs("acp-bridge") } : null),
    argv: ({ dir, sessionId, rulesFile, mcp, prompt }) => {
      const a = agent()!;
      const mcpFile = join(dir, "mcp.json"); // this turn's token: dead once the turn ends, overwritten next turn
      writeFileSync(mcpFile, JSON.stringify({ mcpServers: { jobos: mcp } }), "utf8");
      return { args: ["--mcp", mcpFile, "--rules", rulesFile, ...(sessionId ? ["--resume", sessionId] : []), "--", a.cmd, ...a.args], stdin: prompt };
    },
    parser: claudeSpec.parser,
  };
}

export const dshSpec = acpSpec("dsh", dshLauncher);
