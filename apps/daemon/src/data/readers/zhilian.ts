import { incomplete, pullOnce, type Listing, type Source, type SourceConfig, type SourceContext } from "../types.js";

/**
 * 智联校园 (xiaoyuan.zhaopin.com and the groups' branded <brand>.zhaopin.com sites; 中国船舶集团 alone lists 1,262
 * posts across 67 units there). Read the way the sites' front end does (verified 2026-09-29): POST
 * fe.zhaopin.com/grace/api/dsc/search-job-list with the campus root org id, jobSource 2, 200 per page. No login,
 * cookies or signing. The root id is not in the URL: a branded site carries it as xiaozhaoId in its JS bundle, a job
 * page as companyRootId. Each post keeps its hiring unit as the company, so a group portal fills its institutes.
 * ponytail: no deadline — the list API has none and the job page only holds a project-wide window.
 */
const API = "https://fe.zhaopin.com/grace/api/dsc/search-job-list";
const JOB = /(C[CZ]L?\d+J\d+)/;

export function zhilianUrl(url: string): { host: string; job?: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (!/(^|\.)zhaopin\.com$/.test(u.hostname) || u.hostname === "fe.zhaopin.com") return null;
  const job = JOB.exec(u.pathname)?.[1];
  // www.zhaopin.com without a job is the 社招 site; xiaoyuan/m/webapp need a job or company page to name the employer
  if (!job && /^(www\.|m\.)?zhaopin\.com$|^(xiaoyuan|m|webapp)\.zhaopin\.com$/.test(u.hostname) && !/\/company\/KA|\/\d{4}\//.test(u.pathname)) return null;
  return { host: u.hostname, job };
}

/**
 * The campus id is compiled into the site's job-list component, under one of several names (xiaozhaoId, companyXzId,
 * companyOutId, rootCompanyId, orgNumber, or a local constant after globalData.companyId); CMS-built sites keep the job
 * list on a route page of its own (nativeHref:"jobs" → /jobs/index.html) with its own bundle. Verified 2026-09-30 on
 * 中航西飞, 航发商发, 中国一拖, 河北建投 (two ids), 广州工控, 电科55所. Only ids the list API answers for are kept.
 */
const ID = /(?:xiaozhaoId|companyXzId|companyOutId|rootCompanyId|orgNumbers?)["']?[:=]\[?["']?(\d{5,7})\b|globalData\.companyId,[\w$]+="?(\d{5,7})\b/g;
export const idsIn = (text: string) => [...new Set([...text.matchAll(ID)].map((m) => m[1] || m[2]))];

async function count(ctx: SourceContext, id: string): Promise<number> {
  const r: any = await ctx.fetchJson(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgNumbers: [id], jobSource: 2, pageIndex: 1, pageSize: 1 }) }).catch(() => null);
  return r?.data?.pageInfo?.totalNum ?? 0;
}

/** xiaoyuan sometimes answers with a ~1 KB EdgeOne script page first; we do not run it, we just ask again a little later. */
async function page(ctx: SourceContext, url: string): Promise<string> {
  for (let i = 0; ; i++) {
    const t = await ctx.fetchText(url);
    if (!/EO_Bot_Ssid/.test(t) || t.length > 5000 || i >= 3) return t;
    await ctx.sleep(1500 * (i + 1));
  }
}

const roots = new Map<string, string[]>(); // per site: the crawl below is up to a few dozen requests
export async function rootIdsOf(url: string, ctx: SourceContext): Promise<string[]> {
  const z = zhilianUrl(url);
  const key = z?.job && /^(xiaoyuan|m|www|webapp)\./.test(z.host) ? z.job : new URL(url).origin + (url.includes("webapp.zhaopin.com") ? new URL(url).pathname.split("/").slice(0, 4).join("/") : "");
  if (roots.has(key)) return roots.get(key)!;
  let ids: string[] = [];
  if (z?.job) {
    const html = await page(ctx, `https://xiaoyuan.zhaopin.com/job/${z.job}`);
    // three different things, three different remedies: the bot check never let us in, the post is gone, or the unit has nothing open
    if (/EO_Bot_Ssid/.test(html) && html.length < 5000) throw new Error(`BLOCKED: 智联：岗位页一直是机器人校验页 ${url}`);
    ids = [/"companyRootId":(\d+)/.exec(html)?.[1] ?? ""].filter(Boolean);
    if (!ids.length) throw new Error(`LINK_STALE: 智联：这个岗位页里已经没有公司的校招机构号（岗位多半下线了） ${url}`);
  } else {
    const u = new URL(url), base = u.origin + (u.host.startsWith("webapp.") ? u.pathname.split("/").slice(0, 4).join("/") : "") + "/";
    const pages = [url], seen = new Set(pages), js: string[] = [];
    let all = "";
    for (let i = 0; i < pages.length && i < 8; i++) {
      const html = await page(ctx, pages[i]).catch((e: Error) => {
        // a group site Zhilian no longer serves answers 403, as a name that never existed does (checked 2026-10-30): gone, not blocked
        if (i === 0 && /HTTP 40[34]\b/.test(e.message)) throw new Error(`SITE_GONE: 智联：这个集团校招站已经下线 ${url}`);
        return "";
      });
      all += html;
      for (const m of html.matchAll(/(?:src|href)="([^"]+\.js)"/g)) { const s = new URL(m[1], pages[i]).href; if (/\/assets\/|\/static\//.test(s) && !seen.has(s)) { seen.add(s); js.push(s); } }
      for (let j = 0; j < js.length && j < 40; j++) {
        const src = js[j];
        if (src === "") continue;
        js[j] = "";
        const t = await ctx.fetchText(src).catch(() => "");
        all += t;
        for (const m of t.matchAll(/["'`](\.{1,2}\/[\w./-]+?\.js)(?=["'`])/g)) { const s = new URL(m[1], src).href; if (!seen.has(s)) { seen.add(s); js.push(s); } }
      }
      // every route page: 河北建投 keeps a second campus id on another one
      for (const m of all.matchAll(/nativeHref:"(\w+)"/g)) { const p = base + (m[1] === "index" ? "" : `${m[1]}/index.html`); if (!seen.has(p)) { seen.add(p); pages.push(p); } }
    }
    ids = idsIn(all);
    if (!ids.length) throw new Error(`SCHEMA_CHANGED: 智联：站点里没找到校招机构号 ${url}`);
  }
  const live: string[] = [];
  for (const id of ids) if ((await count(ctx, id)) > 0) live.push(id);
  if (!live.length) throw new Error(`ZERO_POSTS: 智联：没找到有岗位的校招机构号 ${url}`);
  roots.set(key, live);
  return live;
}

export interface ZhilianItem {
  company?: { campusOrgName?: string; campusDepartment?: { name?: string } | null; companyNumber?: string };
  job?: { jobNumber?: string; title?: string; cityName?: string; minEducationName?: string; needMajor?: string; detail?: string; url?: string; jobTypeName?: string; modifiedTime?: number };
}

/** One post → Listing. Exported for tests. */
export function itemToListing(it: ZhilianItem, root: string, cfg: SourceConfig): Listing | null {
  const j = it.job ?? {}, c = it.company ?? {};
  if (!j.jobNumber || !j.title) return null;
  const detail = (j.detail ?? "").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return {
    externalId: j.jobNumber,
    url: j.url || `https://xiaoyuan.zhaopin.com/job/${j.jobNumber}`,
    title: j.title.trim(),
    company: c.campusOrgName?.trim() || cfg.name || `智联 ${root}`,
    orgUnit: c.campusDepartment?.name || undefined,
    locations: j.cityName ? [j.cityName] : [],
    description: detail,
    datePosted: j.modifiedTime ? new Date(j.modifiedTime).toISOString() : undefined,
    degreeReq: j.minEducationName || undefined,
    majorReq: j.needMajor || undefined,
    cohort: cfg.cohort ?? "2027届",
    batch: cfg.batch ?? "校招",
    kind: cfg.kind ?? (j.minEducationName === "博士" ? "博士专项" : "校招"),
    publisher: `zhilian:${root}`,
    grade: "官方",
    isOriginal: true,
    confidence: 0.9,
  };
}

export const zhilian: Source = {
  id: "zhilian",
  name: "智联校园", input: "xiaoyuan.zhaopin.com 岗位/公司页、集团专属站 <集团>.zhaopin.com",
  mode: "pull",
  describe: "智联校园（xiaoyuan.zhaopin.com、集团专属站 <集团>.zhaopin.com）：走站点前端的搜索接口，按集团校招机构号拉全部单位的岗位，零 token",
  detect: (url) => !!zhilianUrl(url),
  // ponytail: the root id needs a request, so two job links of one group are two subscriptions (same campaigns, a scan wasted)
  siteKey: (url) => { const z = zhilianUrl(url)!; return z.job && /^(xiaoyuan|m|www|webapp)\./.test(z.host) ? `job/${z.job}` : z.host; },
  /**
   * A job link names its company in the job number (CCL1226837610J40891991705 → CCL1226837610): if posts of that company
   * were read before, the library knows its campus id without the job page, which the bot check often blocks and which
   * goes when the post does (2026-10-29: 七〇五所's link read 「没找到有岗位」 for weeks while 102 of its posts were open).
   */
  hint(cfg, db) {
    if (cfg.rootId) return null;
    const company = /^(C[CZ]L?\d+)J/.exec(zhilianUrl(cfg.url ?? "")?.job ?? "")?.[1];
    // a group site: the ids its own earlier reads came under. They belong to the organisation, not to one season's site
    // (河北建投's 2027 site went 2026-10-29; 106565/106566 stay, and its next season's posts come under them).
    // ponytail: a remembered id set does not see an id the site adds later; re-walk the site when a group adds units
    const r = (company
      ? db.prepare("select publisher from source_listing where provider = 'zhilian' and external_id like ? and publisher like 'zhilian:%' order by fetched_at desc limit 1").get(`${company}J%`)
      : db.prepare("select publisher from source_listing where provider = 'zhilian' and content_path like ? escape '\\' and publisher like 'zhilian:%' order by fetched_at desc limit 1").get(`%-${cfg.id.replace(/[\\%_]/g, (c) => `\\${c}`)}.json`)) as { publisher: string } | undefined;
    return r ? { rootId: r.publisher.slice("zhilian:".length) } : null;
  },
  async fetch(cfg, ctx) {
    const ids = cfg.rootId ? String(cfg.rootId).split(",") : await rootIdsOf(cfg.url ?? "", ctx);
    if (!cfg.rootId) ctx.learn?.({ rootId: ids.join(",") }); // the next read needs no page that can be blocked or gone
    const root = ids.join(",");
    return pullOnce(`zhilian:${root}:${cfg.keywords?.[0] ?? ""}`, async () => {
    const out: Listing[] = [];
    const seen = new Set<string>();
    let ended = false, total = 0;
    for (let page = 1; page <= (cfg.maxPages ?? 50); page++) {
      const r: any = await ctx.fetchJson(API, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ orgNumbers: ids, jobSource: 2, pageIndex: page, pageSize: 200, keyword: cfg.keywords?.[0] ?? "" }) });
      if (r?.code !== 200) throw new Error(`SCHEMA_CHANGED: 智联：${r?.message ?? "接口返回异常"}`);
      for (const it of (r.data?.jobList ?? []) as ZhilianItem[]) {
        const l = itemToListing(it, root, cfg);
        if (l && !seen.has(l.externalId)) { seen.add(l.externalId); out.push(l); }
      }
      total = Number(r.data?.pageInfo?.totalNum ?? 0);
      ctx.log(`zhilian ${root}: page ${page} (${out.length}/${total || "?"})`);
      if (page >= (r.data?.pageInfo?.totalPage ?? 1)) { ended = true; break; }
      await ctx.sleep(400);
    }
    return ended ? out : incomplete(out, `智联 ${out.length}/${total}`);
    });
  },
};
