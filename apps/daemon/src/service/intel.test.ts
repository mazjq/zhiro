import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { pickListing, flagAnnouncements, importSme, smeMatch, parseNews, pickIpo, brief } from "./intel.js";

describe("企业情况 (ADR-029) offline parts", () => {
  it("picks the listed entity behind a company name, ignoring delisted and unrelated hits", () => {
    const hits = [
      { code: "300024", orgId: "9900004062", category: "A股", zwjc: "机器人", delisted: "false" },
      { code: "002415", orgId: "9900012688", category: "A股", zwjc: "海康威视", delisted: "false" },
      { code: "000001", orgId: "x", category: "A股", zwjc: "海康威视", delisted: "true" },
    ];
    expect(pickListing("杭州海康威视数字技术股份有限公司", hits)).toMatchObject({ code: "002415", market: "A股" });
    expect(pickListing("海康威视", hits)?.code).toBe("002415");
    expect(pickListing("智元机器人", [])).toBeNull();
  });
  it("flags what a candidate cares about in announcement titles", () => {
    const r = flagAnnouncements([
      { date: "2026-09-01", title: "关于公司获评国家级专精特新“小巨人”企业的公告", url: "u1" },
      { date: "2026-08-01", title: "关于收到政府补助的公告", url: "u2" },
      { date: "2026-07-01", title: "关于高级管理人员减持股份的预披露公告", url: "u3" },
      { date: "2026-06-01", title: "2026年半年度报告", url: "u4" },
    ]);
    expect(r.flags).toEqual({ 专精特新: 1, 政府补助: 1, 减持: 1, 业绩: 1 });
    expect(r.hits.map((h) => h.url)).toEqual(["u1", "u2", "u3"]); // 业绩 reports are counted, not listed
  });
  it("news items lose the search highlighting and tracking query; an IPO project is matched by company name", () => {
    const n = parseNews({ data: { count: 9, items: [{ display_time: 1767609282, title: "<em>智</em><em>元</em><em>机器人</em>2025年出货量超过5100台", uri: "https://wallstreetcn.com/articles/3762574?keyword=x" }] } });
    expect(n).toEqual({ total: 9, items: [{ date: "2026-01-05", title: "智元机器人2025年出货量超过5100台", url: "https://wallstreetcn.com/articles/3762574" }] });
    const rows = [{ cmpnm: "苏州朗高电机科技股份有限公司", cmpsnm: "朗高科技", prjst: "上市委会议通过", boardName: "创业板", regloc: "江苏", sprinsts: "华泰联合", updtdt: "2026-09-10 00:00:00" }];
    expect(pickIpo("朗高科技", rows)).toMatchObject({ exchange: "深交所", stage: "上市委会议通过", sponsor: "华泰联合", updatedAt: "2026-09-10" });
    expect(pickIpo("智元机器人", rows)).toBeNull();
  });
  it("stored rows are whole; the card summary clips them the old way and is idempotent", () => {
    const irm = { items: Array.from({ length: 10 }, (_, i) => ({ date: "2026-09-01", q: "问".repeat(80), a: "答".repeat(300) + i })) };
    const b = brief("irm", irm);
    expect(b.items).toHaveLength(3);
    expect(b.items[0].a).toHaveLength(91); // 90 + …
    expect(brief("irm", b)).toEqual(b);
    expect(brief("holders", { top: Array(10).fill({ name: "x", pct: 1 }) }).top).toHaveLength(5);
    expect(brief("finance", { annual: [] })).toEqual({ annual: [] });
    expect(brief("news", { total: 0 })).toEqual({ total: 0 });
  });
  it("imports the 专精特新 roster with an update time and matches company names loosely", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-intel-"));
    mkdirSync(join(dir, "research"));
    writeFileSync(join(dir, "research", "sme-list.csv"), "name,level,batch,region,source_url,published_at\n杭州海康威视数字技术股份有限公司,国家级小巨人,第一批,浙江,https://miit.gov.cn/x,2019-06\n深圳市其域创新科技有限公司,省级专精特新,2024年,广东,,2024-05\n", "utf8");
    const db = openDb(join(dir, "t.db"));
    const r = importSme(db, dir);
    expect(r).toMatchObject({ rows: 2, inserted: 2, updated: 0 });
    expect(importSme(db, dir)).toMatchObject({ inserted: 0, updated: 2 });
    const m = smeMatch(db, "海康威视");
    expect(m.matches).toHaveLength(0);
    expect(m.near.map((x) => x.name)).toEqual(["杭州海康威视数字技术股份有限公司"]);
    expect(smeMatch(db, "深圳市其域创新科技有限公司").matches[0]).toMatchObject({ level: "省级专精特新", exact: true });
    expect(smeMatch(db, "其域创新科技").matches).toHaveLength(1); // the sheet's short name, without the city and the suffix
    expect(m.rosterSize).toBe(2);
    expect(m.rosterUpdatedAt).toBeTruthy();
  });
});

describe("data channels (ADR-031)", () => {
  it("every company-intel kind the refresh writes is described as a channel", async () => {
    const CHANNELS = (await import("../channels.js")).channels();
    const ids = new Set(CHANNELS.map((c) => c.id));
    for (const k of ["listing", "basic", "finance", "dividends", "announcements", "holders", "irm", "sectors", "reports", "forecast", "news", "ipo"]) expect(ids.has(`intel:${k}`)).toBe(true);
    for (const c of CHANNELS) expect(["免费", "模型", "联网调研"]).toContain(c.cost);
  });
});
