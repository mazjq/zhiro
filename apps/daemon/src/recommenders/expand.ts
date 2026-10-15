import type { Recommender, Hit } from "./index.js";
import { sourceFor, siteKeyOf, isAggregate } from "../data/index.js";
import type { Services } from "../registry.js";
import { unitIndex, unitKey } from "../service/same-company.js";
import { openCampaigns } from "../service/deadlines.js";

const ENGINEERING = /能源|化工|电力|制造|电子|通信|半导体|互联网|人工智能|软件|科技|航空|航天|国防|军工|船舶|轨道|汽车|车企|机械|装备|电气|矿产|钢铁|科研|研究所|机器人|智能硬件/;
/**
 * Sites we deliberately do not read by program (ADR-033: 中国石油 sits behind 瑞数 anti-bot; getting through means hiding
 * automation, which the user declined 2026-09-30). The hint tells the agent the way that remains.
 */
const MANUAL: Record<string, string> = {
  "zhaopin.cnpc.com.cn": "入口 zhaopin.cnpc.com.cn 有反爬，不自动读取：在本人浏览器里打开（全集团 132 个公告在一个列表），把相关公告页的正文交给 listing.capture 入库",
};

/** Where a company's real job list lives, in the words the reason shows: readable now, needs the model, or not yet reachable. */
export function entryOf(urls: string[]): { readable: boolean; label: string; url?: string } {
  for (const u of urls) { const src = sourceFor(u); if (src?.fetch && !isAggregate(src.id)) return { readable: true, label: `可自动展开（${src.name}）`, url: u }; }
  // an apply site beats the 公众号 article that announced it: the site is where a reader can be written
  const host = urls.map((u) => { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return ""; } }).find((h) => h && h !== "mp.weixin.qq.com");
  if (host && MANUAL[host]) return { readable: false, label: MANUAL[host] };
  if (host) return { readable: false, label: `入口 ${host}（暂不能自动读取）` };
  return urls.length ? { readable: false, label: "入口是公众号文章（抓取要用模型）" } : { readable: false, label: "没有入口链接" };
}

/**
 * 待展开: companies on the user's direction (画像匹配) that the pool only knows from a summary sheet — job families or
 * majors instead of jobs, often no deadline. Big groups (国家能源集团, 中国船舶集团) live here. Readable entries are
 * then synced by official.ts (caredCompanies); the tag goes away by itself once real jobs have come in.
 */
export const expand: Recommender = {
  id: "expand",
  tag: "待展开",
  describe: "方向相关、但岗位库里只有汇总表信息（类别或专业、常无截止日期）的公司；理由写明官方入口能否自动展开",
  auto: true,
  run: (s) => expandHits(s, expandedSites(s)),
};

/**
 * The companies 待展开 would name if their career sites had not been subscribed and read: with no site counted as
 * read, and with only what the summary sheets say of them. A company stops being named once its site is read — its
 * posts are then in the pool, under its own name or its units' — and that reading is the only reason its subscription
 * exists. Whoever tidies subscriptions away has to know these companies, or it removes a subscription for "nobody
 * cares about this company", what it brought is cleared, the company is named again, and the site is subscribed and
 * read again: every start (2026-10-13: 中国航天科工集团, 国家电投集团, 中国东信 … two dozen subscriptions, a few hundred
 * campaigns deleted and read back each time).
 */
export const expandable = (s: Services): Set<string> => new Set(expandHits(s, null).map((h) => h.companyId));

/** `done`: the sites already read; null asks the what-if above. */
function expandHits(s: Services, done: Set<string> | null): Hit[] {
    const db = s.domain.db;
    const best = new Map<string, number>();
    // profile_match has just run (rerunAuto keeps that order) and stored its hits: read them instead of matching twice
    for (const r of db.prepare("select company_id, max(score) score from recommendation where mode = 'profile_match' group by company_id").all() as { company_id: string; score: number }[]) best.set(r.company_id, r.score);
    // one read, grouped here: a query per company scanned the whole campaign table ~1,000 times (10 s, froze the daemon)
    type Row = { source_kind: string; apply_url: string; notice_url: string };
    const byCompany = new Map<string, Row[]>();
    // a batch counts while its 项目层说法 has not passed (ADR-041: the person's later day counts; the local day)
    const live = openCampaigns(db);
    const campaigns = db.prepare("select id, company_id, source_kind, apply_url, notice_url from campaign").all() as (Row & { id: string; company_id: string })[];
    for (const r of campaigns.filter((c) => live.has(c.id)))
      (byCompany.get(r.company_id) ?? byCompany.set(r.company_id, []).get(r.company_id)!).push(r);
    const open = { all: (id: string) => (done ? byCompany.get(id) ?? [] : (byCompany.get(id) ?? []).filter((r) => isAggregate(r.source_kind))) };
    const hits: Hit[] = [];
    // 「中船七二二所」 from the sheet is expanded once 「中国船舶集团有限公司第七二二研究所」 came in from the group's site
    const units = unitIndex(db);
    const official = new Set(campaigns.filter((c) => live.has(c.id) && !isAggregate(c.source_kind)).map((c) => c.company_id));
    const name = db.prepare("select name from company where id = ?");
    const twinHasJobs = (id: string) => !!done && (units.get(unitKey((name.get(id) as { name: string }).name)) ?? []).some((c) => c.id !== id && official.has(c.id));
    for (const [companyId, score] of best) {
      const rows = open.all(companyId) as { source_kind: string; apply_url: string; notice_url: string }[];
      if (!rows.length || rows.some((r) => !isAggregate(r.source_kind)) || twinHasJobs(companyId)) continue;
      const e = entryOf(rows.flatMap((r) => [r.apply_url, r.notice_url]).filter(Boolean));
      if (e.url && done?.has(siteKeyOf(e.url))) continue;
      hits.push({ companyId, score: score + (e.readable ? 1 : 0), reason: `只有汇总表信息；${e.label}` });
    }
    // the group itself (国家能源集团, 中国石油): its sheet row lists a few majors or none, yet it hires across hundreds of
    // units — never let it drop out just because the sheet did not name the user's major
    const groups = db.prepare(`select id, industry from company where type = '央国企' and name not like '%（%' and name not like '%(%'
      and (name like '%集团' or name like '%集团有限公司' or (name like '中国%' and length(name) <= 6))`).all() as { id: string; industry: string }[];
    for (const { id, industry } of groups) {
      // ponytail: industry words from the sheet decide "an engineering employer"; a real direction→industry map is the upgrade
      if (best.has(id) || !ENGINEERING.test(industry) || /金融|证券|保险|传媒|广告|地产/.test(industry)) continue;
      const rows = open.all(id) as { source_kind: string; apply_url: string; notice_url: string }[];
      if (!rows.length || rows.some((r) => !isAggregate(r.source_kind))) continue;
      const e = entryOf(rows.flatMap((r) => [r.apply_url, r.notice_url]).filter(Boolean));
      if (e.url && done?.has(siteKeyOf(e.url))) continue;
      hits.push({ companyId: id, score: 1, reason: `央国企集团条目，汇总表没写你的专业；${e.label}` });
    }
    return hits;
}

/**
 * Sites already subscribed and read at least once: a group row (中国华能) stays sheet-only because its site files the
 * posts under the units (华能核能技术研究院 …), yet there is nothing left to expand.
 */
function expandedSites(s: Services): Set<string> {
  const ok = new Set((s.domain.db.prepare("select distinct config_id from scan_run where error = '' and found > 0").all() as { config_id: string }[]).map((r) => r.config_id));
  return new Set(s.config.sources.filter((c) => c.url && ok.has(c.id)).map((c) => siteKeyOf(c.url!)));
}
