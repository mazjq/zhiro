import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { ingest } from "../data/index.js";
import { saveResume, listResumes, pickResume, removeResume, analyzeResume } from "./resumes.js";

function setup() {
  const vault = mkdtempSync(join(tmpdir(), "jobos-resume-"));
  const domain = new Domain(openDb(join(vault, "t.db")));
  const L = (company: string, companyType: string, title: string, id: string, description = "") => ({ externalId: id, url: "https://e.com", title, company, companyType, description, locations: [], publisher: company, grade: "官方" as const, isOriginal: true, confidence: 1 });
  ingest(domain, vault, "x", "x", [
    L("某民营机器人公司", "民企", "运动控制算法工程师", "1", "负责伺服与轨迹规划，熟悉 MPC"),
    L("某船舶研究所", "央国企、研究院所", "船舶动力定位控制研究", "2"),
    L("某船舶研究所", "央国企、研究院所", "行政助理", "3"),
  ]);
  const pos = (q: string) => domain.listPositions({ query: q }).items[0].id;
  return { vault, db: domain.db, pos };
}
const file = (s: string) => Buffer.from(s.padEnd(200, "。"));

describe("简历库", () => {
  it("picks by job AND company type, falls back to the default, and always says why", async () => {
    const { vault, db, pos } = setup();
    await saveResume(db, vault, { name: "通用版", fileName: "a.txt", bytes: file("通用简历") });
    await saveResume(db, vault, { name: "控制算法-民企版", fileName: "b.txt", bytes: file("控制算法"), companyTypes: ["民企"], roleKeywords: ["控制", "算法", "MPC"] });
    await saveResume(db, vault, { name: "科研-院所版", fileName: "c.txt", bytes: file("科研"), companyTypes: ["研究院所", "央国企"], roleKeywords: ["研究", "船舶"] });
    expect(listResumes(db).items.find((r) => r.isDefault)!.name).toBe("通用版"); // the first one becomes the default

    const a = pickResume(db, pos("运动控制"));
    expect(a.pick!.resume.name).toBe("控制算法-民企版");
    expect(a.pick!.reason).toMatch(/岗位名含 控制\/算法.*JD 提到 mpc|MPC.*公司类型 民企/i);
    // same keyword "控制" in the title, but the institute's type tips it to the research resume
    expect(pickResume(db, pos("动力定位")).pick!.resume.name).toBe("科研-院所版");
    // company type alone is not enough to beat... it still wins over the untagged default, and says so
    const c = pickResume(db, pos("行政"));
    expect(c.pick).toMatchObject({ resume: { name: "科研-院所版" }, reason: "公司类型 研究院所/央国企" });
    expect(c.alternatives.map((x) => x.resume.name)).toContain("通用版");
  });

  it("nothing matches → the default, with an honest reason; removing the default promotes another", async () => {
    const { vault, db, pos } = setup();
    const g = await saveResume(db, vault, { name: "通用版", fileName: "a.txt", bytes: file("x") });
    await saveResume(db, vault, { name: "金融版", fileName: "b.txt", bytes: file("y"), companyTypes: ["银行"], roleKeywords: ["风控"] });
    expect(pickResume(db, pos("运动控制")).pick).toMatchObject({ resume: { name: "通用版" }, score: 0 });
    expect(pickResume(db, pos("运动控制")).pick!.reason).toContain("默认");
    removeResume(db, g.resume.id);
    expect(existsSync(g.resume.filePath)).toBe(false);
    expect(listResumes(db).items).toMatchObject([{ name: "金融版", isDefault: true }]);
    await expect(saveResume(db, vault, { name: "金融版", fileName: "z.txt", bytes: file("z") })).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(saveResume(db, vault, { name: "exe", fileName: "z.exe", bytes: file("z") })).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
  });

  it("analysis is advice only and refuses a resume it cannot read", async () => {
    const { vault, db, pos } = setup();
    const r = await saveResume(db, vault, { name: "控制版", fileName: "a.txt", bytes: file("做过船舶动力定位控制算法") });
    const llm: any = { model: () => ({}), models: { completeSimple: async () => ({ content: [{ type: "text", text: JSON.stringify({ fit: "高", summary: "方向对口", strengths: ["动力定位"], gaps: ["MPC"], suggestions: ["把动力定位项目放到第一条"] }) }] }) } };
    const out = await analyzeResume(db, llm, r.resume.id, pos("运动控制"));
    expect(out).toMatchObject({ fit: "高", hasJd: true, suggestions: ["把动力定位项目放到第一条"] });
    const empty = await saveResume(db, vault, { name: "扫描件", fileName: "s.txt", bytes: Buffer.from("短") });
    await expect(analyzeResume(db, llm, empty.resume.id, pos("运动控制"))).rejects.toMatchObject({ code: "NO_TEXT" });
  });
});
