import { describe, it, expect } from "vitest";
import { conceptsIn } from "./concepts.js";
import { parseJd } from "./requirements.js";
import { profileEvidence } from "./fit.js";

describe("concepts", () => {
  it("reads spellings into concepts; Latin names need word boundaries; 规控 opens into planning + control", () => {
    expect([...conceptsIn("负责移动机器人自主导航、运动规划及控制等相关软件算法的研究与开发")]).toEqual(expect.arrayContaining(["d_mobile_robot", "navigation", "motion_planning"]));
    expect([...conceptsIn("规控算法工程师")]).toEqual(expect.arrayContaining(["planning_control", "control_algorithm"]));
    expect(conceptsIn("prospect analysis").has("ros")).toBe(false);
    expect(conceptsIn("熟悉Linux/ROS开发环境").has("ros")).toBe(true);
    expect(conceptsIn("熟悉 DWA、A*、MPC、PID、LQR 等算法").size).toBe(4);
  });
});

describe("a skill still being learned", () => {
  it("counts as knowing of it, not having used it", () => {
    const ev = (level?: string) => profileEvidence([{ id: "f", kind: "skill", data: { name: "ROS", ...(level ? { level } : {}) } }]).find((e) => e.conceptId === "ros")?.depth;
    expect(ev()).toBe("used");
    expect(ev("熟练")).toBe("used");
    expect(ev("在学")).toBe("knows");
  });
});

describe("JD → atoms", () => {
  const jd = `岗位职责
1. 负责移动机器人自主导航、运动规划及控制等相关软件算法的研究与开发；
2. 参与实地测试与调优。
任职要求
1. 硕士及以上学历，自动化、电子、控制、机器人、计算机等相关专业；
2. 熟悉C/C++编程，熟悉Linux/ROS开发环境；
3. 具备对运动机器人建模的能力，并有常见运动传感器的使用经验；
4. 熟悉常见的规划控制算法，有DWA、A*、MPC、PID、LQR等算法的开发经验；
5. 有移动机器人、无人机、自动驾驶等相关项目或者竞赛经验优先；
6. 具备良好的沟通能力和团队协作精神。`;
  it("duties give tasks and objects; requirements give one atom per concept with depth and modality", () => {
    const p = parseJd(jd, "规控算法工程师");
    expect(p.dutyConcepts).toEqual(expect.arrayContaining(["navigation", "motion_planning"]));
    expect(p.dutyDomains).toContain("d_mobile_robot");
    expect(p.eligibility).toHaveLength(1);
    const by = (id: string) => p.atoms.find((a) => a.concepts.includes(id));
    expect(by("cpp")).toMatchObject({ modality: "required", depth: "knows" });
    expect(by("ros")).toMatchObject({ modality: "required" });
    expect(by("dynamics_modeling")).toMatchObject({ importance: "core", depth: "used" });
    expect(by("mpc")).toMatchObject({ depth: "delivered", modality: "required" });
    expect(by("autonomous_driving")).toMatchObject({ modality: "preferred", importance: "supporting" });
    expect(p.atoms.some((a) => a.quote.includes("沟通"))).toBe(false);
    expect(p.hasRequirements).toBe(true);
  });
  it("或 / 至少一种 makes an OR group; a preferred line never becomes core", () => {
    const p = parseJd("任职要求\n1. 至少精通 C/C++ 或 Python 一种；\n2. 有强化学习项目经验优先");
    expect(p.atoms[0]).toMatchObject({ or: true, concepts: expect.arrayContaining(["cpp", "python"]), depth: "used" });
    expect(p.atoms[1]).toMatchObject({ concepts: ["reinforcement_learning"], modality: "preferred", importance: "supporting", depth: "delivered" });
  });
  it("a one-line source description (国能) yields no requirements and counts as partial information", () => {
    const p = parseJd("科研岗;国能信控;专业:自动化类;硕士研究生;1人", "AI应用研发工程师");
    expect(p.hasRequirements).toBe(false);
    expect(p.atoms).toHaveLength(0);
  });
});
