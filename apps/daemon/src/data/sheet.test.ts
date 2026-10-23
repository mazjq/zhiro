import { describe, it, expect } from "vitest";
import { guessColumns, tableToListings, csvToTable, BUILTIN_COLUMNS } from "./sheet.js";

const OWN = `企业名称,岗位,ddl,网申地址,城市,学历,毕业年份
示例重工,"控制算法工程师、仿真工程师",2099-10-31,https://apply.example.com/a,武汉 上海,硕士及以上,2027届
示例电子,电机控制工程师,招满为止,https://apply.example.com/b,深圳,本科及以上,2027届
去年公司,工程师,2020-01-01,https://apply.example.com/c,北京,本科,2027届
,无主岗位,,,,,2027届
`;

describe("which column is which", () => {
  it("the built-in names map to themselves; other people's names are recognised; a name is used once", () => {
    expect(guessColumns(Object.values(BUILTIN_COLUMNS))).toEqual(BUILTIN_COLUMNS);
    expect(guessColumns(["企业名称", "岗位", "ddl", "网申地址", "城市", "学历", "毕业年份", "备注"])).toEqual({ company: "企业名称", positions: "岗位", deadline: "ddl", applyUrl: "网申地址", cities: "城市", degree: "学历", cohort: "毕业年份" });
    expect(guessColumns(["Company", "Job Title", "Deadline", "Location", "Apply URL"])).toMatchObject({ company: "Company", positions: "Job Title", deadline: "Deadline", cities: "Location", applyUrl: "Apply URL" });
    // 公司类型 is the type, not the company; with no company column there is none
    expect(guessColumns(["公司类型", "单位名称（全称）"])).toEqual({ companyType: "公司类型", company: "单位名称（全称）" });
    expect(guessColumns(["序号", "备注"]).company).toBeUndefined();
  });
});

describe("a table's rows", () => {
  it("become listings by the mapping: titles split, closed and ownerless rows left out, never graded 官方", () => {
    const table = csvToTable(OWN);
    const out = tableToListings(table, guessColumns(table.headers), { name: "我的表" }, "2026-10-12");
    expect(out.map((l) => `${l.company}|${l.title}`)).toEqual(["示例重工|控制算法工程师", "示例重工|仿真工程师", "示例电子|电机控制工程师"]);
    expect(out[0]).toMatchObject({ url: "https://apply.example.com/a", locations: ["武汉", "上海"], degreeReq: "硕士及以上", deadlineText: "2099-10-31", cohort: "2027届", publisher: "我的表", grade: "聚合", isOriginal: false });
    // a table with no row ids: the same row is the same row tomorrow, wherever it stands in the file
    const moved = csvToTable(OWN.split("\n").filter((_, i) => i !== 2).join("\n"));
    expect(tableToListings(moved, guessColumns(moved.headers), { name: "我的表" }, "2026-10-12")[0].externalId).toBe(out[0].externalId);
  });
  it("a cell in Latin script is not a list of words — in the built-in layout too (NVIDIA's one post read as five)", () => {
    const t = csvToTable(`Security,Role,HQ
3M,Industrial Conglomerates,"Saint Paul, Minnesota"
Acme,"Software Engineer; Data Analyst",Austin
示例重工,控制算法工程师 仿真工程师,武汉 上海
`);
    const out = tableToListings(t, { company: "Security", positions: "Role", cities: "HQ" }, {}, "2026-10-12");
    expect(out.map((l) => `${l.company}|${l.title}|${l.locations.join("/")}`)).toEqual(["3M|Industrial Conglomerates|Saint Paul/Minnesota", "Acme|Software Engineer|Austin", "Acme|Data Analyst|Austin", "示例重工|控制算法工程师|武汉/上海", "示例重工|仿真工程师|武汉/上海"]);
    const builtin = csvToTable(`公司,招聘岗位
示例,AI Computing Software Development Intern
示例二,算法工程师 测试工程师
`);
    expect(tableToListings(builtin, BUILTIN_COLUMNS, {}, "2026-10-12").map((l) => l.title)).toEqual(["AI Computing Software Development Intern", "算法工程师", "测试工程师"]);
  });
  it("a cohort asked for leaves other cohorts out — when the table has a cohort column at all", () => {
    const t = csvToTable("公司,岗位,届次\n甲,工程师,2027届\n乙,工程师,2026届\n");
    expect(tableToListings(t, guessColumns(t.headers), { cohort: "2027届" }, "2026-10-12").map((l) => l.company)).toEqual(["甲"]);
    const bare = csvToTable("公司,岗位\n甲,工程师\n");
    expect(tableToListings(bare, guessColumns(bare.headers), { cohort: "2027届" }, "2026-10-12")).toHaveLength(1);
  });
});
