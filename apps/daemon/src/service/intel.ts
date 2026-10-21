import { resolveUsListing, fetchUsBasic, fetchUsFinance } from "./us-stock.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Db } from "../db.js";
import type { Services } from "../registry.js";
import { NotFound } from "./domain.js";
import { parseCsv } from "../data/index.js";
import { upsertSme } from "./sme.js";
import { resolveNeeq, fetchNeeqBasic, fetchNeeqFinance } from "./neeq.js";

/**
 * 企业情况 (ADR-029): what a candidate wants to know about an employer, from free anonymous endpoints, one row per kind
 * with its own fetched_at. Structured facts exist only for A-share listed companies (巨潮 name→code, 东财 F10 survey and
 * key indicators, 新浪 income statement, 东财 dividends, 巨潮 announcements); the 专精特新 roster is a local table the
 * user or a worker keeps. Everything else (non-listed funding, local policy, news) is the research worker's job.
 * Read-only, serial, ~300 ms between calls, a failed kind is skipped and the rest still land.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function http(url: string, init: RequestInit = {}, timeoutMs = 15_000): Promise<string> {
  const res = await fetch(url, { ...init, headers: { "user-agent": UA, ...(init.headers as Record<string, string> ?? {}) }, signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.text();
}
const json = async (url: string, init?: RequestInit) => JSON.parse(await http(url, init));
const form = (o: Record<string, string>) => new URLSearchParams(o).toString();

export type Kind = "listing" | "basic" | "finance" | "dividends" | "announcements" | "sme" | "news" | "ipo" | "irm" | "holders" | "forecast" | "sectors" | "reports";

/** 华尔街见闻 search: recent articles naming the company (works for any company, listed or not). */
export function parseNews(x: any) {
  // stored whole; the card shows six (brief)
  const items = (x?.data?.items ?? []).slice(0, 10).map((i: any) => ({ date: i.display_time ? new Date(i.display_time * 1000).toISOString().slice(0, 10) : "", title: String(i.title ?? "").replace(/<[^>]+>/g, ""), url: String(i.uri ?? "").split("?")[0] }));
  return { total: x?.data?.count ?? items.length, items };
}
export async function fetchNews(name: string) {
  return parseNews(await json(`https://api-one.wallstcn.com/apiv1/search/article?query=${encodeURIComponent(name)}&limit=10`));
}

/** 深交所 IPO 审核项目 (the only exchange feed that answered anonymously); matched by company name. */
export function pickIpo(name: string, rows: any[]) {
  const n = name.replace(/[\s（）()]/g, "");
  const hit = rows.find((r) => String(r.cmpnm ?? "").replace(/[\s（）()]/g, "").includes(n) || (r.cmpsnm && n.includes(String(r.cmpsnm))));
  return hit ? { exchange: "深交所", company: hit.cmpnm, stage: hit.prjst, board: hit.boardName ?? "", industry: hit.csrcind ?? "", region: hit.regloc ?? "", sponsor: hit.sprinsts ?? hit.sprinst ?? "", updatedAt: String(hit.updtdt ?? "").slice(0, 10), acceptedAt: String(hit.acptdt ?? "").slice(0, 10) } : null;
}
export async function fetchIpo(name: string) {
  const key = name.replace(/(股份有限公司|有限责任公司|有限公司|集团)$/g, "").slice(0, 8);
  const x = await json(`https://www.szse.cn/api/ras/projectrends/query?bizType=1&pageIndex=0&pageSize=20&keyword=${encodeURIComponent(key)}`, { headers: { referer: "https://listing.szse.cn/", "x-requested-with": "XMLHttpRequest", accept: "application/json, text/plain, */*" } });
  return { szse: pickIpo(name, x?.data ?? []), checked: ["深交所"], note: "上交所/北交所/港交所与证监会辅导公示由联网调研覆盖" };
}

/** The brief the research worker gets when the card asks for a non-listed company (docs/reports/2026-09-22-nonlisted-intel-sources.md). */
export const INTEL_QUESTION = `这家公司的经营情况（不是校招安排）。按顺序查并给出每项的来源 URL、日期与置信度：
1 身份：官网、注册地（城市/区）、统一社会信用代码（官网或招聘页常有）。
2 IPO 进度：深交所/北交所/上交所审核项目、港交所申请、各证监局辅导备案公示；输出 阶段(无/辅导备案/已受理/问询/过会/注册/港股申请)、交易所、保荐机构、最近更新日期。
3 融资与大厂参股：华尔街见闻、搜狗微信、36氪/投资界；上市公司公告里的参股（巨潮全文检索）；输出 轮次[日期、轮次、金额、投资方]、战略股东（腾讯/华为/比亚迪等）及来源。
4 资质与政策：site:gov.cn 公司名（专精特新/小巨人/高新技术企业/重点项目/补贴）、省经信厅公示、国务院政策文件库里对该行业的政策；输出 荣誉[名称、级别、年份、来源]、地方政策命中[标题、机构、日期、URL]。
5 产线与扩张：新工厂、产线、基地落地、签约；输出 [日期、地点、说明、URL]。
6 规模与口碑：官网/招聘页人数、牛客帖子（site:nowcoder.com 公司名 薪资）、招股书员工数；输出 人数估计、薪资区间线索、评价倾向与证据数。不读脉脉/看准，不登录，不破验证码。
每项拿不到就标 unavailable，不超过 2 次重试。`;
export interface Listing { code: string; orgId: string; market: "A股" | "港股" | "新三板" | string; name: string }

/** 巨潮 name search: the listed entity behind a company name, if any. Exported for tests (matching logic). */
export function pickListing(name: string, hits: { code: string; orgId: string; category: string; zwjc: string; delisted?: string }[]): Listing | null {
  const norm = (s: string) => s.replace(/[\s（）()]/g, "").replace(/(股份有限公司|有限责任公司|有限公司|集团|科技|股份)$/g, "");
  const n = norm(name);
  const live = hits.filter((h) => h.delisted !== "true");
  const exact = live.find((h) => norm(h.zwjc) === n) ?? live.find((h) => n.includes(norm(h.zwjc)) || norm(h.zwjc).includes(n));
  if (!exact) return null;
  return { code: exact.code, orgId: exact.orgId, market: exact.category, name: exact.zwjc };
}
export async function resolveListing(name: string): Promise<Listing | null> {
  const hits = await json("http://www.cninfo.com.cn/new/information/topSearch/query", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ keyWord: name, maxNum: "10" }) });
  return pickListing(name, Array.isArray(hits) ? hits : []);
}

// 沪 6xxxxx / 9xxxxx(B), 深 0/2/3xxxxx, 北交所 8xxxxx / 4xxxxx / 92xxxx
const emCode = (code: string) => (/^(8|4|92)/.test(code) ? `BJ${code}` : code.startsWith("6") || code.startsWith("9") ? `SH${code}` : `SZ${code}`);
const clip = (s: unknown, n: number) => { const t = String(s ?? "").replace(/\s+/g, " ").trim(); return t.length > n ? t.slice(0, n) + "…" : t; };

/** 互动易 / e互动 (巨潮 irm): recent investor questions the company answered — orders, expansion, hiring in its own words. */
export async function fetchIrm(code: string) {
  const k = await json("https://irm.cninfo.com.cn/newircs/index/queryKeyboardInfo", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form({ keyWord: code }) });
  const orgId = k?.data?.[0]?.secid;
  if (!orgId) return { items: [] };
  await sleep(300);
  const q = await json(`https://irm.cninfo.com.cn/newircs/company/question?${form({ _t: "1", stockcode: code, orgId, pageSize: "30", pageNum: "1", keyWord: "", startDay: "", endDay: "" })}`, { method: "POST" });
  const answered = (q?.rows ?? []).filter((r: any) => r.attachedContent);
  return { items: answered.slice(0, 10).map((r: any) => ({ date: r.pubDate ? new Date(r.pubDate).toISOString().slice(0, 10) : "", q: clip(r.mainContent, 1e4), a: clip(r.attachedContent, 1e4) })) };
}

/** 十大股东 + 实际控制人 (东财 F10 股东研究): who owns it — a big group's stake is the 大厂参股 question. */
export async function fetchHolders(code: string) {
  const x = await json(`https://emweb.securities.eastmoney.com/PC_HSF10/ShareholderResearch/PageAjax?code=${emCode(code)}`);
  const rows: any[] = x?.sdgd ?? [];
  const latest = rows[0]?.END_DATE;
  return {
    asOf: String(latest ?? "").slice(0, 10),
    controller: x?.sjkzr?.[0]?.HOLDER_NAME ?? x?.sjkzr?.[0]?.ACTUAL_CONTROLLER ?? "",
    top: rows.filter((r) => r.END_DATE === latest).slice(0, 10).map((r) => ({ name: r.HOLDER_NAME, pct: r.HOLD_NUM_RATIO })),
  };
}

/** 业绩预告: only filed when required, so it can be years old — the date is kept to say so. */
export async function fetchForecast(code: string) {
  const d = await json(`https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_PUBLIC_OP_NEWPREDICT&columns=ALL&filter=(SECURITY_CODE%3D%22${code}%22)&pageSize=4&sortColumns=NOTICE_DATE&sortTypes=-1&source=WEB&client=WEB`);
  const r = (d?.result?.data ?? []).find((x: any) => /净利润/.test(x.PREDICT_FINANCE ?? "")) ?? d?.result?.data?.[0];
  // a forecast is news for about a year; an old one (海康's latest is from 2019) only costs tokens and misleads
  const fresh = r && Date.now() - Date.parse(String(r.NOTICE_DATE ?? "").slice(0, 10)) < 400 * 86400_000;
  return fresh ? { period: String(r.REPORT_DATE ?? "").slice(0, 10), noticeDate: String(r.NOTICE_DATE ?? "").slice(0, 10), type: r.PREDICT_TYPE ?? "", text: clip(r.PREDICT_CONTENT, 1e4) } : { period: "" };
}

/** Sector membership (东财 slist) minus index/market-access tags that say nothing about the business. */
const NOT_A_SECTOR = /融资融券|深股通|沪股通|MSCI|标准普尔|富时|深证|上证|深成|沪深|中证|创业板综|央视|HS300|基金重仓|机构重仓|QFII|社保重仓|预盈预增|破净|昨日|百元股|低价股|AH股|转债标的|板块$/;
export async function fetchSectors(code: string) {
  const market = code.startsWith("6") ? 1 : 0;
  const x = await json(`https://push2.eastmoney.com/api/qt/slist/get?fltt=2&invt=2&secid=${market}.${code}&spt=3&pi=0&pz=200&po=1&fields=f12,f14`, { headers: { referer: "https://quote.eastmoney.com/" } });
  const d = x?.data?.diff;
  const names: string[] = (Array.isArray(d) ? d : Object.values(d ?? {})).map((r: any) => r.f14).filter((n: string) => n && !NOT_A_SECTOR.test(n));
  return { tags: names };
}

/** Analyst reports of the last year: title, broker, rating — the outside view of where the business is going. */
export async function fetchReports(code: string) {
  const from = new Date(Date.now() - 365 * 86400_000).toISOString().slice(0, 10);
  const x = await json(`https://reportapi.eastmoney.com/report/list?${form({ industryCode: "*", pageSize: "10", industry: "*", rating: "*", ratingChange: "*", beginTime: from, endTime: "2100-01-01", pageNo: "1", fields: "", qType: "0", orgCode: "", code, rcode: "" })}`, { headers: { referer: "https://data.eastmoney.com/" } });
  return { total: x?.hits ?? 0, items: (x?.data ?? []).slice(0, 10).map((r: any) => ({ date: String(r.publishDate ?? "").slice(0, 10), org: r.orgSName ?? "", rating: r.emRatingName ?? "", title: clip(r.title, 1e4) })) };
}

export async function fetchBasic(code: string) {
  const s = await json(`https://emweb.securities.eastmoney.com/PC_HSF10/CompanySurvey/PageAjax?code=${emCode(code)}`);
  const b = s?.jbzl?.[0] ?? {}, f = s?.fxxg?.[0] ?? {};
  return {
    orgName: b.ORG_NAME ?? "", industry: b.INDUSTRYCSRC1 ?? b.EM2016 ?? "", province: b.PROVINCE ?? "", address: b.ADDRESS ?? "", web: b.ORG_WEB ?? "",
    employees: b.EMP_NUM ?? null, regCapital: b.REG_CAPITAL ?? null, market: b.SECURITY_TYPE ?? "", founded: (f.FOUND_DATE ?? "").slice(0, 10), listed: (f.LISTING_DATE ?? "").slice(0, 10),
  };
}

/** Last three annual reports + the latest interim: revenue, net profit, growth, R&D expense. */
export async function fetchFinance(code: string) {
  // type=0 lists the latest reports of any kind (the newest is the current interim), type=1 lists annual reports only
  const z = await json(`https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=0&code=${emCode(code)}`);
  await sleep(300);
  const y = await json(`https://emweb.securities.eastmoney.com/PC_HSF10/NewFinanceAnalysis/ZYZBAjaxNew?type=1&code=${emCode(code)}`).catch(() => null);
  const rows: any[] = z?.data ?? [];
  const pick = (r: any) => ({ period: r.REPORT_DATE_NAME, revenue: r.TOTALOPERATEREVE, netProfit: r.PARENTNETPROFIT, revenueYoy: r.TOTALOPERATEREVETZ, netProfitYoy: r.PARENTNETPROFITTZ, roe: r.ROEJQ, grossMargin: r.XSMLL });
  const annual = ((y?.data as any[] | undefined) ?? rows.filter((r) => r.REPORT_TYPE === "年报")).slice(0, 3).map(pick);
  const latest = rows[0] && rows[0].REPORT_TYPE !== "年报" ? pick(rows[0]) : null;
  // 新浪 annual statements: R&D from the income statement (lrb), 支付给职工的现金 from the cash-flow statement (llb —
  // not "xjllb", which silently returns null). Staff cash ÷ employees is the closest public figure to 人均薪酬.
  const sina = async (source: string, field: string) => {
    try {
      await sleep(300);
      const l = await json(`https://quotes.sina.com.cn/cn/api/openapi.php/CompanyFinanceService.getFinanceReport2022?paperCode=${emCode(code).toLowerCase()}&source=${source}&type=4&page=1&num=3`);
      return new Map(Object.entries(l?.result?.data?.report_list ?? {}).map(([d, v]: [string, any]) => [`${d.slice(0, 4)}年报`, Number(v.data?.find((x: any) => x.item_field === field)?.item_value ?? NaN) || null]));
    } catch { return new Map<string, number | null>(); }
  };
  const rd = await sina("lrb", "DEVEEXPE"), staff = await sina("llb", "PAYWORKCASH");
  return { latest, annual: annual.map((a) => ({ ...a, rdExpense: rd.get(a.period) ?? null, staffCash: staff.get(a.period) ?? null })) };
}

/** 港股 (东财 HK F10 main indicators): the last three annual reports + the latest interim, same shape as A股. */
export function hkFinance(rows: any[]) {
  const pick = (r: any) => ({ period: String(r.REPORT_TYPE ?? "").replace(/^(\d{4})年报$/, "$1年报"), revenue: r.OPERATE_INCOME, netProfit: r.HOLDER_PROFIT, revenueYoy: r.OPERATE_INCOME_YOY, netProfitYoy: r.HOLDER_PROFIT_YOY, roe: r.ROE_AVG ?? null, grossMargin: r.GROSS_PROFIT_RATIO, rdExpense: null, currency: r.CURRENCY ?? "" });
  const annual = rows.filter((r) => /年报/.test(String(r.REPORT_TYPE))).slice(0, 3).map(pick);
  const latest = rows[0] && !/年报/.test(String(rows[0].REPORT_TYPE)) ? pick(rows[0]) : null;
  return { latest, annual };
}
export async function fetchHkFinance(code: string) {
  const x = await json(`https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=RPT_HKF10_FN_MAININDICATOR&columns=ALL&filter=(SECUCODE%3D%22${code}.HK%22)&pageNumber=1&pageSize=12&sortTypes=-1&sortColumns=STD_REPORT_DATE&source=F10&client=PC`);
  return hkFinance(x?.result?.data ?? []);
}

export async function fetchDividends(code: string) {
  const d = await json(`https://datacenter-web.eastmoney.com/api/data/v1/get?reportName=RPT_SHAREBONUS_DET&columns=ALL&filter=(SECURITY_CODE%3D%22${code}%22)&pageSize=10&sortColumns=REPORT_DATE&sortTypes=-1&source=WEB&client=WEB`);
  return { items: (d?.result?.data ?? []).filter((r: any) => r.ASSIGN_PROGRESS === "实施分配").map((r: any) => ({ period: (r.REPORT_DATE ?? "").slice(0, 7), plan: r.IMPL_PLAN_PROFILE ?? "" })) };
}

/** What the candidate cares about in a year of announcements. */
export const ANNOUNCEMENT_FLAGS: [string, RegExp][] = [
  ["专精特新", /专精特新/], ["政府补助", /政府补助|补贴/], ["IPO/上市", /辅导|上市|挂牌/], ["购置/扩产", /购置|新建|扩产|产线|产能|基地/], ["对外投资", /对外投资|设立|增资|收购|并购/],
  ["募集资金", /募集|定增|可转债/], ["回购", /回购/], ["减持", /减持/], ["增持", /增持/], ["股权激励", /激励|员工持股/], ["业绩", /业绩(预告|快报)|年度报告|半年度报告/],
];
export function flagAnnouncements(items: { date: string; title: string; url: string }[]) {
  const flags: Record<string, number> = {};
  for (const it of items) for (const [k, re] of ANNOUNCEMENT_FLAGS) if (re.test(it.title)) flags[k] = (flags[k] ?? 0) + 1;
  const hits = items.filter((it) => ANNOUNCEMENT_FLAGS.some(([k, re]) => k !== "业绩" && re.test(it.title)));
  return { flags, hits };
}
export async function fetchAnnouncements(code: string, orgId: string) {
  const to = new Date(), from = new Date(Date.now() - 365 * 86400_000);
  const d = (x: Date) => x.toISOString().slice(0, 10);
  const column = code.startsWith("6") || code.startsWith("9") ? "sse" : "szse";
  const r = await json("http://www.cninfo.com.cn/new/hisAnnouncement/query", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", referer: "http://www.cninfo.com.cn/new/commonUrl/pageOfSearch?url=disclosure/list/search" },
    body: form({ pageNum: "1", pageSize: "60", column, tabName: "fulltext", plate: "", stock: `${code},${orgId}`, searchkey: "", secid: "", category: "", trade: "", seDate: `${d(from)}~${d(to)}`, sortName: "", sortType: "", isHLtitle: "false" }) });
  const items = (r?.announcements ?? []).map((a: any) => ({ date: new Date(a.announcementTime).toISOString().slice(0, 10), title: String(a.announcementTitle ?? "").replace(/<[^>]+>/g, ""), url: `http://static.cninfo.com.cn/${a.adjunctUrl}` }));
  return { total: r?.totalAnnouncement ?? items.length, ...flagAnnouncements(items) };
}

// ---------- 专精特新 roster ----------
export const PLACE = /^(北京|上海|天津|重庆|深圳|广州|杭州|南京|苏州|武汉|成都|西安|合肥|长沙|郑州|济南|青岛|宁波|无锡|厦门|福州|大连|沈阳|哈尔滨|长春|石家庄|太原|南昌|昆明|贵阳|南宁|海口|兰州|东莞|佛山|珠海|中山|惠州|常州|南通|绍兴|温州|嘉兴|金华|台州|烟台|潍坊|徐州|扬州|镇江|泰州|湖州|芜湖|洛阳|襄阳|宜昌|绵阳|广东|江苏|浙江|山东|河南|河北|湖北|湖南|四川|福建|安徽|江西|陕西|山西|辽宁|吉林|黑龙江|云南|贵州|广西|内蒙古|新疆|甘肃|宁夏|青海|海南|西藏)(省|市|自治区)?/;
/** 「深圳拓竹科技有限公司」 and the sheet's 「拓竹科技」 are the same company: drop the place prefix and the legal suffix. */
export const normName = (s: string) => s.replace(/[\s（）()]/g, "").replace(/(股份有限公司|有限责任公司|有限公司|集团有限公司)$/g, "").replace(PLACE, "");
export function smeMatch(db: Db, companyName: string) {
  const n = normName(companyName);
  const rows = (db.prepare("select * from sme_list where name like ? limit 40").all(`%${n.slice(0, Math.min(n.length, 6))}%`) as any[]).filter((r, i, a) => a.findIndex((x) => x.name === r.name && x.level === r.level) === i);
  const exact = n.length >= 3 ? rows.filter((r) => normName(r.name) === n) : [];
  const near = exact.length ? [] : rows.filter((r) => normName(r.name).includes(n) || n.includes(normName(r.name))).slice(0, 3);
  return { matches: exact.map((r) => ({ name: r.name, level: r.level, batch: r.batch, region: r.region, sourceUrl: r.source_url, publishedAt: r.published_at, exact: true })), near: near.map((r) => ({ name: r.name, level: r.level, batch: r.batch, region: r.region, exact: false })), rosterUpdatedAt: (db.prepare("select max(updated_at) u from sme_list").get() as any)?.u ?? null, rosterSize: (db.prepare("select count(*) n from sme_list").get() as any).n as number };
}
export function importSme(db: Db, vault: string, path?: string): { path: string; rows: number; inserted: number; updated: number } {
  const file = path ?? join(vault, "research", "sme-list.csv");
  if (!existsSync(file)) throw new NotFound(`名单文件 ${file}`);
  const rows = parseCsv(readFileSync(file, "utf8").replace(/^﻿/, ""));
  const [head, ...body] = rows;
  const col = (name: string) => head.indexOf(name);
  const iName = col("name"), iLevel = col("level"), iBatch = col("batch"), iRegion = col("region"), iUrl = col("source_url"), iDate = col("published_at");
  if (iName < 0 || iLevel < 0) throw new Error("CSV 需要 name,level 两列");
  const at = (r: string[], i: number) => (i >= 0 ? (r[i] ?? "").trim() : "");
  const { inserted, updated } = upsertSme(db, body.map((r) => ({ name: at(r, iName), level: at(r, iLevel), batch: at(r, iBatch), region: at(r, iRegion), source_url: at(r, iUrl), published_at: at(r, iDate) })));
  return { path: file, rows: body.length, inserted, updated };
}

// ---------- the card ----------
/**
 * Rows are stored whole; the card (and the assistant, every time it reads one) gets this summary — the sizes the card
 * had when fetching itself clipped. company.intelDetail returns one kind whole. Idempotent, so pre-2026-09-28 rows pass.
 */
export function brief(kind: string, d: any): any {
  const first = (n: number, f = (x: any) => x) => (Array.isArray(d?.items) ? { ...d, items: d.items.slice(0, n).map(f) } : d);
  switch (kind) {
    case "news": return first(6);
    case "dividends": return first(3);
    case "irm": return first(3, (r: any) => ({ ...r, q: clip(r.q, 50), a: clip(r.a, 90) }));
    case "reports": return first(3, (r: any) => ({ ...r, title: clip(r.title, 40) }));
    case "holders": return { ...d, top: (d?.top ?? []).slice(0, 5) };
    case "sectors": return { ...d, tags: (d?.tags ?? []).slice(0, 15) };
    case "announcements": return { ...d, hits: (d?.hits ?? []).slice(0, 12) };
    case "forecast": return d?.text ? { ...d, text: clip(d.text, 80) } : d;
    default: return d;
  }
}
export interface IntelRow { kind: Kind; data: any; source: string; fetchedAt: string; ageDays: number; more?: boolean }
const toRow = (r: any): IntelRow => ({ kind: r.kind, data: JSON.parse(r.data_json), source: r.source, fetchedAt: r.fetched_at, ageDays: Math.floor((Date.now() - Date.parse(r.fetched_at)) / 86400_000) });
export function getIntelDetail(s: Services, companyId: string, kind: string) {
  const r = s.domain.db.prepare("select * from company_intel where company_id = ? and kind = ?").get(companyId, kind);
  if (!r) throw new NotFound(`企业情况 ${companyId} ${kind}`);
  return { companyId, ...toRow(r) };
}
export function getIntel(s: Services, companyId: string) {
  const co = s.domain.db.prepare("select name from company where id = ?").get(companyId) as { name: string } | undefined;
  if (!co) throw new NotFound(`company ${companyId}`);
  const rows = (s.domain.db.prepare("select * from company_intel where company_id = ?").all(companyId) as any[]).map((r): IntelRow => {
    const row = toRow(r), b = brief(row.kind, row.data);
    return JSON.stringify(b) === JSON.stringify(row.data) ? row : { ...row, data: b, more: true };
  });
  const sme = smeMatch(s.domain.db, co.name);
  const listing = rows.find((r) => r.kind === "listing")?.data ?? null;
  return { companyId, companyName: co.name, listing, rows: rows.filter((r) => r.kind !== "listing"), sme, stale: rows.length === 0 || rows.some((r) => r.ageDays > 30) };
}

const put = (s: Services, companyId: string, kind: Kind, data: unknown, source: string) =>
  s.domain.db.prepare("insert or replace into company_intel(company_id, kind, data_json, source, fetched_at) values (?,?,?,?,?)").run(companyId, kind, JSON.stringify(data), source, new Date().toISOString());

/** Fetch every kind afresh; a kind that fails keeps its old row and is reported. */
export async function refreshIntel(s: Services, companyId: string) {
  const co = s.domain.db.prepare("select name from company where id = ?").get(companyId) as { name: string } | undefined;
  if (!co) throw new NotFound(`company ${companyId}`);
  const errors: Record<string, string> = {};
  let listing: Listing | null = await resolveListing(co.name).catch((e) => { errors.listing = String(e?.message ?? e); return null; });
  let via = "cninfo:topSearch";
  if (!listing) { await sleep(300); listing = await resolveNeeq(co.name, normName(co.name)).catch((e) => { errors.listing = String(e?.message ?? e); return null; }); via = "eastmoney:codetable"; }
  // not on a mainland or Hong Kong board: a company listed in the US (拼多多, 蔚来, 英伟达) is found by 东财's name search
  if (!listing) { await sleep(300); listing = await resolveUsListing(co.name).catch((e) => { errors.listing = String(e?.message ?? e); return null; }); via = "eastmoney:search"; }
  put(s, companyId, "listing", listing ?? { none: true }, listing ? via : "cninfo:topSearch+eastmoney:codetable+eastmoney:search");
  if (listing && listing.market === "美股") {
    for (const [kind, fn, source] of [["basic", () => fetchUsBasic(listing.code), "eastmoney:USF10"], ["finance", () => fetchUsFinance(listing.code), "eastmoney:USF10"]] as [Kind, () => Promise<unknown>, string][]) {
      try { put(s, companyId, kind, await fn(), source); } catch (e: any) { errors[kind] = String(e?.message ?? e).slice(0, 200); }
      await sleep(300);
    }
  }
  if (listing && listing.market === "新三板") {
    for (const [kind, fn, source] of [["basic", () => fetchNeeqBasic(listing.code), "neeq:detailCompany+年报"], ["finance", () => fetchNeeqFinance(listing.code), "eastmoney:xinsanban"]] as [Kind, () => Promise<unknown>, string][]) {
      try { put(s, companyId, kind, await fn(), source); } catch (e: any) { errors[kind] = String(e?.message ?? e).slice(0, 200); }
      await sleep(300);
    }
  }
  if (listing && listing.market === "港股") {
    try { put(s, companyId, "finance", await fetchHkFinance(listing.code), "eastmoney:HKF10"); } catch (e: any) { errors.finance = String(e?.message ?? e).slice(0, 200); }
    await sleep(300);
  }
  if (listing && listing.market === "A股") {
    const steps: [Kind, () => Promise<unknown>, string][] = [
      ["basic", () => fetchBasic(listing.code), "eastmoney:F10"],
      ["finance", () => fetchFinance(listing.code), "eastmoney:ZYZB+sina:lrb"],
      ["dividends", () => fetchDividends(listing.code), "eastmoney:datacenter"],
      ["announcements", () => fetchAnnouncements(listing.code, listing.orgId), "cninfo:hisAnnouncement"],
      ["holders", () => fetchHolders(listing.code), "eastmoney:F10-shareholders"],
      ["irm", () => fetchIrm(listing.code), "cninfo:irm"],
      ["sectors", () => fetchSectors(listing.code), "eastmoney:slist"],
      ["reports", () => fetchReports(listing.code), "eastmoney:reportapi"],
      ["forecast", () => fetchForecast(listing.code), "eastmoney:datacenter"],
    ];
    for (const [kind, fn, source] of steps) {
      try { put(s, companyId, kind, await fn(), source); } catch (e: any) { errors[kind] = String(e?.message ?? e).slice(0, 200); }
      await sleep(300);
    }
  }
  // for every company, listed or not
  // a listing under review is looked for only where there is no listing yet (an A-share company has nothing to review)
  const steps: [Kind, () => Promise<unknown>, string][] = [["news", () => fetchNews(co.name), "wallstreetcn:search"]];
  if (!listing || listing.market !== "A股") steps.push(["ipo", () => fetchIpo(co.name), "szse:projectrends"]);
  for (const [kind, fn, source] of steps) {
    try { put(s, companyId, kind, await fn(), source); } catch (e: any) { errors[kind] = String(e?.message ?? e).slice(0, 200); }
    await sleep(300);
  }
  return { ...getIntel(s, companyId), errors };
}
