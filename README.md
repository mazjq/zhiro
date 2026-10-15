<div align="center">

# Zhiro · 职路

**Find the best career path open to you — not just the next job.**

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/mazjq/zhiro/actions/workflows/ci.yml/badge.svg)](https://github.com/mazjq/zhiro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mazjq/zhiro)](https://www.npmjs.com/package/@mazjq/zhiro)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

Most job tools help you apply faster. Zhiro helps you choose better. It looks at three things together:

- **you** — what you can do and what you are missing;
- **the companies** — their financials, how much they invest in R&D, how they pay and reward their people, and whether
  their place in the industry is hard to replace;
- **the openings** — every relevant job, with its real deadline.

Then it keeps the whole job hunt moving, from finding a job to an offer. It runs on your own computer and works with the
AI agent you already use (Claude Code, Codex, WorkBuddy or any MCP client). It is built first for campus recruiting in
China (校招), and works for any job search.

![Zhiro: jobs ranked against your profile](docs/assets/jobs.png)

<sub>All screenshots use made-up data.</sub>

## Why Zhiro

### 1. See what to learn next, not just what you fail

Job filters quietly drop the jobs you "don't match". Zhiro turns them into **opportunity gaps**:

1. It collects the requirements, across all the jobs related to your work, that your profile does not show yet.
2. It groups them by skill and counts how many jobs, and how many companies, would open up if you had each one.
3. It labels each skill: *unknown* (your profile is silent), *transferable* (you have related experience), or a real
   gap you have confirmed.

So a long list of rejections becomes a short list of things worth learning next. Answer "I can do this" or "I haven't
done this", and the matching runs again.

### 2. Judge the company, not the job ad

A job ad says little about where a career goes. Zhiro gives you, and your agent, the data to judge the company
behind it:

- **Financials** of listed companies (A-shares, Hong Kong, US, NEEQ): revenue, net profit, growth, gross margin, R&D
  spending, headcount, cash paid per employee.
- **Signals from a year of announcements**: equity incentives and employee share plans, expansion and new capacity,
  government grants, "专精特新" (specialised niche leaders, often hard to replace in a supply chain), share sales by
  insiders.
- **Industry context**: the listed companies in a sector or theme, recent broker reports, and US salary statistics
  (BLS) for comparison.

Ask your agent to research an industry or a company. It uses these tools and the web, and writes a report you can
check. Each claim names its source. The report links back to the jobs in your pool, so "is this a good place to grow?"
becomes a question you can answer with evidence.

<img src="docs/assets/company-intel.png" alt="A company's card: financials, R&D, pay per employee" width="520">

### 3. Never miss what matters

- **One job pool, refreshed every day**: companies' own recruiting sites (Moka, Beisen, Feishu Jobs, Dayee, 51job,
  Zhaopin, iGuopin and more) and your own spreadsheets (Feishu Base, CSV).
- **Reconciled deadlines**: when sources disagree, Zhiro compares them; every deadline says where it came from and
  whether it has been verified.
- **Matching**: jobs are matched against your profile — small, checkable cards for education, skills, projects and
  preferences.

| Today: what closes soon, what waits for you | Your profile: one source for matching, resumes and forms |
|---|---|
| ![Today](docs/assets/today.png) | ![Profile](docs/assets/profile.png) |

### 4. Keep every application moving

- **The pipeline**: watch → prepare → applied → tests and interviews → result, with reminders.
- **An inbox that reads recruiting mail**: it recognises test and interview invitations, links each one to its
  application, and suggests the update for you to confirm.
- **Form filling up to *Submit***: a separate Chrome profile fills in application forms from your profile and the
  right resume, then stops. You press *Submit*.

| Applications: every stage, with the job's own requirements | Inbox: recruiting mail turned into next steps |
|---|---|
| ![Applications](docs/assets/pipeline.png) | ![Inbox](docs/assets/inbox.png) |

### 5. Your agent, your data, your rules

- **Safe agent actions**: anything an agent does that can be undone, it does, and you can undo it. Anything with
  consequences becomes a card you confirm. Logins and credentials are never an agent's to touch.
- **Local data**: everything stays in one folder on your computer. Upgrades run on a copy and are checked before they
  replace anything; one command verifies the data, one rolls back.

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
codex mcp add zhiro --env ZHIRO_RESULT_MODE=text -- zhiro mcp
# Windows: codex mcp add zhiro --env ZHIRO_RESULT_MODE=text -- cmd /c zhiro mcp
# (ZHIRO_RESULT_MODE: Codex then gets each result once instead of twice — about half the tokens)
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
