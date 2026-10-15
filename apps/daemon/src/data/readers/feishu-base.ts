import { gunzipSync } from "node:zlib";
import type { Listing, Source } from "../types.js";
import { BUILTIN_COLUMNS, listingsFromTable, tableToListings, type Columns, type Table } from "../sheet.js";

/**
 * 飞书多维表格（/base/<token>?table=…&view=…）that is shared "anyone with the link can view".
 * No app, no login: the web client's own read endpoints work with the anonymous session the share page hands out.
 *   1. GET the share URL following redirects by hand, keeping cookies  → anonymous session
 *   2. GET …/clientvars?recordLimit=1                                  → field definitions (gzip+base64)
 *   3. GET …/records?offset=&limit=3000 until a short page             → all rows (server caps a page at 3000)
 * Columns are the 17-column 校招汇总表 layout that import.csv already understands.
 * ponytail: private web endpoints, not the Open API — if Feishu changes them this source fails loudly into scan_run;
 * the upgrade path is an Open API app once the sheet owner grants one access.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const PAGE = 3000;

export function parseBaseUrl(url: string): { origin: string; base: string; table: string; view: string } | null {
  try {
    const u = new URL(url);
    const m = /^\/base\/([A-Za-z0-9]+)/.exec(u.pathname);
    const table = u.searchParams.get("table");
    if (!/\.(feishu\.cn|larksuite\.com)$/.test(u.hostname) || !m || !table) return null;
    return { origin: u.origin, base: m[1], table, view: u.searchParams.get("view") ?? "" };
  } catch { return null; }
}

async function anonymousCookies(url: string, signal?: AbortSignal): Promise<string> {
  const jar = new Map<string, string>();
  let next = url;
  for (let i = 0; i < 12; i++) {
    const res = await fetch(next, { redirect: "manual", signal, headers: { "user-agent": UA, "accept-language": "zh-CN,zh", cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } });
    for (const c of res.headers.getSetCookie()) { const [kv] = c.split(";"); const eq = kv.indexOf("="); jar.set(kv.slice(0, eq).trim(), kv.slice(eq + 1).trim()); }
    const loc = res.headers.get("location");
    if (res.status < 300 || res.status >= 400 || !loc) break;
    next = new URL(loc, next).href;
  }
  if (!jar.has("session")) throw new Error("NOT_PUBLIC: 这张表没有开「互联网上获得链接的人可阅读」，或链接已失效");
  return [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
}

const unzip = (s: string) => JSON.parse(gunzipSync(Buffer.from(s, "base64")).toString("utf8"));

type FieldMap = Record<string, { name: string; type: number; property?: { options?: { id: string; name: string }[] } }>;
type RecordMap = Record<string, Record<string, { value: unknown }>>;

/** A Bitable as a table: the cell under a column name, as text (an option's name, a date in 北京时间) or as the link behind it. */
export function toTable(fieldMap: FieldMap, recordMap: RecordMap): Table {
  const byName = Object.fromEntries(Object.entries(fieldMap).map(([id, f]) => [f.name.trim(), { id, ...f }]));
  const cell = (rec: RecordMap[string], name: string, want: "text" | "link" = "text"): string => {
    const f = byName[name];
    const v = f && rec[f.id]?.value;
    if (v == null) return "";
    const opt = (id: unknown) => f.property?.options?.find((o) => o.id === id)?.name ?? "";
    if (typeof v === "number") return new Date(v + 8 * 3600_000).toISOString().slice(0, 10); // 表里的日期按北京时间
    if (typeof v === "string") return opt(v) || v;
    if (Array.isArray(v)) return v.map((x: any) => (typeof x === "string" ? opt(x) : want === "link" ? x?.link ?? "" : x?.text ?? "")).filter(Boolean).join(typeof v[0] === "string" ? "、" : "");
    return "";
  };
  return { headers: Object.keys(byName), rows: Object.entries(recordMap).map(([id, rec]) => ({ id, get: (h, want) => cell(rec, h, want) })) };
}

/** Pure: Bitable rows → listings by the subscription's column mapping (the built-in 17-column one when it has none). */
export function rowsToListings(fieldMap: FieldMap, recordMap: RecordMap, cfg: { cohort?: string; name?: string; columns?: Record<string, string> }, today = new Date().toISOString().slice(0, 10)): Listing[] {
  return tableToListings(toTable(fieldMap, recordMap), (cfg.columns as Columns | undefined) ?? BUILTIN_COLUMNS, cfg, today, "飞书汇总表");
}

export const feishuBase: Source = {
  id: "feishu-base",
  name: "飞书多维表格", input: "公开的 feishu.cn/base/…?table=… 链接", aggregate: true,
  mode: "pull",
  describe: "飞书多维表格（公开链接，匿名读取）：按订阅里存的列对应读成岗位，没有对应时按内置 17 列格式；按届次过滤，跳过已截止的行",
  detect: (url) => !!parseBaseUrl(url),
  siteKey: (url) => { const u = parseBaseUrl(url)!; return `${u.base}/${u.table}`; },
  async table(config, ctx) {
    const { fieldMap, records } = await readBase(config.url ?? "", (m) => ctx.log(`feishu-base ${config.id}: ${m}`), ctx.signal);
    return toTable(fieldMap, records);
  },
  async fetch(config, ctx) { return listingsFromTable(await this.table!(config, ctx), config, "飞书汇总表"); },
};

/** Any public Bitable: its fields and all rows (also used to read a 专精特新 list the user keeps in a sheet). */
export async function readBase(url: string, log: (m: string) => void = () => {}, signal?: AbortSignal): Promise<{ fieldMap: FieldMap; records: RecordMap }> {
  const u = parseBaseUrl(url);
  if (!u) throw new Error(`BAD_URL: 需要 https://<tenant>.feishu.cn/base/<token>?table=…，收到 ${url}`);
  const cookie = await anonymousCookies(url, signal);
  const api = `${u.origin}/space/api/v1/bitable/${u.base}`;
  const get = async (path: string) => {
    const res = await fetch(api + path, { signal: signal ?? AbortSignal.timeout(90_000), headers: { cookie, "user-agent": UA, referer: `${u.origin}/base/${u.base}` } });
    const j = (await res.json()) as any;
    if (j.code !== 0) throw new Error(`FAILED: 飞书接口 ${j.code}：${j.msg}`);
    return j.data;
  };
  const q = `tableID=${u.table}&viewID=${u.view}`;
  const head = unzip((await get(`/clientvars?${q}&recordLimit=1&ondemandLimit=1&needBase=false&viewLazyLoad=true&openType=0`)).table);
  const total: number = head.meta?.recordsNum ?? 0;
  const records: RecordMap = {};
  for (let offset = 0; offset < Math.max(total, 1); offset += PAGE) {
    const page = unzip((await get(`/records?${q}&offset=${offset}&limit=${PAGE}`)).records).recordMap ?? {};
    Object.assign(records, page);
    log(`${Object.keys(records).length}/${total}`);
    if (Object.keys(page).length < PAGE) break;
    await new Promise((r) => setTimeout(r, 800));
  }
  if (total && Object.keys(records).length < total * 0.9) throw new Error(`FAILED: 只拿到 ${Object.keys(records).length}/${total} 行`);
  return { fieldMap: head.fieldMap, records };
}
