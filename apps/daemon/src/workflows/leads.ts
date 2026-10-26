import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../services.js";
import { resolveLeads } from "../service/leads.js";

/** lead_resolve: once a day, read the most relevant announcement pages behind 待补资料 leads (ADR-035), within the budget. */
export function leadResolve(s: Services): WorkflowDef {
  return {
    kind: "lead_resolve",
    order: ["resolve"],
    steps: {
      resolve: async ({ checkpoint }) => {
        const budget = s.config.leads?.dailyBudget ?? 30;
        const r = budget > 0 && s.llm ? await resolveLeads(s, budget) : { attempted: 0, positions: 0, results: [], remaining: 0 };
        const at = new Date().toISOString(), until = new Date(Date.now() + 24 * 3600_000).toISOString();
        // the last two weeks of runs: the daily brief adds up those since its last one
        const run = { at, attempted: r.attempted, positions: r.positions, remaining: r.remaining, companies: [...new Set(r.results.filter((x) => x.positions).map((x) => x.companyName))] };
        const runs = [...((checkpoint?.runs ?? []) as (typeof run)[]), run].slice(-14);
        return { type: "sleep", until, checkpoint: { last: at, attempted: r.attempted, positions: r.positions, remaining: r.remaining, runs } };
      },
    },
  };
}

export function scheduleLeads(s: Services): void {
  s.workflows.start("lead_resolve", "leads", "lead_resolve:leads");
}
