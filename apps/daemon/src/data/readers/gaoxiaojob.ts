import type { Listing, Source, SourceConfig, SourceContext } from "../types.js";

/**
 * 高校人才网 (gaoxiaojob.com): research institutes, labs, university teams, 事业单位 and smaller firms that never post a
 * campus drive on a hiring system (D-25). It is a reprint site: every post is 聚合, never 官方, and the original notice is
 * linked when the page names it.
 *
 * Read the way its mobile pages read themselves, no login: a column's announcement list
 * (`m.gaoxiaojob.com/home/get-announcement-list`), then per announcement its page (dates, deadline, body) and its job list
 * (`/announcement/get-job-list`, each job with the site's own id). Desktop paging needs a login; the mobile list does not.
 *
 * Each read returns the whole set still open, by a fixed rule (`stillOpen`), because a read that leaves a post out closes
 * it: a dated deadline not passed; 长期有效 / 招满 posted within 180 days; anything else posted within 90 days. The list is
 * newest first; reading stops after two pages wholly older than 180 days. Hitting the page cap before that fails the
 * read: half a set would close the other half.
 */
const M = "https://m.gaoxiaojob.com";
const W = "https://www.gaoxiaojob.com";
const UA = { "user-agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148" };
const DAY = 86400_000;
const LONG = /长期有效|长期招聘|常年|招满为止|招满即止|额满为止/;

export const columnOf = (url: string): string | null => /^https?:\/\/(?:www\.|m\.)?gaoxiaojob\.com\/column\/(\d+)\.html/.exec(url.trim())?.[1] ?? null;

/** 「10-16」 has no year: the latest such day that is not in the future. Exported for tests. */
export function dayOf(mmdd: string, today = new Date()): string | null {
  const m = /^(\d{1,2})-(\d{1,2})$/.exec(mmdd.trim());
  if (!m) return null;
  const y = today.getUTCFullYear(), mm = m[1].padStart(2, "0"), dd = m[2].padStart(2, "0");
  const d = `${y}-${mm}-${dd}`;
  return Date.parse(d) > today.getTime() + DAY ? `${y - 1}-${mm}-${dd}` : d;
}

export interface Notice { id: string; title: string; posted: string | null; deadlineText: string; closesAt: string | null; place: string; source: string; body: string }

const text = (html: string) => html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, " ").replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>/g, "\n")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/[ \t\r]+/g, " ").replace(/\n\s*/g, "\n");

/** An announcement page: what its 基本信息 block says, the body, and the original notice it was taken from. Exported for tests. */
export function parseNotice(id: string, title: string, html: string): Notice {
  const t = text(html);
  const flat = t.replace(/\s+/g, " ");
  const field = (k: string) => new RegExp(`${k}[:：]\\s*(.*?)\\s+(?:截止日期|学历要求|所属省份|工作地点|报名方式|栏目分类|需求学科|发布时间)`).exec(flat)?.[1]?.trim() ?? "";
  const posted = /发布时间[:：]\s*(\d{4}-\d{2}-\d{2})/.exec(flat)?.[1] ?? null;
  const deadlineText = field("截止日期");
  const full = /(\d{4})[-/.年](\d{1,2})[-/.月](\d{1,2})/.exec(deadlineText);
  const closesAt = full ? `${full[1]}-${full[2].padStart(2, "0")}-${full[3].padStart(2, "0")}` : null; // only a whole date is a date
  const source = /来源链接[:：]\s*(https?:\/\/\S+)/.exec(flat)?.[1] ?? "";
  const a = t.indexOf("公告详情"), b = t.indexOf("来源于网络", a);
  const body = (a >= 0 ? t.slice(a + 4, b > a ? b : a + 8000) : "").trim().slice(0, 8000);
  return { id, title, posted, deadlineText, closesAt, place: field("工作地点"), source, body };
}

/** The fixed rule for what a read returns: see the header. Exported for tests. */
export function stillOpen(n: Pick<Notice, "posted" | "closesAt" | "deadlineText">, listedOn: string | null, today = new Date()): boolean {
  if (n.closesAt) return Date.parse(`${n.closesAt}T23:59:59+08:00`) >= today.getTime();
  const on = n.posted ?? listedOn;
  if (!on) return false;
  const age = (today.getTime() - Date.parse(on)) / DAY;
  return age <= (LONG.test(n.deadlineText) ? 180 : 90);
}

export interface Job { jobId: string; jobName: string; companyName?: string; city?: string; education?: string; major?: string; amount?: string; url?: string }

/** One announcement and its jobs as listings: a job of the site's own id each; no jobs listed, the announcement itself. Exported for tests. */
export function noticeListings(n: Notice, jobs: Job[], cfg: SourceConfig): Listing[] {
  const company = (jobs.find((j) => j.companyName)?.companyName ?? "").replace(/#+$/, "").trim() || unitFrom(n.title);
  const base = {
    company, noticeUrl: `${W}/announcement/detail/${n.id}.html`, datePosted: n.posted ?? undefined,
    validThrough: n.closesAt ?? undefined, deadlineText: n.deadlineText || undefined,
    cohort: cfg.cohort, batch: n.title.slice(0, 80), // one announcement, one campaign (campaigns group by publisher|company|cohort|batch)
    publisher: "gaoxiaojob", grade: "聚合" as const, isOriginal: false,
    confidence: 0.7, // a reprint: below the 0.85–0.9 the official readers give
  };
  const intern = (s: string) => (/实习/.test(s) ? "实习" : undefined);
  const jd = [n.body, n.source ? `原公告：${n.source}` : ""].filter(Boolean).join("\n\n");
  if (!jobs.length) return [{ ...base, externalId: `ann:${n.id}`, url: base.noticeUrl, title: n.title, locations: n.place ? [n.place] : [], description: jd, kind: intern(n.title) }];
  return jobs.map((j) => ({
    ...base, externalId: `job:${j.jobId}`, url: j.url ? `${W}${j.url}` : base.noticeUrl, title: j.jobName,
    locations: j.city ? [j.city] : n.place ? [n.place] : [], description: jd, degreeReq: j.education || undefined, majorReq: j.major || undefined,
    kind: intern(`${j.jobName} ${n.title}`),
  }));
}

/** 「华中科技大学丁汉院士…团队2026年诚聘博士后」 → the unit before the first year or verb, for a notice with no job list. */
const unitFrom = (title: string) => /^(.+?)(?:\d{4}|诚聘|招聘|公开|引进|招收)/.exec(title)?.[1]?.trim() || title.slice(0, 30);

async function jobsOf(ctx: SourceContext, id: string): Promise<Job[]> {
  const out: Job[] = [];
  for (let page = 1; page <= 20; page++) {
    const d: any = await ctx.fetchJson(`${M}/announcement/get-job-list?announcementId=${id}&page=${page}`, { headers: UA });
    const list: Job[] = d?.data?.list ?? [];
    out.push(...list);
    if (!list.length || out.length >= Number(d?.data?.count ?? 0)) return out;
    await ctx.sleep(pause());
  }
  return out;
}

/** a person reading: 0.6–1.4 s between pages */
const pause = () => 600 + Math.floor(Math.random() * 800);

export const gaoxiaojob: Source = {
  id: "gaoxiaojob",
  name: "高校人才网",
  input: "www.gaoxiaojob.com/column/<栏目编号>.html（如武汉 48、武汉科研院所 509、武汉企业 511）",
  mode: "pull",
  describe: "高校人才网的一个栏目（研究院、实验室、高校团队、事业单位、企业）：读手机版公开列表和每条公告的岗位清单，只收仍有效的；转载来源，记为聚合，零 token",
  detect: (url) => !!columnOf(url),
  siteKey: (url) => `column/${columnOf(url)}`,
  async fetch(cfg, ctx) {
    const col = columnOf(cfg.url ?? "");
    if (!col) throw new Error("SCHEMA_CHANGED: 不是高校人才网的栏目链接");
    const maxPages = cfg.maxPages ?? 60;
    const today = new Date();
    const out: Listing[] = [];
    let oldPages = 0, page = 1;
    for (; page <= maxPages; page++) {
      const d: any = await ctx.fetchJson(`${M}/home/get-announcement-list?columnId=${col}&isEstablishment=0&announcementHeat=0&page=${page}`, { headers: UA });
      if (d?.code !== 200) throw new Error(`SCHEMA_CHANGED: 列表接口返回 ${d?.code ?? "?"} ${d?.msg ?? ""}`);
      const items: { id: string; title: string; refreshTime: string }[] = d?.data ?? [];
      if (!items.length) break;
      let fresh = 0;
      for (const it of items) {
        const listedOn = dayOf(it.refreshTime ?? "", today);
        if (listedOn && (today.getTime() - Date.parse(listedOn)) / DAY > 180) continue;
        fresh++;
        await ctx.sleep(pause());
        const n = parseNotice(String(it.id), it.title, await ctx.fetchText(`${W}/announcement/detail/${it.id}.html`) /* the desktop page: its 基本信息 block is what parseNotice reads */);
        if (!stillOpen(n, listedOn, today)) continue;
        await ctx.sleep(pause());
        out.push(...noticeListings(n, await jobsOf(ctx, n.id), cfg));
      }
      ctx.log(`gaoxiaojob ${col}: page ${page} ${items.length} 条，在窗口内 ${fresh}（累计 ${out.length}）`);
      oldPages = fresh ? 0 : oldPages + 1;
      if (oldPages >= 2) break;
      await ctx.sleep(pause());
    }
    if (page > maxPages) throw new Error(`TIMEOUT: 读到第 ${maxPages} 页还没读完这个栏目，这次不算（读一半会把另一半标成下架）`);
    return out;
  },
};
