import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../db.js";
import { ingest, type Listing } from "../data/index.js";
import { addSite, revokeSite, trustedSites, listSites } from "./trust.js";
import { checkNotice, recordCheck, type NoticeDoc, type Extract } from "./notice.js";
import { companyIdentity } from "./notice-verify.js";

const SEASON = { cohort: "2027", since: "2026-03-01", until: "2027-08-31" };
const listing = (company: string, url: string): Listing => ({ externalId: `${company}-1`, url, title: "控制算法工程师", company, locations: ["武汉"], publisher: "x", grade: "官方", isOriginal: true, confidence: 1, cohort: "2027届", batch: "校招" });
function setup() {
  const dir = mkdtempSync(join(tmpdir(), "zhiro-trust-"));
  const db = openDb(join(dir, "t.db"));
  ingest({ db }, dir, "capture", "c1", [listing("示例重工股份有限公司", "https://careers.example-heavy.cn/jobs/1"), listing("国家能源集团", "https://zhaopin.chnenergy.com.cn/jobs/1")]);
  db.prepare("update campaign set source_grade = '官方', notice_url = apply_url").run();
  const co = (name: string) => (db.prepare("select id from company where name = ?").get(name) as any).id as string;
  const camp = (name: string) => (db.prepare("select c.id from campaign c join company co on co.id = c.company_id where co.name = ?").get(name) as any).id as string;
  return { dir, db, co, camp };
}
const doc = (url: string): NoticeDoc => ({ url, finalUrl: url, via: "http", status: "ok", title: "2027届校园招聘公告", text: "示例重工股份有限公司 2027届校园招聘公告。招聘对象：2027届毕业生。网申截止时间：2099年10月31日。", images: [], complete: true });
const ex: Extract = { isRecruitment: true, issuer: "示例重工股份有限公司", cohort: "2027届", cohortQuote: "招聘对象：2027届毕业生", cohortImage: null, deadlineText: "网申截止时间：2099年10月31日", deadlineDate: "2099-10-31", deadlineImage: null, applyEntry: "", scope: "", doubts: "", seen: { chars: 1e6, images: 99, model: "m" } };

describe("官网信任根: only sites on record, with their evidence, are a company's own", () => {
  it("a batch labelled 官方 does not make its site the company's own", () => {
    const { db, co } = setup();
    const id = companyIdentity(db, co("示例重工股份有限公司"));
    expect(id.sites.size).toBe(0);
    expect(checkNotice(doc("https://careers.example-heavy.cn/notice/1"), ex, id, SEASON).gates.publisher.result).toBe("unknown");
  });

  it("built-in sites come on record for the companies the library has; one revoked is never brought back", () => {
    const { db, co } = setup();
    const energy = co("国家能源集团");
    expect([...trustedSites(db, energy).keys()]).toEqual(["zhaopin.chnenergy.com.cn"]);
    const [site] = listSites(db, energy);
    revokeSite(db, site.id, "test", "试一下");
    expect(trustedSites(db, energy).size).toBe(0); // the sync ran again inside, and left it revoked
  });

  it("revoking a site undoes what leaned on it — the sites it vouched for, the checks, their deadlines — and nothing else", () => {
    const { dir, db, co, camp } = setup();
    const company = co("示例重工股份有限公司"), cid = camp("示例重工股份有限公司");
    const root = addSite(db, { companyId: company, siteKey: "example-heavy.cn", rootKind: "exchange", basisUrl: "https://x/d", basisQuote: "公司网址", fingerprint: "a" }) as { id: string };
    const child = addSite(db, { companyId: company, siteKey: "careers.example-heavy.cn", rootKind: "linked", basisUrl: "https://example-heavy.cn/", basisQuote: "加入我们", fingerprint: "b", parentId: root.id }) as { id: string };
    const r = recordCheck({ db, vault: dir }, { type: "campaign", id: cid }, doc("https://careers.example-heavy.cn/notice/1"), ex, checkNotice(doc("https://careers.example-heavy.cn/notice/1"), ex, companyIdentity(db, company), SEASON));
    expect(r.factId).toBeTruthy();
    const out = revokeSite(db, root.id, "test", "披露的网址不是这家公司的");
    expect(out.revoked.sort()).toEqual([root.id, child.id].sort());
    expect(out).toMatchObject({ checks: 1, facts: 1, campaigns: [cid] });
    expect((db.prepare("select superseded_at from deadline_fact where id = ?").get(r.factId!) as any).superseded_at).toBeTruthy();
    expect((db.prepare("select invalidated_at from notice_check where id = ?").get(r.checkId) as any).invalidated_at).toBeTruthy();
    // the same evidence is not taken again; new evidence is
    expect(addSite(db, { companyId: company, siteKey: "example-heavy.cn", rootKind: "exchange", basisUrl: "https://x/d", basisQuote: "公司网址", fingerprint: "a" })).toEqual({ refused: "这条证据之前被撤回过" });
    expect(addSite(db, { companyId: company, siteKey: "example-heavy.cn", rootKind: "exchange", basisUrl: "https://x/e", basisQuote: "公司网址", fingerprint: "c" })).toHaveProperty("id");
  });

  it("a site revoked between the reading and the writing: the deadline is not written", () => {
    const { dir, db, co, camp } = setup();
    const company = co("示例重工股份有限公司"), cid = camp("示例重工股份有限公司");
    const root = addSite(db, { companyId: company, siteKey: "careers.example-heavy.cn", rootKind: "exchange", basisUrl: "https://x/d", basisQuote: "公司网址", fingerprint: "a" }) as { id: string };
    const result = checkNotice(doc("https://careers.example-heavy.cn/notice/1"), ex, companyIdentity(db, company), SEASON);
    expect(result.outcome).toBe("fact");
    revokeSite(db, root.id, "test", "撤回");
    const r = recordCheck({ db, vault: dir }, { type: "campaign", id: cid }, doc("https://careers.example-heavy.cn/notice/1"), ex, result);
    expect(r.factId).toBeUndefined();
    expect((db.prepare("select outcome from notice_check where id = ?").get(r.checkId) as any).outcome).toBe("review");
  });

  it("two independent records for one site: revoking one leaves the site standing", () => {
    const { db, co } = setup();
    const company = co("示例重工股份有限公司");
    const a = addSite(db, { companyId: company, siteKey: "careers.example-heavy.cn", rootKind: "exchange", basisUrl: "https://x/d", basisQuote: "q", fingerprint: "a" }) as { id: string };
    addSite(db, { companyId: company, siteKey: "careers.example-heavy.cn", rootKind: "exchange", basisUrl: "https://x/e", basisQuote: "q", fingerprint: "b" });
    revokeSite(db, a.id, "test", "撤回");
    expect(trustedSites(db, company).has("careers.example-heavy.cn")).toBe(true);
  });
});
