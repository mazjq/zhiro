import { describe, it, expect } from "vitest";
import { openDb } from "../db.js";
import { WorkflowEngine } from "./workflow.js";

describe("the poll runs kinds of work side by side", () => {
  it("something slow of one kind does not hold up another kind; within a kind, one at a time", async () => {
    const db = openDb(":memory:");
    const engine = new WorkflowEngine(db, 5);
    let release!: () => void;
    const slow = new Promise<void>((ok) => (release = ok));
    const ran: string[] = [];
    let together = 0, most = 0;
    engine.register({ kind: "scan", order: ["pull"], steps: { pull: async ({ subjectId }) => { most = Math.max(most, ++together); if (subjectId === "big") await slow; ran.push(subjectId); together--; return { type: "done" }; } } });
    engine.register({ kind: "file", order: ["collect"], steps: { collect: async ({ subjectId }) => { ran.push(subjectId); return { type: "done" }; } } });
    engine.start("scan", "big", "scan:big");
    engine.start("scan", "small", "scan:small");
    engine.start("file", "report", "file:report");
    engine.startPolling();
    await new Promise((ok) => setTimeout(ok, 60));
    // the report was filed while the big scan is still reading; the second scan waits its turn behind the first
    expect(ran).toEqual(["report"]);
    release();
    await new Promise((ok) => setTimeout(ok, 60));
    engine.stopPolling();
    expect(ran).toEqual(["report", "big", "small"]);
    expect(most).toBe(1);
    expect(db.prepare("select count(*) n from workflow where state = 'completed'").get()).toEqual({ n: 3 });
  });
});
