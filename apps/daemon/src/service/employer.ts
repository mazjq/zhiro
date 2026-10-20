import type { Db } from "../db.js";
import { resolveNeeq } from "./neeq.js";
import { companyFinancials } from "./research-data.js";
import { normName, smeMatch } from "./intel.js";

/**
 * Comparing employers (D-29): where each listed company stands among the A-share companies of its own 申万一级
 * industry on four measures, and how its place among the candidates moves with what the person cares about. No total
 * score and no imputed values: a missing number stays missing and widens the answer instead.
 *
 * Data: 东方财富 F10 tables read in bulk (company list with industry and staff count; income statement; cash-flow
 * statement), kept in `peer_snapshot` with the time fetched so a comparison can say what it used.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
const F10 = "https://datacenter.eastmoney.com/securities/api/data/v1/get";
const A_SHARE = ["深交所主板A股", "上交所主板A股", "深交所创业板A股", "上交所科创板A股", "北京证券交易所A股", "深交所风险警示板A股", "上交所风险警示板A股"];
const KEEP_DAYS = 30;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface Company { code: string; name: string; org: string; industry: string; employees: number | null; market?: string; csrc?: string; peerSw?: string; approx?: boolean }
export interface YearRow { revenue: number | null; netProfit: number | null; rd: number | null; opCost: number | null; staffCash: number | null; dividendCash: number | null; capex: number | null }
export interface PeerRow extends Company { years: Record<string, YearRow> }

async function f10(report: string, columns: string, filter: string, page = 1): Promise<{ data: any[]; pages: number }> {
  const url = `${F10}?reportName=${report}&columns=${columns}&filter=${encodeURIComponent(filter)}&pageNumber=${page}&pageSize=500&source=HSF10&client=PC`;
  for (let k = 0; ; k++) {
    try {
      const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(20_000) });
      const x: any = await res.json();
      if (!x?.success && x?.code !== 9201) throw new Error(`东方财富 ${report}：${x?.message ?? res.status}`);
      return { data: x?.result?.data ?? [], pages: x?.result?.pages ?? 0 };
    } catch (e) { if (k >= 1) throw e; await sleep(1500); }
  }
}
async function f10All(report: string, columns: string, filter: string) {
  const first = await f10(report, columns, filter);
  const out = [...first.data];
  for (let p = 2; p <= first.pages; p++) { await sleep(300); out.push(...(await f10(report, columns, filter, p)).data); }
  return out;
}

function cached<T>(db: Db, key: string, now: number): { at: string; data: T } | null {
  const r = db.prepare("select fetched_at, data_json from peer_snapshot where key = ?").get(key) as { fetched_at: string; data_json: string } | undefined;
  if (!r || now - Date.parse(r.fetched_at) > KEEP_DAYS * 86400_000) return null;
  return { at: r.fetched_at, data: JSON.parse(r.data_json) };
}
const keep = (db: Db, key: string, data: unknown, now: number) =>
  db.prepare("insert or replace into peer_snapshot(key, fetched_at, data_json) values (?,?,?)").run(key, new Date(now).toISOString(), JSON.stringify(data));
/**
 * A name looked up on the other boards (新三板, 港股, 美股) is remembered for a week, found or not: an unlisted company
 * took a second of lookups on every comparison (2026-10-20). A lookup that failed is not remembered.
 */
async function remembered<T>(db: Db, key: string, now: number, look: () => Promise<T>): Promise<T> {
  const r = db.prepare("select fetched_at, data_json from peer_snapshot where key = ?").get(key) as { fetched_at: string; data_json: string } | undefined;
  if (r && now - Date.parse(r.fetched_at) <= 7 * 86400_000) return JSON.parse(r.data_json).v as T;
  const v = await look();
  keep(db, key, { v }, now);
  return v;
}

/** Every A-share company with its 申万 industry (一级-二级-三级) and latest staff count. */
export async function universe(db: Db, now = Date.now()): Promise<{ at: string; data: Company[] }> {
  const hit = cached<Company[]>(db, "universe:3", now); // :2 added 北交所, :3 the 证监会 industry
  if (hit) return hit;
  const rows = await f10All("RPT_F10_BASIC_ORGINFO", "SECUCODE,SECURITY_NAME_ABBR,ORG_NAME,BOARD_NAME_LEVEL,EMP_NUM,INDUSTRYCSRC1", `(SECURITY_TYPE in (${A_SHARE.map((t) => `"${t}"`).join(",")}))`);
  const data: Company[] = rows.filter((r) => r.BOARD_NAME_LEVEL).map((r) => ({ code: r.SECUCODE, name: r.SECURITY_NAME_ABBR ?? "", org: r.ORG_NAME ?? "", industry: r.BOARD_NAME_LEVEL, employees: Number(r.EMP_NUM) > 0 ? Number(r.EMP_NUM) : null, csrc: r.INDUSTRYCSRC1 ?? "" }));
  keep(db, "universe:3", data, now);
  return { at: new Date(now).toISOString(), data };
}

/** The latest fiscal year whose annual reports are all out (they are due by the end of April, Beijing time). */
export function latestYear(now = Date.now()) {
  const d = new Date(now + 8 * 3600_000);
  return d.getUTCMonth() >= 4 ? d.getUTCFullYear() - 1 : d.getUTCFullYear() - 2;
}
export const sector = (industry: string) => industry.split("-")[0];
/**
 * Whom a company is measured against: an A-share company, the A-share companies of its 申万一级 industry; a 新三板
 * company (whose own industry scheme is not 申万), the A-share companies of its 证监会 industry, which both carry.
 */
export function peerGroup(c: Company): { key: string; label: string; has: (x: Company) => boolean } {
  if (c.peerSw) return { key: c.peerSw, label: `申万一级「${c.peerSw}」`, has: (x) => sector(x.industry) === c.peerSw };
  if (c.market === "新三板" && c.csrc) return { key: `csrc:${c.csrc}`, label: `证监会行业「${c.csrc}」`, has: (x) => x.csrc === c.csrc };
  const top = sector(c.industry);
  return { key: top, label: `申万一级「${top}」`, has: (x) => sector(x.industry) === top };
}

/** One peer group: each company's statements for `year` and the three years before (for growth). */
export async function industryPool(db: Db, group: ReturnType<typeof peerGroup>, year: number, all: Company[], now = Date.now()): Promise<{ at: string; data: PeerRow[] }> {
  const key = `industry:${group.key}:${year}`;
  const hit = cached<PeerRow[]>(db, key, now);
  if (hit) return hit;
  const members = all.filter(group.has);
  const rows = new Map<string, PeerRow>(members.map((c) => [c.code, { ...c, years: {} }]));
  await statements(rows, year);
  // a company without that year's revenue is not in the pool (delisted, or listed after the year)
  const data = [...rows.values()].filter((r) => (r.years[String(year)]?.revenue ?? 0) > 0);
  keep(db, key, data, now);
  return { at: new Date(now).toISOString(), data };
}

/** Fill each row's statements for `year` and the three years before, 100 companies a request. */
async function statements(rows: Map<string, PeerRow>, year: number) {
  const members = [...rows.values()];
  const dates = [year, year - 1, year - 2, year - 3].map((y) => `'${y}-12-31'`).join(",");
  const row = (code: string, date: string) => {
    const r = rows.get(code)!, y = date.slice(0, 4);
    return (r.years[y] ??= { revenue: null, netProfit: null, rd: null, opCost: null, staffCash: null, dividendCash: null, capex: null });
  };
  const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  for (let i = 0; i < members.length; i += 100) { // 100 companies × 4 years fits one 500-row page
    const codes = `(SECUCODE in (${members.slice(i, i + 100).map((c) => `"${c.code}"`).join(",")}))(REPORT_DATE in (${dates}))`;
    for (const r of await f10All("RPT_F10_FINANCE_GINCOME", "SECUCODE,REPORT_DATE,TOTAL_OPERATE_INCOME,PARENT_NETPROFIT,RESEARCH_EXPENSE,OPERATE_COST", codes)) {
      if (!rows.has(r.SECUCODE)) continue;
      Object.assign(row(r.SECUCODE, r.REPORT_DATE), { revenue: num(r.TOTAL_OPERATE_INCOME), netProfit: num(r.PARENT_NETPROFIT), rd: num(r.RESEARCH_EXPENSE), opCost: num(r.OPERATE_COST) });
    }
    await sleep(300);
    for (const r of await f10All("RPT_F10_FINANCE_GCASHFLOW", "SECUCODE,REPORT_DATE,PAY_STAFF_CASH,ASSIGN_DIVIDEND_PORFIT,CONSTRUCT_LONG_ASSET", codes)) {
      if (!rows.has(r.SECUCODE)) continue;
      Object.assign(row(r.SECUCODE, r.REPORT_DATE), { staffCash: num(r.PAY_STAFF_CASH), dividendCash: num(r.ASSIGN_DIVIDEND_PORFIT), capex: num(r.CONSTRUCT_LONG_ASSET) });
    }
    await sleep(300);
  }
}

/** A 新三板 company by name: the code table finds it, its F10 profile gives the industry and staff count. */
async function neeqCompany(name: string): Promise<Company | null> {
  const hit = await resolveNeeq(name, normName(name));
  if (!hit) return null;
  const r = (await f10("RPT_F10_BASIC_ORGINFO", "SECUCODE,SECURITY_NAME_ABBR,ORG_NAME,BOARD_NAME_LEVEL,EMP_NUM,INDUSTRYCSRC1", `(SECUCODE="${hit.code}.NQ")`)).data[0];
  return r?.BOARD_NAME_LEVEL ? { code: r.SECUCODE, name: r.SECURITY_NAME_ABBR ?? hit.name, org: r.ORG_NAME ?? "", industry: r.BOARD_NAME_LEVEL, employees: Number(r.EMP_NUM) > 0 ? Number(r.EMP_NUM) : null, market: "新三板", csrc: r.INDUSTRYCSRC1 ?? "" } : null;
}

/**
 * A Hong Kong or US listing: found the way company.financials finds it, then its annual reports (revenue, net profit,
 * gross margin, R&D) read one by one. Neither market reports cash paid to staff, so there is no pay measure.
 */
async function overseas(name: string): Promise<PeerRow | null> {
  const f: any = await companyFinancials({ name });
  if (f.status === "failed") throw new Error(`${name}：认出了上市公司但数据没取成`);
  const sec = f.status === "listed" ? f.security : null;
  if (!sec || (sec.market !== "港股" && sec.market !== "美股")) return null;
  const hk = sec.market === "港股", code = hk ? `${sec.code}.HK` : sec.code;
  const main = (await f10(hk ? "RPT_HKF10_FN_MAININDICATOR" : "RPT_USF10_FN_GMAININDICATOR", "ALL", `(SECUCODE="${code}")`)).data;
  const annual = main.filter((r) => (hk ? /年报/.test(String(r.REPORT_TYPE)) : r.DATE_TYPE === "年报"));
  await sleep(300);
  const rd = (await f10(hk ? "RPT_HKF10_FN_INCOME_PC" : "RPT_USF10_FN_INCOME", "ALL", hk ? `(SECUCODE="${code}")(STD_ITEM_NAME="研发费用")(DATE_TYPE_CODE="001")` : `(SECUCODE="${code}")(REPORT_TYPE="年报")(ITEM_NAME="研发费用")`).catch(() => ({ data: [] as any[] }))).data;
  const rdOn = new Map(rd.map((r) => [String(r.REPORT_DATE).slice(0, 10), Number(r.AMOUNT)]));
  const years: Record<string, YearRow> = {};
  for (const r of annual) {
    const y = String(hk ? r.REPORT_TYPE : r.REPORT_DATA_TYPE).match(/\d{4}/)?.[0]; // a year ending in March is named by the source, as 「2025年年报」
    if (!y || years[y]) continue;
    const num = (v: unknown) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
    const revenue = num(r.OPERATE_INCOME), gm = num(r.GROSS_PROFIT_RATIO);
    years[y] = { revenue, netProfit: num(hk ? r.HOLDER_PROFIT : r.PARENT_HOLDER_NETPROFIT), rd: rdOn.get(String(r.REPORT_DATE).slice(0, 10)) ?? null, opCost: revenue !== null && gm !== null ? revenue * (1 - gm / 100) : null, staffCash: null, dividendCash: null, capex: null };
  }
  // amounts stay in the report's own currency (东财's CURRENCY names the listing's, not always the report's): only
  // ratios are compared, and they do not depend on it
  return { code, name: sec.name, org: sec.name, industry: f.basic?.industry ?? "", employees: f.basic?.employees ?? null, market: sec.market, approx: !!f.approx, years };
}

/**
 * What Zhiro already holds about a company with no listing, without going out: its funding stage, size and industry as
 * BOSS 直聘 showed them on a search page (the company's own entry there), the 专精特新 roster, and a listing review
 * recorded on its company card. The employer report goes further (funding rounds, investors, filings).
 */
export function unlistedFacts(db: Db, name: string) {
  const n = normName(name);
  const boss = n.length >= 2 ? (db.prepare("select brand, stage, scale, industry, last_seen from boss_candidate order by last_seen desc limit 2000").all() as any[])
    .find((b) => b.brand && b.brand.length >= 2 && (normName(b.brand) === n || n.includes(normName(b.brand)) || normName(b.brand).includes(n))) : undefined;
  const sme = smeMatch(db, name).matches[0];
  const co = db.prepare("select id from company where name = ? or norm = ?").get(name, n) as { id: string } | undefined;
  const ipo = co ? (db.prepare("select data_json, fetched_at from company_intel where company_id = ? and kind = 'ipo'").get(co.id) as any) : undefined;
  const szse = ipo ? JSON.parse(ipo.data_json)?.szse : null;
  return {
    ...(boss ? { boss: { stage: boss.stage, scale: boss.scale, industry: boss.industry, seen: String(boss.last_seen).slice(0, 10) } } : {}),
    ...(sme ? { sme: sme.level } : {}),
    ...(szse ? { ipo: { board: "深交所", stage: szse.stage, date: szse.date ?? "" } } : {}),
  };
}

// ---------- the measures ----------
export type Facet = "growth" | "rd" | "pay" | "profit";
export const FACETS: { key: Facet; label: string; measure: string; note?: string }[] = [
  { key: "growth", label: "成长", measure: "营收三年复合增速" },
  { key: "rd", label: "研发", measure: "研发费用占营收" },
  { key: "pay", label: "待遇信号", measure: "每名员工对应的职工现金支出", note: "粗指标：含奖金、社保、离职补偿，员工数取最新" },
  { key: "profit", label: "盈利", measure: "归母净利润占营收" },
];
const ratio = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || !b || b <= 0 ? null : a / b);
const change = (a: number | null | undefined, b: number | null | undefined) => (a === null || a === undefined || b === null || b === undefined || b === 0 ? null : (a - b) / Math.abs(b));

export function measures(r: PeerRow, year: number) {
  const y = r.years[String(year)] ?? ({} as YearRow), p = r.years[String(year - 1)] ?? ({} as YearRow), b = r.years[String(year - 3)];
  const growth = b && (b.revenue ?? 0) > 0 && (y.revenue ?? 0) > 0 ? (y.revenue! / b.revenue!) ** (1 / 3) - 1 : null;
  return {
    main: { growth, rd: ratio(y.rd, y.revenue), pay: ratio(y.staffCash, r.employees), profit: ratio(y.netProfit, y.revenue) } as Record<Facet, number | null>,
    more: {
      revenue: y.revenue ?? null, netProfit: y.netProfit ?? null, prevNetProfit: p.netProfit ?? null, employees: r.employees,
      revenueChange: change(y.revenue, p.revenue), profitChange: change(y.netProfit, p.netProfit), staffCashChange: change(y.staffCash, p.staffCash), rdChange: change(y.rd, p.rd),
      grossMargin: y.revenue && y.opCost !== null && y.opCost !== undefined ? (y.revenue - y.opCost) / y.revenue : null,
      capexToRevenue: ratio(y.capex, y.revenue), dividendCashToProfit: (y.netProfit ?? 0) > 0 ? ratio(y.dividendCash, y.netProfit) : null,
    },
  };
}

/** Mid-rank percentile of `v` among `values` (0–100): half of the ties count as below. */
export function percentile(values: number[], v: number) {
  let below = 0, same = 0;
  for (const x of values) { if (x < v) below++; else if (x === v) same++; }
  return values.length ? Math.round(((below + same / 2) / values.length) * 100) : null;
}

/** What happened together in the year — never why. */
export function moved(m: ReturnType<typeof measures>["more"]): string[] {
  const out: string[] = [], up = (x: number | null) => x !== null && x > 0.02, down = (x: number | null) => x !== null && x < -0.02;
  const turned = m.prevNetProfit !== null && m.netProfit !== null ? (m.prevNetProfit < 0 && m.netProfit > 0 ? "扭亏为盈" : m.prevNetProfit > 0 && m.netProfit < 0 ? "由盈转亏" : null) : null;
  if (turned) out.push(`营收${up(m.revenueChange) ? "增长" : down(m.revenueChange) ? "下降" : "基本持平"}，${turned}`);
  else if (up(m.revenueChange) && up(m.profitChange)) out.push("营收和利润同时增长");
  else if (up(m.revenueChange) && down(m.profitChange)) out.push("营收增长、利润下降（增收不增利）");
  else if (down(m.revenueChange) && up(m.profitChange)) out.push(`营收下降、利润增长${down(m.staffCashChange) || down(m.rdChange) ? `；同期${[down(m.staffCashChange) && "职工现金", down(m.rdChange) && "研发费用"].filter(Boolean).join("、")}减少，利润可能来自压缩成本（待核实）` : ""}`);
  else if (down(m.revenueChange) && down(m.profitChange)) out.push("营收和利润同时下降");
  if (up(m.profitChange) && down(m.staffCashChange) && !down(m.revenueChange)) out.push("利润增长的同时职工现金减少（可能减员或降薪，待核实）");
  if (m.netProfit !== null && m.netProfit < 0 && turned !== "由盈转亏") out.push("当年亏损");
  return out;
}

/** Plain rules on the percentiles; the rule is shown with the label. */
export function labels(pct: Record<Facet, number | null>): { label: string; rule: string }[] {
  const out: { label: string; rule: string }[] = [], at = (k: Facet, n: number) => (pct[k] ?? -1) >= n;
  if (at("rd", 75) && at("growth", 50)) out.push({ label: "研发驱动", rule: "研发百分位 ≥ 75 且成长 ≥ 50" });
  else if (at("growth", 75)) out.push({ label: "高成长", rule: "成长百分位 ≥ 75" });
  if (at("profit", 75) && pct.growth !== null && pct.growth < 50) out.push({ label: "稳健盈利", rule: "盈利百分位 ≥ 75 且成长 < 50" });
  if (at("pay", 75)) out.push({ label: "职工现金支出靠前", rule: "待遇信号百分位 ≥ 75" });
  return out;
}

// ---------- ranking under preferences ----------
export const SCENARIOS: Record<string, Record<Facet, number>> = {
  成长研发优先: { growth: 0.35, rd: 0.35, pay: 0.15, profit: 0.15 },
  均衡: { growth: 0.25, rd: 0.25, pay: 0.25, profit: 0.25 },
  稳定回报优先: { growth: 0.15, rd: 0.15, pay: 0.35, profit: 0.35 },
};
const KEYS = FACETS.map((f) => f.key);

/** A small seeded generator, so the same data and weights give the same answer. */
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
/** Weights drawn evenly over all weightings, kept when each is within `spread` of `center` (spread 1 = any weighting). */
export function sampleWeights(center: Record<Facet, number>, spread: number, n: number, seed = 1): Record<Facet, number>[] {
  const r = rng(seed), out: Record<Facet, number>[] = [];
  for (let tries = 0; out.length < n && tries < n * 2000; tries++) {
    const e = KEYS.map(() => -Math.log(1 - r())), s = e.reduce((a, b) => a + b, 0);
    const w = Object.fromEntries(KEYS.map((k, i) => [k, e[i] / s])) as Record<Facet, number>;
    if (KEYS.every((k) => Math.abs(w[k] - center[k]) <= spread)) out.push(w);
  }
  return out;
}
const score = (p: Record<Facet, number | null>, w: Record<Facet, number>, fill?: number) => KEYS.reduce((a, k) => a + w[k] * (p[k] ?? fill ?? 0), 0);
const rankOf = (mine: number, others: number[]) => 1 + others.filter((x) => x > mine).length;
const q = (xs: number[], f: number) => { const s = [...xs].sort((a, b) => a - b); return s[Math.min(s.length - 1, Math.floor(f * s.length))]; };

export interface Pick { code: string; pct: Record<Facet, number | null> }
/**
 * Places of the complete picks under one preference: the place at the weights as given, and over weights drawn near
 * them the usual range (10th–90th) and how often in the top three. A pick missing a measure gets a place among the
 * complete ones by what is known, and the best and worst it could be with the missing value at 100 or 0.
 */
export function placeUnder(picks: Pick[], center: Record<Facet, number>, spread: number, n = 2000, seed = 1) {
  const complete = picks.filter((p) => KEYS.every((k) => p.pct[k] !== null));
  const samples = sampleWeights(center, spread, n, seed);
  const ranks = new Map<string, number[]>(complete.map((p) => [p.code, []]));
  for (const w of samples) {
    const s = complete.map((p) => score(p.pct, w));
    complete.forEach((p, i) => ranks.get(p.code)!.push(rankOf(s[i], s.filter((_, j) => j !== i))));
  }
  const at = complete.map((p) => score(p.pct, center));
  const out = new Map<string, any>();
  complete.forEach((p, i) => {
    const r = ranks.get(p.code)!;
    out.set(p.code, { place: rankOf(at[i], at.filter((_, j) => j !== i)), usually: [q(r, 0.1), q(r, 0.9)], top3Share: r.length && complete.length > 3 ? Math.round((r.filter((x) => x <= 3).length / r.length) * 20) * 5 : null }); // three or fewer complete: always in the top three, which says nothing
  });
  for (const p of picks.filter((x) => !complete.includes(x))) {
    const known = KEYS.filter((k) => p.pct[k] !== null), wsum = known.reduce((a, k) => a + center[k], 0);
    const cond = wsum ? known.reduce((a, k) => a + (center[k] / wsum) * p.pct[k]!, 0) : null;
    out.set(p.code, {
      place: null, byKnown: cond === null ? null : rankOf(cond, at), best: rankOf(score(p.pct, center, 100), at), worst: rankOf(score(p.pct, center, 0), at),
      missing: KEYS.filter((k) => p.pct[k] === null),
    });
  }
  return { samples: samples.length, places: out };
}

/** Picks no other complete pick matches or beats on every measure (and beats on one); the rest say who does. */
export function notOutdone(picks: Pick[]) {
  const complete = picks.filter((p) => KEYS.every((k) => p.pct[k] !== null));
  const beats = (a: Pick, b: Pick) => KEYS.every((k) => a.pct[k]! >= b.pct[k]!) && KEYS.some((k) => a.pct[k]! > b.pct[k]!);
  return new Map(complete.map((p) => [p.code, complete.filter((o) => o !== p && beats(o, p)).map((o) => o.code)]));
}

// ---------- the comparison ----------
/** Find a listed company by code (300124 / 300124.SZ), short name, or legal name. */
export function findCompany(all: Company[], query: string): Company | { candidates: Company[] } | null {
  const s = query.trim();
  const code = s.match(/^(\d{6})(\.(SZ|SH|BJ))?$/i);
  if (code) return all.find((c) => c.code.startsWith(code[1])) ?? null;
  const exact = all.filter((c) => c.name === s || c.org === s);
  if (exact.length) return exact[0];
  const n = normName(s);
  const near = n.length >= 2 ? all.filter((c) => normName(c.org) === n || c.name.replace(/\s/g, "") === n || normName(c.org).includes(n)) : [];
  return near.length === 1 ? near[0] : near.length ? { candidates: near.slice(0, 5) } : null;
}

export async function compare(db: Db, q: { companies: string[]; weights?: Partial<Record<Facet, number>>; spread?: number; year?: number; peerIndustry?: string }, now = Date.now()) {
  const year = q.year ?? latestYear(now);
  const uni = await universe(db, now);
  const found: Company[] = [], notFound: { query: string; reason: string; candidates?: string[]; known?: ReturnType<typeof unlistedFacts> }[] = [];
  const elsewhere: string[] = [];
  for (const name of q.companies.slice(0, 15)) {
    const c = findCompany(uni.data, name) ?? (await remembered(db, `neeq:${name}`, now, () => neeqCompany(name)).catch(() => null));
    if (!c) elsewhere.push(name);
    else if ("candidates" in c) notFound.push({ query: name, reason: "有几家名字相近，用股票代码再查", candidates: c.candidates.map((x) => `${x.name} ${x.code}`) });
    else if (!found.some((f) => f.code === c.code)) found.push(c);
  }
  // 港股 / 美股 have no 申万 industry: they are measured against the one asked for, else the one most of the A-share
  // companies here are in
  const tops = found.filter((c) => !c.market).map((c) => sector(c.industry));
  const peerSw = q.peerIndustry?.trim() || [...new Set(tops)].sort((a, b) => tops.filter((x) => x === b).length - tops.filter((x) => x === a).length)[0];
  const abroad = new Map<string, PeerRow>();
  for (const name of elsewhere) {
    const r = await remembered(db, `abroad:${name}`, now, () => overseas(name)).catch(() => null);
    if (!r) notFound.push({ query: name, reason: "不是 A 股、新三板、港股或美股上市公司（或名字写法不同）；未上市公司没有公开财报，放不进这张表", known: unlistedFacts(db, name) });
    else if (!peerSw) notFound.push({ query: name, reason: `${r.market}公司没有申万行业：和 A 股公司一起比，或给出拿哪个申万一级行业当同行（peerIndustry）` });
    else if (!uni.data.some((c) => sector(c.industry) === peerSw)) notFound.push({ query: name, reason: `没有叫「${peerSw}」的申万一级行业` });
    else if (!found.some((f) => f.code === r.code)) { r.peerSw = peerSw; abroad.set(r.code, r); found.push(r); }
  }
  const pools = new Map<string, { at: string; data: PeerRow[] }>();
  for (const c of found) { const g = peerGroup(c); if (!pools.has(g.label)) pools.set(g.label, await industryPool(db, g, year, uni.data, now)); }
  // 新三板 companies are measured with the A-share yardstick of their industry; their own statements are read here
  const outside = new Map<string, PeerRow>(found.filter((c) => c.market === "新三板").map((c) => [c.code, { ...c, years: {} }]));
  if (outside.size) await statements(outside, year);

  const rows = found.map((c) => {
    const pool = pools.get(peerGroup(c).label)!;
    const other = outside.get(c.code) ?? abroad.get(c.code);
    const me = pool.data.find((r) => r.code === c.code) ?? (other?.years[String(year)]?.revenue ? other : undefined);
    if (!me) return { company: c, missingYear: true as const };
    const m = measures(me, year);
    const all = pool.data.map((r) => measures(r, year).main);
    const pct = Object.fromEntries(KEYS.map((k) => {
      const v = m.main[k];
      return [k, v === null ? null : percentile(all.map((x) => x[k]).filter((x): x is number => x !== null), v)];
    })) as Record<Facet, number | null>;
    const n = Object.fromEntries(KEYS.map((k) => [k, all.filter((x) => x[k] !== null).length])) as Record<Facet, number>;
    return { company: c, years: me.years, value: m.main, pct, peers: n, more: m.more, moved: moved(m.more), labels: labels(pct), coverage: KEYS.filter((k) => m.main[k] !== null).length };
  });
  const ok = rows.filter((r): r is Extract<typeof r, { pct: any }> => "pct" in r);
  const picks: Pick[] = ok.map((r) => ({ code: r.company.code, pct: r.pct }));
  const spread = Math.max(0.02, Math.min(1, q.spread ?? 0.1));
  const scenarios: Record<string, Record<Facet, number>> = { ...SCENARIOS };
  if (q.weights) {
    const w = Object.fromEntries(KEYS.map((k) => [k, Math.max(0, q.weights![k] ?? 0)])) as Record<Facet, number>, s = KEYS.reduce((a, k) => a + w[k], 0);
    if (s > 0) scenarios.你设的权重 = Object.fromEntries(KEYS.map((k) => [k, w[k] / s])) as Record<Facet, number>;
  }
  const under = Object.fromEntries(Object.entries(scenarios).map(([name, w]) => [name, { weights: w, ...placeUnder(picks, w, spread) }]));
  const any = placeUnder(picks, SCENARIOS.均衡, 1, 4000, 2); // every weighting at all
  const outdone = notOutdone(picks);

  return {
    year, peerGroup: "同一行业的全部 A 股上市公司（当年有营收的）：A 股公司按申万一级，新三板公司按证监会行业",
    data: { universeAt: uni.at, pools: Object.fromEntries([...pools].map(([k, v]) => [k, { at: v.at, companies: v.data.length }])), source: "东方财富 F10：公司概况、利润表、现金流量表（年报）" },
    measures: FACETS,
    companies: rows.map((r) => {
      if (!("pct" in r)) return { code: r.company.code, name: r.company.name, org: r.company.org, industry: r.company.industry, market: r.company.market ?? "A股", note: /^[A-Z]/.test(r.company.code) ? `在申报上市（申报代码 ${r.company.code}），还没有公开的年报` : `没有 ${year} 年报数据（可能是当年之后才上市）` };
      return {
        code: r.company.code, name: r.company.name, org: r.company.org, industry: r.company.industry, market: r.company.market ?? "A股",
        peerGroup: peerGroup(r.company).label, ...(r.company.market === "新三板" ? { yardstick: "新三板公司，按同一证监会行业的 A 股上市公司来量" } : {}),
        ...(/^[A-Z]/.test(r.company.code) ? { yardstick: `在申报上市（申报代码 ${r.company.code}），财务数据来自申报材料，按同行业 A 股上市公司来量` } : {}),
        ...(r.company.peerSw ? { yardstick: `${r.company.market}公司，按申万一级「${r.company.peerSw}」的 A 股上市公司来量；不披露支付给职工的现金，待遇信号缺；金额是公司财报自己的币种，比较的都是比例，不受币种影响${r.company.approx ? `；「${r.company.name}」是按名字相近认的，请核对是不是你要的那家` : ""}` } : {}),
        years: r.years, value: r.value, percentile: r.pct, peers: r.peers, coverage: `${r.coverage}/4`, more: r.more, movedTogether: r.moved, labels: r.labels,
        outdoneBy: outdone.has(r.company.code) ? outdone.get(r.company.code)!.map((c) => ok.find((x) => x.company.code === c)!.company.name) : null,
        under: Object.fromEntries(Object.entries(under).map(([k, v]) => [k, v.places.get(r.company.code)])),
        anyWeighting: any.places.get(r.company.code)?.top3Share ?? null,
      };
    }),
    scenarios: Object.fromEntries(Object.entries(under).map(([k, v]) => [k, { weights: v.weights, samples: v.samples }])),
    spread, notFound,
    method: `每项先在本行业同行里算百分位（越高越好），名次只在这几家之间排。「通常第 a–b 名」是在所选权重上下各 ${Math.round(spread * 100)} 个百分点内随机抽权重（固定种子）时名次的 10%–90% 范围；「进前三的比例」是这些权重里排进前三的占比，是偏好情景的比例，不是现实概率。缺数据的不估值，只给按已知指标的名次和最好 / 最坏情况。`,
  };
}

// ---------- the facts at the top of an employer report ----------
const yi = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v / 1e8).toFixed(2)} 亿`);
const pc = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${(v * 100).toFixed(1)}%`);
/**
 * The fact table Zhiro puts at the top of an employer report (the agent writes what follows). `c` is one company from
 * compare(); every number here is from the snapshot it names.
 */
export function factsMarkdown(c: any, r: { year: number; data: any; peerGroup: string }): string {
  if (!c.years) return `## 一、事实（职路取数）\n\n${c.note ?? "不是 A 股上市公司，职路没有它的同行数据。"}\n`;
  const ys = Object.keys(c.years).sort().reverse().slice(0, 4);
  const row = (label: string, f: (y: YearRow) => string) => `| ${label} | ${ys.map((y) => f(c.years[y])).join(" | ")} |`;
  const pool = r.data.pools[c.peerGroup];
  return [
    `## 一、事实（职路取数，${r.year} 年报口径）`, "",
    `${c.name}（${c.code}）· ${c.industry} · 员工 ${c.more.employees ?? "—"} 人（最新）`, "",
    `| 年份 | ${ys.join(" | ")} |`, `|---|${ys.map(() => "---").join("|")}|`,
    row("营业总收入", (y) => yi(y.revenue)), row("归母净利润", (y) => yi(y.netProfit)), row("研发费用", (y) => yi(y.rd)),
    row("支付给职工的现金", (y) => yi(y.staffCash)), row("分配股利、利润或偿付利息的现金", (y) => yi(y.dividendCash)), row("购建长期资产的现金", (y) => yi(y.capex)), "",
    `在${c.peerGroup} ${pool?.companies ?? "?"} 家 A 股公司里的位置（百分位越高越好）${c.yardstick ? `；${c.yardstick}` : ""}：`, "",
    ...FACETS.map((f) => `- ${f.label}（${f.measure}）：${f.key === "pay" ? (c.value.pay === null ? "—" : `${(c.value.pay / 1e4).toFixed(1)} 万/人`) : pc(c.value[f.key])}，同行第 ${c.percentile[f.key] ?? "—"} 百分位${f.note ? `（${f.note}）` : ""}`),
    `- 毛利率 ${pc(c.more.grossMargin)}；购建长期资产占营收 ${pc(c.more.capexToRevenue)}；分配股利和偿付利息的现金占净利 ${pc(c.more.dividendCashToProfit)}（含利息，不全是分红）`,
    ...(c.movedTogether.length ? [`- ${r.year} 年同期一起发生的：${c.movedTogether.join("；")}`] : []),
    ...(c.labels.length ? [`- 规则标签：${c.labels.map((l: any) => `${l.label}（${l.rule}）`).join("；")}`] : []),
    "", `来源：${r.data.source}，取数 ${pool?.at?.slice(0, 10) ?? "?"}。`, "",
  ].join("\n");
}
