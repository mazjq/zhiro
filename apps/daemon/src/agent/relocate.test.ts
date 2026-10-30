import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServices, testConfig, type Services } from "../services.js";
import { openDb } from "../db.js";
import { Domain } from "../service/domain.js";
import { apply, sourceRelocate, startRelocate } from "./relocate.js";

const OLD = "https://app.mokahr.com/campus-recruitment/old/1", NEW = "https://app.mokahr.com/campus-recruitment/new/2";
function setup(): Services {
  const vault = mkdtempSync(join(tmpdir(), "jobos-relocate-"));
  mkdirSync(join(vault, "config"));
  const db = openDb(join(vault, "t.db"));
  const s = createServices({ db, domain: new Domain(db), config: testConfig(vault, { sources: [
    { id: "moka-old", source: "moka", name: "某公司", url: OLD, everyHours: 24 },
    { id: "moka-new", source: "moka", name: "某公司", url: NEW, everyHours: 24 },
  ] }) });
  s.workflows.register(sourceRelocate(s));
  return s;
}
const answer = (over: object = {}) => ({ verdict: "moved" as const, url: NEW, same_company: true, evidence: [{ url: "https://mou.com/join", kind: "official_site", says: "校园招聘 → 新链接" }], summary: "官网换了新站", ...over });
const ids = (s: Services) => s.config.sources.map((c) => c.id);

describe("找新地址", () => {
  it("asks once per subscription, address and reason", () => {
    const s = setup();
    const a = startRelocate(s, "moka-old", "SITE_GONE: Moka：未找到对应的官网", true);
    expect(startRelocate(s, "moka-old", "SITE_GONE: 又一次", true)).toBe(a);
    expect(startRelocate(s, "moka-old", "LINK_STALE: 别的原因", true)).not.toBe(a);
  });

  it("switches only with evidence beyond a search, the same company, another site, and a read that lists posts", async () => {
    const s = setup(), reads: string[] = [];
    const ok = async (url: string) => (reads.push(url), { posts: 3 });
    expect(await apply(s, "moka-old", OLD, answer({ same_company: false }), ok)).toContain("不能确认是同一家");
    expect(await apply(s, "moka-old", OLD, answer({ evidence: [{ url: "https://baidu.com/s", kind: "search", says: "" }] }), ok)).toContain("只有搜索结果");
    expect(await apply(s, "moka-old", OLD, answer({ url: "https://mou.com/careers" }), ok)).toContain("不能自动读");
    expect(await apply(s, "moka-old", OLD, answer({ verdict: "season_over", url: "" }), ok)).toContain("等下一季");
    // the same tenant under another link (or the old link given back) is not a move: the old subscription stays
    expect(await apply(s, "moka-old", OLD, answer({ url: OLD + "?locale=zh-CN" }), ok)).toContain("同一个站");
    expect(reads).toEqual([]);
    expect(await apply(s, "moka-old", OLD, answer(), async () => ({ error: "SITE_GONE: 未找到对应的官网" }))).toContain("读不成");
    expect(await apply(s, "moka-old", OLD, answer(), async () => ({ posts: 0 }))).toContain("一个岗位都没有");
    expect(ids(s)).toEqual(["moka-old", "moka-new"]);
  });

  it("a subscription changed while the new address was read is left alone", async () => {
    const s = setup();
    expect(await apply(s, "moka-old", OLD, answer(), async () => { s.config.sources[0].url = OLD + "9"; return { posts: 3 }; })).toContain("已经改过");
    expect(ids(s)).toEqual(["moka-old", "moka-new"]);
  });

  it("switches after the new address reads; one already subscribed is read too and only the old one goes", async () => {
    const s = setup(), reads: string[] = [];
    expect(await apply(s, "moka-old", OLD, answer(), async (u) => (reads.push(u), { posts: 3 }))).toContain("本来就订阅了");
    expect(reads).toEqual([NEW]);
    expect(ids(s)).toEqual(["moka-new"]);
  });

  it("a new address not yet subscribed becomes the subscription, under the old one's name", async () => {
    const s = setup(), NEW2 = "https://app.mokahr.com/campus-recruitment/other/3";
    expect(await apply(s, "moka-old", OLD, answer({ url: NEW2 }), async () => ({ posts: 5 }))).toContain("试读 5 个岗位");
    expect(s.config.sources.map((c) => [c.url, c.name])).toEqual([[NEW, "某公司"], [NEW2, "某公司"]]);
  });
});
