import { describe, it, expect } from "vitest";
import { createServices, testConfig } from "../services.js";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, now } from "../db.js";
import { Domain } from "../service/domain.js";
import type { Services } from "../services.js";
import { ingest } from "../data/index.js";
import { companyFind } from "./find-company.js";

/** A finished worker run, as the real `claude -p` leaves it on disk. */
function fakeRun(s: Services, vault: string, structured: object) {
  const runId = "run1", dir = join(vault, "runs", runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "out.json"), JSON.stringify({ structured_output: structured, total_cost_usd: 0.4, session_id: "sess" }));
  writeFileSync(join(dir, "exit.txt"), "0");
  s.domain.db.prepare("insert into agent_run(id, runner, mode, subject_type, subject_id, subject_label, run_dir, status, started_at) values (?,?,?,?,?,?,?,?,?)").run(runId, "claude", "company.find", "company", "", "中微", dir, "running", now());
  return runId;
}

function setup() {
  const vault = mkdtempSync(join(tmpdir(), "jobos-find-"));
  const db = openDb(join(vault, "t.db"));
  const domain = new Domain(db);
  const s: Services = createServices({ db: db, domain, config: testConfig(vault, { sources: [] }) });
  return { vault, domain, s };
}
const status = (s: Services) => s.domain.db.prepare("select status, summary, error, cost_usd from agent_run where id = 'run1'").get() as any;

describe("company.find collection", () => {
  it("an unreachable entry is reported, not fatal; the company that did get into the library is tagged 我点名的", async () => {
    const { vault, domain, s } = setup();
    // stands in for what a successful entry would have ingested
    ingest(domain, vault, "capture", "x", [{ externalId: "1", url: "https://e.com", title: "刻蚀工艺工程师", company: "中微半导体设备（上海）股份有限公司", locations: [], publisher: "中微", grade: "官方", isOriginal: true, confidence: 1 }]);
    const runId = fakeRun(s, vault, { official_name: "中微半导体设备(上海)股份有限公司", summary: "2027 届校招已开启", entries: [{ url: "http://127.0.0.1:9/unreachable", kind: "official", note: "校招站" }] });
    const r = await companyFind(s).steps.collect({ subjectId: runId, checkpoint: { companyName: "中微" }, attempts: 0 } as any);
    expect(r.type).toBe("done");
    expect(status(s)).toMatchObject({ status: "done", cost_usd: 0.4 });
    expect(status(s).summary).toContain("处理失败");
    expect(domain.db.prepare("select tag from recommendation").all()).toEqual([{ tag: "我点名的" }]);
  });

  it("no entries → failed with the worker's own explanation; a still-running worker is polled again", async () => {
    const { vault, s } = setup();
    const runId = fakeRun(s, vault, { official_name: "某公司", summary: "今年未见校招信息", entries: [] });
    await companyFind(s).steps.collect({ subjectId: runId, checkpoint: { companyName: "某公司" }, attempts: 0 } as any);
    expect(status(s)).toMatchObject({ status: "failed" });
    expect(status(s).error).toContain("今年未见校招信息");
  });
});
