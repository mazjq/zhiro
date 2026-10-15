import { conceptsIn, concept, domainsIn } from "./concepts.js";

/**
 * A JD read into atoms (ADR-035). 职责 lines give the tasks; 任职要求 lines give requirements, one atom per concept
 * named, AND within a line unless the segment says 或/至少一种 (then one OR group). 优先/加分 → preferred; 学历/专业/届
 * lines are eligibility, judged elsewhere; lines about 沟通/团队/热情 are skipped. Depth comes from the verb:
 * 了解/熟悉 → knows, 熟练/精通/掌握 → used, 经验/落地/项目/独立 → delivered. Unparsed requirement lines stay counted, so
 * a JD the parser cannot read shows as "partial", not as "everything met".
 */
export type Depth = "knows" | "used" | "delivered";
export interface Atom { concepts: string[]; or: boolean; modality: "required" | "preferred"; importance: "core" | "supporting"; depth: Depth; domains: string[]; quote: string }
export interface ParsedJd { duties: string; dutyConcepts: string[]; primaryConcepts: string[]; dutyDomains: string[]; atoms: Atom[]; eligibility: string[]; unparsed: number; hasRequirements: boolean }

const HEAD_REQ = /^(任职|岗位|职位|应聘)?\s*(要求|资格|条件|需求)/;
const HEAD_DUTY = /^(岗位|工作|职位|主要)?\s*(职责|内容|描述|任务)/;
const SOFT = /沟通|团队|协作|热情|抗压|责任心|自驱|学习能力|进取|积极|品行|价值观|出差|加班|执行力|表达能力|主动/;
const ELIGIBILITY = /学历|学位|专业|届|毕业|研究生|本科|硕士|博士|英语|cet|四级|六级|证书/i;
const PREFERRED = /优先|加分|者优先|为佳|更佳/;
const DELIVERED = /经验|经历|落地|项目|独立|交付|部署|实车|真机|量产/;
const USED = /熟练|精通|掌握|能够|能力|具备/;

export function parseJd(jd: string, title = ""): ParsedJd {
  const lines = jd.split(/\r?\n/).map((l) => l.replace(/^\s*[\d一二三四五六七八九十]+[.、．:：)）]\s*/, "").trim()).filter(Boolean);
  let section: "duty" | "req" | "" = "";
  const duty: string[] = [], req: string[] = [];
  for (const l of lines) {
    if (HEAD_REQ.test(l)) { section = "req"; const rest = l.replace(HEAD_REQ, "").replace(/^[:：\s]+/, ""); if (rest) req.push(rest); continue; }
    if (HEAD_DUTY.test(l)) { section = "duty"; const rest = l.replace(HEAD_DUTY, "").replace(/^[:：\s]+/, ""); if (rest) duty.push(rest); continue; }
    if (section === "req") req.push(l); else if (section === "duty") duty.push(l);
    else (DELIVERED.test(l) && USED.test(l)) || /^(熟悉|精通|掌握|了解|具备|有)/.test(l) ? req.push(l) : duty.push(l); // no headings: guess by shape
  }
  const duties = duty.join("\n");
  const atoms: Atom[] = [], eligibility: string[] = [];
  let unparsed = 0;
  for (const l of req) {
    if (ELIGIBILITY.test(l) && !/熟悉|精通|掌握|经验/.test(l)) { eligibility.push(l); continue; }
    if (SOFT.test(l) && !conceptsIn(l).size) continue;
    const modality = PREFERRED.test(l) ? "preferred" : "required";
    let found = false;
    for (const seg of l.split(/[，,；;。]/)) {
      const domains = domainsIn(seg);
      const depth: Depth = DELIVERED.test(seg) ? "delivered" : USED.test(seg) ? "used" : "knows";
      let ids = [...conceptsIn(seg)].filter((id) => concept(id)?.kind !== "domain");
      // 「有机械臂控制经验」: the object is the requirement — experience with that thing, whatever the method
      if (!ids.length && depth === "delivered" && domains.length) ids = domains;
      if (!ids.length) continue;
      found = true;
      const or = ids.length > 1 && /或|至少一种|任一|之一|任意一种/.test(seg);
      const importance = modality === "preferred" ? "supporting" : depth === "delivered" || ids.some((id) => concept(id)?.kind === "task") ? "core" : "supporting";
      if (or) atoms.push({ concepts: ids, or: true, modality, importance, depth, domains, quote: seg.trim() });
      else for (const id of ids) atoms.push({ concepts: [id], or: false, modality, importance, depth, domains, quote: seg.trim() });
    }
    if (!found) unparsed++;
  }
  const dutyText = duties || title;
  const primaryConcepts = [...conceptsIn(`${title}\n${duty[0] ?? ""}`)].filter((id) => concept(id)?.kind !== "domain");
  return { duties, dutyConcepts: [...conceptsIn(dutyText)].filter((id) => concept(id)?.kind !== "domain"), primaryConcepts, dutyDomains: domainsIn(dutyText + "\n" + title), atoms, eligibility, unparsed, hasRequirements: req.length > 0 };
}
