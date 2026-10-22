/**
 * Notices that must reach the person, and the proof that they did (phase-1 plan P1, B1). Whoever has something to tell
 * — a test tomorrow, a deadline, a mail that moved an application — files a notice with a key (the same thing is filed
 * once) and an urgency; this sends it, asks whether it was read, and presses when it was not:
 *   now   (a test or interview within hours): unread 15 min after sending → a Feishu urgent banner; 45 min → an SMS
 *         (if allowed); within 30 min of the start → a call (only if the person turned calls on);
 *   today (a deadline today or tomorrow, a test tomorrow): unread 2 h → the urgent banner;
 *   info  (the daily brief, progress): sent once, never pressed.
 * Sent is not received: a notice counts as received when Feishu reports the person read it (or they mark it in the
 * window). Without a configured channel it stays unsent and the 今日 page says so — it is never taken as said.
 * During a test's quiet span (budget/quiet.ts) only that test's own notices go out; the rest wait for it to end.
 */
import { ulid } from "ulid";
import type { Db } from "../db.js";
import type { Card } from "./feishu.js";

export type Urgency = "now" | "today" | "info";
export interface NoticeInput { key: string; kind: string; urgency: Urgency; title: string; lines: string[]; url?: string; refKind?: string; refId?: string; dueAt?: string | null }

/** What the center needs of a channel (notify/feishu.ts behind it; a fake in tests). */
export interface Channel {
  ready(): boolean;
  send(c: Card): Promise<string>;
  readBy(messageId: string): Promise<boolean>;
  press(messageId: string, how: "app" | "sms" | "phone"): Promise<void>;
}

const MIN = 60_000, HOUR = 60 * MIN;
const iso = (ms: number) => new Date(ms).toISOString();

/** File a notice; null when one with this key was filed before (it is not sent again). */
export function enqueue(db: Db, n: NoticeInput, now = Date.now()): string | null {
  const id = ulid();
  const r = db.prepare(`insert or ignore into notice(id, key, kind, urgency, title, body, url, ref_kind, ref_id, due_at, created_at, state, next_at)
    values (?,?,?,?,?,?,?,?,?,?,?, 'pending', ?)`).run(id, n.key, n.kind, n.urgency, n.title, JSON.stringify(n.lines), n.url ?? "", n.refKind ?? "", n.refId ?? "", n.dueAt ?? null, iso(now), iso(now));
  return r.changes ? id : null;
}

/** Stop pressing about something that no longer stands (a test moved or cancelled, an application closed). */
export function cancel(db: Db, refKind: string, refId: string, why: string): number {
  return Number(db.prepare("update notice set state = 'cancelled', last_error = ?, next_at = null where ref_kind = ? and ref_id = ? and state in ('pending', 'sent')").run(why, refKind, refId).changes);
}

export interface DeliverOptions { sms: boolean; phone: boolean; quiet?: (now: number) => { why: string; refId?: string } | null }

/** One pass over what is due: send the unsent, ask about the sent, press the unread. */
export async function deliver(db: Db, ch: Channel | null, now = Date.now(), o: DeliverOptions = { sms: true, phone: false }): Promise<{ sent: number; read: number; pressed: number; waiting: number }> {
  const out = { sent: 0, read: 0, pressed: 0, waiting: 0 };
  const due = db.prepare("select * from notice where state in ('pending', 'sent') and (next_at is null or next_at <= ?) order by created_at limit 50").all(iso(now)) as any[];
  const set = (id: string, p: Record<string, unknown>) => {
    const keys = Object.keys(p);
    db.prepare(`update notice set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ?`).run(...keys.map((k) => p[k] as any), id);
  };
  for (const n of due) {
    const dueAt = n.due_at ? Date.parse(n.due_at) : NaN;
    // a notice about something already past is not worth sending late (configured only now, or the computer was off)
    if (n.state === "pending" && Number.isFinite(dueAt) && dueAt < now - HOUR && n.kind !== "test") { set(n.id, { state: "cancelled", last_error: "事情已经过去，没有再发", next_at: null }); continue; }
    if (n.state === "pending") {
      if (!ch?.ready()) { set(n.id, { blocked_reason: "not_configured", next_at: iso(now + 10 * MIN) }); out.waiting++; continue; }
      const q = o.quiet?.(now);
      if (q && n.urgency !== "now" && !(q.refId && q.refId === n.ref_id)) { set(n.id, { blocked_reason: "quiet", next_at: iso(now + 10 * MIN) }); out.waiting++; continue; }
      try {
        const mid = await ch.send({ title: n.title, lines: JSON.parse(n.body), url: n.url || undefined, tone: n.urgency === "now" ? "red" : n.urgency === "today" ? "orange" : "blue" });
        set(n.id, { state: "sent", message_id: mid, sent_at: iso(now), blocked_reason: "", last_error: "", next_at: iso(now + 3 * MIN) });
        out.sent++;
      } catch (e: any) {
        const attempts = (n.attempts ?? 0) + 1;
        set(n.id, { attempts, last_error: String(e?.message ?? e).slice(0, 200), state: attempts >= 10 ? "failed" : "pending", next_at: attempts >= 10 ? null : iso(now + Math.min(30, 2 ** attempts) * MIN) });
      }
      continue;
    }
    // sent: has the person read it?
    const sent = Date.parse(n.sent_at), age = now - sent;
    if (age > 7 * 24 * HOUR) { set(n.id, { state: "unconfirmed", next_at: null }); continue; } // Feishu answers for 7 days only
    try {
      if (await ch?.readBy(n.message_id)) { set(n.id, { state: "read", read_at: iso(now), acked_via: "read", next_at: null }); out.read++; continue; }
      let level = n.level ?? 0;
      const press = async (how: "app" | "sms" | "phone", to: number) => { await ch!.press(n.message_id, how); level = to; out.pressed++; };
      if (n.urgency === "now") {
        if (level < 1 && age >= 15 * MIN) await press("app", 1);
        else if (level < 2 && age >= 45 * MIN && o.sms) await press("sms", 2);
        if (level < 3 && o.phone && Number.isFinite(dueAt) && dueAt - now <= 30 * MIN && dueAt > now) await press("phone", 3);
      } else if (n.urgency === "today" && level < 1 && age >= 2 * HOUR) await press("app", 1);
      set(n.id, { level, last_error: "", next_at: iso(now + (age < HOUR ? 3 * MIN : age < 24 * HOUR ? 15 * MIN : 2 * HOUR)) });
    } catch (e: any) {
      set(n.id, { last_error: String(e?.message ?? e).slice(0, 200), next_at: iso(now + 15 * MIN) });
    }
  }
  return out;
}

/** The person says they saw it (the window's 「知道了」). */
export function ack(db: Db, id: string, now = Date.now()): boolean {
  return Number(db.prepare("update notice set state = 'read', read_at = ?, acked_via = 'local', next_at = null where id = ? and state in ('pending', 'sent', 'unconfirmed')").run(iso(now), id).changes) > 0;
}

export function listNotices(db: Db, limit = 30) {
  const rows = db.prepare("select * from notice order by created_at desc limit ?").all(limit) as any[];
  const c = db.prepare(`select sum(state = 'pending') as unsent, sum(state = 'pending' and blocked_reason = 'not_configured') as notConfigured,
    sum(state in ('sent', 'unconfirmed') and urgency != 'info') as unread from notice`).get() as any;
  return {
    items: rows.map((r) => ({ id: r.id as string, kind: r.kind as string, urgency: r.urgency as Urgency, title: r.title as string, lines: JSON.parse(r.body) as string[], state: r.state as string,
      waitingFor: (r.blocked_reason || "") as string, createdAt: r.created_at as string, sentAt: (r.sent_at ?? null) as string | null, readAt: (r.read_at ?? null) as string | null, pressed: (r.level ?? 0) as number, error: (r.last_error ?? "") as string })),
    counts: { unsent: c.unsent ?? 0, notConfigured: c.notConfigured ?? 0, unread: c.unread ?? 0 },
  };
}

// ---------- tests and interviews on record

const hm = (ms: number) => new Date(ms).toLocaleString("zh-CN", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });

/**
 * Every test, assessment or interview with a time and no result yet gets two notices: the day before (today) and two
 * hours before (now). Keyed by the stage and its time, so a moved test is announced again and the old one is dropped.
 */
export function noticeStages(db: Db, now = Date.now()): number {
  const rows = db.prepare(`select s.id, s.kind, s.scheduled_at, s.link, s.notes, co.name as company, p.title from stage s join application a on a.id = s.application_id
    join position p on p.id = a.position_id join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id
    where s.scheduled_at >= ? and (s.result is null or s.result = '') and a.state not in ('closed', 'cancelled')`).all(iso(now - HOUR)) as any[];
  let filed = 0;
  for (const r of rows) {
    const at = Date.parse(r.scheduled_at);
    if (!Number.isFinite(at)) continue;
    // a moved test: the notices of its old time are dropped
    db.prepare("update notice set state = 'cancelled', last_error = '时间改了', next_at = null where ref_kind = 'stage' and ref_id = ? and due_at != ? and state in ('pending', 'sent')").run(r.id, r.scheduled_at);
    const lines = [`**${r.company}** · ${r.title}`, `时间：**${hm(at)}**`, ...(r.link ? [`链接：${r.link}`] : []), ...(r.notes ? [String(r.notes).slice(0, 200)] : [])];
    const base = { kind: "exam", refKind: "stage", refId: r.id as string, dueAt: r.scheduled_at as string, url: r.link || undefined, lines };
    if (at - now <= 26 * HOUR && enqueue(db, { ...base, key: `stage:${r.id}:${r.scheduled_at}:day`, urgency: "today", title: `明天${r.kind} · ${r.company}` }, now)) filed++;
    if (at - now <= 2.5 * HOUR && enqueue(db, { ...base, key: `stage:${r.id}:${r.scheduled_at}:soon`, urgency: "now", title: `${r.kind}快开始了 · ${r.company} · ${hm(at).slice(-5)}` }, now)) filed++;
  }
  return filed;
}
