import { incomplete, pullOnce, type Listing, type Source, type SourceConfig, type SourceContext } from "../types.js";

/**
 * 图谱 (tupu360.com): the hiring system of many foreign firms in China (西门子, 康明斯, 礼来, IQVIA, 辉瑞, 舍弗勒 …).
 * Read the way the desktop career site reads itself (verified 2026-10-30): careersite.tupu360.com/<tenant>/position/index
 * names the tenant's own tabs (校招职位, 实习生职位, 管理培训生项目 …, each a `recruitmentType`); POST
 * /<tenant>/position/nextPageList with recruitmentType, offset, max answers that tab's list as an HTML fragment, empty
 * past the end; each post's page /<tenant>/position/detail?positionId= holds the JD. No login, no signing.
 * Tenants' list templates differ (西门子 cards, IQVIA table rows), so a list only gives ids, titles and dates; place
 * and JD come from the detail page.
 * A <name>.tupu360.com link is the WeChat site (a desktop browser is sent to a 「扫码访问」 page). careersite may have a
 * tenant of the same name, but a name is not a company: siemens.tupu360.com is 西门子医疗, careersite's siemens is 西门子
 * (2026-10-30, by the posts each lists). A post id belongs to one tenant (another tenant's path does not show it), so a
 * WeChat link naming a post is read on careersite when that post opens there, and the subscription keeps the careersite
 * link. One without a post id is not read: the careersite candidate is named for checking. careersite answering
 * 「该网站已停用」 = WeChat only.
 * ponytail: no deadline anywhere on the site; details cached once per daemon life, like job51.
 */
const BASE = "https://careersite.tupu360.com";
const PAGE = 50, MAX_PAGES = 40;
const NOT_TENANT = new Set(["www", "careersite", "cdn", "static", "wxtemp"]);
const POST_ID = /(?:pid="|positionId=)([0-9a-f]{24})/g;

/** The tenant a link belongs to: careersite.tupu360.com/<tenant>/… or <tenant>.tupu360.com/… (pageQrCode links included). */
export function tupuTenant(url: string): { tenant: string; wechat: boolean; post?: string } | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const m = /^([\w-]+)\.tupu360\.com$/.exec(u.hostname);
  if (!m) return null;
  if (m[1] === "careersite") { const t = u.pathname.split("/")[1]; return t && /^[\w-]+$/.test(t) && t !== "csresources" ? { tenant: t, wechat: false } : null; }
  if (NOT_TENANT.has(m[1]) || m[1].startsWith("cdn")) return null;
  const post = /\/position\/detail\/([0-9a-f]{24})/.exec(u.pathname)?.[1] ?? /^([0-9a-f]{24})$/.exec(u.searchParams.get("positionId") ?? u.searchParams.get("id") ?? "")?.[1];
  return { tenant: m[1], wechat: true, ...(post ? { post } : {}) };
}

const decode = (s: string) => s.replace(/&nbsp;/g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");
const texts = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "").split(/<[^>]*>/).map((s) => decode(s).trim()).filter(Boolean);

/** The tabs a tenant lists, without 社招 and 校园大使. Exported for tests. */
export function tabsOf(html: string): { type: string; label: string }[] {
  const out = new Map<string, string>();
  for (const m of html.replace(/<script[\s\S]*?<\/script>/g, "").matchAll(/recruitmentType=([A-Z_]+)["'][^>]*>([^<]*)/g)) {
    const label = decode(m[2]).trim();
    if (!/SOCIAL|AMBASSADOR/.test(m[1]) && !/社招|社会招聘|校园大使/.test(label) && !out.has(m[1])) out.set(m[1], label);
  }
  return [...out].map(([type, label]) => ({ type, label }));
}

export interface TupuItem { id: string; title: string; date?: string }

/** One list fragment → its posts (whichever template the tenant uses). Exported for tests. */
export function parseList(html: string): TupuItem[] {
  // a post's id shows up again on its apply button: cut at each id's first sight
  const hits = [...html.matchAll(POST_ID)].map((m) => ({ id: m[1], at: html.lastIndexOf("<", m.index) })).filter((h, i, a) => a.findIndex((x) => x.id === h.id) === i);
  const out: TupuItem[] = [];
  hits.forEach((h, i) => {
    const chunk = html.slice(h.at, hits[i + 1]?.at ?? undefined);
    const title = texts(chunk)[0];
    if (title) out.push({ id: h.id, title, date: /20\d\d-\d\d-\d\d/.exec(chunk)?.[0] });
  });
  return out;
}

/** The inner HTML of the first `<div class="<cls>…">`, its nested divs balanced. */
function divInner(html: string, cls: string): string | undefined {
  const start = html.search(new RegExp(`<div[^>]*class="${cls}[\\s"]`));
  if (start < 0) return undefined;
  const open = html.indexOf(">", start) + 1;
  let depth = 1;
  const tag = /<(\/?)div\b[^>]*>/g;
  tag.lastIndex = open;
  for (let m = tag.exec(html); m; m = tag.exec(html)) if ((depth += m[1] ? -1 : 1) === 0) return html.slice(open, m.index);
  return undefined;
}

/** A post's page → its JD, place and date. Exported for tests. */
export function parseDetail(html: string): { description?: string; place?: string; date?: string } {
  const body = divInner(html, "position-description");
  const description = body?.replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, "\n").replace(/<[^>]+>/g, "").split("\n").map((s) => decode(s).trim()).filter(Boolean).join("\n");
  const all = texts(html), flat = all.join(" | ");
  // labelled (工作地点 / 工作城市), or some tenants' header line right under the share links (辉瑞: 「上海-静安区」)
  const head = all[all.indexOf("复制链接") + 1] ?? "";
  return {
    description: description || undefined,
    place: /(?:工作地点|工作城市)[：:]\s*(?:\|\s*)?([^|]+)/.exec(flat)?.[1]?.trim() || (all.includes("复制链接") && head.length <= 20 && !/[。；;，,：:]/.test(head) && !description?.startsWith(head) ? head : undefined),
    date: /(?:发布时间|发布于)[：:]?\s*(?:\|\s*)?(20\d\d-\d\d-\d\d)/.exec(flat)?.[1],
  };
}

const details = new Map<string, ReturnType<typeof parseDetail>>(); // post id → detail, once per daemon life

/** One post → Listing. Exported for tests. */
export function toListing(it: TupuItem, d: ReturnType<typeof parseDetail> | undefined, tab: { type: string; label: string }, tenant: string, cfg: SourceConfig): Listing {
  const date = d?.date ?? it.date;
  return {
    externalId: it.id,
    url: `${BASE}/${tenant}/position/detail?positionId=${it.id}&recruitmentType=${tab.type}`,
    title: it.title,
    company: cfg.name || tenant,
    locations: d?.place ? d.place.split(/[,，、/]/).map((s) => s.trim()).filter(Boolean) : [],
    description: d?.description,
    datePosted: date ? `${date}T00:00:00+08:00` : undefined,
    cohort: cfg.cohort,
    batch: cfg.batch ?? "校招",
    kind: cfg.kind ?? (/实习/.test(tab.label) ? "实习" : "校招"),
    publisher: `tupu360:${tenant}`,
    grade: "官方",
    isOriginal: true,
    confidence: 0.9,
  };
}

export const tupu360: Source = {
  id: "tupu360",
  name: "图谱", input: "careersite.tupu360.com/<公司>/… 或 <公司>.tupu360.com 的链接",
  mode: "pull",
  describe: "图谱招聘站（careersite.tupu360.com，外企多用）：按公司读校招、实习等各栏目的列表和岗位详情，零 token；无截止日期；只有微信版的公司读不了",
  detect: (url) => !!tupuTenant(url),
  siteKey: (url) => { const t = tupuTenant(url)!; return t.wechat ? `wx:${t.tenant}` : t.tenant; }, // same name ≠ same company
  async fetch(cfg, ctx: SourceContext) {
    const t = tupuTenant(cfg.url ?? "");
    if (!t) throw new Error(`BAD_URL: 图谱：认不出公司 ${cfg.url}`);
    const { tenant } = t;
    // the identity check is outside the shared pull: a careersite read of the same name must not answer a WeChat link
    const index = await ctx.fetchText(`${BASE}/${tenant}/position/index?recruitmentType=CAMPUSRECRUITMENT`);
    const home = `${BASE}/${tenant}/position/index`;
    if (/该网站已停用/.test(index)) {
      throw new Error(t.wechat
        ? `BLOCKED: 图谱：${tenant}.tupu360.com 只给手机微信打开，电脑版站点已停用 ${cfg.url}`
        : `SITE_GONE: 图谱：careersite 上的 ${tenant} 站已停用 ${cfg.url}`);
    }
    if (t.wechat) {
      const own = t.post && /class="position-description/.test(await ctx.fetchText(`${BASE}/${tenant}/position/detail?positionId=${t.post}`).catch(() => ""));
      if (!own) throw new Error(`LINK_STALE: 图谱：${tenant}.tupu360.com 是微信版，电脑上读不了；careersite 上有同名的 ${home}，同名不一定是同一家，核实后把订阅换成它 ${cfg.url}`);
      ctx.learn?.({ url: home, widenedFrom: cfg.url }); // the link's own post opens there: the same tenant
    }
    return pullOnce(`tupu360:${tenant}`, async () => {
      const tabs = tabsOf(index);
      if (!tabs.length) throw new Error(`SCHEMA_CHANGED: 图谱：${tenant} 的页面里没找到招聘栏目 ${cfg.url}`);
      const out: Listing[] = [];
      const seen = new Set<string>();
      let cut = "";
      for (const tab of tabs) {
        let page = 0;
        for (; page < (cfg.maxPages ?? MAX_PAGES); page++) {
          const html = await ctx.fetchText(`${BASE}/${tenant}/position/nextPageList`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ recruitmentType: tab.type, offset: String(page * PAGE), max: String(PAGE) }).toString() });
          const items = parseList(html).filter((i) => !seen.has(i.id));
          if (!items.length) break;
          for (const it of items) {
            seen.add(it.id);
            if (!details.has(it.id)) {
              const jd = await ctx.fetchText(`${BASE}/${tenant}/position/detail?positionId=${it.id}&recruitmentType=${tab.type}`).catch(() => "");
              if (jd) details.set(it.id, parseDetail(jd)); // a failed page is asked again next read
              await ctx.sleep(200);
            }
            out.push(toListing(it, details.get(it.id), tab, tenant, cfg));
          }
          await ctx.sleep(300);
        }
        if (page >= (cfg.maxPages ?? MAX_PAGES)) cut = `${tab.label} 读满 ${page} 页`;
      }
      ctx.log(`tupu360 ${tenant}: ${out.length} posts (${tabs.map((x) => x.label).join("、")})`);
      return cut ? incomplete(out, `图谱 ${cut}，可能还有`) : out;
    });
  },
};
