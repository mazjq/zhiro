import { join } from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import type { Db } from "../db.js";
import { listFacts } from "./profile.js";
import { canonOf, normLabel, SENSITIVE } from "./apply.js";

/**
 * 还缺什么: the answers application forms keep asking for that the profile does not have yet, each with a hint on what
 * to write. Forms the user actually met come first (counted from the saved runs), then the fields nearly every campus
 * form asks. Sensitive fields (证件号 …) are never asked for.
 */
export interface Gap { kind: "basic" | "preference" | "education" | "experience" | "project"; field: string; hint: string; asked: number; factId?: string }

const COMMON: [Gap["kind"], string, string][] = [
  ["basic", "性别", "男 / 女"],
  ["basic", "出生年月", "如 2000.01"],
  ["basic", "民族", "如 汉族"],
  ["basic", "籍贯", "写到区县，如 湖南省岳阳市岳阳楼区（有的表单要选到区县）"],
  ["basic", "现居地", "写到区县，如 湖北省武汉市洪山区"],
  ["basic", "政治面貌", "中共党员 / 共青团员 / 群众 …"],
  ["basic", "预计毕业时间", "如 2027.06"],
  ["basic", "工作经验", "应届生填「应届」（有的表单叫「无工作经验」，会按选项对上）"],
  ["basic", "英语水平", "如 CET-6 550"],
  ["basic", "自我描述", "2–3 句：研究方向、代表成果、想做什么。表单里的「自我描述 / 自我评价 / 个人简介」都用它"],
  ["preference", "城市", "期望工作城市，如 武汉。可以加多张"],
  ["preference", "期望薪资", "如 面议，或 25k×15；几乎每个表单都问"],
  ["preference", "到岗时间", "如 2027年7月"],
];
const HINT: Record<string, string> = { ...Object.fromEntries(COMMON.map(([, f, h]) => [f, h])), 行业: "期望行业，如 新能源汽车 / 机器人" };
/** 意向 cards the recommenders read are named 城市 / 行业; a form asks 期望城市 / 期望行业 */
const AS_PREF: Record<string, string> = { 期望城市: "城市", 期望行业: "行业" };
const PREF = new Set(["城市", "行业", "期望薪资", "到岗时间"]);

export function profileGaps(db: Db, vault: string): { items: Gap[] } {
  const facts = listFacts(db).items;
  const have = new Set(facts.filter((f) => f.kind === "basic" || f.kind === "preference").map((f) => normLabel(f.data.field ?? "")));

  // what the forms the user met asked for and did not get from the profile
  const asked = new Map<string, number>();
  const dir = join(vault, "runs", "apply");
  if (existsSync(dir)) for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    let run: any; try { run = JSON.parse(readFileSync(join(dir, file), "utf8")); } catch { continue; }
    const seen = new Set<string>();
    for (const f of run.form ?? []) {
      if (!["由你填写", "画像里没有"].includes(f.status) || !f.label || f.type === "file" || f.type === "checkbox" || SENSITIVE.test(f.label)) continue;
      if (/经历|经验|项目|实习|工作|获奖|论文|专利|教育|更新说明/.test(f.section ?? "") && !/求职|意向|个人/.test(f.section ?? "")) continue; // multi-row blocks are a separate matter
      if (/推荐码|内推|推荐人|了解渠道|简历更新|最近公司|目前职位|所在行业|当前薪资|面试站点/.test(f.label)) continue; // per-application or not for new graduates
      // the fields of an internship / project / job entry, on forms without section headings (北森)
      if (/开始时间|结束时间|起止|单位名称|公司名称|职位名称|^职务$|^职责$|实习内容|工作内容|工作职责|项目名称|项目描述|项目中|工作地点|汇报对象|公司规模|公司性质|离职原因|^薪资$/.test(normLabel(f.label))) continue;
      const name = AS_PREF[canonOf(f.label)] ?? (canonOf(f.label) || normLabel(f.label));
      if (!seen.has(name)) { seen.add(name); asked.set(name, (asked.get(name) ?? 0) + 1); }
    }
  }

  const gaps: Gap[] = [];
  const add = (kind: Gap["kind"], field: string) => { if (!have.has(field) && !gaps.some((g) => g.field === field)) gaps.push({ kind, field, hint: HINT[field] ?? "", asked: asked.get(field) ?? 0 }); };
  for (const [field] of [...asked].sort((a, b) => b[1] - a[1])) add(PREF.has(field) ? "preference" : "basic", field);
  for (const [kind, field] of COMMON) add(kind, field);

  // places some forms want down to the district (Moka's 籍贯 is a 省 → 市 → 区县 cascade)
  for (const f of facts.filter((x) => x.kind === "basic" && ["籍贯", "现居地"].includes(normLabel(x.data.field ?? "")))) {
    if (!/(区|县|旗)$/.test((f.data.value ?? "").trim())) gaps.push({ kind: "basic", field: `${f.data.field}：写到区县`, hint: `现在是「${f.data.value}」，有的表单要选到区县，如 湖南省岳阳市岳阳楼区`, asked: 0, factId: f.id });
  }
  // records that exist but lack what forms need
  for (const f of facts.filter((x) => ["education", "experience", "project"].includes(x.kind))) {
    if (!f.data.period) gaps.push({ kind: f.kind as Gap["kind"], field: `${f.data.school ?? f.data.org ?? f.data.title}：起止时间`, hint: "如 2021.09—2027.06（至今写「至今」）", asked: 0, factId: f.id });
  }
  const edu = facts.filter((x) => x.kind === "education");
  const degrees = edu.map((x) => x.data.degree ?? "");
  // 直博: the PhD starts within half a year of the bachelor's ending — there is no master's to add
  const ym = (s: string, end: boolean) => { const m = (s ?? "").match(/(\d{4})\D{0,2}(\d{1,2})?\D+?(\d{4})\D{0,2}(\d{1,2})?/); return m ? (end ? Number(m[3]) * 12 + Number(m[4] ?? 6) : Number(m[1]) * 12 + Number(m[2] ?? 9)) : NaN; };
  const bachelor = edu.find((x) => /本科|学士/.test(x.data.degree ?? "")), phd = edu.find((x) => /博士/.test(x.data.degree ?? ""));
  const direct = !!bachelor && !!phd && ym(phd.data.period, false) - ym(bachelor.data.period, true) <= 6;
  if (phd && !direct && !degrees.some((d) => /硕士/.test(d))) gaps.push({ kind: "education", field: "硕士阶段的教育经历", hint: "表单的「教育背景」一般要从本科写起；直博的话把本科和博士的起止时间写上就不再提示", asked: 0 });
  if (degrees.length && !degrees.some((d) => /本科|学士/.test(d))) gaps.push({ kind: "education", field: "本科阶段的教育经历", hint: "表单的「教育背景」一般要从本科写起", asked: 0 });
  return { items: gaps };
}
