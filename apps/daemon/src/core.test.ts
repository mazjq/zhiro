import { describe, it, expect } from "vitest";
import { createServices, testConfig } from "./services.js";
import { mkdtempSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "./db.js";
import { Domain } from "./service/domain.js";
import { importCsv } from "./service/import-csv.js";
import { parseCsv, parseDeadline } from "./data/index.js";
import { WorkflowEngine } from "./service/workflow.js";
import { callTool, type Services } from "./registry.js";
import { runBackup, staleBackups } from "./service/backup.js";

const CSV = `更新时间,公司,企业类型,行业类别,批次,招聘届次,工作地点,招聘岗位,学历要求,专业要求,开始时间,截止时间,简历投递链接,公告链接,是否笔试,公告来源,备注
2026-09-01,示例汽车,民企,汽车,2027届博士专项,2027届,武汉 上海,"底盘控制算法工程师,仿真建模工程师",博士,控制/车辆,2026-08-20,2030-10-15,https://app.mokahr.com/campus-recruitment/demo/1,https://mp.weixin.qq.com/s/x,有笔试,官网,/
2026-09-01,示例电子,民企,工控,秋招,2027届,深圳,电机控制算法工程师,硕士及以上,电气,2026-09-01,招满为止,https://campus.51job.com/demo/,,含免笔试,校园招聘网,
`;

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "jobos-"));
  const db = openDb(join(dir, "t.db"));
  const domain = new Domain(db);
  const workflows = new WorkflowEngine(db);
  const s: Services = createServices({ db: db, domain, config: testConfig(dir, { sources: [] }) });
  return { dir, db, domain, workflows, s };
}

describe("csv", () => {
  it("parses quotes and BOM", () => {
    expect(parseCsv('﻿a,b\n"x,1","y""z"\n')).toEqual([["a", "b"], ["x,1", 'y"z']]);
  });
  it("parses deadlines", () => {
    expect(parseDeadline("2026-10-15")).toEqual({ closesAt: "2026-10-15", kind: "date" });
    expect(parseDeadline("招满为止").kind).toBe("until_filled");
    expect(parseDeadline("").kind).toBe("unknown");
  });
  it("import is idempotent", () => {
    const { dir, domain } = setup();
    const p = join(dir, "a.csv");
    writeFileSync(p, CSV, "utf8");
    const a = importCsv(domain, p);
    expect(a.campaigns).toBe(2);
    expect(a.positions).toBe(3);
    const b = importCsv(domain, p);
    expect(b.inserted).toBe(0);
    expect(b.skipped).toBe(2);
    expect(domain.listCampaigns({}).total).toBe(2);
    expect(domain.listCampaigns({ deadlineWithinDays: 3650 }).items[0].companyName).toBe("示例汽车");
    expect(domain.listCampaigns({}).items.find((c) => c.companyName === "示例汽车")!.sourceGrade).toBe("官方");
  });
});

describe("applications + proposals", () => {
  it("agent write becomes proposal (conservative mode); human approval executes", async () => {
    const { dir, domain, s } = setup();
    s.config.agent = { mode: "conservative" }; // ADR-025: in the default mode application.create runs at once
    const p = join(dir, "a.csv");
    writeFileSync(p, CSV, "utf8");
    importCsv(domain, p);
    const pos = domain.listPositions({ query: "底盘" }).items[0];
    const r: any = await callTool("application.create", { positionId: pos.id, note: "agent 建议投" }, { kind: "agent", via: "career" }, s);
    expect(r.proposal.decision).toBe("pending");
    expect(domain.db.prepare("select count(*) as n from application").get()).toEqual({ n: 0 });
    await expect(callTool("proposal.decide", { id: r.proposal.id, decision: "approved", payloadHash: "bad" }, { kind: "human", via: "desktop" }, s)).rejects.toMatchObject({ code: "HASH_MISMATCH" });
    await expect(callTool("proposal.decide", { id: r.proposal.id, decision: "approved", payloadHash: r.proposal.payloadHash }, { kind: "agent", via: "mcp" }, s)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const ok: any = await callTool("proposal.decide", { id: r.proposal.id, decision: "approved", payloadHash: r.proposal.payloadHash }, { kind: "human", via: "desktop" }, s);
    expect(ok.result.application.state).toBe("draft");
    await expect(callTool("proposal.decide", { id: r.proposal.id, decision: "approved", payloadHash: r.proposal.payloadHash }, { kind: "human", via: "desktop" }, s)).rejects.toMatchObject({ code: "ALREADY_DECIDED" });
    const app = ok.result.application;
    expect(() => domain.updateApplication({ id: app.id, state: "in_process" })).toThrow(expect.objectContaining({ code: "INVALID_TRANSITION" }));
    const sub = domain.updateApplication({ id: app.id, state: "submitted", externalAppId: "A123" });
    expect(sub.submittedAt).toBeTruthy();
    domain.addStage({ applicationId: app.id, kind: "技术面", scheduledAt: "2026-10-20T10:00:00+08:00" });
    expect(domain.getApplication(app.id).state).toBe("in_process");
    expect(domain.timeline(app.id).events.map((e) => e.kind)).toEqual(["created", "state", "stage"]);
  });
});

describe("workflow engine", () => {
  it("resumes from checkpoint and sleeps", async () => {
    const { workflows } = setup();
    const seen: string[] = [];
    workflows.register({
      kind: "t", order: ["a", "b"],
      steps: {
        a: async ({ checkpoint }) => { seen.push("a"); return checkpoint?.slept ? { type: "done" } : { type: "sleep", until: new Date(Date.now() - 1).toISOString(), checkpoint: { slept: true } }; },
        b: async () => { seen.push("b"); return { type: "done" }; },
      },
    });
    const id = workflows.start("t", "s1", "k1");
    expect(workflows.start("t", "s1", "k1")).toBe(id);
    await workflows.tick();
    expect(seen).toEqual(["a"]);
    await workflows.tick();
    expect(seen).toEqual(["a", "a", "b"]);
    expect(workflows.list()[0].state).toBe("completed");
  });
});

describe("backup", () => {
  it("writes a verified copy", () => {
    const { db, dir } = setup();
    const r = runBackup(db, dir);
    expect(r.verified).toBe(true);
    expect(r.bytes).toBeGreaterThan(0);
  });

  it("keeps the newest five of its own and one at least a week old; nothing else in the folder is touched", () => {
    const now = Date.parse("2026-10-20T00:00:00Z");
    const own = ["2026-10-19T10", "2026-10-19T09", "2026-10-18T10", "2026-10-17T10", "2026-10-16T10", "2026-10-15T10", "2026-10-12T10", "2026-10-04T01", "2026-09-20T01"].map((d) => `jobos-${d}-00-00-000Z.db`);
    const others = ["pre-v9-20260918-193937-jobos.db-wal", "jobos.db.pre-v14-20260920-213409", "pre-import-2026-10-01T00-00-00-000Z.db", "export-1760000000000.db", "notes.txt", "jobos-latest.db"];
    // gone: the sixth newest (not yet a week old) and whatever is older than the one older copy that stays
    expect(staleBackups([...others, ...own], now).sort()).toEqual(["jobos-2026-09-20T01-00-00-000Z.db", "jobos-2026-10-04T01-00-00-000Z.db", "jobos-2026-10-15T10-00-00-000Z.db"]);
    expect(staleBackups(own.slice(0, 6), now)).toEqual(["jobos-2026-10-15T10-00-00-000Z.db"]); // no copy a week old yet: five stay
    expect(staleBackups(own.slice(0, 5), now)).toEqual([]);
  });

  it("a backup lets older ones go only after it checked out", () => {
    const { db, dir } = setup();
    mkdirSync(join(dir, "backups"), { recursive: true });
    const old = Array.from({ length: 6 }, (_, i) => `jobos-2020-01-0${i + 1}T00-00-00-000Z.db`);
    for (const f of [...old, "pre-v9-20260918-193937-jobos.db"]) writeFileSync(join(dir, "backups", f), "x", "utf8");
    runBackup(db, dir);
    const left = readdirSync(join(dir, "backups")).sort();
    // the new one, the four newest old ones, the newest of the rest (years old), and the file that is not ours
    expect(left.filter((f) => f.startsWith("jobos-2020"))).toEqual(old.slice(1));
    expect(left).toContain("pre-v9-20260918-193937-jobos.db");
    expect(left).toHaveLength(7);
  });
});

describe("capture routing", () => {
  it("recognizes the same Moka / 北森 tenant", async () => {
    const { sameTenant } = await import("./registry.js");
    expect(sameTenant("https://app.mokahr.com/campus-recruitment/voyah/146293#/job/x", "https://app.mokahr.com/campus-recruitment/voyah/146293")).toBe(true);
    expect(sameTenant("https://app.mokahr.com/campus-recruitment/voyah/146293", "https://app.mokahr.com/campus-recruitment/gufen/143531")).toBe(false);
    expect(sameTenant("https://hzncc.zhiye.com/campus/jobs", "https://hzncc.zhiye.com/")).toBe(true);
    expect(sameTenant("https://hzncc.zhiye.com/", "https://cssc717.zhiye.com/")).toBe(false);
  });
});

describe("campaign.deadline (the proposal the research worker files)", () => {
  it("sets the deadline of the company's open campaigns once; a bad date is refused", async () => {
    const { dir, domain, s } = setup();
    const p = join(dir, "a.csv");
    writeFileSync(p, CSV, "utf8");
    importCsv(domain, p);
    const pos = domain.listPositions({ query: "底盘" }).items[0];
    const companyId = domain.getCampaign(pos.campaignId).campaign.companyId;
    await expect(callTool("campaign.deadline", { companyId, date: "10月15日" }, { kind: "human", via: "desktop" }, s)).rejects.toMatchObject({ code: "BAD_DATE" });
    const r: any = await callTool("campaign.deadline", { companyId, date: "2030-11-30", text: "简历投递截止 11 月 30 日" }, { kind: "human", via: "desktop" }, s);
    expect(r.updated).toBe(1);
    // the source's value is untouched (a refresh cannot undo the person's word); the pool shows the override
    expect(domain.getCampaign(pos.campaignId).campaign.closesAt).toBe("2030-10-15");
    const shown = () => ((callTool("pool.list", { companyId }, { kind: "human", via: "desktop" }, s)) as Promise<any>).then((x) => x.items[0]);
    expect((await shown()).closesAt).toBe("2030-11-30");
    // 「官方未写截止」 clears the sheet's date on display
    await callTool("campaign.deadline", { companyId, unknown: true }, { kind: "human", via: "desktop" }, s);
    expect((await shown()).closesAt).toBeNull();
    expect((await shown()).deadlineText).toContain("官方未写截止");
  });
});

describe("company.similar", () => {
  // the query was a plain string holding `${aggregateSql()}` and threw for any company that had a namesake (found by lint, 2026-10-15)
  it("answers with the namesakes, their open posts and whether any is official", async () => {
    const { domain, s } = setup();
    const a = domain.upsertCompany("中国船舶集团有限公司第七二二研究所");
    domain.upsertCompany("中船七二二所");
    const r = (await callTool("company.similar", { companyId: a }, { kind: "human", via: "desktop" }, s)) as any;
    expect(r.items).toEqual([expect.objectContaining({ companyName: "中船七二二所", positions: 0, official: false })]);
  });
});
