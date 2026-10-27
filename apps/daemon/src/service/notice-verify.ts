import { createHash } from "node:crypto";
import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import { now, type Db } from "../db.js";
import type { Services } from "../services.js";
import type { Llm } from "../llm.js";
import { DomainError, NotFound } from "./errors.js";
import { httpContext, guardedFetchTo } from "../data/index.js";
import { articleText, fetchArticle, loadImages } from "./extract.js";
import { readPage } from "./page-read.js";
import { withPurpose } from "./usage.js";
import { resolveFor, campaignSaying, loadContext } from "./deadlines.js";
import { trustedSites, trustedNames, exchangeRoot, govRoot, linkFromRoots, anchors, hiringPagesOn, type PageLinks } from "./trust.js";
import { checkNotice, recordCheck, siteKey, fingerprint, RULE_VERSION, SEASON, type NoticeDoc, type Extract, type CompanyIdentity, type Outcome, type Gates, type Gate } from "./notice.js";

const unknown = (why: string): Gate => ({ result: "unknown", why });

/**
 * 公告核实, the run: read a batch's announcement (its notice link, else its application link), have the model copy out
 * what it says, check it (notice.ts), file it. A reading that is the same as last time is not sent to the model again:
 * what it found then is checked again (who is on record may have changed) and filed as a new check.
 */

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const MAX_IMAGES = 20, MAX_TEXT = 40_000;

/**
 * What is on record about a company: its name and aliases, its sites on record with their evidence (trust.ts — not the
 * links of batches a source labelled 官方, which mostly came from a sheet), its accounts.
 */
export function companyIdentity(db: Db, companyId: string): CompanyIdentity {
  const co = db.prepare("select name, aliases from company where id = ?").get(companyId) as { name: string; aliases: string } | undefined;
  if (!co) throw new NotFound(`company ${companyId}`);
  const siteIds = trustedSites(db, companyId);
  const sites = new Set(siteIds.keys());
  const accounts = new Set((db.prepare("select account_id from company_account where company_id = ?").all(companyId) as { account_id: string }[]).map((r) => r.account_id));
  let aliases: string[] = [];
  try { aliases = JSON.parse(co.aliases || "[]"); } catch { /* none */ }
  return { name: co.name, aliases, sites, accounts, siteIds, names: trustedNames(db, companyId) };
}

/** One reading: a WeChat post with its account and posters, else the page as it ended up (the browser when HTTP is thin). */
export async function readNotice(s: Services, url: string): Promise<{ doc: NoticeDoc; pics: { data: string; mimeType: string }[] }> {
  const blank = (o: Partial<NoticeDoc>): NoticeDoc => ({ url, finalUrl: url, via: "http", status: "failed", title: "", text: "", images: [], complete: false, ...o });
  const ctx = httpContext();
  // the images of a page, with whether all could be had: a poster that did not load may be where the deadline is
  const images = async (urls: string[]) => {
    const stats = { failed: 0 };
    const pics = await loadImages(urls, ctx, MAX_IMAGES, 4_000_000, stats);
    return { pics, all: stats.failed === 0 && urls.length <= MAX_IMAGES };
  };
  if (/^https?:\/\/mp\.weixin\.qq\.com\//i.test(url)) {
    try {
      const a = await fetchArticle(url, ctx);
      // the post's own account only: a __biz anywhere else on the page may be a recommended post's
      const id = /var biz = "([^"]+)"/.exec(a.html)?.[1] ?? "";
      const name = /var nickname = htmlDecode\("([^"]*)"\)/.exec(a.html)?.[1] ?? /id="js_name">\s*([^<]+)/.exec(a.html)?.[1]?.trim() ?? "";
      // a picture post (图片消息) keeps its pictures in picture_page_info_list, on another image host
      const list = a.html.indexOf("picture_page_info_list");
      const posted = list < 0 ? [] : [...new Set([...a.html.slice(list, list + 80_000).matchAll(/cdn_url:\s*'(https?:\/\/[^']+qpic\.cn\/[^']+)'/g)].map((m) => m[1].replace(/&amp;/g, "&")))];
      const { pics, all } = await images([...a.images, ...posted.filter((u) => !a.images.includes(u))]);
      const doc = blank({ via: "wechat", title: a.title, text: a.text, account: id ? { id, name } : undefined, images: pics.map((p, n) => ({ n, hash: sha(p.data) })),
        complete: a.text.length < MAX_TEXT && all, status: a.text.trim() || pics.length ? "ok" : "empty" });
      return { doc, pics };
    } catch (e: any) {
      return { doc: blank({ via: "wechat", status: e?.code === "VERIFY_REQUIRED" ? "blocked" : "failed", note: String(e?.message ?? e).slice(0, 160) }), pics: [] };
    }
  }
  // HTTP first, following the hops ourselves so the page it ends on is known (a link on the company's site can lead elsewhere)
  try {
    const { res, url: landed } = await guardedFetchTo(url, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const html = await res.text(), a = articleText(html, url);
      if (a.text.replace(/\s+/g, "").length >= 1_200) {
        const { pics, all } = await images(a.images.map((u) => { try { return new URL(u, landed).href; } catch { return ""; } }).filter(Boolean));
        return { doc: blank({ finalUrl: landed, title: a.title, text: a.text, links: [...html.matchAll(/href=["'](https?:[^"']+)["']/gi)].map((m) => m[1]).slice(0, 200),
          images: pics.map((p, n) => ({ n, hash: sha(p.data) })), complete: a.text.length < MAX_TEXT && all, status: "ok" }), pics };
      }
    } else if (res.status === 401) return { doc: blank({ status: "login", note: `HTTP ${res.status}` }), pics: [] };
  } catch (e: any) {
    if (/^BLOCKED/.test(e?.message ?? "")) return { doc: blank({ status: "blocked", note: e.message }), pics: [] };
  }
  // ponytail: a page drawn by script is read as text; its pictures are not fetched (hiring-system pages carry logos, not
  // posters). Add the snapshot's large images if a poster ever turns up there.
  const r = await readPage(s, { url, browser: true, maxChars: 60_000, refresh: true });
  const status = r.status === "ok" ? "ok" : r.status === "needsLogin" ? "login" : r.status === "blocked" ? "blocked" : r.status === "empty" ? "empty" : "failed";
  return { doc: blank({ via: "browser", finalUrl: r.finalUrl || url, title: r.title, text: r.text, links: r.links.map((l) => l.href), complete: !r.truncated, status, note: r.status === "busy" ? "网申正在用浏览器" : "" }), pics: [] };
}

const PROMPT = `你是校招公告核实员。下面是一份招聘材料（网页文字，可能附有配图，配图按顺序编号 0、1、2…）。只输出一个 JSON 对象，不要解释：
{"isRecruitment":true/false,
 "issuer":"招聘主体（招人的公司 / 单位全称，原文怎么写就怎么写）",
 "issuerNames":[{"name":"材料里明确给招聘主体起的简称","quote":"写明这层关系的原句逐字，如「××有限公司（以下简称××）」"}]（没有就空数组）,
 "batchQuote":"标题或正文里说明这是什么招聘的原文逐字，取最能看出招聘类型和批次的一句，如「2027届秋季校园招聘公告」「2027届暑期实习生招聘」「春季补录」；没写就空",
 "cohort":"届别原文，如 2027届；没写就空", "cohortQuote":"写届别的原文逐字（文字材料）", "cohortImage":届别只写在图上时的图序号，否则 null,
 "deadlineText":"网申或投递截止的原文逐字（整句；在图上就照图抄整句）；写的是招满即止 / 长期有效也照抄；没写就空", "deadlineDate":"YYYY-MM-DD，原文没年份就空", "deadlineImage":截止只写在图上时的图序号，否则 null,
 "applyEntry":"投递入口原文（网址或「官网 / 小程序」等说法）",
 "scope":"截止适用哪些岗位 / 地区 / 下属单位，照原文；没说就空；明确写全部就写全部",
 "doubts":"只写对已抄出内容的疑问：看不清 / 多个截止 / 一份材料里有几种招聘（如实习和正式、不同批次）各有截止 / 年份缺失 / 不确定是不是截止 / 文字和图上的截止不一致；某项原文没写就让那一项留空，不要写进这里；没有疑问就空"}
规则：只抄原文，不推测、不补全；网申开始、宣讲、笔试、面试的日期不是截止；文字和图都要看，图上的延期、例外也算。`;

const POSTER_PROMPT = `下面是一份招聘材料的配图，按顺序编号 0、1、2…。只看图，找出网申或投递的截止。只输出一个 JSON 对象，不要解释：
{"deadlineText":"图上写截止的整句，逐字照抄（含限定语，如「部分岗位」「以…为准」）；招满即止 / 长期有效也照抄；图上没有就空",
 "deadlineDate":"YYYY-MM-DD，图上没年份就空", "image":这句在第几张图上（序号）或 null,
 "scope":"这个截止适用哪些岗位 / 地区 / 下属单位，照图上原文；没说就空；明确写全部就写全部"}
规则：只抄图上的字，不推测；网申开始、宣讲、笔试、面试的日期不是截止。`;

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
const json = (msg: any) => parseJsonWithRepair<any>(contentText(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));

/**
 * The model copies out what the material says, text and pictures together. A deadline found only on a poster is read
 * again by another model that can see, on its own, from all the pictures: the evidence check compares the two.
 */
export async function askNotice(llm: Llm, doc: NoticeDoc, pics: { data: string; mimeType: string }[], company: string, batch: string): Promise<Extract | null> {
  const model = llm.model();
  const canSee = (model as any).input?.includes?.("image");
  if (pics.length && !canSee && doc.text.replace(/\s+/g, "").length < 400) return null; // nothing but posters, and no eyes
  const shown = canSee ? pics : [];
  // what the batch is said to be is not told: the model must find the cohort in the material, not repeat ours
  void batch;
  const head = `要核实的公司：${company}\n材料：${doc.finalUrl || doc.url}\n发布者：${doc.account?.name ?? ""}\n标题：${doc.title}\n`;
  const text = doc.text.slice(0, MAX_TEXT);
  const body = `\n正文：\n${text}${shown.length ? `\n\n附 ${shown.length} 张配图，按顺序编号 0…${shown.length - 1}。` : ""}`;
  const pictures = shown.map((p) => ({ type: "image", data: p.data, mimeType: p.mimeType }));
  const j = json(await llm.models.completeSimple(model, { systemPrompt: PROMPT, messages: [{ role: "user", content: [{ type: "text", text: `${head}${body}` }, ...pictures] as any, timestamp: Date.now() }] }, { reasoning: "low" }));
  const ex: Extract = { isRecruitment: j.isRecruitment !== false, issuer: str(j.issuer), cohort: str(j.cohort), cohortQuote: str(j.cohortQuote), cohortImage: num(j.cohortImage),
    deadlineText: str(j.deadlineText), deadlineDate: str(j.deadlineDate), deadlineImage: num(j.deadlineImage), applyEntry: str(j.applyEntry), scope: str(j.scope), doubts: str(j.doubts),
    batchQuote: str(j.batchQuote),
    issuerNames: Array.isArray(j.issuerNames) ? j.issuerNames.map((x: any) => ({ name: str(x?.name), quote: str(x?.quote) })).filter((x: any) => x.name && x.quote) : [],
    seen: { chars: text.length, images: shown.length, model: String((model as any).id ?? "") } };
  if (ex.deadlineImage != null && shown.length) {
    // a model the account cannot use is passed over; none that answers leaves the poster read once (under review)
    for (const second of otherSeeingModels(llm, model).slice(0, 3)) {
      try {
        const p = json(await llm.models.completeSimple(second, { systemPrompt: POSTER_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: `${head}\n附 ${shown.length} 张配图。` }, ...pictures] as any, timestamp: Date.now() }] }, { reasoning: "low" }));
        ex.poster = { model: String(second.id ?? ""), deadlineText: str(p.deadlineText), deadlineDate: str(p.deadlineDate), scope: str(p.scope), image: num(p.image) };
        break;
      } catch (e: any) {
        if (e?.code === "BUDGET_DEFERRED" || e?.code === "MODEL_DELEGATED") throw e;
      }
    }
  }
  return ex;
}

/**
 * The other models of the same provider that can see, for the second reading of a poster, in the provider's order. None
 * when the work goes to a harness (it answers with its own model, so a second call is not a second reader).
 * ponytail: the provider's order; a setting when someone wants to pick the second reader
 */
export function otherSeeingModels(llm: Llm, first: any): any[] {
  if (llm.route?.().kind === "harness") return [];
  try {
    return ((llm.models as any).getModels(first.provider) as any[]).filter((m) => m.id !== first.id && m.input?.includes?.("image"));
  } catch { return []; }
}

/**
 * A known site's page with all its links: plain HTTP first (every link kept); a page drawn by script, or one that turns
 * plain requests away, through the browser (whose reading keeps the first 60 links).
 */
export async function linksOf(s: Services, u: string): Promise<PageLinks | null> {
  try {
    const { res, url: landed } = await guardedFetchTo(u, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const html = await res.text(), links = anchors(html, landed);
      if (links.length >= 5) return { url: landed, title: /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1]?.trim() ?? "", links };
    }
  } catch { /* the browser gets its turn */ }
  try { const r = await readPage(s, { url: u, browser: true, maxChars: 20_000 }); return r.status === "ok" ? { url: r.finalUrl || u, title: r.title, links: r.links } : null; } catch { return null; }
}

type Checked = { url: string; doc: NoticeDoc; ex: Extract | null; result: ReturnType<typeof checkNotice> | null; unchanged: boolean; found?: string; why?: string };

// a link whose words look like an announcement; one naming an earlier cohort is not this season's
const NOTICE_LINK = /校园招聘|校招|招聘公告|招聘简章|招聘启事|简章|管培生|实习生招聘|届.{0,10}(招聘|公告)/;
const OLD_COHORT = /(?<!\d)(?:20)?(?:1\d|2[0-6])\s*届/;
/** The links on a known site's pages, on that same site, whose words look like an announcement — this cohort's first. */
export function noticeLinks(pages: PageLinks[], site: string, cohort = SEASON.cohort): string[] {
  const out: { href: string; now: boolean }[] = [];
  for (const p of pages) for (const l of p.links) {
    const t = l.text.normalize("NFKC");
    if (siteKey(l.href) !== site || !NOTICE_LINK.test(t) || OLD_COHORT.test(t) || out.some((o) => o.href === l.href)) continue;
    out.push({ href: l.href, now: t.includes(cohort) || t.includes(`${cohort.slice(2)}届`) });
  }
  return [...out.filter((o) => o.now), ...out.filter((o) => !o.now)].map((o) => o.href);
}

/**
 * Where else the company's own sites might carry this batch's announcement: their home pages and hiring pages, read
 * for links that look like one (≤5). Plain sites only (a hiring-system tenant has no home page of its own). Once a
 * week per batch; what each found is then checked like any other material, every check included.
 */
export async function findOnSites(s: Services, companyId: string, campaignId: string, skip: Set<string>): Promise<string[]> {
  const db = s.domain.db, kind = `find:${campaignId}`;
  const last = db.prepare("select at from trust_lookup where company_id = ? and kind = ?").get(companyId, kind) as { at: string } | undefined;
  if (last && last.at > new Date(Date.now() - 7 * 86400_000).toISOString()) return [];
  const note = (outcome: string, n: string) => db.prepare("insert or replace into trust_lookup(company_id, kind, at, outcome, note) values (?,?,?,?,?)").run(companyId, kind, now(), outcome, n);
  note("running", ""); // ponytail: one daemon, so a row is enough to keep a second run off; a lease when lookups run elsewhere
  const out: string[] = [];
  for (const site of [...trustedSites(db, companyId).keys()].filter((k) => !k.includes(":")).slice(0, 3)) {
    let home: PageLinks | null = null;
    for (const u of [`https://${site}/`, `https://www.${site}/`, `http://${site}/`]) if ((home = await linksOf(s, u))) break;
    if (!home) continue;
    const pages = [home];
    // one level down: the hiring pages, not the announcements themselves (those are read as material below)
    const notices = new Set(home.links.filter((l) => NOTICE_LINK.test(l.text.normalize("NFKC"))).map((l) => l.href.split("#")[0]));
    for (const u of hiringPagesOn(home, site).filter((u) => !notices.has(u))) { if (pages.length >= 4) break; const p = await linksOf(s, u); if (p) pages.push(p); }
    for (const u of noticeLinks(pages, site)) if (!skip.has(u) && !out.includes(u) && out.length < 5) out.push(u);
  }
  note(out.length ? "found" : "none", out.join(" ").slice(0, 600));
  return out;
}

export interface VerifyResult { url: string; outcome: Outcome; reasons: string[]; deadline: string; factId?: string; unchanged: boolean;
  /** material not among the batch's own links: where it was found */
  found?: string;
  /** the company's own site names its employer otherwise: if that is its full name, company.alias (a card for an agent) and check again */
  aliasHint?: { companyId: string; alias: string } }

/** Check a batch's announcement (or the batch of a post). `url`: the material to read, else the batch's own links. */
export async function verifyNotice(s: Services, input: { campaignId?: string; positionId?: string; url?: string }): Promise<{ campaignId: string; results: VerifyResult[]; now: string }> {
  const db = s.domain.db;
  const campaignId = input.campaignId ?? (input.positionId ? (db.prepare("select campaign_id from position where id = ?").get(input.positionId) as { campaign_id: string } | undefined)?.campaign_id : undefined);
  if (!campaignId) throw new DomainError("MISSING_FIELD", input.positionId ? `没有岗位 ${input.positionId}` : "要给 campaignId 或 positionId");
  const c = db.prepare("select id, company_id, kind, batch, cohort, notice_url, apply_url from campaign where id = ?").get(campaignId) as { id: string; company_id: string; kind: string; batch: string; cohort: string; notice_url: string; apply_url: string } | undefined;
  if (!c) throw new NotFound(`campaign ${campaignId}`);
  const urls = input.url ? [input.url] : [...new Set([c.notice_url, c.apply_url].filter((u) => /^https?:\/\//i.test(u ?? "")))].slice(0, 2);
  if (!urls.length) throw new DomainError("NO_MATERIAL", "这个批次没有公告或网申链接：用 url 指定要读的公告");
  // the company's sites on record first: a listed company's disclosed website, a central enterprise's on the 国资委
  // list, each looked up once a month (trust.ts)
  await exchangeRoot(db, c.company_id).catch(() => null);
  await govRoot(db, c.company_id).catch(() => null);
  let co = companyIdentity(db, c.company_id);
  const subject = { type: "campaign" as const, id: c.id };
  // a known site's own page, as read for one hop to its hiring site (trust.ts linkFromRoots)
  const pageLinks = (u: string) => linksOf(s, u);
  const last = db.prepare(`select k.extract, r.fingerprint from notice_check k join notice_read r on r.id = k.read_id
    where k.subject_type = 'campaign' and k.subject_id = ? and r.url = ? and k.rule_version = ? and r.status in ('ok', 'partial') and k.outcome != 'unreadable' order by k.checked_at desc limit 1`);
  const batch = { kind: c.kind, batch: c.batch };
  // read and check every piece of this round's material first; what is written is decided once all of it is in
  const checked: Checked[] = [];
  const checkOne = async (url: string, found?: string) => {
    const { doc, pics } = await readNotice(s, url);
    // the page is on a site not yet known as the company's own: see whether one of its known sites links to it, once a month
    const here = doc.via !== "wechat" ? siteKey(doc.finalUrl || doc.url) : null;
    if (here && !co.sites.has(here) && (await linkFromRoots(pageLinks, db, c.company_id, here).catch(() => null))?.status === "added") co = companyIdentity(db, c.company_id);
    if (doc.status !== "ok" && doc.status !== "partial") return checked.push({ url, doc, ex: null, result: null, unchanged: false, found, why: doc.note || `读不到（${doc.status}）` });
    const prev = last.get(c.id, url, RULE_VERSION) as { extract: string; fingerprint: string } | undefined;
    const unchanged = !!prev && prev.fingerprint === fingerprint(doc);
    if (!unchanged && !s.llm) throw new DomainError("NO_MODEL", "没有配置模型：公告要模型来读");
    const ex = unchanged ? (JSON.parse(prev!.extract) as Extract) : await withPurpose("notice.verify", c.company_id, () => askNotice(s.llm!, doc, pics, co.name, `${c.cohort} ${c.batch}`));
    if (!ex) return checked.push({ url, doc: { ...doc, note: "这份是海报，当前模型看不了图" }, ex: null, result: null, unchanged: false, found, why: "这份是海报，当前模型看不了图：换一个能看图的模型" });
    return checked.push({ url, doc, ex, result: checkNotice(doc, ex, co, SEASON, batch), unchanged, found });
  };
  for (const url of urls) await checkOne(url);
  // the batch's own links said nothing that stands: look on the company's own sites for its announcement (D1)
  if (!input.url && !checked.some((x) => x.result?.outcome === "fact")) {
    for (const url of await findOnSites(s, c.company_id, c.id, new Set(urls))) await checkOne(url, "在这家公司已确认的站点上找到");
  }
  // two pieces saying different deadlines, with nothing saying which one holds: neither is taken
  const days = new Set(checked.filter((x) => x.result?.fact).map((x) => `${x.result!.fact!.policy}:${x.result!.fact!.date ?? ""}`));
  if (days.size > 1) for (const x of checked) if (x.result?.fact) x.result = { ...x.result, outcome: "review", fact: undefined, gates: { ...x.result.gates, evidence: unknown(`几份材料写的截止不同：${checked.filter((y) => y.result?.fact).map((y) => y.ex!.deadlineText.slice(0, 30)).join(" / ")}`) } };
  const results: VerifyResult[] = [];
  const reasons = (g?: Gates) => (g ? Object.values(g).filter((x) => x.result !== "pass").map((x) => x.why) : []);
  for (const x of checked) {
    const r = recordCheck({ db, vault: s.config.vault }, subject, x.doc, x.ex, x.result, x.unchanged ? "notice.verify:unchanged" : x.found ? "notice.verify:found" : "notice.verify");
    const why = x.result ? [...reasons(x.result.gates), ...(x.ex?.doubts ? [`模型存疑：${x.ex.doubts}`] : [])] : [x.why ?? ""];
    results.push({ url: x.url, outcome: x.result?.outcome ?? "unreadable", reasons: why, deadline: x.ex?.deadlineText ?? "", factId: r.factId, unchanged: x.unchanged, ...(x.found ? { found: x.found } : {}) });
  }
  if (results.some((r) => r.factId)) s.onDataChanged?.();
  const say = input.positionId ? resolveFor(db, [input.positionId]).get(input.positionId)?.say : campaignSaying(loadContext(db, [c.company_id]), c.id).say;
  return { campaignId: c.id, results, now: say ?? "" };
}

/** What has been checked of a batch, newest first. */
export function noticeChecks(db: Db, campaignId: string, limit = 20) {
  return (db.prepare(`select k.id, k.outcome, k.gates, k.extract, k.by, k.checked_at, r.url, r.final_url, r.status, r.account_id, r.account_name from notice_check k join notice_read r on r.id = k.read_id
    where k.subject_type = 'campaign' and k.subject_id = ? order by k.checked_at desc limit ?`).all(campaignId, limit) as any[]).map((r) => {
    const ex = JSON.parse(r.extract || "{}"), gates = JSON.parse(r.gates || "{}") as Partial<Gates>;
    return { id: r.id as string, checkedAt: r.checked_at as string, url: r.url as string, finalUrl: r.final_url as string, readStatus: r.status as string, outcome: r.outcome as Outcome,
      unchanged: r.by === "notice.verify:unchanged", account: r.account_id ? { id: r.account_id as string, name: r.account_name as string } : null,
      gates: Object.fromEntries(Object.entries(gates).map(([k, g]) => [k, `${g!.result === "pass" ? "✓" : g!.result === "fail" ? "✗" : "?"} ${g!.why}`])) as Record<string, string>,
      deadline: String(ex.deadlineText ?? ""), cohort: String(ex.cohort ?? ""), applyEntry: String(ex.applyEntry ?? ""), issuer: String(ex.issuer ?? "") };
  });
}

/** The person says this WeChat account is the company's own (seen linked from its site, or known): its posts count as official. */
export function recordAccount(db: Db, p: { companyId: string; accountId: string; name?: string; basis: string }) {
  if (!db.prepare("select 1 from company where id = ?").get(p.companyId)) throw new NotFound(`company ${p.companyId}`);
  if (!p.accountId.trim() || !p.basis.trim()) throw new DomainError("MISSING_FIELD", "要给公众号 id 和依据（例如：官网招聘页链到这个号）");
  db.prepare("insert or replace into company_account(company_id, account_id, name, basis, at) values (?,?,?,?,?)").run(p.companyId, p.accountId.trim(), p.name?.trim() ?? "", p.basis.trim(), now());
  return { ok: true };
}

/**
 * What the last checks of a batch's announcement say, in three lines for the post's page: what the announcement says
 * (and when it was read), whether the way in opened, and that whether it still takes applications is not known — a
 * page read today says nothing of a batch closed tomorrow. Null when nothing was checked in the last 30 days.
 */
export function noticeSummary(db: Db, campaignId: string, applyUrl = ""): { checkedAt: string; lines: string[] } | null {
  const rows = db.prepare(`select k.outcome, k.gates, k.extract, k.checked_at, r.url, r.status from notice_check k join notice_read r on r.id = k.read_id
    where k.subject_type = 'campaign' and k.subject_id = ? and k.invalidated_at is null and k.checked_at >= datetime('now', '-30 days') order by k.checked_at desc`).all(campaignId) as { outcome: string; gates: string; extract: string; checked_at: string; url: string; status: string }[];
  if (!rows.length) return null;
  // newest per piece of material: rows come newest first, so the first seen of each url is kept
  const latest: typeof rows = [];
  for (const r of rows) if (!latest.some((x) => x.url === r.url)) latest.push(r);
  const day = (iso: string) => iso.slice(5, 10);
  const at = latest[0].checked_at;
  const read = latest.filter((r) => r.outcome !== "unreadable");
  const fact = read.find((r) => r.outcome === "fact"), none = read.find((r) => r.outcome === "not_stated");
  const firstWhy = (r: { gates: string }) => (Object.values(JSON.parse(r.gates || "{}")) as Gate[]).find((g) => g.result !== "pass")?.why ?? "";
  const lines: string[] = [];
  if (fact) lines.push(`公告复查于 ${day(fact.checked_at)}：${JSON.parse(fact.extract || "{}").deadlineText || "截止已核实"}`);
  else if (none) lines.push(`公告复查于 ${day(none.checked_at)}：官方页面未见截止`);
  else if (read.length) lines.push(`公告复查于 ${day(read[0].checked_at)}：待复核（${firstWhy(read[0]) || "证据不够"}）`);
  else {
    const before = rows.find((r) => r.outcome !== "unreadable");
    lines.push(`这次没读到公告（${day(at)}）${before ? `；上次 ${day(before.checked_at)} 的记录仍在` : ""}`);
  }
  const entry = applyUrl ? latest.find((r) => r.url === applyUrl) : undefined;
  if (entry) lines.push(entry.status === "ok" ? `网申入口能打开（${day(entry.checked_at)}）` : `网申入口这次没打开（${day(entry.checked_at)}）`);
  lines.push("是否还在收申请：没确认");
  return { checkedAt: at, lines };
}
