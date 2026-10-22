# AGENTS.md — for coding agents working on this repository

You are changing Zhiro's code. (Using Zhiro to hunt for jobs is different: that is `agent-skills/zhiro/SKILL.md`.)
Read [CONTRIBUTING.md](CONTRIBUTING.md) and [docs/contrib/architecture.md](docs/contrib/architecture.md) first.

## Never

1. **Touch a real data folder.** Develop and test with a throwaway one (`ZHIRO_DATA=<temp dir>`). Never read, copy or
   edit someone's `jobos.db`, `config/` keys or `credentials.json`; never write the database directly — business writes
   go through the tools (`callTool`).
2. **Commit anything personal or secret**: real names, resumes, application details, keys, links to private sheets,
   paths on your machine. Tests use made-up data (`apps/daemon/src/eval/seed.ts`). `pnpm check:clean` must pass —
   and so must every commit you push (the pre-push hook and CI run `check-clean --commits`: a key committed and then
   deleted is still public once pushed). Commit as your GitHub noreply address, never a personal e-mail.
   Data and code stay apart: the daemon refuses a data folder inside the program's own folder.
3. **Make the program act irreversibly on its own**: no pressing *Submit*, no sending, no deleting the person's data
   without a confirm card the person decides.
4. **Edit a shipped migration.** Append to `MIGRATIONS` in `apps/daemon/src/db.ts`, then
   `pnpm --filter @zhiro/daemon make-fixture` and commit the new sample.

## How

- A tool = contract in `packages/contracts/src/index.ts` → handler in `apps/daemon/src/registry.ts` → test. Tool names
  and their inputs / outputs only grow; agents in the wild call them.
- A recruiting site or sheet type = one file + one registry line + one test in `apps/daemon/src/data/readers/`.
- `data/` imports nothing from above it; code outside enters through `data/index.ts`.
- Paths of the program's own files come from `apps/daemon/src/paths.ts` only.
- Before you say done: `pnpm lint && pnpm typecheck && pnpm test`; for packaging changes also `pnpm build && pnpm smoke`.
  Type errors: trust `tsc --noEmit`, not the editor.

## Commands

```bash
pnpm install
pnpm dev                                   # daemon from source on :8787 (ZHIRO_PORT to change)
pnpm --filter @zhiro/daemon test           # all daemon tests (vitest); test:data = the data layer only
pnpm --filter @zhiro/daemon data probe <url-or-file>   # what a reader gets from a link, without writing
pnpm build && pnpm smoke                   # the npm package, installed into an empty folder and run
```
