<div align="center">

# Zhiro · 职路

An open-source job-search tool that runs on your own computer and works with the AI agent you already use.

English | [简体中文](README.zh-CN.md)

[![CI](https://github.com/mazjq/zhiro/actions/workflows/ci.yml/badge.svg)](https://github.com/mazjq/zhiro/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/@mazjq/zhiro)](https://www.npmjs.com/package/@mazjq/zhiro)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

I built Zhiro while looking for a job myself. Sending applications is the easy part. The hard part is knowing where to
send them: which jobs actually fit, whether the skills I'm missing are worth learning, and what a company is like
beyond its job ad.

Zhiro keeps all of that in one place: your profile, a job pool that refreshes every day, and companies' financials and
announcements. It also tracks what happens after you apply. It works with Claude Code, Codex, WorkBuddy or any MCP
client. It was built for campus recruiting in China (校招) first, and works for other job searches too.

![Zhiro: jobs ranked against your profile](docs/assets/jobs.png)

<sub>Every company, job and number in the screenshots is made up.</sub>

## Why Zhiro

### 1. Opportunity gaps: what you're missing

Job filters drop the jobs you "don't match", so you never learn what stood in the way. Zhiro keeps every job related to
your work, picks out the requirements your profile doesn't show yet, groups them by skill, and counts how many jobs
and companies each one blocks.

Most gaps only mean your profile is silent, not that you can't do it. Click *I can do this* or *haven't done this* and
the matching runs again. In the screenshot below, C++ is required by 4 of the jobs and ROS by 2.

![Opportunity gaps: how many jobs each skill blocks](docs/assets/gaps.png)

### 2. Look at the company itself

Job ads all read the same. To judge a company you need its numbers and its announcements, so Zhiro gives your agent
data tools for them:

- Listed companies (A-shares, Hong Kong, US, NEEQ): three years of revenue, net profit, growth, gross margin, R&D
  spending, headcount, and cash paid per employee.
- A year of announcements: equity incentives and employee share plans, expansion, government grants, "专精特新"
  (specialised niche) status, insider share sales. 专精特新 firms are often the hard-to-replace link in a supply chain.
- Industries: the listed companies in a sector, recent broker reports, and US salary statistics from the BLS.

Ask your agent to research an industry or a company and it writes a report from these tools plus web search. Each
claim names its source, and Zhiro checks the numbers in it against the data that was fetched. Companies the report
mentions are matched to your job pool, so their open jobs are one click away.

![A research report: key points, their sources, the companies it names](docs/assets/research.png)

<img src="docs/assets/company-intel.png" alt="A company's card: financials, R&D, pay per employee" width="520">

### 3. Jobs and deadlines

The job pool refreshes every day. It reads companies' own recruiting sites (Moka, Beisen, Feishu Jobs, Dayee, 51job,
Zhaopin, iGuopin and more) and your own spreadsheets (Feishu Base, CSV). When sources give different deadlines, Zhiro
compares them, and every deadline says where it came from and whether it has been verified.

Jobs are matched against your profile, which is a set of small cards for education, skills, projects and preferences
that you can edit any time.

| Today: what closes soon, what waits for you | Your profile: one source for matching, resumes and forms |
|---|---|
| ![Today](docs/assets/today.png) | ![Profile](docs/assets/profile.png) |

### 4. After you apply

Each application's stage is tracked (watching, preparing, applied, tests and interviews, result), with reminders. The
inbox reads recruiting mail, spots test and interview invitations, works out which application each one belongs to,
and asks before updating it.

Zhiro can also fill in application forms. It uses a separate Chrome profile, fills the form from your profile and the
right resume, and stops before *Submit*. You press it yourself.

| Applications: every stage, with the job's own requirements | Inbox: recruiting mail turned into next steps |
|---|---|
| ![Applications](docs/assets/pipeline.png) | ![Inbox](docs/assets/inbox.png) |

### 5. What the agent may do, and where your data lives

An agent only acts directly when the action can be undone. Anything with consequences becomes a card you confirm.
Logins and passwords are out of its reach.

Your data lives in one folder on your computer. Upgrades run on a copy and replace the original only after the copy
checks out. If something goes wrong, one command takes you back to before the upgrade.

## Install

**Have Node 22.13 or newer?**

```bash
npx @mazjq/zhiro                 # try it
npm i -g @mazjq/zhiro && zhiro   # keep it (the command is `zhiro`)
```

**No Node?** One line installs it. The script brings its own Node (checked against nodejs.org's checksums) and leaves
your system alone:

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
Or open Claude Code inside Zhiro's agent folder (shown on the settings page); everything is set up there.
[More](docs/harness/claude-code.md)
</details>

<details><summary>Codex</summary>

```bash
codex mcp add zhiro --env ZHIRO_RESULT_MODE=text -- zhiro mcp
# Windows: codex mcp add zhiro --env ZHIRO_RESULT_MODE=text -- cmd /c zhiro mcp
# (ZHIRO_RESULT_MODE: Codex then gets each result once instead of twice, about half the tokens)
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

Bug reports, recruiting sites to support, and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).
Adding a recruiting site is one file plus a test ([how](apps/daemon/src/data/readers/README.md)).
Security issues: please report privately ([SECURITY.md](SECURITY.md)).

## License

[MIT](LICENSE). The Moka reader includes three files from [career-ops](https://github.com/career-ops-hq/career-ops)
(MIT).
