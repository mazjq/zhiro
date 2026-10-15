import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Domain } from "./service/domain.js";
import { WorkflowEngine } from "./service/workflow.js";
import { callTool, type Services } from "./registry.js";
import { sources, type Source } from "./data/index.js";

/**
 * 「加一个新站点只改一个目录」: a reader that is in the registry — and nowhere else — is listed as a channel, recognises
 * its links, can be subscribed to, pulled and filed. Nothing outside data/readers/ names it.
 */
const HUMAN = { kind: "human" as const, via: "desktop" as const };
const fake: Source = {
  id: "fakesite", name: "示例招聘站", input: "jobs.fakesite.example/<公司>", mode: "pull", describe: "测试用",
  detect: (url) => /^https:\/\/jobs\.fakesite\.example\//.test(url),
  siteKey: (url) => new URL(url).pathname.split("/")[1],
  fetch: async (cfg) => [{ externalId: "p-1", url: `${cfg.url}/p-1`, title: "控制算法工程师", company: cfg.name ?? "示例", locations: ["武汉"], publisher: "fakesite:acme", grade: "官方", isOriginal: true, confidence: 0.9, cohort: "2027届", batch: "校招" }],
};

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-reg-"));
  mkdirSync(join(dir, "config"));
  writeFileSync(join(dir, "config", "jobos.yaml"), "sources: []\n", "utf8");
  const db = openDb(join(dir, "t.db"));
  const s: Services = { domain: new Domain(db), workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [] } };
  return { db, s };
}
afterEach(() => { delete sources.fakesite; });

describe("a reader in the registry is all a new site needs", () => {
  it("is listed, recognised, subscribed, pulled and filed", async () => {
    const { db, s } = setup();
    sources.fakesite = fake;
    const ch: any = await callTool("channel.list", {}, HUMAN, s);
    expect(ch.items.find((c: any) => c.id === "fakesite")).toMatchObject({ name: "示例招聘站", produces: "岗位", input: "jobs.fakesite.example/<公司>", subscriptions: 0 });
    const kinds: any = await callTool("source.list", {}, HUMAN, s);
    expect(kinds.kinds.map((k: any) => k.id)).toContain("fakesite");

    const added: any = await callTool("source.add", { url: "https://jobs.fakesite.example/acme/list", name: "示例重工" }, HUMAN, s);
    expect(added.source).toBe("fakesite");
    // another page of the same site is the same subscription
    expect(((await callTool("source.add", { url: "https://jobs.fakesite.example/acme/job/9", name: "示例重工" }, HUMAN, s)) as any).id).toBe(added.id);

    const run: any = await callTool("scan.run", { configId: added.id }, HUMAN, s);
    expect(run).toMatchObject({ received: 1, positionsNew: 1 });
    expect(db.prepare("select p.title, p.source_key, c.source_kind, c.source_grade from position p join campaign c on c.id = p.campaign_id").get()).toEqual({ title: "控制算法工程师", source_key: "p-1", source_kind: "fakesite", source_grade: "官方" });
    expect(((await callTool("channel.list", {}, HUMAN, s)) as any).items.find((c: any) => c.id === "fakesite")).toMatchObject({ subscriptions: 1, records: 1 });
  });
});
