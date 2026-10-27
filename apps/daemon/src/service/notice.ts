import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { now, type Db } from "../db.js";
import { companyKey } from "../data/index.js";
import { recordFact, type Policy } from "./deadlines.js";
import { depsStand, type Dep } from "./trust.js";

/**
 * 公告核实: what a recruiting announcement (a site's article, a WeChat post or its posters) says of a batch's or a
 * post's deadline, cohort and way in — read, copied word for word by a model, then put through four checks that are
 * plain code. Only a deadline that passes all four becomes a deadline fact (and so decides 「还能投吗」); everything
 * else is kept as what this check found, shown to the person, deciding nothing. 「公告里没写截止」 is such a finding,
 * never a fact: it must not outweigh a date another source gives.
 */

export type ReadStatus = "ok" | "partial" | "failed" | "login" | "blocked" | "empty";
/** One reading of one piece of material. `complete`: nothing cut off, every image fetched. */
export interface NoticeDoc {
  url: string; finalUrl: string; via: "http" | "browser" | "wechat"; status: ReadStatus; note?: string; title: string;
  /** a WeChat post: the account's id (__biz) and name */
  account?: { id: string; name: string };
  text: string; links?: string[]; images: { n: number; hash: string }[]; complete: boolean;
}
/** A second, independent reading of the posters by another model: what it says the deadline is. */
export interface PosterRead { model: string; deadlineText: string; deadlineDate: string; scope: string; image: number | null }
/** What the model copied out (the prompt asks for words as written, nothing guessed). */
export interface Extract {
  isRecruitment: boolean; issuer: string; cohort: string; cohortQuote: string; cohortImage: number | null;
  deadlineText: string; deadlineDate: string; deadlineImage: number | null; applyEntry: string; scope: string; doubts: string;
  /** the material's own words tying the employer's full name to a short one: 「甲有限公司（以下简称乙）」 */
  issuerNames?: { name: string; quote: string }[];
  /** filled by the run, not the model: how much of the material the model was shown, and by which model */
  seen?: { chars: number; images: number; model: string };
  poster?: PosterRead;
}
/**
 * What is known of the company the material is checked for. `sites`: siteKey()s of its sites on record (trust.ts), with
 * the records that vouch for each in `siteIds`; `accounts`: WeChat accounts the person put on record as its own.
 */
export interface CompanyIdentity { name: string; aliases: string[]; sites: Set<string>; accounts: Set<string>; siteIds?: Map<string, string[]>;
  /** full names known from the same outside records as its sites (trust.ts), with the records that vouch for each */
  names?: Map<string, string[]> }
export interface Season { cohort: string; since: string; until: string }
// ponytail: one season, as the rest of Zhiro (A9 turns 「2027」 into the recruiting season)
export const SEASON: Season = { cohort: "2027", since: "2026-03-01", until: "2027-08-31" };

export type GateResult = "pass" | "fail" | "unknown";
/** `deps`: the records a passing gate leaned on — a check counts only while all of them stand */
export interface Gate { result: GateResult; why: string; deps?: Dep[] }
export interface Gates { publisher: Gate; issuer: Gate; evidence: Gate; season: Gate }
export type Outcome = "fact" | "not_stated" | "review" | "unreadable" | "not_recruitment";
// 2: doubts are only about what is written (an absent deadline is not a doubt); 「27届」 read as 2027
// 3: posters read twice by two models; cohort sentence checked; what the model was shown counted; 「以下简称」
// 4: the title counts as the material's words; the batch's own cohort is no longer told to the model; 「中国」 in front
// 5: 「简称」 only as 「甲（以下简称乙）」 written together; the title and the account are part of what 「unchanged」 means
// 6: a company's own sites are only those on record with their evidence (trust.ts), not every batch labelled 官方
// 7: a full name on record (巨潮, Zhiro's own readers) passes the issuer check
export const RULE_VERSION = 7;

const pass = (why: string): Gate => ({ result: "pass", why }), fail = (why: string): Gate => ({ result: "fail", why }), unknown = (why: string): Gate => ({ result: "unknown", why });

// hosts many companies share: the host alone never says whose page it is
const SHARED = /(^|\.)(mokahr\.com|hotjob\.cn|mp\.weixin\.qq\.com|weixin\.qq\.com|zhaopin\.com|51job\.com|iguopin\.com|nowcoder\.com|shixiseng\.com|yingjiesheng\.com|liepin\.com|zhipin\.com|lagou\.com|feishu\.cn|larksuite\.com|qq\.com|baidu\.com|sohu\.com|163\.com|sina\.com\.cn|toutiao\.com|zhihu\.com|bilibili\.com)$/i;
/**
 * Whose site a link is on: a hiring system's tenant (app.mokahr.com/campus-recruitment/<tenant>, <tenant>.zhiye.com,
 * <tenant>.jobs.feishu.cn …), else the host without www. Null for a host many companies share and no tenant in sight.
 */
export function siteKey(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.toLowerCase().replace(/^www\./, "");
  const moka = /^app\.mokahr\.com$/.test(host) && /^\/(?:campus|social)[-_]recruitment\/([^/#?]+)/.exec(u.pathname);
  if (moka) return `mokahr:${moka[1].toLowerCase()}`;
  const hotjob = /^wecruit\.hotjob\.cn$/.test(host) && /^\/(SU[0-9a-z]+)/i.exec(u.pathname);
  if (hotjob) return `hotjob:${hotjob[1].toLowerCase()}`;
  if (/^[^.]+\.jobs\.feishu\.cn$/.test(host)) return host; // the tenant is the first label
  return SHARED.test(host) ? null : host;
}

// legal form only: 「集团」「股份」 stay, they tell a group from its parts (catalog.ts companyKey)
// 「中国航天502所」 and 「航天502所」 are one name written two ways
const nameKey = (s: string) => companyKey(s).replace(/[（）()【】\[\]·・\-—]/g, "").replace(/(股份有限公司|有限责任公司|有限公司|公司)$/, "").replace(/^中国(?=.{3,})/, ""); // never down to two characters (中国电信 is not 电信)

/** 发布者: the company's own site or hiring-system tenant, or a WeChat account on record as its own. */
export function publisherGate(doc: NoticeDoc, co: CompanyIdentity): Gate {
  if (doc.via === "wechat") {
    if (doc.account?.id && co.accounts.has(doc.account.id)) return { ...pass(`公众号「${doc.account.name}」已登记为这家公司的`), deps: [{ kind: "account", id: doc.account.id }] };
    return unknown(`公众号「${doc.account?.name || "未知"}」是不是这家公司的官方号还没核实`);
  }
  const k = siteKey(doc.finalUrl || doc.url);
  if (!k) return unknown("这个网站很多公司共用，看不出是谁的页面");
  if (co.sites.has(k)) return { ...pass(`这家公司已确认的官网 / 招聘系统（${k}）`), deps: (co.siteIds?.get(k) ?? []).map((id) => ({ kind: "site" as const, id })) };
  return unknown(`${k} 不在这家公司已确认的官网里`);
}

/** 主体: the employer the announcement names is this company — by full name or a recorded alias, never by likeness. */
// 「甲（以下简称乙）」「甲(简称:乙)」: the two names joined by the word, nothing else between them
const shortFor = (quote: string, full: string, short: string) => ["以下简称", "下称", "简称"].some((w) => norm(quote).includes(norm(full) + w + norm(short)));
export function issuerGate(ex: Extract, co: CompanyIdentity, doc?: NoticeDoc): Gate {
  const issuer = nameKey(ex.issuer ?? "");
  if (!issuer) return unknown("公告没写招聘主体");
  const names = [co.name, ...co.aliases].map(nameKey).filter(Boolean);
  if (names.includes(issuer)) return pass(`招聘主体「${ex.issuer}」`);
  // a full name on record from an outside record (巨潮's disclosure, Zhiro's own readers)
  for (const [full, ids] of co.names ?? []) if (nameKey(full) === issuer) return { ...pass(`招聘主体「${ex.issuer}」是「${co.name}」的全称（已确认）`), deps: ids.map((id) => ({ kind: "name" as const, id })) };
  // the material itself says the full name is short for this one: 「甲有限公司（以下简称乙）」, word for word on the page
  const tie = (ex.issuerNames ?? []).find((x) => names.includes(nameKey(x.name)) && shortFor(x.quote, ex.issuer, x.name) && onPage(doc, x.quote));
  if (tie) return pass(`原文「${tie.quote.trim().slice(0, 60)}」：「${ex.issuer}」简称「${tie.name}」`);
  if (names.some((n) => n.includes(issuer) || issuer.includes(n))) return unknown(`招聘主体「${ex.issuer}」和「${co.name}」名字相近，可能是集团或下属单位`);
  return fail(`招聘主体是「${ex.issuer}」，不是「${co.name}」`);
}

// the material's words: its title and its text
const onPage = (doc: NoticeDoc | undefined, q: string) => !!doc && !!norm(q) && norm(`${doc.title}\n${doc.text}`).includes(norm(q));
const norm = (s: string) => (s ?? "").normalize("NFKC").replace(/\s+/g, "").replace(/[，,。.：:；;（）()【】\[\]“”"'、]/g, "");
/** The days a sentence names, in order; a day without a year takes the year of the one before it. */
export function datesIn(text: string): { dates: string[]; yearless: boolean; between: string[]; named: number } {
  const out: string[] = [], between: string[] = [];
  let year = "", yearless = false, last = -1, named = 0;
  const t = text.normalize("NFKC");
  // 「2026年8月10日」「2026-8-10」「2026 8.10」（a poster's year, a space, then the day）
  const re = /(?:(\d{4})\s*(?:[年\-/.]|\s))?\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?/g;
  for (const m of t.matchAll(re)) {
    named++; // every day the sentence names counts, with a year or without
    if (m[1]) year = m[1];
    if (!year) { yearless = true; continue; }
    const mo = Number(m[2]), d = Number(m[3]);
    const day = new Date(Date.UTC(Number(year), mo - 1, d));
    if (mo < 1 || mo > 12 || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) continue; // 2 月 30 日 is no day
    if (last >= 0) between.push(t.slice(last, m.index));
    last = m.index! + m[0].length;
    out.push(`${year}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`);
  }
  return { dates: out, yearless, between, named };
}
/** What a deadline sentence says, by rule: a day (the end of a range), 招满即止, 长期 — or that it cannot be told. */
export function readDeadline(quote: string): { policy: Policy; date?: string } | { unclear: string } {
  if (/招满即止|招满为止|额满为止|招满截止|满额即止/.test(quote)) return { policy: "until_filled" };
  if (/长期有效|长期招聘|常年招聘|滚动招聘/.test(quote)) return { policy: "rolling" };
  const { dates, yearless, between, named } = datesIn(quote);
  if (named > 1 && !dates.length) return { unclear: "原文没写年份" };
  if (named > 1 && !(dates.length === 2 && named === 2)) return { unclear: "一句话里有好几个日期" };
  if (!dates.length) return { unclear: yearless ? "原文没写年份" : "原文里没有日期" };
  if (dates.length === 1) return { policy: "date", date: dates[0] };
  // 「9月1日-11月30日」「10月8日至11月9日」: the end of the range
  if (dates.length === 2 && /^\s*(至|到|~|～|—|–|-|－|▶|►|→|⇀|➡)\s*$/.test(between[0])) return dates[0] <= dates[1] ? { policy: "date", date: dates[1] } : { unclear: "日期区间前后颠倒" };
  return { unclear: "一句话里有好几个日期" };
}

// words that make a deadline narrower than the whole batch, or not final
const NARROWER = /部分|除外|以外|另行|暂定|视情况|以.{0,8}为准|仅限|分别/;
const sameScope = (a: string, b: string) => norm(a) === norm(b);

/**
 * 证据: the sentence is on the page word for word and names the day the model gave. On a poster there are no words to
 * find, so a second model reads the posters on its own: both must name the same day, the same reach, the same terms.
 */
export function evidenceGate(doc: NoticeDoc, ex: Extract): Gate {
  const q = ex.deadlineText ?? "";
  const said = readDeadline(q);
  if (ex.deadlineImage != null) {
    if (!Number.isInteger(ex.deadlineImage) || !doc.images.some((im) => im.n === ex.deadlineImage)) return fail(`说截止在图 ${ex.deadlineImage}，这份材料没有这张图`);
    if ("unclear" in said) return unknown(`海报上的截止：${said.unclear}`);
    const p = ex.poster;
    if (!p) return unknown("海报只读了一遍（没有第二个能看图的模型）");
    if (p.model === ex.seen?.model) return unknown("两遍用的是同一个模型，不算独立");
    const again = readDeadline(p.deadlineText ?? "");
    if ("unclear" in again) return unknown(`第二遍读海报：${again.unclear}`);
    if (again.policy !== said.policy || again.date !== said.date) return unknown(`两遍读海报不一致：「${q.slice(0, 40)}」/「${(p.deadlineText ?? "").slice(0, 40)}」`);
    if (!sameScope(ex.scope ?? "", p.scope ?? "")) return unknown(`两遍读到的适用范围不同：「${ex.scope}」/「${p.scope}」`);
    if (NARROWER.test(q) !== NARROWER.test(p.deadlineText ?? "")) return unknown("两遍读到的限定语不同");
    const img = doc.images.find((im) => im.n === ex.deadlineImage)!;
    return pass(`海报图 ${ex.deadlineImage}（${img.hash}）二次读取一致：「${q.trim().slice(0, 50)}」（${ex.seen?.model ?? "?"} / ${p.model}）`);
  }
  if (!onPage(doc, q)) return fail("截止原句在页面上找不到");
  if ("unclear" in said) return unknown(`截止原句：${said.unclear}`);
  if (said.policy === "date" && ex.deadlineDate && ex.deadlineDate !== said.date) return fail(`原句是 ${said.date}，抽出来的是 ${ex.deadlineDate}`);
  return pass(`原句「${q.trim().slice(0, 60)}」`);
}

/** 本季: the cohort the announcement names, its words on the page (or on a poster), is this season's; else a day inside it. */
export function seasonGate(ex: Extract, season: Season, date?: string, doc?: NoticeDoc): Gate {
  // 「2027届」「2027 届」「27届」
  const years = [...new Set([...(ex.cohort ?? "").matchAll(/(?<!\d)(20)?(\d{2})(?!\d)/g)].map((m) => `20${m[2]}`))];
  const shown = ex.cohortImage != null ? !!doc?.images.some((im) => im.n === ex.cohortImage) : onPage(doc, ex.cohortQuote ?? "") && norm(ex.cohortQuote).includes(norm(ex.cohort));
  if (years.length && !shown) return unknown(`届别「${ex.cohort}」的原句在材料里找不到`);
  if (years.includes(season.cohort)) return pass(`届别「${ex.cohort}」`);
  if (years.length) return fail(`届别是「${ex.cohort}」，不是 ${season.cohort} 届`);
  if (date && date >= season.since && date <= season.until) return pass(`没写届别；截止 ${date} 在本季之内`);
  return unknown("公告没写届别");
}

export function checkNotice(doc: NoticeDoc, ex: Extract, co: CompanyIdentity, season: Season = SEASON): { gates: Gates; outcome: Outcome; fact?: { policy: Policy; date?: string; evidence: string } } {
  const said = ex.deadlineText ? readDeadline(ex.deadlineText) : null;
  const date = said && !("unclear" in said) ? said.date : undefined;
  const gates: Gates = { publisher: publisherGate(doc, co), issuer: issuerGate(ex, co, doc), evidence: ex.deadlineText ? evidenceGate(doc, ex) : unknown("公告没写截止"), season: seasonGate(ex, season, date, doc) };
  if (doc.status !== "ok" && doc.status !== "partial") return { gates, outcome: "unreadable" };
  if (!ex.isRecruitment) return { gates, outcome: "not_recruitment" };
  const all = (Object.values(gates) as Gate[]).every((g) => g.result === "pass");
  // the whole batch: nothing said, or exactly 「全部 / 所有岗位」 — 「全部岗位，部分除外」 is not the whole
  const whole = (!(ex.scope ?? "").trim() || /^(全部|所有|全体)(岗位|职位)?$/.test(norm(ex.scope))) && !NARROWER.test(ex.deadlineText ?? "");
  if (ex.deadlineText) {
    if (all && whole && !ex.doubts && said && !("unclear" in said)) return { gates, outcome: "fact", fact: { ...said, evidence: ex.deadlineImage != null ? `海报图 ${ex.deadlineImage}：${ex.deadlineText.trim()}` : ex.deadlineText.trim() } };
    return { gates, outcome: "review" };
  }
  // no deadline in it: worth saying only of the whole of an official announcement for this company, this season, all of
  // which the model was shown — a cut-off text or a poster it did not see may be where the deadline is
  const shownAll = !!ex.seen && ex.seen.chars >= doc.text.length && ex.seen.images >= doc.images.length;
  const sure = doc.status === "ok" && doc.complete && shownAll && gates.publisher.result === "pass" && gates.issuer.result === "pass" && gates.season.result !== "fail" && !ex.doubts;
  return { gates, outcome: sure ? "not_stated" : "review" };
}

/** What a reading looks like, to tell next time whether anything changed: the words (dates kept), the links, the images. */
export const fingerprint = (doc: NoticeDoc) => createHash("sha256").update([doc.title, doc.account?.id ?? "", doc.account?.name ?? "", doc.text.normalize("NFKC").replace(/\s+/g, " ").trim(), ...(doc.links ?? []).slice().sort(), ...doc.images.map((i) => `${i.n}:${i.hash}`)].join("\n")).digest("hex").slice(0, 32);

/**
 * File one check: the reading, what was found, and — when everything passed — the deadline fact, in one transaction.
 * A check that does not end in a fact replaces nothing: what was known before still stands.
 */
export function recordCheck(s: { db: Db; vault: string }, subject: { type: "campaign" | "position"; id: string }, doc: NoticeDoc, ex: Extract | null, result: ReturnType<typeof checkNotice> | null, by = ""): { readId: string; checkId: string; factId?: string } {
  const db = s.db, at = now(), readId = ulid(), checkId = ulid();
  const dir = join(s.vault, "notices");
  mkdirSync(dir, { recursive: true });
  const textPath = join(dir, `${readId}.txt`);
  writeFileSync(textPath, doc.text, "utf8");
  let factId: string | undefined;
  db.exec("begin");
  try {
    db.prepare("insert into notice_read(id, url, final_url, via, status, note, title, account_id, account_name, text_path, fingerprint, images, complete, read_at) values (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(readId, doc.url, doc.finalUrl, doc.via, doc.status, doc.note ?? "", doc.title, doc.account?.id ?? "", doc.account?.name ?? "", textPath, fingerprint(doc), JSON.stringify(doc.images), doc.complete ? 1 : 0, at);
    // what the check leaned on; a deadline is written only if all of it still stands now, inside this transaction
    const deps = result ? (Object.values(result.gates) as Gate[]).flatMap((g) => (g.result === "pass" ? g.deps ?? [] : [])) : [];
    const stands = depsStand(db, deps);
    if (result && !stands) result = { ...result, outcome: "review", fact: undefined, gates: { ...result.gates, publisher: unknown(`${result.gates.publisher.why}（依据已撤回或过期）`) } };
    const outcome: Outcome = result?.outcome ?? "unreadable";
    db.prepare("insert into notice_check(id, subject_type, subject_id, read_id, rule_version, extract, gates, outcome, by, checked_at) values (?,?,?,?,?,?,?,?,?,?)")
      .run(checkId, subject.type, subject.id, readId, RULE_VERSION, JSON.stringify(ex ?? {}), JSON.stringify(result?.gates ?? {}), outcome, by, at);
    const dep = db.prepare("insert or ignore into notice_check_dep(check_id, kind, ref_id) values (?,?,?)");
    for (const d of deps) dep.run(checkId, d.kind, d.id);
    if (outcome === "fact" && result?.fact) {
      const f = result.fact;
      factId = recordFact(db, { ...(subject.type === "campaign" ? { campaignId: subject.id } : { positionId: subject.id }), policy: f.policy, date: f.date, grade: "官方", sourceKind: "notice", url: doc.finalUrl || doc.url, evidence: f.evidence, by: by || "notice.verify", checkId }).id;
    }
    db.exec("commit");
  } catch (e) { db.exec("rollback"); throw e; }
  return { readId, checkId, factId };
}
