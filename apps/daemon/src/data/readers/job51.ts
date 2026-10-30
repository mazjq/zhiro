import { createHash } from "node:crypto";
import { incomplete, pullOnce, type Listing, type Source, type SourceConfig, type SourceContext } from "../types.js";

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

/**
 * Same-site .html / .js files a page names: in any string literal (href, src, location.href = …), in an unquoted attribute
 * (a built app: `<script src=js/main.143a.bundle.js?5d98>`), and the lazy chunks a webpack runtime names as
 * `"js/"+(…)+"."+{670:"9e7f…",…}[e]+".chunk.js"` (电连's ctmid sits in chunk 670). Absolute URLs. Exported for tests.
 */
export function siteLinks(text: string, base: string): string[] {
  const root = new URL(".", base).href, out: string[] = [];
  const add = (rel: string) => { const p = new URL(rel, base).href; if (p.startsWith(root) && !out.includes(p) && !/jquery|swiper|jweixin|\.min\.js|\/vendor\./.test(p)) out.push(p); };
  for (const m of text.matchAll(/(?:["']|\b(?:src|href)=)((?:\.\/)?\w[\w./-]*\.(?:html?|js))(?:\?[^"'\s>]*)?(?=["'\s>])/g)) add(m[1]);
  for (const m of text.matchAll(/"([\w/]*)"\+(?:\([^)]*\)|\w+)\+"\."\+\{((?:\d+:"[0-9a-f]+",?)+)\}\[\w+\]\+"(\.chunk\.js)"/g))
    for (const [, id, hash] of m[2].matchAll(/(\d+):"([0-9a-f]+)"/g)) add(`${m[1]}${id}.${hash}${m[3]}`);
  return out;
}

/** Another hiring system a 51job page sends its applicants to (斯伦贝谢 → slb.tupu360.com, 国网信通 → zhaopin.sgcc.com.cn). */
const ELSEWHERE = /https?:\/\/[\w.-]*(?:tupu360\.com|mokahr\.com|zhiye\.com|hotjob\.cn|wintalent\.cn|zhaopin\.sgcc\.com\.cn|jobs\.feishu\.cn|iguopin\.com|zhaopin\.com)\/[^"'\s<>]*/i;

/** The employer the page is about: the GUID xym's API answers for, or only the numeric ctmid coapi answers for. */
async function employerOf(cfg: SourceConfig, ctx: SourceContext): Promise<{ guid: string } | { ctmid: string }> {
  const url = cfg.url ?? "";
  const direct = /[?&]id=([0-9a-f-]{36})/i.exec(url) ?? /CtmID=([0-9a-f-]{36})/i.exec(url);
  if (direct) return { guid: direct[1] };
  let ctmid = /ctmid=(\d+)/i.exec(url)?.[1] ?? (cfg.ctmid ? String(cfg.ctmid) : undefined), elsewhere: string | undefined;
  if (!ctmid) {
    // a branded site's root is often a splash page (sometimes only `location.href = "about.html"`); the ctmid sits in one of
    // its own pages or scripts (js/data.js, js/index.js, js/job.js …), so walk what each page names: scripts first, pages after.
    // A built bundle also names its source modules (./core/store/defaultStore.js, none of them served): from one, only
    // other built files are followed (电连: 20 such paths used up the walk before the chunk with the ctmid)
    const base = /\/$|\.html?$/.test(url) ? url : url + "/";
    const built = /\.[0-9a-f]{8,}\.(?:bundle|chunk)\.js$/;
    const pages = [base, new URL("js/job.js", base).href, new URL("js/jobs.js", base).href];
    for (let i = 0; i < pages.length && i < 24 && !ctmid; i++) {
      const t = await ctx.fetchText(pages[i]).catch(() => "");
      ctmid = /ctmid["']?\s*[:=]\s*["']?(\d{5,})/i.exec(t)?.[1];
      elsewhere ??= ELSEWHERE.exec(t)?.[0];
      for (const p of siteLinks(t, base)) if (!pages.includes(p) && (!built.test(pages[i]) || built.test(p))) p.endsWith(".js") ? pages.splice(i + 1, 0, p) : pages.push(p);
    }
    if (ctmid) ctx.learn?.({ ctmid }); // the next read needs no walk
  }
  if (!ctmid && elsewhere) throw new Error(`ELSEWHERE: 51job：这里只是宣传页，岗位和投递在 ${elsewhere}`);
  if (!ctmid) throw new Error(`SCHEMA_CHANGED: 51job：页面里没找到企业编号 ${url}`);
  // the apply link redirects to the login page with the employer GUID in its query: read the Location, do not follow it
  const r = await fetch(`https://xyz.51job.com/External/Apply.aspx?CtmID=${ctmid}`, { redirect: "manual", headers: { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/128.0 Safari/537.36" }, signal: AbortSignal.timeout(20_000) }).catch(() => null);
  const g = GUID.exec(r?.headers.get("location") ?? "")?.[0] ?? (await directory(ctx)).get(ctmid);
  return g ? { guid: g } : { ctmid };
}

/**
 * The other API the campus pages call (js.51jobcdn.com/in/js/2018/coapi/coapi.min.js): job_list.php / job_detail.php by
 * ctmid alone, each request signed md5("coapi" + params + 15 characters of the page's public key from an offset 1–40).
 * For an employer whose ctmid has no GUID (西北电力设计院 2763869: verified 2026-10-30, 63 jobs, with publish dates).
 */
const COAPI_KEY = "tuD&#mheJQBlgy&Sm300l8xK^X4NzFYBcrN8@YLCret$fv1AZbtujg*KN^$YnUkh";
async function coapi(ctx: SourceContext, path: string, params: Record<string, string>): Promise<any> {
  const k = 7, s = JSON.stringify(params);
  const t = await ctx.fetchText(`https://coapi.51job.com/${path}?${new URLSearchParams({ key: String(k), sign: md5("coapi" + s + COAPI_KEY.slice(k, k + 15)), params: s })}`);
  const r = JSON.parse(t.slice(t.indexOf("(") + 1, t.lastIndexOf(")")));
  if (String(r?.status) !== "1") throw new Error(`SCHEMA_CHANGED: 51job coapi ${path}：${String(r?.message ?? t).slice(0, 80)}`);
  await ctx.sleep(200);
  return r.resultbody;
}

const plain = (html: unknown) => String(html ?? "").replace(/<br\s*\/?>|<\/p>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** One coapi job (+ detail) → Listing. The job name says 社会招聘 when the site mixes both (西北电力: 43 of 63). Exported for tests. */
export function coapiToListing(j: any, d: any, cfg: SourceConfig): Listing | null {
  if (!j?.jobid || !j.jobname) return null;
  const title = String(j.jobname).trim();
  const kind = /社会招聘|社招/.test(title) ? "社招" : /实习/.test(title + (j.term ?? "")) ? "实习" : "校招";
  return {
    externalId: String(j.jobid),
    url: /^https?:\/\//.test(d?.jumpurl ?? "") ? d.jumpurl : `https://jobs.51job.com/all/${j.jobid}.html`,
    title,
    company: String(j.coname ?? "").trim() || cfg.name || "51job",
    orgUnit: j.divname || undefined,
    locations: j.jobareaname ? [String(j.jobareaname)] : [],
    description: plain(d?.jobinfo) || undefined,
    datePosted: /^\d{4}-\d\d-\d\d/.test(j.issuedate ?? "") ? String(j.issuedate).slice(0, 10) : undefined,
    degreeReq: j.degreefrom || undefined,
    majorReq: d?.major || undefined,
    cohort: cfg.cohort ?? "2027届",
    batch: cfg.batch ?? (kind === "社招" ? "社招" : "校招"),
    kind: cfg.kind ?? kind,
    publisher: "job51",
    grade: "官方",
    isOriginal: true,
    confidence: 0.85,
  };
}

async function viaCoapi(ctmid: string, cfg: SourceConfig, ctx: SourceContext): Promise<Listing[]> {
  const PAGE = 1000, jobs: any[] = []; // the page's own size; the API allows 2,000 a page
  let total = 0;
  for (let p = 1; p <= (cfg.maxPages ?? 100); p++) {
    const b = await coapi(ctx, "job_list.php", { ctmid, pagesize: String(PAGE), pagenum: String(p) });
    const page = Object.values(b?.joblist ?? {});
    jobs.push(...page);
    total = Number(b?.totalnum ?? 0);
    if (page.length < PAGE || jobs.length >= total) break;
  }
  ctx.log(`job51 coapi ${ctmid}: ${jobs.length}/${total} jobs`);
  const out: Listing[] = [];
  for (const j of jobs) {
    const key = `coapi:${j.jobid}`;
    if (!details.has(key)) details.set(key, await coapi(ctx, "job_detail.php", { jobid: String(j.jobid) }).catch(() => null));
    const l = coapiToListing(j, details.get(key), cfg);
    if (l) out.push(l);
  }
  return jobs.length < total ? incomplete(out, `51job ${jobs.length}/${total}`) : out;
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

const details = new Map<string, any>(); // job GUID (coapi: "coapi:" + jobid) → detail, once per daemon life

/** One job (+ detail) → Listing. Exported for tests. */
export function jobToListing(j: any, d: any, cfg: SourceConfig, employer: string): Listing | null {
  if (!j?.JobID || !j.CjobName) return null;
  const units = String(d?.OrgName ?? "").split("/").filter(Boolean);
  const jd = plain(d?.CJobInfo);
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
    const who = await employerOf(cfg, ctx);
    if ("ctmid" in who) return pullOnce(`job51:${who.ctmid}`, () => viaCoapi(who.ctmid, cfg, ctx));
    const id = who.guid;
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
