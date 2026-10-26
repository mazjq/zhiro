import { createHash } from "node:crypto";
import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import { now, type Db } from "../db.js";
import type { Services } from "../services.js";
import type { Llm } from "../llm.js";
import { DomainError, NotFound } from "./errors.js";
import { httpContext, guardedFetch } from "../data/index.js";
import { articleText, fetchArticle, loadImages } from "./extract.js";
import { readPage } from "./page-read.js";
import { withPurpose } from "./usage.js";
import { resolveFor, campaignSaying, loadContext } from "./deadlines.js";
import { checkNotice, recordCheck, siteKey, fingerprint, RULE_VERSION, type NoticeDoc, type Extract, type CompanyIdentity, type Outcome, type Gates } from "./notice.js";

/**
 * 公告核实, the run: read a batch's announcement (its notice link, else its application link), have the model copy out
 * what it says, check it (notice.ts), file it. A reading that is the same as last time is not sent to the model again:
 * what it found then is checked again (who is on record may have changed) and filed as a new check.
 */

const sha = (s: string | Buffer) => createHash("sha256").update(s).digest("hex").slice(0, 16);
const MAX_IMAGES = 20, MAX_TEXT = 40_000;

/** What is on record about a company: its name and aliases, the sites of its official subscriptions, its accounts. */
export function companyIdentity(db: Db, companyId: string): CompanyIdentity {
  const co = db.prepare("select name, aliases from company where id = ?").get(companyId) as { name: string; aliases: string } | undefined;
  if (!co) throw new NotFound(`company ${companyId}`);
  const urls = (db.prepare("select apply_url, notice_url from campaign where company_id = ? and source_grade = '官方'").all(companyId) as { apply_url: string; notice_url: string }[]).flatMap((r) => [r.apply_url, r.notice_url]);
  const sites = new Set(urls.filter(Boolean).map(siteKey).filter((k): k is string => !!k));
  const accounts = new Set((db.prepare("select account_id from company_account where company_id = ?").all(companyId) as { account_id: string }[]).map((r) => r.account_id));
  let aliases: string[] = [];
  try { aliases = JSON.parse(co.aliases || "[]"); } catch { /* none */ }
  return { name: co.name, aliases, sites, accounts };
}

/** One reading: a WeChat post with its account and posters, else the page as it ended up (the browser when HTTP is thin). */
export async function readNotice(s: Services, url: string): Promise<{ doc: NoticeDoc; pics: { data: string; mimeType: string }[] }> {
  const blank = (o: Partial<NoticeDoc>): NoticeDoc => ({ url, finalUrl: url, via: "http", status: "failed", title: "", text: "", images: [], complete: false, ...o });
  if (/^https?:\/\/mp\.weixin\.qq\.com\//i.test(url)) {
    const ctx = httpContext();
    try {
      const a = await fetchArticle(url, ctx);
      const id = /var biz = "([^"]+)"/.exec(a.html)?.[1] ?? /__biz=([^&"#]+)/.exec(a.html)?.[1] ?? "";
      const name = /var nickname = htmlDecode\("([^"]*)"\)/.exec(a.html)?.[1] ?? /id="js_name">\s*([^<]+)/.exec(a.html)?.[1]?.trim() ?? "";
      const pics = await loadImages(a.images, ctx, MAX_IMAGES);
      const doc = blank({ via: "wechat", title: a.title, text: a.text, account: id ? { id, name } : undefined, images: pics.map((p, n) => ({ n, hash: sha(p.data) })),
        // ponytail: an image that failed to load and a skipped icon look the same here; counted as complete when none was cut off by the cap
        complete: a.text.length < MAX_TEXT && a.images.length <= MAX_IMAGES, status: a.text.trim() || pics.length ? "ok" : "empty" });
      return { doc, pics };
    } catch (e: any) {
      return { doc: blank({ via: "wechat", status: e?.code === "VERIFY_REQUIRED" ? "blocked" : "failed", note: String(e?.message ?? e).slice(0, 160) }), pics: [] };
    }
  }
  // HTTP first, following the hops ourselves so the page it ends on is known (a link on the company's site can lead elsewhere)
  try {
    const res = await guardedFetch(url, { headers: { accept: "text/html", "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36" }, signal: AbortSignal.timeout(20_000) });
    if (res.ok) {
      const html = await res.text(), a = articleText(html, url);
      if (a.text.replace(/\s+/g, "").length >= 1_200) return { doc: blank({ finalUrl: res.url || url, title: a.title, text: a.text, links: [...html.matchAll(/href=["'](https?:[^"']+)["']/gi)].map((m) => m[1]).slice(0, 200), complete: a.text.length < MAX_TEXT, status: "ok" }), pics: [] };
    } else if (res.status === 401) return { doc: blank({ status: "login", note: `HTTP ${res.status}` }), pics: [] };
  } catch (e: any) {
    if (/^BLOCKED/.test(e?.message ?? "")) return { doc: blank({ status: "blocked", note: e.message }), pics: [] };
  }
  const r = await readPage(s, { url, browser: true, maxChars: 60_000, refresh: true });
  const status = r.status === "ok" ? "ok" : r.status === "needsLogin" ? "login" : r.status === "blocked" ? "blocked" : r.status === "empty" ? "empty" : "failed";
  return { doc: blank({ via: "browser", finalUrl: r.finalUrl || url, title: r.title, text: r.text, links: r.links.map((l) => l.href), complete: !r.truncated, status, note: r.status === "busy" ? "网申正在用浏览器" : "" }), pics: [] };
}

const PROMPT = `你是校招公告核实员。下面是一份招聘材料（网页文字，或公众号文章的配图按顺序编号 0、1、2…）。只输出一个 JSON 对象，不要解释：
{"isRecruitment":true/false,
 "issuer":"招聘主体（招人的公司 / 单位全称，原文怎么写就怎么写）",
 "cohort":"届别原文，如 2027届；没写就空", "cohortQuote":"写届别的原文逐字（文字材料）", "cohortImage":图序号或null,
 "deadlineText":"网申或投递截止的原文逐字（整句）；写的是招满即止 / 长期有效也照抄；没写就空", "deadlineDate":"YYYY-MM-DD，原文没年份就空", "deadlineImage":截止写在第几张图上（只在图上时），否则 null,
 "applyEntry":"投递入口原文（网址或「官网 / 小程序」等说法）",
 "scope":"截止适用哪些岗位 / 地区 / 下属单位；全部则写全部",
 "doubts":"只写对已抄出内容的疑问：看不清 / 多个截止 / 年份缺失 / 不确定是不是截止；某项原文没写就让那一项留空，不要写进这里；没有疑问就空"}
规则：只抄原文，不推测、不补全；网申开始、宣讲、笔试、面试的日期不是截止；文字里有的就不要说在图上。`;

/** The model copies out what the material says. Posters only reach a model that can see; otherwise the reading is left to a person. */
export async function askNotice(llm: Llm, doc: NoticeDoc, pics: { data: string; mimeType: string }[], company: string, batch: string): Promise<Extract | null> {
  const model = llm.model();
  const canSee = (model as any).input?.includes?.("image");
  const posters = pics.length > 0 && doc.text.replace(/\s+/g, "").length < 400;
  if (posters && !canSee) return null;
  const head = `要核实的公司：${company}\n批次：${batch}\n材料：${doc.finalUrl || doc.url}\n发布者：${doc.account?.name ?? ""}\n标题：${doc.title}\n`;
  const body = posters ? `\n这份材料是 ${pics.length} 张图片，按顺序编号 0…${pics.length - 1}。\n文字部分：${doc.text.slice(0, 2_000)}` : `\n正文：\n${doc.text.slice(0, 24_000)}`;
  const content: any[] = [{ type: "text", text: `${head}${body}` }, ...(posters ? pics.map((p) => ({ type: "image", data: p.data, mimeType: p.mimeType })) : [])];
  const msg = await llm.models.completeSimple(model, { systemPrompt: PROMPT, messages: [{ role: "user", content, timestamp: Date.now() }] }, { reasoning: "low" });
  const j = parseJsonWithRepair<Partial<Extract>>(contentText(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) ? v : null);
  return { isRecruitment: j.isRecruitment !== false, issuer: str(j.issuer), cohort: str(j.cohort), cohortQuote: str(j.cohortQuote), cohortImage: num(j.cohortImage),
    deadlineText: str(j.deadlineText), deadlineDate: str(j.deadlineDate), deadlineImage: num(j.deadlineImage), applyEntry: str(j.applyEntry), scope: str(j.scope), doubts: str(j.doubts) };
}

export interface VerifyResult { url: string; outcome: Outcome; reasons: string[]; deadline: string; factId?: string; unchanged: boolean;
  /** the company's own site names its employer otherwise: if that is its full name, company.alias (a card for an agent) and check again */
  aliasHint?: { companyId: string; alias: string } }

/** Check a batch's announcement (or the batch of a post). `url`: the material to read, else the batch's own links. */
export async function verifyNotice(s: Services, input: { campaignId?: string; positionId?: string; url?: string }): Promise<{ campaignId: string; results: VerifyResult[]; now: string }> {
  const db = s.domain.db;
  const campaignId = input.campaignId ?? (input.positionId ? (db.prepare("select campaign_id from position where id = ?").get(input.positionId) as { campaign_id: string } | undefined)?.campaign_id : undefined);
  if (!campaignId) throw new DomainError("MISSING_FIELD", input.positionId ? `没有岗位 ${input.positionId}` : "要给 campaignId 或 positionId");
  const c = db.prepare("select id, company_id, batch, cohort, notice_url, apply_url from campaign where id = ?").get(campaignId) as { id: string; company_id: string; batch: string; cohort: string; notice_url: string; apply_url: string } | undefined;
  if (!c) throw new NotFound(`campaign ${campaignId}`);
  const urls = input.url ? [input.url] : [...new Set([c.notice_url, c.apply_url].filter((u) => /^https?:\/\//i.test(u ?? "")))].slice(0, 2);
  if (!urls.length) throw new DomainError("NO_MATERIAL", "这个批次没有公告或网申链接：用 url 指定要读的公告");
  const co = companyIdentity(db, c.company_id), subject = { type: "campaign" as const, id: c.id };
  const last = db.prepare(`select k.extract, r.fingerprint from notice_check k join notice_read r on r.id = k.read_id
    where k.subject_type = 'campaign' and k.subject_id = ? and r.url = ? and k.rule_version = ? and r.status in ('ok', 'partial') and k.outcome != 'unreadable' order by k.checked_at desc limit 1`);
  const results: VerifyResult[] = [];
  for (const url of urls) {
    const { doc, pics } = await readNotice(s, url);
    const reasons = (g?: Gates) => (g ? Object.values(g).filter((x) => x.result !== "pass").map((x) => x.why) : []);
    if (doc.status !== "ok" && doc.status !== "partial") {
      recordCheck({ db, vault: s.config.vault }, subject, doc, null, null, "notice.verify");
      results.push({ url, outcome: "unreadable", reasons: [doc.note || `读不到（${doc.status}）`], deadline: "", unchanged: false });
      continue;
    }
    const prev = last.get(c.id, url, RULE_VERSION) as { extract: string; fingerprint: string } | undefined;
    const unchanged = !!prev && prev.fingerprint === fingerprint(doc);
    if (!unchanged && !s.llm) throw new DomainError("NO_MODEL", "没有配置模型：公告要模型来读");
    const ex = unchanged ? (JSON.parse(prev!.extract) as Extract) : await withPurpose("notice.verify", c.company_id, () => askNotice(s.llm!, doc, pics, co.name, `${c.cohort} ${c.batch}`));
    if (!ex) {
      recordCheck({ db, vault: s.config.vault }, subject, { ...doc, note: "这份是海报，当前模型看不了图" }, null, null, "notice.verify");
      results.push({ url, outcome: "unreadable", reasons: ["这份是海报，当前模型看不了图：换一个能看图的模型，或本人看图确认"], deadline: "", unchanged: false });
      continue;
    }
    const result = checkNotice(doc, ex, co);
    const r = recordCheck({ db, vault: s.config.vault }, subject, doc, ex, result, unchanged ? "notice.verify:unchanged" : "notice.verify");
    // only a name wholly unlike the one on record, on the company's own site: a name that contains it is a part or a parent, not another way to write it
    const other = result.gates.publisher.result === "pass" && result.gates.issuer.result === "fail" && !db.prepare("select 1 from company where name = ?").get(ex.issuer);
    const why = [...reasons(result.gates), ...(ex.doubts ? [`模型存疑：${ex.doubts}`] : []), ...(other ? [`这家公司官网上写的招聘主体是「${ex.issuer}」：如果它就是「${co.name}」的全称，用 company.alias 登记后再核`] : [])];
    results.push({ url, outcome: result.outcome, reasons: why, deadline: ex.deadlineText, factId: r.factId, unchanged, ...(other ? { aliasHint: { companyId: c.company_id, alias: ex.issuer } } : {}) });
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
