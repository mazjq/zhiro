import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { Domain } from "./domain.js";
import { ingest, type Listing } from "../data/index.js";

const post = (title: string, extra: Partial<Listing> = {}): Listing => ({
  externalId: title, url: `https://jobs.example.com/${encodeURIComponent(title)}`, title, company: "示例机器人", locations: ["武汉"],
  validThrough: "2030-12-31", publisher: "example", grade: "官方", isOriginal: true, confidence: 0.9, ...extra,
});

describe("找实习", () => {
  it("lists a post whose name says 实习 / intern, or whose batch its source files as 实习, and nothing else", () => {
    const dir = mkdtempSync(join(tmpdir(), "zhiro-intern-"));
    const domain = new Domain(openDb(join(dir, "jobos.db")));
    ingest(domain, dir, "moka", "s1", [post("运动控制算法实习生"), post("Robotics Intern"), post("控制算法工程师"), post("实习基地讲解员（不是实习岗也会被算进来，名字说了算）")]);
    ingest(domain, dir, "moka", "s2", [post("算法开发", { company: "某研究院", batch: "2027届暑期实习", kind: "实习" })]);
    const titles = domain.listPositions({ internship: true }).items.map((p) => p.title).sort();
    expect(titles).toEqual(["Robotics Intern", "实习基地讲解员（不是实习岗也会被算进来，名字说了算）", "算法开发", "运动控制算法实习生"].sort());
    expect(domain.listPositions({ internship: true, query: "运动" }).items.map((p) => p.title)).toEqual(["运动控制算法实习生"]);
    expect(domain.listPositions({}).items).toHaveLength(5); // 找岗位 still lists them all
  });
});
