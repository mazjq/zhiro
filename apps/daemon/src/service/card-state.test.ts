/** P3 (B5): a confirm card says what it is now — done, no longer standing, run out but still useful, or waiting. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorld } from "../eval/seed.js";
import { callTool } from "../registry.js";
import { cardView } from "./card-state.js";

const HUMAN = { kind: "human" as const, via: "desktop" as const };
const world = () => seedWorld(mkdtempSync(join(tmpdir(), "zhiro-cards-")));
const future = new Date(Date.now() + 3600_000).toISOString(), past = new Date(Date.now() - 3600_000).toISOString();

describe("what a card is now", () => {
  it("done when it is already so; no longer standing when its application ended; run out but useful; waiting", async () => {
    const { s, app } = await world();
    const db = s.domain.db;
    const a = s.domain.getApplication(app.chutian);
    expect(cardView(db, { kind: "application.update", payload: { id: a.id, state: a.state }, expiresAt: future }).state).toBe("已完成");
    expect(cardView(db, { kind: "application.update", payload: { id: a.id, nextAction: "问 HR" }, expiresAt: future }).state).toBe("待处理");
    expect(cardView(db, { kind: "application.update", payload: { id: a.id, nextAction: "问 HR" }, expiresAt: past }).state).toBe("需补救");
    expect(cardView(db, { kind: "stage.add", payload: { applicationId: a.id, kind: "复试", scheduledAt: past }, expiresAt: future }).state).toBe("待处理"); // backfilling a past stage stands
    expect(cardView(db, { kind: "application.update", payload: { id: "nope" }, expiresAt: future }).state).toBe("已过时");
  });

  it("judges by what the card asks: corrections on an ended application, every asked field, pair by pair, interrupted runs", async () => {
    const { s, app } = await world();
    const db = s.domain.db;
    const one = db.prepare("select * from stage where application_id = ? and kind = '一面'").get(app.chutian) as any;
    expect(cardView(db, { kind: "stage.add", payload: { applicationId: app.chutian, kind: "一面", scheduledAt: one.scheduled_at, link: one.link }, expiresAt: future }).state).toBe("已完成");
    expect(cardView(db, { kind: "stage.add", payload: { applicationId: app.chutian, kind: "一面", scheduledAt: one.scheduled_at, link: "https://other.example.com" }, expiresAt: future }).state).toBe("待处理");
    expect(cardView(db, { kind: "stage.add", payload: { applicationId: app.chutian, kind: "一面" }, expiresAt: future }).state).toBe("待处理"); // no time: cannot tell two apart
    db.prepare("update application set state = 'closed' where id = ?").run(app.chutian);
    expect(cardView(db, { kind: "application.update", payload: { id: app.chutian, closeReason: "笔试未过" }, expiresAt: future }).state).toBe("待处理");
    expect(cardView(db, { kind: "application.update", payload: { id: app.chutian, state: "in_process" }, expiresAt: future }).state).toBe("待处理");
    expect(cardView(db, { kind: "stage.add", payload: { applicationId: app.chutian, kind: "二面", scheduledAt: future }, expiresAt: future }).state).toBe("已过时");
    const [f1, f2, f3] = (db.prepare("select id from fact limit 3").all() as any[]).map((r) => r.id);
    const mixed = cardView(db, { kind: "fact.merge", payload: { pairs: [{ fromId: f1, intoId: f2 }, { fromId: f3, intoId: "gone" }] }, expiresAt: future });
    expect(mixed.state).toBe("待处理");
    expect(mixed.why).toContain("1 项");
    expect(cardView(db, { kind: "fact.merge", payload: { pairs: [{ fromId: f3, intoId: "gone" }] }, expiresAt: future }).state).toBe("已过时");
    const cut = s.domain.createProposal("application.update", { id: app.chutian, nextAction: "补材料" }, "agent:mcp", "", -1);
    db.prepare("update proposal set execution = 'interrupted' where id = ?").run(cut.id);
    expect(cardView(db, { kind: "application.update", payload: { id: app.chutian, nextAction: "补材料" }, expiresAt: past, execution: "interrupted" }).state).toBe("待处理");
    await expect(callTool("proposal.renew", { id: cut.id }, HUMAN, s)).rejects.toMatchObject({ code: "NOT_RENEWABLE" });
  });

  it("the list carries the view; folded cards are put away; a run-out card is raised again as a new one, not run", async () => {
    const { s, app } = await world();
    const done = s.domain.createProposal("application.update", { id: app.chutian, state: s.domain.getApplication(app.chutian).state }, "agent:mcp");
    const useful = s.domain.createProposal("application.update", { id: app.chutian, nextAction: "补材料" }, "agent:mcp", "", -1); // already run out
    const list = ((await callTool("proposal.list", {}, HUMAN, s)) as any).items;
    expect(list.find((p: any) => p.id === done.id).view.state).toBe("已完成");
    expect(list.find((p: any) => p.id === useful.id).view.state).toBe("需补救");
    expect(((await callTool("proposal.dismiss", { ids: [done.id] }, HUMAN, s)) as any).dismissed).toBe(1);
    const fresh = ((await callTool("proposal.renew", { id: useful.id }, HUMAN, s)) as any).proposal;
    expect(fresh.payload).toEqual({ id: app.chutian, nextAction: "补材料" });
    expect(s.domain.getApplication(app.chutian).nextAction).not.toBe("补材料"); // raised again, not run
    const pending = ((await callTool("proposal.list", {}, HUMAN, s)) as any).items.map((p: any) => p.id);
    expect(pending).toContain(fresh.id);
    expect(pending).not.toContain(useful.id);
    expect(pending).not.toContain(done.id);
    await expect(callTool("proposal.renew", { id: fresh.id }, HUMAN, s)).rejects.toMatchObject({ code: "NOT_RENEWABLE" });
  });
});
