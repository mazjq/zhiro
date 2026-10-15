import mokahr from "./career-ops/mokahr.mjs";
import type { Listing, Source, SourceConfig, SourceContext } from "../types.js";

/**
 * Moka (mokahr.com) campus/social tenant sites — wraps the career-ops provider as-is (MIT; the three files in
 * ./career-ops/ are copied unchanged from career-ops-hq/career-ops at da8c6f9, licence beside them).
 * Verified 2026-09-15 on two real campus tenants (voyah 88 jobs, gufen 16 jobs), zero-token, no login.
 */
type VendorJob = { title: string; url: string; company: string; location: string; description?: string; postedAt?: number };
const provider = async (): Promise<{ fetch(entry: any, ctx: any): Promise<VendorJob[]> }> => mokahr;

// A tenant may serve the same site from its own domain (大疆: apply.careers.dji.com/campus-recruitment/dji/143359); the
// path keeps Moka's shape and the API answers for it on app.mokahr.com all the same (verified 2026-10-06). `/apply/` is
// too common a path to trust on a foreign host.
const TENANT = /^https:\/\/(?:app\.mokahr\.com\/(campus-recruitment|social-recruitment|apply)|[^/]+\/(campus-recruitment|social-recruitment))\/([^/?#]+)\/(\d+)/;

export function mokaTenant(url: string): { orgId: string; siteId: string; canonical: string } | null {
  const m = TENANT.exec(url);
  return m ? { orgId: m[3], siteId: m[4], canonical: `https://app.mokahr.com/${m[1] ?? m[2]}/${m[3]}/${m[4]}` } : null;
}

/** Map a vendored Job to our Listing; exported for tests. */
export function toListing(j: VendorJob, cfg: SourceConfig): Listing {
  const t = mokaTenant(cfg.url ?? "")!;
  const idMatch = /#\/job\/([^/?#]+)/.exec(j.url);
  const desc = j.description ?? "";
  const dept = /部门:\s*([^\n]+)/.exec(desc)?.[1]?.trim();
  const commitment = /类型:\s*([^\n]+)/.exec(desc)?.[1]?.trim();
  const degree = /(博士|硕士及以上|硕士|本科及以上|本科|大专)/.exec(desc)?.[1];
  return {
    externalId: idMatch ? decodeURIComponent(idMatch[1]) : j.url,
    url: j.url,
    title: j.title,
    company: cfg.name || j.company || t.orgId,
    orgUnit: dept,
    locations: j.location ? j.location.split("/").map((s) => s.trim()).filter(Boolean) : [],
    description: desc,
    employmentType: commitment,
    datePosted: j.postedAt ? new Date(j.postedAt).toISOString() : undefined,
    degreeReq: degree,
    cohort: cfg.cohort,
    batch: cfg.batch ?? (/campus/.test(cfg.url ?? "") ? "校招" : "社招"),
    kind: cfg.kind ?? (/campus/.test(cfg.url ?? "") ? (degree === "博士" ? "博士专项" : "校招") : "社招"),
    publisher: `moka:${t.orgId}`,
    grade: "官方",
    isOriginal: true,
    confidence: 0.9,
    raw: j,
  };
}

export const moka: Source = {
  id: "moka",
  name: "Moka", input: "app.mokahr.com/campus-recruitment/<公司>/<站点>（公司自有域名上的同样路径也认）",
  mode: "pull",
  describe: "Moka 招聘站（app.mokahr.com 校招/社招租户），走站点前端自己的接口，零 token",
  detect: (url) => !!mokaTenant(url),
  siteKey: (url) => { const t = mokaTenant(url)!; return `${t.orgId}/${t.siteId}`; },
  async fetch(cfg, ctx: SourceContext) {
    const tenant = cfg.url ? mokaTenant(cfg.url) : null;
    if (!tenant) throw new Error(`BAD_URL: Moka：认不出租户 ${cfg.url}`);
    const p = await provider();
    const jobs: VendorJob[] = await p.fetch(
      { name: cfg.name ?? "", careers_url: tenant.canonical, keywords: cfg.keywords?.length ? cfg.keywords : [""], max_pages: cfg.maxPages ?? 10 },
      { fetchJson: ctx.fetchJson, fetchText: ctx.fetchText, sleep: ctx.sleep, maxPages: ctx.maxPages, transport: "http" },
    );
    ctx.log(`moka ${cfg.name ?? cfg.url}: ${jobs.length} jobs`);
    return jobs.map((j) => toListing(j, cfg));
  },
};
