import type { Db } from "../db.js";
import { json } from "../db.js";

/**
 * 「同一岗位」 — one rule for the pool and for every tool answer (technical-debt plan item 2). Inside one company, posts
 * whose titles read the same are one post seen by several sources (a sheet row and the site's own list) — except where
 * one batch itself lists that title more than once while open (大疆 控制算法工程师 in 深圳 / 上海 / 北京, each its own post
 * on the site): those stay apart, told by their cities. A post the source took down is gone unless the person watches
 * it or applied to it; such a held post still joins its group, but does not count toward "more than once".
 */
export const titleKey = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

export interface GroupPost { id: string; campaign_id: string; title: string; cities: string; status: string; watch_priority: number | null; app_state: string | null; closes_at: string | null }

/** Whether a post is listed at all: open, or taken down but still held by the person. */
export const held = (p: GroupPost) => p.status !== "closed" || !!p.app_state || (p.watch_priority ?? 0) > 0;

/**
 * One company's posts grouped. `campaignIds` in the order the first post of a group should come from (the pool puts the
 * batch that decides the company line first). `keyOf` also names the group a dropped post would belong to.
 */
export function groupPosts<T extends GroupPost>(campaignIds: string[], byCampaign: Map<string, T[]>): { groups: Map<string, T[]>; keyOf: Map<string, string> } {
  const groups = new Map<string, T[]>(), keyOf = new Map<string, string>();
  for (const cid of campaignIds) {
    const mine = byCampaign.get(cid) ?? [];
    const seen = new Map<string, number>(), tk = mine.map((p) => titleKey(p.title));
    mine.forEach((p, i) => { if (p.status !== "closed") seen.set(tk[i], (seen.get(tk[i]) ?? 0) + 1); });
    for (const [i, p] of mine.entries()) {
      const t = tk[i];
      const k = t + ((seen.get(t) ?? 0) > 1 ? "|" + [...json.parse(p.cities, [] as string[])].sort().join(",") : "");
      keyOf.set(p.id, k);
      if (!held(p)) continue;
      (groups.get(k) ?? groups.set(k, []).get(k)!).push(p);
    }
  }
  return { groups, keyOf };
}

// beyond this many companies, one read of every post is cheaper than a long `in (…)` list
const ALL = 5000;

/**
 * The same post as listed elsewhere, for each post of these companies (all companies when omitted): what the pool
 * merges it with. One read of the companies' posts with their watch and application state. A post alone is not in the map.
 */
export function twinsOf(db: Db, companyIds?: string[]): Map<string, GroupPost[]> {
  const some = companyIds && companyIds.length <= ALL;
  return twinsFrom(db.prepare(`select p.id, p.campaign_id, p.title, p.cities, p.status, p.watch_priority, p.closes_at, c.company_id, a.state as app_state
    from position p join campaign c on c.id = p.campaign_id left join application a on a.position_id = p.id and a.state != 'cancelled'
    ${some ? `where c.company_id in (${companyIds!.map(() => "?").join(",")})` : ""}`).all(...(some ? companyIds! : [])) as unknown as (GroupPost & { company_id: string })[]);
}

/**
 * The same from rows a caller already has: every post of the companies that is listed at all (open, or closed but held —
 * a post closed and not held is in no group and changes no count), with its company.
 */
export function twinsFrom(rows: (GroupPost & { company_id: string })[]): Map<string, GroupPost[]> {
  const byCompany = new Map<string, Map<string, GroupPost[]>>();
  for (const r of rows) {
    const cs = byCompany.get(r.company_id) ?? byCompany.set(r.company_id, new Map()).get(r.company_id)!;
    (cs.get(r.campaign_id) ?? cs.set(r.campaign_id, []).get(r.campaign_id)!).push(r);
  }
  const out = new Map<string, GroupPost[]>();
  for (const cs of byCompany.values()) {
    const { groups, keyOf } = groupPosts([...cs.keys()], cs);
    for (const [id, k] of keyOf) {
      const g = groups.get(k);
      if (!g || (g.length === 1 && g[0].id === id)) continue; // alone, as most posts are
      const twins = g.filter((p) => p.id !== id);
      if (twins.length) out.set(id, twins);
    }
  }
  return out;
}
