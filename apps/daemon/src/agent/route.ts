/**
 * Who does the AI work nobody is waiting on in a chat (ADR-057): the background tidying (mail, notices, documents, form
 * fields, fit) and research started from the Zhiro window or by a schedule. Work an external agent started inside its
 * own tool call is that agent's (usage.ts `callingAgent`) and never comes here.
 *
 * The target is decided first; if it cannot answer now the call fails with the reason — it is not handed to someone
 * else behind the person's back. The one exception is the queue for the person's own agent, which is what "no model of
 * our own" has always meant (ADR-032) and which the settings page says.
 */
import { isExternal } from "../llm.js";
import type { Services } from "../services.js";
import { claudeLauncher } from "./backends/claude.js";
import { codexLauncher } from "./backends/codex.js";
import { backendOf } from "./backend.js";

export type BackgroundTarget =
  | { kind: "model" }                                   // Zhiro's built-in model (the model service on the settings page)
  | { kind: "harness"; name: "claude" | "codex" }      // the chosen harness, run once with no tools
  | { kind: "waiting" }                                 // queued for the person's own agent (llm.pending)
  | { kind: "unavailable"; why: string };

/** The settings switch 「后台整理改用内置模型」: on unless the person turned it off. */
export const backgroundOnModel = (s: Services) => s.config.llm.forBackground !== false;

export function backgroundTarget(s: Services): BackgroundTarget {
  const builtIn = (): BackgroundTarget => (isExternal(s.config.llm.provider) || s.llm?.loggedIn === false ? { kind: "waiting" } : { kind: "model" });
  if (backgroundOnModel(s)) return builtIn();
  const b = backendOf(s);
  if (b === "claude") return claudeLauncher() ? { kind: "harness", name: "claude" } : { kind: "unavailable", why: "选的是 Claude Code，但没找到它的命令行" };
  if (b === "codex") return codexLauncher() ? { kind: "harness", name: "codex" } : { kind: "unavailable", why: "选的是 Codex，但没找到它的命令行" };
  if (b === "builtin") return builtIn();
  return { kind: "unavailable", why: `${b} 还不能做后台整理：在配置页打开「后台整理改用内置模型」` };
}

export type ResearchTarget = { kind: "worker"; runner: "claude" | "codex" } | { kind: "waiting" };

/** Research started from the window or a schedule: by the chosen harness's research worker; Claude Code's for everyone else. */
export function researchTarget(s: Services): ResearchTarget {
  if (backendOf(s) === "codex" && codexLauncher()) return { kind: "worker", runner: "codex" };
  if (claudeLauncher()) return { kind: "worker", runner: "claude" };
  return { kind: "waiting" };
}

/** One line for the settings page. */
export function describeBackground(s: Services): string {
  const t = backgroundTarget(s);
  if (t.kind === "model") return `内置模型（${s.config.llm.provider} · ${s.config.llm.model}）`;
  if (t.kind === "harness") return t.name === "claude" ? "Claude Code（不给任何工具）" : "Codex（不给任何工具）";
  if (t.kind === "waiting") return "内置模型没登录：排队等你自己的 AI 助手来做";
  return `做不了：${t.why}`;
}
