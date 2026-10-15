import { updateConfig } from "../config.js";
import { ulid } from "ulid";
import type { ToolContract } from "@zhiro/contracts";
import type { Services } from "../registry.js";
import { DomainError, NotFound } from "./domain.js";
import { listPresets } from "../recommenders/preset.js";
import { isLocalPath } from "../data/index.js";

/** Tools whose only outward flow is the prompt to the model (and read-only fetches): when an external agent calls them it answers that prompt itself (ADR-032, ADR-057), so nothing leaves for anyone else. */
const MODEL_ONLY_EGRESS = new Set(["inbox.paste", "inbox.pull", "profile.import", "profile.scan", "document.reextract", "resume.analyze", "listing.capture", "research.company", "research.topic", "company.find", "intel.smeResearch", "fit.deep", "lead.resolve"]);

/**
 * ADR-025: what the assistant may do without asking. Three tiers for an agent's write:
 *   do    — local, reversible, free: executed at once, logged in agent_action, undoable from the chat
 *   ask   — irreversible / external / paid / bulk / an application in flight: a proposal (the confirm card)
 *   never — HUMAN_ONLY (credentials, model login, undo, agent mode) and proposal.decide; enforced in registry before this runs
 * The user's own list of must-ask: ① deleting data of an application in flight ② the submit button ③ sending.
 */
export type Tier = "do" | "ask";
export type AgentMode = "default" | "conservative";

export const agentMode = (s: Services): AgentMode => (s.config.agent?.mode === "conservative" ? "conservative" : "default");
export const maxWritesPerTurn = (s: Services): number => s.config.agent?.maxWritesPerTurn ?? 10;

const IN_FLIGHT = new Set(["submitted", "in_process", "closed"]);

/** `byAgent`: the caller is the person's own external agent (credential "agent"), which does the model work of its calls itself. */
export function tierOf(name: string, c: ToolContract, inp: any, s: Services, byAgent = false): Tier {
  if (agentMode(s) === "conservative") return "ask";
  // ADR-032: the application browser (open / start / pause / close) runs at once — the run never presses submit, which stays the user's own act
  if (name.startsWith("apply.") && name !== "apply.reference") return "do";
  if (byAgent && MODEL_ONLY_EGRESS.has(name)) return "do";
  const e = c.effects;
  if (!e.localWrite || e.externalAction || e.dataEgress || !e.reversible) return "ask";
  if (name === "import.csv" || name === "intel.smeImport") return "ask"; // one call, hundreds of rows
  if (name === "source.add" && isLocalPath(String(inp?.url ?? ""))) return "ask"; // a file on this machine is the person's to hand over
  if (name === "apply.reference") return "ask"; // the same: a document of theirs that forms will be filled from
  if (name === "application.update" && inp?.state) {
    // ① an application in flight, and any forward move (标记已投递 is the user's own act) — draft ⇄ cancelled is free
    const cur = s.domain.getApplication(String(inp.id)).state;
    if (IN_FLIGHT.has(inp.state) || IN_FLIGHT.has(cur)) return "ask";
  }
  return "do";
}

type Inverse = { name: string; input: unknown } | null;

/** Capture what an undo needs BEFORE the write; the inverse call is built once the output is known. */
export function undoPlan(name: string, inp: any, s: Services): (out: any) => Inverse {
  const db = s.domain.db;
  switch (name) {
    case "position.watch": {
      const p = db.prepare("select watch_priority, watch_note from position where id = ?").get(inp.positionId) as any;
      return () => (p ? { name, input: { positionId: inp.positionId, priority: p.watch_priority ?? 0, note: p.watch_note ?? "" } } : null);
    }
    case "recommend.tag": return (out) => ({ name: "recommend.untag", input: { companyId: out.companyId, tag: inp.tag } }); // ponytail: an older reason on the same tag is not restored
    case "recommend.untag": {
      const r = db.prepare("select reason, score from recommendation where company_id = ? and tag = ? order by created_at desc limit 1").get(inp.companyId, inp.tag) as any;
      return () => (r ? { name: "recommend.tag", input: { companyId: inp.companyId, tag: inp.tag, reason: r.reason, score: r.score } } : null);
    }
    case "application.create": return (out) => ({ name: "application.update", input: { id: out.application.id, state: "cancelled", closeReason: "撤销助手的操作" } });
    case "application.update": {
      const a = s.domain.getApplication(String(inp.id));
      return () => ({ name, input: { id: a.id, state: a.state, closeReason: a.closeReason, externalAppId: a.externalAppId, submittedAt: a.submittedAt ?? undefined, resumeLabel: a.resumeLabel, nextAction: a.nextAction, nextActionAt: a.nextActionAt ?? undefined } });
    }
    case "fact.upsert": {
      const prev = inp.id ? (db.prepare("select * from fact where id = ?").get(inp.id) as any) : undefined;
      // ponytail: a merge into an existing card (no id) is not undoable — the card only gained fields and a source
      return (out) => (out.created ? { name: "fact.remove", input: { id: out.fact.id } } : prev ? { name, input: { id: prev.id, kind: prev.kind, data: JSON.parse(prev.data_json), grade: prev.grade, statement: prev.statement } } : null);
    }
    case "fact.restore": return () => ({ name: "fact.remove", input: { id: inp.id } });
    case "preset.save": {
      const prev = inp.id ? listPresets(s).find((p: any) => p.id === inp.id) : undefined;
      return (out) => (inp.id ? (prev ? { name, input: prev } : null) : { name: "preset.remove", input: { id: out.preset.id } });
    }
    default: return () => null;
  }
}

function positionLabel(s: Services, id: string): string {
  try {
    const r = s.domain.db.prepare("select p.title, co.name from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id where p.id = ?").get(id) as any;
    return r ? `「${r.name} · ${r.title}」` : "一个岗位";
  } catch { return "一个岗位"; }
}

/** One line the user reads in the chat. */
function summarize(s: Services, name: string, inp: any, out: any): string {
  switch (name) {
    case "position.watch": return inp.priority > 0 ? `关注了${positionLabel(s, inp.positionId)}` : `取消关注${positionLabel(s, inp.positionId)}`;
    case "recommend.tag": return `打了标签「${inp.tag}」`;
    case "recommend.untag": return `去掉了标签「${inp.tag}」`;
    case "application.create": return `为${positionLabel(s, inp.positionId)}准备申请`;
    case "application.update": return inp.state === "cancelled" ? "标记为不投了" : inp.state === "draft" ? "重新准备申请" : inp.nextAction ? `记了待办：${inp.nextAction}` : "更新了申请";
    case "fact.upsert": return `画像：${inp.data?.field ?? inp.kind}${inp.data?.value ? " = " + inp.data.value : ""}`.slice(0, 80);
    case "fact.restore": return "恢复了一张事实卡";
    case "preset.save": return `搜索模式「${inp.name}」（${out?.hits ?? 0} 个岗位）`;
    case "stage.add": return `记了进展：${inp.kind}`;
    case "stage.update": return "更新了一个环节";
    default: return name;
  }
}

export interface AgentActionT { id: string; at: string; tool: string; input: unknown; summary: string; undoable: boolean; undoneAt: string | null }

export function recordAction(s: Services, actor: string, tool: string, input: unknown, inverse: Inverse, out: any, turnId?: string): AgentActionT {
  const id = ulid(), at = new Date().toISOString(), summary = summarize(s, tool, input, out);
  s.domain.db.prepare("insert into agent_action(id, at, actor, tool, input_json, summary, undo_json, turn_id) values (?,?,?,?,?,?,?,?)")
    .run(id, at, actor, tool, JSON.stringify(input), summary, inverse ? JSON.stringify(inverse) : null, turnId ?? null);
  return { id, at, tool, input, summary, undoable: !!inverse, undoneAt: null };
}

const row = (r: any): AgentActionT => ({ id: r.id, at: r.at, tool: r.tool, input: JSON.parse(r.input_json), summary: r.summary, undoable: !!r.undo_json && !r.undone_at, undoneAt: r.undone_at ?? null });

export function listActions(s: Services, limit = 20): AgentActionT[] {
  return (s.domain.db.prepare("select * from agent_action order by at desc limit ?").all(limit) as any[]).map(row);
}

export function undoAction(s: Services, id: string, exec: (name: string, input: unknown) => unknown): { ok: boolean; undone: unknown } {
  const r = s.domain.db.prepare("select * from agent_action where id = ?").get(id) as any;
  if (!r) throw new NotFound(`action ${id}`);
  if (r.undone_at) throw new DomainError("ALREADY_UNDONE", "已经撤销过了");
  if (!r.undo_json) throw new DomainError("NOT_UNDOABLE", "这个操作没有自动撤销，请手动改回");
  const inv = JSON.parse(r.undo_json);
  const undone = exec(inv.name, inv.input);
  s.domain.db.prepare("update agent_action set undone_at = ? where id = ?").run(new Date().toISOString(), id);
  return { ok: true, undone };
}

/** One of the `agent:` settings, written to jobos.yaml (only that key) and applied to the running config. */
export function setAgentConfig(s: Services, patch: Partial<NonNullable<Services["config"]["agent"]>>): void {
  updateConfig(s.config.vault, (doc) => { doc.agent = { ...(doc.agent ?? {}), ...patch }; });
  s.config.agent = { ...(s.config.agent ?? {}), ...patch };
}
export const setMode = (s: Services, mode: AgentMode): void => setAgentConfig(s, { mode });
