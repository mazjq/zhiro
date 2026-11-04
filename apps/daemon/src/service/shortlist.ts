/**
 * 每周短名单: once a week, at most ten cards the person decides on in a quarter of an hour, instead of a stream of posts.
 *
 * Why not the match tiers: of the 20 applications the first person actually sent, 12 posts were never assessed (the
 * rules skip a post whose duties they cannot read — most research institutes write thin JDs), one was 低相关 and none
 * 优先考虑. What they chose was company (the kind they applied to before), title (their direction) and city. So the
 * candidates are posts whose title names something the person has evidence for, in a city on their list, plus every
 * new post of a 重点 company; the tiers only order and word the cards.
 *
 * Three slots: 新机会 (≤6), 要决定 (≤3: drafts left two weeks, and what was put aside last week), 可补 (≤2: posts whose
 * one open core requirement is a skill the person can still pick up, with a date). What a rule kept out is listed, not
 * dropped — the person can put one back, which also undoes the rule. Rules come only from the person's own choices
 * on a card (不投 → 这家公司 / 这类岗位 / 这个城市 / 这个集团只投一个); nothing an agent wrote is a rule.
 * ponytail: no model call here — the two lines on a card quote what the assessment already found; a deep match on the
 * chosen cards is the upgrade.
 */
import { ulid } from "ulid";
import { json, now, tx, type Db } from "../db.js";
import type { Services } from "../services.js";
import { DomainError, NotFound } from "./domain.js";
import { listFacts, upsertFact, removeFact } from "./profile.js";
import { beijingDay } from "./deadlines.js";
import { groupOf } from "./same-company.js";
import { low, terms, levelOf, minLevel } from "../recommenders/common.js";
import { assess, userSide, parseJd, label, type Assessment, type Judgement } from "../recommenders/fit.js";
import { conceptsIn, concept } from "../recommenders/concepts.js";
import { tagCompany } from "../recommenders/index.js";
import { isAggregate } from "../data/index.js";
import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import { asBackground } from "../budget/index.js";
import { withPurpose } from "./usage.js";

export type Slot = "new" | "decide" | "fill";
export type Decision = "pending" | "apply" | "skip" | "hold" | "fill";
export type RuleKind = "company" | "type" | "city" | "group";
export interface Rule { kind: RuleKind; value: string }
export interface Card {
  key: string; slot: Slot; positionId: string; applicationId?: string; companyId: string; company: string; title: string; cities: string[]; closesAt: string | null;
  cityRank: number; tier?: string; why: string; gap: string; notes: string[]; group?: string; groupApplied: string[];
  gapConcept?: string; unlocks?: number; expiresAt?: string; decision: Decision; reason?: string; detail?: string;
  /** 补一下: the plan written once by the model, or why there is none */
  plan?: string; planNote?: string;
}
export interface Skipped { reason: string; rule?: Rule; positionId: string; company: string; title: string }
export interface Shortlist { id: string; week: string; at: string; cards: Card[]; skipped: Skipped[]; skippedTotal: number; skippedBy: Record<string, number> }

export const MAX_NEW = 6, MAX_DECIDE = 3, MAX_FILL = 2, PER_COMPANY = 2;
const DAY = 86400_000;
const SKIPPED_KEPT = 40;
const INSTITUTE = /研究所|研究院|设计部|总体部|研究中心|设计院/;
/** a 期望 card field that only the shortlist reads: cities the person said they will not go to, groups that take one application */
export const NO_CITY_FIELD = "不去的城市", ONE_PER_GROUP_FIELD = "集团只投一个";

/** The Monday of the week `now` is in, as the local day. */
export function weekOf(now = Date.now()): string {
  const d = new Date(now); d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Which tier of the person's city list a post is in: 0 first … n-1; n = place unknown (sorted after all); -1 = not on the list. */
export function cityRank(cities: string[], tiers: string[][]): number {
  if (!tiers.length) return 0;
  const known = cities.filter((c) => !/全国|不限|多地|远程|各地/.test(c));
  if (!known.length) return tiers.length;
  const ranks = known.map((c) => tiers.findIndex((t) => t.some((x) => c.includes(x) || x.includes(c)))).filter((r) => r >= 0);
  return ranks.length ? Math.min(...ranks) : -1;
}

interface Row {
  id: string; title: string; jd_text: string; cities: string; degree_req: string; major_req: string; closes_at: string | null; created_at: string; watch_priority: number | null;
  c_closes: string | null; c_degree: string; c_major: string; c_cities: string; source_kind: string;
  company_id: string; company: string; company_type: string; app_state: string | null; assessment: string | null; key_company: number;
}
const ROWS = `select p.id, p.title, p.jd_text, p.cities, p.degree_req, p.major_req, p.closes_at, p.created_at, p.watch_priority,
    c.closes_at c_closes, c.degree_req c_degree, c.major_req c_major, c.cities c_cities, c.source_kind,
    co.id company_id, co.name company, co.type company_type,
    (select a.state from application a where a.position_id = p.id) app_state,
    (select a.json from position_assessment a where a.position_id = p.id) assessment,
    exists (select 1 from recommendation r where r.company_id = co.id and r.mode = 'manual' and r.tag = '重点') key_company
  from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id`;

interface Me { level: number; concepts: Set<string>; direction: string[]; stems: string[]; user: ReturnType<typeof userSide> }
/**
 * Words a title can carry without naming a concept: the two-character words that recur in the names of the person's own
 * task concepts' names (运动控制 / 伺服控制 / 飞行控制 → 控制; 控制算法 / 滤波算法 → 算法). 「控制岗」「自动化控制工程师」「控制系统
 * 总体设计师」 name no concept, yet were what the first person applied to.
 */
export function titleStems(conceptIds: Iterable<string>): string[] {
  const n = new Map<string, number>();
  for (const id of conceptIds) {
    const c = concept(id);
    if (c?.kind !== "task") continue;
    // the head of a compound is its last two characters (运动控制 → 控制, 轨迹跟踪 → 跟踪); counted once per concept
    const heads = new Set(c.names.filter((name) => /^[一-鿿]+$/.test(name) && name.length !== 3).map((name) => name.slice(-2)));
    for (const g of heads) n.set(g, (n.get(g) ?? 0) + 1);
  }
  return [...n].filter(([, k]) => k >= 2).map(([g]) => g);
}
function loadMe(db: Db): Me {
  const facts = listFacts(db).items;
  const level = Math.max(0, ...facts.filter((f) => f.kind === "education").map((f) => levelOf(f.data.degree ?? "")));
  const gaps = (db.prepare("select concept_id from user_gap where status = 'confirmed'").all() as { concept_id: string }[]).map((r) => r.concept_id);
  const user = userSide(facts as any[], level, gaps);
  const concepts = new Set(user.evidence.map((e) => e.conceptId));
  return { level, user, concepts, stems: titleStems(concepts), direction: terms(facts.filter((f) => f.kind === "direction").map((f) => f.data.keyword ?? "")) };
}

interface Rules { tiers: string[][]; noCities: string[]; onePerGroup: string[]; excludes: string[]; blocked: Set<string> }
function loadRules(s: Services): Rules {
  const db = s.domain.db;
  const facts = listFacts(db).items;
  const pref = (field: string) => terms(facts.filter((f) => f.kind === "preference" && f.data.field === field).map((f) => f.data.value ?? ""));
  return {
    tiers: (s.config.shortlist?.cities ?? []).map((t) => t.map(low)),
    noCities: pref(NO_CITY_FIELD), onePerGroup: pref(ONE_PER_GROUP_FIELD),
    excludes: terms(facts.filter((f) => f.kind === "exclude").map((f) => f.data.keyword ?? "")),
    blocked: new Set((db.prepare("select company_id from recommendation where mode = 'manual' and tag = '不投'").all() as { company_id: string }[]).map((r) => r.company_id)),
  };
}

/** The assessment a post has, or one made now by the same rules (written back: the ledger and the lists read it too). */
function assessed(db: Db, r: Row, me: Me): Assessment | null {
  if (r.assessment) return json.parse(r.assessment, null as Assessment | null);
  const parsed = parseJd(r.jd_text ?? "", r.title);
  const majorText = r.major_req || (/专业(?:要求)?[:：]\s*([^\n；;。]+)/.exec(low(r.jd_text ?? ""))?.[1] ?? "") || (isAggregate(r.source_kind) ? r.c_major : "");
  const a = assess(parsed, me.user.evidence, me.user, { degreeText: r.degree_req || r.c_degree || "", sourceKind: r.source_kind, agg: isAggregate(r.source_kind), majorText: low(majorText) });
  db.prepare("insert or ignore into position_assessment(position_id, json, profile_hash, rules_version, created_at) values (?,?,?,?,?)").run(r.id, JSON.stringify(a), "", "shortlist", now());
  return a;
}

const quote = (j: Judgement) => `「${j.quote.slice(0, 60)}」`;
/** The two lines on a card, from what the assessment found; never a judgement the rules did not make. */
export function wording(a: Assessment | null, title: string, hasJd: boolean, me: Me): { why: string; gap: string } {
  const js = a?.judgements ?? [];
  const sup = js.find((j) => j.status === "supported" && j.importance === "core") ?? js.find((j) => j.status === "supported") ?? js.find((j) => j.status === "transferable");
  const named = [...conceptsIn(title)].filter((c) => me.concepts.has(c));
  const why = sup ? `${quote(sup)}：你有${sup.concepts.map(label).join("/")}的${sup.status === "transferable" ? "相近" : ""}证据`
    : a?.taskWhy ? `职责里有${a.taskWhy.replace(/^职责\s*/, "")}` : named.length ? `岗位名里有${named.map(label).join("/")}` : "岗位名对口";
  const open = js.find((j) => j.status === "gap" && j.importance === "core") ?? js.find((j) => j.status === "unknown" && j.importance === "core") ?? js.find((j) => j.status === "gap") ?? js.find((j) => j.status === "unknown" && j.modality === "required");
  const gap = open ? `${quote(open)}：${open.status === "gap" ? "你说过没做过" : "资料里还没有证据"}` : !hasJd ? "没有岗位描述，点开看原文" : js.length ? "要求都对得上" : "要求没读出来，点开看原文";
  return { why, gap };
}

/** The one open core skill a post asks that the person could still pick up (unknown, never a confirmed gap). */
const fillable = (a: Assessment | null) => a && a.A >= 30 ? a.judgements.find((j) => j.status === "unknown" && j.importance === "core")?.concepts[0] ?? null : null;

const TIER_RANK: Record<string, number> = { 优先考虑: 0, 可迁移: 1, 待补资料: 2, 明显缺口: 3, 低相关: 4 };
const daysLeft = (closesAt: string | null, today: string) => closesAt ? Math.round((Date.parse(closesAt.slice(0, 10)) - Date.parse(today)) / DAY) : null;
const plusDays = (day: string, n: number) => new Date(Date.parse(day) + n * DAY).toISOString().slice(0, 10);

function toCard(r: Row, a: Assessment | null, me: Me, rules: Rules, applied: Map<string, string[]>, today: string, slot: Slot = "new"): Card {
  const cities = json.parse(r.cities, [] as string[]);
  const where = cities.length ? cities : json.parse(r.c_cities, [] as string[]);
  const closesAt = r.closes_at ?? r.c_closes ?? null;
  const group = groupOf(r.company) ?? undefined;
  const groupApplied = (group ? applied.get(group) ?? [] : []).filter((n) => n !== r.company);
  const { why, gap } = wording(a, r.title, !!(r.jd_text ?? "").trim(), me);
  const notes: string[] = [];
  if (r.key_company) notes.push("重点公司");
  if (groupApplied.length) notes.push(`同集团已投 ${groupApplied.slice(0, 2).join("、")}${groupApplied.length > 2 ? " 等" : ""}`);
  if (r.watch_priority) notes.push("关注中");
  const left = daysLeft(closesAt, today);
  if (left != null) notes.push(left < 0 ? "已过截止" : left === 0 ? "今天截止" : `还剩 ${left} 天`);
  return { key: r.id, slot, positionId: r.id, companyId: r.company_id, company: r.company, title: r.title, cities: where, closesAt, cityRank: cityRank(where.map(low), rules.tiers), tier: a?.tier, why, gap, notes, group, groupApplied, decision: "pending" };
}

/** Pure selection over rows the queries fetched; exported for the test. `applied` = group → companies applied to. */
export function pick(rows: Row[], me: Me, rules: Rules, applied: Map<string, string[]>, assessOf: (r: Row) => Assessment | null, today: string, skippedBefore: Set<string>): { cards: Card[]; skipped: Skipped[] } {
  const skipped: Skipped[] = [];
  const skip = (r: Row, reason: string, rule?: Rule) => skipped.push({ reason, rule, positionId: r.id, company: r.company, title: r.title });
  const appliedInstitutes = [...applied.values()].flat().some((n) => INSTITUTE.test(n));
  const scored: { r: Row; a: Assessment | null; sort: number[] }[] = [];
  for (const r of rows) {
    if (r.app_state || skippedBefore.has(r.id)) continue; // held, sent, or 不投 already: decided
    const closesAt = r.closes_at ?? r.c_closes;
    if (closesAt && closesAt.slice(0, 10) < today) continue;
    if (me.level && minLevel(r.degree_req || r.c_degree || "") > me.level) continue;
    const title = low(r.title);
    const group = groupOf(r.company);
    // 像你投过的: a company of a group the person applied to is in whatever it posts; an institute elsewhere only sorts higher
    const sameGroup = !!(group && applied.has(group));
    const like = sameGroup || (appliedInstitutes && INSTITUTE.test(r.company));
    const hit = r.key_company || sameGroup || [...conceptsIn(r.title)].some((c) => me.concepts.has(c)) || me.stems.some((k) => title.includes(k)) || me.direction.some((k) => title.includes(k));
    if (!hit) continue;
    // the person's own rules, listed so one can be put back
    if (rules.blocked.has(r.company_id)) { skip(r, "标了「不投」的公司", { kind: "company", value: r.company_id }); continue; }
    const ex = rules.excludes.find((x) => title.includes(x));
    if (ex) { skip(r, `岗位名含「${ex}」`, { kind: "type", value: ex }); continue; }
    const cities = json.parse(r.cities, [] as string[]);
    const where = (cities.length ? cities : json.parse(r.c_cities, [] as string[])).map(low);
    const no = rules.noCities.find((c) => where.some((w) => w.includes(c)));
    if (no) { skip(r, `工作地「${no}」你说过不去`, { kind: "city", value: no }); continue; }
    const rank = cityRank(where, rules.tiers);
    if (rank < 0 && !r.key_company) { skip(r, "工作地不在你的城市名单里"); continue; }
    if (group && rules.onePerGroup.includes(low(group)) && applied.has(group)) { skip(r, `${group}只投一个，已投 ${applied.get(group)!.slice(0, 2).join("、")}`, { kind: "group", value: group }); continue; }
    const a = assessOf(r);
    // a core requirement the person said they do not have is not a 新机会 (the 可补 slot takes only what is unknown); a 重点 company's post stays
    if (a?.tier === "明显缺口" && !r.key_company) {
      const said = a.judgements.filter((j) => j.status === "gap" && j.importance === "core").map((j) => j.concepts.map(label).join("/"));
      skip(r, `核心要求是你说过没做过的（${[...new Set(said)].slice(0, 2).join("、")}）`); continue;
    }
    scored.push({ r, a, sort: [r.key_company ? 0 : 1, rank < 0 ? 99 : rank, like ? 0 : 1, TIER_RANK[a?.tier ?? ""] ?? 5, -(a?.S ?? 0), -Date.parse(r.created_at)] });
  }
  scored.sort((x, y) => { for (let i = 0; i < x.sort.length; i++) if (x.sort[i] !== y.sort[i]) return x.sort[i] - y.sort[i]; return 0; });
  const cards: Card[] = [];
  const perCompany = new Map<string, number>();
  const rest: typeof scored = [];
  for (const x of scored) {
    const n = perCompany.get(x.r.company_id) ?? 0;
    if (cards.length < MAX_NEW && n < PER_COMPANY) { cards.push(toCard(x.r, x.a, me, rules, applied, today)); perCompany.set(x.r.company_id, n + 1); }
    else rest.push(x);
  }
  // 可补: one card per open skill, the skill that would unlock the most posts first
  const byConcept = new Map<string, typeof rest>();
  for (const x of rest) { const c = fillable(x.a); if (c) (byConcept.get(c) ?? byConcept.set(c, []).get(c)!).push(x); }
  const fills = [...byConcept].sort((a, b) => b[1].length - a[1].length).slice(0, MAX_FILL);
  for (const [concept, xs] of fills) {
    const x = xs[0];
    const card = toCard(x.r, x.a, me, rules, applied, today, "fill");
    card.gapConcept = label(concept); card.unlocks = xs.length;
    card.expiresAt = card.closesAt ? plusDays(card.closesAt.slice(0, 10), -14) : plusDays(today, 21);
    if (card.expiresAt < today) card.expiresAt = today;
    card.notes.push(`补上「${label(concept)}」还能投 ${xs.length - 1} 个同类岗位`);
    cards.push(card);
    rest.splice(rest.indexOf(x), 1);
  }
  for (const x of rest) skip(x.r, "超出本周张数");
  return { cards, skipped };
}

/** Companies applied to this season, by group, for 「同集团已投」 and 「像你投过的」. */
function appliedByGroup(db: Db): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const r of db.prepare("select distinct co.name from application a join position p on p.id = a.position_id join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id where a.state in ('submitted', 'in_process', 'closed')").all() as { name: string }[]) {
    const g = groupOf(r.name) ?? `=${r.name}`;
    (m.get(g) ?? m.set(g, []).get(g)!).push(r.name);
  }
  return m;
}

/** 要决定: drafts left two weeks (oldest first) and what last week's list put aside; only 投 / 不投 on these. */
function decideCards(db: Db, me: Me, rules: Rules, applied: Map<string, string[]>, today: string, now: number): Card[] {
  const out: Card[] = [];
  const prev = db.prepare(`select i.key, i.decision, i.reason, i.card_json from shortlist_item i join shortlist_run r on r.id = i.run_id
      where i.decision in ('hold', 'fill') and i.key not like 'app:%' order by r.at desc`).all() as { key: string; decision: string; reason: string; card_json: string }[];
  const seen = new Set<string>();
  for (const p of prev) {
    if (seen.has(p.key)) continue; seen.add(p.key);
    const r = db.prepare(`${ROWS} where p.id = ? and p.status = 'open'`).get(p.key) as unknown as Row | undefined;
    if (!r || r.app_state) continue;
    const was = json.parse(p.card_json, {} as Partial<Card>);
    if (p.decision === "fill" && was.expiresAt && was.expiresAt < today) continue; // ran out: listed as skipped by the maker
    const card = toCard(r, assessed(db, r, me), me, rules, applied, today, "decide");
    card.notes.unshift(p.decision === "hold" ? "上周先放着的：这次定一下" : `上周说补一下（${was.gapConcept ?? ""}）：补了没？到 ${was.expiresAt} 为止`);
    if (p.decision === "fill") { card.gapConcept = was.gapConcept; card.expiresAt = was.expiresAt; card.plan = was.plan; card.planNote = was.planNote; }
    out.push(card);
  }
  for (const a of db.prepare(`select a.id app_id, a.updated_at, p.id, p.title, p.cities, p.jd_text, c.closes_at, co.id company_id, co.name company from application a join position p on p.id = a.position_id
      join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id where a.state = 'draft' and a.updated_at < ? order by a.updated_at`).all(new Date(now - 14 * DAY).toISOString()) as any[]) {
    if (out.length >= MAX_DECIDE) break;
    const left = daysLeft(a.closes_at, today);
    const days = Math.floor((now - Date.parse(a.updated_at)) / DAY);
    out.push({ key: `app:${a.app_id}`, slot: "decide", positionId: a.id, applicationId: a.app_id, companyId: a.company_id, company: a.company, title: a.title, cities: json.parse(a.cities, []), closesAt: a.closes_at ?? null, cityRank: 0,
      why: `草稿放了 ${days} 天`, gap: left != null && left < 0 ? "已过截止：核实有没有延期，否则不投" : "投还是不投？", notes: left != null && left >= 0 ? [`还剩 ${left} 天`] : [], groupApplied: [], decision: "pending" });
  }
  return out.slice(0, MAX_DECIDE);
}

/** Make this week's list and keep it. */
export function runShortlist(s: Services, nowMs = Date.now()): Shortlist {
  const db = s.domain.db;
  const today = beijingDay(new Date(nowMs));
  const me = loadMe(db), rules = loadRules(s), applied = appliedByGroup(db);
  const last = db.prepare("select at from shortlist_run order by at desc limit 1").get() as { at: string } | undefined;
  const since = new Date(Math.max(last ? Date.parse(last.at) : 0, nowMs - 14 * DAY)).toISOString();
  const rows = db.prepare(`${ROWS} where p.status = 'open' and p.created_at >= ?`).all(since) as unknown as Row[];
  const skippedBefore = new Set((db.prepare("select key from shortlist_item where decision = 'skip'").all() as { key: string }[]).map((r) => r.key));
  const { cards, skipped } = pick(rows, me, rules, applied, (r) => assessed(db, r, me), today, skippedBefore);
  // a 可补 card that ran out: said once, as skipped
  for (const p of db.prepare(`select i.key, i.card_json from shortlist_item i where i.decision = 'fill' and i.run_id = (select id from shortlist_run order by at desc limit 1)`).all() as { key: string; card_json: string }[]) {
    const was = json.parse(p.card_json, {} as Partial<Card>);
    if (was.expiresAt && was.expiresAt < today && was.company && was.title) skipped.unshift({ reason: `可补到期没补（${was.gapConcept ?? ""}）`, positionId: p.key, company: was.company, title: was.title });
  }
  const all = [...cards.filter((c) => c.slot === "new"), ...decideCards(db, me, rules, applied, today, nowMs), ...cards.filter((c) => c.slot === "fill")];
  // what a rule or the cap kept out is what the person may want back: those stay in the kept part; the rest is counted
  const kind = (x: Skipped) => x.rule ? `规则：${x.rule.kind === "company" ? "不投的公司" : x.rule.kind === "type" ? "排除词" : x.rule.kind === "city" ? "不去的城市" : "集团只投一个"}` : x.reason.startsWith("超出") ? "超出张数" : x.reason.startsWith("可补") ? "可补到期" : x.reason.startsWith("核心") ? "你说过没做过" : "城市不在名单";
  const skippedBy: Record<string, number> = {};
  for (const x of skipped) skippedBy[kind(x)] = (skippedBy[kind(x)] ?? 0) + 1;
  skipped.sort((a, b) => Number(!(a.rule || !a.reason.startsWith("工作地不在"))) - Number(!(b.rule || !b.reason.startsWith("工作地不在"))));
  const list: Shortlist = { id: ulid(), week: weekOf(nowMs), at: new Date(nowMs).toISOString(), cards: all, skipped: skipped.slice(0, SKIPPED_KEPT), skippedTotal: skipped.length, skippedBy };
  save(db, list, true);
  return list;
}

function save(db: Db, list: Shortlist, fresh = false): void {
  tx(db, () => {
    db.prepare("insert into shortlist_run(id, week, at, json) values (?,?,?,?) on conflict(id) do update set json = excluded.json").run(list.id, list.week, list.at, JSON.stringify(list));
    const ins = db.prepare("insert into shortlist_item(run_id, key, position_id, slot, decision, reason, card_json, decided_at) values (?,?,?,?,?,?,?,?) on conflict(run_id, key) do update set decision = excluded.decision, reason = excluded.reason, card_json = excluded.card_json, decided_at = excluded.decided_at");
    for (const c of list.cards) if (fresh || c.decision !== "pending") ins.run(list.id, c.key, c.positionId, c.slot, c.decision, c.reason ?? "", JSON.stringify(c), c.decision === "pending" ? null : now());
  });
}

export function latestShortlist(db: Db): Shortlist | null {
  const r = db.prepare("select json from shortlist_run order by at desc limit 1").get() as { json: string } | undefined;
  return r ? json.parse(r.json, null as Shortlist | null) : null;
}

function load(db: Db, runId: string): Shortlist {
  const r = db.prepare("select json from shortlist_run where id = ?").get(runId) as { json: string } | undefined;
  if (!r) throw new NotFound(`shortlist ${runId}`);
  return JSON.parse(r.json);
}

/** Add a value to a 期望 card the shortlist reads (one card per field; values joined by 、). */
function addPref(db: Db, field: string, value: string): void {
  const f = listFacts(db, { kind: "preference" }).items.find((x) => x.data.field === field);
  const values = [...new Set([...terms([f?.data.value ?? ""]), low(value)])];
  upsertFact(db, { id: f?.id, kind: "preference", data: { field, value: values.join("、") } }, "本人确认");
}
function dropPref(db: Db, field: string, value: string): void {
  const f = listFacts(db, { kind: "preference" }).items.find((x) => x.data.field === field);
  if (!f) return;
  const values = terms([f.data.value ?? ""]).filter((v) => v !== low(value));
  if (values.length) upsertFact(db, { id: f.id, kind: "preference", data: { field, value: values.join("、") } }, "本人确认"); else removeFact(db, f.id);
}

const REASON_TEXT: Record<string, string> = { single: "不投（短名单）", company: "这家公司不投", type: "这类岗位不投", city: "不去这个城市", group: "这个集团只投一个" };

/**
 * The person's decision on a card. 投 makes the draft; 不投 records the reason and, for company / type / city / group,
 * the rule behind next week's list; 先放着 and 补一下 bring the card back next week under 要决定.
 */
export function decideCard(s: Services, p: { runId: string; key: string; decision: Exclude<Decision, "pending">; reason?: string; detail?: string }): Shortlist {
  const db = s.domain.db;
  const list = load(db, p.runId);
  const card = list.cards.find((c) => c.key === p.key);
  if (!card) throw new NotFound(`card ${p.key}`);
  const today = beijingDay(new Date());
  if (p.decision === "apply") {
    if (!card.applicationId && !db.prepare("select 1 from application where position_id = ?").get(card.positionId)) {
      const a = s.domain.createApplication(card.positionId, "", "每周短名单：本人选了「投」", "human:shortlist");
      card.applicationId = a.id;
    }
  } else if (p.decision === "skip") {
    const reason = p.reason ?? "single";
    if (!REASON_TEXT[reason]) throw new DomainError("BAD_INPUT", "原因只能是 single / company / type / city / group");
    if (["type", "city"].includes(reason) && !p.detail?.trim()) throw new DomainError("MISSING_FIELD", reason === "type" ? "写一下是哪类岗位（岗位名里的词）" : "写一下是哪个城市");
    if (reason === "company") tagCompany(s, { companyId: card.companyId, tag: "不投", reason: "每周短名单：本人选了「这家公司不投」" });
    if (reason === "type") upsertFact(db, { kind: "exclude", data: { keyword: p.detail!.trim() } }, "本人确认");
    if (reason === "city") addPref(db, NO_CITY_FIELD, p.detail!.trim());
    if (reason === "group") { if (!card.group) throw new DomainError("BAD_INPUT", "这家公司不属于已知的集团"); addPref(db, ONE_PER_GROUP_FIELD, card.group); }
    if (card.applicationId) s.domain.updateApplication({ id: card.applicationId, state: "cancelled", closeReason: REASON_TEXT[reason] }, "human:shortlist");
    card.reason = reason; card.detail = p.detail?.trim();
  } else if (p.decision === "hold") {
    card.expiresAt = plusDays(today, 7);
  } else if (p.decision === "fill") {
    card.expiresAt ??= card.closesAt ? plusDays(card.closesAt.slice(0, 10), -14) : plusDays(today, 21);
    if (card.expiresAt < today) card.expiresAt = today;
  }
  card.decision = p.decision;
  save(db, list);
  s.onDataChanged?.();
  return list;
}

/** 放回来: the post joins this week's cards, and the rule that kept it out (if one did) is taken back. */
export function restoreCard(s: Services, p: { runId: string; positionId: string }): Shortlist {
  const db = s.domain.db;
  const list = load(db, p.runId);
  const i = list.skipped.findIndex((x) => x.positionId === p.positionId);
  if (i < 0) throw new NotFound(`skipped ${p.positionId}`);
  const [sk] = list.skipped.splice(i, 1);
  list.skippedTotal = Math.max(0, list.skippedTotal - 1);
  const rule = sk.rule;
  if (rule?.kind === "company") db.prepare("delete from recommendation where company_id = ? and mode = 'manual' and tag = '不投'").run(rule.value);
  if (rule?.kind === "type") for (const f of listFacts(db, { kind: "exclude" }).items) if (low(f.data.keyword ?? "") === rule.value) removeFact(db, f.id);
  if (rule?.kind === "city") dropPref(db, NO_CITY_FIELD, rule.value);
  if (rule?.kind === "group") dropPref(db, ONE_PER_GROUP_FIELD, rule.value);
  const r = db.prepare(`${ROWS} where p.id = ?`).get(p.positionId) as unknown as Row | undefined;
  if (r && !list.cards.some((c) => c.key === r.id)) {
    const me = loadMe(db);
    const card = toCard(r, assessed(db, r, me), me, loadRules(s), appliedByGroup(db), beijingDay(new Date()));
    card.notes.unshift("你放回来的");
    list.cards.push(card);
  }
  // a 不投 recorded on this post by an earlier list no longer keeps it out
  db.prepare("delete from shortlist_item where key = ? and decision = 'skip'").run(p.positionId);
  save(db, list, true);
  s.onDataChanged?.();
  return list;
}

/** Change one card of a kept list in place (the list and its item row), then tell the screens. */
function patchCard(s: Services, runId: string, key: string, f: (c: Card) => void): void {
  const db = s.domain.db;
  const list = load(db, runId);
  const c = list.cards.find((x) => x.key === key);
  if (!c) return;
  f(c);
  tx(db, () => {
    db.prepare("update shortlist_run set json = ? where id = ?").run(JSON.stringify(list), runId);
    db.prepare("update shortlist_item set card_json = ? where run_id = ? and key = ?").run(JSON.stringify(c), runId, key);
  });
  s.onDataChanged?.();
}

const PLAN_SYSTEM = `你帮一位在读研究生补上一个岗位要求。给你：岗位名、岗位里他还没有证据的那条要求（原文），以及他资料里的项目和经历。
只依据给出的内容，不要编造他没有的经历。从他的项目里挑一个最接得上的，写一件具体的小事：几天内做得完，做完就能在简历或面试里说清自己有这项能力。
只输出 JSON：{"project": "所用项目的名称，照抄资料里的写法", "task": "要做的那件小事（60 字内，大白话）", "time": "大约多久，如 两个晚上、三天"}`;

/** Other open posts that ask the same skill and do not see it in the person's evidence yet. */
function sameSkillPosts(db: Db, positionId: string, conceptId: string): number {
  let n = 0;
  for (const r of db.prepare("select a.json from position_assessment a join position p on p.id = a.position_id where p.status = 'open' and p.id <> ?").all(positionId) as { json: string }[]) {
    const a = json.parse(r.json, null as Assessment | null);
    if (a?.judgements?.some((j) => j.status !== "supported" && j.status !== "transferable" && j.concepts.includes(conceptId))) n++;
  }
  return n;
}

/**
 * 补一下: once per card, one model call (held background work `shortlist_fill`, purpose shortlist.fill) for a short plan —
 * the missing requirement as the post words it, one small task on one of the person's own projects, about how long;
 * the days left and how many other posts the same skill opens are counted here, not asked. No model, a refusal, an
 * error or a plan on no project of theirs: the card says so, and no plan is made up by rules.
 */
export async function fillPlan(s: Services, runId: string, key: string, nowMs = Date.now()): Promise<void> {
  const db = s.domain.db;
  const card = load(db, runId).cards.find((c) => c.key === key);
  if (!card || card.plan || card.planNote) return; // once
  const note = (planNote: string) => patchCard(s, runId, key, (c) => { c.planNote = planNote; });
  const quote = /「([^」]+)」/.exec(card.gap)?.[1];
  if (!quote) return note("这张卡没读出具体差哪一条要求，没写补的计划");
  const own = listFacts(db).items.filter((f) => ["project", "experience", "publication"].includes(f.kind))
    .map((f) => ({ name: f.data.title || [f.data.org, f.data.role].filter(Boolean).join(" "), text: (f as any).statement || Object.values(f.data ?? {}).join(" / ") })).filter((x) => x.name);
  if (!own.length) return note("资料里还没有项目或经历，没法接着你自己的项目写计划；先在「资料」里补上");
  const to = s.llm?.route?.();
  if (!s.llm || to?.kind === "waiting" || to?.kind === "unavailable") return note("现在没有能用的模型，没写补的计划");
  let o: any;
  try {
    const text = `岗位：${card.company} · ${card.title}\n还差的要求（原文）：「${quote}」\n\n他的项目和经历：\n${own.map((x) => `- ${x.text}`).join("\n")}`;
    const msg = await asBackground("shortlist_fill", () => withPurpose("shortlist.fill", card.positionId, () =>
      s.llm!.models.completeSimple(s.llm!.model(), { systemPrompt: PLAN_SYSTEM, messages: [{ role: "user", content: [{ type: "text", text }], timestamp: Date.now() }] }, { reasoning: "low" })));
    o = parseJsonWithRepair<any>(contentText(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  } catch (e: any) {
    return note(e?.code === "BUDGET_DEFERRED" ? `额度要先留给你自己用（${String(e.message).slice(0, 60)}），这次没写补的计划` : "写补的计划时模型出错了，这次没写");
  }
  const flat = (t: unknown) => low(String(t ?? "")).replace(/\s+/g, "");
  const said = flat(o?.project);
  const project = said.length >= 2 ? own.find((x) => flat(x.name) && (said.includes(flat(x.name)) || flat(x.name).includes(said))) : undefined;
  const task = String(o?.task ?? "").trim().slice(0, 80), time = String(o?.time ?? "").trim().slice(0, 20);
  if (!project || !task) return note("模型给的计划没接上你资料里的项目，没有采用");
  const left = daysLeft(card.closesAt, beijingDay(new Date(nowMs)));
  const a = json.parse((db.prepare("select json from position_assessment where position_id = ?").get(card.positionId) as { json: string } | undefined)?.json ?? "", null as Assessment | null);
  const conceptId = a?.judgements.find((j) => j.status !== "supported" && (j.quote.includes(quote) || quote.includes(j.quote.slice(0, 60))))?.concepts[0];
  const others = card.unlocks ? card.unlocks - 1 : conceptId ? sameSkillPosts(db, card.positionId, conceptId) : null;
  const plan = [
    `差的：「${quote}」`,
    `怎么补：${task}（接着你的「${project.name}」做）`,
    ...(time ? [`大约要：${time}`] : []),
    left == null ? "这个岗位没写截止日期" : left < 0 ? "这个岗位已过截止" : left === 0 ? "这个岗位今天截止" : `这个岗位还剩 ${left} 天截止`,
    ...(others != null ? [others ? `补上这一项，还能投另外 ${others} 个要它的岗位` : "暂时没有别的岗位要这一项"] : []),
  ].join("\n");
  patchCard(s, runId, key, (c) => { c.plan = plan; });
}

/** Lines for the Monday brief notice. */
export function shortlistLines(list: Shortlist): string[] {
  if (!list.cards.length) return [];
  const name = (c: Card) => `· ${c.slot === "decide" ? "要决定 · " : c.slot === "fill" ? "可补 · " : ""}${c.company} · ${c.title}`;
  const by = Object.entries(list.skippedBy ?? {}).map(([k, n]) => `${k} ${n}`).join("、");
  return [`**本周短名单 · ${list.cards.length} 张**`, ...list.cards.slice(0, 10).map(name), ...(list.skippedTotal ? [`· 另有 ${list.skippedTotal} 个没上卡（${by}），在 Zhiro「今日」里看和放回`] : ["· 在 Zhiro「今日」里决定"])];
}
