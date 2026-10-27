import { ulid } from "ulid";
import { now, type Db } from "../db.js";

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
