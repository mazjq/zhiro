import { conceptsIn, concept, domainsIn, TRANSFERS } from "./concepts.js";
import { parseJd, type Atom, type Depth, type ParsedJd } from "./requirements.js";
import { majorStems } from "./profile-match.js";
import { low } from "./common.js";

/**
 * 岗位适配度 v2 (ADR-035): three questions, judged apart —
 *   A  is the work related to what the user has done (tasks in the duties vs tasks in the fact cards, object aware)
 *   B  are the requirements covered by evidence (each atom: supported / transferable / unknown / gap)
 *   C  has the user delivered similar work (a project or paper on the same task)
 *   D  gaps the user confirmed (never inferred: an unmentioned skill is unknown, not missing)
 * S = A + B + C − D on 0–100, then a tier and an information status. Every judgement carries the fact card it rests on.
 */
export type Status = "supported" | "transferable" | "unknown" | "gap";
export interface Evidence { conceptId: string; depth: Depth; domains: string[]; factId: string; kind: string; quote: string }
export interface Judgement { concepts: string[]; status: Status; importance: Atom["importance"]; modality: Atom["modality"]; depth: Depth; quote: string; via?: string }
export type Tier = "优先考虑" | "可迁移" | "待补资料" | "明显缺口" | "低相关";
export interface Assessment { A: number; B: number | null; C: number; D: number; S: number; tier: Tier; info: "adequate" | "partial" | "lead"; taskWhy: string; eligibility: "pass" | "unknown" | "fail"; eligibilityWhy: string; judgements: Judgement[] }

const RANK: Record<Depth, number> = { knows: 0, used: 1, delivered: 2 };
const DEPTH_OF_KIND: Record<string, Depth> = { skill: "used", direction: "used", project: "delivered", experience: "delivered", publication: "delivered", patent: "delivered", award: "delivered", education: "knows" };
const RULES_VERSION = "v2.1";
const MAJOR_IMPLIES: [RegExp, string[]][] = [
  [/控制|自动化/, ["control_theory", "pid", "matlab_simulink"]],
  [/计算机|软件/, ["cpp", "python", "linux"]],
  [/电气|电子/, ["motor_control", "hardware"]],
  [/机械|机电/, ["mechanical", "dynamics_modeling"]],
];

export function profileEvidence(facts: { id: string; kind: string; statement?: string; data?: Record<string, string> }[]): Evidence[] {
  const out: Evidence[] = [];
  for (const f of facts) {
    if (f.kind === "exclude" || f.kind === "preference" || f.kind === "basic") continue;
    const text = [f.statement, ...Object.values(f.data ?? {})].filter(Boolean).join(" / "); // the statement may leave a description out
    const depth = DEPTH_OF_KIND[f.kind] ?? "knows";
    const domains = domainsIn(text);
    for (const id of conceptsIn(text)) if (concept(id)?.kind !== "domain") out.push({ conceptId: id, depth, domains, factId: f.id, kind: f.kind, quote: text.slice(0, 80) });
    // a degree in the field is evidence of its foundations: a 控制科学与工程 / 自动化 graduate knows control theory and PID
    if (f.kind === "education") for (const [re, ids] of MAJOR_IMPLIES) if (re.test(f.data?.major ?? "")) for (const id of ids) out.push({ conceptId: id, depth: "used", domains: [], factId: f.id, kind: f.kind, quote: `专业 ${f.data?.major}` });
  }
  return out;
}

/** The best evidence for one concept, object aware: same task on another object is transferable, not supported. */
function judgeConcept(id: string, need: Depth, needDomains: string[], ev: Evidence[], gaps: Set<string>): { status: Status; via?: string; factId?: string } {
  if (gaps.has(id)) return { status: "gap" };
  const same = ev.filter((e) => e.conceptId === id);
  const fits = (e: Evidence) => !needDomains.length || !e.domains.length || e.domains.some((d) => needDomains.includes(d));
  const best = same.filter(fits).sort((a, b) => RANK[b.depth] - RANK[a.depth])[0];
  if (best && RANK[best.depth] >= RANK[need]) return { status: "supported", factId: best.factId };
  if (same.length) return { status: "transferable", factId: same[0].factId, via: best ? "深度不足" : "对象不同" };
  const from = TRANSFERS.filter(([, to]) => to === id).map(([f]) => f).find((f) => ev.some((e) => e.conceptId === f));
  if (from) return { status: "transferable", via: `由 ${label(from)} 迁移` };
  return { status: "unknown" };
}

export const label = (id: string) => concept(id)?.names[0] ?? id;
const W = { core: 5, supporting: 3, preferred: 1 } as const;
const M: Record<Status, number> = { supported: 1, transferable: 0.5, unknown: 0, gap: 0 };

export function assess(parsed: ParsedJd, ev: Evidence[], user: { level: number; majors: string[]; gaps: Set<string> }, opts: { degreeText: string; sourceKind: string; agg: boolean; majorText: string }): Assessment {
  const tasksDone = new Set(ev.filter((e) => concept(e.conceptId)?.kind === "task" && e.depth !== "knows").map((e) => e.conceptId));
  const methodsKnown = new Set(ev.filter((e) => ["method", "tool"].includes(concept(e.conceptId)?.kind ?? "")).map((e) => e.conceptId));
  const myDomains = new Set(ev.flatMap((e) => e.domains));
  // A — task relation
  const dutyTasks = [...new Set([...parsed.dutyConcepts, ...parsed.primaryConcepts])].filter((id) => concept(id)?.kind === "task");
  const dutyMethods = parsed.dutyConcepts.filter((id) => ["method", "tool"].includes(concept(id)?.kind ?? ""));
  // the job's main task is what its title and first duty line name; a task only mentioned further down is a side line
  const primary = new Set([...parsed.primaryConcepts].filter((id) => concept(id)?.kind === "task"));
  const direct = dutyTasks.filter((t) => tasksDone.has(t));
  const directMain = direct.filter((t) => primary.has(t));
  const viaTransfer = dutyTasks.filter((t) => !tasksDone.has(t) && TRANSFERS.some(([f, to]) => to === t && tasksDone.has(f)));
  const objectMatch = !parsed.dutyDomains.length || !myDomains.size || parsed.dutyDomains.some((d) => myDomains.has(d));
  let A = directMain.length ? (objectMatch ? 40 : 30) : direct.length || viaTransfer.length ? 20 : dutyMethods.some((m) => methodsKnown.has(m)) ? 10 : 0;
  const titleOnly = !parsed.duties;
  if (titleOnly) A = Math.min(A, 20);
  const taskWhy = directMain.length ? `职责 ${directMain.map(label).join("、")}${objectMatch ? "" : "（对象不同）"}` : direct.length ? `顺带涉及 ${direct.map(label).join("、")}` : viaTransfer.length ? `职责 ${viaTransfer.map(label).join("、")}（可迁移）` : dutyMethods.some((m) => methodsKnown.has(m)) ? "方法相关" : "";
  // B — requirement coverage
  const judgements: Judgement[] = [];
  let sumW = 0, sumWM = 0, prefW = 0, reqW = 0;
  for (const a of parsed.atoms) {
    const js = a.concepts.map((c) => judgeConcept(c, a.depth, a.domains, ev, user.gaps));
    const pick = a.or ? js.sort((x, y) => M[y.status] - M[x.status])[0] : js.sort((x, y) => M[x.status] - M[y.status])[0]; // OR takes the best, AND the worst
    const w = a.modality === "preferred" ? W.preferred : W[a.importance];
    if (a.modality === "preferred") prefW += w; else reqW += w;
    judgements.push({ concepts: a.concepts, status: pick.status, importance: a.importance, modality: a.modality, depth: a.depth, quote: a.quote, via: pick.via });
  }
  const prefCap = Math.min(prefW, reqW * 0.2);
  for (let i = 0; i < parsed.atoms.length; i++) {
    const a = parsed.atoms[i], j = judgements[i];
    const w = a.modality === "preferred" ? (prefW ? (W.preferred * prefCap) / prefW : 0) : W[a.importance];
    sumW += w; sumWM += w * M[j.status];
  }
  const B = parsed.atoms.length ? Math.round((40 * sumWM) / sumW) : null;
  // C — similar work delivered
  // similar work counts for the job's main task, not for a task its duties mention in passing
  const delivered = ev.filter((e) => e.depth === "delivered" && directMain.includes(e.conceptId));
  const C = delivered.length ? (delivered.some((e) => !e.domains.length || !parsed.dutyDomains.length || e.domains.some((d) => parsed.dutyDomains.includes(d))) ? 20 : 10) : directMain.length ? 5 : 0;
  // D — confirmed gaps only
  const D = Math.min(24, judgements.filter((j) => j.status === "gap" && j.modality === "required").reduce((n, j) => n + (j.importance === "core" ? 8 : 3), 0));
  const S = Math.max(0, Math.min(100, A + (B ?? 0) + C - D));
  // eligibility: degree by source semantics, major by open/closed list
  const t = opts.degreeText.replace(/(博士|硕士)研究生/g, "$1");
  const named = ([["博士", 3], ["硕士", 2], ["研究生", 2], ["本科", 1], ["学士", 1], ["专科", 0], ["大专", 0]] as [string, number][]).filter(([k]) => t.includes(k)).map(([, v]) => v);
  const minimum = /及以上|以上学历|或以上/.test(t) || ["zhilian", "iguopin"].includes(opts.sourceKind) || named.length > 1;
  let eligibility: Assessment["eligibility"] = "pass", eligibilityWhy = "";
  if (named.length && user.level && !named.includes(user.level) && !minimum && Math.max(...named) <= user.level - 2) { eligibility = "unknown"; eligibilityWhy = `学历写的是「${opts.degreeText.slice(0, 12)}」，是否只招该学历待核实`; }
  const majors = opts.agg ? "" : low(opts.majorText); // a sheet row's list is the whole campaign's, not this post's
  if (majors && !/不限|相关|等/.test(majors) && !user.majors.some((m) => majors.includes(m))) { eligibility = eligibility === "pass" ? "unknown" : eligibility; eligibilityWhy += (eligibilityWhy ? "；" : "") + "专业名单里没有你的专业"; }
  // information status and tier
  const info: Assessment["info"] = parsed.hasRequirements && parsed.atoms.length >= 2 && parsed.duties ? "adequate" : parsed.duties || parsed.atoms.length ? "partial" : "lead";
  const required = judgements.filter((j) => j.modality === "required");
  const coreOk = required.filter((j) => j.importance === "core").every((j) => j.status === "supported");
  const knownRatio = required.length ? required.filter((j) => j.status !== "unknown").reduce((n, j) => n + W[j.importance], 0) / required.reduce((n, j) => n + W[j.importance], 0) : 1;
  const coreGap = required.some((j) => j.importance === "core" && j.status === "gap");
  let tier: Tier;
  if ((eligibility as string) === "fail" || coreGap) tier = "明显缺口"; // "fail" arrives with user-confirmed eligibility limits (ADR-035 phase 2)
  else if (info === "lead") tier = A >= 20 ? "待补资料" : "低相关";
  else if (S >= 70 && A >= 30 && eligibility === "pass" && coreOk && knownRatio >= 0.8 && info === "adequate") tier = "优先考虑";
  else if (S >= 45 && A >= 20 && (C > 0 || judgements.some((j) => j.status !== "unknown" && j.status !== "gap" && !j.concepts.every((c) => concept(c)?.generic)))) tier = "可迁移"; // C++ alone carries nobody
  else tier = "低相关";
  return { A, B, C, D, S, tier, info, taskWhy, eligibility, eligibilityWhy, judgements };
}

/** One line for the list and the agent: tier first, then what carried it and what is still open. */
export function explain(a: Assessment): string {
  const named = (st: Status) => [...new Set(a.judgements.filter((j) => j.status === st && j.modality === "required").map((j) => j.concepts.map(label).join("/")))];
  const parts = [a.taskWhy, named("supported").length && `证据 ${named("supported").slice(0, 4).join("、")}`, named("transferable").length && `可迁移 ${named("transferable").slice(0, 3).join("、")}`,
    named("unknown").length && `待核实 ${named("unknown").slice(0, 4).join("、")}`, named("gap").length && `缺口 ${named("gap").join("、")}`, a.eligibilityWhy, a.info === "lead" ? "只有岗位名" : a.info === "partial" ? "要求不全" : ""].filter(Boolean);
  return `${a.tier} · ${parts.join("；")}`;
}

export interface UserSide { level: number; majors: string[]; gaps: Set<string>; evidence: Evidence[] }
export function userSide(facts: any[], level: number, gaps: string[]): UserSide {
  return { level, majors: [...new Set(facts.filter((f) => f.kind === "education").flatMap((f) => majorStems(f.data?.major ?? "")))], gaps: new Set(gaps), evidence: profileEvidence(facts) };
}
export { RULES_VERSION };
export type { ParsedJd };
export { parseJd };
