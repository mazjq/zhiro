/**
 * 行业研报 (docs/plans/2026-10-13-research-loop.md 第 2 块): what brokers have written lately about an industry or a
 * theme — title, house, date, rating, and where to read it. From 东方财富's report centre: free, no key. These are
 * opinions, not facts; whoever uses them says which house said it and when. Nothing is stored: asked for, answered.
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128.0 Safari/537.36";
const get = async (url: string): Promise<any> => {
  const res = await fetch(url, { signal: AbortSignal.timeout(15_000), headers: { "user-agent": UA, referer: "https://data.eastmoney.com/report/" } });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${url}`);
  return res.json();
};
const day = (d: Date) => d.toISOString().slice(0, 10);
const listUrl = (industryCode: string, from: string, to: string, size: number, page = 1) =>
  `https://reportapi.eastmoney.com/report/list?industryCode=${industryCode}&pageSize=${size}&industry=*&rating=*&ratingChange=*&beginTime=${from}&endTime=${to}&pageNo=${page}&fields=&qType=1`;

export interface IndustryReport { title: string; org: string; date: string; industry: string; rating: string; pages: number; url: string; pdf: string }

/** One row of the listing as the card and the agent get it. Exported for tests. */
export function toReport(r: any): IndustryReport {
  const code = String(r?.infoCode ?? "");
  return {
    title: String(r?.title ?? ""), org: String(r?.orgSName ?? r?.orgName ?? ""), date: String(r?.publishDate ?? "").slice(0, 10), industry: String(r?.industryName ?? ""), rating: String(r?.emRatingName ?? ""), pages: Number(r?.attachPages ?? 0),
    url: code ? `https://data.eastmoney.com/report/zw_industry.jshtml?infocode=${code}` : "", pdf: code ? `https://pdf.dfcfw.com/pdf/H3_${code}_1.pdf` : "",
  };
}

/** The industries whose name is what was asked for, or part of it, or has it as a part (「机器人」 → 机器人; 「汽车零部件行业」 → 汽车零部件). Exported for tests. */
export function matchIndustries(query: string, all: { bkCode: string; bkName: string }[]): { code: string; name: string }[] {
  const q = query.trim().replace(/行业$/, "");
  if (q.length < 2) return [];
  const name = (s: string) => s.replace(/[ⅠⅡⅢ]+$/, "");
  return all.filter((b) => name(b.bkName).length >= 2 && (name(b.bkName).includes(q) || q.includes(name(b.bkName)))).slice(0, 3).map((b) => ({ code: b.bkCode, name: b.bkName }));
}

/** Newest first, a report once, the ones whose title carries the words ahead of those that only share the industry. Exported for tests. */
export function mergeReports(query: string, byTitle: any[], byIndustry: any[], limit: number): IndustryReport[] {
  const q = query.trim();
  const seen = new Set<string>(), out: (IndustryReport & { hit: number })[] = [];
  for (const r of [...byTitle, ...byIndustry]) {
    const code = String(r?.infoCode ?? "");
    if (!code || seen.has(code)) continue;
    seen.add(code);
    out.push({ ...toReport(r), hit: String(r?.title ?? "").includes(q) ? 1 : 0 });
  }
  return out.sort((a, b) => b.hit - a.hit || b.date.localeCompare(a.date)).slice(0, limit).map(({ hit: _hit, ...r }) => r);
}

export async function industryReports(p: { query: string; days?: number; limit?: number }) {
  const query = p.query.trim();
  if (query.length < 2) throw Object.assign(new Error("MISSING_FIELD: 要说明行业或主题，至少两个字"), { code: "MISSING_FIELD" });
  const days = Math.min(Math.max(p.days ?? 90, 7), 365), limit = Math.min(p.limit ?? 20, 50);
  const to = day(new Date()), from = day(new Date(Date.now() - days * 86400_000));
  const industries = matchIndustries(query, (await get("https://reportapi.eastmoney.com/report/bk?bkCode=016&pageSize=600"))?.data ?? []);
  // by title across every industry: the newest thousand (about a month of them), five pages at a time — enough for a
  // theme that is in the news (人形机器人 sits under 通用设备, 汽车零部件 …); an older report is found under its industry
  const recent: any[] = [];
  for (let first = 1; first <= 10; first += 5) {
    const pages = await Promise.all([0, 1, 2, 3, 4].map((k) => get(listUrl("*", from, to, 100, first + k)).then((x) => (x?.data ?? []) as any[])));
    recent.push(...pages.flat());
    if (pages.some((rows) => rows.length < 100)) break;
  }
  const byIndustry: any[] = [];
  for (const i of industries) byIndustry.push(...((await get(listUrl(i.code, from, to, 30)))?.data ?? []));
  const items = mergeReports(query, recent.filter((r) => String(r?.title ?? "").includes(query)), byIndustry, limit);
  return { query, from, to, industries: industries.map((i) => i.name), items, note: "研报是券商的观点，不是事实；引用时写明哪家、哪天。标题含主题词的排在前面，其余是同一行业分类下的最新研报。" };
}
