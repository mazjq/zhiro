import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeAgentDir, repoRoot } from "./agent-dir.js";

describe("the agent directory: one skill, three places, MCP for each harness, no secrets", () => {
  it("writes what Claude Code, Codex and WorkBuddy each look for, pointing at the launcher", () => {
    const vault = mkdtempSync(join(tmpdir(), "jobos-agentdir-"));
    const dir = writeAgentDir(vault, "http://127.0.0.1:8798");
    const skill = readFileSync(join(repoRoot(), "agent-skills", "zhiro", "SKILL.md"), "utf8");
    for (const p of [".claude/skills/zhiro/SKILL.md", ".agents/skills/zhiro/SKILL.md", ".workbuddy/skills/zhiro/SKILL.md"]) expect(readFileSync(join(dir, p), "utf8")).toBe(skill);
    expect(skill).toMatch(/^---\nname: zhiro\ndescription: /);
    const mcp = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8"));
    expect(mcp.mcpServers.zhiro.args[0]).toMatch(/bin[\\/]jobos-mcp\.cjs$/);
    expect(existsSync(mcp.mcpServers.zhiro.args[0])).toBe(true);
    expect(mcp.mcpServers.zhiro.env).toEqual({ JOBOS_VAULT: vault, JOBOS_URL: "http://127.0.0.1:8798", JOBOS_ACTOR: "claude" });
    const codex = readFileSync(join(dir, ".codex/config.toml"), "utf8");
    expect(codex).toMatch(/^\[mcp_servers\.zhiro\]\ncommand = ".+node(\.exe)?"\nargs = \[".*jobos-mcp\.cjs"\]\n\n\[mcp_servers\.zhiro\.env\]\nJOBOS_VAULT = ".*"\nJOBOS_URL = "http:\/\/127\.0\.0\.1:8798"\nJOBOS_ACTOR = "codex"\nZHIRO_RESULT_MODE = "text"\n$/);
    // WorkBuddy: HTTP only, with the agent key as a header (the one file in here that carries it)
    mkdirSync(join(vault, "config"), { recursive: true }); writeFileSync(join(vault, "config", ".agent-token"), "a".repeat(48), "utf8");
    writeAgentDir(vault, "http://127.0.0.1:8798");
    const wb = JSON.parse(readFileSync(join(dir, ".workbuddy/mcp.json"), "utf8")).mcpServers.zhiro;
    expect(wb).toEqual({ url: "http://127.0.0.1:8798/mcp", headers: { "x-jobos-key": "a".repeat(48), "x-jobos-actor": "workbuddy" } });
    // no token in the other files
    for (const p of [".mcp.json", ".codex/config.toml", "README.md", "AGENTS.md"]) expect(readFileSync(join(dir, p), "utf8")).not.toMatch(/token|[0-9a-f]{48}/i);
  });
});
