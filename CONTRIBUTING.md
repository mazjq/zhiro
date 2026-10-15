# Contributing / 参与开发

Issues and pull requests are welcome, in English or Chinese. 中英文都可以。
For anything bigger than a fix, open an issue first so we can agree on the shape before you write it.
改动较大时先开 issue 讨论，再动手。

## Set up / 开发环境

You need Node **22.13+** and pnpm (`corepack enable` gives you the pinned version).

```bash
git clone https://github.com/mazjq/zhiro && cd zhiro
pnpm install          # also installs the pre-commit check (.githooks)
pnpm dev              # daemon on http://127.0.0.1:8787, from source (tsx)
pnpm --filter @zhiro/desktop dev   # the UI with hot reload (vite), talks to the daemon
```

Use a throwaway data folder while developing so your own data stays untouched:
`ZHIRO_DATA=/tmp/zhiro-dev pnpm dev` (PowerShell: `$env:ZHIRO_DATA="$env:TEMP\zhiro-dev"; pnpm dev`).
Port taken? `ZHIRO_PORT=8788`.

## Before you push / 提交前

```bash
pnpm lint && pnpm typecheck && pnpm test
pnpm build && pnpm smoke        # the npm package installs and runs (slow: installs from npm)
pnpm check:clean                 # nothing personal or secret in the repository
```

CI runs all of this on Windows, macOS and Linux with Node 22.13 and 24; a PR merges only when it is green.

## Where things are / 代码在哪

```
apps/daemon/src/
  main.ts            start-up: data folder → lock → upgrade → open → serve
  registry.ts        every tool: one entry point callTool(name, input, actor); permissions, confirm cards, undo, audit
  http.ts, mcp/      HTTP API, MCP (for your own agent), the UI files
  data/              the data layer: readers (recruiting sites, sheets), subscriptions, ingest, daily pull
  service/           business logic: pool, deadlines, recommendations, profile, resumes, applications, inbox, research
  agent/             chat backends (Claude Code, Codex, built-in), research workers
  db.ts, upgrade.ts  schema and migrations; upgrades on a copy, checked before they replace anything
  datadir.ts         where the data folder is
packages/contracts   tool contracts (TypeBox): names, inputs, outputs — the vocabulary every layer shares
apps/desktop         the UI (React + Tailwind; the daemon serves the built files at /app/)
agent-skills/zhiro   the skill text given to Claude Code / Codex / WorkBuddy
```

More: [docs/contrib/architecture.md](docs/contrib/architecture.md).

## Rules that keep data safe / 守住数据的几条规矩

1. **A new tool** = contract in `packages/contracts` → handler in `registry.ts` → test. No side doors in `http.ts`.
2. **Agents never act irreversibly.** Writes by an agent are either undoable (recorded, the person can undo) or become a
   confirm card the person decides. Nothing ever presses *Submit* on an application or sends a message by itself.
3. **The database changes only by migration**, appended at the end of `MIGRATIONS` in `db.ts` (never edit a shipped
   one). Then run `pnpm --filter @zhiro/daemon make-fixture` and commit the new `test/fixtures/vault-v<N>.zip`: the
   upgrade test opens every older sample with your code and checks that nothing was lost. A migration that changes
   row counts on purpose says so in `COUNTS_MAY_CHANGE`.
4. **Nothing personal in the repository** — no real data, keys, links to private sheets, names. Tests use made-up data
   (`apps/daemon/src/eval/seed.ts` has a whole fictional world). `pnpm check:clean` and CI enforce it.
5. **The data layer stands alone** (`data/` imports nothing above it; others enter through `data/index.ts`). A test
   guards this.

## Adding a recruiting site or a sheet type / 加一个招聘站或表格

One file in `apps/daemon/src/data/readers/`, one line in its `index.ts`, one test next to it — see
[that folder's README](apps/daemon/src/data/readers/README.md).

## Releases / 发版

`main` is always releasable. release-please keeps a release PR with the next version and the changelog; merging it
tags the release, and CI publishes the npm package and attaches the install scripts.
