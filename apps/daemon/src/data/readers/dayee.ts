import { pullOnce, type Listing, type Source, type SourceConfig } from "../types.js";
import { genericCompany } from "../catalog.js";

/**
 * 大易 (DaYee) new campus platform, wecruit.hotjob.cn/SU<24 hex>/… — 中国电科 (136 posts), 特变电工 (392), 中国电信国际 …
 * Read the way its pages do (verified 2026-09-30): form POSTs to /wecruit/positionInfo/<op>/SU…, no login or signing.
 * listPosition caps page 1 per tenant (a display setting: 1 row for 中国电科, 10 for 特变电工), so page 2 is also read
 * with page sizes 1…32 before 50-row pages; rows are deduped by postId. The JD is one listPositionDetail per post,
 * fetched once per post for the life of the daemon. A tenant's list also carries older projects: past deadlines and
 * projects naming an earlier year are dropped.
 * ponytail: the legacy /wt/<corp>/ platform (cgn.hotjob.cn, *.wintalent.cn) is server-rendered HTML, and 中广核 applies by
 * company not by post — not read; add an HTML reader if such a site matters.
 */
export function dayeeSuite(url: string): { su: string; recruitType: string; postId?: string } | null {
  // a tenant may serve the platform from its own domain (荣耀: career.honor.com/SU…/mc/position/campus); the suite id in
  // the path is the platform's, and its API answers for it on wecruit.hotjob.cn all the same (verified 2026-10-11)
  const m = /^https?:\/\/[^/]+\/(SU[0-9a-f]{24})(?:[/?#]|$)/i.exec(url);
  if (!m) return null;
  let q: URLSearchParams;
  try { q = new URL(url).searchParams; } catch { q = new URLSearchParams(); }
  // the API takes a number; a link may carry the word (…detail?postId=…&recruitType=campus answered 「parameter error」 for weeks)
  const given = q.get("recruitType") ?? "";
  const recruitType = /interns?\.html/.test(url) || /^intern/i.test(given) ? "12" : /^\d+$/.test(given) ? given : "1";
  return { su: m[1], recruitType, postId: q.get("postId") ?? undefined };
}

const named = (x: unknown) => (x && !genericCompany(String(x)) ? String(x) : "");
const details = new Map<string, any>(); // postId → detail; a post's JD does not change often enough to re-read daily

/** One row (+ its detail) → Listing, or null when it belongs to a closed or earlier project. Exported for tests. */
export function rowToListing(p: any, d: any, su: string, cfg: SourceConfig, today = new Date().toISOString().slice(0, 10)): Listing | null {
  if (!p?.postId || !p.postName) return null;
  const end = String(p.endDate ?? "").slice(0, 10);
  if (/^\d{4}-\d{2}-\d{2}$/.test(end) && end < today) return null;
  const year = Number((cfg.cohort ?? "2027").replace(/\D/g, "").slice(0, 4)) || 2027;
  const projYear = Number(/(20\d\d)/.exec(p.projectName ?? "")?.[1] ?? 0);
  if (projYear && projYear < year) return null;
  const ownDomain = !!cfg.url && !/\/\/wecruit\.hotjob\.cn\//i.test(cfg.url);
  const jd = [d?.workContent &&`岗位职责\n${String(d.workContent).trim()}`, d?.serviceCondition && `任职要求\n${String(d.serviceCondition).trim()}`].filter(Boolean).join("\n\n");
  const places = ((d?.workPlaceList ?? []) as any[]).map((w) => w.name).concat(p.workPlaceStr ? String(p.workPlaceStr).split(/[,，;；]/) : []);
  return {
    externalId: String(p.postId),
    url: `https://wecruit.hotjob.cn/${su}/pb/posDetail.html?postId=${p.postId}&postType=campus`,
    title: String(p.postName).trim(),
    // on the shared host a group lists its member companies in `company` (中国电科's 研究所); a tenant on its own domain is
    // one company and the column holds its departments (荣耀: 「Marketing与销售服务部」)
    // … and some tenants fill it with the literal word 「公司」 (three sites did): that is no name, the subscription's is
    company: String((ownDomain && cfg.name) || named(p.company) || named(d?.orgName) || cfg.name || "").trim() || "大易招聘",
    orgUnit: (ownDomain && cfg.name ? p.company : p.department) || undefined,
    locations: [...new Set(places.map((x: string) => x.split("-")[0].trim()).filter(Boolean))],
    description: jd || undefined,
    validThrough: /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : undefined,
    datePosted: p.publishDate ? String(p.publishDate).slice(0, 10) : undefined,
    degreeReq: p.educationStr || d?.education || undefined,
    majorReq: p.subject || undefined,
    cohort: cfg.cohort ?? `${year}届`,
    batch: cfg.batch ?? (p.projectName || "校招"),
    kind: cfg.kind ?? (/实习/.test(p.projectName ?? "") ? "实习" : "校招"),
    publisher: `dayee:${su}`,
    grade: "官方",
    isOriginal: true,
    confidence: 0.9,
  };
}

export const dayee: Source = {
  id: "dayee",
  name: "大易", input: "wecruit.hotjob.cn/SU…（学校招聘、岗位详情页；公司自有域名上的同样路径也认）",
  mode: "pull",
  describe: "大易新版校招站（wecruit.hotjob.cn/SU…）：走页面自己的接口，列表 + 每个岗位的职责与要求，零 token",
  detect: (url) => !!dayeeSuite(url),
  siteKey: (url) => dayeeSuite(url)!.su,
  async fetch(cfg, ctx) {
    const t = dayeeSuite(cfg.url ?? "");
    if (!t) throw new Error(`BAD_URL: 不是大易新版校招站：${cfg.url}`);
    const call = async (op: string, form: Record<string, string | number>) => {
      const r: any = await ctx.fetchJson(`https://wecruit.hotjob.cn/wecruit/positionInfo/${op}/${t.su}?iSaJAx=isAjax&request_locale=zh_CN&t=${Date.now()}`, {
        method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(Object.entries(form).map(([k, v]) => [k, String(v)])).toString(),
      });
      if (String(r?.state) !== "200") throw new Error(`${/官网不存在/.test(JSON.stringify(r)) ? "SITE_GONE" : "SCHEMA_CHANGED"}: 大易 ${op}：${r?.Exception?.message ?? JSON.stringify(r).slice(0, 120)}`);
      await ctx.sleep(250);
      return r.data;
    };
    return pullOnce(`dayee:${t.su}:${t.recruitType}`, async () => {
      const base = { isFrompb: "true", recruitType: t.recruitType };
      const rows = new Map<string, any>();
      const add = (d: any) => { for (const p of d?.pageForm?.pageData ?? []) rows.set(p.postId, p); };
      const first = await call("listPosition", { ...base, pageSize: 10, currentPage: 1 });
      add(first);
      const total = Number(first?.pageForm?.dataCount ?? first?.positonNum ?? 0);
      for (let size = 1; size < 50 && size < total; size *= 2) add(await call("listPosition", { ...base, pageSize: size, currentPage: 2 }));
      for (let page = 2; (page - 1) * 50 < total && page <= (cfg.maxPages ?? 40); page++) add(await call("listPosition", { ...base, pageSize: 50, currentPage: page }));
      ctx.log(`dayee ${t.su}: ${rows.size}/${total} rows`);
      const out: Listing[] = [];
      for (const p of rows.values()) {
        if (!rowToListing(p, null, t.su, cfg)) continue; // closed / earlier project: no detail request
        if (!details.has(p.postId)) details.set(p.postId, await call("listPositionDetail", { postId: p.postId, recruitType: t.recruitType }).catch(() => null));
        const l = rowToListing(p, details.get(p.postId), t.su, cfg);
        if (l) out.push(l);
      }
      return out;
    });
  },
};
