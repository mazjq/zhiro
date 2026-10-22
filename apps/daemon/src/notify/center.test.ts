/** P1: notices reach the person, or say they did not (B1); unread ones are pressed by urgency. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorld } from "../eval/seed.js";
import { callTool } from "../registry.js";
import { deliver, enqueue, listNotices, noticeStages, type Channel } from "./center.js";
import { deadlineReminder, scheduleAllDeadlines } from "../workflows/deadline.js";

const MIN = 60_000, H = 60 * MIN;
const T0 = Date.parse("2026-10-22T10:00:00+08:00");
const world = () => seedWorld(mkdtempSync(join(tmpdir(), "zhiro-notice-")));

function fake(read = false) {
  const log: string[] = [];
  let seen = read;
  const ch: Channel & { log: string[]; see: () => void } = {
    log, see: () => { seen = true; },
    ready: () => true,
    send: async (c, _dedupe) => { log.push(`send ${c.title}`); return `m${log.length}`; },
    readBy: async () => seen,
    press: async (_m, how) => { log.push(`press ${how}`); },
  };
  return ch;
}
const state = (db: any, id: string) => db.prepare("select state, level, blocked_reason from notice where id = ?").get(id);

describe("the notice center", () => {
  it("with no channel a notice stays unsent and is counted as such — never taken as said", async () => {
    const { s } = await world();
    const id = enqueue(s.domain.db, { key: "k1", kind: "deadline", urgency: "today", title: "截止", lines: ["x"] }, T0)!;
    await deliver(s.domain.db, null, T0);
    expect(state(s.domain.db, id)).toMatchObject({ state: "pending", blocked_reason: "not_configured" });
    expect(listNotices(s.domain.db).counts).toMatchObject({ unsent: 1, notConfigured: 1 });
  });
  it("the same thing is filed once", async () => {
    const { s } = await world();
    expect(enqueue(s.domain.db, { key: "same", kind: "x", urgency: "info", title: "a", lines: [] })).toBeTruthy();
    expect(enqueue(s.domain.db, { key: "same", kind: "x", urgency: "info", title: "a", lines: [] })).toBeNull();
  });
  it("an urgent notice unread is pressed: the app banner at 15 min, SMS at 45 min; read stops it", async () => {
    const { s } = await world();
    const ch = fake();
    const id = enqueue(s.domain.db, { key: "exam", kind: "exam", urgency: "now", title: "笔试", lines: [], dueAt: new Date(T0 + 3 * H).toISOString() }, T0)!;
    await deliver(s.domain.db, ch, T0);
    expect(state(s.domain.db, id).state).toBe("sent");
    await deliver(s.domain.db, ch, T0 + 16 * MIN);
    expect(ch.log).toContain("press app");
    await deliver(s.domain.db, ch, T0 + 46 * MIN);
    expect(ch.log).toContain("press sms");
    expect(ch.log).not.toContain("press phone"); // calls only when turned on
    ch.see();
    await deliver(s.domain.db, ch, T0 + 60 * MIN);
    expect(state(s.domain.db, id).state).toBe("read");
    const before = ch.log.length;
    await deliver(s.domain.db, ch, T0 + 120 * MIN);
    expect(ch.log.length).toBe(before);
  });
  it("information is sent once and never pressed", async () => {
    const { s } = await world();
    const ch = fake();
    enqueue(s.domain.db, { key: "brief", kind: "brief", urgency: "info", title: "简报", lines: [] }, T0);
    for (const t of [0, 20, 60, 300]) await deliver(s.domain.db, ch, T0 + t * MIN);
    expect(ch.log.filter((l) => l.startsWith("press"))).toEqual([]);
  });
  it("something already past is not sent late", async () => {
    const { s } = await world();
    const id = enqueue(s.domain.db, { key: "old", kind: "exam", urgency: "now", title: "旧", lines: [], dueAt: new Date(T0 - 2 * H).toISOString() }, T0)!;
    await deliver(s.domain.db, fake(), T0);
    expect(state(s.domain.db, id).state).toBe("cancelled");
  });
  it("during a test's quiet span only that test's own notices go out — not another test's, however urgent", async () => {
    const { s } = await world();
    const ch = fake();
    const info = enqueue(s.domain.db, { key: "i", kind: "brief", urgency: "info", title: "简报", lines: [] }, T0)!;
    const other = enqueue(s.domain.db, { key: "o", kind: "exam", urgency: "now", title: "别的笔试", lines: [], refKind: "stage", refId: "B" }, T0)!;
    const own = enqueue(s.domain.db, { key: "n", kind: "exam", urgency: "now", title: "这场笔试", lines: [], refKind: "stage", refId: "A" }, T0)!;
    await deliver(s.domain.db, ch, T0, { sms: true, phone: false, quiet: () => ({ why: "笔试安静中", stageId: "A" }) });
    expect(state(s.domain.db, info)).toMatchObject({ state: "pending", blocked_reason: "quiet" });
    expect(state(s.domain.db, other)).toMatchObject({ state: "pending", blocked_reason: "quiet" });
    expect(state(s.domain.db, own).state).toBe("sent");
  });
  it("two passes at once send a notice once", async () => {
    const { s } = await world();
    const ch = fake();
    enqueue(s.domain.db, { key: "x", kind: "brief", urgency: "info", title: "x", lines: [] }, T0);
    await Promise.all([deliver(s.domain.db, ch, T0), deliver(s.domain.db, ch, T0)]);
    expect(ch.log.filter((l) => l.startsWith("send"))).toHaveLength(1);
  });
  it("not knowing whether it was read does not stop the pressing", async () => {
    const { s } = await world();
    const ch = fake();
    ch.readBy = async () => { throw new Error("no permission"); };
    const id = enqueue(s.domain.db, { key: "e", kind: "exam", urgency: "now", title: "笔试", lines: [], dueAt: new Date(T0 + 5 * H).toISOString() }, T0)!;
    await deliver(s.domain.db, ch, T0);
    await deliver(s.domain.db, ch, T0 + 16 * MIN);
    expect(ch.log).toContain("press app");
    expect((s.domain.db.prepare("select last_error from notice where id = ?").get(id) as any).last_error).toContain("查不到是否已读");
  });
  it("a call comes only after the banner and the SMS, steps closer together near the start", async () => {
    const { s } = await world();
    const ch = fake();
    enqueue(s.domain.db, { key: "c", kind: "exam", urgency: "now", title: "笔试", lines: [], dueAt: new Date(T0 + 25 * MIN).toISOString() }, T0);
    const o = { sms: true, phone: true };
    await deliver(s.domain.db, ch, T0, o);
    await deliver(s.domain.db, ch, T0 + 2 * MIN, o);
    expect(ch.log.filter((l) => l.startsWith("press"))).toEqual([]);
    await deliver(s.domain.db, ch, T0 + 6 * MIN, o);
    await deliver(s.domain.db, ch, T0 + 11 * MIN, o);
    await deliver(s.domain.db, ch, T0 + 16 * MIN, o);
    expect(ch.log.filter((l) => l.startsWith("press"))).toEqual(["press app", "press sms", "press phone"]);
  });
  it("a notice about something no longer standing is dropped before it is sent", async () => {
    const { s } = await world();
    const id = enqueue(s.domain.db, { key: "d", kind: "deadline", urgency: "today", title: "截止", lines: [], refKind: "position", refId: "p1" }, T0)!;
    await deliver(s.domain.db, fake(), T0, { sms: true, phone: false, relevant: () => false });
    expect(state(s.domain.db, id).state).toBe("cancelled");
  });
});

describe("tests and interviews on record", () => {
  it("the day before and two hours before; a moved test drops the old notices", async () => {
    const { s } = await world();
    const db = s.domain.db;
    const stage = (db.prepare("select id from stage limit 1").get() as any).id;
    db.prepare("update stage set scheduled_at = null").run();
    db.prepare("update application set state = 'submitted' where id = (select application_id from stage where id = ?)").run(stage);
    db.prepare("update stage set kind = '笔试', result = '', scheduled_at = ? where id = ?").run(new Date(T0 + 2 * H).toISOString(), stage);
    expect(noticeStages(db, T0)).toBe(1); // a late start: only "soon", not "tomorrow" as well
    expect(noticeStages(db, T0)).toBe(0); // filed once
    db.prepare("update stage set scheduled_at = ? where id = ?").run(new Date(T0 + 20 * H).toISOString(), stage);
    noticeStages(db, T0);
    const rows = db.prepare("select state, title from notice where ref_id = ? order by created_at").all(stage) as any[];
    expect(rows[0].state).toBe("cancelled");
    expect(rows[1]).toMatchObject({ state: "pending" });
    db.prepare("update stage set result = '通过' where id = ?").run(stage); // a result: nothing left to remind of
    noticeStages(db, T0);
    expect((db.prepare("select count(*) as n from notice where ref_id = ? and state = 'pending'").get(stage) as any).n).toBe(0);
  });
});

describe("deadline reminders go through the center (B1)", () => {
  it("unconfigured: the reminder is filed and waits, not marked as said and dropped", async () => {
    const { s } = await world();
    const def = deadlineReminder(s);
    s.workflows.register(def);
    scheduleAllDeadlines(s);
    await s.workflows.tick();
    const n = s.domain.db.prepare("select count(*) as n from notice where kind = 'deadline'").get() as any;
    expect(n.n).toBeGreaterThan(0);
    await deliver(s.domain.db, null);
    expect(listNotices(s.domain.db).counts.notConfigured).toBe(n.n);
  });
});

describe("the app secret", () => {
  it("never reaches the audit log", async () => {
    const { s } = await world();
    await expect(callTool("notify.setup", { appId: "not-an-id", appSecret: "s3cret", who: "a@b.c" }, { kind: "human", via: "desktop" }, s)).rejects.toMatchObject({ code: "BAD_INPUT" });
    const rows = s.domain.db.prepare("select input_json from audit where tool = 'notify.setup'").all() as any[];
    expect(rows.length).toBe(1);
    expect(rows[0].input_json).not.toContain("s3cret");
  });
  it("is the person's to give: an agent cannot set the channel", async () => {
    const { s } = await world();
    await expect(callTool("notify.setup", { appId: "cli_x", appSecret: "s", who: "a@b.c" }, { kind: "agent", via: "mcp", cred: "agent" }, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("a test written in a mail (B2)", () => {
  it("is reminded of from the mail even when it cannot be placed; a stage of the same time takes over", async () => {
    const { s, app } = await world();
    const db = s.domain.db;
    const { noticeMail } = await import("./center.js");
    const at = new Date(T0 + 20 * H).toISOString();
    db.prepare(`insert into message(id, account, message_id, received_at, created_at, category, company, scheduled_at, status, candidates_json)
      values ('m1', 'a', '<m1>', ?, ?, '笔试', '楚天智驾', ?, 'unlinked', '[]')`).run(new Date(T0).toISOString(), new Date(T0).toISOString(), at);
    expect(noticeMail(db, T0)).toBe(2); // the reminder, and the question which application
    expect((db.prepare("select kind from notice where ref_id = 'm1' or ref_id = 'm1'").all() as any[]).map((r) => r.kind).sort()).toEqual(["exam", "question"]);
    // placed, and a stage of that time is made: the stage reminds from now on
    db.prepare("update message set application_id = ?, status = 'new' where id = 'm1'").run(app.chutian);
    db.prepare("insert into stage(id, application_id, kind, scheduled_at, created_at) values ('s9', ?, '笔试', ?, '')").run(app.chutian, at);
    noticeMail(db, T0);
    expect((db.prepare("select state from notice where ref_kind = 'message' and ref_id = 'm1'").get() as any).state).toBe("cancelled");
  });
});

describe("a test moved after its mail", () => {
  it("once the application has a stage of that kind the old mail's time is not reminded of", async () => {
    const { s, app } = await world();
    const db = s.domain.db;
    const { noticeMail } = await import("./center.js");
    const at = new Date(T0 + 20 * H).toISOString(), moved = new Date(T0 + 22 * H).toISOString();
    db.prepare(`insert into message(id, account, message_id, received_at, created_at, category, company, scheduled_at, status, application_id)
      values ('m2', 'a', '<m2>', ?, ?, '笔试', '楚天智驾', ?, 'new', ?)`).run(new Date(T0).toISOString(), new Date(T0).toISOString(), at, app.chutian);
    db.prepare("insert into stage(id, application_id, kind, scheduled_at, created_at) values ('s8', ?, '笔试', ?, '')").run(app.chutian, moved);
    noticeMail(db, T0);
    expect((db.prepare("select count(*) as n from notice where ref_id = 'm2' and state = 'pending'").get() as any).n).toBe(0);
  });
});
