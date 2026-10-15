# Architecture

Zhiro is one local process (the **daemon**, Node 22.13+, TypeScript) plus a web UI it serves, and an MCP server for the
person's own agent. One user, one machine, one data folder.

## Layers

Each layer only uses the ones below it.

```
access     UI (apps/desktop) · HTTP /api/tools · MCP (/mcp, `zhiro mcp`) · `zhiro data|vault` · the chat drawer's backends
             └────────────── all through one entry: callTool(name, input, actor) ──────────────┘
tools      registry.ts — validate input against the contract, decide the permission tier, confirm cards, undo, audit
business   service/ · recommenders/ · workflows/ · agent/   (pool, deadlines, matching, profile, resumes, applications,
           form filling, inbox, research)
data       data/ — readers (recruiting sites, sheets), subscriptions, ingest, the job catalog's identity rules, daily pull
base       db.ts (schema, migrations) · upgrade.ts · datadir.ts · lock.ts · config.ts · move.ts · service/workflow.ts
```

`packages/contracts` is the shared vocabulary: every tool's name, input and output (TypeBox), used by the daemon, the
UI and the MCP tool list alike.

The data layer stands alone (`data/boundary.test.ts`): nothing in `data/` imports from above, and everything above
enters through `data/index.ts`. `zhiro data …` runs it without the agent, the UI or a model.

## One way in: `callTool`

Every caller — the UI, MCP, HTTP, the built-in assistant, a harness answering in the chat drawer — ends in
`callTool(name, input, actor)` in `registry.ts`. **Who** the caller is comes from the key it holds, never from what it says:

| key (in `config/`) | who | can |
|---|---|---|
| `.daemon-token` (and the UI's session cookie) | the person | everything |
| `.agent-token` (MCP, HTTP) | an agent | read; write by tier (below) |
| a per-turn token | a harness answering one chat message | same as an agent, for that turn |
| `.capture-key` | the bookmarklet | capture a page |

An agent's writes fall in three tiers (`service/tiers.ts`):

- **just do it, undoably** — local and reversible (watch a job, tag, prepare an application, add a profile card): done,
  recorded in `agent_action`, the person can undo it;
- **ask first** — has an effect outside or is hard to take back (close, delete, send, research on the web, bulk): becomes
  a **confirm card** the person decides (in the UI, or — by default — in their own agent after they say yes);
- **never** — model logins, credentials.

The form-filling browser may be driven by an agent, but **nothing ever presses Submit**.

## Data

Three kinds, with fixed homes:

| kind | examples | where |
|---|---|---|
| observations | what a source returned on one pull, a captured page | immutable files under `snapshots/`, `captures/` + `source_listing`, `scan_run` |
| state | companies, campaigns, positions, applications, confirm cards, workflows | SQLite (`jobos.db`) |
| knowledge | profile cards, research reports, resumes | files in the data folder, the database indexes them |

Sources only produce observations; `data/ingest.ts` is the one way they become state. Ingest is incremental: unchanged
rows are only marked as seen.

## Processes

- **daemon** (`zhiro`, or `pnpm dev`): HTTP on `127.0.0.1:8787`, the scheduler (`service/workflow.ts`: SQLite table,
  leases, retries; daily pulls, deadline reminders, inbox), the UI files at `/app/`. It takes an exclusive lock on the
  data folder (`lock.ts`: a named pipe / unix socket, freed by the OS when the process ends).
- **`zhiro mcp`**: a stdio relay to the daemon's `/mcp`. One MCP implementation, in the daemon.
- **chat drawer backends** (`agent/backends/`): the person's Claude Code or Codex run headless per message, or any
  ACP agent through `acp-bridge.ts`, each with a per-turn token; or the built-in assistant (`agent/career.ts`, on
  `@earendil-works/pi-ai`), optional.
- **research workers** (`agent/worker.ts`): a harness in a sandbox folder `runs/<id>/` with only web tools and the
  data tools of `mcp/research-data.ts`; results come back through tools, checked.

## Start-up

`main.ts`: find the data folder (`datadir.ts`: `--data`, `ZHIRO_DATA`, the remembered choice, the old JobOS place, the
platform default) → finish a requested move (`move.ts`) → take the lock (no lock, no start) → **upgrade the database if
the program is newer** (`upgrade.ts`) → open → schedule → serve.

## Upgrades

The live database is never migrated in place. `upgrade.ts` copies it (`VACUUM INTO`), migrates the copy, compares it
with the original (every table's row count, the person's own rows row by row, the expected tables / indexes /
triggers, integrity, foreign keys), and only then swaps the files, keeping the original as
`backups/pre-v<old>-v<new>-<time>.db` with a manifest (versions, SHA-256, counts). A journal (`upgrade.json`) makes a
swap cut short finish or undo at the next start. `openDb` refuses an older or newer schema before writing anything.
`zhiro vault verify` / `rollback` are the manual side. Every release that adds a migration ships a synthetic sample
(`apps/daemon/test/fixtures/vault-v<N>.zip`); the upgrade test opens every older sample with the current code.

## Packaging

`pnpm build` bundles the daemon with esbuild into `out/npm/dist/` next to the UI and the agent skill; `paths.ts` is the
only place that knows the two layouts (source tree, package). `bin/zhiro.cjs` checks the Node version first.
`scripts/smoke.mjs` installs the packed package into an empty folder and runs it end to end.
