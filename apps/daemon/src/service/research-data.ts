import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fetchBasic, fetchFinance, fetchHkFinance } from "./intel.js";
import { fetchNeeqFinance } from "./neeq.js";
import { fetchUsBasic, fetchUsFinance } from "./us-stock.js";
import { industryReports } from "./industry.js";

/**
 * 调研用的数据工具 (docs/plans/2026-10-13-research-data.md, ADR-056): what someone looking into an industry needs as
 * numbers rather than as web pages — a listed company's filings by its name, the listed companies a theme has on the
 * stock market, brokers' reports, US employment and pay by occupation. Public data, asked for and answered; nothing here
 * touches the pool, the profile or the database, so the same functions serve the daemon's tools and the small server
 * the background worker is given (mcp/research-data.ts). Every answer carries a `ref` to cite it by, and when the call
 * belongs to a research run it is written to that run's data file — what the report's 要点 are later checked against.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
const get = async (url: string, init: RequestInit = {}): Promise<any> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000), ...init, headers: { "user-agent": UA, ...(init.headers as Record<string, string> ?? {}) } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).hostname}`);
  return res.json();
};
const now = () => new Date().toISOString();
interface Hit { code: string; shortName: string; securityTypeName: string; market: number | string }
/** 东财's code table: one search over A 股, 港股, 美股, 新三板 and the boards, by name or by code. */
const codeTable = async (keyword: string): Promise<Hit[]> =>
  ((await get(`https://search-codetable.eastmoney.com/codetable/search/web?client=web&clientType=webSuggest&clientVersion=lastest&pageIndex=1&pageSize=12&keyword=${encodeURIComponent(keyword)}`))?.result ?? []) as Hit[];

// ---------- a company's filings, by its name ----------
export type Market = "A股" | "港股" | "美股" | "新三板";
export interface Security { market: Market; code: string; name: string }
const A_BOARDS = new Set(["沪A", "深A", "科创板", "创业板", "北A", "京A", "北交所"]);
const US_SUFFIX: Record<string, string> = { "105": "O", "106": "N", "107": "A" };
const FUND = /ETF|做多|做空|期权|收益|基金|指数|期货|\(ADR\)|-R$|-WR$/i;
const ORDER: Market[] = ["A股", "港股", "美股", "新三板"];
/** A name without what differs between a careers page and a ticker: brackets, the listing-class mark (-W, -U), legal endings. */
const bare = (s: string) => s.normalize("NFKC").replace(/[\s（）()]/g, "").replace(/-[A-Z]{1,2}$/, "").replace(/(股份有限公司|有限责任公司|有限公司|控股公司|公司|集团|控股|股份)+$/g, "").toLowerCase();
const security = (h: Hit): Security | null => {
  const t = h.securityTypeName, m = String(h.market);
  if (FUND.test(h.shortName)) return null;
  if (A_BOARDS.has(t)) return { market: "A股", code: h.code, name: h.shortName };
  if (t === "港股" && /^0\d{4}$/.test(h.code)) return { market: "港股", code: h.code, name: h.shortName };
  if (t === "美股" && US_SUFFIX[m]) return { market: "美股", code: `${h.code}.${US_SUFFIX[m]}`, name: h.shortName };
  if (t === "三板") return { market: "新三板", code: h.code, name: h.shortName };
  return null;
};
/**
 * Which listed company a name (or a code) means. The same name once the endings are set aside is that company (比亚迪 on
 * two exchanges: the mainland one). One company only, whose name begins with what was asked or the other way round
 * (宇树 → 宇树科技-W): taken, and said to be a near match. Several such: none is taken, all are listed. A code is the
 * company with that code. Not found is not "unlisted" — the name may simply be written another way. Exported for tests.
 */
export function pickSecurity(query: string, hits: Hit[]): { status: "listed"; security: Security; approx: boolean } | { status: "ambiguous"; candidates: Security[] } | { status: "not_found" } {
  const q = query.trim(), all = hits.map(security).filter((x): x is Security => !!x);
  const byCode = all.filter((s) => s.code.toUpperCase() === q.toUpperCase() || s.code.split(".")[0].toUpperCase() === q.toUpperCase().replace(/\.(HK|[ONA])$/, ""));
  if (/^[0-9A-Za-z.]+$/.test(q)) return byCode.length ? { status: "listed", security: byCode.sort((a, b) => ORDER.indexOf(a.market) - ORDER.indexOf(b.market))[0], approx: false } : { status: "not_found" };
  const n = bare(q);
  if (n.length < 2) return { status: "not_found" };
  const same = all.filter((s) => bare(s.name) === n).sort((a, b) => ORDER.indexOf(a.market) - ORDER.indexOf(b.market));
  if (same.length) return { status: "listed", security: same[0], approx: false };
  const near = all.filter((s) => { const b = bare(s.name); return b.length >= 2 && (b.startsWith(n) || n.startsWith(b)); });
  const companies = new Set(near.map((s) => bare(s.name)));
  if (companies.size === 1) return { status: "listed", security: near.sort((a, b) => ORDER.indexOf(a.market) - ORDER.indexOf(b.market))[0], approx: true };
  return near.length ? { status: "ambiguous", candidates: near.slice(0, 6) } : { status: "not_found" };
}

export interface FinanceRow { period: string; revenue: number | null; netProfit: number | null; revenueYoy: number | null; netProfitYoy: number | null; grossMargin: number | null; rdExpense: number | null; currency: string }
const num = (v: unknown) => (v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const row = (r: any, currency: string): FinanceRow => ({ period: String(r?.period ?? "").replace("年年报", "年报"), revenue: num(r?.revenue), netProfit: num(r?.netProfit), revenueYoy: num(r?.revenueYoy), netProfitYoy: num(r?.netProfitYoy), grossMargin: num(r?.grossMargin), rdExpense: num(r?.rdExpense), currency: String(r?.currency || currency) });

/**
 * A company's last three annual reports and the latest one since, with what it is and how many it employs — by name or
 * by code, whether or not it is in the pool. `status` says what happened: listed (figures follow), not_found (no listed
 * company by that name: unlisted, or spelled differently), ambiguous (several candidates, no figures), failed (found,
 * the figures could not be fetched).
 */
export async function companyFinancials(p: { name: string }) {
  const query = String(p.name ?? "").trim();
  if (query.length < 2) throw Object.assign(new Error("MISSING_FIELD: 要给公司名或股票代码，至少两个字"), { code: "MISSING_FIELD" });
  const base = { query, fetchedAt: now(), source: "东方财富（代码表、F10 主要指标）；A 股研发费用取自新浪利润表", note: "金额单位是所标币种的「元」，不是万元或亿元；同比与毛利率是百分数。" };
  // the name as written, then without its endings (the table knows short names: 「汇川技术」, not 「深圳市汇川技术股份有限公司」)
  let picked: ReturnType<typeof pickSecurity> = { status: "not_found" };
  for (const key of [...new Set([query, query.normalize("NFKC").replace(/[（(][^）)]*[）)]/g, "").replace(/(股份有限公司|有限责任公司|有限公司)$/g, "")])].filter((k) => k.length >= 2)) {
    picked = pickSecurity(query, await codeTable(key));
    if (picked.status !== "not_found") break;
  }
  // still nothing: the brand alone (「小鹏汽车」 is listed as 小鹏集团-W). What is found this way is a near match, said so
  const brand = query.normalize("NFKC").replace(/(汽车|科技|技术|集团|控股|股份)+$/g, "");
  if (picked.status === "not_found" && brand !== query && brand.length >= 2 && /[一-鿿]/.test(brand)) {
    const viaBrand = pickSecurity(brand, await codeTable(brand));
    picked = viaBrand.status === "listed" ? { ...viaBrand, approx: true } : viaBrand;
  }
  if (picked.status === "not_found") return { ...base, status: "not_found" as const, ref: "", message: "没有查到叫这个名字的上市公司（A 股 / 港股 / 美股 / 新三板）。可能未上市，也可能是名字写法不同——可以换通用简称或直接给股票代码再查。" };
  if (picked.status === "ambiguous") return { ...base, status: "ambiguous" as const, ref: "", candidates: picked.candidates, message: "有几家名字相近的上市公司，没有替你选。用其中一家的代码再查。" };
  const sec = picked.security, ref = `F:${sec.market}:${sec.code}`;
  let basic: any = null, fin: any = null;
  const errors: string[] = [];
  const attempt = async (what: string, fn: () => Promise<any>) => { try { return await fn(); } catch (e: any) { errors.push(`${what}：${String(e?.message ?? e).slice(0, 120)}`); return null; } };
  if (sec.market === "A股") { basic = await attempt("公司概况", () => fetchBasic(sec.code)); fin = await attempt("财务", () => fetchFinance(sec.code)); }
  else if (sec.market === "港股") fin = await attempt("财务", () => fetchHkFinance(sec.code));
  else if (sec.market === "美股") { basic = await attempt("公司概况", () => fetchUsBasic(sec.code)); fin = await attempt("财务", () => fetchUsFinance(sec.code)); }
  else fin = await attempt("财务", () => fetchNeeqFinance(sec.code));
  const currency = sec.market === "A股" || sec.market === "新三板" ? "人民币" : "";
  const annual = ((fin?.annual ?? []) as any[]).map((r) => row(r, currency));
  return {
    ...base, status: (annual.length || fin?.latest ? "listed" : "failed") as "listed" | "failed", ref, security: sec, approx: picked.approx,
    ...(picked.approx ? { message: `按名字相近认成了「${sec.name}」（${sec.market} ${sec.code}），请核对是不是这家。` } : {}),
    basic: basic ? { industry: String(basic.industry ?? ""), employees: num(basic.employees), province: String(basic.province ?? ""), founded: String(basic.founded ?? ""), listedOn: String(basic.listed ?? ""), web: String(basic.web ?? "") } : null,
    annual, latest: fin?.latest ? row(fin.latest, currency) : null, errors,
  };
}

// ---------- the listed companies a theme has ----------
/** The board a query names: the one called exactly that, else one whose name holds it or is held by it. Exported for tests. */
export function pickBoard(query: string, hits: Hit[]): { board: { code: string; name: string; kind: string } | null; others: string[] } {
  const q = query.trim().replace(/(行业|概念|板块)$/, "");
  const boards = hits.filter((h) => /^BK\d+$/.test(h.code) && (h.securityTypeName === "概念" || h.securityTypeName === "行业"));
  const hit = boards.find((b) => b.shortName === q) ?? boards.find((b) => b.shortName.replace(/概念$/, "") === q) ?? boards.find((b) => b.shortName.includes(q) || q.includes(b.shortName.replace(/概念$/, "")));
  return { board: hit ? { code: hit.code, name: hit.shortName, kind: hit.securityTypeName } : null, others: boards.filter((b) => b !== hit).map((b) => b.shortName) };
}
/**
 * The A-share companies 东方财富 files under a theme or an industry, largest first. A board is a list of candidates, not
 * the industry: a concept board is led by large companies that only touch the theme (人形机器人: 美的集团, 兆易创新).
 */
export async function industryCompanies(p: { query: string; limit?: number }) {
  const query = String(p.query ?? "").trim();
  if (query.length < 2) throw Object.assign(new Error("MISSING_FIELD: 要说明行业或主题，至少两个字"), { code: "MISSING_FIELD" });
  const limit = Math.min(Math.max(p.limit ?? 30, 5), 100);
  const { board, others } = pickBoard(query, await codeTable(query));
  const base = { query, fetchedAt: now(), source: "东方财富板块成分股", note: "板块是候选名单，不是行业样本：概念板块里排前面的常是只沾边的大公司，看「主营行业」一栏分辨。只含 A 股；港股、美股和未上市的公司不在里面。市值单位：亿元人民币。" };
  if (!board) return { ...base, ref: "", board: null, otherBoards: others, total: 0, items: [] as { code: string; name: string; marketCapYi: number | null; industry: string }[], message: "东方财富没有叫这个名字的板块。换一个说法（更宽的行业名，或具体的概念名）再查。" };
  const x = await get(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${limit}&po=1&np=1&fltt=2&invt=2&fid=f20&fs=b:${board.code}&fields=f12,f14,f20,f100`, { headers: { referer: "https://quote.eastmoney.com/" } });
  const diff = x?.data?.diff, rows: any[] = Array.isArray(diff) ? diff : Object.values(diff ?? {});
  return { ...base, ref: `B:${board.code}`, board, otherBoards: others, total: Number(x?.data?.total ?? rows.length), items: rows.map((r) => ({ code: String(r.f12), name: String(r.f14), marketCapYi: num(r.f20) == null ? null : Math.round(Number(r.f20) / 1e7) / 10, industry: String(r.f100 ?? "") })) };
}

// ---------- US employment and pay by occupation ----------
let occupations: Promise<Map<string, string>> | undefined;
/** BLS's own list of occupation codes and names, read once: a code that is wrong is seen to be wrong by its name. */
const occupationNames = () => (occupations ??= fetch("https://download.bls.gov/pub/time.series/oe/oe.occupation", { headers: { "user-agent": UA }, signal: AbortSignal.timeout(30_000) })
  .then((r) => (r.ok ? r.text() : "")).then((t) => new Map(t.split(/\r?\n/).map((l) => l.split("\t")).filter((c) => /^\d{6}$/.test(c[0] ?? "")).map((c) => [c[0], (c[1] ?? "").trim()] as [string, string])))
  .catch(() => new Map<string, string>()));
/** BLS series answers → one row per occupation. Exported for tests. */
export function laborRows(socs: string[], series: any[], names: Map<string, string>) {
  const latest = (id: string) => { const d = (series.find((s) => s?.seriesID === id)?.data ?? [])[0]; return d ? { year: String(d.year), value: num(String(d.value).replace(/,/g, "")) } : null; };
  return socs.map((soc) => {
    const six = soc.replace(/\D/g, ""), e = latest(`OEUN0000000000000${six}01`), mean = latest(`OEUN0000000000000${six}04`), median = latest(`OEUN0000000000000${six}13`);
    const found = !!(e || mean || median);
    return { soc: `${six.slice(0, 2)}-${six.slice(2)}`, ref: found ? `L:${six.slice(0, 2)}-${six.slice(2)}` : "", title: names.get(six) ?? "", status: (found ? "ok" : "no_data") as "ok" | "no_data", year: e?.year ?? median?.year ?? mean?.year ?? "", employment: e?.value ?? null, meanAnnualWage: mean?.value ?? null, medianAnnualWage: median?.value ?? null };
  });
}
/**
 * 美国劳工统计局 OEWS (official, yearly): how many people work in an occupation across the US and what they are paid.
 * By SOC code — 17-2141 机械工程师, 17-2071 电气工程师, 15-1252 软件开发, 17-2199 其他工程师 … The name BLS gives each
 * code comes back with it. Without a key the BLS interface answers about 25 requests a day from one address.
 */
export async function laborUs(p: { soc: string[] }) {
  const socs = [...new Set((p.soc ?? []).map((s) => String(s).replace(/\D/g, "")).filter((s) => s.length === 6))].slice(0, 8);
  if (!socs.length) throw Object.assign(new Error("MISSING_FIELD: 要给 SOC 职业代码，如 17-2141"), { code: "MISSING_FIELD" });
  const year = new Date().getFullYear();
  const [x, names] = await Promise.all([
    get("https://api.bls.gov/publicAPI/v2/timeseries/data/", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ seriesid: socs.flatMap((s) => ["01", "04", "13"].map((d) => `OEUN0000000000000${s}${d}`)), startyear: String(year - 2), endyear: String(year) }) }),
    occupationNames(),
  ]);
  if (x?.status !== "REQUEST_SUCCEEDED") throw Object.assign(new Error(`SOURCE_FAILED: 美国劳工统计局没有答复：${String((x?.message ?? []).join("；")).slice(0, 200) || x?.status}（没有密钥时每天约 25 次请求）`), { code: "SOURCE_FAILED" });
  return { fetchedAt: now(), source: "美国劳工统计局 BLS · OEWS（全国、各行业合计，年度）", note: "employment 是就业人数；工资是年薪，美元。title 是 BLS 对这个代码的叫法——和你要查的职业不一样就是代码给错了。status=no_data 表示没有这个代码的数据。", items: laborRows(socs, x?.Results?.series ?? [], names) };
}

// ---------- the tools, and a run's record of what it was given ----------
export const DATA_TOOLS = {
  "industry.reports": async (i: any) => { const r = await industryReports(i); return { ...r, items: r.items.map((it) => ({ ...it, ref: `R:${/infocode=([^&]+)/.exec(it.url)?.[1] ?? ""}` })) }; },
  "industry.companies": industryCompanies,
  "company.financials": companyFinancials,
  "labor.us": laborUs,
} as const;
export type DataTool = keyof typeof DATA_TOOLS;
export const isDataTool = (name: string): name is DataTool => name in DATA_TOOLS;

export interface DataEntry { at: string; tool: DataTool; input: unknown; ok: boolean; error?: string; output?: any; for?: string }
/** Where a run keeps what it was given: one line per call, in the run's directory; copied beside the report when it is filed. */
export const dataFile = (dir: string) => join(dir, "data.jsonl");
export function keepData(file: string, e: Omit<DataEntry, "at">): void {
  try { appendFileSync(file, JSON.stringify({ at: now(), ...e }) + "\n", "utf8"); } catch { /* a record that cannot be written does not fail the answer */ }
}
/** One tool, called; with `file` the call and its answer are kept there, failures too (`forWhat`: the report's company it was fetched for). */
export async function callData(tool: DataTool, input: any, file?: string, forWhat?: string): Promise<any> {
  const keep = (e: Pick<DataEntry, "ok" | "error" | "output">) => { if (file) keepData(file, { tool, input, ...(forWhat ? { for: forWhat } : {}), ...e }); };
  try { const output = await (DATA_TOOLS[tool] as (i: any) => Promise<any>)(input); keep({ ok: true, output }); return output; }
  catch (e: any) { keep({ ok: false, error: String(e?.message ?? e).slice(0, 300) }); throw e; }
}
export function readData(file: string): DataEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l) as DataEntry]; } catch { return []; } });
}

/** Everything a run was given, by the ref it is cited by: a report, a company's filings, a board, an occupation. */
export function refIndex(entries: DataEntry[]): Map<string, { kind: "研报" | "财报" | "板块" | "美国劳工统计"; label: string; at: string; data: any }> {
  const out = new Map<string, { kind: "研报" | "财报" | "板块" | "美国劳工统计"; label: string; at: string; data: any }>();
  for (const e of entries) {
    if (!e.ok || !e.output) continue;
    const o = e.output;
    if (e.tool === "industry.reports") for (const it of o.items ?? []) if (it.ref) out.set(it.ref, { kind: "研报", label: `${it.org} ${it.date}《${it.title}》`, at: e.at, data: it });
    if (e.tool === "company.financials" && o.ref) out.set(o.ref, { kind: "财报", label: `${o.security?.name ?? o.query}（${o.security?.market ?? ""} ${o.security?.code ?? ""}）`, at: e.at, data: { basic: o.basic, annual: o.annual, latest: o.latest } });
    if (e.tool === "industry.companies" && o.ref) out.set(o.ref, { kind: "板块", label: `${o.board?.name ?? o.query} 板块（${o.total} 家）`, at: e.at, data: { total: o.total, items: o.items } });
    if (e.tool === "labor.us") for (const it of o.items ?? []) if (it.ref) out.set(it.ref, { kind: "美国劳工统计", label: `${it.title || it.soc}（${it.year}）`, at: e.at, data: it });
  }
  return out;
}

// ---------- a report's 要点 against what the run was given ----------
/**
 * The figures a sentence states: 12.3 亿 → 1.23e9, 3,400 万 → 3.4e7, 28% → 28, 104,110 → 104110. `plain` is the numeral
 * as written (12.3): some data is already kept in 亿. Years and bare small counts (「3 家」「16 个岗位」) are not figures
 * to look up. Exported for tests.
 */
export function numbersIn(text: string): { raw: string; value: number; plain: number; loose: number }[] {
  const out: { raw: string; value: number; plain: number; loose: number }[] = [];
  for (const m of text.matchAll(/(\d[\d,]*(?:\.\d+)?)\s*(万亿|亿|万|千|%|％)?/g)) {
    const digits = m[1].replace(/,/g, ""), n = Number(digits), unit = m[2] ?? "";
    if (!Number.isFinite(n)) continue;
    if (!unit && (/^(19|20)\d\d$/.test(digits) || (!digits.includes(".") && digits.length < 4))) continue;
    const scale = unit === "万亿" ? 1e12 : unit === "亿" ? 1e8 : unit === "万" ? 1e4 : unit === "千" ? 1e3 : 1;
    const decimals = (digits.split(".")[1] ?? "").length;
    out.push({ raw: m[0].trim(), value: n * scale, plain: n, loose: 0.5 * 10 ** -decimals }); // as far off as rounding to the digits shown allows
  }
  return out;
}
const leaves = (v: any, out: number[] = []): number[] => { if (typeof v === "number" && Number.isFinite(v)) out.push(v); else if (v && typeof v === "object") for (const x of Object.values(v)) leaves(x, out); return out; };
export interface CheckedPoint { text: string; refs: { ref: string; kind: string; label: string }[]; unknownRefs: string[]; status: "matched" | "unmatched" | "cited" | "none" | "unknown"; unmatched: string[] }
/**
 * Each point of a report against the data its run was given. matched: every number in the sentence is found in the
 * data it cites (to the rounding shown, or within 1 %). unmatched: it cites data, and some number is not in it — a
 * conversion or a sum, or a mistake; a person looks. cited: it cites data and states no number. none: it cites nothing
 * (a web page, or a judgement). unknown: what it cites is not among what this run was given. This shows that the data
 * was fetched and cited and that the figures are in it — not that the conclusion follows from them.
 */
export function checkPoints(points: { text: string; refs: string[] }[], index: ReturnType<typeof refIndex>): CheckedPoint[] {
  return points.map((p) => {
    const refs = [...new Set(p.refs)];
    const known = refs.filter((r) => index.has(r)), unknownRefs = refs.filter((r) => !index.has(r));
    const base = { text: p.text, refs: known.map((r) => ({ ref: r, kind: index.get(r)!.kind, label: index.get(r)!.label })), unknownRefs };
    if (!refs.length) return { ...base, status: "none" as const, unmatched: [] };
    if (!known.length) return { ...base, status: "unknown" as const, unmatched: [] };
    const have = known.flatMap((r) => leaves(index.get(r)!.data));
    const said = numbersIn(p.text);
    // by size: a sentence says a loss or a fall in words (「净亏 7.03 亿」「同比下降 12.2%」), the data with a minus sign
    const near = (h: number, v: number, loose: number) => Math.abs(Math.abs(h) - Math.abs(v)) <= Math.max(loose, Math.abs(h) * 0.01);
    const unmatched = said.filter((n) => !have.some((h) => near(h, n.value, n.loose * (n.value / (n.plain || 1))) || near(h, n.plain, n.loose))).map((n) => n.raw);
    return { ...base, status: (!said.length ? "cited" : unmatched.length ? "unmatched" : "matched") as CheckedPoint["status"], unmatched };
  });
}
