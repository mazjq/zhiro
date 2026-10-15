/**
 * 岗位适配度 v2 (ADR-035): the shared vocabulary both sides are read into. A concept is a capability or a task with
 * the spellings JDs and fact cards use for it. Matching is by concept, never by raw substring, so 「运动规划及控制」
 * yields 运动规划 + 控制 and 「规控」 yields both, while 「控制」 alone never becomes a task the user has done.
 *
 * kind: task (what the job does / the user has done), method (an approach), tool (software, hardware, language),
 * domain (the object worked on). generic: too common to carry a post into the recommendations on its own.
 * ponytail: a hand-kept table for control / robotics / software, extended when a JD names something it lacks;
 * a user-editable overlay is the upgrade.
 */
export interface Concept { id: string; kind: "task" | "method" | "tool" | "domain"; names: string[]; generic?: boolean; distinct?: boolean }

export const CONCEPTS: Concept[] = [
  // tasks
  { id: "motion_control", kind: "task", names: ["运动控制", "motion control"] },
  { id: "motion_planning", kind: "task", names: ["运动规划", "路径规划", "轨迹规划", "规划算法", "motion planning", "path planning"] },
  { id: "planning_control", kind: "task", names: ["规控", "规划控制", "规划与控制", "规划及控制", "决策规划"] },
  { id: "control_algorithm", kind: "task", names: ["控制算法", "控制策略", "控制器设计", "控制系统设计", "控制律"] },
  { id: "dynamic_positioning", kind: "task", names: ["动力定位", "dynamic positioning"], distinct: true },
  { id: "dynamics_modeling", kind: "task", names: ["动力学建模", "动力学模型", "运动学建模", "运动学模型", "系统建模", "非线性建模", "建模与仿真", "机器人建模", "车辆建模", "运动学和动力学", "运动学、动力学", "建模能力"] },
  { id: "system_identification", kind: "task", names: ["参数辨识", "系统辨识", "模型辨识"] },
  { id: "state_estimation", kind: "task", names: ["状态估计", "状态观测", "观测器", "扰动估计", "扰动观测", "滤波算法", "卡尔曼", "kalman"] },
  { id: "disturbance_rejection", kind: "task", names: ["扰动抑制", "扰动补偿", "抗扰", "干扰抑制", "等价输入扰动", "disturbance rejection"] },
  { id: "trajectory_tracking", kind: "task", names: ["轨迹跟踪", "轨迹跟随", "路径跟踪"] },
  { id: "navigation", kind: "task", names: ["自主导航", "导航算法", "定位导航", "导航"] },
  { id: "slam", kind: "task", names: ["slam", "建图", "定位与建图"] },
  { id: "perception", kind: "task", names: ["感知算法", "目标检测", "图像分割", "视觉算法", "计算机视觉", "点云"] },
  { id: "reinforcement_learning", kind: "task", names: ["强化学习", "reinforcement learning", "ppo", "sac", "rl算法"] },
  { id: "deep_learning", kind: "task", names: ["深度学习", "神经网络", "机器学习", "模型训练", "大模型", "llm", "vla", "vlm"] },
  { id: "motor_control", kind: "task", names: ["电机控制", "foc", "伺服控制", "驱动控制", "电机驱动"] },
  { id: "force_control", kind: "task", names: ["力控", "阻抗控制", "导纳控制", "柔顺控制"] },
  { id: "embedded", kind: "tool", names: ["嵌入式", "固件", "单片机", "stm32", "rtos", "实时控制系统", "实时控制"] },
  { id: "hmi_upper", kind: "tool", names: ["上位机", "监控系统", "组态"] },
  { id: "simulation", kind: "tool", names: ["仿真验证", "仿真测试", "仿真平台", "半实物", "hil", "sil"] },
  { id: "calibration", kind: "tool", names: ["标定", "校准"] },
  { id: "autonomous_driving", kind: "task", names: ["自动驾驶", "智能驾驶", "无人驾驶", "adas"] },
  { id: "flight_control", kind: "task", names: ["飞控", "飞行控制", "制导", "姿态控制"] },
  { id: "software_test", kind: "task", names: ["自动化测试", "软件测试", "测试用例", "测试开发"] },
  { id: "hardware", kind: "tool", names: ["硬件设计", "电路设计", "pcb", "原理图"] },
  { id: "mechanical", kind: "tool", names: ["机械设计", "结构设计", "机械结构"] },
  // methods
  { id: "mpc", kind: "method", names: ["mpc", "模型预测控制", "预测控制"] },
  { id: "lqr", kind: "method", names: ["lqr", "线性二次", "最优控制", "ilqr", "ddp"] },
  { id: "pid", kind: "method", names: ["pid"], generic: true },
  { id: "robust_control", kind: "method", names: ["鲁棒控制", "h∞", "h-infinity", "lmi", "sdp", "线性矩阵不等式"] },
  { id: "adaptive_control", kind: "method", names: ["自适应控制", "自适应"] },
  { id: "sliding_mode", kind: "method", names: ["滑模", "滑模控制", "smc"] },
  { id: "control_theory", kind: "method", names: ["控制理论", "现代控制", "经典控制", "自动控制原理", "控制原理"], generic: true },
  { id: "search_planning", kind: "method", names: ["a*", "dwa", "rrt", "hybrid a*", "teb", "lattice"] },
  { id: "optimization", kind: "method", names: ["数值优化", "凸优化", "非线性优化", "最优化"] },
  // tools
  { id: "matlab_simulink", kind: "tool", names: ["matlab", "simulink"], generic: true },
  { id: "cpp", kind: "tool", names: ["c++", "c/c++", "c语言"], generic: true },
  { id: "python", kind: "tool", names: ["python"], generic: true },
  { id: "linux", kind: "tool", names: ["linux"], generic: true },
  { id: "ros", kind: "tool", names: ["ros", "ros2", "ros/ros2", "机器人操作系统"] },
  { id: "plc_twincat", kind: "tool", names: ["twincat", "倍福", "plc", "codesys"], distinct: true },
  { id: "pytorch", kind: "tool", names: ["pytorch", "tensorflow"] },
  { id: "sim_tools", kind: "tool", names: ["gazebo", "isaac sim", "mujoco", "sapien", "webots", "carsim", "prescan"] },
  { id: "git", kind: "tool", names: ["git"], generic: true },
  { id: "stewart", kind: "tool", names: ["stewart", "并联机构", "并联平台"], distinct: true },
  // domains (objects worked on)
  { id: "d_marine", kind: "domain", names: ["船舶", "海洋平台", "海上平台", "钻井平台", "勘探平台", "海洋", "水下", "auv", "无人艇"] },
  { id: "d_manipulator", kind: "domain", names: ["机械臂", "机器人手臂", "多关节机器人", "末端执行器", "夹爪"] },
  { id: "d_mobile_robot", kind: "domain", names: ["移动机器人", "轮式机器人", "agv", "amr", "割草机器人", "四轮"] },
  { id: "d_humanoid", kind: "domain", names: ["人形机器人", "具身智能", "具身", "足式", "四足", "双足"] },
  { id: "d_uav", kind: "domain", names: ["无人机", "飞行器", "航天器", "卫星"] },
  { id: "d_vehicle", kind: "domain", names: ["车辆", "整车", "汽车", "底盘", "线控"] },
  { id: "d_drilling", kind: "domain", names: ["钻机", "钻井", "定向钻"] },
  { id: "d_power", kind: "domain", names: ["发电", "电厂", "电网", "新能源电站"] },
];

/** A compound name stands for its parts: 「规控」 is planning and control; 「建模与仿真」 is modelling and simulation. */
export const IMPLIES: Record<string, string[]> = { planning_control: ["motion_planning", "control_algorithm"] };

/** One-hop transfers: the same task on another object counts as partial support, nothing further. */
export const TRANSFERS: [string, string][] = [
  ["dynamic_positioning", "motion_control"],
  ["dynamic_positioning", "trajectory_tracking"],
  ["disturbance_rejection", "state_estimation"],
  ["state_estimation", "disturbance_rejection"],
  ["motion_control", "planning_control"],
  ["control_algorithm", "planning_control"],
  ["control_algorithm", "motion_control"],
  ["lqr", "mpc"],
];

const byName = new Map<string, string>(CONCEPTS.flatMap((c) => c.names.map((n) => [n.toLowerCase(), c.id] as [string, string])));
const LATIN = /^[a-z0-9+/*∞#.-]+$/i;
const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const names = [...byName.keys()].sort((a, b) => b.length - a.length);
// two scans per text instead of ~150 substring searches: Chinese spellings as one alternation, Latin ones with word
// boundaries ("ros" must not match "prospect"); longest spelling first so 「运动学建模」 wins over 「建模能力」
const RE_CJK = new RegExp(names.filter((n) => !LATIN.test(n)).map(esc).join("|"), "g");
const RE_LATIN = new RegExp(`(?<![a-z0-9])(?:${names.filter((n) => LATIN.test(n)).map(esc).join("|")})(?![a-z0-9])`, "g");

/** Concept ids named in a text. */
export function conceptsIn(text: string): Set<string> {
  const t = text.normalize("NFKC").toLowerCase();
  const out = new Set<string>();
  for (const m of t.matchAll(RE_CJK)) out.add(byName.get(m[0])!);
  for (const m of t.matchAll(RE_LATIN)) out.add(byName.get(m[0])!);
  for (const id of [...out]) for (const x of IMPLIES[id] ?? []) out.add(x);
  return out;
}

export const concept = (id: string) => CONCEPTS.find((c) => c.id === id);
export const domainsIn = (text: string) => [...conceptsIn(text)].filter((id) => concept(id)?.kind === "domain");
