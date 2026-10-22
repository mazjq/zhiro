import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import type { Db } from "../db.js";
import { json, now, tx } from "../db.js";
import type { Llm } from "../llm.js";
import { DomainError, NotFound, companyKey, type Domain } from "./domain.js";
import { withPurpose, currentPurpose } from "./usage.js";
import { oldestWaitingMail } from "./model-jobs.js";
import { enqueue } from "../notify/center.js";

/** Mail providers that accept a 授权码 over IMAP — no OAuth, no app registration, reachable from mainland China. */
export const PROVIDERS: Record<string, { label: string; host: string; port: number; help: string }> = {
  "163": { label: "163 邮箱", host: "imap.163.com", port: 993, help: "网页版 设置 → POP3/SMTP/IMAP → 开启 IMAP/SMTP 服务 → 生成授权码" },
  qq: { label: "QQ 邮箱", host: "imap.qq.com", port: 993, help: "网页版 设置 → 账号 → 开启 IMAP/SMTP 服务 → 生成授权码" },
};

export interface MailAccount { id: string; provider: string; email: string; authCode: string; addedAt: string }
export interface RawMail { messageId: string; from: string; subject: string; date: string; text: string; html?: string; eml?: Buffer; folder?: string }
/** `messageId` set = fetch just that one message (used to rescue a mail the filter skipped). */
export type MailFetcher = (account: MailAccount, since: Date, opts?: { messageId?: string }) => Promise<RawMail[]>;

// ---------- accounts: the 授权码 is a secret, so it lives in its own file next to credentials.json, never in the DB or yaml
const accountsFile = (vault: string) => join(vault, "config", "mail.json");
export function loadAccounts(vault: string): MailAccount[] {
  return existsSync(accountsFile(vault)) ? (JSON.parse(readFileSync(accountsFile(vault), "utf8")) as MailAccount[]) : [];
}
function saveAccounts(vault: string, list: MailAccount[]) {
  mkdirSync(join(vault, "config"), { recursive: true });
  writeFileSync(accountsFile(vault), JSON.stringify(list, null, 1), "utf8");
  try { chmodSync(accountsFile(vault), 0o600); } catch { /* windows */ }
}
export const publicAccount = (a: MailAccount) => ({ id: a.id, provider: a.provider, email: a.email, addedAt: a.addedAt });

export async function connectAccount(vault: string, p: { provider: string; email: string; authCode: string }, fetcher: MailFetcher) {
  if (!PROVIDERS[p.provider]) throw new DomainError("BAD_PROVIDER", `支持：${Object.keys(PROVIDERS).join(" / ")}`);
  const account: MailAccount = { id: `${p.provider}:${p.email.trim().toLowerCase()}`, provider: p.provider, email: p.email.trim(), authCode: p.authCode.trim(), addedAt: now() };
  try { await fetcher(account, new Date()); } // a login + empty search proves the code works before it is stored
  catch (e: any) { throw new DomainError("LOGIN_FAILED", `登录失败：${e?.responseText ?? e?.message ?? e}。确认已在网页版开启 IMAP 并使用「授权码」而不是登录密码。`); }
  saveAccounts(vault, [...loadAccounts(vault).filter((a) => a.id !== account.id), account]);
  return publicAccount(account);
}
export function disconnectAccount(vault: string, id: string) {
  const list = loadAccounts(vault);
  if (!list.some((a) => a.id === id)) throw new NotFound(`mail account ${id}`);
  saveAccounts(vault, list.filter((a) => a.id !== id));
  return { ok: true };
}

// ---------- which mail is ours to read
/**
 * The filter is the only place a mail can be dropped without a model ever seeing it, so it errs wide, on three signals:
 *   1. recruiting words in sender / subject / opening text
 *   2. the sender is an applicant-tracking system (Moka, 北森, 牛客, 大易 …) — their notices sometimes say very little
 *   3. the mail mentions a company the user has an application with — "关于下周安排" from that company's HR has no keyword at all
 * What still fails all three is logged by subject only (`mail_skipped`), so the user can look the list over and rescue one.
 */
const WORDS = /面试|笔试|测评|在线测|考试|offer|录用|入职|应聘|投递|简历|校招|校园招聘|秋招|春招|招聘|宣讲|候选人|人才|人力资源|hr\b|interview|assessment|application|recruit|campus|career|talent|hiring|onboard/i;
const ATS = /mokahr|moka|beisen|italent|zhiye\.com|nowcoder|牛客|dayee|大易|hotjob|51job|zhaopin|智联|liepin|猎聘|lagou|feishu|lark|kanzhun|boss|shixiseng|实习僧|yingjiesheng|应届生|ncss|24365|wintalent|avature|workday|successfactors|greenhouse|lever\.co/i;
export function looksLikeRecruiting(m: Pick<RawMail, "from" | "subject" | "text">, appliedCompanies: string[] = []): boolean {
  const head = `${m.from}\n${m.subject}\n${m.text.slice(0, 800)}`;
  if (WORDS.test(head) || ATS.test(m.from)) return true;
  const flat = companyKey(head);
  return appliedCompanies.some((c) => c.length >= 2 && flat.includes(c));
}

/** Names (and aliases) of companies the user has an open application with, as lossless keys; legal suffixes dropped so "华中数控" matches "武汉华中数控股份有限公司". */
export function appliedCompanyKeys(db: Db): string[] {
  const rows = db.prepare("select distinct co.name, co.aliases from application a join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id where a.state not in ('closed', 'cancelled')").all() as any[];
  // HR mail says "华中数控", the registered name is "武汉华中数控股份有限公司": also try it without the legal tail and the place-name head
  const REGION = /^(中国|北京|上海|天津|重庆|深圳|广州|武汉|杭州|南京|成都|西安|苏州|长沙|合肥|青岛|厦门|宁波|无锡|济南|郑州|大连|沈阳|哈尔滨|长春|福州|东莞|佛山|珠海|昆明|贵阳|南昌|太原|石家庄|兰州|乌鲁木齐|湖北|湖南|广东|江苏|浙江|山东|四川|陕西|河南|河北|安徽|福建|江西|辽宁|吉林|黑龙江)(市|省)?/u;
  const short = (n: string) => companyKey(n).replace(/(股份|集团|科技|技术)$/u, "");
  const brand = (n: string) => short(n).replace(REGION, "");
  return [...new Set(rows.flatMap((r) => [r.name, ...json.parse(r.aliases, [] as string[])]).flatMap((n: string) => [companyKey(n), short(n), brand(n)]).filter((k) => k.length >= 3))];
}

export const CATEGORIES = ["投递确认", "测评", "笔试", "面试", "面试改期", "面试取消", "通过", "offer", "拒信", "待办", "其他"] as const;
export const ROUNDS = ["一面", "二面", "三面", "终面", "技术面", "综合面", "HR面"] as const;
export interface Classified { category: (typeof CATEGORIES)[number]; round: string; isReminder: boolean; company: string; position: string; scheduledAt: string | null; link: string; summary: string; confidence: number }

const SYSTEM = `你在帮一名求职者整理收件箱。判断这条邮件/短信/微信通知是不是招聘流程通知，只输出 JSON：
{"category":"","round":"","isReminder":false,"company":"","position":"","scheduledAt":null,"link":"","summary":"","confidence":0.0}
category 只能取下面之一：
- 投递确认：已收到简历、投递成功、进入筛选。
- 测评：性格/能力/认知/在线测评邀请（北森、Talview 等）。
- 笔试：笔试或在线编程考试的邀请与安排（牛客、赛码等）。
- 面试：任何一轮面试的邀请或时间安排（含 AI 面试、群面、电话面试）。
- 面试改期：已安排的面试/笔试改了时间。scheduledAt 填新时间。
- 面试取消：已安排的面试/笔试取消。
- 通过：告知某一轮通过、进入下一轮，但还没给出下一轮的具体时间。
- offer：录用意向、offer、录用通知、签约/三方安排。
- 拒信：未通过、不合适、人才库、感谢关注、流程终止。
- 待办：要求候选人补充材料、完善简历、填写信息、确认意向、预约时间段等，且有动作要做。
- 其他：广告、订阅推送、宣讲会/直播群发、面试体验问卷、平台营销、验证码、与某次投递无关的内容。
其他字段：
- round：面试是第几轮或哪一类，只能是 一面/二面/三面/终面/技术面/综合面/HR面 之一；没写或不是面试就留空。"初面/初试/第一轮"=一面，"复试/第二轮"=二面，"终试/总监面/高管面"=终面。
- isReminder：这条只是对之前已经通知过的安排的提醒/催办（"将于今晚开始""还有1小时""您还未完成测评""请记得参加"），而不是第一次通知，就填 true。
- company 写招聘单位，不是招聘平台（Moka、北森、牛客、智联等是平台）；position 写岗位名，没写留空。
- scheduledAt：写明的考试/面试开始时间，ISO 8601 带 +08:00；邮件没写年份就用邮件日期所在年份；只有截止时间时填截止时间（测评/笔试/待办常见）；都没有填 null，不要推算。
- link：参加或查看详情的链接，原样抄写，没有留空。
- summary：一句话，含时间、形式、需要对方做什么。只写原文里有的。
- confidence：0 到 1。
同一封里既有通过上一轮又给了下一轮时间的，按 面试 处理（round 填下一轮）。`;

export async function classify(llm: Llm, m: RawMail): Promise<Classified> {
  const user = `发件人：${m.from}\n主题：${m.subject}\n时间：${m.date}\n\n正文：\n${m.text.slice(0, 8000)}`;
  const msg = await llm.models.completeSimple(llm.model(), { systemPrompt: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: user }], timestamp: Date.now() }] }, { reasoning: "low" });
  const o = parseJsonWithRepair<Partial<Classified>>(contentText(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const category = (CATEGORIES as readonly string[]).includes(o.category ?? "") ? (o.category as Classified["category"]) : "其他";
  const round = (ROUNDS as readonly string[]).includes(o.round ?? "") ? (o.round as string) : "";
  const at = o.scheduledAt && !Number.isNaN(Date.parse(o.scheduledAt)) ? o.scheduledAt : null;
  return { category, round, isReminder: o.isReminder === true, company: (o.company ?? "").trim(), position: (o.position ?? "").trim(), scheduledAt: at, link: (o.link ?? "").trim(), summary: (o.summary ?? "").trim(), confidence: Math.max(0, Math.min(1, Number(o.confidence) || 0)) };
}

// ---------- which application is this about
const bigrams = (s: string) => { const t = companyKey(s); const out = new Set<string>(); for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2)); return out; };
const overlap = (a: string, b: string) => { const x = bigrams(a), y = bigrams(b); if (!x.size || !y.size) return 0; let n = 0; for (const g of x) if (y.has(g)) n++; return n / Math.min(x.size, y.size); };

/** A company name without its legal tail and its place-name head: 「中国石油集团工程技术研究院有限公司」 → 「石油集团工程技术研究院」. */
const coreName = (n: string) => companyKey(n).replace(/(股份|集团|科技|技术)?(有限|有限责任)?(公司)?$/u, "").replace(/^(中国|中)/u, "");
/**
 * The Chinese core of a name: no Latin brand, no legal or generic tail — 「DJI 大疆」 → 「大疆」, 「大疆创新科技有限公司」 →
 * 「大疆」. Two names whose cores contain one another (two characters at least) are taken for the same employer.
 */
const GENERIC = /(股份有限公司|有限责任公司|有限公司|集团|股份|公司|创新|科技|技术|智能|信息|控股|中国|中)/gu;
const cnCore = (n: string) => n.replace(/[^\u4e00-\u9fff]/gu, "").replace(GENERIC, "");
const sameCore = (a: string, b: string) => { const x = cnCore(a), y = cnCore(b); return x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x)); };

/** Categories that only happen after applying: they are about an application already sent, not one still being prepared. */
const AFTER_SENDING = new Set(["测评", "笔试", "面试", "面试改期", "面试取消", "通过", "offer", "拒信"]);

/**
 * Which application a mail is about, and the ones it could be about when that cannot be told (P2a, B2, B4):
 *   1. the company by name or alias, either containing the other; else by a close name (two-character pieces, ≥ 0.6) —
 *      a close name alone is only a candidate, it needs the job title to agree as well;
 *   2. several applications there: the job title decides (clearly ahead of the next);
 *   3. still several: a test, an interview, a result can only be about one already sent — if exactly one is, it is that.
 * Anything else is left for the person, with the candidates kept: a wrong guess would file an interview under the
 * wrong application, a question costs one click.
 */
export function linkCandidates(db: Db, company: string, position: string, category = ""): { id: string | null; candidates: string[] } {
  if (!company) return { id: null, candidates: [] };
  const key = companyKey(company), core = coreName(company);
  const apps = db.prepare(`select a.id, a.state, p.title, co.name, co.aliases from application a join position p on p.id = a.position_id
    join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id where a.state not in ('closed', 'cancelled')`).all() as any[];
  const names = (a: any) => [a.name, ...json.parse(a.aliases, [] as string[])] as string[];
  const exact = apps.filter((a) => names(a).some((n) => { const k = companyKey(n); return k === key || (key.length >= 2 && (k.includes(key) || key.includes(k))) || sameCore(n, company); }));
  const close = exact.length ? [] : apps.filter((a) => names(a).some((n) => overlap(coreName(n), core) >= 0.6));
  const titled = (list: any[]) => {
    if (!position) return null;
    const ranked = list.map((a) => ({ id: a.id as string, s: overlap(a.title, position) })).sort((x, y) => y.s - x.s);
    return ranked[0] && ranked[0].s >= 0.5 && (ranked.length === 1 || ranked[0].s > ranked[1].s) ? ranked[0].id : null;
  };
  if (close.length) return { id: titled(close), candidates: close.map((a) => a.id) }; // a close name: only with the title
  if (exact.length <= 1) return { id: exact[0]?.id ?? null, candidates: exact.map((a) => a.id) };
  const byTitle = titled(exact);
  if (byTitle) return { id: byTitle, candidates: exact.map((a) => a.id) };
  // only when the mail names no job: a title that matches none of them is not a reason to pick the sent one
  const sent = AFTER_SENDING.has(category) && !position.trim() ? exact.filter((a) => a.state === "submitted" || a.state === "in_process") : [];
  return { id: sent.length === 1 ? sent[0].id : null, candidates: exact.map((a) => a.id) };
}
/** The application a mail is about, or null (linkCandidates without the candidates). */
export const linkApplication = (db: Db, company: string, position: string, category = ""): string | null => linkCandidates(db, company, position, category).id;

// ---------- message → stored row → proposal
export interface InboxDeps { domain: Domain; vault: string; llm?: Llm; onChanged?: () => void; /** P2b: file clear mail on its own (default on) */ auto?: boolean }

function msgRow(r: any) {
  return { id: r.id as string, account: r.account as string, from: r.sender as string, subject: r.subject as string, receivedAt: r.received_at as string, category: r.category as string, round: r.round as string,
    company: r.company as string, position: r.position as string, scheduledAt: (r.scheduled_at ?? null) as string | null, link: r.link as string, summary: r.summary as string,
    confidence: r.confidence as number, applicationId: (r.application_id ?? null) as string | null, proposalId: (r.proposal_id ?? null) as string | null, status: r.status as string,
    note: r.note as string, folder: r.folder as string, candidates: json.parse(r.candidates_json ?? "[]", [] as string[]) };
}

const INTERVIEW_KINDS = ["面试", ...ROUNDS];
const sameDay = (a: string | null, b: string | null) => (!a && !b) || (!!a && !!b && a.slice(0, 10) === b.slice(0, 10));
const dayText = (s: string | null) => (s ? s.slice(5, 16).replace("T", " ") : "时间未定");

/**
 * What a classified, linked message asks to change — always as a proposal (mail is untrusted input; the user approves).
 * Returns `note` instead when nothing should change: most often a reminder about something already on record.
 */
function decide(db: Db, c: Classified, applicationId: string, subject: string): { kind: string; payload: unknown } | { note: string } {
  const app = db.prepare("select state from application where id = ?").get(applicationId) as { state: string };
  const stages = db.prepare("select * from stage where application_id = ? order by created_at").all(applicationId) as any[];
  const pending = (db.prepare("select kind, payload_json from proposal where decision = 'pending'").all() as any[]).map((p) => ({ kind: p.kind as string, payload: json.parse(p.payload_json, {} as any) })).filter((p) => (p.payload.applicationId ?? p.payload.id) === applicationId);
  const notes = c.summary || subject;
  const interviewStage = () => [...stages].reverse().find((s) => (c.round ? s.kind === c.round : INTERVIEW_KINDS.includes(s.kind) || s.kind === "笔试" || s.kind === "测评") && !s.result);

  if (c.category === "测评" || c.category === "笔试" || c.category === "面试" || c.category === "offer") {
    const kind = c.category === "面试" ? c.round || "面试" : c.category;
    // The same event announced again: same kind and (same day, or the same join link, or the mail itself is a reminder —
    // "今晚 19:00 开始" pasted a week late resolves to the wrong date, so the date alone can't be trusted for reminders).
    const same = (at: string | null, link: string, open: boolean) => sameDay(at, c.scheduledAt) || (!!c.link && link === c.link) || (c.isReminder && open);
    const onRecord = stages.find((s) => s.kind === kind && same(s.scheduled_at, s.link, !s.result));
    if (onRecord) return { note: `和已记录的「${kind} ${dayText(onRecord.scheduled_at)}」是同一件事（${c.isReminder ? "提醒" : "重复通知"}），没有重复记` };
    const waiting = pending.find((p) => p.kind === "stage.add" && p.payload.kind === kind && same(p.payload.scheduledAt ?? null, p.payload.link ?? "", true));
    if (waiting) return { note: `已经有一条待你确认的「${kind} ${dayText(waiting.payload.scheduledAt ?? null)}」，这条是同一件事` };
    // an offer's date in the mail is the deadline to answer, not when the offer "happens": keep it in the notes only
    return { kind: "stage.add", payload: { applicationId, kind, scheduledAt: c.category === "offer" ? undefined : c.scheduledAt ?? undefined, link: c.link || undefined, notes } };
  }
  if (c.category === "面试改期") {
    const s = interviewStage();
    if (s && sameDay(s.scheduled_at, c.scheduledAt) && s.scheduled_at === c.scheduledAt) return { note: "记录里已经是这个时间了" };
    return s ? { kind: "stage.update", payload: { id: s.id, scheduledAt: c.scheduledAt ?? undefined, link: c.link || undefined, notes } }
      : { kind: "stage.add", payload: { applicationId, kind: c.round || "面试", scheduledAt: c.scheduledAt ?? undefined, link: c.link || undefined, notes } };
  }
  if (c.category === "面试取消") { const s = interviewStage(); return s ? { kind: "stage.update", payload: { id: s.id, result: "已取消", notes } } : { note: "记录里没有对应的面试，无需改动" }; }
  if (c.category === "通过") {
    const s = interviewStage();
    if (s) return { kind: "stage.update", payload: { id: s.id, result: "通过", notes } };
    // no stage waiting for a result: still progress — sent becomes 流程中, and the notice is kept on the application
    return app.state === "submitted" ? { kind: "application.update", payload: { id: applicationId, state: "in_process", note: `收到通过通知：${notes}` } }
      : app.state === "in_process" ? { kind: "application.update", payload: { id: applicationId, note: `收到通过通知：${notes}` } }
      : { note: "这条申请还没投递，先不推进" };
  }
  if (c.category === "拒信") return app.state === "closed" ? { note: "这条申请已经结束了" } : { kind: "application.update", payload: { id: applicationId, state: "closed", closeReason: "拒信", note: notes } };
  if (c.category === "投递确认") return app.state === "draft" ? { kind: "application.update", payload: { id: applicationId, state: "submitted", note: notes } } : { note: "申请已经是已投递状态，无需改动" };
  if (c.category === "待办") return { kind: "application.update", payload: { id: applicationId, nextAction: notes.slice(0, 120), nextActionAt: c.scheduledAt ?? undefined } };
  return { note: "" };
}

/** Same text arriving twice (mailbox + paste, or a forwarded copy) must not be stored or proposed twice. The whole text
 * counts (B31): two notices that open alike and differ further down are two mails. */
const contentKey = (m: RawMail) => createHash("sha256").update(companyKey(m.subject) + "|" + companyKey(m.text)).digest("hex").slice(0, 40);
/** The key mail stored before v42 carries (the first 600 characters): still looked up, so an upgrade never stores a mail twice. */
const legacyKey = (m: RawMail) => createHash("sha256").update(companyKey(m.subject) + "|" + companyKey(m.text).slice(0, 600)).digest("hex").slice(0, 40);

export async function ingestMessage(d: InboxDeps, account: string, m: RawMail) {
  const db = d.domain.db;
  const key = contentKey(m);
  const known = db.prepare("select * from message where message_id = ? or content_key in (?, ?)").get(m.messageId, key, legacyKey(m)) as any;
  if (known?.status === "unclassified" && (!known.classify_next_at || known.classify_next_at <= now())) { // kept earlier, not classified yet, its turn has come
    await classifyTurn(d, known.id, m);
    d.onChanged?.();
    return { message: msgRow(db.prepare("select * from message where id = ?").get(known.id)), added: false };
  }
  if (known) return { message: msgRow(known), added: false };
  // kept before anything can fail (B30): no model, a short allowance or an error leaves it waiting, never lost
  const id = ulid();
  const dir = join(d.vault, "inbox"); mkdirSync(dir, { recursive: true });
  const bodyPath = join(dir, id + ".txt");
  writeFileSync(bodyPath, `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.text}`, "utf8");
  if (m.html) writeFileSync(join(dir, id + ".html"), m.html, "utf8");
  if (m.eml) writeFileSync(join(dir, id + ".eml"), m.eml);
  const kept = db.prepare(`insert or ignore into message(id, account, message_id, content_key, sender, subject, received_at, body_path, category, status, note, folder, created_at)
    values (?,?,?,?,?,?,?,?, '', 'unclassified', '', ?, ?)`).run(id, account, m.messageId, key, m.from, m.subject, m.date, bodyPath, m.folder ?? "", now());
  if (!kept.changes) return { message: msgRow(db.prepare("select * from message where message_id = ? or content_key in (?, ?)").get(m.messageId, key, legacyKey(m))), added: false }; // a parallel pull kept it first
  db.prepare("delete from mail_skipped where message_id = ?").run(m.messageId);
  await classifyTurn(d, id, m);
  d.onChanged?.();
  return { message: msgRow(db.prepare("select * from message where id = ?").get(id)), added: true };
}

/** Classify a kept mail and file what it asks for. Throws when the model cannot answer now; the mail stays kept. */
async function classifyKept(d: InboxDeps, id: string, m: RawMail) {
  const db = d.domain.db;
  if (!d.llm) throw new DomainError("NO_MODEL", "未配置模型，邮件已保存，等能分类时再处理");
  // ref = the mail's date: a mail whose classification waits for an external agent (ADR-032) keeps the pull looking back to it
  const c = await withPurpose(currentPurpose().purpose, m.date, () => classify(d.llm!, m));
  // the model took seconds: only the run that still finds the mail unclassified files anything (a paste and a pull at
  // once, or a person placing it meanwhile) — claimed, decided and filed in one transaction
  tx(db, () => {
    if (!db.prepare("select 1 from message where id = ? and status = 'unclassified'").get(id)) return;
    const link = c.category === "其他" ? { id: null, candidates: [] as string[] } : linkCandidates(db, c.company, c.position, c.category);
    let proposalId: string | null = null, note = "", status = "new";
    if (link.id) {
      const r = decide(db, c, link.id, m.subject);
      if ("note" in r) note = r.note;
      else if (d.auto !== false && c.confidence >= AUTO_CONFIDENCE && !isTimeless(c, r)) { note = fileMail(d, id, r, c, m.subject); status = "filed"; }
      else { proposalId = d.domain.createProposal(r.kind, r.payload, "system:inbox", `来自「${m.subject.slice(0, 60)}」：${c.summary}`.slice(0, 300), 24 * 14).id; status = "proposed"; }
    } else if (c.category !== "其他") {
      status = "unlinked"; // which application: the person picks (inbox.link); a test in it is reminded of meanwhile
      note = link.candidates.length > 1 ? `可能是 ${link.candidates.length} 条申请之一，请在收件箱里选` : link.candidates.length ? "公司名对不太上，请在收件箱里确认是不是这条申请" : "没找到对应的申请";
    }
    db.prepare(`update message set category = ?, round = ?, company = ?, position = ?, scheduled_at = ?, link = ?, summary = ?, confidence = ?, application_id = ?,
      proposal_id = ?, status = ?, note = ?, candidates_json = ?, is_reminder = ?, classify_next_at = null where id = ?`).run(c.category, c.round, c.company, c.position, c.scheduledAt, c.link, c.summary, c.confidence,
      link.id, proposalId, status, note, JSON.stringify(link.candidates), c.isReminder ? 1 : 0, id);
  });
}

// ---------- P2b: clear mail is filed on its own

/** How sure the classification must say it is before mail changes anything by itself (with a unique link besides). */
const AUTO_CONFIDENCE = 0.8;
/** A test or interview invitation without a time is still asked about: a stage with no time reminds of nothing. */
const isTimeless = (c: Classified, r: { kind: string; payload: any }) => r.kind === "stage.add" && ["笔试", "面试"].includes(c.category) && !r.payload.scheduledAt;
/** What is worth telling the person at once when mail moved something (the rest goes into the daily brief). */
const TELL = new Set(["笔试", "测评", "面试", "面试改期", "面试取消", "通过", "offer", "拒信"]);

/**
 * File what a mail asks for — the only writes mail makes on its own: a stage added or updated, an application moved or
 * annotated. What it was before is kept on the message (filed_json), the doing is in the history (agent_action, by
 * system:inbox) with inbox.unfile as its undo, and the person is told of anything that matters.
 */
function fileMail(d: InboxDeps, messageId: string, r: { kind: string; payload: any }, c: Classified, subject: string): string {
  const db = d.domain.db, src = "system:inbox";
  const appId = r.kind === "stage.update" ? (db.prepare("select application_id from stage where id = ?").get(r.payload.id) as any)?.application_id : r.payload.applicationId ?? r.payload.id;
  const before = db.prepare("select state, close_reason, next_action, next_action_at from application where id = ?").get(appId) as any;
  const stageBefore = r.kind === "stage.update" ? db.prepare("select scheduled_at, result, link, notes from stage where id = ?").get(r.payload.id) : null;
  let created: string | null = null, said = "";
  if (r.kind === "stage.add") { created = d.domain.addStage(r.payload, src).id; said = `记了${r.payload.kind}${r.payload.scheduledAt ? `（${String(r.payload.scheduledAt).slice(5, 16).replace("T", " ")}）` : ""}`; }
  else if (r.kind === "stage.update") { d.domain.updateStage(r.payload, src); said = r.payload.result ? `环节结果：${r.payload.result}` : `环节改到 ${String(r.payload.scheduledAt ?? "").slice(5, 16).replace("T", " ")}`; }
  else { d.domain.updateApplication(r.payload, src); said = r.payload.state ? `申请改为「${({ submitted: "已投递", in_process: "流程中", closed: "已结束" } as any)[r.payload.state] ?? r.payload.state}」` : "记了一条进展"; }
  const after = db.prepare("select updated_at from application where id = ?").get(appId) as any;
  db.prepare("update message set filed_json = ? where id = ?").run(JSON.stringify({ kind: r.kind, payload: r.payload, applicationId: appId, before, stageBefore, created, afterUpdatedAt: after?.updated_at }), messageId);
  db.prepare("insert into agent_action(id, at, actor, tool, input_json, summary, undo_json, turn_id) values (?,?,?,?,?,?,?,null)")
    .run(ulid(), now(), src, r.kind, JSON.stringify(r.payload), `邮件「${subject.slice(0, 30)}」：${said}`, JSON.stringify({ name: "inbox.unfile", input: { id: messageId } }));
  if (TELL.has(c.category)) {
    const co = db.prepare("select co.name, p.title from application a join position p on p.id = a.position_id join campaign ca on ca.id = a.campaign_id join company co on co.id = ca.company_id where a.id = ?").get(appId) as any;
    enqueue(db, { key: `filed:${messageId}`, kind: "mail", urgency: c.category === "offer" || c.category === "拒信" ? "today" : "info", title: `${c.category} · ${co?.name ?? c.company}`,
      lines: [`**${co?.name ?? c.company}** · ${co?.title ?? c.position}`, c.summary || subject, `Zhiro 已记下：${said}（记错了可在收件箱里撤销）`], refKind: "filed", refId: messageId });
  }
  return `已自动记下：${said}`;
}

/**
 * inbox.unfile: undo what a mail filed on its own — only while nothing was changed after it (the stage untouched, the
 * application not updated since); otherwise the person is told to set it right by hand, nothing is overwritten.
 */
export function unfileMail(d: InboxDeps, messageId: string) {
  const db = d.domain.db;
  const m = db.prepare("select * from message where id = ?").get(messageId) as any;
  if (!m) throw new NotFound(`message ${messageId}`);
  if (m.status !== "filed" || !m.filed_json) throw new DomainError("NOT_FILED", "这封邮件没有自动记过账");
  const f = JSON.parse(m.filed_json);
  return tx(db, () => {
    const app = db.prepare("select updated_at from application where id = ?").get(f.applicationId) as any;
    if (app && f.afterUpdatedAt && app.updated_at !== f.afterUpdatedAt) throw new DomainError("CHANGED_SINCE", "这条申请在那之后又改过了：自动撤销会覆盖你的改动，请在投递页手动改回");
    if (f.created) {
      const st = db.prepare("select result from stage where id = ?").get(f.created) as any;
      if (st && st.result) throw new DomainError("CHANGED_SINCE", "这个环节后来记了结果：请手动处理");
      db.prepare("delete from stage where id = ?").run(f.created);
      db.prepare("update notice set state = 'cancelled', last_error = '自动记账已撤销', next_at = null where ref_kind = 'stage' and ref_id = ? and state in ('pending', 'sent')").run(f.created);
    }
    if (f.stageBefore) db.prepare("update stage set scheduled_at = ?, result = ?, link = ?, notes = ? where id = ?").run(f.stageBefore.scheduled_at, f.stageBefore.result, f.stageBefore.link, f.stageBefore.notes, f.payload.id);
    if (f.before) db.prepare("update application set state = ?, close_reason = ?, next_action = ?, next_action_at = ?, updated_at = ? where id = ?").run(f.before.state, f.before.close_reason, f.before.next_action, f.before.next_action_at, now(), f.applicationId);
    d.domain.event(f.applicationId, "note", `撤销了邮件「${String(m.subject).slice(0, 40)}」的自动记账`, "manual");
    db.prepare("update message set status = 'new', note = '自动记账已撤销', filed_json = null where id = ?").run(messageId);
    return { ok: true };
  });
}

/** One try at classifying a kept mail; a failure waits longer each time (5 min, 10, 20 … up to 6 h) and lets others go first. */
async function classifyTurn(d: InboxDeps, id: string, m: RawMail) {
  try { await classifyKept(d, id, m); }
  catch (e: any) {
    // no model, or the answer is coming from the person's agent: nothing was spent, the next chance is taken as it comes
    if (e?.code === "NO_MODEL" || e?.code === "MODEL_DELEGATED") throw e;
    const r = d.domain.db.prepare("select classify_attempts from message where id = ?").get(id) as { classify_attempts: number } | undefined;
    const n = (r?.classify_attempts ?? 0) + 1;
    // a deferral says when it may try again; anything else backs off
    const next = e?.code === "BUDGET_DEFERRED" && e.until ? e.until : new Date(Date.now() + Math.min(6 * 3600_000, 5 * 60_000 * 2 ** (n - 1))).toISOString();
    d.domain.db.prepare("update message set classify_attempts = ?, classify_next_at = ?, note = ? where id = ? and status = 'unclassified'").run(n, next, `还没分类：${String(e?.message ?? e).slice(0, 120)}`, id);
    throw e;
  }
}

/** Mail kept but not classified yet, whose turn has come: tried again at each pull, the ones tried least first. */
export async function classifyWaiting(d: InboxDeps, limit = 20): Promise<{ done: number; errors: string[] }> {
  const rows = d.domain.db.prepare("select * from message where status = 'unclassified' and (classify_next_at is null or classify_next_at <= ?) order by classify_attempts, received_at limit ?").all(now(), limit) as any[];
  const out = { done: 0, errors: [] as string[] };
  for (const r of rows) {
    const text = existsSync(r.body_path) ? readFileSync(r.body_path, "utf8").replace(/^[\s\S]*?\n\n/, "") : "";
    try { await classifyTurn(d, r.id, { messageId: r.message_id, from: r.sender, subject: r.subject, date: r.received_at, text, folder: r.folder }); out.done++; }
    catch (e: any) { out.errors.push(`「${String(r.subject).slice(0, 30)}」：${e?.message ?? e}`); if (e?.code === "BUDGET_DEFERRED" || e?.code === "MODEL_DELEGATED") break; }
  }
  return out;
}

/**
 * inbox.replay: what the current rules would do with the recent mail — which application, and what change — written
 * nowhere. For looking over before mail is filed on its own (P2b).
 */
export function replayMessages(db: Db, limit = 50) {
  const rows = db.prepare("select * from message where status != 'unclassified' and category != '其他' order by received_at desc limit ?").all(limit) as any[];
  return { items: rows.map((r) => {
    const c: Classified = { category: r.category, round: r.round, isReminder: r.is_reminder === 1, company: r.company, position: r.position, scheduledAt: r.scheduled_at, link: r.link, summary: r.summary, confidence: r.confidence };
    const link = linkCandidates(db, c.company, c.position, c.category);
    const would = link.id ? decide(db, c, link.id, r.subject) : null;
    return { messageId: r.id as string, subject: r.subject as string, receivedAt: r.received_at as string, category: c.category, company: c.company, linkedNow: (r.application_id ?? null) as string | null,
      wouldLink: link.id, candidates: link.candidates, wouldDo: would && !("note" in would) ? { tool: would.kind, input: would.payload } : null, note: (r.is_reminder == null ? "（旧邮件没存是否为提醒，按非提醒回放）" : "") + (would && "note" in would ? would.note : link.id ? "" : link.candidates.length ? "分不清是哪条申请" : "没找到对应的申请") };
  }) };
}

export function listMessages(db: Db, q: { category?: string; includeOther?: boolean; limit?: number } = {}) {
  const where = q.category ? "where category = ?" : q.includeOther ? "" : "where category != '其他'";
  const rows = db.prepare(`select * from message ${where} order by received_at desc limit ?`).all(...(q.category ? [q.category] : []), q.limit ?? 100) as any[];
  return { items: rows.map(msgRow) };
}

export function readMessage(db: Db, id: string) {
  const r = db.prepare("select * from message where id = ?").get(id) as any;
  if (!r) throw new NotFound(`message ${id}`);
  const html = String(r.body_path).replace(/\.txt$/, ".html"), eml = String(r.body_path).replace(/\.txt$/, ".eml");
  return { message: msgRow(r), body: existsSync(r.body_path) ? readFileSync(r.body_path, "utf8") : "", html: existsSync(html) ? readFileSync(html, "utf8") : "", emlPath: existsSync(eml) ? eml : "" };
}

/** Manual link for mail the matcher could not (or would not) place; derives the proposal for the chosen application. */
export function linkMessage(d: InboxDeps, id: string, applicationId: string) {
  const db = d.domain.db;
  const r = db.prepare("select * from message where id = ?").get(id) as any;
  if (!r) throw new NotFound(`message ${id}`);
  if (!db.prepare("select 1 from application where id = ?").get(applicationId)) throw new NotFound(`application ${applicationId}`);
  let proposalId = r.proposal_id as string | null, note = r.note as string;
  if (!proposalId) {
    const res = decide(db, { category: r.category, round: r.round, isReminder: false, company: r.company, position: r.position, scheduledAt: r.scheduled_at, link: r.link, summary: r.summary, confidence: r.confidence }, applicationId, r.subject);
    if ("note" in res) note = res.note;
    else proposalId = d.domain.createProposal(res.kind, res.payload, "system:inbox", `来自「${String(r.subject).slice(0, 60)}」：${r.summary}`.slice(0, 300), 24 * 14).id;
  }
  db.prepare("update message set application_id = ?, proposal_id = ?, status = ?, note = ?, candidates_json = '[]' where id = ?").run(applicationId, proposalId, proposalId ? "proposed" : r.status === "unlinked" ? "new" : r.status, note, id);
  // the person said which company this mail's way of writing it means: kept as that company's alias, so the next mail
  // written the same way is placed without asking
  const co = db.prepare("select co.id, co.name, co.aliases from application a join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id where a.id = ?").get(applicationId) as any;
  const said = String(r.company ?? "").trim();
  if (co && said && companyKey(said) !== companyKey(co.name)) {
    const aliases = json.parse(co.aliases, [] as string[]);
    if (!aliases.some((x: string) => companyKey(x) === companyKey(said))) db.prepare("update company set aliases = ? where id = ?").run(JSON.stringify([...aliases, said]), co.id);
  }
  return { message: msgRow(db.prepare("select * from message where id = ?").get(id)) };
}

// ---------- pulling
const SKIPPED_KEEP = 300;
export function listSkipped(db: Db, limit = 100) {
  const rows = db.prepare("select * from mail_skipped order by received_at desc limit ?").all(limit) as any[];
  return { items: rows.map((r) => ({ account: r.account as string, messageId: r.message_id as string, from: r.sender as string, subject: r.subject as string, receivedAt: r.received_at as string, folder: r.folder as string })) };
}

let pulling: Promise<PullResult> | null = null;
export interface PullResult { accounts: number; fetched: number; recruiting: number; added: number; proposals: number; skipped: number; errors: string[] }

/**
 * Pull every connected mailbox (inbox and junk folder). First run looks back 14 days; afterwards from a day before the
 * newest mail seen. The timer and the "立即收取" button share one run, so the same mail is never classified twice in parallel.
 */
export function pullAll(d: InboxDeps, fetcher: MailFetcher): Promise<PullResult> {
  return (pulling ??= (async () => {
    const out: PullResult = { accounts: 0, fetched: 0, recruiting: 0, added: 0, proposals: 0, skipped: 0, errors: [] };
    try {
      const db = d.domain.db;
      const waiting = await classifyWaiting(d);
      out.errors.push(...waiting.errors);
      for (const a of loadAccounts(d.vault)) {
        out.accounts++;
        try {
          const last = (db.prepare("select max(t) as t from (select max(received_at) as t from message where account = ? union all select max(received_at) from mail_skipped where account = ?)").get(a.id, a.id) as any)?.t as string | null;
          const delegated = oldestWaitingMail(db);
          const since = new Date(Math.min(last ? Date.parse(last) - 86400_000 : Date.now() - 14 * 86400_000, delegated ? Date.parse(delegated) - 3600_000 : Infinity));
          const mails = await fetcher(a, since);
          out.fetched += mails.length;
          const applied = appliedCompanyKeys(db);
          for (const m of mails) {
            if (!looksLikeRecruiting(m, applied)) {
              if (db.prepare("insert or ignore into mail_skipped(account, message_id, sender, subject, received_at, folder) values (?,?,?,?,?,?)").run(a.id, m.messageId, m.from, m.subject, m.date, m.folder ?? "").changes) out.skipped++;
              continue;
            }
            out.recruiting++;
            try { const r = await ingestMessage(d, a.id, m); if (r.added) { out.added++; if (r.message.proposalId) out.proposals++; } }
            catch (e: any) { out.errors.push(`「${m.subject.slice(0, 30)}」：${e?.message ?? e}`); } // one bad mail must not stop the rest
          }
          db.prepare("delete from mail_skipped where account = ? and message_id not in (select message_id from mail_skipped where account = ? order by received_at desc limit ?)").run(a.id, a.id, SKIPPED_KEEP);
        } catch (e: any) { out.errors.push(`${a.email}：${e?.responseText ?? e?.message ?? e}`); }
      }
      return out;
    } finally { pulling = null; }
  })());
}

/** Look at one skipped mail: fetched from the mailbox for display only — not stored, not classified, not sent anywhere. */
export async function peekSkipped(vault: string, fetcher: MailFetcher, accountId: string, messageId: string) {
  const a = loadAccounts(vault).find((x) => x.id === accountId);
  if (!a) throw new NotFound(`mail account ${accountId}`);
  const [m] = await fetcher(a, new Date(0), { messageId });
  if (!m) throw new NotFound("邮箱里找不到这封邮件了（可能已被删除）");
  return { from: m.from, subject: m.subject, date: m.date, body: m.text, html: m.html ?? "" };
}

/** The user says a skipped mail is a recruiting notice after all: fetch that one message and run it through, filter bypassed. */
export async function rescueSkipped(d: InboxDeps, fetcher: MailFetcher, accountId: string, messageId: string) {
  const a = loadAccounts(d.vault).find((x) => x.id === accountId);
  if (!a) throw new NotFound(`mail account ${accountId}`);
  const [m] = await fetcher(a, new Date(0), { messageId });
  if (!m) throw new NotFound("邮箱里找不到这封邮件了（可能已被删除）");
  return ingestMessage(d, a.id, m);
}
