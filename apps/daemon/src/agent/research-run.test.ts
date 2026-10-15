import { describe, it, expect } from "vitest";
import { ResearchRun, LIMITS } from "./research-run.js";

const cp = (itemId: string, status: any = "answered", urls: string[] = ["https://a.com/1"]) => ({ itemId, status, answer: "x", evidence: urls.map((url) => ({ url })) });

describe("research run controller: it always ends", () => {
  it("the same call three times is refused, the run goes on", () => {
    const r = new ResearchRun();
    expect(r.beforeCall("page_read", { url: "https://a.com", steps: [{ click: "x" }] }).allow).toBe(true);
    expect(r.beforeCall("page_read", { steps: [{ click: "x" }], url: "https://a.com" }).allow).toBe(true); // key order does not matter
    const g: any = r.beforeCall("page_read", { url: "https://a.com", steps: [{ click: "x" }] });
    expect(g).toMatchObject({ allow: false, scope: "call", reason: "identical_call" });
    expect(r.state).toBe("RUNNING");
  });
  it("an A/B cycle is refused after two repetitions", () => {
    const r = new ResearchRun();
    const a = { url: "https://a.com/x" }, b = { url: "https://b.com/y" };
    // identical-call cap would fire first on the 3rd A; use distinct args per pair to isolate the cycle rule
    const gates = [a, b, { ...a, maxChars: 1 }, { ...b, maxChars: 1 }, { ...a, maxChars: 2 }, { ...b, maxChars: 2 }].map((x) => r.beforeCall("page_read", x));
    expect(gates.every((g) => g.allow)).toBe(true); // distinct signatures: no exact cycle
    const r2 = new ResearchRun({ ...LIMITS, identical: 99 });
    const g2 = [a, b, a, b, a, b].map((x) => r2.beforeCall("page_read", x));
    expect(g2.slice(0, 4).every((g) => g.allow)).toBe(true);
    expect(g2[5]).toMatchObject({ allow: false, reason: "ab_cycle" });
  });
  it("budgets stop the whole run and later calls are refused with the run reason", () => {
    const r = new ResearchRun({ ...LIMITS, toolCalls: 3 });
    for (let i = 0; i < 3; i++) expect(r.beforeCall("pool_list", { q: i }).allow).toBe(true);
    expect(r.beforeCall("pool_list", { q: 9 })).toMatchObject({ allow: false, scope: "run", reason: "tool_calls_exceeded" });
    expect(r.state).toBe("STOPPING");
    expect(r.beforeCall("pool_list", { q: 10 })).toMatchObject({ allow: false, scope: "run" });
  });
  it("a site with a login wall is fused after two hits (one login box is not a wall); a per-site browser budget fuses the site, not the run", () => {
    const r = new ResearchRun({ ...LIMITS, browserPerSite: 2 });
    r.afterCall("page_read", { url: "https://x.com/a" }, { status: "needsLogin", finalUrl: "https://x.com/login" });
    r.afterCall("page_read", { url: "https://x.com/a" }, { status: "needsLogin", finalUrl: "https://x.com/login" }); // the same page again is not a second wall
    r.afterCall("page_read", { url: "https://x.com/z" }, { status: "empty", finalUrl: "https://x.com/z" });
    r.afterCall("page_read", { url: "https://x.com/z2" }, { status: "empty", finalUrl: "https://x.com/z2" });
    r.afterCall("page_read", { url: "https://x.com/z3" }, { status: "empty", finalUrl: "https://x.com/z3" }); // empties never fuse
    expect(r.beforeCall("page_read", { url: "https://x.com/b" }).allow).toBe(true);
    r.afterCall("page_read", { url: "https://x.com/b" }, { status: "needsLogin", finalUrl: "https://x.com/login" });
    expect(r.beforeCall("page_read", { url: "https://x.com/c" })).toMatchObject({ allow: false, scope: "site", reason: "site_fused" });
    expect(r.beforeCall("page_read", { url: "https://y.com/1", browser: true }).allow).toBe(true);
    expect(r.beforeCall("page_read", { url: "https://y.com/2", browser: true }).allow).toBe(true);
    expect(r.beforeCall("page_read", { url: "https://y.com/3", browser: true })).toMatchObject({ allow: false, scope: "site", reason: "site_budget_exceeded" });
    expect(r.state).toBe("RUNNING");
  });
  it("stagnation: many calls without a checkpoint making progress stops the run", () => {
    const r = new ResearchRun({ ...LIMITS, stagnant: 10 });
    r.checkpoint(cp("T1"));
    for (let i = 0; i < 10; i++) expect(r.beforeCall("pool_list", { q: i }).allow).toBe(true);
    r.checkpoint(cp("T1")); // same thing again: not progress
    expect(r.beforeCall("pool_list", { q: 99 })).toMatchObject({ allow: false, reason: "stagnant" });
  });
  it("checkpoints are idempotent per item; finish needs no partial items; auto-continue is capped and needs progress", () => {
    const r = new ResearchRun();
    expect(r.checkpoint(cp("T1", "partial")).progress).toBe(true);
    expect(r.checkpoint(cp("T1", "partial")).progress).toBe(false);
    expect(r.finish()).toEqual({ ok: false, missing: ["T1"] });
    expect(r.shouldAutoContinue()).toBe(true);
    expect(r.shouldAutoContinue()).toBe(false); // no progress since
    expect(r.checkpoint(cp("T1", "answered", ["https://a.com/1", "https://a.com/2"])).progress).toBe(true);
    expect(r.shouldAutoContinue()).toBe(true);
    r.checkpoint(cp("T2", "blocked", []));
    expect(r.shouldAutoContinue()).toBe(false); // cap of two
    expect(r.needsFinalize()).toBe(true);
    expect(r.finish().ok).toBe(true);
    expect(r.state).toBe("STOPPING");
    expect(r.needsFinalize()).toBe(false);
    expect(r.ledgerText()).toContain("## T2 · blocked");
  });
});
