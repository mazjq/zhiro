/** What the pages listen to (SSE): a write happened, a capture arrived, the assistant took a step. One bus for every way in. */
import { EventEmitter } from "node:events";
import { tools, type ToolContract } from "@zhiro/contracts";
import type { Actor } from "./registry.js";

export const bus = new EventEmitter();
bus.setMaxListeners(50);

export function emit(type: string, data: unknown): void { bus.emit("event", { type, data }); }

/** After a tool ran: the pages refresh only for writes; the chat drawer matches the turn by turnId. */
export function emitToolDone(name: string, actor: Actor, client = ""): void {
  const c = (tools as Record<string, ToolContract | undefined>)[name];
  if (!c?.effects.localWrite) return;
  emit("tool", { name, actor: { kind: actor.kind, via: actor.via }, client, turnId: actor.kind === "agent" ? actor.turnId ?? "" : "" });
}
