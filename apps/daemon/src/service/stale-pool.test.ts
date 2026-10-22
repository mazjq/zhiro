/** 过期信息 leaves the job list unless asked for; what the person holds stays, saying why. */
import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedWorld } from "../eval/seed.js";
import { callTool } from "../registry.js";
import { refreshPool } from "./pool.js";

const HUMAN = { kind: "human" as const, via: "desktop" as const };

describe("stale posts in the job list", () => {
  it("an old-cohort post is left out and counted; a watched one stays; includeStale lists all", async () => {
    const { s } = await seedWorld(mkdtempSync(join(tmpdir(), "zhiro-stale-")));
    const db = s.domain.db;
    const [a, b] = db.prepare("select p.id, c.company_id co from position p join campaign c on c.id = p.campaign_id where c.cohort like '%2027%' and p.watch_priority is null and not exists (select 1 from application x where x.position_id = p.id) limit 2").all() as any[];
    db.prepare("update position set title = '26届校招：管培生', updated_at = '2099-01-01' where id = ?").run(a.id);
    db.prepare("update position set title = '26届校招：技术员', updated_at = '2099-01-01' where id = ?").run(b.id); // another title: same-titled posts are one
    db.prepare("update position set watch_priority = 2 where id = ?").run(b.id);
    refreshPool(db);
    const posts = (r: any) => r.items.flatMap((c: any) => c.positions);
    const plain = (await callTool("pool.list", { limit: 500 }, HUMAN, s)) as any;
    expect(posts(plain).some((p: any) => p.id === a.id)).toBe(false);
    expect(plain.hiddenStale).toBeGreaterThanOrEqual(1);
    const held = posts(plain).find((p: any) => p.id === b.id);
    expect(held?.stale).toBe("往届：标题写的是 26 届");
    const all = (await callTool("pool.list", { limit: 500, includeStale: true }, HUMAN, s)) as any;
    expect(posts(all).find((p: any) => p.id === a.id)?.stale).toBe("往届：标题写的是 26 届");
  });
});
