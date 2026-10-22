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
    expect(cardView(db, { kind: "stage.add", payload: { applicationId: a.id, kind: "笔试", scheduledAt: past }, expiresAt: future }).state).toBe("已过时");
    expect(cardView(db, { kind: "application.update", payload: { id: "nope" }, expiresAt: future }).state).toBe("已过时");
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
