import { describe, it, expect } from "vitest";
import { flattenAria, findBlocks } from "./page-read.js";

describe("读页 (ADR-038)", () => {
  it("flattens an aria snapshot into headings, links, bullets; tables are marked and returned apart; repeats drop", () => {
    const yaml = `- banner:
  - link "首页":
  - link "校园招聘":
- main:
  - heading "新的机会 (10)" [level=2]
  - table:
    - row "岗位名称 招聘组织":
      - cell "岗位名称"
      - cell "招聘组织"
  - list:
    - listitem:
      - link "管网仿真优化技术研究岗":
    - listitem:
      - text: 人工智能技术研究岗
  - button "搜索"
  - link "首页":
`;
    expect(flattenAria(yaml).split("\n").map((l) => l.trim())).toEqual(["[首页]", "[校园招聘]", "## 新的机会 (10)", "[表格]", "[管网仿真优化技术研究岗]", "人工智能技术研究岗", "(按钮 搜索)"]);
  });
  it("find keeps only the blocks that mention a word, and says when nothing did", () => {
    const text = "# 岗位 A\n城市 北京\n学历 博士\n\n# 岗位 B\n城市 武汉\n学历 硕士";
    expect(findBlocks(text, "武汉")).toEqual({ text: "# 岗位 B\n城市 武汉\n学历 硕士", found: true });
    expect(findBlocks(text, "上海 深圳").found).toBe(false);
    expect(findBlocks(text, "上海 深圳").text).toBe(text);
  });
});
