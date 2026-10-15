/**
 * The agent directory (ADR-047): `<vault>/agent/`, written at every daemon start. The person opens their own harness
 * *in this directory* and Zhiro is there — the MCP server and the skill, in each harness's project-level place — and
 * nowhere else: nothing is installed into anyone's global settings. The files hold no token (the forwarder reads
 * .agent-token itself) and no user data; only paths.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ROOT, SKILL_FILE, mcpCommand } from "../paths.js";

export const repoRoot = (): string => ROOT;

/** The one skill text, from agent-skills/jobos/SKILL.md; its three copies are what each harness looks for. */
const SKILL_PLACES = [".claude/skills/zhiro", ".agents/skills/zhiro", ".workbuddy/skills/zhiro"];
/** Written by JobOS before the rename: removed so the harness does not see the skill twice. */
const OLD_SKILL_PLACES = [".claude/skills/jobos", ".agents/skills/jobos", ".workbuddy/skills/jobos"];

export function writeAgentDir(vault: string, url: string): string {
  const dir = join(vault, "agent");
  const launch = mcpCommand();
  const skill = readFileSync(SKILL_FILE, "utf8");
  const env = (actor: string) => ({ JOBOS_VAULT: vault, JOBOS_URL: url, JOBOS_ACTOR: actor });
  const toml = (o: Record<string, string>) => Object.entries(o).map(([k, v]) => `${k} = ${JSON.stringify(v)}`).join("\n");
  const w = (rel: string, text: string) => { const p = join(dir, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, text, "utf8"); };

  // Claude Code: project-level MCP + project skill
  w(".mcp.json", JSON.stringify({ mcpServers: { zhiro: { command: launch.command, args: launch.args, env: env("claude") } } }, null, 2) + "\n");
  // Codex: project-level config (asks once to trust the directory) + the documented project skill place
  w(".codex/config.toml", `[mcp_servers.zhiro]\ncommand = ${JSON.stringify(launch.command)}\nargs = ${JSON.stringify(launch.args)}\n\n[mcp_servers.zhiro.env]\n${toml(env("codex"))}\n`);
  // WorkBuddy reaches custom MCP servers only over HTTP through its connector proxy (a stdio entry is listed but never
  // started — seen 2026-10-13), so it gets the daemon's /mcp with the agent key in the header. The key is the same file
  // as config/.agent-token next door; this directory lives inside the vault.
  let agentKey = "";
  try { agentKey = readFileSync(join(vault, "config", ".agent-token"), "utf8").trim(); } catch { /* not created yet: the entry is written without it */ }
  // WorkBuddy strips an Authorization header from a custom server's config (its sanitizeMcpServerConfig), so the key
  // travels as x-jobos-key, which the daemon accepts the same way
  w(".workbuddy/mcp.json", JSON.stringify({ mcpServers: { zhiro: { url: `${url}/mcp`, headers: { ...(agentKey ? { "x-jobos-key": agentKey } : {}), "x-jobos-actor": "workbuddy" } } } }, null, 2) + "\n");
  for (const p of SKILL_PLACES) w(join(p, "SKILL.md"), skill);
  for (const p of OLD_SKILL_PLACES) rmSync(join(dir, p), { recursive: true, force: true });
  w("AGENTS.md", "这是 Zhiro 的 agent 工作目录。求职相关的事用 MCP 工具 `zhiro`；怎么用见技能 zhiro（.agents/skills/zhiro/SKILL.md）。这里没有代码，不要在这里建文件。\n");
  w("README.md", [
    "# Zhiro 的 agent 工作目录",
    "",
    "在这个目录里打开你自己的 agent，它就能用 Zhiro；离开这个目录就都不在，你各家的全局设置不受影响。每次 Zhiro 启动都会重写这里的文件，不要手改。",
    "",
    "- Claude Code：`cd` 到这里再 `claude`（首次会问是否启用 `.mcp.json` 里的 zhiro，选是）。",
    "- Codex：`cd` 到这里再 `codex`（首次会问是否信任这个目录，选是）。",
    "- WorkBuddy：用「打开文件夹」打开这个目录。",
    "",
    "然后说一句试试：「今天有什么截止的」。确认和撤销默认都在你的 agent 里完成。你在这里发起的、要 AI 的事（画像匹配、整理邮件、联网调研）由你的 agent 自己做；Zhiro 窗口里改过的东西，会在工具返回的 `changedByUser` 里告诉它。",
    "",
    `daemon：${url}；数据目录：${vault}`,
    "",
  ].join("\n"));
  return dir;
}
