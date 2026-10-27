import { ulid } from "ulid";
import { now, type Db } from "../db.js";
import { companyKey, guardedFetch } from "../data/index.js";
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
export const BUILTIN_SITES: { company: string; site: string; why: string }[] = [
  { company: "国家能源集团", site: "zhaopin.chnenergy.com.cn", why: "Zhiro 内置读取器 chnenergy：国家能源集团招聘平台" },
  { company: "中国华能", site: "zhaopin.chng.com.cn", why: "Zhiro 内置读取器 chng：中国华能招聘平台" },
  { company: "快手", site: "campus.kuaishou.cn", why: "Zhiro 内置读取器 kuaishou：快手校园招聘" },
  { company: "小红书", site: "job.xiaohongshu.com", why: "Zhiro 内置读取器 xiaohongshu：小红书招聘" },
];

/** Put the built-in sites on record for the companies the library has. A site once revoked is never brought back here. */
export function syncBuiltinSites(db: Db): void {
  const company = db.prepare("select id from company where name = ?");
  const known = db.prepare("select 1 from company_site where company_id = ? and site_key = ? and root_kind = 'builtin'");
  for (const b of BUILTIN_SITES) {
    const co = company.get(b.company) as { id: string } | undefined;
    if (!co || known.get(co.id, b.site)) continue;
    db.prepare("insert into company_site(id, company_id, site_key, root_kind, basis_quote, basis_fingerprint, verified_at) values (?,?,?,?,?,?,?)").run(ulid(), co.id, b.site, "builtin", b.why, `builtin:${b.site}`, now());
  }
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

export type Dep = { kind: "site" | "account"; id: string };
/** Whether everything a check leaned on still stands (checked inside the transaction that writes its deadline). */
export function depsStand(db: Db, deps: Dep[]): boolean {
  const site = db.prepare("select 1 from company_site where id = ? and status = 'active' and (expires_at is null or expires_at > ?)");
  return deps.every((d) => d.kind !== "site" || !!site.get(d.id, now()));
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
    const revoked: string[] = [];
    const queue = [id];
    while (queue.length) {
      const x = queue.shift()!;
      const r = db.prepare("update company_site set status = 'revoked', revoked_at = ?, revoked_by = ?, revoke_reason = ? where id = ? and status != 'revoked'").run(at, by, revoked.length ? `依据 ${id} 已撤回` : reason, x);
      if (!r.changes) continue;
      revoked.push(x);
      for (const c of db.prepare("select id from company_site where parent_id = ? and status != 'revoked'").all(x) as { id: string }[]) queue.push(c.id);
    }
    const marks = revoked.map(() => "?").join(",");
    const checks = revoked.length ? (db.prepare(`select distinct d.check_id, k.subject_type, k.subject_id from notice_check_dep d join notice_check k on k.id = d.check_id where d.kind = 'site' and d.ref_id in (${marks}) and k.invalidated_at is null`).all(...revoked) as { check_id: string; subject_type: string; subject_id: string }[]) : [];
    let facts = 0;
    for (const k of checks) {
      db.prepare("update notice_check set invalidated_at = ? where id = ?").run(at, k.check_id);
      facts += Number(db.prepare("update deadline_fact set superseded_at = ? where check_id = ? and superseded_at is null").run(at, k.check_id).changes);
    }
    db.exec("commit");
    const campaigns = [...new Set(checks.filter((k) => k.subject_type === "campaign").map((k) => k.subject_id))];
    return { revoked, checks: checks.length, facts, campaigns };
  } catch (e) { db.exec("rollback"); throw e; }
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
  let added = 0;
  for (const w of p.websites) {
    const key = siteKeyOf(/^https?:\/\//i.test(w) ? w : `http://${w}`);
    if (!key) continue;
    const r = addSite(db, { companyId, siteKey: key, rootKind: "exchange", basisUrl: url, basisQuote: `${p.orgName}（${hit.code} ${hit.zwjc}）在巨潮资讯披露的公司网址：${w}`, fingerprint: `exchange:${hit.code}:${p.orgName}:${w.toLowerCase()}`, days: 90 });
    if ("id" in r) added++;
  }
  return done(added ? "added" : "kept", `${p.orgName}（${hit.code}）：${p.websites.join("、")}`);
}
