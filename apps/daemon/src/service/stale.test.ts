/** Which posts leave the everyday lists, and why (old cohort, a deadline long past, taken down). */
import { describe, it, expect } from "vitest";
import { staleReason, cohortYears } from "./stale.js";

const T = "2026-10-22";
describe("stale posts", () => {
  it("reads cohort years from titles and batches", () => {
    expect(cohortYears("2026届、2027届")).toEqual([2026, 2027]);
    expect(cohortYears("雅思授课教师-26届校招")).toEqual([2026]);
    expect(cohortYears("控制算法工程师")).toEqual([]);
  });
  it("an earlier cohort, a deadline over a week gone, a post taken down; the rest stays", () => {
    expect(staleReason({ title: "26届校招：营销管培生" }, "2027届", T)).toBe("往届：标题写的是 26 届");
    expect(staleReason({ title: "鲸英领袖生(2027届/2026届应届生)" }, "2027届", T)).toBe("");
    expect(staleReason({ title: "营养顾问培训生（26届可投）" }, "2026届、2027届", T)).toBe("往届：标题写的是 26 届");
    expect(staleReason({ title: "控制算法工程师" }, "", T)).toBe("");
    expect(staleReason({ title: "控制算法工程师", deadline: { expired: true, date: "2026-10-10" } }, "2027届", T)).toBe("截止（2026-10-10）已过一周以上");
    expect(staleReason({ title: "控制算法工程师", deadline: { expired: true, date: "2026-10-18" } }, "2027届", T)).toBe(""); // 补录 may still come
    expect(staleReason({ title: "控制算法工程师", status: "closed" }, "2027届", T)).toBe("源站已撤下");
  });
});
