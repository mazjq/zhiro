import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { WorkflowEngine } from "./workflow.js";
import { callTool, type Services, type Actor } from "../registry.js";
import { ingest } from "../data/index.js";
import type { Listing } from "../data/index.js";
import { tidyPool, dropOrphanCampaigns } from "./tidy.js";

const HUMAN: Actor = { kind: "human", via: "desktop" };
function setup(sourceIds: { id: string; source: string }[]) {
  const dir = mkdtempSync(join(tmpdir(), "jobos-tidy-"));
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const s: Services = { domain, workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: sourceIds } };
  return { dir, domain, s };
}
const listing = (o: Partial<Listing>): Listing => ({ externalId: o.title ?? "x", url: "https://example.com/j", title: "控制算法工程师", company: "示例", locations: ["武汉"], publisher: "示例", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "秋招", ...o });

describe("evidence-based tidy (2026-10-01)", () => {
  it("campaigns left by a pruned pull subscription are dropped, unless a person holds one of their posts", async () => {
    const { dir, domain, s } = setup([{ id: "beisen-kept", source: "beisen" }]);
    ingest(domain, dir, "beisen", "beisen-kept", [listing({ company: "甲", externalId: "k1" })]);
    ingest(domain, dir, "beisen", "beisen-gone", [listing({ company: "乙", externalId: "g1" }), listing({ company: "乙", externalId: "g2", title: "仿真工程师" })]);
    ingest(domain, dir, "beisen", "beisen-held", [listing({ company: "丙", externalId: "h1" })]);
    const held = ((await callTool("pool.list", { query: "丙" }, HUMAN, s)) as any).items[0].positions[0].id;
    await callTool("position.watch", { positionId: held, priority: 2 }, HUMAN, s);
    expect(tidyPool(s)).toMatchObject({ droppedCampaigns: 1, merged: [] });
    const names = ((await callTool("pool.list", {}, HUMAN, s)) as any).items.map((c: any) => c.companyName).sort();
    expect(names).toEqual(["丙", "甲"]);
  });
  it("a removed subscription takes only what it alone brought: a campaign another subscription also lists stays, with that one's rows", () => {
    const { dir, domain, s } = setup([{ id: "feishu-base-kept", source: "feishu-base" }]);
    const row = (o: Partial<Listing>) => listing({ grade: "聚合", isOriginal: false, publisher: "汇总表", ...o });
    ingest(domain, dir, "feishu-base", "feishu-base-gone", [row({ company: "甲", externalId: "g1" }), row({ company: "乙", externalId: "g2" })]);
    ingest(domain, dir, "feishu-base", "feishu-base-kept", [row({ company: "甲", externalId: "k1" })]);
    expect(dropOrphanCampaigns(s, "feishu-base-gone")).toBe(1);
    expect(domain.db.prepare("select co.name, l.external_id from source_listing l join campaign c on c.id = l.campaign_id join company co on co.id = c.company_id").all()).toEqual([{ name: "甲", external_id: "k1" }]);
    expect(domain.db.prepare("select count(*) n from position").get()).toEqual({ n: 1 });
  });
  it("a sheet of thousands of companies is cleared in seconds (it took 20 s for this many, 19 minutes for the user's sheet of 1 万)", () => {
    const { dir, domain, s } = setup([]);
    const rows: Listing[] = [];
    for (let c = 0; c < 2000; c++) for (let p = 0; p < 10; p++) rows.push(listing({ company: `示例公司${c}`, title: `岗位${p}`, externalId: `r${c}-${p}`, grade: "聚合", isOriginal: false, publisher: "汇总表" }));
    ingest(domain, dir, "feishu-base", "feishu-base-big", rows);
    const t = Date.now();
    expect(dropOrphanCampaigns(s, "feishu-base-big")).toBe(2000);
    expect(Date.now() - t).toBeLessThan(4000);
    expect(domain.db.prepare("select (select count(*) from campaign) c, (select count(*) from position) p, (select count(*) from source_listing) l").get()).toEqual({ c: 0, p: 0, l: 0 });
  }, 60_000);
  it("whatever points at a post or a campaign can be looked up by an index (deleting one makes SQLite look, once per row deleted)", () => {
    const { domain: { db } } = setup([]);
    const bare: string[] = [];
    for (const { name } of db.prepare("select name from sqlite_master where type = 'table'").all() as { name: string }[]) {
      const led = new Set((db.prepare(`pragma index_list(${name})`).all() as { name: string }[]).map((i) => (db.prepare(`pragma index_info(${i.name})`).all() as { name: string }[])[0]?.name));
      for (const f of db.prepare(`pragma foreign_key_list(${name})`).all() as { table: string; from: string }[]) if ((f.table === "position" || f.table === "campaign") && name !== "application" && !led.has(f.from)) bare.push(`${name}.${f.from}`);
    }
    expect(bare).toEqual([]); // application is left out: a person's applications are a few dozen rows
    // and a subscription's last runs (asked once per subscription by source.list) are found, not scanned for
    const plan = (db.prepare("explain query plan select started_at from scan_run where config_id = ? order by started_at desc limit 10").all("x") as { detail: string }[]).map((r) => r.detail).join("; ");
    expect(plan).not.toContain("SCAN");
  });
  it("an agent's merge proposal: stale → expired, same recruiting page → merged, a name that only contains the other → left for the person with both names", async () => {
    const { dir, domain, s } = setup([{ id: "moka-a", source: "moka" }, { id: "feishu-base-s", source: "feishu-base" }, { id: "moka-b", source: "moka" }]);
    ingest(domain, dir, "moka", "moka-a", [listing({ company: "嘉立创集团", externalId: "a1", url: "https://jlc.zhiye.com/campus/jobs/1" })]);
    ingest(domain, dir, "feishu-base", "feishu-base-s", [listing({ company: "嘉立创", grade: "聚合", isOriginal: false, publisher: "汇总表", externalId: "s1", title: "软件工程师", url: "https://jlc.zhiye.com/campus/jobs/1" })]);
    ingest(domain, dir, "moka", "moka-b", [listing({ company: "荣耀终端股份有限公司", externalId: "b1", url: "https://career.honor.com/x" })]);
    ingest(domain, dir, "feishu-base", "feishu-base-s", [listing({ company: "荣耀", grade: "聚合", isOriginal: false, publisher: "汇总表", externalId: "s2", title: "硬件工程师", url: "https://example.com/sheet-row" })]);
    const id = (n: string) => (domain.db.prepare("select id from company where name = ?").get(n) as { id: string }).id;
    const AGENT: Actor = { kind: "agent", via: "mcp" };
    await callTool("company.merge", { fromId: id("嘉立创"), intoId: id("嘉立创集团") }, AGENT, s);
    await callTool("company.merge", { fromId: id("荣耀"), intoId: id("荣耀终端股份有限公司") }, AGENT, s);
    await callTool("company.merge", { fromId: id("荣耀"), intoId: "01NOSUCHCOMPANY0000000000" }, AGENT, s);
    const listed = ((await callTool("proposal.list", {}, HUMAN, s)) as any).items;
    expect(listed).toHaveLength(1); // 嘉立创 merged on evidence, the one into a missing company expired
    expect(listed[0].context).toMatchObject({ from: { name: "荣耀", official: false }, into: { name: "荣耀终端股份有限公司", official: true }, strong: false });
    expect(listed[0].context.signals.join("")).toContain("名字包含");
    expect(domain.db.prepare("select 1 from company where name = '嘉立创'").get()).toBeUndefined();
  });

  it("one unit spelled two ways merges into the spelling that has the official source; two official spellings stay apart", async () => {
    const { dir, domain, s } = setup([{ id: "moka-a", source: "moka" }, { id: "moka-b", source: "moka" }, { id: "feishu-base-s", source: "feishu-base" }]);
    ingest(domain, dir, "moka", "moka-a", [listing({ company: "中国船舶集团有限公司第七二二研究所", externalId: "a1" })]);
    ingest(domain, dir, "feishu-base", "feishu-base-s", [listing({ company: "中船七二二所", grade: "聚合", isOriginal: false, publisher: "汇总表", externalId: "s1", title: "软件工程师" })]);
    ingest(domain, dir, "moka", "moka-a", [listing({ company: "中国船舶集团有限公司第七一九研究所", externalId: "a2" })]);
    ingest(domain, dir, "moka", "moka-b", [listing({ company: "中船七一九所", externalId: "b1" })]);
    const r = tidyPool(s);
    expect(r.merged).toEqual([{ from: "中船七二二所", into: "中国船舶集团有限公司第七二二研究所" }]);
    const items = ((await callTool("pool.list", {}, HUMAN, s)) as any).items;
    const merged = items.find((c: any) => c.companyName === "中国船舶集团有限公司第七二二研究所");
    expect(merged.positions.map((p: any) => p.title).sort()).toEqual(["控制算法工程师", "软件工程师"]);
    expect(items.map((c: any) => c.companyName).sort()).toEqual(["中国船舶集团有限公司第七一九研究所", "中国船舶集团有限公司第七二二研究所", "中船七一九所"]);
  });
});
