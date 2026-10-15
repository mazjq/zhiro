#!/usr/bin/env node
/**
 * `jobos-mcp`: the MCP stdio server any harness points at. Works from any directory: it finds the daemon package next to
 * itself and runs the forwarder (apps/daemon/src/mcp/stdio.ts) — from source under tsx while that is how the daemon
 * runs, or the built file once a build exists (dist/mcp/stdio.js; the packaging session swaps the entry, not the name).
 * Environment passes through: JOBOS_VAULT (which data directory's .agent-token), JOBOS_URL, JOBOS_ACTOR (an audit label).
 */
const { spawn } = require("node:child_process");
const { existsSync } = require("node:fs");
const { join } = require("node:path");

const daemon = join(__dirname, "..", "apps", "daemon");
const built = join(daemon, "dist", "mcp", "stdio.js");
const args = existsSync(built)
  ? ["--no-warnings=ExperimentalWarning", built]
  : ["--no-warnings=ExperimentalWarning", "--import", "tsx", join(daemon, "src", "mcp", "stdio.ts")];

const child = spawn(process.execPath, args, { cwd: daemon, stdio: "inherit", env: process.env, windowsHide: true });
child.on("exit", (code, signal) => process.exit(code ?? (signal ? 1 : 0)));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
