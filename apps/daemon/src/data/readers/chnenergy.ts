import type { Listing, Source, SourceContext } from "../types.js";

/**
 * 国家能源集团招聘 (zhaopin.chnenergy.com.cn), the group's own site: server-rendered HTML, no anti-bot (verified
 * 2026-09-29: the 2027 统招 announcement alone lists 2,413 posts). The whole site is one subscription: every current
 * campus announcement (统招, 管培生, 专项, 博士后) → its station list, 10 rows a page, each row = title, category,
 * department, full major list, degree, city, headcount. Deadline and JD live on each post's own page; one detail page per
 * announcement gives the (announcement-wide) deadline. ponytail: no per-post JD — 2,400 extra requests a day; majors
 * and category are what matching needs. The posts belong to the group, the department is the unit.
 */
const BASE = "https://zhaopin.chnenergy.com.cn";
const FORM = { "content-type": "application/x-www-form-urlencoded" };
const CAMPUS = /毕业生|校园|校招|管培|专项|博士后|应届/;
const strip = (s: string) => s.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim();

/** Announcement list page → [{id, title, date}]. Exported for tests. */
export function parseAnnouncements(html: string) {
  return [...html.matchAll(/showgg\?id=([\w-]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(\d{4})年(\d{2})月(\d{2})日/g)].map((m) => ({ id: m[1], title: strip(m[2]), date: `${m[3]}-${m[4]}-${m[5]}` }));
}

/** Station list page → rows and the page count. Exported for tests. */
export function parseStations(html: string) {
  const pages = Number(/共<b>\d+<\/b>条，共<b>(\d+)<\/b>页/.exec(html)?.[1] ?? 0);
  const rows = [...html.matchAll(/showgw\?id=([\w-]+)"[^>]*title="([^"]*)"[\s\S]*?<small>([^<]*)<\/small>[\s\S]*?<p class="list-group-item-text">([\s\S]*?)<\/p>/g)].map((m) => {
    const [unit, major, degree, city, headcount] = strip(m[4].replace(/<span title="([^"]*)">[^<]*<\/span>/g, "$1")).split(/\s*\|\s*/);
    return { id: m[1], title: strip(m[2]), category: strip(m[3]), unit: unit ?? "", major: major ?? "", degree: degree ?? "", city: city ?? "", headcount: headcount ?? "" };
  });
  return { pages, rows };
}

/** ~250 requests a run: one dropped connection must not throw the whole crawl away (seen 2026-09-29, "fetch failed" at 142 s). */
async function retry<T>(ctx: SourceContext, f: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) { try { return await f(); } catch (e) { if (i >= 3) throw e; await ctx.sleep(2000 * (i + 1)); } }
}
async function post(ctx: SourceContext, path: string, body: Record<string, string>) {
  return retry(ctx, () => ctx.fetchText(BASE + path, { method: "POST", headers: FORM, body: new URLSearchParams(body).toString() }));
}

export const chnenergy: Source = {
  id: "chnenergy",
  name: "国家能源集团招聘网", input: "zhaopin.chnenergy.com.cn 任一页面（整站校招公告）", notices: true,
  mode: "pull",
  describe: "国家能源集团招聘网（zhaopin.chnenergy.com.cn）：整站当前校招公告（统招、管培生、专项、博士后）的全部岗位，零 token",
  detect: (url) => /^https?:\/\/zhaopin\.chnenergy\.com\.cn/i.test(url),
  siteKey: () => "zhaopin.chnenergy.com.cn",
  async fetch(cfg, ctx) {
    const anns: { id: string; title: string; date: string }[] = [];
    for (let p = 0; p < 5; p++) {
      const got = parseAnnouncements(await post(ctx, "/annc/annclist", { pagenum: String(p), ggtype: "1" }));
      anns.push(...got.filter((a) => !anns.some((x) => x.id === a.id)));
      if (got.length < 10) break;
      await ctx.sleep(300);
    }
    const year = Number((cfg.cohort ?? "2027").replace(/\D/g, "").slice(0, 4)) || 2027;
    const campus = anns.filter((a) => CAMPUS.test(a.title) && !/社会招聘/.test(a.title) && (a.title.includes(String(year)) || a.date >= `${year - 1}-07-01`));
    const out: Listing[] = [];
    for (const a of campus) {
      let deadline: string | undefined;
      for (let page = 0, pages = 1; page < pages && page < (cfg.maxPages ?? 400); page++) {
        const r = parseStations(await post(ctx, "/annc/showggStationList", { id: a.id, pagenum: String(page) }));
        pages = r.pages;
        if (!deadline && r.rows[0]) {
          const d = /截止时间：<strong>(\d{4})年(\d{2})月(\d{2})日/.exec(await retry(ctx, () => ctx.fetchText(`${BASE}/annc/showgw?id=${r.rows[0].id}`)));
          deadline = d ? `${d[1]}-${d[2]}-${d[3]}` : "";
          // the site can hang last year's station list under this year's announcement (2027 西藏青海新疆专项, published
          // 2026-09-02, lists posts that closed 2025-10-13): a list that closed before its announcement was published is not this one
          if (deadline && deadline < a.date) { ctx.log(`chnenergy ${a.title.slice(0, 24)}: 岗位列表截止 ${deadline} 早于公告发布 ${a.date}，判为旧列表，跳过`); break; }
        }
        for (const s of r.rows) out.push({
          // one title is hired by dozens of plants (「电气检修」): the pool keys positions by title, so the unit goes in it
          externalId: s.id, url: `${BASE}/annc/showgw?id=${s.id}`, noticeUrl: `${BASE}/annc/showgg?id=${a.id}`, title: s.unit ? `${s.title}（${s.unit}）` : s.title,
          company: "国家能源集团", orgUnit: s.unit || undefined, locations: s.city ? s.city.split(/[,，、]/).filter(Boolean) : [],
          description: `${s.category}岗；${s.unit}；专业：${s.major}；${s.degree}；${s.headcount}`, majorReq: s.major, degreeReq: s.degree,
          validThrough: deadline || undefined, cohort: cfg.cohort ?? `${year}届`, batch: a.title.replace(/^国家能源投资集团有限责任公司|^国家能源集团/, "").slice(0, 40),
          kind: /博士后/.test(a.title) ? "博士后" : /管培/.test(a.title) ? "管培生" : s.degree.startsWith("博士") ? "博士专项" : "校招",
          publisher: "chnenergy", grade: "官方", isOriginal: true, confidence: 0.9,
        });
        ctx.log(`chnenergy ${a.title.slice(0, 20)}: page ${page + 1}/${pages} (${out.length})`);
        await ctx.sleep(200);
      }
    }
    return out;
  },
};
