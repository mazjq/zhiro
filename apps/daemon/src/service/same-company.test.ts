import { describe, it, expect } from "vitest";
import { unitKey } from "./same-company.js";

describe("one unit, two spellings", () => {
  it("sheet short names meet the career site's legal names", () => {
    expect(unitKey("中船七二二所")).toBe(unitKey("中国船舶集团有限公司第七二二研究所"));
    expect(unitKey("中船七〇三所")).toBe("中船703所");
    expect(unitKey("中国船舶集团第七一一研究所")).toBe(unitKey("中船711所"));
    expect(unitKey("中国船舶集团有限公司第十一研究所")).toBe("中船11所");
    expect(unitKey("航天科工二院")).toBe(unitKey("中国航天科工集团第二研究院"));
    expect(unitKey("华能核能技术研究院有限公司")).toBe("华能核能技术院");
  });
  it("different units stay different", () => {
    expect(unitKey("中船七〇三所")).not.toBe(unitKey("中船七〇七所"));
    expect(unitKey("东风汽车集团")).not.toBe(unitKey("东风汽车股份"));
    expect(unitKey("国家能源集团（数科公司）")).toBe("国能"); // a bare group name: callers ignore keys this short
  });
});

describe("a place in brackets is a different company", () => {
  it("keeps 青岛 and 天津 apart, drops notes", () => {
    expect(unitKey("中远海运（青岛）有限公司")).not.toBe(unitKey("中远海运（天津）有限公司"));
    expect(unitKey("宁德新能源(ATL)")).toBe(unitKey("宁德新能源"));
  });
});
