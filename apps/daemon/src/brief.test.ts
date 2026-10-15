/** D-22 / D-23: the short form only when asked; one copy of a result only for a connection that asked. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { seedWorld } from "./eval/seed.js";
import { callTool, type Actor } from "./registry.js";
import { resolveFor } from "./service/deadlines.js";
import { deadlineBrief } from "./service/brief.js";
import { createMcpServer, type ResultMode } from "./mcp/server.js";

const AGENT: Actor = { kind: "agent", via: "mcp" } as Actor;
const world = () => seedWorld(mkdtempSync(join(tmpdir(), "zhiro-brief-")));

describe("list tools: a call without the new parameters is what it always was", () => {
  it("position.list and application.list without detail: same items as the old code, no new keys", async () => {
    const w = await world(), s = w.s;
    const r = (await callTool("position.list", { limit: 50 }, AGENT, s)) as any;
    const old = s.domain.listPositions({ limit: 50 } as any), d = resolveFor(s.domain.db, old.items.map((p: any) => p.id));
    expect(r).toEqual({ items: old.items.map((p: any) => ({ ...p, closesAt: d.get(p.id)?.date ?? null, deadline: d.get(p.id) })) });
    expect(r.items.some((p: any) => p.jdText)).toBe(true);
    const a = (await callTool("application.list", {}, AGENT, s)) as any;
    expect(Object.keys(a)).toEqual(["items"]);
    expect(a.items.length).toBeGreaterThan(0);
    const p = (await callTool("pool.list", {}, AGENT, s)) as any;
    expect(p.detail).toBeUndefined();
    expect(p.items.every((c: any) => Array.isArray(c.positions))).toBe(true);
  });
});

describe("the short form", () => {
  it("position.list brief: no description, a deadline to judge by, pages with hasMore", async () => {
    const w = await world(), s = w.s;
    const all = (await callTool("position.list", { limit: 100 }, AGENT, s)) as any;
    const b = (await callTool("position.list", { limit: 3, detail: "brief" }, AGENT, s)) as any;
    expect(b.detail).toBe("brief");
    expect(b.items).toHaveLength(3);
    expect(b.hasMore).toBe(all.items.length > 3);
    for (const p of b.items) {
      expect(p.jdText).toBeUndefined();
      expect(p.noticeUrl).toBeUndefined();
      expect(Object.keys(p.deadline).sort()).toEqual(["closesAt", "conflictsCount", "deadlineKind", "expired", "say", "status"]);
    }
    const page2 = (await callTool("position.list", { limit: 3, offset: 3, detail: "brief" }, AGENT, s)) as any;
    expect(page2.items.map((p: any) => p.id)).toEqual(all.items.slice(3, 6).map((p: any) => p.id));
    const last = (await callTool("position.list", { limit: 100, offset: all.items.length - 1, detail: "brief" }, AGENT, s)) as any;
    expect(last.items).toHaveLength(1);
    expect(last.hasMore).toBe(false);
  });

  it("a deadline nobody knows is not 'not expired'", () => {
    expect(deadlineBrief({ policy: "unknown", date: null, dateText: "", status: "unverified", scope: "none", say: "截止未核实", source: null, conflicts: [], expired: false, process: "" })!.expired).toBeNull();
    expect(deadlineBrief({ policy: "until_filled", date: null, dateText: "", status: "verified", scope: "campaign", say: "招满即止", source: null, conflicts: [], expired: false, process: "" })!.expired).toBe(false);
  });

  it("application.list brief: what comes next stays, the description goes; total and pages", async () => {
    const w = await world(), s = w.s;
    const full = (await callTool("application.list", {}, AGENT, s)) as any;
    const b = (await callTool("application.list", { detail: "brief", limit: 2 }, AGENT, s)) as any;
    expect(b.total).toBe(full.items.length);
    expect(b.items).toHaveLength(Math.min(2, full.items.length));
    expect(b.hasMore).toBe(full.items.length > 2);
    for (const x of b.items) {
      expect(x.jdText).toBeUndefined();
      expect(x.application).toEqual(expect.objectContaining({ id: expect.any(String), positionId: expect.any(String), state: expect.any(String) }));
      if (x.lastEvent) expect(typeof x.lastEvent.truncated).toBe("boolean");
    }
  });

  it("pool.list brief: every matched post (compact) under a new name, the rest counted; expired kept even when unknown", async () => {
    const w = await world(), s = w.s;
    const full = (await callTool("pool.list", { limit: 1000 }, AGENT, s)) as any;
    const b = (await callTool("pool.list", { detail: "brief", limit: 1000 }, AGENT, s)) as any;
    expect(b.total).toBe(full.total);
    for (const c of b.items) {
      const f = full.items.find((x: any) => x.companyId === c.companyId);
      const matched = f.positions.filter((p: any) => p.match).map((p: any) => p.id).sort();
      expect(c.positions).toBeUndefined();
      expect(c.matchedPositions.map((p: any) => p.id).sort()).toEqual(matched.slice(0, 50).length === matched.length ? matched : expect.any(Array));
      expect(c.matchedPositionsTotal).toBe(matched.length);
      expect(c.otherPositionsTotal).toBe(f.positions.length - matched.length);
      expect(c.allPositionsTotal).toBe(f.positions.length);
      expect(c.sourcesCount).toBe(f.sources.length);
      for (const p of [...c.matchedPositions, ...c.otherPositionPreviews]) expect("expired" in p).toBe(true);
    }
    const page = (await callTool("pool.list", { detail: "brief" }, AGENT, s)) as any;
    expect(page.items.length).toBeLessThanOrEqual(20);
    expect(page.hasMore).toBe(full.total > 20);
  });
});

describe("one copy of a result, for a connection that asked", () => {
  async function connect(mode: ResultMode) {
    const w = await world();
    const [a, b] = InMemoryTransport.createLinkedPair();
    await createMcpServer(w.s, AGENT, mode).connect(a);
    const c = new Client({ name: "t", version: "0" });
    await c.connect(b);
    return { c, w };
  }
  it("dual (default): text and structured, as before", async () => {
    const { c } = await connect("dual");
    const r = (await c.callTool({ name: "today.summary", arguments: {} })) as any;
    expect(r.content[0].type).toBe("text");
    expect(JSON.parse(r.content[0].text)).toEqual(r.structuredContent);
  });
  it("text: the text copy only — a confirm card too", async () => {
    const { c, w } = await connect("text");
    const r = (await c.callTool({ name: "today.summary", arguments: {} })) as any;
    expect(r.structuredContent).toBeUndefined();
    expect(JSON.parse(r.content[0].text).deadlines).toBeDefined();
    // closing an application is asked of the person: a confirm card comes back
    const card = (await c.callTool({ name: "application.update", arguments: { id: w.app.chutian, state: "closed", closeReason: "测试" } })) as any;
    expect(card.structuredContent).toBeUndefined();
    expect(JSON.parse(card.content[0].text).proposal).toBeTruthy();
  });
});
