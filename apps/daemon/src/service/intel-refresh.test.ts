import { describe, it, expect, afterEach, vi } from "vitest";
import { createServices, testConfig } from "../services.js";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import type { Services } from "../services.js";
import { getIntel, readIntel, refreshIntel, EVERY_DAYS } from "./intel.js";

function setup() {
  const vault = mkdtempSync(join(tmpdir(), "zhiro-intel-"));
  const domain = new Domain(openDb(join(vault, "t.db")));
  const s: Services = createServices({ db: domain.db, domain, config: testConfig(vault, { sources: [] }) });
  domain.db.prepare("insert into company(id, name, norm, created_at) values ('c1', '汇川技术', '汇川技术', '2026-01-01')").run();
  return s;
}
const ago = (days: number) => new Date(Date.now() - days * 86400_000).toISOString();
const keep = (s: Services, kind: string, data: unknown, days: number) =>
  s.domain.db.prepare("insert or replace into company_intel(company_id, kind, data_json, source, fetched_at) values ('c1', ?, ?, 'test', ?)").run(kind, JSON.stringify(data), ago(days));

describe("企业情况: each kind on its own period, fetched behind the card (2026-10-21)", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("only the stale kinds are fetched; a kind that failed waits; a card never generated fetches nothing by itself", async () => {
    const s = setup();
    const hosts: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => { hosts.push(new URL(url).hostname); throw new Error("offline"); });
    expect(readIntel(s, "c1")).toMatchObject({ listing: null, refreshing: false }); // nothing stored: wait for 生成
    expect(hosts).toEqual([]);

    keep(s, "listing", { code: "300124", orgId: "o", market: "A股", name: "汇川技术" }, 10);
    for (const k of ["basic", "finance", "dividends", "announcements", "holders", "irm", "sectors", "reports", "forecast"]) keep(s, k, {}, 0);
    keep(s, "news", { items: [] }, 2); // a day is its period
    const card = getIntel(s, "c1");
    expect(card.staleKinds).toEqual(["news"]);
    expect(card.rows.find((r) => r.kind === "finance")).toMatchObject({ everyDays: EVERY_DAYS.finance, stale: false });

    const r = await refreshIntel(s, "c1");
    expect(new Set(hosts).size).toBe(1); // one source asked: the news search
    expect(Object.keys(r.errors)).toEqual(["news"]); // only news was asked for; no IPO lookup for an A-share company
    const asked = hosts.length;
    await refreshIntel(s, "c1"); // failed a moment ago: not asked again yet
    expect(hosts.length).toBe(asked);
    await refreshIntel(s, "c1", { force: true }); // the button: every kind, now
    expect(hosts.length).toBeGreaterThan(asked + 5);
  });

  it("a listing found holds half a year; nothing found is looked for again in a month", () => {
    const s = setup();
    keep(s, "listing", { none: true }, 40);
    expect(getIntel(s, "c1").staleKinds).toEqual(["listing"]);
    keep(s, "listing", { code: "300124", orgId: "o", market: "A股" }, 40);
    expect(getIntel(s, "c1").staleKinds).toEqual([]);
  });
});
