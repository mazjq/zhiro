import type { Listing } from "./intel.js";

/**
 * 美股 企业情况 (ADR-029 的第四个市场): which US-listed company a name is, what it is, and its last three annual reports.
 * All from 东方财富 — its code table and its US F10 data centre — which answers in Chinese, needs no key, and is reachable
 * from where the user is. SEC EDGAR is the official source but refuses requests from this network (403, 2026-10-13);
 * if that changes it is the better source for filings, and this file is where it would go.
 * (Not searchapi.eastmoney.com/api/suggest: curl gets the code table from it, Node gets an unrelated JSONP answer.)
 */
const get = async (url: string): Promise<any> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
};
const dc = (report: string, filter: string, size: number, sort = "REPORT_DATE") =>
  `https://datacenter.eastmoney.com/securities/api/data/v1/get?reportName=${report}&columns=ALL&filter=${encodeURIComponent(filter)}&pageNumber=1&pageSize=${size}&sortColumns=${sort}&sortTypes=-1&source=SECURITIES&client=PC`;

/** 东财 exchange number → the suffix its US codes carry. */
const SUFFIX: Record<string, string> = { "105": "O", "106": "N", "107": "A" };
const FUND = /ETF|做多|做空|期权|收益|基金|指数|-W$|-R$/i;

/** A company name without the endings that vary between a careers page and a stock ticker's short name. */
const bareName = (s: string) => s.normalize("NFKC").replace(/[\s（）()]/g, "").replace(/(股份有限公司|有限责任公司|有限公司|控股公司|公司|集团|控股|科技|汽车|股份)+$/g, "");
const bare = (s: string) => bareName(s).toLowerCase();

/**
 * The US-listed company a name means — only when the names are the same once the usual endings are set aside
 * (「蔚来汽车」 is 蔚来; 「拼多多」 is 拼多多). A name that merely contains another is not taken: 「苹果园科技」 is not 苹果.
 * Funds built on a company's name (二倍做多英伟达 ETF) are not the company. Exported for tests.
 */
export function pickUsListing(name: string, hits: { Code: string; Name: string; SecurityTypeName: string; MktNum: string }[]): Listing | null {
  const n = bare(name);
  if (n.length < 2) return null;
  const hit = hits.find((h) => h.SecurityTypeName === "美股" && SUFFIX[h.MktNum] && !FUND.test(h.Name) && bare(h.Name) === n);
  return hit ? { code: `${hit.Code}.${SUFFIX[hit.MktNum]}`, orgId: "", market: "美股", name: hit.Name } : null;
}
/** 东财's code table by name — the search the 新三板 lookup uses too; asked with the name as written, then without its endings. */
export async function resolveUsListing(name: string): Promise<Listing | null> {
  for (const key of [...new Set([name.trim(), bareName(name)])].filter((k) => k.length >= 2)) {
    const x = await get(`https://search-codetable.eastmoney.com/codetable/search/web?client=web&clientType=webSuggest&clientVersion=lastest&pageIndex=1&pageSize=10&keyword=${encodeURIComponent(key)}`);
    const hit = pickUsListing(name, ((x?.result ?? []) as any[]).map((r) => ({ Code: String(r.code), Name: String(r.shortName), SecurityTypeName: String(r.securityTypeName), MktNum: String(r.market) })));
    if (hit) return hit;
  }
  return null;
}

/** Company profile row → the card's 基本盘. Exported for tests. */
export function usBasic(p: any) {
  return {
    orgName: p?.ORG_NAME ?? "", enName: p?.ORG_EN_ABBR ?? "", industry: p?.BELONG_INDUSTRY ?? "", province: "", address: p?.ADDRESS ?? "", web: p?.ORG_WEB ?? "",
    employees: p?.EMP_NUM ?? null, regCapital: null, market: p?.BELONG_MARKET ?? "美股", founded: String(p?.FOUND_DATE ?? "").slice(0, 10), listed: "",
  };
}
export async function fetchUsBasic(code: string) {
  const x = await get(dc("RPT_USF10_INFO_ORGPROFILE", `(SECUCODE="${code}")`, 1, "SECUCODE"));
  const p = x?.result?.data?.[0];
  if (!p) throw new Error(`SCHEMA_CHANGED: 东财没有返回 ${code} 的公司资料`);
  return usBasic(p);
}

/**
 * Main-indicator rows (newest first; annual, cumulative and single-quarter reports mixed) + the annual R&D rows → the
 * card's shape: the last three fiscal years and the latest report since. Amounts are in the report's own currency, said
 * on every row — a US filer reports in 美元, a Chinese ADR often in 人民币. A fiscal year is named as the source names
 * it (英伟达's year ending 2026-01 is 「2025年报」). Exported for tests.
 */
export function usFinance(rows: any[], rd: any[]) {
  const day = (r: any) => String(r.REPORT_DATE ?? "").slice(0, 10);
  const rdBy = new Map(rd.map((r) => [day(r), Number(r.AMOUNT)]));
  const pick = (r: any) => ({
    period: String(r.REPORT_DATA_TYPE ?? "").replace(/\s+/g, "").replace("年年报", "年报"), revenue: r.OPERATE_INCOME ?? null, netProfit: r.PARENT_HOLDER_NETPROFIT ?? null,
    revenueYoy: r.OPERATE_INCOME_YOY ?? null, netProfitYoy: r.PARENT_HOLDER_NETPROFIT_YOY ?? null, roe: r.ROE_AVG ?? null, grossMargin: r.GROSS_PROFIT_RATIO ?? null,
    rdExpense: rdBy.get(day(r)) ?? null, currency: r.CURRENCY ?? "", periodEnd: day(r),
  });
  const annual = rows.filter((r) => r.DATE_TYPE === "年报").slice(0, 3).map(pick);
  // since the last annual report: the newest cumulative one (中报, 三季报) or a first quarter — not a single middle quarter
  const since = rows.find((r) => (r.DATE_TYPE === "累计季报" || /一季报/.test(String(r.REPORT_DATA_TYPE))) && (!annual[0] || day(r) > annual[0].periodEnd));
  return { latest: since ? pick(since) : null, annual };
}
export async function fetchUsFinance(code: string) {
  const main = await get(dc("RPT_USF10_FN_GMAININDICATOR", `(SECUCODE="${code}")`, 40));
  const rows: any[] = main?.result?.data ?? [];
  if (!rows.length) throw new Error(`SCHEMA_CHANGED: 东财没有返回 ${code} 的财务指标`);
  const rd = await get(dc("RPT_USF10_FN_INCOME", `(SECUCODE="${code}")(REPORT_TYPE="年报")(ITEM_NAME="研发费用")`, 4)).then((x) => (x?.result?.data ?? []) as any[]).catch(() => [] as any[]);
  return usFinance(rows, rd);
}
