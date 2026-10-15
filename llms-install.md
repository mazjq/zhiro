# Installing Zhiro · 职路 — for AI agents

## For humans / 给人看

Paste this to your coding agent (Claude Code, Codex, Cline, …):

> Install Zhiro for me by following https://raw.githubusercontent.com/mazjq/zhiro/main/llms-install.md (fetch it with curl, not a summarizer).
>
> 按 https://raw.githubusercontent.com/mazjq/zhiro/main/llms-install.md 帮我安装 Zhiro（用 curl 取原文，不要用网页摘要）。

## For LLM agents

You are installing Zhiro, a local-first job-hunting app, on the user's own machine. It runs a local server (the
"daemon") on `127.0.0.1:8787` with a web UI and an MCP server. Talk to the user in the language they use.

### Step 0 — ask (one message, all at once)

1. Where should Zhiro keep their data? Default is fine for most people (Windows `%APPDATA%\Zhiro\data`, macOS
   `~/Library/Application Support/Zhiro`, Linux `~/.local/share/zhiro`). Never inside a git repository or a synced
   folder they have not chosen.
2. Which agent do they want to use Zhiro from (you, Claude Code, Codex, WorkBuddy, other)? You will connect it in step 4.

Detect the OS yourself.

### Step 1 — install

Check Node: `node --version`.

- **v22.13.0 or newer** → `npm install -g zhiro`
- **older, or no Node** → do not upgrade their Node; use the installer, which brings its own:
  - Windows (PowerShell): `irm https://github.com/mazjq/zhiro/releases/latest/download/install.ps1 | iex`
  - macOS / Linux: `curl -fsSL https://github.com/mazjq/zhiro/releases/latest/download/install.sh | sh`
  - It installs to `%LOCALAPPDATA%\Zhiro` or `~/.zhiro` and adds `zhiro` to the user's PATH. In the current shell,
    call it by full path: `%LOCALAPPDATA%\Zhiro\bin\zhiro.cmd` or `~/.zhiro/bin/zhiro`.

Verify: `zhiro --version` prints a version like `0.1.0`.

### Step 2 — start it

The daemon is a long-running process. Start it **in the background** (or ask the user to run it in a terminal of its
own) — do not block on it:

If the user chose a data folder other than the default, remember it first (every later start and `zhiro mcp` use it):

```bash
zhiro vault use "<folder>"
```

Then:

```bash
zhiro --no-open
```

Wait until `http://127.0.0.1:8787/health` answers `{"ok":true,…}` (curl it every second, up to a minute).
Its output contains a line `open the UI (link good once, 10 minutes): http://127.0.0.1:8787/api/launch?code=…` —
give that link to the user; it logs them in to the web UI.

If port 8787 is taken, start with `ZHIRO_PORT=8788`, use that port below, and give `zhiro mcp` the address too
(`ZHIRO_URL=http://127.0.0.1:8788` in the MCP server's environment).

### Step 3 — check

```bash
zhiro vault verify --quick
```

Prints `检查通过` ("check passed") on a fresh install.

### Step 4 — connect the user's agent

Zhiro's MCP server is the command `zhiro mcp` (stdio). It finds the running daemon and its key by itself.

- **Claude Code**: `claude mcp add zhiro -- zhiro mcp` (Windows: `claude mcp add zhiro -- cmd /c zhiro mcp`)
- **Codex**: `codex mcp add zhiro -- zhiro mcp` (Windows: `codex mcp add zhiro -- cmd /c zhiro mcp`)
- **WorkBuddy**: follow https://raw.githubusercontent.com/mazjq/zhiro/main/docs/harness/workbuddy.md
- **Anything else with MCP**: https://raw.githubusercontent.com/mazjq/zhiro/main/docs/harness/others.md
- Alternative needing no setup: open the agent inside Zhiro's agent folder, `<data folder>/agent` — the MCP config and
  the usage skill are already there.

A good first test once connected: call the `today.summary` tool.

### Step 5 — tell the user

- the UI link from step 2 (or: run `zhiro` in a terminal, it opens the browser itself);
- where their data is (`zhiro vault verify` prints it);
- that a model login is optional: their own agent does the AI work.

### Do not

- type, ask for, or store passwords, API keys or login codes — the user does logins themselves, in the Zhiro window;
- put the data folder in a repository, or copy files out of it;
- edit `jobos.db` or files under the data folder — use the tools;
- press Submit on any application form, or tell the user Zhiro will.

### If something fails

| message | meaning |
|---|---|
| `Zhiro 需要 Node 22.13 或更新` | use the installer (step 1), not their system Node |
| `数据目录已被…占用` | Zhiro is already running on that data folder — use it |
| `EADDRINUSE` / port in use | another program has 8787: `ZHIRO_PORT=8788` |
| `数据应该在 …，现在找不到` | the remembered data folder is on a disk that is not connected; ask the user, never delete the pointer file on your own |
