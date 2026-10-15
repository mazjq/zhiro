## What and why / 改了什么、为什么

<!-- One or two sentences. Link the issue: Fixes #123 -->

## How it was checked / 怎么验证的

- [ ] `pnpm lint && pnpm typecheck && pnpm test` pass
- [ ] A test covers the change (or: why not)
- [ ] If it touches the database: a migration was added at the end of `db.ts` and `pnpm --filter @zhiro/daemon make-fixture` was run
- [ ] No personal data, keys or private links (`pnpm check:clean`)
