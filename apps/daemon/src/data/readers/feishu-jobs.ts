import type { Listing, Source, SourceConfig, SourceContext } from "../types.js";

/**
 * 飞书招聘 career portals on <tenant>.jobs.feishu.cn (the ATS behind 蔚来 / 拓竹 / 智元 / Momenta …; 208 campaigns in the
 * user's sheet point there). Read the way the portal's own front end does (verified 2026-09-22 on bambulab 157, nio 893,
 * pecivkvtit 31 posts): POST /api/v1/csrf/token with the portal path as `website-path` → token (also set as the
 * atsx-csrf-token cookie), then POST /api/v1/search/job/posts with `x-csrf-token`, 100 per page. A `?project=<id>` in
 * the portal URL is a 招聘项目 (job_subject) and narrows the list with subject_id_list. No login, no cookies of the
 * user's, ~400 ms between pages.
 */
const HOST = /^https:\/\/([a-z0-9-]+)\.jobs\.feishu\.cn(?:\/([^/?#]*))?/i;
/** A tenant's 社招 portal: not something 校招 sync should pull (bambulab/experienced held 387 social jobs). */
const SOCIAL_PATH = /^(experienced|social|society|shezhao)/i;

export function feishuTenant(url: string): { tenant: string; path: string; project?: string } | null {
  const m = HOST.exec(url);
  if (!m || (m[2] && SOCIAL_PATH.test(m[2]))) return null;
  const path = m[2] && !/^(position|api)$/i.test(m[2]) ? m[2] : "index";
  const project = (() => { try { return new URL(url).searchParams.get("project") ?? undefined; } catch { return undefined; } })();
  return { tenant: m[1], path, project };
}

export interface FeishuPost {
  id: string; title: string; description?: string | null; requirement?: string | null; publish_time?: number | null;
  city_info?: { name?: string } | null; city_list?: { name?: string }[] | null;
  recruit_type?: { name?: string; parent?: { name?: string } | null } | null;
  job_subject?: { id?: string; name?: { zh_cn?: string; i18n?: string } | null } | null;
  job_function?: { name?: string } | null;
}

const clean = (s?: string | null) => (s ?? "").replace(/\r/g, "").replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

/** Map one post → Listing. Exported for tests. */
export function postToListing(p: FeishuPost, t: { tenant: string; path: string }, cfg: SourceConfig): Listing {
  const desc = [clean(p.description) && `岗位职责\n${clean(p.description)}`, clean(p.requirement) && `任职要求\n${clean(p.requirement)}`].filter(Boolean).join("\n\n");
  const degree = /(博士|硕士及以上|硕士|本科及以上|本科|大专)/.exec(desc)?.[1];
  const family = p.recruit_type?.parent?.name ?? p.recruit_type?.name ?? "";
  const subject = p.job_subject?.name?.zh_cn ?? p.job_subject?.name?.i18n ?? "";
  const cohortIn = /(\d{2,4})\s*届/.exec(subject)?.[1];
  const cities = (p.city_list ?? []).map((c) => c.name ?? "").filter(Boolean);
  return {
    externalId: p.id,
    url: `https://${t.tenant}.jobs.feishu.cn/${t.path}/position/${p.id}/detail/`,
    title: clean(p.title),
    company: cfg.name || t.tenant,
    orgUnit: p.job_function?.name || undefined,
    locations: cities.length ? cities : p.city_info?.name ? [p.city_info.name] : [],
    description: desc,
    employmentType: p.recruit_type?.name || undefined,
    datePosted: p.publish_time ? new Date(p.publish_time).toISOString() : undefined,
    degreeReq: degree,
    cohort: cfg.cohort ?? (cohortIn ? `${cohortIn.length === 2 ? "20" + cohortIn : cohortIn}届` : undefined),
    batch: cfg.batch ?? (subject || (family.includes("校招") ? "校招" : "社招")),
    kind: cfg.kind ?? (family.includes("校招") || /实习/.test(p.recruit_type?.name ?? "") ? (degree === "博士" ? "博士专项" : "校招") : "社招"),
    publisher: `feishu-jobs:${t.tenant}`,
    grade: "官方",
    isOriginal: true,
    confidence: 0.9,
    raw: p,
  };
}

const UA_HEADERS = { "content-type": "application/json", "portal-channel": "official", "portal-platform": "pc", "accept-language": "zh-CN" };

export const feishuJobs: Source = {
  id: "feishu-jobs",
  name: "飞书招聘", input: "<公司>.jobs.feishu.cn（校招路径）",
  mode: "pull",
  describe: "飞书招聘门户（<租户>.jobs.feishu.cn）：走门户前端自己的搜索接口，零 token",
  detect: (url) => !!feishuTenant(url),
  // "/", "/index" and "/campus" of one tenant are one portal unless a 招聘项目 narrows it
  siteKey: (url) => { const t = feishuTenant(url)!; return `${t.tenant}${t.project ? "/" + t.project : ""}`; },
  async fetch(cfg, ctx: SourceContext) {
    const t = feishuTenant(cfg.url ?? "");
    if (!t) throw new Error(`BAD_URL: 不是飞书招聘的校招站：${cfg.url}`);
    const base = `https://${t.tenant}.jobs.feishu.cn/api/v1`;
    const csrf: any = await ctx.fetchJson(`${base}/csrf/token`, { method: "POST", headers: { ...UA_HEADERS, "website-path": t.path }, body: "{}" });
    const token: string = csrf?.data?.token ?? "";
    if (!token) throw new Error("SCHEMA_CHANGED: 飞书招聘：没拿到 csrf token");
    const headers = { ...UA_HEADERS, "website-path": t.path, "x-csrf-token": token, cookie: `atsx-csrf-token=${encodeURIComponent(token)}` };
    const posts = async (project: string | undefined): Promise<Listing[]> => {
      const out: Listing[] = [];
      const seen = new Set<string>();
      const limit = 100;
      for (let page = 0; page < (cfg.maxPages ?? 10); page++) {
        const body = {
          keyword: cfg.keywords?.[0] ?? "", limit, offset: page * limit, job_category_id_list: [], tag_id_list: [], location_code_list: [],
          subject_id_list: project ? [project] : [], recruitment_id_list: [], portal_type: 3, job_function_id_list: [], storefront_id_list: [], portal_entrance: 1,
        };
        const res: any = await ctx.fetchJson(`${base}/search/job/posts`, { method: "POST", headers, body: JSON.stringify(body) });
        if (res?.code !== 0) throw new Error(`SCHEMA_CHANGED: 飞书招聘：${res?.message ?? "接口返回异常"}`);
        const batch: FeishuPost[] = res.data?.job_post_list ?? [];
        for (const p of batch) {
          if (seen.has(p.id)) continue;
          seen.add(p.id);
          const l = postToListing(p, t, cfg);
          if (l.kind === "社招" && cfg.kind !== "社招") continue; // a mixed portal: 校招 sync keeps campus and intern posts only
          out.push(l);
        }
        ctx.log(`feishu-jobs ${t.tenant}/${t.path}: page ${page + 1} +${batch.length} (${out.length}/${res.data?.count ?? "?"})`);
        if (batch.length < limit || out.length >= (res.data?.count ?? 0)) break;
        await ctx.sleep(400);
      }
      return out;
    };
    const out = await posts(t.project);
    // a link narrowed to one 招聘项目 goes quiet when that project ends, while the same portal opens the next one: read
    // the portal (still this tenant and this path, campus and intern posts only) and keep the wider link
    if (!out.length && t.project) {
      const wide = await posts(undefined);
      if (wide.length) {
        const u = new URL(cfg.url!); u.searchParams.delete("project");
        ctx.log(`feishu-jobs ${t.tenant}: 项目 ${t.project} 没有岗位，改读整个门户（${wide.length}）`);
        ctx.learn?.({ url: u.href, widenedFrom: cfg.url });
      }
      return wide;
    }
    return out;
  },
};
