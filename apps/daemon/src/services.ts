/**
 * What every part of the daemon works with (A2): the database through the domain, the workflow engine, the settings,
 * and the hooks the daemon sets. Kept apart from the tool registry, so a module that needs these does not have to
 * import the registry (and everything it imports). `createServices` puts the parts together — the daemon's start and
 * the tests use the same one; `testConfig` is the settings a test starts from.
 */
import type { Db } from "./db.js";
import { Domain } from "./service/domain.js";
import { WorkflowEngine } from "./service/workflow.js";
import type { JobosConfig } from "./config.js";
import type { Llm } from "./llm.js";
import type { ChatHub } from "./agent/backend.js";

/** `onBackgroundChanged`: data changed with no tool call behind it; the open pages hear of it once it shows (service/background.ts) */
export interface Services { domain: Domain; workflows: WorkflowEngine; config: JobosConfig; onDataChanged?: () => void; onBackgroundChanged?: (what: string) => void; onRelevanceChanged?: () => void; onSourcesChanged?: () => void; onInboxChanged?: () => void; llm?: Llm; chat?: ChatHub }

/** The parts, from a database and its settings. Hooks are the caller's (the daemon wires them; a test sets what it needs). */
export function createServices(o: { db: Db; config: JobosConfig; domain?: Domain; readOnly?: boolean; llm?: Llm }): Services {
  const domain = o.domain ?? new Domain(o.db, { readOnly: !!o.readOnly });
  return { domain, workflows: new WorkflowEngine(o.db), config: o.config, ...(o.llm ? { llm: o.llm } : {}) };
}

/** Settings for a test's own data folder: no port, a model that is never called, reminders at 7 / 3 / 1 days, no subscriptions. */
export function testConfig(vault: string, over: Partial<JobosConfig> = {}): JobosConfig {
  return { vault, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [], ...over };
}
