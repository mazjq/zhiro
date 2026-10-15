import { tools, type ToolName, type ToolInput, type ToolOutput, type ToolContract } from "@zhiro/contracts";
import { Value } from "@sinclair/typebox/value";
import type { Domain } from "./service/domain.js";
import { DomainError, NotFound, genericCompany } from "./service/domain.js";
import { importCsv } from "./service/import-csv.js";
import { capture } from "./service/capture.js";
import { runBackup } from "./service/backup.js";
import { locationInfo, requestMove, cancelMove } from "./move.js";
import { notify } from "./service/feishu.js";
import type { WorkflowEngine } from "./service/workflow.js";
import type { JobosConfig } from "./config.js";
import { updateConfig } from "./config.js";
import { emit } from "./events.js";
import type { Llm } from "./llm.js";
import { runSource, listSources, addSource, removeSource, previewSource, isLocalPath, type Columns } from "./data/index.js";
import { sourceFor, campaignKey, companyKey, aggregateSql, type DataContext, type SourceConfig } from "./data/index.js";

/** Same tenant = same host + same first two path segments (Moka /campus-recruitment/<org>/<site>, 北森 <tenant>.zhiye.com). */
export function sameTenant(a: string, b: string): boolean {
  try {
    const ua = new URL(a), ub = new URL(b);
    const key = (u: URL) => u.hostname + (/zhiye\.com$/.test(u.hostname) ? "" : "/" + u.pathname.split("/").filter(Boolean).slice(0, 3).join("/"));
    return key(ua) === key(ub);
  } catch { return a === b; }
}
import { startResearch, getResearch, listResearch } from "./agent/research.js";
import { startFindCompany } from "./agent/find-company.js";
import { startTopicResearch, listTopics, getTopic } from "./agent/research-topic.js";
import { callData, dataFile, type DataTool } from "./service/research-data.js";
import { listPool, scanHistory, searchCompanies, poolFacets, poolWatched, poolDirty } from "./service/pool.js";
import { listFacts, upsertFact, removeFact, listTrash, restoreFact, reorderFacts, factLabels } from "./service/profile.js";
import { addDocument, scanFolder, listDocuments, reextract, duplicateCandidates, mergeFacts, drain, type Deps } from "./service/documents.js";
import { existsSync, readFileSync } from "node:fs";
import { basename } from "node:path";

import { PROVIDERS, loadAccounts, publicAccount, connectAccount, disconnectAccount, pullAll, ingestMessage, listMessages, readMessage, linkMessage, listSkipped, rescueSkipped, peekSkipped, type InboxDeps } from "./service/inbox.js";
import { imapFetcher } from "./service/imap.js";
import { createHash } from "node:crypto";

import { listResumes, saveResume, removeResume, pickResume, analyzeResume, resumeFile } from "./service/resumes.js";
import { officialLinks, syncOfficial, syncOfficialInBackground } from "./service/official.js";
import { workerStatus } from "./agent/worker.js";
import { contentText } from "@earendil-works/pi-ai";

import { openBrowser, closeBrowser, readForm, mapFields } from "./service/apply.js";
import { readPage } from "./service/page-read.js";
import { mergeEvidence, resolveMergeProposals, dropOrphanCampaigns } from "./service/tidy.js";
import { resolveFor, recordFact, setOverride, campaignClosesAt as campaignClosesAtOf } from "./service/deadlines.js";
import { deadlineBoard } from "./service/pool.js";
import { exploreCandidates } from "./service/explore.js";
import { startRun, stopRun, pauseRun, currentRun } from "./service/apply-run.js";
import { profileGaps } from "./service/gaps.js";
import { FACT_KINDS } from "./service/profile.js";

/** The same checks upsertFact makes, run before a proposal is filed. */
function checkFact(inp: any): void {
  const def = FACT_KINDS[inp?.kind];
  if (!def) throw new ToolError("BAD_KIND", `kind 必须是 ${Object.keys(FACT_KINDS).join(" / ")} 之一`);
  const missing = def.required.filter((f) => !String(inp?.data?.[f] ?? "").trim());
  if (missing.length) throw new ToolError("MISSING_FIELD", `${inp.kind} 的 data 缺少 ${missing.join("、")}；该类要写成 {${def.required.map((f) => `"${f}": "…"`).join(", ")}}`);
}
import { withPurpose, usageSummary, asAgentCall } from "./service/usage.js";
import { changesCursor, changesSince } from "./service/changes.js";
import { readReference } from "./service/apply-reference.js";
import { backgroundOnModel, describeBackground } from "./agent/route.js";
import { followedModel, modelRefused } from "./agent/backends/cli.js";
import { pendingJobs, replyJob } from "./service/model-jobs.js";
import { checkResume } from "./service/resume-check.js";
import { listPlatforms } from "./service/platforms.js";

import { modelStatus, modelLogin, modelAnswer, modelCancel, modelProvider, modelSelect, modelRefresh } from "./model/control.js";

/** Credentials and the choice of model are the user's alone: agents may look, never touch. */
const humanOnly = (a: Actor) => { if (a.kind !== "human") throw new ToolError("FORBIDDEN", "模型与凭据只能由本人在界面里操作"); };

export const inboxDeps = (s: Services): InboxDeps => ({ domain: s.domain, vault: s.config.vault, llm: s.llm });

/** Document extraction finishes in the background; when it does, the profile changed, so matching reruns — and the pages hear of both. */
export const docDeps = (s: Services): Deps => ({ db: s.domain.db, vault: s.config.vault, llm: s.llm, onChanged: () => void rerunAuto(s).then(() => s.onBackgroundChanged?.("documents")) });
import { recommenders, runRecommender, tagCompany, rerunAuto } from "./recommenders/index.js";
import { listPresets, savePreset, removePreset, suggestTerms } from "./recommenders/preset.js";
import { tierOf, undoPlan, recordAction, listActions, undoAction, setMode, setAgentConfig, maxWritesPerTurn } from "./service/tiers.js";
import { backendOf, type ChatHub } from "./agent/backend.js";
import { exportVault, defaultExportPath } from "./service/export.js";
import { join } from "node:path";
import { getIntel, getIntelDetail, refreshIntel, importSme } from "./service/intel.js";
import { sameCompanies } from "./service/same-company.js";
import { enqueueFit, listFit } from "./service/fit.js";
import { listGaps, confirmGap } from "./service/opportunity-gaps.js";
import { listLeads, resolveLeads } from "./service/leads.js";
import { loadSources, startSmeResearch } from "./service/sme.js";
import { listChannels } from "./channels.js";

/** A reader's "CODE: 说明" error as a tool error a caller can branch on, with the sentence for the person. */
function coded(e: any): unknown {
  if (e instanceof ToolError) return e;
  const m = /^([A-Z_]{4,}): ([\s\S]*)$/.exec(String(e?.message ?? e));
  return m ? new ToolError(m[1], m[2]) : e;
}

/**
 * Who is calling. Agents never execute write tools directly: they get a proposal back.
 * overflow: the agent already used this turn's write budget (ADR-025 ⑤), so even a 「直接做」 write becomes a proposal.
 * cred (ADR-045): which credential the agent came in with — "agent" the person's own harness (external, may confirm its
 * own cards when the person allows it), "turn" a harness the daemon started for one chat turn (embedded, never confirms;
 * its writes and cards carry turnId). The built-in assistant has neither. `via` is an audit label and nothing else.
 */
export type Actor = { kind: "human"; via: "desktop" | "cli" | "feishu" | "mcp-human" } | { kind: "agent"; via: string; overflow?: boolean; cred?: "agent" | "turn"; turnId?: string } | { kind: "system"; via: "workflow" };

/** Where the person's own harness confirms and undoes: in the harness itself (default) or only in the Zhiro window. */
export const harnessConfirm = (s: Services): "harness" | "window" => (s.config.agent?.harnessConfirm === "window" ? "window" : "harness");
/** An external agent allowed to decide and undo its own doings (ADR-047). */
const mayConfirmInHarness = (a: Actor, s: Services): boolean => a.kind === "agent" && a.cred === "agent" && harnessConfirm(s) === "harness";
/** The audit label of a write made by an external agent (any via): what such an agent may confirm or undo. Not the built-in assistant, not an embedded turn. */
const EXTERNAL_LABEL = /^agent:(?!embedded:|career$)/;
const CONFIRM_WINDOW_MS = 30 * 60_000;
/** ADR-025 ⑤ for callers that have no turn: direct writes in the last ten minutes, by any external agent. */
const EXTERNAL_WINDOW_MS = 10 * 60_000;
let externalInFlight = 0; // writes past the check and not yet recorded: counted so eleven at once cannot all pass (single-threaded, so this is exact)
function externalWritesRecently(s: Services): number {
  const since = new Date(Date.now() - EXTERNAL_WINDOW_MS).toISOString();
  const r = s.domain.db.prepare("select count(*) as n from agent_action where at > ? and actor like 'agent:%' and actor not like 'agent:embedded:%' and actor != 'agent:career'").get(since) as { n: number };
  return r.n + externalInFlight;
}

export class ToolError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}

/** What the data layer is given of the services: the database, the data directory, the subscriptions, and whom to tell. */
export function dataOf(s: Services): DataContext {
  return { db: s.domain.db, vault: s.config.vault, sources: s.config.sources as SourceConfig[], workflows: s.workflows, onDataChanged: () => s.onDataChanged?.(), onSourcesChanged: () => s.onSourcesChanged?.(),
    onPostsEdited: () => s.onBackgroundChanged?.("posts"),
    // only 「更新情况」 listens: it looks again and follows the pull while it runs (a page refresh for each of ~3,000 daily pulls would not do)
    onPull: (configId, running) => emit("scan", { configId, running }) };
}

/** `onBackgroundChanged`: data changed with no tool call behind it; the open pages hear of it once it shows (service/background.ts) */
export interface Services { domain: Domain; workflows: WorkflowEngine; config: JobosConfig; onDataChanged?: () => void; onBackgroundChanged?: (what: string) => void; onRelevanceChanged?: () => void; onSourcesChanged?: () => void; onInboxChanged?: () => void; llm?: Llm; chat?: ChatHub }

/**
 * The research data tools (ADR-056). Called with the runId of a 主题调研 that is under way, the call and its answer are
 * kept with that run — what its report's 要点 are checked against; a runId that is not such a run is refused, so one
 * report cannot be propped up by another's data. Without a runId nothing is kept.
 */
async function dataTool(tool: DataTool, i: any, s: Services): Promise<any> {
  const { runId, ...input } = i;
  let file: string | undefined;
  if (runId) {
    const run = s.domain.db.prepare("select run_dir, status from agent_run where id = ? and mode = 'research.topic'").get(runId) as { run_dir: string; status: string } | undefined;
    if (run?.status !== "running") throw new ToolError("BAD_RUN", `runId ${runId} 不是一份进行中的主题调研。不是在做调研就不要带 runId`);
    file = dataFile(run.run_dir);
  }
  try { return await callData(tool, input, file); } catch (e) { throw coded(e); }
}
type Handler<N extends ToolName> = (input: ToolInput<N>, actor: Actor, s: Services) => Promise<ToolOutput<N>> | ToolOutput<N>;

const handlers: { [N in ToolName]: Handler<N> } = {
  "campaign.list": (i, _a, s) => s.domain.listCampaigns(i),
  "campaign.get": (i, _a, s) => s.domain.getCampaign(i.id),
  // every post a tool returns says what it goes by (ADR-041): closesAt is the post's resolved last day, not the batch's earliest
  "position.list": (i, _a, s) => { const r = s.domain.listPositions(i), d = resolveFor(s.domain.db, r.items.map((p) => p.id)); return { items: r.items.map((p) => ({ ...p, closesAt: d.get(p.id)?.date ?? null, deadline: d.get(p.id) })) }; },
  "position.get": (i, _a, s) => {
    const r = s.domain.db.prepare(`select p.*, c.company_id, co.name company_name, c.closes_at c_closes, c.major_req c_major, c.apply_url, c.notice_url, c.source_kind, c.source_grade, a.json assessment
      from position p join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id left join position_assessment a on a.position_id = p.id where p.id = ?`).get(i.id) as any;
    if (!r) throw new ToolError("NOT_FOUND", "没有这个岗位");
    // the person's day for this batch, else the source's (meaning unchanged; read from deadline_override since 2026-10-14)
    const campaignClosesAt = campaignClosesAtOf(s.domain.db, r.campaign_id, r.c_closes ?? null);
    const deadline = resolveFor(s.domain.db, [r.id]).get(r.id);
    return { position: { id: r.id, campaignId: r.campaign_id, title: r.title, jdText: r.jd_text, cities: JSON.parse(r.cities || "[]"), degreeReq: r.degree_req, status: r.status, directionTags: JSON.parse(r.direction_tags || "[]"), lastSeenAt: r.last_seen_at, watchPriority: r.watch_priority },
      companyId: r.company_id, companyName: r.company_name, closesAt: deadline?.date ?? null, deadline, campaignClosesAt, majorReq: r.major_req || r.c_major || "", applyUrl: r.apply_url, noticeUrl: r.notice_url, sourceKind: r.source_kind, sourceGrade: r.source_grade, lastSeenAt: r.last_seen_at, assessment: r.assessment ? JSON.parse(r.assessment) : null };
  },
  // the person's (or their agent's) own word about a deadline (ADR-041): a date, 招满即止, 官网未设截止, 官方未写, or taking
  // it back; on one post, one batch, or every campus batch of the company. It outranks every source and survives refreshes.
  "campaign.deadline": (i, a, s) => {
    const db = s.domain.db;
    const kind = i.clear ? "clear" : i.policy ?? (i.unknown ? "unknown" : "date");
    if (kind === "date" && !/^\d{4}-\d{2}-\d{2}$/.test(i.date ?? "")) throw new ToolError("BAD_DATE", "日期要写成 YYYY-MM-DD；不是具体日期时用 policy（until_filled / no_fixed_date / rolling）或 unknown=true");
    if (!db.prepare("select 1 from company where id = ?").get(i.companyId)) throw new ToolError("NOT_FOUND", "没有这家公司");
    const say = { date: `核实：${i.date}`, unknown: "官方未写截止", until_filled: "官网：招满即止", no_fixed_date: "官网：不设截止", rolling: "官网：滚动招聘", clear: "" }[kind] ?? "";
    const note = (i.text ?? say) + (i.sourceUrl ? ` ${i.sourceUrl}` : ""), by = actorLabel(a);
    let updated = 0;
    if (i.positionId) {
      if (!db.prepare("select 1 from position p join campaign c on c.id = p.campaign_id where p.id = ? and c.company_id = ?").get(i.positionId, i.companyId)) throw new ToolError("NOT_FOUND", "这家公司没有这个岗位");
      setOverride(db, { subjectType: "position", subjectId: i.positionId, kind, date: i.date, note, by });
      updated = 1;
    } else {
      const cs = db.prepare(`select id from campaign where company_id = ? and kind != '社招'${i.campaignId ? " and id = ?" : ""}`).all(i.companyId, ...(i.campaignId ? [i.campaignId] : [])) as { id: string }[];
      // the person's word lives in deadline_override only; the old campaign.closes_at_override / override_note /
      // overridden_at columns are neither written nor read since 2026-10-14 (technical-debt plan item 1)
      for (const c of cs) setOverride(db, { subjectType: "campaign", subjectId: c.id, kind, date: i.date, note, by });
      updated = cs.length;
    }
    poolDirty(); s.onRelevanceChanged?.();
    return { updated };
  },
  // what a source says about a deadline, with the sentence it says it in (ADR-041). Not the person's word — that is campaign.deadline.
  // a batch filed under the wrong company (a reader took 「公司」 for a name): move it whole — posts, watches and
  // applications keep their ids — and re-key it so the next scan of its source finds it under the right name
  "campaign.move": (i, _a, s) => {
    const db = s.domain.db, name = i.companyName.trim();
    const c = db.prepare("select id, company_id, source_kind, cohort, batch, external_key from campaign where id = ?").get(i.campaignId) as any;
    if (!c) throw new ToolError("NOT_FOUND", "没有这个招聘项目");
    if (!name || genericCompany(name)) throw new ToolError("COMPANY_UNKNOWN", "要给出真实的公司名");
    const to = s.domain.upsertCompany(name);
    const pub = (db.prepare("select publisher from source_listing where campaign_id = ? limit 1").get(c.id) as any)?.publisher as string | undefined;
    const key = pub ? campaignKey(c.source_kind, pub, name, c.cohort, c.batch) : c.external_key;
    if (db.prepare("select 1 from campaign where external_key = ? and id != ?").get(key, c.id)) throw new ToolError("CONFLICT", `「${name}」已经有同一来源的这个项目了；用 company.merge 合并两家公司`);
    db.prepare("update campaign set company_id = ?, external_key = ?, updated_at = ? where id = ?").run(to, key, new Date().toISOString(), c.id);
    poolDirty(); s.onDataChanged?.();
    return { campaignId: c.id as string, companyId: to, companyName: name, fromCompanyId: c.company_id as string };
  },
  "deadline.pending": (i, _a, s) => ({ items: deadlineBoard(s.domain.db, 14, i.limit ?? 20).verify }),
  "deadline.report": (i, a, s) => {
    const r = recordFact(s.domain.db, { ...i, by: actorLabel(a) });
    poolDirty(); s.onRelevanceChanged?.();
    const pid = i.positionId ?? (s.domain.db.prepare(i.campaignId ? "select id from position where campaign_id = ? limit 1" : "select p.id from position p join campaign c on c.id = p.campaign_id where c.company_id = ? and c.kind != '社招' limit 1").get(i.campaignId ?? i.companyId ?? "") as { id: string } | undefined)?.id;
    return { factId: r.id, created: r.created, now: pid ? resolveFor(s.domain.db, [pid]).get(pid)?.say ?? "" : "" };
  },
  "position.watch": (i, _a, s) => { s.domain.watchPosition(i.positionId, i.priority, i.note); poolWatched(s.domain.db, i.positionId, i.priority > 0); s.onRelevanceChanged?.(); return { ok: true }; },
  "application.create": (i, a, s) => { const application = s.domain.createApplication(i.positionId, i.channel, i.note, actorLabel(a));
    syncOfficialInBackground(s, (s.domain.db.prepare("select company_id from campaign where id = ?").get(application.campaignId) as any).company_id);
    s.onRelevanceChanged?.(); return { application }; },
  "application.update": (i, a, s) => ({ application: s.domain.updateApplication(i, actorLabel(a)) }),
  "application.timeline": (i, _a, s) => s.domain.timeline(i.id),
  "stage.add": (i, a, s) => ({ stage: s.domain.addStage(i, actorLabel(a)) }),
  "stage.update": (i, a, s) => ({ stage: s.domain.updateStage(i, actorLabel(a)) }),
  // a merge card names both companies and what the data says, so it can be decided at a glance; stale ones are expired first
  "proposal.list": (i, _a, s) => {
    if ((i.decision ?? "pending") === "pending") resolveMergeProposals(s);
    return { items: s.domain.listProposals(i.decision ?? "pending").map((p) => (p.kind === "company.merge" && (p.payload as any)?.fromId ? { ...p, context: mergeEvidence(s.domain.db, (p.payload as any).fromId, (p.payload as any).intoId) }
      : p.kind === "fact.remove" ? { ...p, context: { cards: factLabels(s.domain.db, (p.payload as any)?.ids ?? [(p.payload as any)?.id]) } }
      : p.kind === "fact.merge" ? { ...p, context: { merges: ((p.payload as any)?.pairs ?? [p.payload]).map((x: any) => `${factLabels(s.domain.db, [x.fromId])[0] ?? "（已不在）"} → 并入 → ${factLabels(s.domain.db, [x.intoId])[0] ?? "（已不在）"}`) } } : p)) };
  },
  "proposal.decide": async (i, a, s) => {
    // ADR-047: the person's own harness may decide a card it raised itself, when the person set confirmation to happen there
    if (a.kind !== "human") {
      if (!mayConfirmInHarness(a, s)) throw new ToolError("FORBIDDEN", "only a human entry point can decide proposals");
      const p = s.domain.db.prepare("select created_by, created_at from proposal where id = ?").get(i.id) as { created_by: string; created_at: string } | undefined;
      if (!p) throw new NotFound(`proposal ${i.id}`);
      if (!EXTERNAL_LABEL.test(p.created_by)) throw new ToolError("FORBIDDEN", "只能确认你自己提出的确认卡");
      if (Date.parse(p.created_at) < Date.now() - CONFIRM_WINDOW_MS) throw new ToolError("FORBIDDEN", "这张确认卡已超过 30 分钟，请用户到 Zhiro 窗口「今日」确认");
    }
    // a tool that answers later (it reads a page, a table): the card is settled by how the work ends, not by its having
    // started (ADR-044 ⑥) — and while it runs the card says so, in the database, so a restart cannot leave it looking done (ADR-062)
    const r = s.domain.decideProposal(i.id, i.decision, i.payloadHash, (kind, payload) => executeDirect(kind as ToolName, payload, a.kind === "human" ? { kind: "human", via: a.via } : a, s));
    if (!(r instanceof Promise)) return r;
    try { return await r; } catch (e) { throw coded(e); }
  },
  "import.csv": (i, _a, s) => { const r = importCsv(s.domain, i.path); s.onDataChanged?.(); return r; },
  "listing.capture": async (i, _a, s) => {
    // A bookmarked Moka/北森 tenant page is better served by the pull source: register it (once) and scan now.
    const pull = sourceFor(i.url);
    if (pull?.fetch) {
      const tenantUrl = pull.id === "moka" ? i.url.split("#")[0] : i.url;
      let cfg = s.config.sources.find((c) => c.source === pull.id && c.url && sameTenant(c.url, tenantUrl));
      if (!cfg) {
        const name = (i.title ?? "").split(/[-|｜_–—]/)[0].trim().slice(0, 30) || new URL(i.url).hostname.split(".")[0];
        const added = addSource(dataOf(s), { url: tenantUrl, name, cohort: "2027届", batch: "校招" });
        cfg = s.config.sources.find((c) => c.id === added.id)!;
      }
      const r = await runSource(dataOf(s), cfg.id);
      if (!r.ok) throw new ToolError("SOURCE_FAILED", r.error);
      return { captureId: r.result.runId, campaignId: r.listed.campaignIds[0] ?? null, positionIds: r.listed.positionIds, note: `识别为 ${pull.id} 招聘站，已作为自动数据源「${cfg.name}」（每 ${cfg.everyHours ?? 24} 小时重扫）：本次 ${r.result.received} 条，新增 ${r.result.positionsNew}` };
    }
    const r = await capture(s.domain, s.config.vault, i, s.llm);
    s.onDataChanged?.();
    return r;
  },
  "source.list": (_i, _a, s) => listSources(dataOf(s)),
  "scan.run": async (i, _a, s) => {
    const r = await runSource(dataOf(s), i.configId);
    if (!r.ok) throw new ToolError(r.error.startsWith("NOT_FOUND") ? "NOT_FOUND" : "SOURCE_FAILED", r.error);
    return r.result;
  },
  // a table is read by a column mapping: the caller's, or — given none — the one a preview guesses, refused when it finds no company column
  "source.preview": async (i, a, s) => {
    if (isLocalPath(i.url) && a.kind !== "human") throw new ToolError("FORBIDDEN", "本机文件只能由本人在界面里预览。要接入请直接调 source.add，用户会看到路径并确认");
    try { return await previewSource(dataOf(s), i as any); } catch (e) { throw coded(e); }
  },
  "source.add": async (i, _a, s) => {
    try {
      let columns = i.columns as Columns | undefined;
      if (sourceFor(i.url.trim())?.table && !columns) {
        const pv = await previewSource(dataOf(s), { url: i.url, cohort: i.cohort });
        if (pv.problem) throw new ToolError("BAD_TABLE", pv.problem);
        columns = pv.columns as Columns;
      }
      return addSource(dataOf(s), { ...i, columns });
    } catch (e) { throw coded(e); }
  },
  "source.remove": (i, _a, s) => {
    const cfg = removeSource(dataOf(s), i.id);
    const droppedCampaigns = dropOrphanCampaigns(s, i.id);
    poolDirty(); s.onDataChanged?.();
    return { id: i.id, name: cfg.name ?? "", droppedCampaigns };
  },
  "research.company": (i, _a, s) => startResearch(s, i.companyName, i.question),
  "research.topic": async (i, _a, s) => { try { return await startTopicResearch(s, i); } catch (e) { throw coded(e); } },
  "research.topics": (_i, _a, s) => ({ items: listTopics(s) }),
  "industry.reports": (i, _a, s) => dataTool("industry.reports", i, s),
  "industry.companies": (i, _a, s) => dataTool("industry.companies", i, s),
  "company.financials": (i, _a, s) => dataTool("company.financials", i, s),
  "labor.us": (i, _a, s) => dataTool("labor.us", i, s),
  "research.report": (i, _a, s) => { const r = getTopic(s, i.runId); if (!r) throw new ToolError("NOT_FOUND", `没有这份主题调研：${i.runId}`); return r; },
  "research.get": (i, _a, s) => { const r = getResearch(s, i.runId); if (!r) throw new ToolError("NOT_FOUND", `run ${i.runId}`); return r; },
  "research.list": (i, _a, s) => ({ items: listResearch(s, i.companyName) }),
  "fact.list": (i, _a, s) => listFacts(s.domain.db, i),
  // a person typing in the desktop vouches for the card; anything else is only what some material claims
  "fact.upsert": (i, a, s) => { const r = upsertFact(s.domain.db, i, a.kind === "human" ? "本人确认" : "材料自述"); s.onDataChanged?.(); return r; },
  // ids: at most 10, the size of 最近删除 — a batch stays restorable whole
  "fact.remove": (i, _a, s) => { const ids = i.ids ?? (i.id ? [i.id] : []); if (!ids.length) throw new DomainError("MISSING_FIELD", "给 id 或 ids"); if (factLabels(s.domain.db, ids).length !== ids.length) throw new NotFound("fact"); for (const id of ids) removeFact(s.domain.db, id); s.onDataChanged?.(); return { ok: true }; },
  "fact.reorder": (i, _a, s) => reorderFacts(s.domain.db, i.ids),
  "profile.gaps": (_i, _a, s) => profileGaps(s.domain.db, s.config.vault),
  "usage.summary": (_i, _a, s) => usageSummary(s.domain.db),
  "profile.import": (i, _a, s) => {
    if (i.path) { if (!existsSync(i.path)) throw new ToolError("FILE_NOT_FOUND", i.path); return addDocument(docDeps(s), basename(i.path), readFileSync(i.path)); }
    if (!i.name || !i.dataBase64) throw new ToolError("MISSING_FIELD", "需要 path，或 name + dataBase64");
    return addDocument(docDeps(s), i.name, Buffer.from(i.dataBase64, "base64"));
  },
  "profile.scan": (i, _a, s) => scanFolder(docDeps(s), i.dir),
  "document.list": (_i, _a, s) => listDocuments(s.domain.db),
  "document.reextract": (i, _a, s) => reextract(docDeps(s), i.id),
  "fact.duplicates": (_i, _a, s) => duplicateCandidates(s.domain.db),
  "fact.merge": (i, _a, s) => {
    const pairs = i.pairs ?? (i.fromId && i.intoId ? [{ fromId: i.fromId, intoId: i.intoId }] : []);
    if (!pairs.length) throw new DomainError("MISSING_FIELD", "给 fromId + intoId 或 pairs");
    const ids = pairs.flatMap((p) => [p.fromId, p.intoId]);
    if (factLabels(s.domain.db, ids).length !== ids.length) throw new NotFound("fact"); // all there before any merges
    for (const p of pairs) mergeFacts(s.domain.db, p.fromId, p.intoId);
    s.onDataChanged?.();
    return { ok: true };
  },
  "fact.trash": (_i, _a, s) => listTrash(s.domain.db),
  "fact.restore": (i, _a, s) => { const r = restoreFact(s.domain.db, i.id); s.onDataChanged?.(); return r; },
  "pool.list": (i, _a, s) => listPool(s.domain.db, i),
  "company.merge": (i, _a, s) => s.domain.mergeCompany(i.fromId, i.intoId),
  // another name a company goes by (the person says so): rows and reports that use it mean this company from now on
  "company.alias": (i, _a, s) => {
    const db = s.domain.db, alias = i.alias.trim();
    const co = db.prepare("select name, aliases from company where id = ?").get(i.companyId) as { name: string; aliases: string } | undefined;
    if (!co) throw new ToolError("NOT_FOUND", "没有这家公司");
    if (!alias || genericCompany(alias)) throw new ToolError("COMPANY_UNKNOWN", "别名要是一个真实的名字");
    const other = db.prepare("select name from company where id != ? and (name = ? or norm = ?)").get(i.companyId, alias, companyKey(alias)) as { name: string } | undefined;
    if (other) throw new ToolError("CONFLICT", `库里已经有一家叫「${other.name}」的公司；如果它和「${co.name}」是同一家，用 company.merge 合并`);
    const aliases = [...new Set([...(JSON.parse(co.aliases || "[]") as string[]), alias])].filter((a) => a !== co.name);
    db.prepare("update company set aliases = ? where id = ?").run(JSON.stringify(aliases), i.companyId);
    poolDirty();
    return { ok: true, companyName: co.name, aliases };
  },
  "lead.list": (_i, _a, s) => ({ items: listLeads(s) }),
  "lead.resolve": (i, _a, s) => resolveLeads(s, i.budget, i.companyIds),
  "gap.list": (i, _a, s) => listGaps(s, i),
  "gap.confirm": (i, _a, s) => confirmGap(s, i),
  "company.similar": (i, _a, s) => ({ items: sameCompanies(s.domain.db, i.companyId).map((c) => {
    const r = s.domain.db.prepare(`select count(p.id) n, sum(c.source_kind not in (${aggregateSql()})) o from campaign c left join position p on p.campaign_id = c.id and p.status = 'open' where c.company_id = ?`).get(c.companyId) as any;
    return { ...c, positions: Number(r?.n ?? 0), official: Number(r?.o ?? 0) > 0 };
  }) }),
  "scan.history": (i, _a, s) => scanHistory(s.domain.db, new Map(s.config.sources.map((c) => [c.id, c.name ?? c.id])), i.limit ?? 30),
  "recommend.modes": () => ({ items: Object.values(recommenders).map(({ id, tag, describe, auto }) => ({ id, tag, describe, auto })) }),
  "recommend.run": (i, _a, s) => runRecommender(s, i.mode, i.params ?? {}),
  "preset.list": (_i, _a, s) => ({ items: listPresets(s) }),
  "preset.save": (i, _a, s) => { const r = savePreset(s, i); s.onDataChanged?.(); return r; },
  "preset.remove": (i, _a, s) => { const r = removePreset(s, i.id); s.onDataChanged?.(); return r; },
  "recommend.suggest": (i, _a, s) => {
    const p = i.presetId ? listPresets(s).find((x) => x.id === i.presetId) : undefined;
    if (i.presetId && !p) throw new ToolError("NOT_FOUND", `preset ${i.presetId}`);
    const facts = listFacts(s.domain.db).items.filter((f) => f.kind === "direction" || f.kind === "exclude").map((f) => f.data.keyword);
    return suggestTerms(s, p ? `preset:${p.id}` : "profile_match", [...facts, ...(p ? [...p.must, ...p.any, ...p.exclude] : [])]);
  },
  "recommend.tag": (i, _a, s) => { const r = tagCompany(s, i); syncOfficialInBackground(s, r.companyId); s.onRelevanceChanged?.(); return r; },
  "recommend.untag": (i, _a, s) => { s.domain.db.prepare("delete from recommendation where company_id = ? and tag = ?").run(i.companyId, i.tag); return { ok: true }; },
  "resume.list": (_i, _a, s) => listResumes(s.domain.db),
  "resume.save": (i, _a, s) => {
    if (i.path && !existsSync(i.path)) throw new ToolError("FILE_NOT_FOUND", i.path);
    const bytes = i.path ? readFileSync(i.path) : i.dataBase64 ? Buffer.from(i.dataBase64, "base64") : undefined;
    return saveResume(s.domain.db, s.config.vault, { id: i.id, name: i.name, fileName: i.path ? basename(i.path) : i.fileName, bytes, companyTypes: i.companyTypes, roleKeywords: i.roleKeywords, note: i.note, isDefault: i.isDefault });
  },
  "resume.remove": (i, _a, s) => removeResume(s.domain.db, i.id),
  "resume.file": (i, _a, s) => resumeFile(s.domain.db, i.id),
  "resume.pick": (i, _a, s) => pickResume(s.domain.db, i.positionId),
  "resume.check": (i, _a, s) => checkResume(s.domain.db, i.id),
  "fit.deep": (i, _a, s) => enqueueFit(s, i.positionIds, { force: i.force }),
  "fit.list": (i, _a, s) => listFit(s, i),
  "resume.analyze": (i, _a, s) => analyzeResume(s.domain.db, s.llm, i.resumeId, i.positionId),
  "page.read": (i, _a, s) => readPage(s, i),
  "explore.candidates": (i, _a, s) => exploreCandidates(s, i),
  // ADR-032 ①: the application browser is the agent's to open and fill (直接做); the handler's own human-only check was a
  // leftover from before and contradicted it (an embedded Claude Code was refused, 2026-10-13). Submitting stays the person's act.
  "apply.open": (i, _a, s) => openBrowser(s.config.vault, i.url),
  "apply.read": async (_i, _a, s) => { const form = await readForm(); return { ...form, fields: await mapFields(s.domain.db, s.llm, form.fields) }; },
  "apply.start": async (i, _a, s) => ({ run: await startRun(s, i.applicationId) }),
  "apply.status": () => ({ run: currentRun() }),
  "apply.platforms": (_i, _a, s) => listPlatforms(s.domain.db),
  "apply.pause": (i, _a, s) => ({ run: pauseRun(s, i.paused) }),
  "apply.close": () => { stopRun(); return closeBrowser(); },
  "inbox.accounts": (_i, _a, s) => ({
    accounts: loadAccounts(s.config.vault).map(publicAccount),
    providers: Object.entries(PROVIDERS).map(([id, p]) => ({ id, label: p.label, help: p.help })),
    lastPull: JSON.parse(((s.domain.db.prepare("select checkpoint_json from workflow where kind = 'inbox_poll' order by updated_at desc limit 1").get() as any)?.checkpoint_json as string) ?? "null"),
  }),
  "inbox.connect": async (i, a, s) => {
    if (a.kind !== "human") throw new ToolError("FORBIDDEN", "邮箱授权码只能由本人在界面里填写");
    const r = await connectAccount(s.config.vault, i, imapFetcher);
    s.onInboxChanged?.();
    return r;
  },
  "inbox.disconnect": (i, _a, s) => disconnectAccount(s.config.vault, i.id),
  "inbox.pull": (_i, _a, s) => pullAll(inboxDeps(s), imapFetcher),
  "inbox.paste": (i, _a, s) => {
    const text = i.text.trim();
    return ingestMessage(inboxDeps(s), "paste", { messageId: "paste:" + createHash("sha256").update(text).digest("hex").slice(0, 32), from: i.from ?? "粘贴", subject: i.subject ?? text.split("\n")[0].slice(0, 80), date: new Date().toISOString(), text });
  },
  "inbox.list": (i, _a, s) => listMessages(s.domain.db, i),
  "inbox.get": (i, _a, s) => readMessage(s.domain.db, i.id),
  "inbox.skipped": (i, _a, s) => listSkipped(s.domain.db, i.limit ?? 100),
  "inbox.peek": (i, _a, s) => peekSkipped(s.config.vault, imapFetcher, i.account, i.messageId),
  "inbox.rescue": (i, _a, s) => rescueSkipped(inboxDeps(s), imapFetcher, i.account, i.messageId),
  "inbox.link": (i, _a, s) => linkMessage(inboxDeps(s), i.id, i.applicationId),
  "application.list": (i, _a, s) => { const r = s.domain.listApplications(i.state), d = resolveFor(s.domain.db, r.items.map((x) => x.application.positionId)); return { items: r.items.map((x) => ({ ...x, closesAt: d.get(x.application.positionId)?.date ?? null, deadline: d.get(x.application.positionId) })) }; },
  "company.find": (i, _a, s) => startFindCompany(s, i.name),
  "company.official": (i, _a, s) => ({ links: officialLinks(s, i.companyId) }),
  "company.syncOfficial": (i, _a, s) => syncOfficial(s, i.companyId),
  "company.search": (i, _a, s) => searchCompanies(s.domain.db, i.query, i.limit ?? 10),
  "company.intel": (i, _a, s) => getIntel(s, i.companyId),
  "company.intelDetail": (i, _a, s) => getIntelDetail(s, i.companyId, i.kind),
  "company.intelRefresh": (i, _a, s) => refreshIntel(s, i.companyId),
  "intel.smeImport": (i, _a, s) => importSme(s.domain.db, s.config.vault, i.path),
  "channel.list": (_i, _a, s) => ({ items: listChannels(s) }),
  "intel.smeFromUrl": (i, _a, s) => loadSources(s.domain.db, [{ url: i.url, level: i.level, batch: i.batch, region: i.region, published_at: i.publishedAt }]),
  "intel.smeResearch": (i, _a, s) => startSmeResearch(s, i.region, i.hint ?? ""),
  "pool.facets": (_i, _a, s) => poolFacets(s.domain.db),
  "workflow.list": (i, _a, s) => ({ items: s.workflows.list(i.state) }),
  "today.summary": (i, _a, s) => ({ ...s.domain.today(i.days ?? 7), notifyConfigured: !!(s.config.feishu.webhookUrl || s.config.feishu.appId) }),
  "feishu.notify": async (i, _a, s) => notify(s.config.feishu, i),
  "backup.run": (_i, _a, s) => runBackup(s.domain.db, s.config.vault),
  "history.list": (i, _a, s) => ({ items: listActions(s, i.limit ?? 20) }),
  "history.undo": (i, a, s) => {
    if (a.kind !== "human") {
      // ADR-047: an external agent undoes only what an external agent did
      if (!mayConfirmInHarness(a, s)) humanOnly(a);
      const r = s.domain.db.prepare("select actor from agent_action where id = ?").get(i.id) as { actor: string } | undefined;
      if (r && !EXTERNAL_LABEL.test(r.actor)) throw new ToolError("FORBIDDEN", "只能撤销你自己做的操作");
    }
    return undoAction(s, i.id, (n, inp) => executeDirect(n as ToolName, inp as any, a.kind === "human" ? { kind: "human", via: a.via } : a, s));
  },
  "agent.mode": (i, a, s) => { humanOnly(a); setMode(s, i.mode); return { mode: i.mode }; },
  "agent.backend": (i, a, s) => {
    humanOnly(a);
    const st = s.chat?.status()[i.backend];
    if (st && !st.available) throw new ToolError("NOT_AVAILABLE", st.detail);
    s.chat?.cancel();
    setAgentConfig(s, { backend: i.backend });
    return { backend: i.backend };
  },
  "agent.harnessConfirm": (i, a, s) => { humanOnly(a); setAgentConfig(s, { harnessConfirm: i.where }); return { where: i.where }; },
  "apply.reference": (i, _a, s) => {
    const path = i.path.trim();
    const ref = path ? readReference(path) : null;
    if (path && !ref) throw new ToolError("NOT_READABLE", `读不了这个文件（要 .docx）：${path}`);
    updateConfig(s.config.vault, (doc) => { doc.apply = { ...(doc.apply ?? {}), referenceDoc: path || undefined }; });
    s.config.apply = { ...(s.config.apply ?? {}), referenceDoc: path || undefined };
    return { path, awards: ref?.awards.length ?? 0, projects: ref?.projects.length ?? 0, fields: ref ? [...ref.fields.keys()] : [] };
  },
  "agent.background": (i, a, s) => {
    humanOnly(a);
    updateConfig(s.config.vault, (doc) => { doc.llm = { ...(doc.llm ?? {}), forBackground: i.useModel }; });
    s.config.llm.forBackground = i.useModel;
    return { useModel: i.useModel, doneBy: describeBackground(s) };
  },
  "data.export": (i, a, s) => {
    humanOnly(a);
    try { const r = exportVault(s.domain.db, s.config.vault, i.to || defaultExportPath()); return { path: r.path, bytes: r.bytes, counts: r.manifest.counts, files: r.manifest.files }; }
    catch (e) { throw coded(e); }
  },
  "data.location": (_i, _a, s) => locationInfo(s.config.vault),
  "data.move": (i, a, s) => {
    humanOnly(a);
    if (!i.to.trim()) { cancelMove(s.config.vault); return { pending: null }; }
    // said early and kindly; what actually keeps the copy honest is the file-by-file comparison at the next start
    if (currentRun() && !["已投递", "已停止", "结果待核实"].includes(currentRun()!.state)) throw new ToolError("BUSY", "有一份网申正在填：填完或停掉再搬");
    if ((s.domain.db.prepare("select count(*) as n from agent_run where status = 'running'").get() as any).n) throw new ToolError("BUSY", "有调研还在跑：等它跑完再搬");
    try { return { pending: requestMove(s.config.vault, i.to.trim()).to }; } catch (e) { throw coded(e); }
  },
  "config.get": async (_i, _a, s) => ({
    config: {
      ...s.config,
      feishu: { configured: !!(s.config.feishu.webhookUrl || s.config.feishu.appId) },
      llm: { ...s.config.llm, ...(s.llm ? await s.llm.status() : {}) },
      worker: workerStatus(),
      // ADR-046 / 047: who answers the drawer, what is installed; where the person's own harness confirms
      chat: { backend: backendOf(s), backends: s.chat?.status() ?? {}, harnessConfirm: harnessConfirm(s), agentDir: join(s.config.vault, "agent"), models: { claude: followedModel("claude"), codex: followedModel("codex"), refused: { claude: modelRefused("claude"), codex: modelRefused("codex") } } },
      background: { useModel: backgroundOnModel(s), doneBy: describeBackground(s) },
      applyReference: s.config.apply?.referenceDoc ?? "",
      configFile: s.config.vault + "\\config\\jobos.yaml",
    },
  }),
  "model.status": (_i, _a, s) => modelStatus(s),
  "model.login": (_i, a, s) => { humanOnly(a); return modelLogin(s); },
  "model.answer": (i, a, s) => { humanOnly(a); return modelAnswer(s, i); },
  "model.cancel": (_i, a, s) => { humanOnly(a); return modelCancel(s); },
  "model.provider": (i, a, s) => { humanOnly(a); return modelProvider(s, i.providerId, i.authType); },
  "model.select": (i, a, s) => { humanOnly(a); return modelSelect(s, i.modelId); },
  "model.refresh": (_i, a, s) => { humanOnly(a); return modelRefresh(s); },
  "llm.pending": (_i, a, s) => pendingJobs(s.domain.db, a.kind === "agent" && a.cred === "agent" ? a.via.slice(0, 32) : undefined),
  "llm.reply": (i, _a, s) => {
    const job = replyJob(s.domain.db, i.jobId, i.text);
    // work that was waiting for this answer picks up again on its own
    if (s.domain.db.prepare("update document set status = 'pending', stage = '' where status = 'waiting'").run().changes) void drain(docDeps(s));
    if (job.purpose.startsWith("inbox")) void withPurpose("inbox.poll", "", () => pullAll(inboxDeps(s), imapFetcher)).catch(() => {});
    return { job: { id: job.id, kind: job.kind, purpose: job.purpose, status: job.status } };
  },
  "llm.test": async (_i, _a, s) => {
    const base = { provider: s.config.llm.provider, model: s.config.llm.model };
    const t0 = Date.now();
    try {
      if (!s.llm) throw new Error("模型未初始化");
      const msg = await s.llm.models.completeSimple(s.llm.model(), { systemPrompt: "只回复两个字：正常", messages: [{ role: "user", content: [{ type: "text", text: "测试" }], timestamp: Date.now() }] }, { reasoning: "low" });
      return { ok: true, ...base, latencyMs: Date.now() - t0, reply: contentText(msg.content).trim().slice(0, 40), error: "" };
    } catch (e: any) { return { ok: false, ...base, latencyMs: Date.now() - t0, reply: "", error: String(e?.message ?? e).slice(0, 400) }; }
  },
};

/** The audit label. An embedded turn is marked by the server from its credential, so no header can claim or shed it. */
function actorLabel(a: Actor): string {
  return a.kind === "agent" && a.cred === "turn" ? `agent:embedded:${a.via}` : `${a.kind}:${a.via}`;
}

/** Tools an agent may call directly (read-only) — everything else becomes a proposal. */
export function isAgentDirect(c: ToolContract): boolean {
  return !c.effects.localWrite && !c.effects.externalAction && !c.effects.dataEgress;
}

function executeDirect<N extends ToolName>(name: N, input: ToolInput<N>, actor: Actor, s: Services): Promise<ToolOutput<N>> | ToolOutput<N> {
  const h = handlers[name] as Handler<N>;
  return h(input, actor, s);
}

/**
 * Single entry for every transport. Enforces:
 *  - unknown tool → NOT_FOUND
 *  - agent + write/effect tool → proposal (returned as { proposal }) instead of execution
 *  - audit row for every call
 */
export const HUMAN_ONLY = new Set(["gap.confirm", "model.login", "model.answer", "model.cancel", "model.provider", "model.select", "model.refresh", "inbox.connect", "inbox.disconnect", "history.undo", "agent.mode", "agent.backend", "agent.harnessConfirm", "agent.background", "data.export", "data.move"]);

/** What an actor may call at all: agents never see the human-only tools or proposal.decide (they would only be refused) — except the person's own harness, when confirmation happens there (ADR-047). */
export const callableBy = (actor: Actor, s?: Services) => {
  const harness = !!s && mayConfirmInHarness(actor, s);
  return listContracts().filter((c) => actor.kind === "human" || (harness && (c.name === "proposal.decide" || c.name === "history.undo")) || (!HUMAN_ONLY.has(c.name) && c.name !== "proposal.decide"));
};

/**
 * Every transport's entry. A call from the person's own external agent runs inside that agent's scope (ADR-057: the model
 * work it causes is answered by it) and carries what the person changed in the window since that agent's last call.
 */
export async function callTool(name: string, input: unknown, actor: Actor, s: Services): Promise<unknown> {
  if (actor.kind !== "agent") return callToolHere(name, input, actor, s);
  // every agent hears what the person changed since its own last call — the drawer's harness and the built-in assistant
  // too (2026-10-14); a turn is labelled claude / codex like the external ones, so the place is kept per credential
  const who = `${actor.cred ?? "builtin"}:${actor.via}`;
  const since = changesCursor(who, s);
  const out = actor.cred === "agent" ? await asAgentCall(actor.via, () => callToolHere(name, input, actor, s)) : await callToolHere(name, input, actor, s);
  const changed = changesSince(who, since, s);
  return changed && out && typeof out === "object" && !Array.isArray(out) ? { ...(out as object), changedByUser: changed } : out;
}

async function callToolHere(name: string, input: unknown, actor: Actor, s: Services): Promise<unknown> {
  const contract = (tools as Record<string, ToolContract>)[name];
  if (!contract) throw new ToolError("NOT_FOUND", `unknown tool ${name}`);
  const inp = (input ?? {}) as any;
  try {
    // the trust boundary (desktop, HTTP, MCP, the assistant): an input that does not fit the contract is refused with what
    // is wrong, instead of failing deep inside (resume.save with no name died on `undefined.trim()`, 2026-10-07)
    const fits: boolean = Value.Check(contract.input, inp); // a plain boolean: Check is a type guard and would narrow `inp`
    if (!fits) {
      const errs = [...Value.Errors(contract.input, inp)].slice(0, 3).map((e) => `${e.path || "/"} ${e.message}`);
      throw new ToolError("BAD_INPUT", `${name} 的参数不对：${errs.join("；")}`);
    }
    const inHarness = mayConfirmInHarness(actor, s);
    // deciding a card and undoing: the person, or (ADR-047) the person's own harness for its own doings — checked in the handlers
    if (name === "proposal.decide" && actor.kind !== "human" && !inHarness) throw new ToolError("FORBIDDEN", "only a human entry point can decide proposals");
    // Credentials, the choice of model and the user's browser are not things an agent may even propose: a proposal would
    // park its payload (an API key, an auth code) in the database.
    if (actor.kind === "agent" && HUMAN_ONLY.has(name) && !(name === "history.undo" && inHarness)) throw new ToolError("FORBIDDEN", "这个操作只能由本人在界面里完成");
    if (actor.kind === "agent" && !isAgentDirect(contract) && name !== "proposal.decide" && name !== "history.undo") {
      if (name === "fact.upsert") checkFact(inp); // the model learns the right shape now, not the user at approval time
      // ⑤ past the budget every write becomes a card: the built-in assistant and an embedded turn count per turn (overflow),
      // an external harness has no turn and is counted over the last ten minutes
      const external = actor.cred === "agent";
      const overflow = actor.overflow
        || (external && externalWritesRecently(s) >= maxWritesPerTurn(s))
        || (actor.cred === "turn" && !!actor.turnId && (s.domain.db.prepare("select count(*) as n from agent_action where turn_id = ?").get(actor.turnId) as { n: number }).n >= maxWritesPerTurn(s));
      const tier = overflow ? "ask" : tierOf(name, contract, inp, s, external);
      if (tier === "ask") {
        const proposal = s.domain.createProposal(name, inp, actorLabel(actor), (inp.note ?? inp.reason ?? "") as string, undefined, actor.turnId);
        s.domain.audit(actorLabel(actor), name, inp, true, `proposal ${proposal.id}`);
        const note = inHarness ? "这个操作需要用户同意：向用户复述这件事，用户同意后调 proposal.decide({ id, decision: \"approved\", payloadHash })；不同意则 rejected"
          : actor.cred === "turn" ? "这个操作需要用户确认：已生成确认卡，用户在对话里点确认后才执行"
          : actor.cred === "agent" ? "这个操作需要用户确认：已生成确认卡，请用户到 Zhiro 窗口「今日」点确认"
          : "这个操作需要用户确认：已生成确认卡，用户点确认后才执行";
        return { proposal, note };
      }
      // ADR-025 「直接做」: local and reversible — executed now, logged, undoable from the chat
      const inverse = undoPlan(name, inp, s);
      if (contract.effects.localWrite && name !== "position.watch") poolDirty();
      if (external) externalInFlight++;
      let out: any;
      try { out = await withPurpose(name, String(inp.applicationId ?? inp.id ?? ""), () => executeDirect(name as ToolName, inp, actor, s)); }
      finally { if (external) externalInFlight--; }
      const action = recordAction(s, actorLabel(actor), name, inp, inverse(out), out, actor.turnId);
      s.domain.audit(actorLabel(actor), name, inp, true, `action ${action.id}`);
      return { ...out, action, ...(inHarness ? { note: "已执行。用户要撤销时调 history.undo({ id: action.id })" } : {}) };
    }
    // the caller will expect to see its own write in the pool; position.watch keeps the pool cache current itself
    if (contract.effects.localWrite && name !== "position.watch") poolDirty();
    const out = await withPurpose(name, String(inp.applicationId ?? inp.id ?? ""), () => executeDirect(name as ToolName, inp, actor, s));
    s.domain.audit(actorLabel(actor), name, inp, true);
    return out;
  } catch (e: any) {
    s.domain.audit(actorLabel(actor), name, inp, false, String(e?.message ?? e));
    // ADR-032: no model of our own — an agent gets the prompt to answer itself, then calls the tool again
    if (e?.code === "MODEL_DELEGATED" && e.job && actor.kind === "agent")
      return { needsModel: { jobId: e.job.id, kind: e.job.kind, purpose: e.job.purpose, systemPrompt: e.job.system, user: e.job.user, next: "按 systemPrompt 的要求作答后调 llm.reply({jobId, text})，再重新调用本工具（参数不变）" } };
    if (e instanceof ToolError || e instanceof DomainError || e instanceof NotFound) throw new ToolError((e as any).code ?? "ERROR", e.message);
    if (typeof e?.code === "string") throw new ToolError(e.code, e.message);
    throw e;
  }
}

export function listContracts(): ToolContract[] {
  return Object.values(tools) as ToolContract[];
}
