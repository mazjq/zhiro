# Design decisions

The decisions that still shape the code, each with the reason. New ones are appended at the end (`D-<n> · date · title`,
then what was decided and why). The project's history before it went public is not part of this repository; these
entries condense what still holds.

## Trust and permissions

- **D-1 · The person decides anything irreversible.** Nothing submits an application, sends a message or deletes the
  person's data by itself. Form filling stops before *Submit*; inbox mail only produces suggestions.
  *Why:* a wrong application or message cannot be taken back; being slower is cheaper than being wrong.
- **D-2 · One entry point, permissions decided there.** Every caller goes through `callTool`; an agent's writes are
  *done undoably*, *asked first* (a confirm card), or *refused* (logins, credentials). *Why:* the same rules hold for
  the UI, MCP, HTTP and every harness, with no side door.
- **D-3 · Identity comes from the key.** Four keys (person, agent, per-turn, bookmarklet); `x-jobos-actor` is only an
  audit label. *Why:* an agent saying "I am the user" must not make it the user.
- **D-4 · A confirm card counts as approved only when its work is done.** A card whose work was running when the
  daemon stopped is shown as interrupted and never re-run by itself.
- **D-5 · Agents may confirm and undo their own cards in the person's own agent** (after the person says yes, within
  30 minutes); this can be limited to the Zhiro window.

## The person's own agent

- **D-6 · Zhiro is a set of tools any agent can use.** The person picks the harness (Claude Code, Codex, WorkBuddy, an
  ACP agent, or the optional built-in assistant); the model is whatever that harness is set to. Business state lives
  only in the data folder, never in a harness's memory. *Why:* switching harness loses nothing.
- **D-7 · Whoever starts model work does it.** Work an external agent starts (matching, research, mail sorting) goes
  back to that agent; Zhiro does not call another model behind its back. Background tidying may use the built-in model
  to save the agent's tokens (on by default, can be turned off).
- **D-8 · One MCP implementation, in the daemon** (`/mcp`); `zhiro mcp` only relays.
- **D-9 · The agent directory** (`<data>/agent`) holds each harness's project-level config and the skill; nothing is
  written into anyone's global settings.

## Data

- **D-10 · Local first, one data folder, one writer.** SQLite through Node's built-in `node:sqlite` (no native module);
  an exclusive lock per folder. *Why:* one install step, nothing to compile, no lost updates.
- **D-11 · Tools built in, data not.** Lists of companies, links to anyone's spreadsheets, profiles: the person's own
  data, never shipped in the repository.
- **D-12 · Readers follow schema.org/JobPosting fields and the career-ops provider shape.** A new site is one file, one
  registry line and one test in `data/readers/`.
- **D-13 · Sources do not overwrite each other.** Each source's statement is kept with its grade (official vs
  aggregated); reading merges them by grade. Deadlines are resolved in one place (facts → resolution → wording).
- **D-14 · Sheets are subscriptions with a column mapping stored in the subscription**, previewed before they are
  saved; a local file is handed over by the person, never picked by an agent without a confirm card.
- **D-15 · A subscription that exists is always pulled**; failures are retried on schedule and shown, not silently
  dropped.
- **D-16 · Ingest is incremental**: unchanged rows are only marked as seen; an unchanged table is not snapshotted again.

## Upgrades and installs

- **D-17 · Upgrades run on a copy.** The original database is never migrated in place; the copy is checked (row
  counts, the person's rows, structure, integrity) before it replaces anything, and the original is kept with a
  manifest. `verify` and `rollback` are commands. Every schema ships a synthetic sample the next release must upgrade.
- **D-18 · One answer for where the data is** (`--data`, `ZHIRO_DATA`, the remembered choice, the old JobOS place,
  the platform default); a place that should hold data but cannot be reached stops the start rather than opening an
  empty folder elsewhere.
- **D-19 · The data folder can move to another disk**: copied, every file compared, switched only when all match; the
  old path stays as a link so stored paths keep working.
- **D-20 · Ship built JavaScript, one `zhiro` command**; `paths.ts` is the only code that knows where the program's
  own files are.
- **D-21 · The rename to Zhiro changed names people see**, not names in the data (`jobos.db`, `config/jobos.yaml`,
  key files, `x-jobos-*` headers) — renaming those would risk data for nothing.

## Agent token use

- **D-22 · 2026-10-15 · List tools have a short form, asked for explicitly.** `position.list`, `application.list` and
  `pool.list` take `detail: "brief"`: no job descriptions or other long texts; a deadline keeps what a decision needs
  (`closesAt`, `deadlineKind`, `expired` — `null` when unknown, never `false` — `status`, `say`); `pool.list` pages by 20 companies
  and lists every post whose title has the search words (the search reads company names and post titles, not
  descriptions) and every post the profile matched (`matchedPositions` with `matchedBy`, compact, up to 50 a company —
  `positionsLimit` raises it for one company), the others by count. Leaving `detail` out returns exactly what it always did — agents in
  the wild depend on it; Zhiro's own skill, chat-drawer rules and built-in assistant ask for the short form and tell
  the agent to page while `hasMore`. *Why:* measured on a real database, one `pool.list` was about a million tokens
  (every company carried all its posts). *Not at the cost of finding things:* on 12 real queries, the short form
  followed as the skill says (pages, then `positionsLimit` for a company with `matchedHasMore`) reached 100% of the
  companies and matched posts of the full result, with 5–30% of its tokens; deadlines agreed in every case. A first
  version showing 3 previews per company reached only 8–56% of the matched posts and was dropped. With Claude Code
  answering 8 questions twice each (before vs after, the same copy): 12/16 right vs 8/16, list recall 100% vs 85%,
  precision 95% vs 79%, 3.5 vs 8.1 tool calls, about 290,000 vs 890,000 input tokens — no question did worse. New fields have new
  names: an old name never changes meaning.
- **D-23 · 2026-10-15 · One copy of each result, for a connection that asks.** By default a tool result carries the
  JSON both as text and as `structuredContent` (what MCP asks for). Claude Code gives its model the structured copy
  only; Codex gives it both (measured with differing markers), which roughly doubles every result. A connection with
  header `x-zhiro-result-mode: text` — set by the stdio relay from `ZHIRO_RESULT_MODE=text`, which Zhiro writes into
  its Codex configs — gets the text copy only. Not the structured copy only: given `content: []`, Codex's model took
  the result for empty in three runs of four, while text-only was read right every time. Never inferred from a
  client's name or the audit label.
