import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { addDocument, scanFolder, listDocuments, drain, docxText, duplicateCandidates, mergeFacts, type Deps } from "./documents.js";
import { listFacts, upsertFact } from "./profile.js";

/** Smallest valid zip with one stored (uncompressed) entry — enough to stand in for a .docx. */
function zipStored(name: string, body: string): Buffer {
  const n = Buffer.from(name), data = Buffer.from(body);
  const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt32LE(data.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt32LE(data.length, 20); central.writeUInt32LE(data.length, 24); central.writeUInt16LE(n.length, 28);
  const eocd = Buffer.alloc(22); eocd.writeUInt32LE(0x06054b50, 0); eocd.writeUInt16LE(1, 8); eocd.writeUInt16LE(1, 10); eocd.writeUInt32LE(46 + n.length, 12); eocd.writeUInt32LE(30 + n.length + data.length, 16);
  return Buffer.concat([local, n, data, central, n, eocd]);
}

function setup(reply?: object) {
  const vault = mkdtempSync(join(tmpdir(), "jobos-doc-"));
  const db = openDb(join(vault, "t.db"));
  const llm: any = reply && { model: () => ({ input: ["text"] }), models: { completeSimple: async () => ({ content: [{ type: "text", text: JSON.stringify(reply) }] }) } };
  const d: Deps = { db, vault, llm };
  return { vault, db, d };
}

describe("documents", () => {
  it("reads the text of a .docx", () => {
    const xml = '<w:document><w:body><w:p><w:r><w:t>张三</w:t></w:r></w:p><w:p><w:r><w:t>控制科学 &amp; 工程</w:t></w:r></w:p></w:body></w:document>';
    expect(docxText(zipStored("word/document.xml", xml))).toBe("张三\n控制科学 & 工程");
  });

  it("extracts cards with their source, is idempotent per content, and a second file lands on the same card", async () => {
    const paper = { kind: "publication", data: { title: "Robust DP Control of Vessels", venue: "Ocean Engineering", year: "2026" }, quote: "Robust DP Control of Vessels, Ocean Engineering" };
    const { db, d } = setup({ docType: "简历", facts: [paper, { kind: "education", data: { school: "某大学", degree: "博士", major: "控制科学与工程" }, quote: "某大学 博士" }, { kind: "nonsense", data: {} }, { kind: "skill", data: {} }] });
    expect(addDocument(d, "resume.tex", Buffer.from("\\section{教育} 某大学 博士"))).toMatchObject({ added: true });
    expect(addDocument(d, "copy-of-resume.tex", Buffer.from("\\section{教育} 某大学 博士"))).toMatchObject({ added: false });
    await drain(d);
    expect(listDocuments(db).items[0]).toMatchObject({ status: "done", facts: 2, kind: "简历" });
    addDocument(d, "paper.txt", Buffer.from("the paper itself"));
    await drain(d);
    const pubs = listFacts(db, { kind: "publication" }).items;
    expect(pubs).toHaveLength(1);
    expect(pubs[0].grade).toBe("材料自述");
    expect(pubs[0].sources.map((s) => s.quote)).toHaveLength(2);
  });

  it("without a model the file is kept and marked failed, and a rescan retries it", async () => {
    const { vault, db, d } = setup();
    const dir = join(vault, "materials"); mkdirSync(join(dir, "sub"), { recursive: true });
    writeFileSync(join(dir, "a.txt"), "x"); writeFileSync(join(dir, "sub", "b.md"), "y"); writeFileSync(join(dir, "ignore.exe"), "z");
    expect(scanFolder(d, dir)).toEqual({ found: 2, added: 2, skipped: 0 });
    await drain(d);
    expect(listDocuments(db).items.every((x) => x.status === "failed" && /模型/.test(x.error))).toBe(true);
    expect(scanFolder(d, dir)).toEqual({ found: 2, added: 0, skipped: 2 });
  });

  it("near-duplicate cards are listed, not merged; merging keeps the survivor's values and moves sources", () => {
    const { db } = setup();
    const a = upsertFact(db, { kind: "publication", data: { title: "Robust DP Control of Vessels under Disturbance", venue: "Ocean Eng." } }, "本人确认").fact;
    const b = upsertFact(db, { kind: "publication", data: { title: "Robust DP control of vessels under disturbances", venue: "WRONG", year: "2026" }, source: { quote: "cv line" } }, "材料自述").fact;
    upsertFact(db, { kind: "publication", data: { title: "Something unrelated" } }, "本人确认");
    const dup = duplicateCandidates(db).items;
    expect(dup).toHaveLength(1);
    mergeFacts(db, b.id, a.id);
    const left = listFacts(db, { kind: "publication" }).items.find((f) => f.id === a.id)!;
    expect(left.data).toMatchObject({ venue: "Ocean Eng.", year: "2026" });
    expect(left.sources).toHaveLength(1);
    expect(duplicateCandidates(db).items).toHaveLength(0);
  });
});

import { removeFact, listTrash, restoreFact } from "./profile.js";

describe("最近删除 and confirmed duplicates", () => {
  it("a deleted card comes back with its sources; only the newest 10 are kept", () => {
    const { db } = setup();
    const a = upsertFact(db, { kind: "award", data: { title: "国家奖学金", year: "2024" }, source: { quote: "2024 国奖" } }, "材料自述").fact;
    removeFact(db, a.id);
    expect(listFacts(db).items).toHaveLength(0);
    expect(listTrash(db).items.map((x) => x.statement)).toEqual([a.statement]);
    expect(restoreFact(db, a.id).fact.sources).toHaveLength(1);
    expect(listTrash(db).items).toHaveLength(0);
    for (let i = 0; i < 12; i++) removeFact(db, upsertFact(db, { kind: "skill", data: { name: "技能" + i } }, "本人确认").fact.id);
    expect(listTrash(db).items).toHaveLength(10);
  });

  it("two cards the user has both confirmed are no longer reported as possible duplicates", () => {
    const { db } = setup();
    const a = upsertFact(db, { kind: "project", data: { title: "船舶动力定位半实物仿真平台" } }, "材料自述").fact;
    upsertFact(db, { kind: "project", data: { title: "船舶动力定位半实物仿真平台搭建" } }, "本人确认");
    expect(duplicateCandidates(db).items).toHaveLength(1);
    upsertFact(db, { id: a.id, kind: "project", data: a.data, grade: "本人确认" }, "本人确认");
    expect(duplicateCandidates(db).items).toHaveLength(0);
  });
});

import { docxHtml } from "./documents.js";

describe("docx preview", () => {
  it("renders paragraphs, bold runs and table cells as simple HTML", () => {
    const xml = '<?xml version="1.0"?><w:document><w:body><w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:rPr><w:b/></w:rPr><w:t>教育背景</w:t></w:r></w:p>'
      + '<w:p><w:r><w:t>某大学</w:t></w:r><w:r><w:tab/><w:t>博士 &amp; 控制</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>技能</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>MATLAB</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>';
    const html = docxHtml(zipStored("word/document.xml", xml));
    expect(html).toContain("<h3><b>教育背景</b></h3>");
    expect(html).toContain("<p>某大学&emsp;博士 &amp; 控制</p>");
    expect(html).toContain("<table><tr><td>技能</td><td>MATLAB</td></tr></table>");
    expect(html).not.toContain("<w:");
  });
});
