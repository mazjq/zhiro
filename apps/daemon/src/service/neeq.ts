import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

/**
 * 新三板 (NEEQ, not 北交所) for 企业情况 (ADR-029 note 2026-09-28): 巨潮 no longer carries these companies, yet their
 * annual reports hold what a candidate wants of a mid-size non-listed employer — headcount, R&D staff, staff pay.
 * 东财 codetable (short name → code), 股转 detailCompany + infoResult (needs X-Requested-With, else a 307 cookie dance),
 * the report PDF (302 + C3VK cookie, replayed), pdftotext -raw; figures from 东财 xinsanban F10. All anonymous.
 */
const UA = { "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36" };
const XHR = { ...UA, "content-type": "application/x-www-form-urlencoded", "x-requested-with": "XMLHttpRequest" };
const run = promisify(execFile);
const timeout = () => AbortSignal.timeout(20_000);
const jsonp = (t: string) => JSON.parse(t.trim().replace(/^null\(/, "").replace(/\)$/, ""));
const neeq = async (path: string, body: string) => {
  const r = await fetch("https://www.neeq.com.cn" + path, { method: "POST", headers: XHR, body, signal: timeout() });
  if (!r.ok) throw new Error(`HTTP ${r.status} neeq${path}`);
  return jsonp(await r.text());
};
const norm = (s: string) => s.replace(/[\s（）()]/g, "").replace(/(股份有限公司|有限责任公司|有限公司|集团)$/g, "");

/** 东财 codetable search: a 三板 hit whose short name matches. Full legal names return nothing, so the legal suffix goes first. */
export function pickNeeq(name: string, hits: { code: string; shortName: string; securityTypeName: string }[]) {
  const n = norm(name);
  // 「吉田股份」 is 山东吉田香料: a short name ending in 股份 has to start the company's name
  const h = hits.filter((x) => x.securityTypeName === "三板").find((x) => { const s = norm(x.shortName).replace(/股份$/, ""); return n === s || (s.length >= 3 && n.includes(s)) || (s.length >= 2 && n.startsWith(s)) || s.includes(n); });
  return h ? { code: h.code, orgId: "", market: "新三板", name: h.shortName } : null;
}
/** `short` is the name without place and legal suffix (intel's normName); the codetable only knows short names, so its head is tried too. */
export async function resolveNeeq(name: string, short = norm(name)) {
  for (const k of [...new Set([short, short.slice(0, 4), short.slice(0, 3), short.slice(0, 2)])].filter((k) => k.length >= 2)) {
    const r = await fetch(`https://search-codetable.eastmoney.com/codetable/search/web?client=web&clientType=webSuggest&clientVersion=lastest&pageIndex=1&pageSize=10&keyword=${encodeURIComponent(k)}`, { headers: UA, signal: timeout() });
    const hit = pickNeeq(short, (await r.json())?.result ?? []);
    if (hit) return hit;
  }
  return null;
}

/** 在职员工 table of a NEEQ annual report as pdftotext -raw prints it: blank cells vanish, so the last number is 期末. */
export function parseStaff(text: string) {
  const at = text.indexOf("在职员工");
  const sec = at < 0 ? "" : text.slice(at, at + 1500);
  const row = (label: string, t = sec) => {
    const l = t.split(/\r?\n/).find((x) => x.startsWith(label) && /^[^\d%]*[\d,\s]+$/.test(x));
    return l ? Number(l.match(/[\d,]+/g)!.pop()!.replace(/,/g, "")) : null;
  };
  return { employees: row("员工总计"), rdStaff: row("研发人员合计", text) ?? row("研发"), techStaff: row("技术人员") };
}

/** 股转 NEEQ report PDF: the CDN answers 302 with a C3VK cookie that only has to be sent back. */
async function pdf(url: string): Promise<Buffer> {
  let cookie = "";
  for (let i = 0; i < 3; i++) {
    const r = await fetch(url, { redirect: "manual", headers: { ...UA, referer: "https://www.neeq.com.cn/", ...(cookie ? { cookie } : {}) }, signal: AbortSignal.timeout(60_000) });
    if (r.status === 200) return Buffer.from(await r.arrayBuffer());
    cookie = (r.headers.get("set-cookie") ?? "").split(";")[0];
    await r.arrayBuffer();
  }
  throw new Error(`PDF ${url}`);
}

export async function fetchNeeqBasic(code: string) {
  const b = (await neeq("/nqhqController/detailCompany.do", `zqdm=${code}`))?.baseinfo ?? {};
  const list: any[] = (await neeq("/disclosureInfoController/infoResult.do", `disclosureType=1&page=0&companyCd=${code}&isNewThree=1&keyword=${encodeURIComponent("年度报告")}`))?.[0]?.listInfo?.content ?? [];
  const ar = list.find((a) => /\d{4}年年度报告$/.test(a.disclosureTitle ?? "")); // not 摘要 / 更正 / 半年度
  const d = String(b.listingDate ?? "");
  const out: any = {
    orgName: b.name ?? "", industry: b.industry ?? "", market: `新三板${b.xxfcbj === "1" ? "创新层" : b.xxfcbj === "0" ? "基础层" : ""}`, transferMode: b.transferMode ?? "",
    listed: d.length === 8 ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : "", employees: null, rdStaff: null,
  };
  if (!ar) return out;
  out.report = { title: String(ar.disclosureTitle).replace(/^\[[^\]]+\]/, ""), date: ar.publishDate, url: "https://www.neeq.com.cn" + ar.destFilePath };
  const dir = mkdtempSync(join(tmpdir(), "jobos-neeq-"));
  try {
    writeFileSync(join(dir, "a.pdf"), await pdf(out.report.url));
    const { stdout } = await run("pdftotext", ["-raw", "-enc", "UTF-8", join(dir, "a.pdf"), "-"], { maxBuffer: 64 * 1024 * 1024 });
    Object.assign(out, parseStaff(stdout), { staffYear: out.report.title.match(/(\d{4})年/)?.[1] ?? "" });
  } catch (e: any) { out.staffError = String(e?.message ?? e).slice(0, 200); } // headcount lost, the rest of the card still lands
  finally { rmSync(dir, { recursive: true, force: true }); }
  return out;
}

/** 东财 xinsanban F10: annual income + cash-flow rows (and the latest interim), same shape as the A股 finance kind. */
export function neeqFinance(lrb: any[], xj: any[]) {
  const pay = new Map(xj.map((r) => [String(r.REPORTDATE).slice(0, 10), Number(r.EMPLOYEEPAY) || null]));
  const yoy = (a: any, b: any) => (a != null && b ? ((a - b) / Math.abs(b)) * 100 : null);
  const pick = (r: any) => {
    const date = String(r.REPORTDATE).slice(0, 10), prev = lrb.find((x) => String(x.REPORTDATE).slice(0, 10) === `${Number(date.slice(0, 4)) - 1}${date.slice(4)}`);
    const rev = Number(r.OPERATEREVE) || null, np = Number(r.PARENTNETPROFIT) || null;
    return { period: date.endsWith("12-31") ? `${date.slice(0, 4)}年报` : date, revenue: rev, netProfit: np, revenueYoy: yoy(rev, Number(prev?.OPERATEREVE)), netProfitYoy: yoy(np, Number(prev?.PARENTNETPROFIT)), rdExpense: Number(r.RDEXP) || null, staffCash: pay.get(date) ?? null };
  };
  const annual = lrb.filter((r) => String(r.REPORTDATE).includes("12-31")).slice(0, 3).map(pick);
  const latest = lrb[0] && !String(lrb[0].REPORTDATE).includes("12-31") ? pick(lrb[0]) : null;
  return { latest, annual };
}
export async function fetchNeeqFinance(code: string) {
  const get = async (t: string) => (await (await fetch(`https://xinsanban.eastmoney.com/api/F10/Finance/${t}?MSECUCODE=${code}&dateType=0&rank=8`, { headers: UA, signal: timeout() })).json())?.result ?? [];
  return neeqFinance(await get("Lrb"), await get("Xjllb"));
}
