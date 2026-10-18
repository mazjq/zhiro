import { poolUnrelatedWrite, deadlineBoard } from "./pool.js";
import { NotFound, DomainError } from "./errors.js";
import { loadContext as loadDeadlines, campaignSaying, expiredMany, localDay, type PostRow } from "./deadlines.js";
import { ulid } from "ulid";
import { genericCompany, companyKey, sha, upsertCompany, upsertCampaign, upsertPosition, type CampaignInput, type PositionExtra } from "../data/index.js";
import type { Db } from "../db.js";
import { json, now, tx } from "../db.js";
import type { Static } from "@zhiro/contracts";
import { Application, Campaign, Position, Proposal, Stage } from "@zhiro/contracts";

type CampaignT = Static<typeof Campaign>;
type PositionT = Static<typeof Position>;
type ApplicationT = Static<typeof Application>;
type StageT = Static<typeof Stage>;
type ProposalT = Static<typeof Proposal>;

export { NotFound, DomainError };

// ADR-023. Before submitting, the user can drop out and come back freely (draft ⇄ cancelled). Once submitted, the
// application is a fact about the world: it can only move forward and end; closed → in_process exists to undo a mis-click.
const ALLOWED: Record<string, string[]> = {
  draft: ["submitted", "cancelled"],
  cancelled: ["draft"],
  submitted: ["in_process", "closed"],
  in_process: ["in_process", "closed"],
  closed: ["in_process"],
};

// who a company, a campaign and a post are is decided in the data layer (data/catalog.ts); the methods below call it
export { genericCompany, companyKey, sha };

// ---------- mappers ----------
function campaignRow(r: any): CampaignT {
  return {
    id: r.id, companyId: r.company_id, companyName: r.company_name ?? "", kind: r.kind, cohort: r.cohort, batch: r.batch,
    cities: json.parse(r.cities, []), degreeReq: r.degree_req, majorReq: r.major_req, opensAt: r.opens_at, closesAt: r.closes_at,
    deadlineKind: r.deadline_kind, deadlineText: r.deadline_text, applyUrl: r.apply_url, noticeUrl: r.notice_url,
    sourceGrade: r.source_grade, sourceKind: r.source_kind, hasWrittenTest: r.has_written_test, notes: r.notes,
    lastVerifiedAt: r.last_verified_at, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function positionRow(r: any): PositionT & { companyName: string; closesAt: string | null; deadlineKind: any; applyUrl: string; noticeUrl: string; applicationState: string | null } {
  return {
    id: r.id, campaignId: r.campaign_id, title: r.title, jdText: r.jd_text, cities: json.parse(r.cities, []), degreeReq: r.degree_req, majorReq: r.major_req || r.campaign_major_req || "",
    status: r.status, directionTags: json.parse(r.direction_tags, []), lastSeenAt: r.last_seen_at, watchPriority: r.watch_priority,
    companyName: r.company_name ?? "", closesAt: r.closes_at ?? null, deadlineKind: r.deadline_kind ?? "unknown",
    applyUrl: r.apply_url ?? "", noticeUrl: r.notice_url ?? "", applicationState: r.app_state ?? null,
  };
}
function applicationRow(r: any): ApplicationT {
  return {
    id: r.id, positionId: r.position_id, campaignId: r.campaign_id, state: r.state, closeReason: r.close_reason, channel: r.channel,
    externalAppId: r.external_app_id, referralCode: r.referral_code, resumeLabel: r.resume_label ?? "", submittedAt: r.submitted_at, nextAction: r.next_action,
    nextActionAt: r.next_action_at, progressUrl: r.progress_url ?? "", createdAt: r.created_at, updatedAt: r.updated_at,
  };
}
function stageRow(r: any): StageT {
  return { id: r.id, applicationId: r.application_id, kind: r.kind, scheduledAt: r.scheduled_at, location: r.location, link: r.link, result: r.result, notes: r.notes };
}
function proposalRow(r: any): ProposalT {
  return { id: r.id, kind: r.kind, payload: json.parse(r.payload_json, null), payloadHash: r.payload_hash, createdBy: r.created_by, reason: r.reason, decision: r.decision, expiresAt: r.expires_at, createdAt: r.created_at,
    ...(r.execution ? { execution: r.execution, executionStartedAt: r.execution_started_at } : {}) };
}

/** Said with a failed card whose work answers later: a sync executor's writes roll back with it, this kind's do not. */
const NOT_UNDONE = "（如果已经做了一部分，那部分不会撤回，请核对后再点）";

/** A campaign the user cares about: its company carries a recommendation tag, or one of its jobs is watched or applied to. */
export const RELEVANT_CAMPAIGN = `(exists (select 1 from recommendation r where r.company_id = c.company_id)
  or exists (select 1 from position p where p.campaign_id = c.id and p.watch_priority > 0)
  or exists (select 1 from application a where a.campaign_id = c.id and a.state != 'cancelled'))`;

const CAMPAIGN_SELECT = "select c.*, co.name as company_name from campaign c join company co on co.id = c.company_id";

export class Domain {
  constructor(public db: Db) {
    // backfill the `norm` column (SQL can't NFKC); no-op once filled. Companies that turn out to share a key are the
    // same employer written twice ("DJI 大疆" / "DJI大疆"): fold the newer into the older.
    const blank = db.prepare("select id, name from company where norm = ''").all() as any[];
    for (const r of blank) db.prepare("update company set norm = ? where id = ?").run(companyKey(r.name), r.id);
    if (blank.length) for (const g of db.prepare("select norm from company group by norm having count(*) > 1").all() as any[]) {
      const [keep, ...rest] = db.prepare("select id from company where norm = ? order by created_at, id").all(g.norm) as any[];
      for (const r of rest) this.mergeCompany(r.id, keep.id);
    }
  }

  // ---------- company / campaign / position ----------
  upsertCompany(name: string, type = "", industry = ""): string { return upsertCompany(this.db, name, type, industry); }

  /** Fold `fromId` into `intoId`: campaigns and tags move, the old name becomes an alias so later scans land on the survivor. */
  mergeCompany(fromId: string, intoId: string): { ok: boolean; movedCampaigns: number } {
    if (fromId === intoId) throw new DomainError("SAME_COMPANY");
    const from = this.db.prepare("select * from company where id = ?").get(fromId) as any;
    const into = this.db.prepare("select * from company where id = ?").get(intoId) as any;
    if (!from || !into) throw new NotFound(`company ${from ? intoId : fromId}`);
    return tx(this.db, () => {
      const aliases = Array.from(new Set([...json.parse(into.aliases, [] as string[]), from.name, ...json.parse(from.aliases, [] as string[])]));
      const moved = this.db.prepare("update campaign set company_id = ? where company_id = ?").run(intoId, fromId).changes as number;
      this.db.prepare("update or ignore recommendation set company_id = ? where company_id = ?").run(intoId, fromId);
      this.db.prepare("delete from recommendation where company_id = ?").run(fromId);
      this.db.prepare("update or ignore company_intel set company_id = ? where company_id = ?").run(intoId, fromId);
      this.db.prepare("delete from company_intel where company_id = ?").run(fromId);
      this.db.prepare("update company set aliases = ? where id = ?").run(json.str(aliases), intoId);
      this.db.prepare("delete from company where id = ?").run(fromId);
      return { ok: true, movedCampaigns: moved };
    });
  }

  upsertCampaign(c: CampaignInput): { id: string; created: boolean } { return upsertCampaign(this.db, c); }
  upsertPosition(campaignId: string, title: string, extra: PositionExtra = {}): { id: string; created: boolean } { return upsertPosition(this.db, campaignId, title, extra); }

  listCampaigns(q: { deadlineWithinDays?: number; city?: string; grade?: string; query?: string; limit?: number }): { items: CampaignT[]; total: number } {
    const where: string[] = [];
    const args: unknown[] = [];
    // the local day, as everywhere (SQLite's date('now') is UTC: a day off around midnight)
    const today = localDay();
    if (q.deadlineWithinDays != null) {
      const until = new Date(); until.setDate(until.getDate() + Math.floor(q.deadlineWithinDays));
      where.push("c.closes_at is not null and c.closes_at >= ? and c.closes_at <= ?");
      args.push(today, localDay(until));
    }
    if (q.city) { where.push("c.cities like ?"); args.push(`%${q.city}%`); }
    if (q.grade) { where.push("c.source_grade = ?"); args.push(q.grade); }
    // several words (公司 + 岗位): each must match somewhere
    for (const word of (q.query ?? "").split(/\s+/).filter(Boolean)) {
      where.push("(co.name like ? or c.major_req like ? or c.batch like ? or exists (select 1 from position p where p.campaign_id = c.id and p.title like ?))");
      const like = `%${word}%`;
      args.push(like, like, like, like);
    }
    const sql = `${CAMPAIGN_SELECT} ${where.length ? "where " + where.join(" and ") : ""} order by case when c.closes_at >= ? then 0 when c.closes_at is null then 1 else 2 end, c.closes_at asc, c.updated_at desc`; // open deadlines first, then unknown, expired last
    const rows = this.db.prepare(sql).all(...(args as any[]), today) as any[];
    const items = rows.slice(0, q.limit ?? 50).map(campaignRow);
    if (!items.length) return { items, total: rows.length };
    // closesAt and the rest stay what the source said; `deadline` is what the batch goes by (the person's word first, ADR-041)
    const ctx = loadDeadlines(this.db, [...new Set(items.map((c) => c.companyId))]);
    return { items: items.map((c) => ({ ...c, deadline: campaignSaying(ctx, c.id) })), total: rows.length };
  }

  getCampaign(id: string) {
    const row = this.db.prepare(`${CAMPAIGN_SELECT} where c.id = ?`).get(id) as any;
    if (!row) throw new NotFound(`campaign ${id}`);
    const positions = (this.db.prepare("select * from position where campaign_id = ? order by title").all(id) as any[]).map(positionRow);
    const applications = (this.db.prepare("select * from application where campaign_id = ?").all(id) as any[]).map(applicationRow);
    return { campaign: campaignRow(row), positions, applications };
  }

  listPositions(q: { campaignId?: string; companyId?: string; query?: string; major?: string; degree?: string; city?: string; watchedOnly?: boolean; includeExpired?: boolean; internship?: boolean; limit?: number }) {
    const where: string[] = [];
    const args: unknown[] = [];
    if (q.campaignId) { where.push("p.campaign_id = ?"); args.push(q.campaignId); }
    if (q.companyId) { where.push("c.company_id = ?"); args.push(q.companyId); }
    if (q.watchedOnly) where.push("p.watch_priority is not null and p.watch_priority > 0");
    // 实习: the post says so in its name, or its source files the whole batch as one (a sheet's 「实习」 row, a page read as 实习)
    if (q.internship) where.push("(p.title like '%实习%' or lower(p.title) like '%intern%' or c.kind = '实习' or c.batch like '%实习%')");
    for (const word of (q.query ?? "").split(/\s+/).filter(Boolean)) { where.push("(p.title like ? or co.name like ?)"); args.push(`%${word}%`, `%${word}%`); }
    // the post's own requirement, else its campaign's (国能 states both per post, a sheet only per campaign); several words
    // in one field are alternatives — 「控制科学与工程 自动化」 means either
    const anyOf = (field: string, words: string) => { const ws = words.split(/[\s,，、|]+/).filter(Boolean); if (ws.length) { where.push(`(${ws.map(() => `${field} like ?`).join(" or ")})`); args.push(...ws.map((w) => `%${w}%`)); } };
    anyOf("coalesce(nullif(p.major_req, ''), c.major_req)", q.major ?? "");
    anyOf("coalesce(nullif(p.degree_req, ''), c.degree_req)", q.degree ?? "");
    if (q.city) { where.push("((case when p.cities != '[]' then p.cities else c.cities end) like ?)"); args.push(`%${q.city}%`); }
    where.push("p.status != 'closed'");
    const from = `from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id ${where.length ? "where " + where.join(" and ") : ""} order by c.closes_at is null, c.closes_at asc, co.name`;
    const full = `select p.*, co.name as company_name, c.closes_at, c.deadline_kind, c.apply_url, c.notice_url, c.major_req as campaign_major_req, (select a.state from application a where a.position_id = p.id and a.state != 'cancelled') as app_state`;
    const limit = q.limit ?? 100;
    if (q.includeExpired) return { items: (this.db.prepare(`${full} ${from} limit ?`).all(...(args as any[]), limit) as any[]).map(positionRow) };
    // 在招 = the resolver says it has not passed (ADR-041): the person's word, the post's own day, its batch's, and what
    // is said of the same post elsewhere — as the pool shows it. 国能's 2027 专项 list still carries last year's posts.
    // Walk the matches in order, in growing chunks (each resolves only its own companies), and stop once `limit` are open
    // — reading only as far as that (all 115,000 matches of an unfiltered list made a quarter of a second of rows alone).
    const matches = this.db.prepare(`select p.id, p.campaign_id, p.closes_at, c.company_id ${from}`).iterate(...(args as any[])) as Iterator<PostRow & { company_id: string }>;
    const open: string[] = [];
    try {
      for (let n = Math.max(limit * 3, 300), done = false; !done && open.length < limit; n *= 2) {
        const chunk: (PostRow & { company_id: string })[] = [];
        while (chunk.length < n) { const r = matches.next(); if (r.done) { done = true; break; } chunk.push(r.value); }
        const expired = expiredMany(this.db, chunk);
        for (const p of chunk) if (!expired.get(p.id) && open.length < limit) open.push(p.id);
      }
    } finally { matches.return?.(); }
    const byId = new Map<string, any>();
    for (let i = 0; i < open.length; i += 5000) {
      const part = open.slice(i, i + 5000);
      for (const r of this.db.prepare(`${full} from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id where p.id in (${part.map(() => "?").join(",")})`).all(...part) as any[]) byId.set(r.id, r);
    }
    return { items: open.map((id) => positionRow(byId.get(id))) };
  }

  watchPosition(positionId: string, priority: number, note = ""): void {
    const r = this.db.prepare("update position set watch_priority = ?, watch_note = ?, updated_at = ? where id = ?").run(priority === 0 ? null : priority, note, now(), positionId);
    if (r.changes === 0) throw new NotFound(`position ${positionId}`);
  }

  // ---------- application ----------
  createApplication(positionId: string, channel = "", note = "", source = "manual"): ApplicationT {
    const pos = this.db.prepare("select campaign_id from position where id = ?").get(positionId) as { campaign_id: string } | undefined;
    if (!pos) throw new NotFound(`position ${positionId}`);
    const old = this.db.prepare("select id, state from application where position_id = ?").get(positionId) as { id: string; state: string } | undefined;
    // one application per position: coming back after 不投了 picks the old one up again, timeline and all
    if (old?.state === "cancelled") return this.updateApplication({ id: old.id, state: "draft", closeReason: "", note }, source);
    if (old) throw new DomainError("ALREADY_EXISTS");
    const id = ulid();
    const t = now();
    return tx(this.db, () => {
      this.db.prepare("insert into application(id, position_id, campaign_id, state, channel, created_at, updated_at) values (?,?,?,?,?,?,?)").run(id, positionId, pos.campaign_id, "draft", channel, t, t);
      this.event(id, "created", note, source);
      return this.getApplication(id);
    });
  }

  listApplications(state?: string) {
    const rows = this.db.prepare(`select a.*, p.title, p.cities, p.jd_text, co.name as company_name, c.closes_at, c.apply_url, c.notice_url from application a
      join position p on p.id = a.position_id join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id
      where ${state ? "a.state = ?" : "a.state != 'cancelled'"} order by a.updated_at desc`).all(...(state ? [state] : [])) as any[];
    return {
      items: rows.map((r) => ({
        application: applicationRow(r), companyName: r.company_name as string, title: r.title as string, closesAt: (r.closes_at ?? null) as string | null, applyUrl: r.apply_url as string, noticeUrl: (r.notice_url ?? "") as string, cities: json.parse(r.cities, [] as string[]), jdText: (r.jd_text ?? "") as string,
        stages: (this.db.prepare("select * from stage where application_id = ? order by scheduled_at is null, scheduled_at").all(r.id) as any[]).map(stageRow),
        lastEvent: (this.db.prepare("select at, kind, detail, source from application_event where application_id = ? order by at desc, rowid desc limit 1").get(r.id) ?? null) as { at: string; kind: string; detail: string; source: string } | null,
      })),
    };
  }

  getApplication(id: string): ApplicationT {
    const r = this.db.prepare("select * from application where id = ?").get(id) as any;
    if (!r) throw new NotFound(`application ${id}`);
    return applicationRow(r);
  }

  updateApplication(p: { id: string; state?: string; closeReason?: string; externalAppId?: string; submittedAt?: string; resumeLabel?: string; nextAction?: string; nextActionAt?: string; progressUrl?: string; note?: string }, source = "manual"): ApplicationT {
    const cur = this.getApplication(p.id);
    return tx(this.db, () => {
      if (p.state && p.state !== cur.state) {
        if (!ALLOWED[cur.state]?.includes(p.state)) throw new DomainError("INVALID_TRANSITION", `${cur.state} → ${p.state}`);
        this.event(p.id, "state", `${cur.state} → ${p.state}${p.note ? ": " + p.note : ""}`, source);
      } else if (p.note) this.event(p.id, "note", p.note, source);
      // dropping out also drops the bookmark, so the job leaves 投递 altogether and 找岗位 offers 关注 again; the reason stays on the position
      if (p.state === "cancelled" && cur.state !== "cancelled") this.db.prepare("update position set watch_priority = null, watch_note = ?, updated_at = ? where id = ?").run(`不投了：${p.closeReason ?? ""}`, now(), cur.positionId);
      const submittedAt = p.submittedAt ?? (p.state === "submitted" && !cur.submittedAt ? now() : cur.submittedAt);
      this.db.prepare(`update application set resume_label = ?, state = ?, close_reason = ?, external_app_id = ?, submitted_at = ?, next_action = ?, next_action_at = ?, progress_url = ?, updated_at = ? where id = ?`)
        .run(p.resumeLabel ?? cur.resumeLabel, p.state ?? cur.state, p.closeReason ?? cur.closeReason, p.externalAppId ?? cur.externalAppId, submittedAt, p.nextAction ?? cur.nextAction, p.nextActionAt ?? cur.nextActionAt, p.progressUrl ?? cur.progressUrl ?? "", now(), p.id);
      return this.getApplication(p.id);
    });
  }

  event(applicationId: string, kind: string, detail = "", source = "manual"): void {
    this.db.prepare("insert into application_event(id, application_id, at, kind, detail, source) values (?,?,?,?,?,?)").run(ulid(), applicationId, now(), kind, detail, source);
  }

  timeline(id: string) {
    const application = this.getApplication(id);
    const stages = (this.db.prepare("select * from stage where application_id = ? order by scheduled_at").all(id) as any[]).map(stageRow);
    const events = (this.db.prepare("select at, kind, detail, source from application_event where application_id = ? order by at, rowid").all(id) as any[]);
    return { application, stages, events };
  }

  addStage(p: { applicationId: string; kind: string; scheduledAt?: string; location?: string; link?: string; notes?: string }, source = "manual"): StageT {
    this.getApplication(p.applicationId);
    const id = ulid();
    return tx(this.db, () => {
      this.db.prepare("insert into stage(id, application_id, kind, scheduled_at, location, link, notes, created_at) values (?,?,?,?,?,?,?,?)")
        .run(id, p.applicationId, p.kind, p.scheduledAt ?? null, p.location ?? "", p.link ?? "", p.notes ?? "", now());
      this.event(p.applicationId, "stage", `${p.kind}${p.scheduledAt ? " @ " + p.scheduledAt : ""}`, source);
      if (["draft", "submitted"].includes(this.getApplication(p.applicationId).state)) {
        this.db.prepare("update application set state = 'in_process', updated_at = ? where id = ?").run(now(), p.applicationId);
      }
      return stageRow(this.db.prepare("select * from stage where id = ?").get(id));
    });
  }

  /** Reschedule, record a result ("通过" / "已取消"), or fix the link of an existing stage. */
  updateStage(p: { id: string; scheduledAt?: string; result?: string; link?: string; location?: string; notes?: string }, source = "manual"): StageT {
    const cur = this.db.prepare("select * from stage where id = ?").get(p.id) as any;
    if (!cur) throw new NotFound(`stage ${p.id}`);
    return tx(this.db, () => {
      this.db.prepare("update stage set scheduled_at = ?, result = ?, link = ?, location = ?, notes = ? where id = ?")
        .run(p.scheduledAt ?? cur.scheduled_at, p.result ?? cur.result, p.link ?? cur.link, p.location ?? cur.location, p.notes ?? cur.notes, p.id);
      const what = [p.scheduledAt && p.scheduledAt !== cur.scheduled_at && `改到 ${p.scheduledAt}`, p.result && p.result !== cur.result && `结果：${p.result}`].filter(Boolean).join("，");
      if (what) this.event(cur.application_id, "stage", `${cur.kind} ${what}`, source);
      return stageRow(this.db.prepare("select * from stage where id = ?").get(p.id));
    });
  }

  // ---------- proposals ----------
  createProposal(kind: string, payload: unknown, createdBy: string, reason = "", ttlHours = 72, turnId?: string): ProposalT {
    const id = ulid();
    const payloadJson = JSON.stringify(payload);
    const expires = new Date(Date.now() + ttlHours * 3600_000).toISOString();
    this.db.prepare("insert into proposal(id, kind, payload_json, payload_hash, created_by, reason, decision, expires_at, created_at, turn_id) values (?,?,?,?,?,?,?,?,?,?)")
      .run(id, kind, payloadJson, sha(payloadJson), createdBy, reason, "pending", expires, now(), turnId ?? null);
    return proposalRow(this.db.prepare("select * from proposal where id = ?").get(id));
  }

  listProposals(decision = "pending"): ProposalT[] {
    return (this.db.prepare("select * from proposal where decision = ? order by created_at desc").all(decision) as any[]).map(proposalRow);
  }

  /**
   * Approve = verify hash + not expired + run the executor (passed by the registry). A card counts as approved only when
   * its work is done (ADR-062):
   *  - an executor that answers at once: run and marked in one transaction — its database writes and the mark stand or
   *    fall together;
   *  - one that answers later (reads a page, a table; returns a Promise): the claim ('running') is committed with the
   *    work's first synchronous part, the card stays pending meanwhile, and the result settles it — approved with what
   *    the work returned, or back to waiting with the reason. What the work already did is not undone; the reason says so.
   * A card left 'running' by a stopped daemon is 'interrupted' at the next start (interruptRunningProposals) and runs
   * again only when the person approves it again.
   */
  decideProposal(id: string, decision: "approved" | "rejected", payloadHash: string, execute: (kind: string, payload: any) => unknown): { ok: boolean; result?: unknown } | Promise<{ ok: boolean; result?: unknown }> {
    const r = this.db.prepare("select * from proposal where id = ?").get(id) as any;
    if (!r) throw new NotFound(`proposal ${id}`);
    if (r.decision !== "pending") throw new DomainError("ALREADY_DECIDED");
    if (r.execution === "running") throw new DomainError("RUNNING", "这张卡正在执行，等它做完");
    if (r.payload_hash !== payloadHash) throw new DomainError("HASH_MISMATCH");
    if (r.expires_at < now()) {
      this.db.prepare("update proposal set decision = 'expired', decided_at = ?, execution = null, execution_started_at = null where id = ?").run(now(), id);
      throw new DomainError("EXPIRED");
    }
    const settle = (result: unknown) => this.db.prepare("update proposal set decision = ?, decided_at = ?, result_json = ?, execution = null, execution_started_at = null where id = ?")
      .run(decision, now(), json.str(result ?? null), id);
    const started = tx(this.db, () => {
      if (decision === "rejected") { settle(undefined); return { ok: true, result: undefined }; }
      this.db.prepare("update proposal set execution = 'running', execution_started_at = ? where id = ?").run(now(), id);
      const result = execute(r.kind, JSON.parse(r.payload_json));
      if (!(result instanceof Promise)) settle(result);
      return { ok: true, result };
    });
    if (!(started.result instanceof Promise)) return started;
    return started.result.then(
      (result) => { settle(result); return { ok: true, result }; },
      (e) => {
        this.db.prepare("update proposal set execution = null, execution_started_at = null where id = ? and execution = 'running'").run(id);
        if (e instanceof Error && (e as any).code !== "MODEL_DELEGATED") e.message += NOT_UNDONE;
        throw e;
      });
  }

  /** At start: a card whose work was running when the daemon stopped is 'interrupted' — never run again by itself (ADR-062). */
  interruptRunningProposals(): number {
    return Number(this.db.prepare("update proposal set execution = 'interrupted' where execution = 'running'").run().changes);
  }

  // ---------- today ----------
  /** 今日: the days coming up and what is unconfirmed, for the posts the person holds (ADR-041), plus what waits on them. */
  today(days = 7) {
    const { deadlines, verify } = deadlineBoard(this.db, days);
    const pendingProposals = (this.db.prepare("select count(*) as n from proposal where decision = 'pending'").get() as any).n as number;
    const nextActions = (this.db.prepare(`select a.id, a.next_action, a.next_action_at, co.name as company_name from application a join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id
      where a.next_action != '' and a.state not in ('closed', 'cancelled') order by a.next_action_at is null, a.next_action_at`).all() as any[])
      .map((r) => ({ applicationId: r.id, companyName: r.company_name, nextAction: r.next_action, nextActionAt: r.next_action_at }));
    const workflowsRunning = (this.db.prepare("select count(*) as n from workflow where state = 'running'").get() as any).n as number;
    const reminders = (this.db.prepare("select count(*) as n from workflow where state = 'running' and kind = 'deadline_reminder'").get() as any).n as number;
    return { deadlines, verify, pendingProposals, nextActions, workflowsRunning, reminders };
  }

  audit(actor: string, tool: string, input: unknown, ok: boolean, detail = ""): void {
    this.db.prepare("insert into audit(id, at, actor, tool, input_json, ok, detail) values (?,?,?,?,?,?,?)").run(ulid(), now(), actor, tool, json.str(input), ok ? 1 : 0, detail);
    poolUnrelatedWrite(this.db);
  }
}
