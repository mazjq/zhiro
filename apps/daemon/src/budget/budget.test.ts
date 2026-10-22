/** P5: background work and the person's allowance; quiet around tests and full screen. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { WorkflowEngine } from "../service/workflow.js";
import { createLlm } from "../llm.js";
import { asBackground, BudgetDeferred, budgetSettings, claudeReadings, decide, fillPerHour, recordReadings, type Reading } from "./index.js";
import { codexReadings } from "./codex.js";
import { examQuiet } from "./quiet.js";
import { seedWorld } from "../eval/seed.js";

const H = 3600_000;
const NOW = Date.parse("2026-10-22T10:00:00+08:00");
const set = budgetSettings({});
const r = (win: string, used: number, resetsInH: number): Reading => ({ channel: "claude", win, used, resetsAt: new Date(NOW + resetsInH * H).toISOString(), at: new Date(NOW).toISOString() });
const db = () => openDb(join(mkdtempSync(join(tmpdir(), "zhiro-budget-")), "t.db"));

describe("the decision", () => {
  it("defaults: 30% kept for the person, $1 a day on a key, 100k tokens before any reading; nonsense is pulled back", () => {
    expect(set).toMatchObject({ reserve: 0.3, apiDailyUsd: 1, unknownDailyTokens: 100_000 });
    expect(budgetSettings({ background: { reserve: 5, apiDailyUsd: -1 } })).toMatchObject({ reserve: 0.9, apiDailyUsd: 0 });
  });
  it("a window past the reserve waits for its reset; every window counts, not only the week", () => {
    const d = decide(NOW, "claude", [r("seven_day", 0.41, 72), r("five_hour", 0.75, 2)], () => null, { tokens: 0, cost: 0 }, set);
    expect(d.ok).toBe(false);
    if (!d.ok) { expect(d.until).toBe(new Date(NOW + 2 * H).toISOString()); expect(d.why).toContain("5 小时额度"); }
  });
  it("a window that would pass the reserve before it resets, at the speed it fills, waits an hour", () => {
    const d = decide(NOW, "claude", [r("seven_day", 0.5, 48)], () => 0.01, { tokens: 0, cost: 0 }, set); // 50% + 1%/h × 48 h ≥ 70%
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.until).toBe(new Date(NOW + H).toISOString());
    expect(decide(NOW, "claude", [r("seven_day", 0.5, 48)], () => 0.001, { tokens: 0, cost: 0 }, set).ok).toBe(true);
  });
  it("no reading yet: a small daily allowance; an API key: a daily spend", () => {
    expect(decide(NOW, "codex", [], () => null, { tokens: 50_000, cost: 0 }, set).ok).toBe(true);
    expect(decide(NOW, "codex", [], () => null, { tokens: 100_000, cost: 0 }, set).ok).toBe(false);
    expect(decide(NOW, "api", [], () => null, { tokens: 0, cost: 0.4 }, set).ok).toBe(true);
    expect(decide(NOW, "api", [], () => null, { tokens: 0, cost: 1.2 }, set).ok).toBe(false);
  });
});

describe("readings", () => {
  it("Codex: whatever windows the plan has (a week only, here)", () => {
    const rs = codexReadings({ rateLimits: { primary: { usedPercent: 19, windowDurationMins: 10080, resetsAt: 1793084760 }, secondary: null } });
    expect(rs).toEqual([expect.objectContaining({ channel: "codex", win: "primary:10080", used: 0.19, durationMins: 10080 })]);
  });
  it("Claude Code: five hours and seven days from its rate_limit_event", () => {
    const rs = claudeReadings({ unifiedWindows: { five_hour: { utilization: 0.1, resetsAt: 1792650600 }, seven_day: { utilization: 0.41, resetsAt: 1793073600 } } });
    expect(rs.map((x) => [x.win, x.used])).toEqual([["five_hour", 0.1], ["seven_day", 0.41]]);
  });
  it("speed: from readings in one reset period; a reset in between says nothing", () => {
    const d = db();
    const at = (h: number) => new Date(NOW + h * H).toISOString();
    recordReadings(d, [{ channel: "claude", win: "seven_day", used: 0.2, resetsAt: "R1", at: at(-4) }, { channel: "claude", win: "seven_day", used: 0.24, resetsAt: "R1", at: at(-2) },
      { channel: "claude", win: "seven_day", used: 0.01, resetsAt: "R2", at: at(-1) }]);
    expect(fillPerHour(d, "claude", "seven_day")).toBeCloseTo(0.02);
  });
});

describe("quiet around a test", () => {
  it("from 30 minutes before to 2 hours after a written test or an interview on record", async () => {
    const w = await seedWorld(mkdtempSync(join(tmpdir(), "zhiro-quiet-")));
    const d = w.s.domain.db;
    d.prepare("update stage set scheduled_at = null").run();
    d.prepare("update stage set kind = '笔试', result = '', scheduled_at = ? where id = (select id from stage limit 1)").run(new Date(NOW + 20 * 60_000).toISOString());
    expect(examQuiet(d, NOW, 30, 120)).toContain("笔试");
    expect(examQuiet(d, NOW - 60 * 60_000, 30, 120)).toBeNull();
    expect(examQuiet(d, NOW + 3 * H, 30, 120)).toBeNull();
  });
});

describe("waiting is not failing", () => {
  it("a run held at the gate keeps its attempts and says what it waits for", async () => {
    const d = db();
    const w = new WorkflowEngine(d);
    let ran = 0;
    w.register({ kind: "lead_resolve", order: ["go"], steps: { go: async () => { ran++; return { type: "done" }; } } });
    w.gate = async () => ({ until: new Date(Date.now() + H).toISOString(), why: "周额度已用 75%" });
    w.start("lead_resolve", "x", "k");
    await w.tick();
    const row = d.prepare("select state, attempts, last_error from workflow").get() as any;
    expect(ran).toBe(0);
    expect(row).toMatchObject({ state: "running", attempts: 0, last_error: "等待：周额度已用 75%" });
  });
  it("a model call refused mid-run sleeps the run instead of counting a failure", async () => {
    const d = db();
    const w = new WorkflowEngine(d);
    w.register({ kind: "lead_resolve", order: ["go"], steps: { go: async () => { throw new BudgetDeferred(new Date(Date.now() + H).toISOString(), "5 小时额度已用 80%"); } } });
    w.start("lead_resolve", "x", "k");
    await w.tick();
    expect(d.prepare("select state, attempts, last_error from workflow").get()).toMatchObject({ state: "running", attempts: 0, last_error: "等待：5 小时额度已用 80%" });
  });
});

describe("only background work asks", () => {
  const llm = (harness?: () => Promise<any>) => {
    const l = createLlm({ vault: mkdtempSync(join(tmpdir(), "zhiro-budget-llm-")), llm: { provider: "openai-codex", model: "x" } } as any);
    const asked: string[] = [];
    l.route = () => ({ kind: "harness", name: "claude" });
    l.harness = harness ?? (async () => ({ text: "ok", model: "m", usage: { input: 1, output: 1, cacheRead: 0, total: 2 } }));
    l.gate = async (kind) => { asked.push(kind); return kind === "lead_resolve" ? { ok: false, until: new Date(NOW + H).toISOString(), why: "周额度已用 75%" } : { ok: true }; };
    return { l, asked };
  };
  const ctx = { systemPrompt: "", messages: [{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 }] };
  it("a scheduled lookup is refused; mail asks (its own ceiling); research the person started and their own calls do not ask", async () => {
    const { l, asked } = llm();
    await expect(asBackground("lead_resolve", () => l.models.completeSimple({} as any, ctx as any))).rejects.toMatchObject({ code: "BUDGET_DEFERRED" });
    await expect(asBackground("inbox_poll", () => l.models.completeSimple({} as any, ctx as any))).resolves.toBeTruthy();
    await expect(asBackground("research_run", () => l.models.completeSimple({} as any, ctx as any))).resolves.toBeTruthy();
    await expect(l.models.completeSimple({} as any, ctx as any)).resolves.toBeTruthy();
    expect(asked).toEqual(["lead_resolve", "inbox_poll"]);
  });
  it("a refusal for the allowance in the middle of background work is a wait, other failures stay failures", async () => {
    const { l } = llm(async () => { throw new Error("BACKGROUND_FAILED: claude：usage limit reached：Claude AI usage limit reached|1792650600"); });
    await expect(asBackground("capture_recheck", () => l.models.completeSimple({} as any, ctx as any))).rejects.toMatchObject({ code: "BUDGET_DEFERRED" });
    const { l: l2 } = llm(async () => { throw new Error("BACKGROUND_FAILED: claude：一分钟没有任何输出"); });
    await expect(asBackground("capture_recheck", () => l2.models.completeSimple({} as any, ctx as any))).rejects.not.toMatchObject({ code: "BUDGET_DEFERRED" });
  });
  it("a gate that throws holds the work instead of letting it through", async () => {
    const { l } = llm();
    l.gate = async () => { throw new Error("db locked"); };
    await expect(asBackground("lead_resolve", () => l.models.completeSimple({} as any, ctx as any))).rejects.toMatchObject({ code: "BUDGET_DEFERRED" });
  });
});

describe("old and stale readings", () => {
  it("a window whose reset has passed says nothing; a reading is aged by how fast its window fills", () => {
    const old = { ...r("five_hour", 0.9, -1) };
    expect(decide(NOW, "claude", [old], () => null, { tokens: 0, cost: 0 }, set).ok).toBe(true); // reset already: unknown, small allowance
    const read3hAgo = { ...r("seven_day", 0.55, 72), at: new Date(NOW - 3 * H).toISOString() };
    expect(decide(NOW, "claude", [read3hAgo], () => 0.06, { tokens: 0, cost: 0 }, set).ok).toBe(false); // 55% + 3 h × 6%/h = 73%
  });
  it("mail goes on up to 95%", () => {
    expect(decide(NOW, "claude", [r("five_hour", 0.8, 2)], () => null, { tokens: 0, cost: 0 }, set, 0.95).ok).toBe(true);
    expect(decide(NOW, "claude", [r("five_hour", 0.96, 2)], () => null, { tokens: 0, cost: 0 }, set, 0.95).ok).toBe(false);
  });
});
