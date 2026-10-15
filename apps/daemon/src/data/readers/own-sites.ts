import type { Listing, Source, SourceConfig, SourceContext } from "../types.js";

/**
 * Career sites a company built for itself — one site, one company, its own JSON behind the list page. Read the way the
 * page reads itself: no login, no cookies of the user's, a pause between pages. Neither site states a deadline per post;
 * their posts' deadline is whatever another source says, shown as 待核实 (ADR-041).
 */
const clean = (s?: string | null) => (s ?? "").replace(/\r/g, "").replace(/\n{3,}/g, "\n\n").trim();
const degreeIn = (s: string) => /(博士|硕士及以上|硕士|本科及以上|本科|大专)/.exec(s)?.[1];
const JSON_POST = { method: "POST", headers: { "content-type": "application/json", accept: "application/json" } };

// ---------- 快手 campus.kuaishou.cn (verified 2026-10-11: 2027应届生 + 2027实习生 = 506 posts) ----------
const KS = "https://campus.kuaishou.cn/recruit/campus/e/api/v1";
export interface KsPost { id: number; name: string; description?: string; positionDemand?: string; positionNatureCode?: string; recruitSubProjectCode?: string; releaseTime?: string; workLocationDicts?: { name: string }[] | null }

export function ksListing(p: KsPost, projects: Map<string, string>, cfg: SourceConfig): Listing {
  const desc = [clean(p.description) && `岗位职责\n${clean(p.description)}`, clean(p.positionDemand) && `任职要求\n${clean(p.positionDemand)}`].filter(Boolean).join("\n\n");
  const batch = projects.get(p.recruitSubProjectCode ?? "") ?? "校招", intern = p.positionNatureCode === "intern" || /实习/.test(batch);
  return {
    externalId: String(p.id), url: `https://campus.kuaishou.cn/#/campus/job-info/${p.id}`, title: clean(p.name), company: cfg.name || "快手",
    locations: (p.workLocationDicts ?? []).map((w) => w.name).filter(Boolean), description: desc, degreeReq: degreeIn(desc),
    datePosted: p.releaseTime ? new Date(p.releaseTime.replace(" ", "T") + "+08:00").toISOString() : undefined,
    cohort: cfg.cohort ?? (/(\d{4})/.exec(batch)?.[1] ? `${/(\d{4})/.exec(batch)![1]}届` : undefined), batch, kind: cfg.kind ?? (intern ? "实习" : "校招"),
    publisher: "kuaishou", grade: "官方", isOriginal: true, confidence: 0.9, raw: p,
  };
}

export const kuaishou: Source = {
  id: "kuaishou",
  name: "快手校招", input: "campus.kuaishou.cn",
  mode: "pull",
  describe: "快手校招官网（campus.kuaishou.cn）：当届应届生与实习生项目的全部岗位",
  detect: (url) => /^https:\/\/campus\.kuaishou\.cn(\/|$)/i.test(url),
  siteKey: () => "campus.kuaishou.cn",
  async fetch(cfg, ctx: SourceContext) {
    const dict: any = await ctx.fetchJson(`${KS}/dictionary/batch?types=recruitSubProject`);
    const all: { code: string; name: string }[] = dict?.result?.recruitSubProject ?? [];
    if (dict?.code !== 0 || !all.length) throw new Error("SCHEMA_CHANGED: 快手校招没返回招聘项目列表");
    // the dictionary keeps every year since 2020; this year's are the ones named after the cohort
    const year = /(\d{4})/.exec(cfg.cohort ?? "")?.[1] ?? String(new Date().getFullYear() + (new Date().getMonth() >= 6 ? 1 : 0));
    const live = all.filter((x) => x.name.includes(year));
    if (!live.length) throw new Error(`ZERO_POSTS: 快手校招还没有 ${year} 届的招聘项目`);
    const projects = new Map(all.map((x) => [x.code, x.name]));
    const out: Listing[] = [];
    for (let page = 1; page <= (cfg.maxPages ?? 20); page++) {
      const res: any = await ctx.fetchJson(`${KS}/open/positions/simple`, { ...JSON_POST, body: JSON.stringify({ recruitSubProjectCodes: live.map((x) => x.code), pageSize: 100, pageNum: page }) });
      if (res?.code !== 0 || !Array.isArray(res.result?.list)) throw new Error(`SCHEMA_CHANGED: 快手校招岗位接口返回异常（${res?.message ?? "无 list"}）`);
      out.push(...(res.result.list as KsPost[]).map((p) => ksListing(p, projects, cfg)));
      ctx.log(`kuaishou: page ${page} (${out.length}/${res.result.total})`);
      if (res.result.list.length < 100 || out.length >= res.result.total) break;
      await ctx.sleep(400);
    }
    return out;
  },
};

// ---------- 小红书 job.xiaohongshu.com/campus (verified 2026-10-11: 465 campus posts) ----------
const XHS = "https://job.xiaohongshu.com/websiterecruit/position/pageQueryPosition";
export interface XhsPost { positionId: number; positionName: string; workplace?: string | null; publishTime?: string | null; recruitStatus?: string; duty?: string | null; qualification?: string | null; jobProjectName?: string | null; jobType?: string | null }

export function xhsListing(p: XhsPost, cfg: SourceConfig): Listing {
  const desc = [clean(p.duty) && `岗位职责\n${clean(p.duty)}`, clean(p.qualification) && `任职要求\n${clean(p.qualification)}`].filter(Boolean).join("\n\n");
  const batch = p.jobProjectName && p.jobProjectName !== "其他项目" ? p.jobProjectName : /实习/.test(p.positionName) ? "实习" : "校招";
  return {
    externalId: String(p.positionId), url: `https://job.xiaohongshu.com/campus/position/${p.positionId}`, title: clean(p.positionName), company: cfg.name || "小红书",
    orgUnit: p.jobType || undefined, locations: (p.workplace ?? "").split(/[，,、]/).map((s) => s.trim().replace(/市$/, "")).filter(Boolean), description: desc, degreeReq: degreeIn(desc),
    datePosted: p.publishTime ? new Date(p.publishTime + "T00:00:00+08:00").toISOString() : undefined,
    cohort: cfg.cohort ?? (/(\d{4})/.exec(batch)?.[1] ? `${/(\d{4})/.exec(batch)![1]}届` : undefined), batch, kind: cfg.kind ?? (/实习/.test(p.positionName + batch) ? "实习" : "校招"),
    publisher: "xiaohongshu", grade: "官方", isOriginal: true, confidence: 0.9, raw: p,
  };
}

export const xiaohongshu: Source = {
  id: "xiaohongshu",
  name: "小红书校招", input: "job.xiaohongshu.com/campus",
  mode: "pull",
  describe: "小红书校招官网（job.xiaohongshu.com/campus）：校园招聘、REDstar 与实习的全部岗位",
  detect: (url) => /^https:\/\/job\.xiaohongshu\.com\/campus(\/|$|\?)/i.test(url),
  siteKey: () => "job.xiaohongshu.com/campus",
  async fetch(cfg, ctx: SourceContext) {
    const out: Listing[] = [];
    for (let page = 1; page <= (cfg.maxPages ?? 20); page++) {
      const res: any = await ctx.fetchJson(XHS, { method: "POST", headers: { ...JSON_POST.headers, origin: "https://job.xiaohongshu.com", referer: "https://job.xiaohongshu.com/campus/position" }, body: JSON.stringify({ positionName: "", pageNum: page, pageSize: 50, recruitType: "campus" }) });
      if (!Array.isArray(res?.data?.list)) throw new Error(`SCHEMA_CHANGED: 小红书校招岗位接口返回异常（${res?.alertMsg ?? "无 list"}）`);
      out.push(...(res.data.list as XhsPost[]).filter((p) => !p.recruitStatus || p.recruitStatus === "in_recruitment").map((p) => xhsListing(p, cfg)));
      ctx.log(`xiaohongshu: page ${page}/${res.data.totalPage} (${out.length}/${res.data.total})`);
      if (page >= (res.data.totalPage ?? 1) || !res.data.list.length) break;
      await ctx.sleep(400);
    }
    return out;
  },
};
