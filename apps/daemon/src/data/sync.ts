import type { WorkflowDef } from "../service/workflow.js";
import { sources, sourceFor, siteKeyOf } from "./readers/index.js";
import { FIELDS, guessColumns, tableToListings, type Columns, type Table } from "./sheet.js";
import { httpContext } from "./http.js";
import { ingest, recordFailedRun, type IngestResult, type Listed } from "./ingest.js";
import { incompleteWhy, type DataContext, type SourceConfig } from "./types.js";
import { saveSources } from "./subscriptions.js";

/** Why a career site could not be read, as one of a few words a person or an agent can act on (ADR-041). */
export const SYNC_REASONS: Record<string, string> = {
  NO_OFFICIAL_LINK: "还没有这家公司的官网招聘链接", UNSUPPORTED_PLATFORM: "官网用的招聘系统还读不了", TIMEOUT: "官网超时没响应", LOGIN_REQUIRED: "官网要登录才能看",
  BLOCKED: "被官网拦了（验证码或访问限制）", SCHEMA_CHANGED: "官网改版，读取方式要更新", DECRYPT_FAILED: "官网返回的数据解不开", ZERO_POSTS: "官网读到了，但一个岗位都没有",
  SITE_DOWN: "官网打不开", SITE_GONE: "招聘站已撤或换了地址", LINK_STALE: "链接指向的岗位已下线，要换成公司的招聘主页",
  ELSEWHERE: "这里只是宣传页，岗位在公司的另一个招聘系统上", FAILED: "读取失败",
  NOT_PUBLIC: "表格没有公开，读不到", BAD_URL: "链接不是这类招聘站的地址", NO_COMPANY_COLUMN: "没认出哪一列是公司", EMPTY_TABLE: "表格读到了，但没有一行能成岗位", FILE_NOT_FOUND: "找不到这个文件",
};
export function reasonOf(error: string): string {
  const code = /^([A-Z_]{4,}):/.exec(error)?.[1];
  if (code && code in SYNC_REASONS && !(code === "SITE_DOWN" && /\b(404|410)\b/.test(error))) return code;
  if (/timeout|timed out|ETIMEDOUT|aborted|超时/i.test(error)) return "TIMEOUT";
  if (/\b401\b|login|登录/i.test(error)) return "LOGIN_REQUIRED";
  if (/\b(403|429)\b|captcha|验证码|forbidden/i.test(error)) return "BLOCKED";
  if (/decrypt|解密/i.test(error)) return "DECRYPT_FAILED";
  // gone (the platform says the site does not exist, or the page is not there) is not down: one waits, the other needs a new address
  if (/未找到对应的官网|官网不存在|\b(404|410)\b/.test(error)) return "SITE_GONE";
  if (/ENOTFOUND|ECONNREFUSED|ECONNRESET|fetch failed|\b5\d\d\b/i.test(error)) return "SITE_DOWN";
  if (/没找到有岗位|没有岗位/.test(error)) return "ZERO_POSTS";
  if (/JSON|Unexpected token|返回异常|not iterable|undefined|parameter error|没找到企业编号|没有换到/i.test(error)) return "SCHEMA_CHANGED";
  return "FAILED";
}

/**
 * A pull under way, as 「更新情况」 shows it: reading (with rows read / rows in all, when the reader says) or filing.
 * In memory only — a pull is minutes at most, and after a restart none is under way.
 */
export interface Progress { stage: "reading" | "filing"; since: string; done: number; total: number }
const running = new Map<string, Progress>();

/** Pull one subscription now and file what it returned. A failure is recorded as a run of its own. */
export async function runSource(ctx: DataContext, configId: string, opts: { quiet?: boolean } = {}): Promise<{ ok: true; result: IngestResult; listed: Listed } | { ok: false; error: string }> {
  const cfg = ctx.sources.find((c) => c.id === configId);
  if (!cfg) return { ok: false, error: `NOT_FOUND: source config ${configId}` };
  const src = sources[cfg.source];
  if (!src?.fetch) return { ok: false, error: `NOT_FOUND: source kind ${cfg.source} is not a pull source` };
  const progress: Progress = { stage: "reading", since: new Date().toISOString(), done: 0, total: 0 };
  running.set(cfg.id, progress);
  ctx.onPull?.(cfg.id, true);
  // a reader that pages through a big table says how far it is as "<read>/<all>" (feishu-base: 3000/13754)
  const log = (m: string) => { console.log(`[scan] ${m}`); const n = /: (\d+)\/(\d+)$/.exec(m); if (n) { progress.done = Number(n[1]); progress.total = Number(n[2]); } };
  const stats = { requests: 0 }, t0 = Date.now();
  const cost = () => ({ fetchMs: Date.now() - t0, requests: stats.requests });
  // what the library knows, then what the reader finds out: kept on the subscription only when the read works
  const learned: Partial<SourceConfig> = { ...(src.hint?.(cfg, ctx.db) ?? {}) };
  try {
    const listings = await src.fetch({ ...cfg, ...learned }, { ...httpContext(log, undefined, stats), learn: (p) => Object.assign(learned, p) });
    const read = cost();
    if (Object.entries(learned).some(([k, v]) => cfg[k] !== v)) {
      log(`${cfg.id}: 记下 ${JSON.stringify(learned)}`);
      Object.assign(cfg, learned);
      saveSources(ctx, [...ctx.sources]);
    }
    // a career site that answers with nothing is not "no change": it moved, changed or went quiet. Say so, and leave the
    // posts already known as they are (ADR-041). A keyword search that finds nothing is a normal answer.
    if (!listings.length && !cfg.discover && !cfg.keywords?.length) throw new Error(src.table ? "EMPTY_TABLE: 表格读到了，但没有一行能成岗位（没有公司、已过截止、或届次对不上的行都不算）" : "ZERO_POSTS: 官网读到了，但一个岗位都没有");
    Object.assign(progress, { stage: "filing", done: 0, total: listings.length });
    await new Promise((ok) => setImmediate(ok)); // a page asking right now sees 「比对入库」 before the one short transaction
    const partial = incompleteWhy(listings);
    if (partial) log(`${cfg.id}: 没读完（${partial}），这次不关岗位`);
    const { listed, ...result } = ingest(ctx, ctx.vault, src.id, cfg.id, listings, { closeUnseen: true, complete: !partial, ...read });
    // a batch fires it once at the end instead of after every site; a read that found the same posts as yesterday
    // changed nothing worth re-matching the pool for (most of the ~3,000 daily reads: 2026-10-13, 357 of 2,984 brought a new post)
    if (!opts.quiet && (result.positionsNew || result.positionsClosed)) ctx.onDataChanged?.();
    // posts it brought before, changed in place: the pages show it; matching keeps its pace (new and closed posts above)
    else if (result.updated) ctx.onPostsEdited?.();
    return { ok: true, result, listed };
  } catch (e: any) {
    const error = String(e?.message ?? e);
    recordFailedRun(ctx, src.id, cfg.id, error, cost());
    return { ok: false, error };
  } finally {
    if (running.get(cfg.id) === progress) running.delete(cfg.id); // a second pull of it started meanwhile keeps its own
    ctx.onPull?.(cfg.id, false);
  }
}

export function listSources(ctx: DataContext) {
  const kinds = Object.values(sources).map((x) => ({ id: x.id, mode: x.mode, describe: x.describe }));
  const configured = ctx.sources.map((c) => {
    const runs = ctx.db.prepare("select started_at, found, new_positions, complete, error from scan_run where config_id = ? order by started_at desc limit 10").all(c.id) as any[];
    const r = runs[0], firstOk = runs.findIndex((x) => !x.error);
    return {
      id: c.id, source: c.source, name: c.name ?? "", url: c.url ?? "", enabled: c.enabled !== false, everyHours: c.everyHours ?? 24, auto: c.auto === true,
      lastRun: r ? { at: r.started_at, found: r.found, newPositions: r.new_positions, complete: !!r.complete, error: r.error } : null,
      // health from what the runs themselves say: when it last worked, how many times in a row it has not, and why
      health: { lastOkAt: (runs[firstOk]?.started_at ?? null) as string | null, failures: firstOk < 0 ? runs.length : firstOk, reason: r?.error ? reasonOf(r.error) : "" },
      ...(running.has(c.id) ? { running: { ...running.get(c.id)! } } : {}),
    };
  });
  return { kinds, configured };
}

/**
 * source_scan: one workflow per subscription. Step `pull` runs the reader, ingests, then sleeps `everyHours`.
 * A failure is recorded in scan_run and is never the end of it: the next try comes in an hour for the first three in a
 * row, then at the subscription's own pace — for as long as the subscription exists. (The engine gives a failing step
 * five tries and then stops for good; 253 of 1,416 subscriptions had gone quiet that way by 2026-10-12.)
 *
 * What trying again cannot fix soon — a block, a login, a site whose format changed — gets no quick retries and waits
 * twice as long each time, up to a week: hammering a block makes it worse, and a changed site needs new code, not
 * another read (2026-10-14…28: 106 subscriptions failed every day for two weeks). A site that answers with no posts
 * keeps its pace: its new season can open any day. ponytail: a reader fixed in a new version still waits out its
 * week; 「立即更新」 reads it at once.
 */
const RETRY_SOON_MS = 60 * 60_000, SOON_TRIES = 3, WEEK_MS = 7 * 24 * 3600_000;
const STUCK = new Set(["BLOCKED", "LOGIN_REQUIRED", "SCHEMA_CHANGED", "DECRYPT_FAILED", "SITE_GONE", "LINK_STALE", "ELSEWHERE"]);
export function retryAfter(error: string, failures: number, pace: number): number {
  if (STUCK.has(reasonOf(error))) return Math.max(pace, Math.min(WEEK_MS, pace * 2 ** (failures - 1)));
  return failures <= SOON_TRIES ? Math.min(RETRY_SOON_MS, pace) : pace;
}
/** Scheduled reads of one platform start at least this far apart (one reader's own paging is its own business). */
const PLATFORM_GAP_MS = 1_000;
const lastStart = new Map<string, number>();
export function sourceScan(ctx: DataContext): WorkflowDef {
  return {
    kind: "source_scan",
    order: ["pull"],
    steps: {
      pull: async ({ subjectId, checkpoint }) => {
        const cfg = ctx.sources.find((c) => c.id === subjectId);
        if (!cfg || cfg.enabled === false) return { type: "done" };
        const gap = ctx.platformGapMs ?? PLATFORM_GAP_MS, wait = (lastStart.get(cfg.source) ?? 0) + gap - Date.now();
        if (wait > 0) await new Promise((ok) => setTimeout(ok, wait));
        lastStart.set(cfg.source, Date.now());
        const r = await runSource(ctx, subjectId);
        const hours = cfg.everyHours ?? 24;
        if (hours <= 0) return { type: "done" };
        const pace = hours * 3600_000;
        if (!r.ok) {
          const failures = (checkpoint?.failures ?? 0) + 1;
          return { type: "sleep", until: new Date(Date.now() + retryAfter(r.error, failures, pace)).toISOString(), checkpoint: { ...checkpoint, failures, lastError: r.error } };
        }
        return { type: "sleep", until: new Date(Date.now() + pace).toISOString(), checkpoint: { lastRunId: r.result.runId } };
      },
    },
  };
}

/** Idempotent: one running workflow per enabled subscription — also for one that was removed and is back. */
export function scheduleSources(ctx: DataContext): number {
  let n = 0;
  for (const c of ctx.sources) {
    if (c.enabled === false || (c.everyHours ?? 24) <= 0) continue;
    ctx.workflows?.ensure("source_scan", c.id, `source_scan:${c.id}`);
    n++;
  }
  return n;
}

/**
 * What adding a link would bring, without filing anything: which reader takes it, and — for a table — its columns, which
 * of them is read as what, how many posts that makes and the first three. `problem` says why it cannot be added yet.
 */
const PREVIEW_KEEP_MS = 3 * 60_000;
let previewed: { key: string; at: number; table: Table } | null = null; // one at a time: the last table looked at
/** Drop the table kept from the last preview (tests answer the same link with different tables). */
export const forgetPreviews = (): void => { previewed = null; };

export async function previewSource(ctx: DataContext, p: { url: string; columns?: Columns; cohort?: string }) {
  const url = p.url.trim();
  const src = sourceFor(url);
  if (!src?.fetch) throw Object.assign(new Error(`UNSUPPORTED_URL: 还认不出这个链接是哪种招聘站或表格：${url}`), { code: "UNSUPPORTED_URL" });
  const subscribed = ctx.sources.find((c) => c.url && siteKeyOf(c.url) === siteKeyOf(url))?.id ?? null;
  const fields = (Object.keys(FIELDS) as (keyof typeof FIELDS)[]).map((field) => ({ field: field as string, label: FIELDS[field] as string, required: field === "company" }));
  const base = { source: src.id, name: src.name, subscribed, fields };
  if (!src.table) return { ...base, table: false, headers: [] as string[], columns: {} as Record<string, string>, rows: 0, posts: 0, companies: 0, sample: [] as { company: string; title: string; deadline: string; cities: string[]; url: string }[], problem: "" };
  const key = `${src.id}:${url}`;
  const table = previewed && previewed.key === key && Date.now() - previewed.at < PREVIEW_KEEP_MS ? previewed.table : await src.table({ id: "preview", source: src.id, url }, httpContext());
  previewed = { key, at: previewed?.key === key ? previewed.at : Date.now(), table };
  // a mapping names columns that exist; anything else in it is dropped rather than read as empty
  const columns = Object.fromEntries(Object.entries(p.columns ?? guessColumns(table.headers)).filter(([f, h]) => f in FIELDS && table.headers.includes(h as string))) as Columns;
  const listings = columns.company ? tableToListings(table, columns, { cohort: p.cohort }) : [];
  const problem = !table.rows.length ? "表是空的" : !columns.company ? `没认出哪一列是公司。现有的列：${table.headers.slice(0, 20).join("、")}`
    : !listings.length ? "没有一行能成岗位：公司为空、已过截止、或届次对不上的行都不算" : "";
  return { ...base, table: true, headers: table.headers, columns: columns as Record<string, string>, rows: table.rows.length, posts: listings.length, companies: new Set(listings.map((l) => l.company)).size,
    sample: listings.slice(0, 3).map((l) => ({ company: l.company, title: l.title, deadline: l.deadlineText ?? "", cities: l.locations, url: l.url })), problem };
}
