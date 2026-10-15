import { existsSync, readFileSync } from "node:fs";
import { now, tx, json } from "../db.js";
import { Domain, DomainError, sha } from "./domain.js";

import { parseCsv, parseDeadline, splitList, gradeFromSource } from "../data/index.js";

const REQUIRED = ["公司", "招聘岗位"];
const HEADER_ALIASES: Record<string, string> = {
  更新时间: "updatedAt", 公司: "company", 企业类型: "companyType", 行业类别: "industry", 批次: "batch", 招聘届次: "cohort",
  工作地点: "cities", 招聘岗位: "positions", 学历要求: "degree", 专业要求: "major", 开始时间: "opensAt", 截止时间: "deadline",
  简历投递链接: "applyUrl", 公告链接: "noticeUrl", 是否笔试: "writtenTest", 公告来源: "source", 备注: "notes",
};

/** The one-shot import of M0, kept as it was: its own campaign key and row ledger (import_row). A CSV that should keep itself up to date is a subscription (source.add). */
export function importCsv(domain: Domain, path: string, sourceName = "csv") {
  if (!existsSync(path)) throw new DomainError("FILE_NOT_FOUND", path);
  const rows = parseCsv(readFileSync(path, "utf8"));
  if (rows.length === 0) throw new DomainError("BAD_HEADER", "empty");
  const header = rows[0].map((h) => h.trim());
  for (const r of REQUIRED) if (!header.includes(r)) throw new DomainError("BAD_HEADER", `missing ${r}`);
  const idx = (name: string) => header.indexOf(name);
  const get = (row: string[], cn: string) => (idx(cn) >= 0 ? (row[idx(cn)] ?? "").trim() : "");

  const stats = { rows: 0, inserted: 0, updated: 0, skipped: 0, campaigns: 0, positions: 0 };
  const db = domain.db;
  for (const row of rows.slice(1)) {
    stats.rows++;
    const raw: Record<string, string> = {};
    header.forEach((h, i) => (raw[HEADER_ALIASES[h] ?? h] = (row[i] ?? "").trim()));
    const rowHash = sha(sourceName + "|" + JSON.stringify(row));
    const existing = db.prepare("select campaign_id from import_row where row_hash = ?").get(rowHash) as { campaign_id: string } | undefined;
    if (existing) { stats.skipped++; continue; }

    const company = get(row, "公司");
    if (!company) { stats.skipped++; continue; }
    const { closesAt, kind } = parseDeadline(get(row, "截止时间"));
    const opens = parseDeadline(get(row, "开始时间")).closesAt;
    const applyUrl = get(row, "简历投递链接");
    const batch = get(row, "批次");
    const cohort = get(row, "招聘届次");
    const externalKey = sha(`${company}|${batch}|${cohort}|${applyUrl || get(row, "公告链接")}`);

    tx(db, () => {
      const companyId = domain.upsertCompany(company, get(row, "企业类型"), get(row, "行业类别"));
      const { id: campaignId, created } = domain.upsertCampaign({
        companyId, externalKey, kind: /博士/.test(batch + get(row, "招聘岗位")) ? "博士专项" : /实习/.test(batch) ? "实习" : "校招",
        cohort, batch, cities: splitList(get(row, "工作地点")), degreeReq: get(row, "学历要求"), majorReq: get(row, "专业要求"),
        opensAt: opens, closesAt, deadlineKind: kind, deadlineText: get(row, "截止时间"), applyUrl, noticeUrl: get(row, "公告链接"),
        sourceGrade: gradeFromSource(get(row, "公告来源"), get(row, "公告链接")) as any, sourceKind: get(row, "公告来源") || sourceName,
        hasWrittenTest: get(row, "是否笔试"), notes: get(row, "备注"), lastVerifiedAt: null,
      });
      created ? stats.inserted++ : stats.updated++;
      if (created) stats.campaigns++;
      for (const title of splitList(get(row, "招聘岗位")).slice(0, 40)) {
        const p = domain.upsertPosition(campaignId, title, { cities: splitList(get(row, "工作地点")), degreeReq: get(row, "学历要求") });
        if (p.created) stats.positions++;
      }
      db.prepare("insert into import_row(row_hash, source, raw_json, campaign_id, imported_at) values (?,?,?,?,?)").run(rowHash, sourceName, json.str(raw), campaignId, now());
    });
  }
  return stats;
}
