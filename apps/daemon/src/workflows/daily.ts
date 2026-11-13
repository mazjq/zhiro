import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../services.js";
import { runBrief } from "../daily/brief.js";
import { deepenShortlist, readForShortlist, runShortlist, shortlistLines, weekOf } from "../service/shortlist.js";

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

/**
 * Whether a brief is owed now: the latest hour that has come (today's, or yesterday's while today's is still ahead)
 * has had none since. One brief covers however many days were missed, and one made in the last 12 hours stands for
 * the hour that follows it, so starting the program shortly before the hour does not make two.
 */
export function briefDue(last: number | null, at: string | undefined, now = Date.now()): boolean {
  const today = todayAt(at, now);
  if (last == null) return now >= today;
  let slot = today;
  if (today > now) { const d = new Date(today); d.setDate(d.getDate() - 1); slot = d.getTime(); }
  return last < slot && now - last >= 12 * 3600_000;
}

/** daily_brief: once a day at the person's hour, the brief of what changed (daily/brief.ts). */
export function dailyBrief(s: Services): WorkflowDef {
  return {
    kind: "daily_brief",
    order: ["brief"],
    steps: {
      brief: async () => {
        // the hour has come and no brief since it (first start, or the computer was off, for a day or for a week): make one now
        const last = s.domain.db.prepare("select max(at) at from brief_run").get() as { at: string | null };
        if (briefDue(last.at ? Date.parse(last.at) : null, s.config.brief?.at)) {
          // the week's shortlist comes with Monday's brief; a week whose Monday the computer slept through gets it the next morning
          const week = weekOf();
          const has = s.domain.db.prepare("select 1 from shortlist_run where week = ?").get(week);
          // the list is ordered by what the model read in the posts, so the reading comes first (minutes, that one morning)
          const list = has ? null : runShortlist(s, Date.now(), (await readForShortlist(s)).picked);
          runBrief(s.domain.db, Date.now(), list ? shortlistLines(list) : []);
          s.onBackgroundChanged?.("brief");
          // the brief names only company and title, so it does not wait for the deep match; that never fails the step
          if (list) await deepenShortlist(s, list.id).catch(() => 0);
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
