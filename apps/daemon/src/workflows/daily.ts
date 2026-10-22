import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../registry.js";
import { runBrief } from "../daily/brief.js";

/** "H:MM" / "HH:MM" with a real hour and minute → "HH:MM"; anything else → null. */
export function normalizeAt(at: string | undefined): string | null {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(at ?? "");
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** Today at `at` on the local clock (default 08:00). */
export function todayAt(at: string | undefined, now = Date.now()): number {
  const [h, m] = (normalizeAt(at) ?? "08:00").split(":").map(Number);
  const d = new Date(now); d.setHours(h, m, 0, 0);
  return d.getTime();
}

/** The next time the clock shows `at`, after `now` — a calendar day on, so a clock change does not move it. */
export function nextAt(at: string | undefined, now = Date.now()): number {
  const t = todayAt(at, now);
  if (t > now) return t;
  const d = new Date(t); d.setDate(d.getDate() + 1);
  return todayAt(at, d.getTime());
}

/** daily_brief: once a day at the person's hour, the brief of what changed (daily/brief.ts). */
export function dailyBrief(s: Services): WorkflowDef {
  return {
    kind: "daily_brief",
    order: ["brief"],
    steps: {
      brief: async () => {
        // today's hour has come and no brief since it (first start, or the computer was off): make it now
        const slot = todayAt(s.config.brief?.at);
        const last = s.domain.db.prepare("select max(at) at from brief_run").get() as { at: string | null };
        if (Date.now() >= slot && (!last.at || Date.parse(last.at) < slot)) {
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
