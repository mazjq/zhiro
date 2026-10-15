import { ulid } from "ulid";
import type { Db } from "../db.js";
import { json, now, tx } from "../db.js";
import { DomainError, NotFound } from "./domain.js";
import { HARD_FIELDS } from "./expectations.js";

type Data = Record<string, string>;
const norm = (s: string) => (s ?? "").normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Structured fact cards (ADR-014). Each kind names its required fields and the identity used for dedup:
 * the same paper seen in a resume and in its PDF lands on one card with two sources.
 */
export const FACT_KINDS: Record<string, { label: string; required: string[]; key: (d: Data) => string }> = {
  basic: { label: "基本信息", required: ["field", "value"], key: (d) => d.field },
  education: { label: "教育", required: ["school", "degree", "major"], key: (d) => d.school + "|" + d.degree },
  direction: { label: "方向关键词", required: ["keyword"], key: (d) => d.keyword },
  exclude: { label: "排除词", required: ["keyword"], key: (d) => d.keyword },
  preference: { label: "期望", required: ["field", "value"], key: (d) => d.field }, // one card per field; values on it are OR (ADR-036)
  publication: { label: "论文", required: ["title"], key: (d) => d.title },
  patent: { label: "专利", required: ["title"], key: (d) => d.number || d.title },
  award: { label: "奖项", required: ["title"], key: (d) => d.title + "|" + (d.year ?? "") },
  project: { label: "项目", required: ["title"], key: (d) => d.title },
  experience: { label: "经历", required: ["org", "role"], key: (d) => d.org + "|" + d.role },
  skill: { label: "技能", required: ["name"], key: (d) => d.name },
};

export interface FactInput { id?: string; kind: string; data: Data; grade?: string; statement?: string; source?: { documentId?: string; quote?: string; locator?: string } }

function row(db: Db, r: any) {
  const sources = (db.prepare("select s.document_id, s.quote, s.locator, d.path from fact_source s left join document d on d.id = s.document_id where s.fact_id = ?").all(r.id) as any[])
    .map((s) => ({ documentId: (s.document_id ?? "") as string, documentName: (s.path ?? "") as string, quote: s.quote as string, locator: s.locator as string }));
  return { id: r.id as string, kind: r.kind as string, data: json.parse(r.data_json, {} as Data), statement: r.statement as string, grade: r.grade as string, sources };
}

/** The user's own order for a list of cards (drag and drop on the 画像 page); cards not listed keep their place after these. */
export function reorderFacts(db: Db, ids: string[]) {
  tx(db, () => ids.forEach((id, i) => db.prepare("update fact set sort = ? where id = ?").run(i + 1, id)));
  return { ok: true };
}

export function listFacts(db: Db, q: { kind?: string; query?: string } = {}) {
  const where: string[] = [], args: string[] = [];
  if (q.kind) { where.push("kind = ?"); args.push(q.kind); }
  if (q.query) { where.push("(statement like ? or data_json like ?)"); args.push(`%${q.query}%`, `%${q.query}%`); }
  const rows = db.prepare(`select * from fact ${where.length ? "where " + where.join(" and ") : ""} order by kind, sort, created_at`).all(...args) as any[];
  return { items: rows.map((r) => row(db, r)) };
}

/**
 * With `id`: a human edit, replaces the card. Without: upsert by (kind, dedup key) — an existing card keeps its
 * values and only gains missing fields plus the new source, so a sloppier document can't degrade a confirmed card.
 */
export function upsertFact(db: Db, p: FactInput, defaultGrade: string) {
  const def = FACT_KINDS[p.kind];
  if (!def) throw new DomainError("BAD_KIND", `kind must be one of ${Object.keys(FACT_KINDS).join("/")}`);
  const data: Data = Object.fromEntries(Object.entries(p.data ?? {}).map(([k, v]) => [k, String(v ?? "").trim()]).filter(([, v]) => v));
  const missing = def.required.filter((f) => !data[f]);
  if (missing.length) throw new DomainError("MISSING_FIELD", `${p.kind} 缺少 ${missing.join("、")}`);
  if (p.kind === "preference" && data.mode === "硬性" && !HARD_FIELDS.includes(data.field)) throw new DomainError("BAD_MODE", `只有 ${HARD_FIELDS.join(" / ")} 可以设硬性`);
  const key = norm(def.key(data));
  const t = now();
  return tx(db, () => {
    const existing = (p.id ? db.prepare("select * from fact where id = ?").get(p.id) : db.prepare("select * from fact where kind = ? and dedup_key = ?").get(p.kind, key)) as any;
    if (p.id && !existing) throw new NotFound(`fact ${p.id}`);
    if (p.id && db.prepare("select 1 from fact where kind = ? and dedup_key = ? and id != ?").get(p.kind, key, p.id)) throw new DomainError("DUPLICATE", "已有同一条事实卡");
    let id: string;
    if (existing) {
      id = existing.id;
      const merged = p.id ? data : { ...data, ...json.parse(existing.data_json, {} as Data) };
      db.prepare("update fact set data_json = ?, statement = ?, grade = ?, dedup_key = ?, updated_at = ? where id = ?")
        .run(json.str(merged), p.statement || (p.id ? Object.values(merged).join(" · ") : existing.statement), p.grade ?? existing.grade, p.id ? key : existing.dedup_key, t, id);
    } else {
      id = ulid();
      db.prepare("insert into fact(id, kind, data_json, statement, grade, dedup_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)")
        .run(id, p.kind, json.str(data), p.statement || Object.values(data).join(" · "), p.grade ?? defaultGrade, key, t, t);
    }
    if (p.source && (p.source.documentId || p.source.quote)) {
      db.prepare("insert into fact_source(id, fact_id, document_id, quote, locator, added_at) values (?,?,?,?,?,?)")
        .run(ulid(), id, p.source.documentId || null, p.source.quote ?? "", p.source.locator ?? "", t);
    }
    return { fact: row(db, db.prepare("select * from fact where id = ?").get(id)), created: !existing };
  });
}

const TRASH_KEEP = 10;

/** What a confirm card that deletes cards shows for each: 「字段：值」 or the card's own statement. Gone cards are left out. */
export function factLabels(db: Db, ids: string[]): string[] {
  return ids.flatMap((id) => {
    const r = db.prepare("select data_json, statement from fact where id = ?").get(id) as any;
    if (!r) return [];
    const d = json.parse(r.data_json, {} as Record<string, string>);
    return [d.field ? `${d.field}：${d.value ?? ""}` : r.statement || Object.values(d).filter(Boolean).join(" · ").slice(0, 60)];
  });
}

/** Deleting moves the card (with its sources) to 最近删除; only the newest TRASH_KEEP are kept. */
export function removeFact(db: Db, id: string) {
  const r = db.prepare("select * from fact where id = ?").get(id) as any;
  if (!r) throw new NotFound(`fact ${id}`);
  return tx(db, () => {
    const sources = db.prepare("select * from fact_source where fact_id = ?").all(id);
    db.prepare("insert or replace into fact_trash(id, fact_json, sources_json, deleted_at) values (?,?,?,?)").run(id, json.str(r), json.str(sources), now());
    db.prepare("delete from fact where id = ?").run(id);
    db.prepare("delete from fact_trash where id not in (select id from fact_trash order by deleted_at desc limit ?)").run(TRASH_KEEP);
    return { ok: true };
  });
}

export function listTrash(db: Db) {
  const rows = db.prepare("select * from fact_trash order by deleted_at desc").all() as any[];
  return { items: rows.map((t) => { const f = json.parse(t.fact_json, {} as any); return { id: t.id as string, kind: f.kind as string, statement: f.statement as string, grade: f.grade as string, deletedAt: t.deleted_at as string }; }) };
}

export function restoreFact(db: Db, id: string) {
  const t = db.prepare("select * from fact_trash where id = ?").get(id) as any;
  if (!t) throw new NotFound(`deleted fact ${id}`);
  const f = json.parse(t.fact_json, {} as any);
  if (db.prepare("select 1 from fact where kind = ? and dedup_key = ?").get(f.kind, f.dedup_key)) throw new DomainError("DUPLICATE", "现在已经有同一条事实卡了，不需要恢复");
  return tx(db, () => {
    db.prepare("insert into fact(id, kind, data_json, statement, grade, dedup_key, created_at, updated_at) values (?,?,?,?,?,?,?,?)").run(f.id, f.kind, f.data_json, f.statement, f.grade, f.dedup_key, f.created_at, now());
    for (const s of json.parse(t.sources_json, [] as any[])) db.prepare("insert into fact_source(id, fact_id, document_id, quote, locator, added_at) values (?,?,?,?,?,?)").run(s.id, s.fact_id, s.document_id, s.quote, s.locator, s.added_at);
    db.prepare("delete from fact_trash where id = ?").run(id);
    return { fact: row(db, db.prepare("select * from fact where id = ?").get(id)) };
  });
}
