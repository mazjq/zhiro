import type { Services } from "../registry.js";
import { listFacts } from "../service/profile.js";
import { isAggregate } from "../data/index.js";
import { expiredMany } from "../service/deadlines.js";
import { twinsFrom } from "../service/post-groups.js";

export const low = (s: string) => (s ?? "").normalize("NFKC").toLowerCase();
export const SEP = /[\/、,，;；|\s]+/;
/** "运动控制/MPC, 仿真" → ["运动控制", "mpc", "仿真"] */
export const terms = (values: string[]) => [...new Set(values.flatMap((v) => low(v).split(SEP)).filter(Boolean))];

const LEVEL: [string, number][] = [["博士", 3], ["硕士", 2], ["研究生", 2], ["本科", 1], ["学士", 1]];
export const levelOf = (s: string) => LEVEL.find(([k]) => s.includes(k))?.[1] ?? 0;
/** Lowest degree a requirement text accepts ("硕士及以上" → 2, "本科/硕士" → 1, "" → 0 = unstated). */
export function minLevel(req: string): number {
  const text = req.replace(/(博士|硕士)研究生/g, "$1");
  const levels = LEVEL.filter(([k]) => text.includes(k)).map(([, v]) => v);
  return levels.length ? Math.min(...levels) : 0;
}

/** agg: the campaign comes from a summary sheet (飞书汇总表 / CSV), whose 「岗位」 are often majors or job families, not jobs. */
export interface Candidate { id: string; companyId: string; title: string; rawTitle: string; rawJd: string; jd: string; majorReq: string; campaignMajor: string; degreeText: string; where: string; agg: boolean; sourceKind: string }

/**
 * What every mode matches against: open positions whose deadline has not passed, minus the two things the user
 * never wants to see regardless of mode — jobs above their degree, and titles containing one of their 排除词.
 */
export function loadContext(s: Services) {
  const facts = listFacts(s.domain.db).items;
  const edu = facts.filter((f) => f.kind === "education");
  const myLevel = Math.max(0, ...edu.map((f) => levelOf(f.data.degree)));
  const excludes = terms(facts.filter((f) => f.kind === "exclude").map((f) => f.data.keyword));
  const rows = s.domain.db.prepare(`select p.id, p.campaign_id, p.closes_at, p.title, p.jd_text, p.cities, p.degree_req, p.major_req as p_major, c.company_id, c.degree_req as c_degree, c.major_req, c.cities as c_cities, c.source_kind
    from position p join campaign c on c.id = p.campaign_id
    where p.status != 'closed'`).all() as any[];
  // 「这个岗位还能投吗」 by the resolver (ADR-041): a later day the person set brings a post back, a post's own passed day
  // closes it, and the day is the local one. The same post elsewhere is found among these rows (none closed: no status
  // read) plus the closed posts the person still holds — not by reading every post a second time.
  const held = () => s.domain.db.prepare(`select p.id, p.campaign_id, p.title, p.cities, p.status, p.watch_priority, p.closes_at, c.company_id, a.state as app_state
    from position p join campaign c on c.id = p.campaign_id left join application a on a.position_id = p.id and a.state != 'cancelled'
    where p.status = 'closed' and (p.watch_priority > 0 or a.id is not null)`).all() as any[];
  // every post not closed: the answer is kept for 机会缺口 and position.list until a deadline input changes
  const expired = expiredMany(s.domain.db, rows, { every: true, twins: () => twinsFrom([...rows, ...held()]) });
  const candidates: Candidate[] = [];
  for (const r of rows) {
    if (expired.get(r.id)) continue;
    if (myLevel && minLevel(r.degree_req || r.c_degree || "") > myLevel) continue;
    const title = low(r.title);
    if (excludes.some((x) => title.includes(x))) continue;
    // the job's own cities beat the campaign-wide union
    candidates.push({ id: r.id, companyId: r.company_id, title, rawTitle: r.title, rawJd: r.jd_text ?? "", sourceKind: r.source_kind, jd: low(r.jd_text), majorReq: low(r.p_major), campaignMajor: low(r.major_req), degreeText: r.degree_req || r.c_degree || "", where: low(r.cities && r.cities !== "[]" ? r.cities : r.c_cities), agg: isAggregate(r.source_kind) });
  }
  return { facts, edu, candidates, myLevel };
}
