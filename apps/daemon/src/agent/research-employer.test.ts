import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, now } from "../db.js";
import { Domain } from "../service/domain.js";
import { WorkflowEngine } from "../service/workflow.js";
import type { Services } from "../registry.js";
import { researchRun, claimsMarkdown, staffMarkdown } from "./research.js";
import { factsMarkdown } from "../service/employer.js";

function setup() {
  const vault = mkdtempSync(join(tmpdir(), "zhiro-employer-"));
  const domain = new Domain(openDb(join(vault, "t.db")));
  const s: Services = { domain, workflows: new WorkflowEngine(domain.db), config: { vault, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7, 3, 1] }, sources: [] } };
  return { vault, domain, s };
}

const company = {
  code: "300001.SZ", name: "甲机器人", industry: "机械设备-自动化设备-机器人", peerGroup: "申万一级「机械设备」",
  years: { 2025: { revenue: 2e9, netProfit: 2e8, rd: 3e8, opCost: 1e9, staffCash: 3e8, dividendCash: 5e7, capex: 1e8 }, 2024: { revenue: 1.5e9, netProfit: 1e8, rd: 2e8, opCost: 8e8, staffCash: 2.5e8, dividendCash: null, capex: null } },
  value: { growth: 0.26, rd: 0.15, pay: 300000, profit: 0.1 }, percentile: { growth: 90, rd: 95, pay: 70, profit: 66 },
  more: { employees: 1000, grossMargin: 0.5, capexToRevenue: 0.05, dividendCashToProfit: 0.25 }, movedTogether: ["营收和利润同时增长"], labels: [{ label: "研发驱动", rule: "研发百分位 ≥ 75 且成长 ≥ 50" }],
};
const result = { year: 2025, peerGroup: "x", data: { source: "东方财富 F10", pools: { "申万一级「机械设备」": { at: "2026-10-18T00:00:00.000Z", companies: 662 } } } };

describe("就业评估 report (D-29): Zhiro's facts on top, the agent's reading below", () => {
  it("the fact table shows each year, the place among peers and the source; an unlisted company gets a line", () => {
    const md = factsMarkdown(company, result);
    expect(md).toContain("| 年份 | 2025 | 2024 |");
    expect(md).toContain("| 营业总收入 | 20.00 亿 | 15.00 亿 |");
    expect(md).toContain("| 分配股利、利润或偿付利息的现金 | 0.50 亿 | — |");
    expect(md).toContain("在申万一级「机械设备」 662 家 A 股公司里");
    expect(md).toContain("待遇信号（");
    expect(md).toContain("30.0 万/人，同行第 70 百分位");
    expect(md).toContain("取数 2026-10-18");
    expect(factsMarkdown({ note: "不是 A 股上市公司" }, result)).toContain("不是 A 股上市公司");
  });

  it("collect writes the facts, then the report, then each conclusion with its evidence, counter and limits", async () => {
    const { vault, s } = setup();
    const dir = join(vault, "runs", "run1");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "out.json"), JSON.stringify({ session_id: "x", total_cost_usd: 0, structured_output: {
      summary: "研发投入高，利润随营收增长",
      report_markdown: "## 二、利润为什么变\n营收增长带动。",
      evidence: [{ url: "https://e.com/ar", title: "2025 年报", grade: "官方", quote: "营业收入同比增长" }],
      claims: [{ text: "利润增长来自营收 | 不是减员", type: "解读", urls: ["https://e.com/ar"], counter: "没找到", limits: "只看了\n一年" }],
      staff: [{ year: 2024, employees: 1250, source: "2024 年报", url: "https://e.com/ar24" }, { year: 2025, employees: 1000, source: "2025 年报", url: "https://e.com/ar" }],
      layoffs: [{ date: "2025-06", what: "传出裁撤海外销售团队约百人", url: "https://e.com/news" }],
    } }));
    writeFileSync(join(dir, "exit.txt"), "0");
    s.domain.db.prepare("insert into agent_run(id, runner, mode, subject_type, subject_id, subject_label, run_dir, status, started_at) values (?,?,?,?,?,?,?,?,?)").run("run1", "claude", "research.company", "company", "c1", "甲机器人", dir, "running", now());
    const prefix = factsMarkdown(company, result);
    expect((await researchRun(s).steps.collect({ subjectId: "run1", checkpoint: { companyName: "甲机器人", companyId: "c1", prefix, staffCash: { 2025: 3e8, 2024: 2.5e8 } }, attempts: 0 } as any)).type).toBe("done");
    const row = s.domain.db.prepare("select status, output_path from agent_run where id = 'run1'").get() as any;
    expect(row.status).toBe("done");
    const md = readFileSync(row.output_path, "utf8");
    expect(md.indexOf("## 一、事实")).toBeLessThan(md.indexOf("### 人员"));
    expect(md.indexOf("### 人员")).toBeLessThan(md.indexOf("## 二、利润为什么变"));
    expect(md).toContain("| 2025 | 1000 | [2025 年报](https://e.com/ar) | 3.00 亿 | 30.0 万 |");
    expect(md).toContain("2024→2025：人数 1250→1000（-20%）；人均 20.0 万→30.0 万（+50%）");
    expect(md).toContain("- 2025-06 传出裁撤海外销售团队约百人（[来源](https://e.com/news)）");
    expect(md).toContain("| 利润增长来自营收 / 不是减员 | 解读 | [1](https://e.com/ar) | 没找到 | 只看了 一年 |");
    expect(md).not.toContain("和你的匹配（单列）"); // the agent writes that section itself
    expect(s.domain.db.prepare("select count(*) n from evidence where run_id = 'run1'").get()).toEqual({ n: 1 });
  });

  it("an ordinary research report has no claims or people section; an unlisted one has headcounts but no pay", () => {
    expect(claimsMarkdown({ report_markdown: "x" })).toBe("");
    expect(staffMarkdown({ report_markdown: "x" })).toBe("");
    const md = staffMarkdown({ staff: [{ year: 2025, employees: 80, source: "公示年报社保参保人数", url: "https://e.com/g" }, { year: 2023, employees: 50, source: "公示年报社保参保人数", url: "https://e.com/g" }], layoffs: [] });
    expect(md).toContain("2023→2025：人数 50→80（+60%）。");
    expect(md).toContain("没有搜到近三年的裁员、降薪报道");
  });
});
