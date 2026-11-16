/** A post's link is its own page where an official reader listed it; the batch's one link is only the fallback. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { ingest } from "../data/index.js";
import { Domain } from "./domain.js";

describe("where to apply for a post", () => {
  it("each post of one batch has its own page, not the batch's one link", () => {
    const vault = mkdtempSync(join(tmpdir(), "zhiro-own-url-"));
    const db = openDb(join(vault, "z.db"));
    const post = (id: string) => ({ externalId: id, url: `https://example.com/${id}`, title: `岗位${id}`, company: "示例公司", locations: ["南京"], cohort: "2027", batch: "秋招", publisher: "iguopin", grade: "官方", isOriginal: true, confidence: 1 }) as any;
    ingest({ db }, vault, "iguopin", "ch-a", ["1", "2", "3"].map(post), { closeUnseen: true });
    expect((db.prepare("select count(distinct apply_url) n from campaign").get() as any).n).toBe(1); // one batch, one link
    const urls = new Domain(db).listPositions({ includeExpired: true }).items.map((x: any) => x.applyUrl).sort();
    expect(urls).toEqual(["https://example.com/1", "https://example.com/2", "https://example.com/3"]);
  });
});
