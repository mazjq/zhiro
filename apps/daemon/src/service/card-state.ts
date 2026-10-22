/**
 * What a confirm card is now (phase-1 plan P3, B5) — said on the card, decided by the person, never guessed by
 * running it. A card's own decision stays as it is (pending / approved / rejected / expired, and execution); this is
 * the view the 今日 page sorts by:
 *   已完成 — what it asks is already so (the application is in that state, the stage is there, the cards are gone);
 *   已过时 — it no longer stands (the application closed, the test passed, what it is about is gone);
 *   需补救 — its time ran out but it still stands: it can be raised again (a new card, checked again), never approved as it was;
 *   待处理 — the rest.
 * One rule per kind of card this phase raises; anything else is 待处理 until it expires, then 需补救.
 */
import type { Db } from "../db.js";

export type CardState = "待处理" | "已完成" | "已过时" | "需补救";
export interface CardView { state: CardState; why: string }
interface Card { kind: string; payload: any; expiresAt: string; execution?: string }

const APP_FIELDS: [string, string][] = [["state", "state"], ["closeReason", "close_reason"], ["nextAction", "next_action"], ["nextActionAt", "next_action_at"], ["submittedAt", "submitted_at"], ["resumeLabel", "resume_label"], ["externalAppId", "external_app_id"], ["progressUrl", "progress_url"]];
const STAGE_FIELDS: [string, string][] = [["scheduledAt", "scheduled_at"], ["result", "result"], ["link", "link"], ["location", "location"], ["notes", "notes"]];
const equalWhereGiven = (p: any, row: any, fields: [string, string][]) => fields.every(([k, col]) => p[k] === undefined || String(p[k] ?? "") === String(row[col] ?? ""));

export function cardView(db: Db, c: Card, cfg: { referenceDoc?: string } = {}, now = Date.now()): CardView {
  const p = c.payload ?? {};
  if (c.execution === "running") return { state: "待处理", why: "正在执行" };
  // a run that stopped half way may have done part of it: the person checks first, it is never folded or raised again blind
  if (c.execution === "interrupted") return { state: "待处理", why: "上次执行中途停了，可能已做了一部分：先核对再确认" };
  let done = false, gone = "", why = "";
  switch (c.kind) {
    case "application.update": {
      // an ended application still takes corrections and reopening: only what it asks decides
      const a = db.prepare("select * from application where id = ?").get(p.id) as any;
      if (!a) { gone = "这条申请已经不在了"; break; }
      done = equalWhereGiven(p, a, APP_FIELDS) && (p.state !== undefined || p.nextAction !== undefined || p.closeReason !== undefined);
      break;
    }
    case "stage.add": {
      const a = db.prepare("select state from application where id = ?").get(p.applicationId) as any;
      if (!a) { gone = "这条申请已经不在了"; break; }
      // done only when a stage of that kind already says everything the card asks — a time is needed to tell two apart
      done = !!p.scheduledAt && (db.prepare("select * from stage where application_id = ? and kind = ?").all(p.applicationId, p.kind) as any[]).some((s) => equalWhereGiven(p, s, STAGE_FIELDS));
      // a past stage is history to record (backfill); only one still ahead on an ended application no longer stands
      if (!done && ["closed", "cancelled"].includes(a.state) && p.scheduledAt && Date.parse(p.scheduledAt) > now) gone = "这条申请已经结束了，之后的环节不会有了";
      break;
    }
    case "stage.update": {
      const s = db.prepare("select * from stage where id = ?").get(p.id) as any;
      if (!s) { gone = "这个环节已经不在了"; break; }
      done = equalWhereGiven(p, s, STAGE_FIELDS);
      break;
    }
    case "fact.remove": {
      const ids: string[] = p.ids ?? [p.id];
      done = !ids.some((id) => db.prepare("select 1 from fact where id = ?").get(id));
      break;
    }
    case "fact.merge": {
      // pair by pair: one broken pair does not void the others
      const has = (id: string) => !!db.prepare("select 1 from fact where id = ?").get(id);
      const left = ((p.pairs ?? [p]) as any[]).filter((x) => has(x.fromId));
      const broken = left.filter((x) => !has(x.intoId)).length;
      done = !left.length;
      if (left.length && broken === left.length) gone = "要并入的那张资料卡已经不在了";
      else if (broken) why = `其中 ${broken} 项要并入的资料卡已经不在了，确认前先看一下`;
      break;
    }
    case "company.merge": {
      const from = db.prepare("select 1 from company where id = ?").get(p.fromId), into = db.prepare("select 1 from company where id = ?").get(p.intoId);
      done = !from && !!into;
      if (!into) gone = "要并入的公司已经不在了";
      // a merge suggestion is void once it runs out: with new evidence the tidying raises it again (contract: 过期的自动作废)
      else if (!done && Date.parse(c.expiresAt) < now) gone = "合并建议过期就作废，有新证据会重新提出";
      break;
    }
    case "apply.reference":
      done = !!cfg.referenceDoc && cfg.referenceDoc === p.path;
      break;
  }
  if (done) return { state: "已完成", why: "要做的事已经是这样了" };
  if (gone) return { state: "已过时", why: gone };
  if (Date.parse(c.expiresAt) < now) return { state: "需补救", why: why || "确认卡过期了，但这件事还有用：可以重新提出再确认" };
  return { state: "待处理", why };
}

/** The views of the pending cards, and how many of each. */
export function cardViews(db: Db, cards: (Card & { id: string })[], cfg: { referenceDoc?: string } = {}) {
  const views = new Map(cards.map((c) => [c.id, cardView(db, c, cfg)]));
  return { views, counts: [...views.values()].reduce((m, v) => ({ ...m, [v.state]: (m[v.state] ?? 0) + 1 }), {} as Record<string, number>) };
}
