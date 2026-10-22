/** P4: the morning brief says what changed — must-do always, the rest only when new or changed. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ulid } from "ulid";
import { seedWorld } from "../eval/seed.js";
import { latestBrief, runBrief } from "./brief.js";
import { nextAt } from "../workflows/daily.js";

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

  it("is made at the person's hour", () => {
    const at = new Date("2026-10-22T07:30:00").getTime();
    expect(new Date(nextAt("08:00", at)).getHours()).toBe(8);
    expect(nextAt("08:00", at) - at).toBe(30 * 60_000);
    expect(nextAt("07:00", at) - at).toBe(23.5 * H);
    expect(new Date(nextAt("bad", at)).getHours()).toBe(8);
  });
});
