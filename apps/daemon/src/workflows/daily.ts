import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../registry.js";
import { runBrief } from "../daily/brief.js";

/** The next time the clock shows `at` (local time, "HH:MM"), after `now`. */
export function nextAt(at: string | undefined, now = Date.now()): number {
  const [h, m] = /^\d{1,2}:\d{2}$/.test(at ?? "") ? at!.split(":").map(Number) : [8, 0];
  const d = new Date(now); d.setHours(Math.min(23, h), Math.min(59, m), 0, 0);
  return d.getTime() > now ? d.getTime() : d.getTime() + 86400_000;
}

/** daily_brief: once a day at the person's hour, the brief of what changed (daily/brief.ts). */
export function dailyBrief(s: Services): WorkflowDef {
  return {
    kind: "daily_brief",
    order: ["brief"],
    steps: {
      brief: async ({ checkpoint }) => {
        const due = checkpoint?.next ? Date.parse(checkpoint.next) : 0;
        if (Date.now() >= due && due) {
          runBrief(s.domain.db);
          s.onBackgroundChanged?.("brief");
        }
        const next = new Date(nextAt(s.config.brief?.at)).toISOString();
        return { type: "sleep", until: next, checkpoint: { next } };
      },
    },
  };
}

export function scheduleBrief(s: Services): void {
  s.workflows.ensure("daily_brief", "brief", "daily_brief:brief");
}
