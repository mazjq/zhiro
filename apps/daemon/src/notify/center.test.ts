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
    send: async (c) => { log.push(`send ${c.title}`); return `m${log.length}`; },
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
  it("during a test's quiet span only urgent notices go out", async () => {
    const { s } = await world();
    const ch = fake();
    const info = enqueue(s.domain.db, { key: "i", kind: "brief", urgency: "info", title: "简报", lines: [] }, T0)!;
    const now = enqueue(s.domain.db, { key: "n", kind: "exam", urgency: "now", title: "笔试", lines: [] }, T0)!;
    await deliver(s.domain.db, ch, T0, { sms: true, phone: false, quiet: () => ({ why: "笔试安静中" }) });
    expect(state(s.domain.db, info)).toMatchObject({ state: "pending", blocked_reason: "quiet" });
    expect(state(s.domain.db, now).state).toBe("sent");
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
    expect(noticeStages(db, T0)).toBe(2);
    expect(noticeStages(db, T0)).toBe(0); // filed once
    db.prepare("update stage set scheduled_at = ? where id = ?").run(new Date(T0 + 20 * H).toISOString(), stage);
    noticeStages(db, T0);
    const rows = db.prepare("select state from notice where ref_id = ? order by created_at").all(stage) as any[];
    expect(rows.slice(0, 2).every((r) => r.state === "cancelled")).toBe(true);
    expect(rows.some((r) => r.state === "pending")).toBe(true);
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
