/** S1: maintenance mode reads and writes nothing — not a row, not even the audit line of a read. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorld } from "./eval/seed.js";
import { callTool, type Actor } from "./registry.js";
import { census } from "./upgrade.js";
import { Domain } from "./service/domain.js";
import { enterMaintenance } from "./maintenance.js";

const HUMAN: Actor = { kind: "human", via: "desktop" };
const AGENT: Actor = { kind: "agent", via: "mcp", cred: "agent" };

describe("maintenance mode", () => {
  it("reads answer, writes and outward calls are refused, and the database is left exactly as it was", async () => {
    const w = await seedWorld(mkdtempSync(join(tmpdir(), "zhiro-maint-")));
    const s = w.s;
    s.config.maintenance = true;
    s.domain = new Domain(s.domain.db, { readOnly: true });
    const real = globalThis.fetch;
    enterMaintenance();
    await expect(fetch("https://example.com")).rejects.toMatchObject({ code: "MAINTENANCE" });
    globalThis.fetch = real;
    const before = census(s.domain.db);
    for (const [name, input] of [["today.summary", {}], ["position.list", { detail: "brief" }], ["application.list", {}], ["pool.list", { detail: "brief" }], ["proposal.list", {}]] as const) {
      expect(await callTool(name, input, HUMAN, s)).toBeTruthy();
      expect(await callTool(name, input, AGENT, s)).toBeTruthy();
    }
    await expect(callTool("application.update", { id: w.app.chutian, nextAction: "x" }, HUMAN, s)).rejects.toMatchObject({ code: "MAINTENANCE" });
    await expect(callTool("position.watch", { positionId: w.pos.yuanche_test, priority: 2 }, AGENT, s)).rejects.toMatchObject({ code: "MAINTENANCE" });
    for (const [n, i] of [["page.read", { url: "https://example.com" }], ["data.export", {}], ["apply.close", {}]] as const) await expect(callTool(n, i, HUMAN, s)).rejects.toMatchObject({ code: "MAINTENANCE" });
    expect(census(s.domain.db)).toEqual(before);
  });
});
