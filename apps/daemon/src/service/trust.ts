import { ulid } from "ulid";
import { now, type Db } from "../db.js";
import { companyKey, guardedFetch, guardedFetchTo } from "../data/index.js";
import { siteKey as siteKeyOf } from "./notice.js";

/**
 * 官网信任根: which sites are known to be a company's own, and how that is known. Only these count as 「this company
 * published it」 in announcement checks — not every batch a source happened to label 官方 (most of those came from a
 * sheet: the sheet vouching for itself). Each site carries its evidence; revoking one undoes, in one transaction,
 * what was concluded from it: the sites it vouched for, the checks that leaned on it and the deadlines they wrote.
 */

export type RootKind = "builtin" | "exchange" | "linked";
export interface SiteRow { id: string; company_id: string; site_key: string; root_kind: RootKind; basis_url: string; basis_quote: string; basis_fingerprint: string; parent_id: string | null; status: string; verified_at: string; expires_at: string | null }

/**
 * Sites written into Zhiro's own readers, each read from one company's own hiring site, reviewed with the code: the
 * exact host, never its whole domain. A company here that is not in the library yet is skipped until it is.
 */
export const BUILTIN_SITES: { company: string; site: string; why: string; fullName: string }[] = [
  { company: "国家能源集团", site: "zhaopin.chnenergy.com.cn", why: "Zhiro 内置读取器 chnenergy：国家能源集团招聘平台", fullName: "国家能源投资集团有限责任公司" },
  { company: "中国华能", site: "zhaopin.chng.com.cn", why: "Zhiro 内置读取器 chng：中国华能招聘平台", fullName: "中国华能集团有限公司" },
  { company: "快手", site: "campus.kuaishou.cn", why: "Zhiro 内置读取器 kuaishou：快手校园招聘", fullName: "北京快手科技有限公司" },
  { company: "小红书", site: "job.xiaohongshu.com", why: "Zhiro 内置读取器 xiaohongshu：小红书招聘", fullName: "行吟信息科技（上海）有限公司" },
];

/** Put the built-in sites on record for the companies the library has. A site once revoked is never brought back here. */
export function syncBuiltinSites(db: Db): void {
  const company = db.prepare("select id from company where name = ?");
  const known = db.prepare("select 1 from company_site where company_id = ? and site_key = ? and root_kind = 'builtin'");
  for (const b of BUILTIN_SITES) {
    const co = company.get(b.company) as { id: string } | undefined;
    if (!co || known.get(co.id, b.site)) continue;
    const site = ulid();
    db.prepare("insert into company_site(id, company_id, site_key, root_kind, basis_quote, basis_fingerprint, verified_at) values (?,?,?,?,?,?,?)").run(site, co.id, b.site, "builtin", b.why, `builtin:${b.site}`, now());
    addName(db, { companyId: co.id, value: b.fullName, rootKind: "builtin", basisUrl: "", basisQuote: `${b.why}；全称 ${b.fullName}`, fingerprint: `builtin:${b.site}:${b.fullName}`, siteId: site });
  }
}

/** Put a company's full name on record, tied to the site record it came with. Refused when the same evidence was revoked. */
export function addName(db: Db, p: { companyId: string; value: string; rootKind: "builtin" | "exchange"; basisUrl: string; basisQuote: string; fingerprint: string; siteId: string; days?: number }): { id: string } | { refused: string } {
  const value = p.value.trim();
  if (!value) return { refused: "没有名字" };
  if (db.prepare("select 1 from company_identity where company_id = ? and kind = 'name' and basis_fingerprint = ? and status = 'revoked'").get(p.companyId, p.fingerprint)) return { refused: "这条证据之前被撤回过" };
  const expires = p.days ? new Date(Date.now() + p.days * 86400_000).toISOString() : null;
  const same = db.prepare("select id from company_identity where company_id = ? and kind = 'name' and basis_fingerprint = ? and status = 'active'").get(p.companyId, p.fingerprint) as { id: string } | undefined;
  if (same) { db.prepare("update company_identity set verified_at = ?, expires_at = ?, site_id = ? where id = ?").run(now(), expires, p.siteId, same.id); return { id: same.id }; }
  const id = ulid();
  db.prepare("insert into company_identity(id, company_id, kind, value, root_kind, basis_url, basis_quote, basis_fingerprint, site_id, verified_at, expires_at) values (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, p.companyId, "name", value, p.rootKind, p.basisUrl, p.basisQuote.slice(0, 600), p.fingerprint, p.siteId, now(), expires);
  return { id };
}

/** The company's full names that stand now: name → the ids of the records that vouch for it. */
export function trustedNames(db: Db, companyId: string): Map<string, string[]> {
  syncBuiltinSites(db);
  const out = new Map<string, string[]>();
  for (const r of db.prepare("select id, value from company_identity where company_id = ? and kind = 'name' and status = 'active' and (expires_at is null or expires_at > ?)").all(companyId, now()) as { id: string; value: string }[])
    out.set(r.value, [...(out.get(r.value) ?? []), r.id]);
  return out;
}

/** The company's sites that stand now: site key → the ids of the records that vouch for it (one is enough). */
export function trustedSites(db: Db, companyId: string): Map<string, string[]> {
  syncBuiltinSites(db);
  const out = new Map<string, string[]>();
  for (const r of db.prepare("select id, site_key from company_site where company_id = ? and status = 'active' and (expires_at is null or expires_at > ?)").all(companyId, now()) as { id: string; site_key: string }[])
    out.set(r.site_key, [...(out.get(r.site_key) ?? []), r.id]);
  return out;
}

/**
 * Put a site on record. Refused when the same evidence was revoked before (a revoked conclusion does not come back by
 * being found again); new evidence for the same site is welcome.
 */
export function addSite(db: Db, p: { companyId: string; siteKey: string; rootKind: RootKind; basisUrl: string; basisQuote: string; fingerprint: string; parentId?: string; runId?: string; days?: number }): { id: string } | { refused: string } {
  if (db.prepare("select 1 from company_site where company_id = ? and site_key = ? and root_kind = ? and basis_fingerprint = ? and status = 'revoked'").get(p.companyId, p.siteKey, p.rootKind, p.fingerprint)) return { refused: "这条证据之前被撤回过" };
  const same = db.prepare("select id from company_site where company_id = ? and site_key = ? and root_kind = ? and basis_fingerprint = ? and status = 'active'").get(p.companyId, p.siteKey, p.rootKind, p.fingerprint) as { id: string } | undefined;
  const expires = p.days ? new Date(Date.now() + p.days * 86400_000).toISOString() : null;
  if (same) { db.prepare("update company_site set verified_at = ?, expires_at = ? where id = ?").run(now(), expires, same.id); return { id: same.id }; }
  const id = ulid();
  db.prepare("insert into company_site(id, company_id, site_key, root_kind, basis_url, basis_quote, basis_fingerprint, parent_id, run_id, verified_at, expires_at) values (?,?,?,?,?,?,?,?,?,?,?)")
    .run(id, p.companyId, p.siteKey, p.rootKind, p.basisUrl, p.basisQuote.slice(0, 600), p.fingerprint, p.parentId ?? null, p.runId ?? "", now(), expires);
  return { id };
}

export type Dep = { kind: "site" | "account" | "name"; id: string };
/** Whether everything a check leaned on still stands (checked inside the transaction that writes its deadline). */
export function depsStand(db: Db, deps: Dep[]): boolean {
  const site = db.prepare("select 1 from company_site where id = ? and status = 'active' and (expires_at is null or expires_at > ?)");
  const name = db.prepare("select 1 from company_identity where id = ? and status = 'active' and (expires_at is null or expires_at > ?)");
  return deps.every((d) => (d.kind === "site" ? !!site.get(d.id, now()) : d.kind === "name" ? !!name.get(d.id, now()) : true));
}

/**
 * Revoke a site's record and everything concluded from it, in one transaction: the sites it vouched for, the checks
 * that leaned on any of them (they no longer count), and the deadlines those checks wrote (superseded). Returns the
 * batches to check again. Other records for the same site, on their own evidence, stand.
 */
export function revokeSite(db: Db, id: string, by: string, reason: string): { revoked: string[]; checks: number; facts: number; campaigns: string[] } {
  const at = now();
  db.exec("begin");
  try {
    const revoked: string[] = [], names: string[] = [];
    // a name record revoked on its own: only it, and what leaned on it
    if (db.prepare("select 1 from company_identity where id = ?").get(id)) {
      if (db.prepare("update company_identity set status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ? where id = ? and status != 'revoked'").run(at, by, reason, id).changes) names.push(id);
    }
    const queue = names.length ? [] : [id];
    while (queue.length) {
      const x = queue.shift()!;
      const r = db.prepare("update company_site set status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ? where id = ? and status != 'revoked'").run(at, by, revoked.length ? `依据 ${id} 已撤回` : reason, x);
      if (!r.changes) continue;
      revoked.push(x);
      for (const c of db.prepare("select id from company_site where parent_id = ? and status != 'revoked'").all(x) as { id: string }[]) queue.push(c.id);
      // the names that came with this site go with it
      for (const n of db.prepare("select id from company_identity where site_id = ? and status != 'revoked'").all(x) as { id: string }[]) {
        db.prepare("update company_identity set status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ? where id = ?").run(at, by, `依据 ${id} 已撤回`, n.id);
        names.push(n.id);
      }
    }
    const refs = [...revoked.map((r) => ["site", r]), ...names.map((n) => ["name", n])];
    const checks = refs.length ? (db.prepare(`select distinct d.check_id, k.subject_type, k.subject_id from notice_check_dep d join notice_check k on k.id = d.check_id where (${refs.map(() => "(d.kind = ? and d.ref_id = ?)").join(" or ")}) and k.invalidated_at is null`).all(...refs.flat()) as { check_id: string; subject_type: string; subject_id: string }[]) : [];
    let facts = 0;
    for (const k of checks) {
      db.prepare("update notice_check set invalidated_at = ? where id = ?").run(at, k.check_id);
      facts += Number(db.prepare("update deadline_fact set superseded_at = ? where check_id = ? and superseded_at is null").run(at, k.check_id).changes);
    }
    db.exec("commit");
    const campaigns = [...new Set(checks.filter((k) => k.subject_type === "campaign").map((k) => k.subject_id))];
    return { revoked: [...revoked, ...names], checks: checks.length, facts, campaigns };
  } catch (e) { db.exec("rollback"); throw e; }
}

/** A company's full-name records, newest first. */
export function listNames(db: Db, companyId: string) {
  syncBuiltinSites(db);
  return (db.prepare("select * from company_identity where company_id = ? and kind = 'name' order by verified_at desc").all(companyId) as any[]).map((r) => ({
    id: r.id as string, name: r.value as string, how: r.root_kind as string, basisUrl: r.basis_url as string, basisQuote: r.basis_quote as string, siteId: (r.site_id ?? null) as string | null,
    status: (r.status === "active" && r.expires_at && r.expires_at <= now() ? "expired" : r.status) as string, verifiedAt: r.verified_at as string,
    revoked: r.revoked_at ? { at: r.revoked_at as string, by: r.revoked_by as string, reason: r.revoke_reason as string } : null,
  }));
}

/** A company's site records, newest first, with how each is known and whether it stands. */
export function listSites(db: Db, companyId: string) {
  syncBuiltinSites(db);
  return (db.prepare("select * from company_site where company_id = ? order by verified_at desc").all(companyId) as any[]).map((r) => ({
    id: r.id as string, site: r.site_key as string, how: r.root_kind as RootKind, basisUrl: r.basis_url as string, basisQuote: r.basis_quote as string, parentId: (r.parent_id ?? null) as string | null,
    status: (r.status === "active" && r.expires_at && r.expires_at <= now() ? "expired" : r.status) as string, verifiedAt: r.verified_at as string, expiresAt: (r.expires_at ?? null) as string | null,
    revoked: r.revoked_at ? { at: r.revoked_at as string, by: r.revoked_by as string, reason: r.revoke_reason as string } : null,
  }));
}

// ---------- exchange disclosures (巨潮资讯, the disclosure platform the CSRC designates) ----------

export interface ExchangeHit { code: string; category: string; zwjc: string; delisted?: string }
export interface ExchangeProfile { orgName: string; websites: string[] }

/**
 * The one listed A-share company a library name stands for: its short name or its full name is that name exactly,
 * and no other live A-share is. Anything looser (a name containing another, 集团 / 科技 dropped) is no match: a group,
 * its listed part and a namesake are told apart by the disclosure, not by likeness.
 */
export function pickExchange(names: string[], hits: ExchangeHit[], orgNameOf: (code: string) => string | undefined): ExchangeHit | null {
  const keys = new Set(names.map(companyKey));
  const live = hits.filter((h) => h.delisted !== "true" && h.category === "A股");
  const same = live.filter((h) => keys.has(companyKey(h.zwjc)) || keys.has(companyKey(orgNameOf(h.code) ?? "")));
  return same.length === 1 ? same[0] : null;
}

/** 巨潮's company overview: the full name and the website(s) the company discloses (F011V, may list several). */
export function parseProfile(x: any): ExchangeProfile | null {
  const b = x?.data?.records?.[0]?.basicInformation?.[0];
  if (!b?.ORGNAME) return null;
  const websites = String(b.F011V ?? "").split(/[;；,，\s]+/).map((w) => w.trim()).filter((w) => /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(w));
  return { orgName: String(b.ORGNAME).trim(), websites };
}

const CNINFO = "http://www.cninfo.com.cn";
const getJson = async (url: string, init?: RequestInit) => (await guardedFetch(url, { ...init, headers: { "user-agent": "Mozilla/5.0", ...(init?.headers as any) }, signal: AbortSignal.timeout(20_000) })).json();

/**
 * Put on record the website a listed company discloses on 巨潮, for a library company that is that listed company —
 * the exact host, valid 90 days. Looked up once a month per company; what was found (or why not) is kept.
 */
export async function exchangeRoot(db: Db, companyId: string, force = false): Promise<{ status: "added" | "kept" | "none" | "skipped"; note: string }> {
  // a disclosure on record and not about to lapse: nothing to look up
  const soon = new Date(Date.now() + 7 * 86400_000).toISOString();
  if (!force && db.prepare("select 1 from company_site where company_id = ? and root_kind = 'exchange' and status = 'active' and (expires_at is null or expires_at > ?)").get(companyId, soon)) return { status: "skipped", note: "已有交易所披露的网址" };
  const last = db.prepare("select at from trust_lookup where company_id = ? and kind = 'exchange'").get(companyId) as { at: string } | undefined;
  if (!force && last && last.at > new Date(Date.now() - 30 * 86400_000).toISOString()) return { status: "skipped", note: "这个月查过" };
  const co = db.prepare("select name, aliases from company where id = ?").get(companyId) as { name: string; aliases: string } | undefined;
  if (!co) return { status: "none", note: "没有这家公司" };
  let aliases: string[] = [];
  try { aliases = JSON.parse(co.aliases || "[]"); } catch { /* none */ }
  const done = (status: "added" | "kept" | "none", note: string) => { db.prepare("insert or replace into trust_lookup(company_id, kind, at, outcome, note) values (?,?,?,?,?)").run(companyId, "exchange", now(), status, note); return { status, note }; };
  const hits = (await getJson(`${CNINFO}/new/information/topSearch/query`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ keyWord: co.name, maxNum: "10" }).toString() }).catch(() => null)) as ExchangeHit[] | null;
  if (!Array.isArray(hits)) return done("none", "巨潮没查到");
  const profiles = new Map<string, ExchangeProfile | null>();
  for (const h of hits.filter((x) => x.delisted !== "true" && x.category === "A股").slice(0, 5)) {
    profiles.set(h.code, parseProfile(await getJson(`${CNINFO}/data20/companyOverview/getCompanyIntroduction?scode=${h.code}`).catch(() => null)));
  }
  const hit = pickExchange([co.name, ...aliases], hits, (code) => profiles.get(code)?.orgName);
  if (!hit) return done("none", "不是一家上市公司，或名字对得上的不止一家");
  const p = profiles.get(hit.code);
  if (!p?.websites.length) return done("none", `${hit.zwjc}（${hit.code}）没披露网址`);
  const url = `${CNINFO}/data20/companyOverview/getCompanyIntroduction?scode=${hit.code}`;
  let added = 0, first = "";
  for (const w of p.websites) {
    const key = siteKeyOf(/^https?:\/\//i.test(w) ? w : `http://${w}`);
    if (!key) continue;
    const r = addSite(db, { companyId, siteKey: key, rootKind: "exchange", basisUrl: url, basisQuote: `${p.orgName}（${hit.code} ${hit.zwjc}）在巨潮资讯披露的公司网址：${w}`, fingerprint: `exchange:${hit.code}:${p.orgName}:${w.toLowerCase()}`, days: 90 });
    if ("id" in r) { added++; first ||= r.id; }
  }
  // the full name disclosed with it is the company's own, tied to that site record
  if (first) addName(db, { companyId, value: p.orgName, rootKind: "exchange", basisUrl: url, basisQuote: `巨潮资讯：${hit.zwjc}（${hit.code}）的公司全称为 ${p.orgName}`, fingerprint: `exchange:${hit.code}:${p.orgName}`, siteId: first, days: 90 });
  return done(added ? "added" : "kept", `${p.orgName}（${hit.code}）：${p.websites.join("、")}`);
}

// ---------- one hop from a known site to its hiring site ----------

const RECRUIT = /招聘|加入我们|加入.{0,4}(团队|我们)|人才|校园|校招|join\s*us|careers?\b|jobs?\b/i;
export interface PageLinks { url: string; title: string; links: { text: string; href: string }[] }

/**
 * Which links on a known site's pages lead straight to `target` from a hiring entry: the link's own text says so, or
 * the page is the site's hiring page. Only links whose address is on the target itself count — a link that goes
 * through the known site's own redirect, or a shortener, does not (an open redirect would lend the site's word to anyone).
 * Pure over pages already read; the caller reads the pages and follows the found link to check where it ends.
 */
export function hiringLinksTo(pages: PageLinks[], target: string): { page: string; text: string; href: string }[] {
  const out: { page: string; text: string; href: string }[] = [];
  for (const p of pages) {
    const hiringPage = RECRUIT.test(p.title);
    for (const l of p.links) {
      if (siteKeyOf(l.href) !== target) continue;
      if (!RECRUIT.test(l.text) && !hiringPage) continue;
      if (!out.some((o) => o.href === l.href)) out.push({ page: p.url, text: l.text.trim().slice(0, 40), href: l.href });
    }
  }
  return out;
}

/** Every link on a page, with its words (a home page can carry hundreds; the hiring one is often near the end). */
export function anchors(html: string, base: string): { text: string; href: string }[] {
  const out: { text: string; href: string }[] = [];
  for (const m of html.matchAll(/<a\s[^>]*?href\s*=\s*["']([^"'#][^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    let href = "";
    try { href = new URL(m[1].replace(/&amp;/g, "&"), base).href; } catch { continue; }
    if (!/^https?:/i.test(href)) continue;
    const text = m[2].replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/\s+/g, " ").trim() || (/title\s*=\s*["']([^"']+)["']/i.exec(m[0])?.[1] ?? "");
    out.push({ text, href });
  }
  return out;
}

/** The known site's own pages that are its hiring entries (to look one level further in). */
export function hiringPagesOn(page: PageLinks, root: string): string[] {
  return [...new Set(page.links.filter((l) => siteKeyOf(l.href) === root && RECRUIT.test(l.text)).map((l) => l.href.split("#")[0]))].slice(0, 3);
}

/**
 * Put `target` on record as the company's hiring site when one of its sites from an outside record (built-in or
 * exchange — never one found this way) links to it from a hiring entry, on its home page or one hiring page down, and
 * the link opens on the target itself. One hop only: a site found this way vouches for nothing further. Looked up
 * once a month per target.
 */
export async function linkFromRoots(read: (url: string) => Promise<PageLinks | null>, db: Db, companyId: string, target: string, force = false): Promise<{ status: "added" | "none" | "skipped"; note: string }> {
  const kind = `linked:${target}`;
  const last = db.prepare("select at from trust_lookup where company_id = ? and kind = ?").get(companyId, kind) as { at: string } | undefined;
  if (!force && last && last.at > new Date(Date.now() - 30 * 86400_000).toISOString()) return { status: "skipped", note: "这个月查过" };
  const done = (status: "added" | "none", note: string) => { db.prepare("insert or replace into trust_lookup(company_id, kind, at, outcome, note) values (?,?,?,?,?)").run(companyId, kind, now(), status, note); return { status, note }; };
  const roots = db.prepare("select id, site_key from company_site where company_id = ? and root_kind in ('builtin', 'exchange') and status = 'active' and (expires_at is null or expires_at > ?)").all(companyId, now()) as { id: string; site_key: string }[];
  if (!roots.length) return done("none", "这家公司还没有已确认的官网");
  for (const root of roots.slice(0, 3)) {
    if (root.site_key.includes(":")) continue; // a hiring-system tenant has no home page of its own to look on
    let home: PageLinks | null = null;
    for (const u of [`https://www.${root.site_key}/`, `https://${root.site_key}/`, `http://www.${root.site_key}/`, `http://${root.site_key}/`]) if ((home = await read(u))) break;
    if (!home) continue;
    const pages = [home];
    // a home page in another language: its own Chinese version is read too (www.mindray.com opens in English)
    const zh = home.links.find((l) => siteKeyOf(l.href) === root.site_key && /中文|简体|China\b/i.test(l.text) && l.href.split("#")[0] !== home.url);
    if (zh) { const p = await read(zh.href); if (p) pages.push(p); }
    for (const page of [...pages]) for (const u of hiringPagesOn(page, root.site_key)) { if (pages.length >= 6 || pages.some((x) => x.url === u)) continue; const p = await read(u); if (p) pages.push(p); }
    for (const l of hiringLinksTo(pages, target)) {
      // the link must open on the target itself, not lead on to somewhere else
      const end = await guardedFetchTo(l.href, { headers: { "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(20_000) }).then((r) => { void r.res.body?.cancel(); return r.res.ok ? r.url : ""; }).catch(() => "");
      if (!end || siteKeyOf(end) !== target) continue;
      const r = addSite(db, { companyId, siteKey: target, rootKind: "linked", basisUrl: l.page, basisQuote: `${root.site_key} 的「${l.text || "招聘页"}」链到 ${l.href}`, fingerprint: `linked:${root.id}:${target}:${l.page}:${l.href}`, parentId: root.id, days: 90 });
      if ("id" in r) return done("added", `${root.site_key} →「${l.text}」→ ${target}`);
    }
  }
  return done("none", "已确认的官网上没找到指向它的招聘入口");
}
