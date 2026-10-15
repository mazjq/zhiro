import { describe, it, expect } from "vitest";
import { forModel, pruneContext } from "./career.js";

describe("what the model sees of a tool result", () => {
  it("a listing becomes a table with every row and every non-empty value intact; only a long free text is abridged", () => {
    const items = Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, title: `岗位${i}`, jdText: "很长的职位描述".repeat(200), cities: ["武汉", "上海"], applyUrl: "", closesAt: null, watchPriority: 1 }));
    const s = forModel({ items, total: 40 });
    const lines = s.split("\n");
    expect(lines[0]).toContain("40 条");
    expect(lines[1].split("\t")).toEqual(["id", "title", "jdText", "cities", "watchPriority"]); // empty columns dropped, keys sent once
    expect(lines).toHaveLength(2 + 40 + 1);
    expect(lines[41]).toContain("岗位39");
    expect(lines[2]).toContain("武汉、上海");
    expect(lines[2]).toContain("（共 1400 字）");
    expect(s.endsWith('{"total":40}')).toBe(true);
    // the table is much shorter than the JSON it replaces
    expect(s.length).toBeLessThan(JSON.stringify({ items, total: 40 }).length / 2);
  });
  it("a single object keeps its full text; a result still too long says so instead of cutting silently", () => {
    const long = "描述".repeat(1000);
    expect(forModel({ fact: { id: "f1", statement: long } })).toContain(long);
    const s = forModel({ items: Array.from({ length: 900 }, (_, i) => ({ id: `p${i}`, title: "岗位".repeat(20) })) });
    expect(s).toContain("结果已截断，共 900 条");
  });
});

describe("context pruning before each model call", () => {
  const tr = (i: number, chars: number) => ({ role: "toolResult", toolCallId: `c${i}`, toolName: "pool_list", content: [{ type: "text", text: "x".repeat(chars) }] });
  const user = (t: string) => ({ role: "user", content: t, timestamp: 0 });
  const asst = (t: string) => ({ role: "assistant", content: [{ type: "text", text: t }] });
  it("does nothing under budget; over budget stubs the oldest tool results but never the current turn", () => {
    const small = [user("a"), tr(1, 100), asst("b")];
    expect(pruneContext(small, 1000)).toBe(small);
    const msgs = [user("q1"), tr(1, 500), asst("a1"), user("q2"), tr(2, 500), asst("a2"), user("q3"), tr(3, 500), asst("a3")];
    const out: any[] = pruneContext(msgs, 1200);
    expect(out).toHaveLength(9);
    expect(out[1].content[0].text).toContain("已省略");
    expect(out[4].content[0].text).toContain("已省略");
    expect(out[7].content[0].text).toBe("x".repeat(500)); // the current turn is untouched
    expect(out[2]).toBe(msgs[2]); // assistant text kept
  });
  it("a single long research turn stubs its own older results, keeps the newest six and the question", () => {
    const msgs: any[] = [user("十道题"), ...Array.from({ length: 20 }, (_, i) => tr(i, 1000))];
    const out: any[] = pruneContext(msgs, 8000);
    expect(out[0]).toBe(msgs[0]);
    expect(out.filter((m) => m.role === "toolResult" && m.content[0].text.startsWith("（早先"))).toHaveLength(14);
    expect(out.slice(-6).every((m) => m.content[0].text === "x".repeat(1000))).toBe(true);
  });
  it("drops whole old turns when stubs are not enough, keeping the current one", () => {
    const msgs = [user("q1".repeat(300)), asst("a1".repeat(300)), user("q2".repeat(300)), asst("a2".repeat(300)), user("q3"), tr(3, 100)];
    const out: any[] = pruneContext(msgs, 800);
    expect(out[0].content).toBe("q3");
    expect(out).toHaveLength(2);
  });
});

describe("transcript for the drawer", () => {
  it("keeps user and assistant text only, in order", async () => {
    const { transcriptOf } = await import("./career.js");
    const msgs = [
      { role: "user", content: "关注武汉的岗位", timestamp: 0 },
      { role: "assistant", content: [{ type: "thinking", thinking: "…" }, { type: "toolCall", id: "c1", name: "pool_list", arguments: {} }] },
      { role: "toolResult", toolCallId: "c1", toolName: "pool_list", content: [{ type: "text", text: "items…" }] },
      { role: "assistant", content: [{ type: "text", text: "已关注 3 个。" }] },
    ];
    expect(transcriptOf(msgs)).toEqual([{ role: "user", text: "关注武汉的岗位" }, { role: "agent", text: "已关注 3 个。" }]);
  });
});

describe("the tool boundary checks inputs against the contract", () => {
  it("a call missing a required field is refused with what is missing; resume.save by id keeps the name", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const { openDb } = await import("../db.js");
    const { Domain } = await import("../service/domain.js");
    const { WorkflowEngine } = await import("../service/workflow.js");
    const { callTool } = await import("../registry.js");
    const dir = mkdtempSync(join(tmpdir(), "jobos-boundary-"));
    const db = openDb(join(dir, "t.db"));
    const s: any = { domain: new Domain(db), workflows: new WorkflowEngine(db), config: { vault: dir, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [7] }, sources: [] } };
    const human = { kind: "human", via: "desktop" } as const;
    await expect(callTool("position.watch", {}, human, s)).rejects.toMatchObject({ code: "BAD_INPUT" });
    const { resume } = (await callTool("resume.save", { name: "控制版", fileName: "a.md", dataBase64: Buffer.from("# 简历").toString("base64") }, human, s)) as any;
    const again = (await callTool("resume.save", { id: resume.id, roleKeywords: ["控制"] }, human, s)) as any;
    expect(again.resume.name).toBe("控制版");
  });
});
