import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import type { Db } from "../db.js";
import { json, now } from "../db.js";
import type { Llm } from "../llm.js";
import { DomainError, NotFound, companyKey, type Domain } from "./domain.js";
import { withPurpose, currentPurpose } from "./usage.js";
import { oldestWaitingMail } from "./model-jobs.js";

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

/**
 * Company first (names, aliases, either containing the other). With several applications at that company the job title
 * decides — and when it can't (no title in the mail, or nothing close), return null: a wrong guess would file an
 * interview under the wrong application, asking the user costs one click.
 */
export function linkApplication(db: Db, company: string, position: string): string | null {
  if (!company) return null;
  const key = companyKey(company);
  const apps = db.prepare(`select a.id, p.title, co.name, co.aliases from application a join position p on p.id = a.position_id
    join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id where a.state not in ('closed', 'cancelled')`).all() as any[];
  const mine = apps.filter((a) => [a.name, ...json.parse(a.aliases, [] as string[])].some((n: string) => { const k = companyKey(n); return k === key || (key.length >= 2 && (k.includes(key) || key.includes(k))); }));
  if (mine.length <= 1) return mine[0]?.id ?? null;
  if (!position) return null;
  const ranked = mine.map((a) => ({ id: a.id as string, s: overlap(a.title, position) })).sort((x, y) => y.s - x.s);
  return ranked[0].s >= 0.5 && ranked[0].s > ranked[1].s ? ranked[0].id : null;
}

// ---------- message → stored row → proposal
export interface InboxDeps { domain: Domain; vault: string; llm?: Llm; onChanged?: () => void }

function msgRow(r: any) {
  return { id: r.id as string, account: r.account as string, from: r.sender as string, subject: r.subject as string, receivedAt: r.received_at as string, category: r.category as string, round: r.round as string,
    company: r.company as string, position: r.position as string, scheduledAt: (r.scheduled_at ?? null) as string | null, link: r.link as string, summary: r.summary as string,
    confidence: r.confidence as number, applicationId: (r.application_id ?? null) as string | null, proposalId: (r.proposal_id ?? null) as string | null, status: r.status as string,
    note: r.note as string, folder: r.folder as string };
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
  if (c.category === "通过") { const s = interviewStage(); return s ? { kind: "stage.update", payload: { id: s.id, result: "通过", notes } } : { note: "记录里没有还在等结果的环节，无需改动" }; }
  if (c.category === "拒信") return app.state === "closed" ? { note: "这条申请已经结束了" } : { kind: "application.update", payload: { id: applicationId, state: "closed", closeReason: "拒信", note: notes } };
  if (c.category === "投递确认") return app.state === "draft" ? { kind: "application.update", payload: { id: applicationId, state: "submitted", note: notes } } : { note: "申请已经是已投递状态，无需改动" };
  if (c.category === "待办") return { kind: "application.update", payload: { id: applicationId, nextAction: notes.slice(0, 120), nextActionAt: c.scheduledAt ?? undefined } };
  return { note: "" };
}

/** Same text arriving twice (mailbox + paste, or a forwarded copy) must not be stored or proposed twice. */
const contentKey = (m: RawMail) => createHash("sha256").update(companyKey(m.subject) + "|" + companyKey(m.text).slice(0, 600)).digest("hex").slice(0, 40);

export async function ingestMessage(d: InboxDeps, account: string, m: RawMail) {
  const db = d.domain.db;
  const key = contentKey(m);
  const known = db.prepare("select * from message where message_id = ? or content_key = ?").get(m.messageId, key) as any;
  if (known) return { message: msgRow(known), added: false };
  if (!d.llm) throw new DomainError("NO_MODEL", "未配置模型，无法分类");
  // ref = the mail's date: a mail whose classification waits for an external agent (ADR-032) keeps the pull looking back to it
  const c = await withPurpose(currentPurpose().purpose, m.date, () => classify(d.llm!, m));
  // the model call took seconds: a parallel pull may have stored the same mail meanwhile
  const raced = db.prepare("select * from message where message_id = ? or content_key = ?").get(m.messageId, key) as any;
  if (raced) return { message: msgRow(raced), added: false };

  const id = ulid();
  const dir = join(d.vault, "inbox"); mkdirSync(dir, { recursive: true });
  const bodyPath = join(dir, id + ".txt");
  writeFileSync(bodyPath, `From: ${m.from}\nSubject: ${m.subject}\nDate: ${m.date}\n\n${m.text}`, "utf8");
  if (m.html) writeFileSync(join(dir, id + ".html"), m.html, "utf8");
  if (m.eml) writeFileSync(join(dir, id + ".eml"), m.eml);

  const applicationId = c.category === "其他" ? null : linkApplication(db, c.company, c.position);
  let proposalId: string | null = null, note = "";
  if (applicationId) {
    const r = decide(db, c, applicationId, m.subject);
    if ("note" in r) note = r.note;
    else proposalId = d.domain.createProposal(r.kind, r.payload, "system:inbox", `来自「${m.subject.slice(0, 60)}」：${c.summary}`.slice(0, 300), 24 * 14).id;
  }
  db.prepare(`insert or ignore into message(id, account, message_id, content_key, sender, subject, received_at, body_path, category, round, company, position, scheduled_at, link, summary, confidence, application_id, proposal_id, status, note, folder, created_at)
    values (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, account, m.messageId, key, m.from, m.subject, m.date, bodyPath, c.category, c.round, c.company, c.position, c.scheduledAt, c.link, c.summary, c.confidence, applicationId, proposalId, proposalId ? "proposed" : "new", note, m.folder ?? "", now());
  db.prepare("delete from mail_skipped where message_id = ?").run(m.messageId);
  d.onChanged?.();
  return { message: msgRow(db.prepare("select * from message where id = ?").get(id)), added: true };
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
  db.prepare("update message set application_id = ?, proposal_id = ?, status = ?, note = ? where id = ?").run(applicationId, proposalId, proposalId ? "proposed" : r.status, note, id);
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
      for (const a of loadAccounts(d.vault)) {
        out.accounts++;
        try {
          const last = (db.prepare("select max(t) as t from (select max(received_at) as t from message where account = ? union all select max(received_at) from mail_skipped where account = ?)").get(a.id, a.id) as any)?.t as string | null;
          const waiting = oldestWaitingMail(db);
          const since = new Date(Math.min(last ? Date.parse(last) - 86400_000 : Date.now() - 14 * 86400_000, waiting ? Date.parse(waiting) - 3600_000 : Infinity));
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
