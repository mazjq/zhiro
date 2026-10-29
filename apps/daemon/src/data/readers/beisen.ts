import { incomplete, type Listing, type Source, type SourceConfig, type SourceContext } from "../types.js";

/** a safety stop, not a size: a list ends at its own total (中国核电 lists 1,126 posts, 23 pages of 50) */
const MAX_PAGES = 100;

/**
 * 北森 (Beisen) career portals on <tenant>.zhiye.com. Two generations exist side by side (verified 2026-09-15):
 *  - portal-2022 SPA: POST /api/Jobad/GetJobAdPageList returns full rows (Duty/Require/LocNames/Org/Degree).
 *    Category "2" = 校园招聘, "1" = 社会招聘. Verified on hzncc (12), cssc717 (16), bsthr (10).
 *  - CmsPortal (older): server-rendered /campus?PageIndex=N table with /zpdetail/<id> links; JD needs one
 *    detail fetch per job (bounded). Verified on jingce (15).
 * Strategy: try the API; if the tenant redirects it to /404 (non-JSON), fall back to the HTML list.
 * No login, no cookies; ~400 ms between requests.
 */
const HOST = /^https:\/\/([a-z0-9-]+)\.zhiye\.com(?:\/|$)/i;

export function beisenTenant(url: string): string | null {
  const m = HOST.exec(url);
  return m ? m[1] : null;
}

const ZERO_DATE = /^0001-01-01/;
const okDate = (s?: string) => (s && !ZERO_DATE.test(s) ? new Date(s).toISOString() : undefined);
const clean = (s?: string) => (s ?? "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();

interface ApiRow { Id: string; JobAdId?: number; JobAdName: string; Org?: string; Category?: string; LocNames?: string[]; Duty?: string; Require?: string; Degree?: string; PostDate?: string; EndTime?: string; Kind?: string; Salary?: string | null }

/** Map one portal-2022 API row → Listing. Exported for tests. */
export function apiRowToListing(r: ApiRow, tenant: string, cfg: SourceConfig): Listing {
  const desc = [r.Duty && `岗位职责\n${clean(r.Duty)}`, r.Require && `任职要求\n${clean(r.Require)}`].filter(Boolean).join("\n\n");
  const degree = r.Degree || /(博士|硕士及以上|硕士|本科及以上|本科|大专)/.exec(desc)?.[1] || undefined;
  return {
    externalId: r.Id,
    url: `https://${tenant}.zhiye.com/campus/jobs/${r.Id}`,
    title: clean(r.JobAdName),
    company: cfg.name || tenant,
    orgUnit: clean(r.Org) || undefined,
    locations: (r.LocNames ?? []).map((s) => s.replace(/·/g, " ").trim()).filter(Boolean),
    description: desc,
    employmentType: r.Kind || undefined,
    datePosted: okDate(r.PostDate),
    validThrough: okDate(r.EndTime),
    degreeReq: degree,
    cohort: cfg.cohort,
    batch: cfg.batch ?? "校招",
    kind: cfg.kind ?? (degree === "博士" ? "博士专项" : "校招"),
    publisher: `beisen:${tenant}`,
    grade: "官方",
    isOriginal: true,
    confidence: 0.9,
    raw: r,
  };
}

/** Parse a CmsPortal list page. Exported for tests. */
export function parseCmsList(html: string): { id: string; title: string; dept: string; loc: string; date: string }[] {
  const out: { id: string; title: string; dept: string; loc: string; date: string }[] = [];
  // links carry ?PageIndex=N once a page parameter is present, so allow an optional query
  const re = /<a\s+title="([^"]*)"\s+href="\/zpdetail\/(\d+)(?:\?[^"]*)?"[^>]*>[\s\S]*?<\/a>\s*<\/td>([\s\S]*?)<\/tr>/g;
  for (const m of html.matchAll(re)) {
    const cells = [...m[3].matchAll(/<td(?:\s+title="([^"]*)")?[^>]*>([\s\S]*?)<\/td>/g)].map((c) => clean(c[1] ?? c[2]));
    out.push({ id: m[2], title: clean(m[1]), dept: cells[0] ?? "", loc: cells[1] ?? "", date: cells[2] ?? "" });
  }
  return out;
}

export function parseCmsDetail(html: string): string {
  const body = html.replace(/<script[\s\S]*?<\/script>/g, "").replace(/<style[\s\S]*?<\/style>/g, "");
  const i = body.search(/岗位职责|职位描述|工作职责|任职要求|岗位要求/);
  const slice = i >= 0 ? body.slice(i - 100, i + 6000) : body;
  return clean(slice).slice(0, 4000);
}

async function tryApi(tenant: string, cfg: SourceConfig, ctx: SourceContext): Promise<{ rows: ApiRow[]; total: number } | null> {
  const categories = (cfg.categories as string[] | undefined) ?? ["2"];
  const rows: ApiRow[] = [];
  const pageSize = 50;
  let total = 0;
  for (let page = 0; page < (cfg.maxPages ?? MAX_PAGES); page++) {
    let res: any;
    try {
      res = await ctx.fetchJson(`https://${tenant}.zhiye.com/api/Jobad/GetJobAdPageList`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ PageIndex: page, PageSize: pageSize, Category: categories, KeyWords: cfg.keywords?.[0] ?? "", SpecialType: 0, PortalId: "", DisplayFields: ["Category", "Kind", "LocId", "Org"] }),
        redirect: "manual",
      });
    } catch {
      return page === 0 ? null : { rows, total: Infinity }; // first page not JSON → not this generation; a later one failing leaves the list unfinished
    }
    if (!res || res.Code !== 200 || !Array.isArray(res.Data)) return page === 0 ? null : { rows, total: Infinity };
    rows.push(...res.Data);
    total = Number(res.Count ?? 0);
    if (rows.length >= (res.Count ?? 0) || res.Data.length < pageSize) break;
    await ctx.sleep(400);
  }
  return { rows, total };
}

async function cmsFallback(tenant: string, cfg: SourceConfig, ctx: SourceContext): Promise<Listing[]> {
  const base = `https://${tenant}.zhiye.com`;
  const listPath = (cfg.listPath as string | undefined) ?? "/campus";
  const seen = new Map<string, ReturnType<typeof parseCmsList>[number]>();
  // MvcPager is 0-based: /campus == ?PageIndex=0. Stop on an empty page or when a page repeats.
  let ended = false;
  for (let page = 0; page < (cfg.maxPages ?? MAX_PAGES); page++) {
    const html = await ctx.fetchText(page === 0 ? `${base}${listPath}` : `${base}${listPath}?PageIndex=${page}`);
    const rows = parseCmsList(html);
    if (rows.length === 0 || rows.every((r) => seen.has(r.id))) { ended = true; break; }
    for (const r of rows) seen.set(r.id, r);
    await ctx.sleep(400);
  }
  const out: Listing[] = [];
  const detailCap = (cfg.detailCap as number | undefined) ?? 60;
  let fetched = 0;
  for (const r of seen.values()) {
    let description = "";
    if (fetched < detailCap) {
      try { description = parseCmsDetail(await ctx.fetchText(`${base}/zpdetail/${r.id}`)); fetched++; await ctx.sleep(300); } catch { /* keep listing without JD */ }
    }
    const degree = /(博士|硕士及以上|硕士|本科及以上|本科|大专)/.exec(description)?.[1];
    out.push({
      externalId: r.id, url: `${base}/zpdetail/${r.id}`, title: r.title, company: cfg.name || tenant, orgUnit: r.dept || undefined,
      locations: r.loc.split(/[,，]/).map((s) => s.trim()).filter(Boolean), description, datePosted: /^\d{4}-\d{2}-\d{2}$/.test(r.date) ? new Date(r.date).toISOString() : undefined,
      degreeReq: degree, cohort: cfg.cohort, batch: cfg.batch ?? "校招", kind: cfg.kind ?? (degree === "博士" ? "博士专项" : "校招"),
      publisher: `beisen:${tenant}`, grade: "官方", isOriginal: true, confidence: 0.85, raw: r,
    });
  }
  return ended ? out : incomplete(out, `北森列表页读到第 ${cfg.maxPages ?? MAX_PAGES} 页还没完`);
}

export const beisen: Source = {
  id: "beisen",
  name: "北森", input: "<公司>.zhiye.com",
  mode: "pull",
  describe: "北森招聘门户（<租户>.zhiye.com）：新版走 GetJobAdPageList 接口，老版解析 /campus 列表页；零 token",
  detect: (url) => !!beisenTenant(url),
  siteKey: (url) => beisenTenant(url)!,
  async fetch(cfg, ctx) {
    const tenant = beisenTenant(cfg.url ?? "");
    if (!tenant) throw new Error(`BAD_URL: 北森：认不出租户 ${cfg.url}`);
    const api = await tryApi(tenant, cfg, ctx);
    if (api) {
      ctx.log(`beisen ${tenant}: api ${api.rows.length}/${api.total} rows`);
      const out = api.rows.map((r) => apiRowToListing(r, tenant, cfg));
      return api.rows.length < api.total ? incomplete(out, `北森 ${api.rows.length}/${api.total === Infinity ? "?" : api.total}`) : out;
    }
    const listings = await cmsFallback(tenant, cfg, ctx);
    ctx.log(`beisen ${tenant}: cms ${listings.length} rows`);
    return listings;
  },
};
