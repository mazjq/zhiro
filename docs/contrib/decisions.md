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
