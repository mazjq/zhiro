import { createHash } from "node:crypto";
import { pullOnce, type Listing, type Source, type SourceConfig, type SourceContext } from "../types.js";

/**
 * 前程无忧 campus pages (campus.51job.com/<co>/, ideal.51job.com/<co>/, xym.51job.com WeChat pages, xyz.51job.com apply
 * links). All of them sit on one employer id (a GUID), and the WeChat job page's backend lists that employer's jobs:
 * POST xym.51job.com/VueData/Jobs.ashx?func=getjobslistbyarea|getJobInfo with Token = md5(md5(GUID)) — the page's own
 * formula, in its readable bundle (verified 2026-09-30: 中粮集团2027秋招 590 jobs). Answers are JS object literals, turned
 * into JSON without eval. A campus/ideal page names the numeric ctmid; xyz's Apply.aspx?CtmID= redirects to the GUID.
 * ponytail: no deadline and no publish date in this API. jobs.51job.com / msearch sit behind a WAF challenge: not read.
 */
const GUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const md5 = (s: string) => createHash("md5").update(s, "utf8").digest("hex");

export function job51Url(url: string): boolean {
  let u: URL;
  try { u = new URL(url); } catch { return false; }
  return /^(campus|ideal|xym|xyz)\.51job\.com$/.test(u.hostname);
}

/** 51job answers `{status:'ok',data:{records:[{CjobName:'…'}]}}`: quote bare keys, turn '…' into "…". Exported for tests. */
export function literalToJson(s: string): string {
  let o = "", i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'" || c === '"') {
      let v = ""; i++;
      while (i < s.length && s[i] !== c) { if (s[i] === "\\") { const n = s[i + 1]; v += ({ n: "\n", r: "\r", t: "\t" } as Record<string, string>)[n] ?? n; i += 2; } else v += s[i++]; }
      i++; o += JSON.stringify(v);
    } else if (/[A-Za-z_$]/.test(c)) {
      let w = ""; while (i < s.length && /[\w$]/.test(s[i])) w += s[i++];
      o += /^(true|false|null)$/.test(w) ? w : JSON.stringify(w);
    } else { o += c; i++; }
  }
  return o;
}

/** Same-site .html / .js files a page names in any string literal (href, src, location.href = …), as absolute URLs. Exported for tests. */
export function siteLinks(text: string, base: string): string[] {
  const root = new URL(".", base).href, out: string[] = [];
  for (const m of text.matchAll(/["']((?:\.\/)?[\w./-]+\.(?:html?|js))(?:\?[^"']*)?["']/g)) {
    const p = new URL(m[1], base).href;
    if (p.startsWith(root) && !out.includes(p) && !/jquery|swiper|jweixin|\.min\.js/.test(p)) out.push(p);
  }
  return out;
}

async function guidOf(url: string, ctx: SourceContext): Promise<string> {
  const direct = /[?&]id=([0-9a-f-]{36})/i.exec(url) ?? /CtmID=([0-9a-f-]{36})/i.exec(url);
  if (direct) return direct[1];
  let ctmid = /ctmid=(\d+)/i.exec(url)?.[1];
  if (!ctmid) {
    // a branded site's root is often a splash page (sometimes only `location.href = "about.html"`); the ctmid sits in one of
    // its own pages or scripts (js/data.js, js/index.js, js/job.js …), so walk what each page names: scripts first, pages after
    const base = /\/$|\.html?$/.test(url) ? url : url + "/";
    const pages = [base, new URL("js/job.js", base).href, new URL("js/jobs.js", base).href];
    for (let i = 0; i < pages.length && i < 16 && !ctmid; i++) {
      const t = await ctx.fetchText(pages[i]).catch(() => "");
      ctmid = /ctmid["']?\s*[:=]\s*["']?(\d{5,})/i.exec(t)?.[1];
      for (const p of siteLinks(t, base)) if (!pages.includes(p)) p.endsWith(".js") ? pages.splice(i + 1, 0, p) : pages.push(p);
    }
  }
  if (!ctmid) throw new Error(`SCHEMA_CHANGED: 51job：页面里没找到企业编号 ${url}`);
  // the apply link redirects to the login page with the employer GUID in its query: read the Location, do not follow it
  const r = await fetch(`https://xyz.51job.com/External/Apply.aspx?CtmID=${ctmid}`, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const g = GUID.exec(r?.headers.get("location") ?? "")?.[0] ?? (await directory(ctx)).get(ctmid);
  if (!g) throw new Error(`SCHEMA_CHANGED: 51job：企业编号 ${ctmid} 没有换到招聘号`);
  return g;
}

/** xym's public employer directory (~9,300 entries, ~900 KB): ehireid (the numeric ctmid) → GUID; read once a day at most. */
let dir: { at: number; map: Map<string, string> } | null = null;
async function directory(ctx: SourceContext): Promise<Map<string, string>> {
  if (dir && Date.now() - dir.at < 86400_000) return dir.map;
  const t = await ctx.fetchText("https://xym.51job.com/jobs/jobs_ctmlist.aspx").catch(() => "");
  const map = new Map([...t.matchAll(/\{ctmid:'([0-9a-f-]{36})',mname:'[^']*',ehireid:'(\d+)'/g)].map((m) => [m[2], m[1]] as [string, string]));
  dir = { at: Date.now(), map };
  return map;
}

const details = new Map<string, any>(); // job GUID → detail, once per daemon life

/** One job (+ detail) → Listing. Exported for tests. */
export function jobToListing(j: any, d: any, cfg: SourceConfig, employer: string): Listing | null {
  if (!j?.JobID || !j.CjobName) return null;
  const units = String(d?.OrgName ?? "").split("/").filter(Boolean);
  const jd = String(d?.CJobInfo ?? "").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\n{3,}/g, "\n\n").trim();
  return {
    externalId: String(j.JobID),
    url: d?.Url ? `https:${String(d.Url).replace(/^https?:/, "")}` : `https://xym.51job.com/wechat/vuectmjobs/#/index?id=${j.JobID}`,
    title: String(j.CjobName).trim(),
    company: units[1] || units[0] || employer || cfg.name || "51job",
    orgUnit: units.slice(2).join("/") || undefined,
    locations: j.JobAreaname ? [String(j.JobAreaname)] : [],
    description: jd || undefined,
    degreeReq: j.DegreeFrom || d?.DegreeName || undefined,
    cohort: cfg.cohort ?? "2027届",
    batch: cfg.batch ?? "校招",
    kind: cfg.kind ?? (/实习/.test(String(j.Term ?? "")) ? "实习" : "校招"),
    publisher: "job51",
    grade: "官方",
    isOriginal: true,
    confidence: 0.85,
  };
}

export const job51: Source = {
  id: "job51",
  name: "前程无忧", input: "campus / ideal / xym / xyz.51job.com（无截止日期）",
  mode: "pull",
  describe: "前程无忧校招页（campus / ideal / xym / xyz.51job.com）：按雇主号走微信职位页的接口，列表 + 岗位详情，零 token；无截止日期",
  detect: job51Url,
  siteKey: (url) => GUID.exec(url)?.[0] ?? /ctmid=(\d+)/i.exec(url)?.[1] ?? new URL(url).host + new URL(url).pathname.split("/").slice(0, 2).join("/"),
  async fetch(cfg, ctx) {
    const id = await guidOf(cfg.url ?? "", ctx);
    const token = md5(md5(id));
    const api = async (func: string, body: Record<string, string | number>) => {
      const t = await ctx.fetchText(`https://xym.51job.com/VueData/Jobs.ashx?func=${func}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(Object.entries(body).map(([k, v]) => [k, String(v)])).toString() });
      const r = JSON.parse(literalToJson(t));
      if (r?.status !== "ok" || typeof r.data !== "object") throw new Error(`SCHEMA_CHANGED: 51job ${func}：${t.slice(0, 80)}`);
      await ctx.sleep(200);
      return r.data;
    };
    return pullOnce(`job51:${id}`, async () => {
      const info = await api("getctminfo", { CtmID: id, Token: token }).catch(() => ({}));
      const jobs: any[] = [];
      for (let p = 1; p <= (cfg.maxPages ?? 200); p++) {
        const d = await api("getjobslistbyarea", { CtmID: id, PageIndex: p, areaname: "", keyword: "", funtypecode: "", token });
        jobs.push(...(d.records ?? []));
        if (p >= Number(d.pagecount ?? 1)) break;
      }
      ctx.log(`job51 ${info?.ShowName ?? id}: ${jobs.length} jobs`);
      const out: Listing[] = [];
      for (const j of jobs) {
        if (!details.has(j.JobID)) details.set(j.JobID, await api("getJobInfo", { CtmID: id, JobID: j.JobID, Token: token }).catch(() => null));
        const l = jobToListing(j, details.get(j.JobID), cfg, String(info?.ShowName ?? "").replace(/20\d\d.*$/, ""));
        if (l) out.push(l);
      }
      return out;
    });
  },
};
