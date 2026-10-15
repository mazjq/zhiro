<div align="center">

# Zhiro · 职路

**Local-first AI career research and job hunting — with the agent you already use.**

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/mazjq/zhiro/actions/workflows/ci.yml/badge.svg)](https://github.com/mazjq/zhiro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mazjq/zhiro)](https://www.npmjs.com/package/@mazjq/zhiro)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

Zhiro keeps your whole job hunt in one place on your own computer: which companies are hiring, what fits you, what
closes this week, where each application stands — and lets your own AI agent (Claude Code, Codex, WorkBuddy, or any
MCP client) research industries and companies, track things for you and fill in application forms, **without ever
pressing Submit for you**. It is built first for campus recruiting in China (校招), and works for any job search.

![Zhiro: jobs ranked against your profile](docs/assets/jobs.png)

| Today: what closes soon, what waits for you | Applications: every stage, with the job's own requirements |
|---|---|
| ![Today](docs/assets/today.png) | ![Applications](docs/assets/pipeline.png) |

<sub>Screenshots use made-up data.</sub>

## What it does

- **One job pool, always fresh.** Reads companies' own recruiting sites (Moka, Beisen, Feishu Jobs, Dayee, 51job,
  Zhaopin, iGuopin, and more) and your own spreadsheets (Feishu Base, CSV links or files), every day. Deadlines are
  reconciled across sources, and each one says where it came from.
- **What fits you.** Your profile is a set of small, checkable cards (education, skills, projects, preferences); jobs
  are matched against them, and gaps become directions to grow in, not silent filters.
- **Today.** What closes in the next 14 days, what changed, and the few things waiting for your decision.
- **Applications.** Watch → prepare → applied → tests and interviews → result, with reminders and an inbox that
  turns recruiting mail into suggestions.
- **Form filling up to Submit.** A separate Chrome profile fills in application forms from your profile and the
  right resume; it stops before *Submit*, and you press it.
- **Research with your own agent.** Ask about an industry or a company; your agent searches the web and gets
  financial and industry data through Zhiro's tools, and the report links back to the jobs in your pool.
- **Your agent, your rules.** Reversible actions happen and can be undone; anything with consequences becomes a card
  you confirm; logins and credentials are never an agent's to touch.
- **Your data stays yours.** Everything is in one folder on your machine. Upgrades run on a copy and are checked
  before they replace anything; one command verifies, one rolls back.

## Install

**Have Node 22.13 or newer?**

```bash
npx @mazjq/zhiro                 # try it
npm i -g @mazjq/zhiro && zhiro   # keep it (the command is `zhiro`)
```

**No Node?** One line installs everything it needs (its own Node, checked against nodejs.org's checksums; your system
is not touched):

```powershell
# Windows (PowerShell)
irm https://github.com/mazjq/zhiro/releases/latest/download/install.ps1 | iex
```

```bash
# macOS / Linux
curl -fsSL https://github.com/mazjq/zhiro/releases/latest/download/install.sh | sh
```

<details><summary>Prefer to read the script first?</summary>

Download [`install.ps1`](https://github.com/mazjq/zhiro/releases/latest/download/install.ps1) or
[`install.sh`](https://github.com/mazjq/zhiro/releases/latest/download/install.sh), look at it, then run it. Running it
again upgrades; the previous version is kept.
</details>

**Want to change the code?** See [CONTRIBUTING.md](CONTRIBUTING.md): `git clone`, `pnpm install`, `pnpm dev`.

The first start asks where to keep your data (press Enter for the usual place), then opens the app in your browser.

### Let your agent install it

Paste this into Claude Code, Codex or any coding agent:

```text
Install Zhiro for me by following https://raw.githubusercontent.com/mazjq/zhiro/main/llms-install.md
(fetch it with curl, not a summarizer).
```

## Use it from your own agent

Zhiro is a set of MCP tools. Start Zhiro, then connect your agent once:

<details><summary>Claude Code</summary>

```bash
claude mcp add zhiro -- zhiro mcp            # Windows: claude mcp add zhiro -- cmd /c zhiro mcp
```
Or open Claude Code inside Zhiro's agent folder (shown on the settings page) — everything is set up there.
[More](docs/harness/claude-code.md)
</details>

<details><summary>Codex</summary>

```bash
codex mcp add zhiro -- zhiro mcp             # Windows: codex mcp add zhiro -- cmd /c zhiro mcp
```
[More](docs/harness/codex.md)
</details>

<details><summary>WorkBuddy, Cursor, and other MCP clients</summary>

[WorkBuddy](docs/harness/workbuddy.md) · [any MCP client](docs/harness/others.md)
</details>

Then just ask: *"What closes this week?"*, *"Watch the control-algorithm jobs in Wuhan"*, *"Research the humanoid
robot industry"*, *"Fill in the application for the first one."*

You can also pick which agent answers in Zhiro's own chat panel (Claude Code, Codex, or an optional built-in
assistant): [docs/harness/embedded.md](docs/harness/embedded.md).

## Your data

One folder, on your machine: `%APPDATA%\Zhiro\data` (Windows), `~/Library/Application Support/Zhiro` (macOS),
`~/.local/share/zhiro` (Linux), or wherever you chose. Nothing is uploaded; the only network traffic is the
recruiting sites you subscribe to and the agent or model you pick.

```bash
zhiro vault verify      # is everything intact?
zhiro vault backup      # a checked backup, any time
zhiro vault rollback    # back to before the last upgrade
```

More: [docs/data.md](docs/data.md) · Bring your own spreadsheet: [docs/data-sources.md](docs/data-sources.md)

## Documentation

| | |
|---|---|
| [docs/data.md](docs/data.md) | Where your data is; backup, upgrade, rollback, moving to another disk |
| [docs/data-sources.md](docs/data-sources.md) | Subscribe to your own sheet (Feishu Base, CSV) |
| [docs/harness/](docs/harness/) | Claude Code, Codex, WorkBuddy, DeepSeek (dsh), other MCP clients |
| [docs/contrib/](docs/contrib/) | Architecture and design decisions, for contributors |

Most user docs are in Chinese for now; PRs translating them are welcome.

## Contributing

Bug reports, recruiting sites to support, and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md).
Adding a recruiting site is one file plus a test ([how](apps/daemon/src/data/readers/README.md)).
Security issues: please report privately ([SECURITY.md](SECURITY.md)).

## License

[MIT](LICENSE). The Moka reader includes three files from [career-ops](https://github.com/career-ops-hq/career-ops)
(MIT).
