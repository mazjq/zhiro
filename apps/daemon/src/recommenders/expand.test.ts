import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "../service/domain.js";
import { WorkflowEngine } from "../service/workflow.js";
import type { Services } from "../registry.js";
import { ingest, type Listing } from "../data/index.js";
import { pruneAutoSources, caredCompanies } from "../service/official.js";
import { entryOf, expand, expandable } from "./expand.js";

describe("待展开: where a company's real job list lives", () => {
  it("a readable career system wins; an apply site beats the 公众号 article that announced it", () => {
    expect(entryOf(["https://mp.weixin.qq.com/s/x", "https://app.mokahr.com/campus-recruitment/voyah/146293"])).toMatchObject({ readable: true, label: "可自动展开（Moka）" });
    expect(entryOf(["https://mp.weixin.qq.com/s/x", "https://zhaopin.chnenergy.com.cn/annc/1"]).readable).toBe(true);
    expect(entryOf(["https://mp.weixin.qq.com/s/x", "https://job.example.cn/1"])).toEqual({ readable: false, label: "入口 job.example.cn（暂不能自动读取）" });
    expect(entryOf(["https://zhaopin.cnpc.com.cn/web/recruitInfolist.html"]).label).toMatch(/有反爬.*listing.capture/);
    expect(entryOf(["https://mp.weixin.qq.com/s/x"]).label).toBe("入口是公众号文章（抓取要用模型）");
    expect(entryOf([]).label).toBe("没有入口链接");
  });
});

describe("待展开 and the start-up tidying of subscriptions agree", () => {
  it("a group whose site has been read is no longer named — and its subscription is not taken for one nobody cares about", () => {
    const dir = mkdtempSync(join(tmpdir(), "jobos-expand-"));
    mkdirSync(join(dir, "config"));
    writeFileSync(join(dir, "config", "jobos.yaml"), "sources: []\n", "utf8");
    const db = openDb(join(dir, "t.db"));
    const site = "https://app.mokahr.com/campus-recruitment/shiligroup/100001", own = "https://app.mokahr.com/campus-recruitment/shilipower/300003", other = "https://app.mokahr.com/campus-recruitment/elsewhere/200002";
    const sources: any[] = [
      { id: "moka-示例重工集团", source: "moka", name: "示例重工集团", url: site, auto: true, enabled: true },
      { id: "moka-示例动力集团", source: "moka", name: "示例动力集团", url: own, auto: true, enabled: true },
      { id: "moka-无人关心公司", source: "moka", name: "无人关心公司", url: other, auto: true, enabled: true },
    ];
    const s: Services = { domain: new Domain(db), workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources } };
    // the sheet knows the group by one row of categories, linking its career site; the site files its posts under the units
    const row = (o: Partial<Listing>): Listing => ({ externalId: "r1", url: site, title: "技术类", company: "示例重工集团", companyType: "央国企", industry: "装备制造", locations: ["武汉"], publisher: "汇总表", grade: "聚合", isOriginal: false, confidence: 1, cohort: "2027届", batch: "秋招", ...o });
    ingest(s.domain, dir, "feishu-base", "feishu-base-sheet", [row({})]);
    ingest(s.domain, dir, "moka", "moka-示例重工集团", [row({ company: "示例重工集团第一研究所", title: "控制算法工程师", externalId: "u1", grade: "官方", isOriginal: true, publisher: "示例重工" })]);
    // a second group, whose site files its posts under the group's own name
    ingest(s.domain, dir, "feishu-base", "feishu-base-sheet", [row({}), row({ company: "示例动力集团", externalId: "r2", url: own })]);
    ingest(s.domain, dir, "moka", "moka-示例动力集团", [row({ company: "示例动力集团", title: "电机控制工程师", externalId: "o1", url: own, grade: "官方", isOriginal: true, publisher: "示例动力" })]);
    const group = (db.prepare("select id from company where name = '示例重工集团'").get() as { id: string }).id, group2 = (db.prepare("select id from company where name = '示例动力集团'").get() as { id: string }).id;

    // read once already: nothing is left to expand, so the rule names neither group, and nothing else makes them "cared"
    expect(expand.run(s, {} as any)).toEqual([]);
    expect(caredCompanies(s)).toEqual([]);
    // yet they are exactly the companies the rule would name the moment their subscriptions, and what these brought, went
    expect([...expandable(s)].sort()).toEqual([group, group2].sort());
    // so the tidying keeps those subscriptions (it removed them, the groups were named again, the sites subscribed and read
    // again: every start) — and still removes the one for a company nothing points at
    expect(pruneAutoSources(s)).toEqual({ before: 3, after: 2 });
    expect(s.config.sources.map((c) => c.id)).toEqual(["moka-示例重工集团", "moka-示例动力集团"]);
  });
});
