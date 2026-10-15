import { describe, it, expect } from "vitest";
import { judge, splitValues, type Expectation } from "./expectations.js";

const city = (hard: boolean, ...values: string[]): Expectation => ({ field: "城市", values, hard, note: "" });
const type = (hard: boolean, ...values: string[]): Expectation => ({ field: "公司类型", values, hard, note: "" });

describe("期望卡 (ADR-036)", () => {
  it("hard cards give pass / unknown / fail; missing data is unknown, never fail", () => {
    const exps = [city(true, "武汉", "深圳")];
    expect(judge(exps, { cities: ["湖北武汉"] }, {}).status).toBe("pass");
    expect(judge(exps, { cities: ["北京"] }, {}).status).toBe("fail");
    expect(judge(exps, {}, { cities: ["深圳"] }).status).toBe("pass"); // the post says nothing, the company does
    expect(judge(exps, {}, {}).status).toBe("unknown");
    expect(judge(exps, { cities: ["全国"] }, {}).status).toBe("unknown");
    expect(judge([type(true, "央国企")], { cities: ["北京"] }, { companyType: "" }).status).toBe("unknown");
    expect(judge([type(true, "央国企")], { cities: ["北京"] }, { companyType: "民企" }).status).toBe("fail");
  });
  it("soft cards only score; a blocked company fails whatever the cards say", () => {
    const soft = [city(false, "武汉"), type(false, "央国企")];
    const v = judge(soft, { cities: ["武汉"] }, { companyType: "民企" });
    expect(v.status).toBe("pass");
    expect(v.score).toBe(0); // +1 city −1 type
    expect(judge([], { cities: ["武汉"] }, {}).score).toBe(0);
    expect(judge(soft, { cities: ["武汉"] }, { companyType: "央国企", blocked: true })).toMatchObject({ status: "fail", score: 2 });
  });
  it("values on one card are OR, split on 、 , / and spaces", () => {
    expect(splitValues("武汉、深圳 / 上海,北京")).toEqual(["武汉", "深圳", "上海", "北京"]);
  });
});
