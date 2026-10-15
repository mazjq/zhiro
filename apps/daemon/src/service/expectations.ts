import type { Db } from "../db.js";

/**
 * 期望卡 (ADR-036): what the person wants, read from the 期望 (preference) fact cards. One card per field, several
 * values on a card are OR, fields are AND. A card marked 硬性 filters; every other card only orders. Rules judge only
 * what the data states (no city on the post → 待核实, never 不符合); the note on a card is for people and the model.
 */
export const HARD_FIELDS = ["城市", "公司类型"];
export const EXPECTATION_FIELDS = ["城市", "公司类型", "行业", "岗位类型", "期望薪资", "到岗时间", "发展偏好"];
export interface Expectation { field: string; values: string[]; hard: boolean; note: string }
export type ExpStatus = "pass" | "unknown" | "fail";
export interface Reason { field: string; status: ExpStatus; evidence: string; hard: boolean }
export interface Verdict { status: ExpStatus; score: number; reasons: Reason[] }

export const splitValues = (v: unknown) => String(v ?? "").split(/[、,，;；/|\s]+/).map((s) => s.trim()).filter(Boolean);

export function loadExpectations(db: Db): Expectation[] {
  return (db.prepare("select data_json from fact where kind = 'preference'").all() as { data_json: string }[])
    .map((r) => { try { return JSON.parse(r.data_json); } catch { return {}; } })
    .filter((d) => d.field && d.value)
    .map((d) => ({ field: String(d.field), values: splitValues(d.value), hard: d.mode === "硬性", note: String(d.note ?? "") }));
}

const RANK: Record<ExpStatus, number> = { pass: 0, unknown: 1, fail: 2 };
export const statusRank = (s: ExpStatus | undefined) => (s ? RANK[s] : 0);
const hit = (text: string, values: string[]) => values.some((v) => text.includes(v) || v.includes(text));

/** One post against the cards. Only 城市 and 公司类型 have rules; the rest is context for the model. */
export function judge(exps: Expectation[], post: { cities?: string[] }, company: { companyType?: string; cities?: string[]; blocked?: boolean }): Verdict {
  const reasons: Reason[] = [];
  if (company.blocked) reasons.push({ field: "公司", status: "fail", evidence: "标了「不投」", hard: true });
  for (const e of exps) {
    if (e.field === "城市") {
      const where = post.cities?.length ? post.cities : company.cities ?? [];
      const status: ExpStatus = !where.length || where.some((c) => /全国|不限|多地|远程|各地/.test(c)) ? "unknown" : where.some((c) => hit(c, e.values)) ? "pass" : "fail";
      reasons.push({ field: e.field, status, evidence: where.length ? where.slice(0, 6).join("、") : "未写工作地", hard: e.hard });
    } else if (e.field === "公司类型") {
      const t = company.companyType ?? "";
      const status: ExpStatus = !t ? "unknown" : hit(t, e.values) ? "pass" : "fail";
      reasons.push({ field: e.field, status, evidence: t || "企业类型未知", hard: e.hard });
    }
  }
  const hard = reasons.filter((r) => r.hard);
  const status: ExpStatus = hard.some((r) => r.status === "fail") ? "fail" : hard.some((r) => r.status === "unknown") ? "unknown" : "pass";
  const score = reasons.filter((r) => !r.hard).reduce((n, r) => n + (r.status === "pass" ? 1 : r.status === "fail" ? -1 : 0), 0);
  return { status, score, reasons };
}
