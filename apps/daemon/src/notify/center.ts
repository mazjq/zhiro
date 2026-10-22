/**
 * Notices that must reach the person, and the proof that they did (phase-1 plan P1, B1). Whoever has something to tell
 * — a test tomorrow, a deadline, a mail that moved an application — files a notice with a key (the same thing is filed
 * once) and an urgency; this sends it, asks whether it was read, and presses when it was not:
 *   now   (a test or interview within hours): unread 15 min after sending → a Feishu urgent banner; 45 min → an SMS
 *         (if allowed); a call only if the person turned calls on, and only after the earlier steps. Within 30 min of
 *         the start the steps come at 5 / 10 / 15 min;
 *   today (a deadline today or tomorrow, a test tomorrow): unread 2 h → the urgent banner;
 *   info  (the daily brief, progress): sent once, never pressed.
 * Sent is not received: a notice counts as received when Feishu reports the person read it (or they mark it in the
 * window). Without a configured channel it stays unsent and the 今日 page says so — it is never taken as said.
 * During a test's quiet span only that test's own notices go out or are pressed; the rest wait for it to end.
 * Before anything is sent or pressed the thing it is about is asked again (`relevant`): a cancelled or moved test, an
 * application already sent, stops it.
 */
import { ulid } from "ulid";
import type { Db } from "../db.js";
import type { Card } from "./feishu.js";

export type Urgency = "now" | "today" | "info";
export interface NoticeInput { key: string; kind: string; urgency: Urgency; title: string; lines: string[]; url?: string; refKind?: string; refId?: string; dueAt?: string | null }

/** What the center needs of a channel (notify/feishu.ts behind it; a fake in tests). `send` gets a key that makes a retry of the same notice a no-op. */
export interface Channel {
  ready(): boolean;
  send(c: Card, dedupe: string): Promise<string>;
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

export interface DeliverOptions {
  sms: boolean;
  phone: boolean;
  /** the test whose quiet span holds now: only its own notices go out or are pressed */
  quiet?: (now: number) => { why: string; stageId: string } | null;
  /** does the thing a notice is about still stand? (default: yes) */
  relevant?: (refKind: string, refId: string) => boolean;
  /** deliver just this notice (the first card of notify.setup) */
  only?: string;
}

let running: Promise<unknown> = Promise.resolve();
/** One pass at a time (the schedule and notify.setup may ask together): a notice is never sent twice for that. */
export function deliver(db: Db, ch: Channel | null, now = Date.now(), o: DeliverOptions = { sms: true, phone: false }) {
  const run = running.then(() => deliverOnce(db, ch, now, o));
  running = run.catch(() => undefined);
  return run;
}

async function deliverOnce(db: Db, ch: Channel | null, now: number, o: DeliverOptions): Promise<{ sent: number; read: number; pressed: number; waiting: number; sentIds: string[] }> {
  const out = { sent: 0, read: 0, pressed: 0, waiting: 0, sentIds: [] as string[] };
  const due = o.only
    ? (db.prepare("select * from notice where id = ? and state in ('pending', 'sent')").all(o.only) as any[])
    : (db.prepare("select * from notice where state in ('pending', 'sent') and (next_at is null or next_at <= ?) order by created_at limit 50").all(iso(now)) as any[]);
  /** Write only if the notice is still in the state this pass read it in: an 「知道了」 or a cancel meanwhile wins. */
  const set = (id: string, from: string, p: Record<string, unknown>) => {
    const keys = Object.keys(p);
    return Number(db.prepare(`update notice set ${keys.map((k) => `${k} = ?`).join(", ")} where id = ? and state = ?`).run(...keys.map((k) => p[k] as any), id, from).changes) > 0;
  };
  const quiet = o.quiet?.(now) ?? null;
  const ownTest = (n: any) => !!quiet && n.ref_kind === "stage" && n.ref_id === quiet.stageId;
  for (const n of due) {
    const dueAt = n.due_at ? Date.parse(n.due_at) : NaN;
    if (n.ref_kind && o.relevant && !o.relevant(n.ref_kind, n.ref_id)) { set(n.id, n.state, { state: "cancelled", last_error: "这件事已经不算数了（取消、改期或已处理）", next_at: null }); continue; }
    if (n.state === "pending") {
      // a notice about something already past is not worth sending late (configured only now, or the computer was off)
      if (Number.isFinite(dueAt) && dueAt < now - HOUR && n.kind !== "test") { set(n.id, "pending", { state: "cancelled", last_error: "事情已经过去，没有再发", next_at: null }); continue; }
      if (!ch?.ready()) { set(n.id, "pending", { blocked_reason: "not_configured", next_at: iso(now + 10 * MIN) }); out.waiting++; continue; }
      if (quiet && !ownTest(n)) { set(n.id, "pending", { blocked_reason: "quiet", next_at: iso(now + 10 * MIN) }); out.waiting++; continue; }
      try {
        const mid = await ch.send({ title: n.title, lines: JSON.parse(n.body), url: n.url || undefined, tone: n.urgency === "now" ? "red" : n.urgency === "today" ? "orange" : "blue" }, n.id);
        if (set(n.id, "pending", { state: "sent", message_id: mid, sent_at: iso(now), blocked_reason: "", last_error: "", next_at: iso(now + 3 * MIN) })) { out.sent++; out.sentIds.push(n.id); }
      } catch (e: any) {
        const attempts = (n.attempts ?? 0) + 1;
        set(n.id, "pending", { attempts, blocked_reason: "", last_error: String(e?.message ?? e).slice(0, 200), state: attempts >= 10 ? "failed" : "pending", next_at: attempts >= 10 ? null : iso(now + Math.min(30, 2 ** attempts) * MIN) });
      }
      continue;
    }
    // sent: has the person read it?
    const age = now - Date.parse(n.sent_at);
    const over = Number.isFinite(dueAt) && dueAt < now && n.kind === "exam"; // a test already begun: nothing left to press about
    if (age > 7 * 24 * HOUR || over) { set(n.id, "sent", { state: "unconfirmed", next_at: null }); continue; } // Feishu answers for 7 days only
    let read = false, readErr = "";
    try { read = !!(await ch?.readBy(n.message_id)); } catch (e: any) { readErr = `查不到是否已读：${String(e?.message ?? e).slice(0, 120)}`; }
    if (read) { if (set(n.id, "sent", { state: "read", read_at: iso(now), acked_via: "read", next_at: null })) out.read++; continue; }
    // unread (or not knowable): press by urgency, one step at a time, each kept as soon as it is done
    let level = n.level ?? 0, err = readErr;
    if (ch?.ready() && !(quiet && !ownTest(n))) {
      const close = Number.isFinite(dueAt) && dueAt - now <= 30 * MIN;
      const step = (lv: number) => (close ? [5, 10, 15][lv] : [15, 45, Infinity][lv]) * MIN;
      const ladder: ("app" | "sms" | "phone")[] = n.urgency === "now" ? ["app", ...(o.sms ? ["sms" as const] : []), ...(o.phone && close ? ["phone" as const] : [])] : n.urgency === "today" ? ["app"] : [];
      const wait = (how: string) => (n.urgency === "today" ? 2 * HOUR : step(how === "app" ? 0 : how === "sms" ? 1 : 2));
      for (let i = level; i < ladder.length && age >= wait(ladder[i]); i++) {
        try { await ch.press(n.message_id, ladder[i]); level = i + 1; out.pressed++; set(n.id, "sent", { level }); }
        catch (e: any) { err = `${ladder[i] === "app" ? "应用内加急" : ladder[i] === "sms" ? "短信加急" : "电话加急"}没成功：${String(e?.message ?? e).slice(0, 120)}`; break; }
      }
    }
    set(n.id, "sent", { level, last_error: err, next_at: iso(now + (age < HOUR ? 3 * MIN : age < 24 * HOUR ? 15 * MIN : 2 * HOUR)) });
  }
  return out;
}

/** The person says they saw it (the window's 「知道了」). */
export function ack(db: Db, id: string, now = Date.now()): boolean {
  return Number(db.prepare("update notice set state = 'read', read_at = ?, acked_via = 'local', next_at = null where id = ? and state in ('pending', 'sent', 'unconfirmed', 'failed')").run(iso(now), id).changes) > 0;
}

export function listNotices(db: Db, limit = 30) {
  const rows = db.prepare("select * from notice order by created_at desc limit ?").all(limit) as any[];
  const c = db.prepare(`select sum(state = 'pending') as unsent, sum(state = 'pending' and blocked_reason = 'not_configured') as notConfigured,
    sum(state = 'pending' and last_error != '') as erring, sum(state = 'failed') as failed,
    sum(state in ('sent', 'unconfirmed') and urgency != 'info') as unread from notice`).get() as any;
  return {
    items: rows.map((r) => ({ id: r.id as string, kind: r.kind as string, urgency: r.urgency as Urgency, title: r.title as string, lines: JSON.parse(r.body) as string[], state: r.state as string,
      waitingFor: (r.blocked_reason || "") as string, createdAt: r.created_at as string, sentAt: (r.sent_at ?? null) as string | null, readAt: (r.read_at ?? null) as string | null, pressed: (r.level ?? 0) as number, error: (r.last_error ?? "") as string })),
    counts: { unsent: c.unsent ?? 0, notConfigured: c.notConfigured ?? 0, erring: c.erring ?? 0, failed: c.failed ?? 0, unread: c.unread ?? 0 },
  };
}

// ---------- tests and interviews on record

const hm = (ms: number) => new Date(ms).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
const dayWord = (at: number, now: number) => {
  const d = (ms: number) => new Date(ms).toLocaleDateString("zh-CN");
  return d(at) === d(now) ? "今天" : d(at) === d(now + 86400_000) ? "明天" : new Date(at).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
};
const STAGE_LIVE = `s.scheduled_at is not null and (s.result is null or s.result = '') and a.state not in ('closed', 'cancelled')`;

/** Does a stage still call for its notices at this time? (its notices are keyed by the time they were filed for) */
export function stageStands(db: Db, stageId: string, dueAt?: string | null): boolean {
  const r = db.prepare(`select s.scheduled_at from stage s join application a on a.id = s.application_id where s.id = ? and ${STAGE_LIVE}`).get(stageId) as { scheduled_at: string } | undefined;
  return !!r && (!dueAt || r.scheduled_at === dueAt);
}

/**
 * Every test, assessment or interview with a time and no result yet gets one notice for where it is now: the day
 * before (2.5–26 h ahead, today) or soon (within 2.5 h, now) — not both at once after a late start. Keyed by the stage
 * and its time: a moved test is announced again; the notices of a cancelled, moved, finished or closed one are dropped.
 */
export function noticeStages(db: Db, now = Date.now()): number {
  for (const n of db.prepare("select id, ref_id, due_at from notice where ref_kind = 'stage' and state in ('pending', 'sent')").all() as any[])
    if (!stageStands(db, n.ref_id, n.due_at)) db.prepare("update notice set state = 'cancelled', last_error = '考试取消、改期或已有结果', next_at = null where id = ?").run(n.id);
  const rows = db.prepare(`select s.id, s.kind, s.scheduled_at, s.link, s.notes, co.name as company, p.title from stage s join application a on a.id = s.application_id
    join position p on p.id = a.position_id join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id
    where s.scheduled_at >= ? and ${STAGE_LIVE}`).all(iso(now)) as any[];
  let filed = 0;
  for (const r of rows) {
    const at = Date.parse(r.scheduled_at), left = at - now;
    if (!Number.isFinite(at) || left <= 0 || left > 26 * HOUR) continue;
    const when = `${dayWord(at, now)} ${hm(at)}`;
    const lines = [`**${r.company}** · ${r.title}`, `时间：**${when}**`, ...(r.link ? [`链接：${r.link}`] : []), ...(r.notes ? [String(r.notes).slice(0, 200)] : [])];
    const base = { kind: "exam", refKind: "stage", refId: r.id as string, dueAt: r.scheduled_at as string, url: r.link || undefined, lines };
    const filedOne = left <= 2.5 * HOUR
      ? enqueue(db, { ...base, key: `stage:${r.id}:${r.scheduled_at}:soon`, urgency: "now", title: `${r.kind} ${when} · ${r.company}` }, now)
      : enqueue(db, { ...base, key: `stage:${r.id}:${r.scheduled_at}:day`, urgency: "today", title: `${dayWord(at, now)}${r.kind} · ${r.company} · ${hm(at)}` }, now);
    if (filedOne) filed++;
  }
  return filed;
}
