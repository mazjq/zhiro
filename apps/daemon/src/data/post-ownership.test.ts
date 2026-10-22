/** B34: two subscriptions feeding one batch — a full read closes only what no subscription lists any more. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { ingest } from "./ingest.js";
import type { Listing } from "./types.js";

const post = (id: string): Listing => ({ externalId: id, url: `https://example.com/${id}`, title: `岗位${id}`, company: "示例公司", locations: ["武汉"], cohort: "2027", batch: "秋招", publisher: "iguopin", grade: "官方" as any, isOriginal: true, confidence: 1 } as Listing);

describe("which subscriptions list a post", () => {
  it("one channel dropping a post does not close it while another still lists it", () => {
    const vault = mkdtempSync(join(tmpdir(), "zhiro-own-"));
    const db = openDb(join(vault, "z.db"));
    const read = (cfg: string, ids: string[]) => ingest({ db }, vault, "iguopin", cfg, ids.map(post), { closeUnseen: true });
    const open = () => (db.prepare("select title from position where status = 'open' order by title").all() as any[]).map((r) => r.title);
    read("ch-a", ["1", "2"]);
    read("ch-b", ["2", "3"]);
    expect(open()).toEqual(["岗位1", "岗位2", "岗位3"]);
    read("ch-a", ["1"]); // a no longer lists 2; b still does
    expect(open()).toEqual(["岗位1", "岗位2", "岗位3"]);
    read("ch-b", ["3"]); // now nobody lists 2
    expect(open()).toEqual(["岗位1", "岗位3"]);
    ingest({ db }, vault, "iguopin", "ch-a", [post("9")], { closeUnseen: true, complete: false }); // a partial read takes nothing away
    expect(open()).toEqual(["岗位1", "岗位3", "岗位9"]);
    expect((db.prepare("select count(*) n from position_seen where position_id = (select id from position where title = '岗位9')").get() as any).n).toBe(0); // nor claims
  });

  it("right after the upgrade (nothing claimed yet) a read closes only what it filed itself", () => {
    const vault = mkdtempSync(join(tmpdir(), "zhiro-own-"));
    const db = openDb(join(vault, "z.db"));
    const read = (cfg: string, ids: string[]) => ingest({ db }, vault, "iguopin", cfg, ids.map(post), { closeUnseen: true });
    const open = () => (db.prepare("select title from position where status = 'open' order by title").all() as any[]).map((r) => r.title);
    read("ch-a", ["1", "2"]);
    read("ch-b", ["3"]);
    db.prepare("delete from position_seen").run(); // as it is the first time the upgraded build runs
    read("ch-a", ["1"]); // b's post 3 stays (b filed it); a's own post 2 closes
    expect(open()).toEqual(["岗位1", "岗位3"]);
  });
});
