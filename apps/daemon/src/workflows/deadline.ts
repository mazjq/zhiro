import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../services.js";
import { enqueue } from "../notify/center.js";
import { resolveFor, sayDate, type Resolution } from "../service/deadlines.js";

/**
 * deadline_reminder (ADR-041): one workflow per post the person holds — watched, or with an application still being
 * prepared — going by that post's own resolved deadline, not its batch's. A post with a day is reminded at 14 / 7 / 3 /
 * 1 / 0 days (plus whatever jobos.yaml adds); one that is 招满即止 gets a nudge a week at most. What was sent is kept in
 * reminder_sent, so a restart, a rescan or a re-created workflow never sends a milestone twice. When the resolved day
 * changes, one 截止已更新 goes out. A submitted application needs no deadline reminder.
 */
const MILESTONES = [14, 7, 3, 1, 0];
const HELD = `p.status != 'closed' and not exists (select 1 from application a where a.position_id = p.id and a.state not in ('draft', 'cancelled'))
  and (p.watch_priority > 0 or exists (select 1 from application a where a.position_id = p.id and a.state = 'draft'))`;
const asap = (r: Resolution) => !r.date && r.status === "verified" && (r.policy === "until_filled" || r.policy === "rolling" || r.policy === "no_fixed_date");
const DAY = 86400_000;

export function deadlineReminder(s: Services): WorkflowDef {
  const db = s.domain.db;
  const days = [...new Set([...MILESTONES, ...s.config.reminders.daysBefore])].sort((a, b) => b - a);
  const sent = (key: string) => !!db.prepare("select 1 from reminder_sent where key = ?").get(key);
  const mark = (key: string) => void db.prepare("insert or ignore into reminder_sent(key, sent_at) values (?, ?)").run(key, new Date().toISOString());
  /**
   * Filed with the notice center (notify/center.ts), which sends it and makes sure it is read. Filing is what is kept
   * here: an unconfigured channel leaves the notice unsent and the 今日 page says so — never taken as said (B1).
   */
  let current = { id: "", date: null as string | null, left: Infinity };
  const send = async (title: string, lines: string[], key: string): Promise<string | null> => {
    enqueue(db, { key: `deadline:${key}`, kind: "deadline", urgency: current.left <= 1 ? "today" : "info", title, lines, refKind: "position", refId: current.id, dueAt: current.date ? current.date + "T23:59:59+08:00" : null });
    return null;
  };
  return {
    kind: "deadline_reminder",
    order: ["remind"],
    steps: {
      remind: async ({ subjectId: id }) => {
        const p = db.prepare(`select p.title, co.name company from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id where p.id = ? and ${HELD}`).get(id) as { title: string; company: string } | undefined;
        const r = resolveFor(db, [id]).get(id);
        if (!p || !r || r.expired) return { type: "done" };
        current = { id, date: r.date ?? null, left: r.date ? Math.ceil((Date.parse(r.date + "T23:59:59+08:00") - Date.now()) / DAY) : Infinity };
        const name = `「${p.title}」`;
        if (!r.date) {
          if (!asap(r)) return { type: "done" }; // nothing to remind of; 待核实 on the 今日 page carries it
          const week = `asap|${id}|${Math.floor(Date.now() / (7 * DAY))}`;
          if (!sent(week)) { const err = await send(`宜尽早投递 · ${p.company}`, [`${name}${r.say}`, "状态：**未投递**"], week); if (err) return { type: "fail", error: err, retryInMs: 30 * 60_000 }; mark(week); }
          return { type: "sleep", until: new Date(Date.now() + 7 * DAY).toISOString() };
        }
        // the day differs from the one the person was last told: say so once. By the last one told, not by "ever told":
        // A → B → A must say B → A (B28); each change is its own notice, so going back is not taken for the first one
        const prev = db.prepare("select key from reminder_sent where key like ? order by sent_at desc, rowid desc limit 1").get(`known|${id}|%`) as { key: string } | undefined;
        const told = prev?.key.split("|")[2];
        if (told !== r.date) {
          if (told) { const err = await send(`截止已更新 · ${p.company}`, [`${name}的截止由 ${sayDate(told)} 改为 **${sayDate(r.date)}**`, r.say], `known|${id}|${told}>${r.date}|${Date.now()}`); if (err) return { type: "fail", error: err, retryInMs: 30 * 60_000 }; }
          // the newest row (rowid) is the day last told, also within one millisecond
          db.prepare("delete from reminder_sent where key = ?").run(`known|${id}|${r.date}`);
          mark(`known|${id}|${r.date}`);
        }
        const left = Math.ceil((Date.parse(r.date + "T23:59:59+08:00") - Date.now()) / DAY);
        if (left < 0) return { type: "done" };
        // the nearest milestone reached; the ones passed on the way are settled with it (first seen at 5 days: one T-7, not T-14 then T-7)
        const due = [...days].reverse().find((d) => left <= d);
        if (due != null && !sent(`${id}|${r.date}|${due}`)) {
          const err = await send(`截止提醒 · ${p.company}`, [`${name}**${sayDate(r.date)}**截止（${left <= 0 ? "今天" : `剩 ${left} 天`}）`, r.say, "状态：**未投递**"], `${id}|${r.date}|${due}`);
          if (err) return { type: "fail", error: err, retryInMs: 30 * 60_000 };
          for (const d of days) if (d >= due) mark(`${id}|${r.date}|${d}`);
        }
        const next = days.find((d) => d < (due ?? Infinity) && !sent(`${id}|${r.date}|${d}`));
        if (next == null) return { type: "done" };
        const wake = Date.parse(r.date + "T09:00:00+08:00") - next * DAY;
        return { type: "sleep", until: new Date(Math.max(wake, Date.now() + 60_000)).toISOString() };
      },
    },
  };
}

/**
 * One reminder per held post, keyed by what it currently resolves to — a new day is a new workflow (which reports the
 * change), and reminders of posts no longer held, or of a day that no longer stands, are dropped. Idempotent; call
 * whenever the pool or what the person holds changes.
 */
export function scheduleAllDeadlines(s: Services): number {
  const db = s.domain.db;
  const ids = (db.prepare(`select p.id from position p where ${HELD}`).all() as { id: string }[]).map((r) => r.id);
  const resolved = resolveFor(db, ids);
  const keep = new Set<string>();
  for (const id of ids) {
    const r = resolved.get(id);
    if (!r || r.expired || (!r.date && !asap(r))) continue;
    const key = `deadline_reminder:${id}:${r.date ?? "asap"}`;
    keep.add(key);
    s.workflows.start("deadline_reminder", id, key);
  }
  for (const w of db.prepare("select id, idempotency_key k from workflow where kind = 'deadline_reminder' and state = 'running'").all() as { id: string; k: string }[]) if (!keep.has(w.k)) db.prepare("delete from workflow where id = ?").run(w.id);
  return keep.size;
}
