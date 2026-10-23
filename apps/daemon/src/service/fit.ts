import { isAggregate } from "../data/index.js";
import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import type { Services } from "../services.js";
import { json, now } from "../db.js";
import { sha } from "./domain.js";
import { listFacts } from "./profile.js";
import { withPurpose } from "./usage.js";

/**
 * 岗位适配度, layer 2 (ADR-034): the model reads one post's requirements against the profile, item by item, and says
 * what is met and what is missing. Only on request, over a short list (the rule layer's 强匹配/可考虑, or what the user
 * picks) — ~1–2k tokens a post. Results live in position_fit with the profile hash they were made against, so a later
 * profile change shows them as stale instead of silently trusting them. One post at a time in the background; in the
 * external-agent mode (ADR-032) a post waits until the agent has answered and is retried.
 */
const SYSTEM = `你是校招岗位匹配评估员。给你一位应届生的画像和一个岗位，逐条对照岗位的硬性要求（学历、专业、技能、经验、证书、地点）和工作内容，判断他能不能投、合不合适。
只依据给出的内容，不要编造画像里没有的经历；岗位没写的要求不算缺口。
只输出 JSON：{"score": 0-100 的整数, "verdict": "一句话结论（20 字内）", "meets": ["满足的要求，每条带画像里的依据"], "gaps": ["不满足或存疑的要求，每条写明差在哪"]}
打分：硬性要求有明确不满足的不超过 40；硬性要求都满足且工作内容与其方向/研究/项目直接相关 80 以上；满足但方向只部分相关 55–79。`;

export function profileText(s: Services): string {
  return listFacts(s.domain.db).items.filter((f: any) => f.kind !== "exclude")
    .map((f: any) => `- ${f.kind}：${f.statement || Object.values(f.data ?? {}).join(" / ")}`).join("\n");
}

function postText(s: Services, positionId: string): string | null {
  const p = s.domain.db.prepare(`select p.title, p.jd_text, p.degree_req, p.major_req, p.cities, c.degree_req c_degree, c.major_req c_major, c.cities c_cities, c.source_kind, co.name, co.type
    from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id where p.id = ?`).get(positionId) as any;
  if (!p) return null;
  const agg = isAggregate(p.source_kind);
  return `公司：${p.name}（${p.type || "类型未知"}）\n岗位：${p.title}\n地点：${json.parse(p.cities, [] as string[]).join("、") || json.parse(p.c_cities, [] as string[]).join("、") || "未写"}\n学历要求：${p.degree_req || p.c_degree || "未写"}\n专业要求：${p.major_req || (agg ? p.c_major : "") || "未写"}\nJD：\n${(p.jd_text || "（来源没有提供 JD 正文，只能按岗位名判断）").slice(0, 5000)}`;
}

export async function deepFit(s: Services, positionId: string) {
  if (!s.llm) throw new Error("没有配置模型");
  const post = postText(s, positionId);
  if (!post) return null;
  const profile = profileText(s);
  const msg = await withPurpose("fit.deep", positionId, () => s.llm!.models.completeSimple(s.llm!.model(), { systemPrompt: SYSTEM, messages: [{ role: "user", content: [{ type: "text", text: `## 画像\n${profile}\n\n## 岗位\n${post}` }], timestamp: Date.now() }] }, { reasoning: "low" }));
  const o = parseJsonWithRepair<any>(contentText(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, ""));
  const list = (v: unknown) => (Array.isArray(v) ? v.map(String).slice(0, 10) : []);
  const score = Math.max(0, Math.min(100, Math.round(Number(o.score) || 0)));
  s.domain.db.prepare(`insert into position_fit(position_id, score, verdict, meets, gaps, model, profile_hash, created_at) values (?,?,?,?,?,?,?,?)
    on conflict(position_id) do update set score = excluded.score, verdict = excluded.verdict, meets = excluded.meets, gaps = excluded.gaps, model = excluded.model, profile_hash = excluded.profile_hash, created_at = excluded.created_at`)
    .run(positionId, score, String(o.verdict ?? "").slice(0, 60), json.str(list(o.meets)), json.str(list(o.gaps)), String((s.llm.model() as any)?.id ?? ""), sha(profile), now());
  return score;
}

// ponytail: an in-process queue — lost on restart (the user clicks again); a table-backed queue if runs get long
const queue: string[] = [];
const failed = new Map<string, string>();
let running = false;

export function enqueueFit(s: Services, ids: string[], opts: { force?: boolean } = {}) {
  const hash = sha(profileText(s));
  const fresh = new Set((s.domain.db.prepare(`select position_id from position_fit where profile_hash = ?`).all(hash) as { position_id: string }[]).map((r) => r.position_id));
  const todo = ids.filter((id) => (opts.force || !fresh.has(id)) && !queue.includes(id));
  queue.push(...todo);
  for (const id of todo) failed.delete(id);
  void drain(s);
  return { queued: todo.length, alreadyDone: opts.force ? 0 : ids.filter((id) => fresh.has(id)).length, pending: queue.length };
}

async function drain(s: Services) {
  if (running) return;
  running = true;
  try {
    let waits = 0;
    while (queue.length) {
      const id = queue[0];
      try { await deepFit(s, id); queue.shift(); s.onDataChanged?.(); }
      catch (e: any) {
        if (e?.code === "MODEL_DELEGATED" && waits < 60) { waits++; await new Promise((r) => setTimeout(r, 60_000)); continue; } // the agent answers later
        failed.set(id, String(e?.message ?? e).slice(0, 200)); queue.shift();
      }
    }
  } finally { running = false; }
}

export function listFit(s: Services, q: { positionIds?: string[]; companyId?: string }) {
  const hash = sha(profileText(s));
  const rows = (q.companyId
    ? s.domain.db.prepare(`select f.* from position_fit f join position p on p.id = f.position_id join campaign c on c.id = p.campaign_id where c.company_id = ?`).all(q.companyId)
    : s.domain.db.prepare(`select * from position_fit where position_id in (${(q.positionIds ?? []).map(() => "?").join(",") || "''"})`).all(...(q.positionIds ?? []))) as any[];
  return {
    items: rows.map((r) => ({ positionId: r.position_id, score: r.score, verdict: r.verdict, meets: json.parse(r.meets, [] as string[]), gaps: json.parse(r.gaps, [] as string[]), model: r.model, at: r.created_at, stale: r.profile_hash !== hash })),
    pending: [...queue], failed: Object.fromEntries(failed),
  };
}
