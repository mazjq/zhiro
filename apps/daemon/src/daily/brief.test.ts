/** P4: the morning brief says what changed — must-do always, the rest only when new or changed. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { seedWorld } from "../eval/seed.js";
import { latestBrief, makeBrief, runBrief } from "./brief.js";
import { nextAt, normalizeAt } from "../workflows/daily.js";

const H = 3600_000, DAY = 24 * H;
const world = () => seedWorld(mkdtempSync(join(tmpdir(), "zhiro-brief-daily-")));

describe("the daily brief", () => {
  it("must-do, new matched posts, and hanging drafts; the next day only what changed (must-do stays)", async () => {
    const { s, app, pos } = await world();
    const db = s.domain.db, now = Date.now();
    // a test tomorrow on an application
    db.prepare("update stage set scheduled_at = null").run();
    db.prepare("insert into stage(id, application_id, kind, scheduled_at, created_at) values ('st1', ?, '笔试', ?, '')").run(app.chutian, new Date(now + 40 * H).toISOString());
    // a newly seen post the profile matches
    const p = (db.prepare("select p.id from position p where not exists (select 1 from application a where a.position_id = p.id) limit 1").get() as any).id; void pos;
    const co = (db.prepare("select c.company_id from position p join campaign c on c.id = p.campaign_id where p.id = ?").get(p) as any).company_id;
    db.prepare("update position set created_at = ?, watch_priority = null where id = ?").run(new Date(now - H).toISOString(), p);
    db.prepare("insert or replace into recommendation(id, company_id, position_id, mode, tag, score, reason, run_id, created_at) values (?,?,?,?,?,?,?,?,?)").run(ulid(), co, p, "profile_match", "画像匹配", 90, "优先考虑：飞行控制", "", new Date().toISOString());
    // a draft left for a week
    const draft = (db.prepare("select id from application where state = 'draft' limit 1").get() as any)?.id;
    if (draft) db.prepare("update application set updated_at = ? where id = ?").run(new Date(now - 7 * DAY).toISOString(), draft);

    const b = runBrief(db, now);
    expect(b.must.some((x) => x.text.startsWith("笔试"))).toBe(true);
    expect(b.fresh.map((x) => x.key)).toContain(`new:${p}`);
    if (draft) expect(b.hanging.some((x) => x.key === `hang:idle:${draft}` || x.key === `hang:past:${draft}`)).toBe(true);
    expect(latestBrief(db)?.id).toBe(b.id);
    expect((db.prepare("select count(*) as n from notice where kind = 'brief'").get() as any).n).toBe(1);

    const again = runBrief(db, now + DAY);
    expect(again.fresh.map((x) => x.key)).not.toContain(`new:${p}`); // told yesterday, unchanged
    expect(again.must.some((x) => x.text.startsWith("笔试"))).toBe(true); // must-do is always there
  });

  it("keeps what did not fit for the next brief, counts a match made later, and does not nag every day", async () => {
    const { s } = await world();
    const db = s.domain.db, now = Date.now();
    db.prepare("delete from recommendation").run();
    for (const k of ["b", "c"]) db.prepare(`insert into position(id, campaign_id, title, created_at, updated_at) select id || '-${k}', campaign_id, title || '${k}', created_at, updated_at from position p where not exists (select 1 from application a where a.position_id = p.id)`).run();
    const free = (db.prepare("select p.id, c.company_id co from position p join campaign c on c.id = p.campaign_id where not exists (select 1 from application a where a.position_id = p.id) limit 18").all() as any[]);
    expect(free.length).toBe(18);
    const match = (x: any, at: number) => db.prepare("insert into recommendation(id, company_id, position_id, mode, tag, score, reason, run_id, created_at) values (?,?,?,?,?,?,?,?,?)").run(ulid(), x.co, x.id, "profile_match", "画像匹配", 80, "可迁移：控制", "", new Date(at).toISOString());
    for (const x of free) db.prepare("update position set created_at = ?, watch_priority = null, status = 'open' where id = ?").run(new Date(now - H).toISOString(), x.id);
    for (const x of free.slice(0, 17)) match(x, now);
    expect(runBrief(db, now).fresh.length).toBe(15);
    match(free[17], now + H); // the post came in before the first brief, its match after
    const next = runBrief(db, now + DAY).fresh.map((x) => x.key);
    expect(next.length).toBe(3);
    expect(next).toContain(`new:${free[17].id}`);

    const draft = (db.prepare("select id from application where state = 'draft' limit 1").get() as any)?.id;
    db.prepare("update campaign set closes_at = null where id = (select campaign_id from application where id = ?)").run(draft);
    db.prepare("update application set updated_at = ? where id = ?").run(new Date(now - 7 * DAY).toISOString(), draft);
    const idle = (t: number) => runBrief(db, t).hanging.some((x) => x.key === `hang:idle:${draft}`);
    expect(idle(now + 2 * DAY)).toBe(true);
    expect(idle(now + 3 * DAY)).toBe(false); // one more day in the count is not a change
    expect(idle(now + 9 * DAY)).toBe(true); // a week on, said again
  });

  it("adds up every lookup since the last brief, and writes nothing when the brief cannot be kept", async () => {
    const { s } = await world();
    const db = s.domain.db, now = Date.now();
    const runs = [{ at: new Date(now - 3 * H).toISOString(), attempted: 4, positions: 2, remaining: 9, companies: ["甲"] }, { at: new Date(now - H).toISOString(), attempted: 3, positions: 1, remaining: 7, companies: ["乙"] }];
    db.prepare("insert into workflow(id, kind, subject_id, idempotency_key, checkpoint_json, created_at, updated_at) values ('lr', 'lead_resolve', 'leads', 'lr', ?, '', ?)").run(JSON.stringify({ runs }), new Date(now).toISOString());
    db.prepare("insert into brief_run(id, at, since, brief_json) values ('b0', ?, ?, '{}')").run(new Date(now - 5 * H).toISOString(), new Date(now - DAY).toISOString());
    const f = runBrief(db, now).found[0];
    expect(f.text).toContain("读了 7 家");
    expect(f.text).toContain("补出 3 个");
    expect(f.text).toContain("还剩 7 家");

    const count = () => [(db.prepare("select count(*) n from brief_item").get() as any).n, (db.prepare("select count(*) n from brief_run").get() as any).n];
    const before = count();
    db.exec("alter table notice rename to notice_gone");
    db.prepare("insert into stage(id, application_id, kind, scheduled_at, created_at) select 'stx', id, '笔试', ?, '' from application where state = 'submitted' limit 1").run(new Date(now + DAY + 2 * H).toISOString());
    expect(() => runBrief(db, now + DAY)).toThrow();
    expect(count()).toEqual(before);
    db.exec("alter table notice_gone rename to notice");
  });

  it("an application an agent recorded as sent, with no mail or word of the person since, is asked about (R19)", async () => {
    const { s, app } = await world();
    const db = s.domain.db, now = Date.now();
    const id = app.chutian;
    db.prepare("update application set state = 'submitted' where id = ?").run(id);
    db.prepare("delete from application_event where application_id = ? and kind = 'state'").run(id);
    db.prepare("delete from message where application_id = ?").run(id);
    db.prepare("insert into application_event(id, application_id, at, kind, detail, source) values ('ev1', ?, ?, 'state', 'draft → submitted: 平台已提交', 'agent:mcp')").run(id, new Date(now - 5 * DAY).toISOString());
    const asked = (at: number) => makeBrief(db, at).hanging.some((x) => x.key === `hang:unproven:${id}`);
    expect(asked(now)).toBe(true);
    db.prepare("insert into message(id, account, message_id, sender, subject, received_at, body_path, category, application_id, status, created_at) values ('m1', 'a', 'x', 'hr', '投递成功', ?, '', '投递确认', ?, 'filed', ?)").run(new Date(now).toISOString(), id, new Date(now).toISOString());
    expect(asked(now)).toBe(false); // a confirmation came in
  });

  it("takes only a real hour and minute", () => {
    expect(normalizeAt("8:05")).toBe("08:05");
    expect(normalizeAt("23:59")).toBe("23:59");
    expect(normalizeAt("99:99")).toBeNull();
    expect(normalizeAt("24:00")).toBeNull();
  });

  it("is made at the person's hour", () => {
    const at = new Date("2026-10-22T07:30:00").getTime();
    expect(new Date(nextAt("08:00", at)).getHours()).toBe(8);
    expect(nextAt("08:00", at) - at).toBe(30 * 60_000);
    expect(nextAt("07:00", at) - at).toBe(23.5 * H);
    expect(new Date(nextAt("bad", at)).getHours()).toBe(8);
  });
});
