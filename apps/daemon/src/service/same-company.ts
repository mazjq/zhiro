import type { Db } from "../db.js";
import { PLACE } from "./intel.js";

/**
 * One unit, two spellings: a summary sheet writes 「中船七二二所」, the group's career site 「中国船舶集团有限公司第七二二研究所」.
 * The key maps group names to one short form, Chinese numerals to digits, 研究所/研究院 to 所/院 and drops legal suffixes,
 * so both become 「中船722所」. Only a suggestion: two legal entities stay apart until a person merges them (ADR-015).
 * ponytail: the group table is the big SOE groups seen in the pool; add a row when a new group shows up split.
 */
const GROUPS: [RegExp, string][] = [
  [/^(中国船舶(重工|工业)?集团(有限公司)?|中国船舶|中船集团|中船)/, "中船"],
  [/^(中国航天科技集团(有限公司)?|航天科技集团|航天科技)/, "航天科技"],
  [/^(中国航天科工集团(有限公司)?|航天科工集团|航天科工)/, "航天科工"],
  [/^(中国电子科技集团(有限)?公司|中国电科|中电科|电科)/, "电科"],
  [/^(国家能源投资集团(有限责任公司)?|国家能源集团|国能)/, "国能"],
  [/^(中国华能集团(有限公司)?|中国华能|华能集团|华能)/, "华能"],
  [/^(中国航空工业集团(有限公司)?|航空工业集团|中航工业|航空工业)/, "航空工业"],
  [/^(中国航空发动机集团(有限公司)?|中国航发|航发)/, "航发"],
  [/^(中国兵器工业集团(有限公司)?|兵器工业集团|中国兵器|兵器工业)/, "兵器"],
  [/^(中国兵器装备集团(有限公司)?|兵器装备集团|兵装)/, "兵装"],
  [/^(国家电力投资集团(有限公司)?|国家电投集团|国家电投)/, "国家电投"],
  [/^(中国核工业集团(有限公司)?|中核集团|中核)/, "中核"],
  [/^(中国能源建设集团(有限公司)?|中国能建)/, "中国能建"],
  [/^(中国电力建设集团(有限公司)?|中国电建)/, "中国电建"],
];
const DIGIT: Record<string, string> = { 〇: "0", 零: "0", 一: "1", 二: "2", 三: "3", 四: "4", 五: "5", 六: "6", 七: "7", 八: "8", 九: "9" };

/** 「七二二」→722, 「七〇三」→703, 「十一」→11, 「二十三」→23. */
function numerals(s: string): string {
  return s.replace(/[〇零一二三四五六七八九十]+/g, (run) => {
    if (!run.includes("十")) return run.length > 1 || /[〇零]/.test(run) ? [...run].map((c) => DIGIT[c]).join("") : run; // a lone 一/二 is often a word
    const [a, b] = run.split("十");
    if (/[十]/.test(b ?? "") || (a && a.length > 1)) return run;
    return String((a ? Number(DIGIT[a]) : 1) * 10 + (b ? Number(DIGIT[b] ?? 0) : 0));
  });
}

export function unitKey(name: string): string {
  // a note in brackets goes (「(ATL)」「（互娱）」), a place stays: 中远海运（青岛）and（天津）are two companies
  let s = name.normalize("NFKC").replace(/\s+/g, "").replace(/[（(]([^）)]*)[）)]/g, (m, inner: string) => (PLACE.test(inner) && inner.replace(PLACE, "").length <= 1 ? `(${inner})` : ""));
  for (const [re, short] of GROUPS) if (re.test(s)) { s = s.replace(re, short); break; }
  s = s.replace(/(股份)?有限(责任)?公司/g, "").replace(/研究所/g, "所").replace(/研究院/g, "院").replace(/第/g, "");
  return numerals(s);
}

/** Other companies in the pool that are probably this one. Keys are only compared when they carry more than a bare group name. */
export function sameCompanies(db: Db, companyId: string): { companyId: string; companyName: string }[] {
  const all = db.prepare("select id, name from company").all() as { id: string; name: string }[];
  const me = all.find((c) => c.id === companyId);
  if (!me) return [];
  const k = unitKey(me.name);
  if (k.length < 3) return [];
  return all.filter((c) => c.id !== companyId && unitKey(c.name) === k).map((c) => ({ companyId: c.id, companyName: c.name }));
}

/** key → companies, for callers that look at many companies at once (the 待展开 run). */
export function unitIndex(db: Db): Map<string, { id: string; name: string }[]> {
  const idx = new Map<string, { id: string; name: string }[]>();
  for (const c of db.prepare("select id, name from company").all() as { id: string; name: string }[]) {
    const k = unitKey(c.name);
    if (k.length >= 3) (idx.get(k) ?? idx.set(k, []).get(k)!).push(c);
  }
  return idx;
}
