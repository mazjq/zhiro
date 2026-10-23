/** A13: a wrong setting falls back to its default, says so, and never stops the start; subscriptions are only reported. */
import { describe, it, expect } from "vitest";
import { checkConfig } from "./config-check.js";

describe("checking jobos.yaml", () => {
  it("takes a wrong value out (its default applies) and says what it takes; good ones stay", () => {
    const doc: any = { http: { port: 99999, host: "127.0.0.1" }, brief: { at: "25:00" }, reminders: { daysBefore: [7, "3"] }, background: { reserve: 0.3 },
      feeds: [{ id: "ok", url: "E:/x", publicKey: "k" }, { id: "a/b", url: "E:/y", publicKey: "k" }], sources: [{ id: "a", source: "moka" }, { name: "缺 id" }] };
    const said = checkConfig(doc);
    expect(said.join("\n")).toContain("http.port");
    expect(said.join("\n")).toContain("brief.at");
    expect(said.join("\n")).toContain("reminders.daysBefore");
    expect(said.join("\n")).toContain("feeds 第 2 个的 id");
    expect(said.join("\n")).toContain("sources 里有 1 个");
    expect(doc.http).toEqual({ host: "127.0.0.1" });
    expect(doc.brief).toEqual({});
    expect(doc.background).toEqual({ reserve: 0.3 });
    expect(doc.feeds.map((f: any) => f.id)).toEqual(["ok"]);
    expect(doc.sources).toHaveLength(2); // never changed here
    expect(checkConfig({ http: { port: 8787 }, brief: { at: "8:00" } })).toEqual([]);
  });
});
