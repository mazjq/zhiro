/**
 * The chat drawer's backend (ADR-046): who answers. The built-in assistant (pi, in-process) or a harness the person
 * already has — Claude Code, Codex — run as a command line per message. The drawer talks to the hub only.
 */
import { ulid } from "ulid";
import type { AgentActionT } from "../service/tiers.js";
import type { Services } from "../services.js";

export type BackendName = "builtin" | "claude" | "codex" | "dsh";
export const BACKENDS: BackendName[] = ["builtin", "claude", "codex", "dsh"];

/** What one user message produced. */
export interface Turn { answer: string; actions: AgentActionT[]; proposals: any[]; turnId?: string; backend?: BackendName; cost?: { usd?: number; kind: "estimated" | "unknown" }; note?: string }

/** The events the drawer renders, in the shape the built-in assistant (pi-agent-core) emits; a CLI backend synthesises them. */
export type ChatEvent = any;

export interface ChatBackend {
  readonly name: BackendName;
  ask(text: string, turnId: string): Promise<Turn>;
  onEvent(l: (e: ChatEvent) => void): () => void;
  history(): { role: "user" | "agent"; text: string; backend?: BackendName }[];
  reset(): void;
  cancel(): void;
  /** Is this backend usable here: the command line found, and so on. */
  status(): { available: boolean; detail: string };
}

export const backendOf = (s: Services): BackendName => (BACKENDS.includes(s.config.agent?.backend as BackendName) ? (s.config.agent!.backend as BackendName) : "builtin");

/**
 * One drawer, one answer at a time: a second message while one is being answered is refused (409), whichever window it
 * came from. Events from whichever backend is active go out tagged with the turn they belong to.
 */
export class ChatHub {
  private listeners = new Set<(e: ChatEvent) => void>();
  private running: { turnId: string; backend: BackendName } | null = null;
  private unsubs: (() => void)[] = [];

  constructor(private s: Services, private backends: Record<BackendName, ChatBackend>) {
    for (const b of new Set(Object.values(backends))) this.unsubs.push(b.onEvent((e) => { if (this.running && b.name === this.running.backend) for (const l of this.listeners) l({ ...e, turnId: this.running.turnId, backend: b.name }); }));
  }

  current(): ChatBackend { return this.backends[backendOf(this.s)]; }
  busy(): { turnId: string; backend: BackendName } | null { return this.running; }

  async ask(text: string, turnId = ulid()): Promise<Turn> {
    if (this.running) throw Object.assign(new Error("上一条还在回答，等它答完或先停止"), { code: "BUSY" });
    const b = this.current();
    this.running = { turnId, backend: b.name };
    try { return { ...(await b.ask(text, turnId)), turnId, backend: b.name }; }
    finally { this.running = null; }
  }
  cancel(): void { if (this.running) this.backends[this.running.backend].cancel(); }
  onEvent(l: (e: ChatEvent) => void): () => void { this.listeners.add(l); return () => this.listeners.delete(l); }
  /** Every assistant's conversation, not only the chosen one's: switching does not hide what was said. The built-in's first (it keeps no times), then the command-line turns of all harnesses in the order they happened. */
  history() {
    const turns = (this.s.domain.db.prepare("select backend, user_text, answer, error from chat_turn order by started_at limit 400").all() as any[])
      .flatMap((t) => [{ role: "user" as const, text: t.user_text as string, backend: t.backend as BackendName }, ...(t.answer || t.error ? [{ role: "agent" as const, text: (t.answer || `（${t.error}）`) as string, backend: t.backend as BackendName }] : [])]);
    return [...this.backends.builtin.history(), ...turns];
  }
  reset(): void { this.cancel(); this.current().reset(); }
  status(): Record<BackendName, { available: boolean; detail: string }> {
    return Object.fromEntries(BACKENDS.map((n) => [n, this.backends[n].status()])) as any;
  }
}

/** The built-in assistant behind the same interface. */
export function builtinBackend(career: { ask(text: string): Promise<Turn>; onEvent(l: (e: any) => void): () => void; history(): { role: "user" | "agent"; text: string }[]; reset(): void; cancel?(): void }, s: Services): ChatBackend {
  return {
    name: "builtin",
    ask: (text) => career.ask(text),
    onEvent: (l) => career.onEvent(l),
    history: () => career.history().map((h) => ({ ...h, backend: "builtin" as const })),
    reset: () => career.reset(),
    cancel: () => career.cancel?.(),
    status: () => ({ available: true, detail: s.config.llm.provider === "external" ? "没有配模型：内置助手不工作" : `模型 ${s.config.llm.model}` }),
  };
}
