import type { Recommender, Hit } from "./index.js";
import { DomainError } from "../service/domain.js";
import { low, SEP, terms, loadContext, type Candidate } from "./common.js";
import { assess, explain, userSide, parseJd, RULES_VERSION } from "./fit.js";
import { concept, conceptsIn } from "./concepts.js";
import { sha } from "../service/domain.js";
import { now, tx } from "../db.js";

/** "控制科学与工程" is never written that way in a 专业要求 cell; "控制" / "控制科学" are. */
export function majorStems(major: string): string[] {
  const out = new Set<string>();
  for (const m of low(major).split(SEP)) {
    let s = m;
    for (;;) {
      if (s.length >= 2) out.add(s);
      const cut = s.replace(/(科学与工程|科学与技术|工程与技术|及其自动化|工程|技术|科学|学)$/, "");
      if (cut === s || cut.length < 2) break;
      s = cut;
    }
  }
  return [...out];
}

/** A 4+ character direction ("运动控制") also matches weakly on its head noun ("控制"), which is what most titles use. */
export function weakTerms(keywords: string[]): string[] {
  return [...new Set(keywords.filter((k) => /^[一-鿿]{4,}$/.test(k)).map((k) => k.slice(-2)))].filter((w) => !keywords.includes(w));
}

const TECHNICAL = /研发|技术|算法|工程师|研究|开发|设计/;

/**
 * 岗位适配度, layer 1 (ADR-034): the wide net stays wide — every post on the user's direction is kept, only a degree
 * above theirs is a hard no — but each is sorted into 强匹配 / 可考虑 / 存疑 and the reason says why. Direction evidence is
 * graded (title > duties > only the major list); three signals demote to 存疑: a degree below theirs (a PhD for a
 * 本科-only post), a major list that does not name theirs, and plant/field roles. Pure rules, no model; layer 2 (a model
 * reading the JD against the profile) runs on demand over a short list. Narrow searches are the user's 搜索模式.
 */
export const profileMatch: Recommender = {
  id: "profile_match",
  tag: "画像匹配",
  describe: "用画像（学历、专业、方向词、意向城市）给方向相关的岗位分三档：强匹配 / 可考虑 / 存疑，理由写明依据与扣分项（不调用模型）",
  auto: true,
  run(s) {
    const { facts, edu, candidates, myLevel } = loadContext(s);
    const majors = [...new Set(edu.flatMap((f) => majorStems(f.data.major)))];
    const cities = terms(facts.filter((f) => f.kind === "preference" && f.data.field === "城市").map((f) => f.data.value));
    const gaps = (s.domain.db.prepare("select concept_id from user_gap where status = 'confirmed'").all() as { concept_id: string }[]).map((r) => r.concept_id);
    const me = userSide(facts as any[], myLevel, gaps);
    if (!me.evidence.length && !majors.length) throw new DomainError("PROFILE_EMPTY", "画像里还没有可用的方向、技能或项目，无法匹配");
    const distinct = new Set(me.evidence.map((e) => e.conceptId).filter((id) => concept(id)?.distinct));
    const majorText = (c: Candidate) => c.majorReq || (/专业(?:要求)?[:：]\s*([^\n；;。]+)/.exec(c.jd)?.[1] ?? "") || (c.agg ? c.campaignMajor : "");

    const hits: Hit[] = [];
    const rows: [string, string][] = [];
    const hash = sha(JSON.stringify([me.evidence.map((e) => [e.conceptId, e.depth, e.domains]), majors, myLevel, gaps]));
    for (const c of candidates) {
      // a sheet row of a big group lists majors where jobs would be (「机械工程」「自动化」): the group hires the major — a lead
      const aggMajor = c.agg ? majors.filter((m) => c.title.includes(m)) : [];
      const parsed = parseJd(c.rawJd, c.rawTitle);
      const a = assess(parsed, me.evidence, me, { degreeText: c.degreeText, sourceKind: c.sourceKind, agg: c.agg, majorText: majorText(c) });
      const named = new Set([...parsed.dutyConcepts, ...conceptsIn(c.rawTitle)]);
      const distinctHit = [...distinct].some((id) => named.has(id) || parsed.atoms.some((x) => x.concepts.includes(id)));
      // a one-line official post (国能: 「科研岗；专业：自动化类」) naming the user's major is a lead too, not a match
      const majorLead = !aggMajor.length && a.info !== "adequate" && a.A < 20 && TECHNICAL.test(c.title) ? majors.filter((m) => low(majorText(c)).includes(m)) : [];
      if (a.A < 20 && !distinctHit && !aggMajor.length && !majorLead.length) continue; // recall: on the user's tasks, a rare skill, or a lead
      const city = cities.filter((x) => c.where.includes(x));
      const lead = (aggMajor.length || majorLead.length) && a.tier === "低相关";
      const tier = lead ? "待补资料" : a.tier;
      const base = tier === "优先考虑" ? 200 : tier === "可迁移" ? 100 : tier === "待补资料" ? 50 : 0;
      const reason = lead ? `待补资料 · ${aggMajor.length ? `汇总表招 ${aggMajor.join("/")} 专业；只有类别没有岗位` : `专业相关（${majorLead.join("/")}）；没有岗位描述`}` : explain(a) + (city.length ? `；城市 ${city.join("/")}` : "");
      hits.push({ companyId: c.companyId, positionId: c.id, score: base + a.S + (city.length ? 5 : 0), reason });
      rows.push([c.id, JSON.stringify({ ...a, tier })]);
    }
    // every judgement kept per post: the 机会缺口 ledger reads them; replaced as one batch with the hits
    tx(s.domain.db, () => {
      s.domain.db.prepare("delete from position_assessment").run();
      const ins = s.domain.db.prepare("insert into position_assessment(position_id, json, profile_hash, rules_version, created_at) values (?,?,?,?,?)");
      const t = now();
      for (const [id, json] of rows) ins.run(id, json, hash, RULES_VERSION, t);
    });
    return hits;
  },
};
