import { ulid } from "ulid";
import type { Services } from "../services.js";
import { json, now, tx } from "../db.js";
import { DomainError, NotFound } from "../service/domain.js";
import { terms, loadContext, type Candidate } from "./common.js";

/**
 * 搜索模式: a named search the user builds and keeps. Unlike the wide 画像匹配 it says exactly what it means:
 *   must    — AND: every term has to appear (title or JD)      → "only jobs that are really mine"
 *   any     — OR: at least one has to appear; each hit scores   → "don't miss what I could apply to"
 *   exclude — NOT: a title containing any of these is dropped
 *   cities  — soft: a match adds a point, never filters
 * Each preset owns one tag (its name), so its results stack with the other tags on the company row and clicking the
 * chip ranks by this preset alone.
 */
export interface PresetParams { must: string[]; any: string[]; exclude: string[]; cities: string[] }
export interface Preset extends PresetParams { id: string; name: string }

const clean = (p: Partial<PresetParams>): PresetParams => ({ must: terms(p.must ?? []), any: terms(p.any ?? []), exclude: terms(p.exclude ?? []), cities: terms(p.cities ?? []) });
const row = (r: any): Preset => ({ id: r.id, name: r.name, ...clean(json.parse(r.params_json, {} as PresetParams)) });

export function matchPreset(c: Candidate, p: PresetParams): { score: number; reason: string } | null {
  if (p.exclude.some((x) => c.title.includes(x))) return null;
  const text = c.title + "\n" + c.jd;
  if (!p.must.every((m) => text.includes(m))) return null;
  const anyTitle = p.any.filter((k) => c.title.includes(k));
  const anyJd = p.any.filter((k) => !c.title.includes(k) && c.jd.includes(k));
  if (p.any.length && !anyTitle.length && !anyJd.length) return null;
  const mustTitle = p.must.filter((m) => c.title.includes(m));
  const city = p.cities.filter((x) => c.where.includes(x));
  const score = 3 * anyTitle.length + Math.min(anyJd.length, 3) + 2 * mustTitle.length + (p.must.length - mustTitle.length) + (city.length ? 1 : 0);
  const reason = [p.must.length && `必含 ${p.must.join("+")}`, anyTitle.length && `标题命中 ${anyTitle.join("/")}`, anyJd.length && `JD 提到 ${anyJd.join("/")}`, city.length && `城市 ${city.join("/")}`].filter(Boolean).join("；");
  return { score, reason };
}

export function listPresets(s: Services): Preset[] {
  return (s.domain.db.prepare("select * from recommend_preset order by created_at").all() as any[]).map(row);
}

export function runPreset(s: Services, preset: Preset, ctx = loadContext(s)) {
  const db = s.domain.db, mode = `preset:${preset.id}`, t = now(), runId = ulid();
  const hits = ctx.candidates.flatMap((c) => { const m = matchPreset(c, preset); return m ? [{ c, ...m }] : []; });
  tx(db, () => {
    db.prepare("delete from recommendation where mode = ?").run(mode);
    const ins = db.prepare("insert or ignore into recommendation(id, company_id, position_id, mode, tag, score, reason, run_id, created_at) values (?,?,?,?,?,?,?,?,?)");
    for (const h of hits) ins.run(ulid(), h.c.companyId, h.c.id, mode, preset.name, h.score, h.reason, runId, t);
  });
  return { hits: hits.length, companies: new Set(hits.map((h) => h.c.companyId)).size };
}

export function savePreset(s: Services, p: { id?: string; name: string } & Partial<PresetParams>) {
  const name = p.name.trim(), params = clean(p), db = s.domain.db, t = now();
  if (!name) throw new DomainError("MISSING_FIELD", "搜索模式需要一个名字");
  if (!params.must.length && !params.any.length) throw new DomainError("MISSING_FIELD", "至少填一个「必须含」或「任一」关键词");
  if (db.prepare("select 1 from recommend_preset where name = ? and id != ?").get(name, p.id ?? "")) throw new DomainError("DUPLICATE", `已有叫「${name}」的搜索模式`);
  const id = p.id ?? ulid();
  if (p.id) { if (db.prepare("update recommend_preset set name = ?, params_json = ?, updated_at = ? where id = ?").run(name, json.str(params), t, id).changes === 0) throw new NotFound(`preset ${id}`); }
  else db.prepare("insert into recommend_preset(id, name, params_json, created_at, updated_at) values (?,?,?,?,?)").run(id, name, json.str(params), t, t);
  const preset = { id, name, ...params };
  return { preset, ...runPreset(s, preset) };
}

export function removePreset(s: Services, id: string) {
  tx(s.domain.db, () => {
    s.domain.db.prepare("delete from recommendation where mode = ?").run(`preset:${id}`);
    if (s.domain.db.prepare("delete from recommend_preset where id = ?").run(id).changes === 0) throw new NotFound(`preset ${id}`);
  });
  return { ok: true };
}

// ponytail: fixed vocabularies instead of word segmentation; add terms here when a field's jargon is missing
const ROLE_WORDS = ["实习", "销售", "市场", "营销", "运营", "客服", "行政", "财务", "会计", "人力", "采购", "质量", "测试", "生产", "工艺", "售前", "售后", "法务", "管培", "储备干部", "文案", "产品经理", "项目管理", "商务", "物流", "仓储", "安全员", "施工", "前端", "后端", "java", "运维", "硬件", "结构", "机械", "电气", "土建", "化工", "材料", "外贸", "翻译", "审计"];
const TOPIC_WORDS = ["算法", "控制", "运动控制", "伺服", "电机", "机器人", "机械臂", "导航", "规划", "感知", "slam", "定位", "仿真", "建模", "嵌入式", "自动驾驶", "智能驾驶", "底盘", "无人机", "飞控", "船舶", "海洋", "航天", "制导", "强化学习", "具身", "优化", "mpc", "plc", "dsp", "fpga", "simulink", "matlab", "c++", "python", "ros", "电力电子", "新能源", "储能", "数控", "视觉", "研究员", "博士"];

/** Words that actually occur in the titles a mode currently returns — so the user refines with evidence, not guesses. */
export function suggestTerms(s: Services, mode: string, inUse: string[]) {
  const titles = (s.domain.db.prepare("select lower(p.title) as t from recommendation r join position p on p.id = r.position_id where r.mode = ?").all(mode) as any[]).map((r) => r.t as string);
  const used = new Set(terms(inUse));
  const count = (words: string[]) => words.filter((w) => !used.has(w)).map((word) => ({ word, count: titles.filter((t) => t.includes(word)).length })).filter((x) => x.count > 0).sort((a, b) => b.count - a.count).slice(0, 14);
  return { total: titles.length, exclude: count(ROLE_WORDS), include: count(TOPIC_WORDS) };
}
