import { incomplete, pullOnce, type Listing, type Source, type SourceConfig, type SourceContext } from "../types.js";

/**
 * 国聘 (iguopin.com: the state-owned groups' campus portal — 航天科技, 国家电投, 中国能建, 中国电建 … as
 * <tenant>.iguopin.com, companies as www.iguopin.com/company?id=). Read the way the React front end does (verified
 * 2026-09-29, spic2027 659 / ceec 664 / spacechina 72 posts): base gp-api.iguopin.com with the headers Device /
 * Version / Subsite, no login. A tenant's config names its job tabs (projectId, or nature codes for a company tree);
 * a company URL lists the company and its subsidiaries with nature 115xW5oQ (= 校招). 200 per page at most.
 * Each post keeps its employing unit as the company. Posts carry end_time, used as the deadline.
 */
const G = "https://gp-api.iguopin.com";
const H = { "content-type": "application/json", Device: "pc", Version: "5.0.0", Subsite: "iguopin" };
const CAMPUS = "115xW5oQ";

export function iguopinUrl(url: string): { tenant?: string; path: string; id?: string; kind: "tenant" | "company" | "job" } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)iguopin\.com$/.test(u.hostname)) return null;
  const sub = u.hostname.split(".")[0], id = u.searchParams.get("id") ?? undefined;
  if (sub !== "www" && sub !== "iguopin" && !/^(m|api\d*|gp-api)$/.test(sub)) return { tenant: sub, path: u.pathname, kind: "tenant" };
  if (/^\/job\/detail/.test(u.pathname) && id) return { path: u.pathname, id, kind: "job" };
  if (/^\/company/.test(u.pathname) && id) return { path: u.pathname, id, kind: "company" };
  return null;
}

async function api(ctx: SourceContext, path: string, body?: unknown): Promise<any> {
  const r: any = await ctx.fetchJson(G + path, body ? { method: "POST", headers: H, body: JSON.stringify(body) } : { headers: H });
  if (r?.code !== 200) throw new Error(`SCHEMA_CHANGED: 国聘 ${path}：${r?.code} ${r?.msg ?? ""}`);
  return r.data;
}

type Query = { projectIds: string[]; companyId?: string; nature: string[]; tags?: string[] };

/** A tenant's job tab: the one at the URL's path, else the one titled 校招, else the first with jobs. Exported for tests. */
export function pickNav(nav: any[], path: string): any | undefined {
  const jobs = nav.filter((n) => n?.props?.projectId || n?.props?.nature);
  return jobs.find((n) => n.route === path) ?? jobs.find((n) => /校/.test(n.title ?? "")) ?? jobs[0];
}

async function queryOf(url: string, ctx: SourceContext): Promise<Query & { companyId?: string }> {
  const t = iguopinUrl(url);
  if (!t) throw new Error(`BAD_URL: 不是国聘链接：${url}`);
  if (t.kind === "company") return { projectIds: [], companyId: t.id, nature: [CAMPUS] };
  if (t.kind === "job") {
    const j = await api(ctx, `/api/jobs/v1/info?id=${t.id}`);
    return { projectIds: [], companyId: String(j.company_id), nature: [CAMPUS] };
  }
  const d = await api(ctx, `/api/activity/exclusive/v1/info?domain=${t.tenant}`);
  const nav = pickNav(JSON.parse(d.content ?? "{}")?.params?.nav ?? [], t.path);
  const projectIds = String(nav?.props?.projectId ?? "").split(",").filter(Boolean);
  return { projectIds, companyId: String(d.company_id), nature: String(nav?.props?.nature ?? CAMPUS).split(",").filter(Boolean) };
}

/** One post → Listing. Exported for tests. */
export function postToListing(j: any, cfg: SourceConfig): Listing | null {
  if (!j?.job_id || !j.job_name) return null;
  const end = String(j.end_time ?? "").slice(0, 10);
  return {
    externalId: String(j.job_id),
    url: `https://www.iguopin.com/job/detail?id=${j.job_id}`,
    title: String(j.job_name).trim(),
    company: String(j.company_name ?? "").trim() || cfg.name || "国聘",
    orgUnit: j.department_cn || undefined,
    industry: j.company_info?.industry_cn || undefined,
    locations: [...new Set(((j.district_list ?? []) as any[]).map((d) => String(d.area_cn ?? "").split("-")[0]).filter(Boolean))],
    description: String(j.contents ?? "").trim(),
    datePosted: j.start_time ? String(j.start_time).replace(" ", "T") + "+08:00" : undefined,
    validThrough: /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : undefined,
    deadlineText: j.end_time ? String(j.end_time) : undefined,
    degreeReq: j.education_cn || undefined,
    majorReq: Array.isArray(j.major_cn) ? j.major_cn.join("、") : undefined,
    cohort: cfg.cohort ?? "2027届",
    batch: cfg.batch ?? "校招",
    kind: cfg.kind ?? (j.education_cn === "博士" ? "博士专项" : /实习/.test(j.nature_cn ?? "") ? "实习" : "校招"),
    publisher: "iguopin",
    grade: "官方",
    isOriginal: true,
    confidence: 0.9,
  };
}

/**
 * 国聘全站发现 (ADR-034): no sheet, no company link — the whole site's campus posts for each of the user's direction and
 * major words (「运动控制」「控制」…), so a user without a summary sheet still gets the state-owned employers. The
 * subscription is kept in step with the profile by official.ts; the rules layer then sorts what comes in.
 */
async function discover(cfg: SourceConfig, ctx: SourceContext): Promise<Listing[]> {
  const out = new Map<string, Listing>();
  let capped = "";
  for (const keyword of (cfg.keywords ?? []).slice(0, 8)) {
    for (let page = 1; page <= (cfg.maxPages ?? 10); page++) {
      const d = await api(ctx, "/api/jobs/v1/list", { page, page_size: 200, nature: [CAMPUS], keyword, source: "s_job_list" });
      const list: any[] = d?.list ?? [];
      for (const j of list) { const l = postToListing(j, { ...cfg, name: "" }); if (l && !out.has(l.externalId)) out.set(l.externalId, l); }
      ctx.log(`iguopin 发现「${keyword}」: page ${page} +${list.length} (${out.size})`);
      if (list.length < 200) break;
      if (page === (cfg.maxPages ?? 10)) capped = `国聘「${keyword}」读到第 ${page} 页还没完`;
      await ctx.sleep(400);
    }
  }
  return capped ? incomplete([...out.values()], capped) : [...out.values()];
}

export const iguopin: Source = {
  id: "iguopin",
  name: "国聘", input: "<集团>.iguopin.com 专场、www.iguopin.com/company?id=、岗位详情页",
  mode: "pull",
  describe: "国聘（<集团>.iguopin.com 专场、www.iguopin.com/company?id=）：走站点前端接口，按招聘项目或公司树拉校招岗位（含截止），零 token",
  detect: (url) => !!iguopinUrl(url),
  siteKey: (url) => { const t = iguopinUrl(url)!; return t.kind === "tenant" ? t.tenant! : `${t.kind}/${t.id}`; },
  async fetch(cfg, ctx) {
    if (cfg.discover) return discover(cfg, ctx);
    const q = await queryOf(cfg.url ?? "", ctx);
    return pullOnce(`iguopin:${JSON.stringify(q)}`, async () => {
    const out: Listing[] = [];
    const seen = new Set<string>();
    let capped = "";
    // a tenant still pointing at last year's project lists nothing: then the company tree is the fallback
    for (const mode of q.projectIds.length ? ["project", "company"] : ["company"]) {
      for (let page = 1; page <= (cfg.maxPages ?? 20); page++) {
        const d = mode === "project"
          ? await api(ctx, "/api/jobs/v1/project-job", { page, page_size: 200, project_id: q.projectIds })
          : await api(ctx, "/api/jobs/v1/list", { page, page_size: 200, company_id_with_sub: q.companyId, nature: q.nature, source: "s_job_list" });
        const list: any[] = d?.list ?? [];
        for (const j of list) { const l = postToListing(j, cfg); if (l && !seen.has(l.externalId)) { seen.add(l.externalId); out.push(l); } }
        ctx.log(`iguopin ${mode}: page ${page} +${list.length} (${out.length})`);
        if (list.length < 200) break;
        if (page === (cfg.maxPages ?? 20)) capped = `国聘读到第 ${page} 页还没完`;
        await ctx.sleep(400);
      }
      if (out.length) break;
    }
    return capped ? incomplete(out, capped) : out;
    });
  },
};
