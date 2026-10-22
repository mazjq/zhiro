import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** Migrations are append-only. Never edit a shipped entry; add a new one. */
export const MIGRATIONS: string[] = [
  `
  create table meta (key text primary key, value text not null);
  create table company (
    id text primary key, name text not null unique, aliases text not null default '[]',
    type text not null default '', industry text not null default '', created_at text not null
  );
  create table campaign (
    id text primary key, company_id text not null references company(id),
    external_key text not null unique,
    kind text not null default '校招', cohort text not null default '', batch text not null default '',
    cities text not null default '[]', degree_req text not null default '', major_req text not null default '',
    opens_at text, closes_at text, deadline_kind text not null default 'unknown', deadline_text text not null default '',
    apply_url text not null default '', notice_url text not null default '',
    source_grade text not null default '聚合', source_kind text not null default '',
    has_written_test text not null default '', notes text not null default '',
    last_verified_at text, created_at text not null, updated_at text not null
  );
  create index campaign_closes on campaign(closes_at);
  create table position (
    id text primary key, campaign_id text not null references campaign(id),
    title text not null, jd_text text not null default '', cities text not null default '[]',
    degree_req text not null default '', status text not null default 'open',
    direction_tags text not null default '[]', last_seen_at text,
    watch_priority integer, watch_note text not null default '',
    created_at text not null, updated_at text not null,
    unique(campaign_id, title)
  );
  create table source_listing (
    id text primary key, position_id text references position(id), campaign_id text references campaign(id),
    provider text not null, tenant text not null default '', external_id text not null default '',
    url text not null default '', publisher text not null default '', grade text not null default '聚合',
    is_original integer not null default 0, extracted_json text not null default '{}', confidence real not null default 0,
    content_path text not null default '', fetched_at text not null
  );
  create table application (
    id text primary key, position_id text not null references position(id), campaign_id text not null references campaign(id),
    state text not null default 'draft', close_reason text not null default '', channel text not null default '',
    external_app_id text not null default '', referral_code text not null default '',
    submitted_at text, next_action text not null default '', next_action_at text,
    created_at text not null, updated_at text not null,
    unique(position_id)
  );
  create table application_event (
    id text primary key, application_id text not null references application(id),
    at text not null, kind text not null, detail text not null default '', source text not null default 'manual'
  );
  create table stage (
    id text primary key, application_id text not null references application(id),
    kind text not null, scheduled_at text, tz text not null default 'Asia/Shanghai', location text not null default '',
    link text not null default '', result text not null default '', notes text not null default '', created_at text not null
  );
  create table proposal (
    id text primary key, kind text not null, payload_json text not null, payload_hash text not null,
    created_by text not null, reason text not null default '', decision text not null default 'pending',
    expires_at text not null, decided_at text, result_json text, created_at text not null
  );
  create table fact (
    id text primary key, key text not null, statement text not null, grade text not null default '待验证',
    source text not null default '', created_at text not null
  );
  create table import_row (
    row_hash text primary key, source text not null, raw_json text not null, campaign_id text, imported_at text not null
  );
  create table workflow (
    id text primary key, kind text not null, subject_id text not null, state text not null default 'running',
    current_step text not null default '', idempotency_key text not null unique,
    checkpoint_json text not null default '{}', next_run_at text, attempts integer not null default 0,
    lease_until text, last_error text not null default '', created_at text not null, updated_at text not null
  );
  create index workflow_next on workflow(state, next_run_at);
  create table audit (
    id text primary key, at text not null, actor text not null, tool text not null,
    input_json text not null, ok integer not null, detail text not null default ''
  );
  create table capture (
    id text primary key, url text not null, title text not null default '', text_path text not null,
    publisher text not null default '', created_at text not null
  );
  `,
  `
  create table scan_run (
    id text primary key, source text not null, config_id text not null default '',
    started_at text not null, finished_at text, complete integer not null default 1,
    found integer not null default 0, new_positions integer not null default 0,
    error text not null default '', snapshot_path text not null default ''
  );
  create index scan_run_source on scan_run(source, started_at);
  `,
  `
  create table agent_run (
    id text primary key, runner text not null, mode text not null, subject_type text not null default '', subject_id text not null default '',
    subject_label text not null default '', run_dir text not null, session_id text not null default '', status text not null default 'queued',
    output_path text not null default '', summary text not null default '', error text not null default '',
    cost_usd real not null default 0, started_at text not null, finished_at text
  );
  create index agent_run_subject on agent_run(subject_type, subject_id, started_at);
  create table evidence (
    id text primary key, subject_type text not null, subject_id text not null, grade text not null,
    url text not null default '', title text not null default '', quote text not null default '',
    fetched_at text not null, report_path text not null default '', run_id text not null default ''
  );
  create index evidence_subject on evidence(subject_type, subject_id);
  `,
  // v4 (ADR-014/015/016): structured profile, company name key, recommendations. Old `fact` was never written.
  `
  alter table company add column norm text not null default '';
  create index company_norm on company(norm);
  drop table fact;
  create table document (
    id text primary key, path text not null, sha256 text not null unique, kind text not null default '',
    text_path text not null default '', egress text not null default 'allow', added_at text not null
  );
  create table fact (
    id text primary key, kind text not null, data_json text not null default '{}', statement text not null default '',
    grade text not null default '待验证', dedup_key text not null, created_at text not null, updated_at text not null,
    unique(kind, dedup_key)
  );
  create table fact_source (
    id text primary key, fact_id text not null references fact(id) on delete cascade,
    document_id text references document(id), quote text not null default '', locator text not null default '', added_at text not null
  );
  create index fact_source_fact on fact_source(fact_id);
  create table recommendation (
    id text primary key, company_id text not null references company(id), position_id text not null default '',
    mode text not null, tag text not null, score real not null default 0, reason text not null default '',
    run_id text not null default '', created_at text not null,
    unique(company_id, position_id, mode, tag)
  );
  create index recommendation_company on recommendation(company_id);
  `,
  // v5: ingest looks listings up by (provider, external_id); unindexed it was O(n²) and froze the daemon on a 57k-row sheet
  `
  create index source_listing_ext on source_listing(provider, external_id);
  `,
  // v6: which resume went out with an application (free text now; a resume-library id later)
  `
  alter table application add column resume_label text not null default '';
  `,
  // v7: user-defined 搜索模式 (AND / OR / NOT keyword searches kept by name)
  `
  create table recommend_preset (
    id text primary key, name text not null unique, params_json text not null default '{}', created_at text not null, updated_at text not null
  );
  `,
  // v8: documents are extracted in the background, one at a time
  `
  alter table document add column status text not null default 'done';
  alter table document add column facts integer not null default 0;
  alter table document add column error text not null default '';
  `,
  // v9: companyKey had a broken whitespace rule — recompute every key (Domain refills and folds the twins);
  // documents report which step of extraction they are in
  `
  update company set norm = '';
  alter table document add column stage text not null default '';
  alter table document add column started_at text;
  `,
  // v10: 最近删除 — the last few deleted fact cards, restorable
  `
  create table fact_trash (id text primary key, fact_json text not null, sources_json text not null default '[]', deleted_at text not null);
  `,
  // v11: recruiting mail (only mail that passed the recruiting filter is ever stored); body text lives in vault/inbox
  `
  create table message (
    id text primary key, account text not null, message_id text not null unique, sender text not null default '', subject text not null default '',
    received_at text not null, body_path text not null default '', category text not null default '其他', company text not null default '', position text not null default '',
    scheduled_at text, link text not null default '', summary text not null default '', confidence real not null default 0,
    application_id text references application(id), proposal_id text, status text not null default 'new', created_at text not null
  );
  create index message_received on message(received_at);
  `,
  // v12: inbox hardening — content-level dedup, interview rounds, junk-folder origin, why nothing was proposed; and a
  // subject-only log of mail the recruiting filter skipped, so a miss is visible and recoverable
  `
  alter table message add column content_key text not null default '';
  alter table message add column round text not null default '';
  alter table message add column note text not null default '';
  alter table message add column folder text not null default '';
  create index message_content on message(content_key);
  create table mail_skipped (
    account text not null, message_id text not null, sender text not null default '', subject text not null default '',
    received_at text not null, folder text not null default '', primary key (account, message_id)
  );
  `,
  // v13: 简历库 — files the user wrote, tagged with the 公司类型 and 岗位关键词 each was written for
  `
  create table resume (
    id text primary key, name text not null unique, file_name text not null default '', file_path text not null default '', text_path text not null default '',
    company_types text not null default '[]', role_keywords text not null default '[]', note text not null default '', is_default integer not null default 0, created_at text not null
  );
  `,
  // v14: 不投了 before submitting is "cancelled", not "closed" (ADR-023); rows closed without ever being submitted were exactly that
  `
  update application set state = 'cancelled' where state = 'closed' and submitted_at is null;
  `,
  // v15: the order the user dragged the cards into (画像页); 0 = never moved, falls back to creation order
  `
  alter table fact add column sort integer not null default 0;
  `,
  // v16: tokens per model call and what it was for (配置 → 模型用量)
  `
  create table llm_usage (
    id text primary key, at text not null, purpose text not null, ref text not null default '', provider text not null, model text not null,
    input integer not null default 0, output integer not null default 0, cache_read integer not null default 0, total integer not null default 0, cost real not null default 0
  );
  create index llm_usage_at on llm_usage(at);
  `,
  // v17: ADR-025 — writes the assistant did without asking, each with the inverse call an undo replays
  `
  create table agent_action (
    id text primary key, at text not null, actor text not null, tool text not null, input_json text not null,
    summary text not null default '', undo_json text, undone_at text
  );
  `,
  // v18: the assistant's transcript survives a daemon restart (one conversation; provider/model it was had with)
  `
  create table chat (
    id text primary key, provider text not null, model text not null, session_id text not null,
    messages_json text not null default '[]', updated_at text not null
  );
  `,
  // v19: the first 飞书招聘 sync (2026-09-22) pulled a tenant's 社招 portal into 校招 campaigns (bambulab/experienced, 387
  // jobs); the source now skips 社招 posts, this removes what it had ingested. Watched or applied positions stay.
  `
  create index if not exists source_listing_position on source_listing(position_id);
  create temp table gone_social as
    select p.id from position p
    where p.id in (select distinct position_id from source_listing where provider = 'feishu-jobs' and extracted_json like '%"kind":"社招"%' and position_id is not null)
      and p.watch_priority is null
      and p.id not in (select position_id from application);
  delete from source_listing where provider = 'feishu-jobs' and extracted_json like '%"kind":"社招"%';
  delete from gone_social where id in (select position_id from source_listing where position_id is not null);
  delete from position where id in (select id from gone_social);
  drop table gone_social;
  `,
  // v20: 企业情况 (ADR-029) — one row per company per kind of fact, each with its own fetched_at so staleness is visible;
  // and the 专精特新 roster loaded from a CSV the user or a worker maintains
  `
  create table company_intel (
    company_id text not null references company(id), kind text not null, data_json text not null default '{}',
    source text not null default '', fetched_at text not null, primary key(company_id, kind)
  );
  create table sme_list (
    name text primary key, level text not null, batch text not null default '', region text not null default '',
    source_url text not null default '', published_at text not null default '', updated_at text not null
  );
  `,
  // v21: a company can be on several 专精特新 lists (小巨人 + 重点小巨人 + 省级) — one row per (name, level)
  `
  drop table sme_list;
  create table sme_list (
    name text not null, level text not null, batch text not null default '', region text not null default '',
    source_url text not null default '', published_at text not null default '', updated_at text not null,
    primary key(name, level)
  );
  `,
  // v22: model work an external agent answers (ADR-032): kind 'complete' = one model call keyed by its prompt hash,
  // kind 'run' = a research worker run (id = agent_run.id); pending → answered → used
  `
  create table model_job (
    id text primary key, kind text not null default 'complete', hash text unique, purpose text not null default '', ref text not null default '',
    system text not null default '', user_text text not null default '', status text not null default 'pending', answer text,
    created_at text not null, answered_at text
  );
  create index model_job_status on model_job(status);
  `,
  // v23: 岗位适配度 (ADR-034). A post's own major requirement (it was only kept per campaign — the first post's), an index
  // the per-company lookups were missing, and the model's reading of a post against the profile (layer 2, on demand).
  `
  alter table position add column major_req text not null default '';
  create index if not exists campaign_company on campaign(company_id);
  create table position_fit (
    position_id text primary key references position(id), score integer not null, verdict text not null default '',
    meets text not null default '[]', gaps text not null default '[]', model text not null default '', profile_hash text not null default '',
    created_at text not null
  );
  `,
  // v24: 岗位适配度 v2 (ADR-035) — every requirement of a post judged against the profile (supported / transferable /
  // unknown / gap), kept per post so the 机会缺口 ledger aggregates them; user-confirmed gaps are the only negatives.
  `
  create table position_assessment (
    position_id text primary key references position(id), json text not null, profile_hash text not null default '', rules_version text not null default '',
    created_at text not null
  );
  create table user_gap (
    concept_id text primary key, status text not null default 'confirmed', note text not null default '', created_at text not null
  );
  `,
  // v25: what a person (or their agent, after research) says about a deadline lives beside the source's value, so the
  // next pull of that source cannot put the sheet's date back (ADR-035); a post's own deadline when its source states one
  `
  alter table campaign add column closes_at_override text;
  alter table campaign add column override_note text not null default '';
  alter table campaign add column overridden_at text;
  alter table position add column closes_at text;
  `,
  // v26: 期望卡 (ADR-036) — one 期望 (preference) card per field, the values on it are OR; cards that shared a field merge
  // into the oldest one, and the dedup key becomes the field alone
  `
  update fact set data_json = json_set(data_json, '$.value', (select group_concat(json_extract(f2.data_json, '$.value'), '、') from fact f2 where f2.kind = 'preference' and json_extract(f2.data_json, '$.field') = json_extract(fact.data_json, '$.field')))
    where kind = 'preference' and created_at = (select min(f3.created_at) from fact f3 where f3.kind = 'preference' and json_extract(f3.data_json, '$.field') = json_extract(fact.data_json, '$.field'));
  delete from fact where kind = 'preference' and created_at <> (select min(f3.created_at) from fact f3 where f3.kind = 'preference' and json_extract(f3.data_json, '$.field') = json_extract(fact.data_json, '$.field'));
  update fact set dedup_key = coalesce(json_extract(data_json, '$.field'), dedup_key), statement = coalesce(json_extract(data_json, '$.field'), '') || ' · ' || coalesce(json_extract(data_json, '$.value'), '') where kind = 'preference';
  `,
  // v27: 读页 (ADR-038) — every page the assistant or a job read, for the day cache, the browser budget and the audit trail
  `
  create table page_read (
    id text primary key, url text not null, final_url text not null default '', status text not null, via text not null,
    chars integer not null default 0, text_path text not null default '', created_at text not null
  );
  create index page_read_url on page_read(url, created_at);
  `,
  // v28: 截止与岗位身份 (ADR-041).
  //  - deadline_fact: what a source said about a deadline (for a post, a batch or a company) with its evidence;
  //    deadline_override: the person's own word (date / 招满即止 / 无固定截止 / 官方未写), which outranks every source.
  //  - position.source_key: the site's own id for a post. Posts were unique per (campaign, title), which merged three
  //    same-titled posts in three cities into one; identity is now (campaign, title, source_key). SQLite cannot drop a
  //    table constraint, so the table is rebuilt — with foreign keys off, as SQLite prescribes for this.
  //  - application.progress_url: where the applicant checks progress; reminder_sent: one row per reminder ever sent.
  `/* foreign_keys:off */
  create table position_new (
    id text primary key, campaign_id text not null references campaign(id),
    title text not null, jd_text text not null default '', cities text not null default '[]',
    degree_req text not null default '', status text not null default 'open',
    direction_tags text not null default '[]', last_seen_at text,
    watch_priority integer, watch_note text not null default '',
    created_at text not null, updated_at text not null,
    major_req text not null default '', closes_at text, source_key text not null default ''
  );
  insert into position_new(id, campaign_id, title, jd_text, cities, degree_req, status, direction_tags, last_seen_at, watch_priority, watch_note, created_at, updated_at, major_req, closes_at)
    select id, campaign_id, title, jd_text, cities, degree_req, status, direction_tags, last_seen_at, watch_priority, watch_note, created_at, updated_at, major_req, closes_at from position;
  drop table position;
  alter table position_new rename to position;
  create unique index position_identity on position(campaign_id, title, source_key);
  create table deadline_fact (
    id text primary key, subject_type text not null, subject_id text not null, event text not null default 'application_close',
    policy text not null, date_start text, date_end text, precision text not null default 'day', applies text not null default 'this_position',
    grade text not null, source_kind text not null default '', url text not null default '', evidence text not null default '',
    content_hash text not null, by text not null default '', created_at text not null, superseded_at text,
    unique(subject_type, subject_id, content_hash)
  );
  create index deadline_fact_subject on deadline_fact(subject_type, subject_id);
  create table deadline_override (
    subject_type text not null, subject_id text not null, kind text not null, date text, note text not null default '',
    by text not null default '', at text not null, primary key(subject_type, subject_id)
  );
  insert into deadline_override(subject_type, subject_id, kind, date, note, by, at)
    select 'campaign', id, case when coalesce(closes_at_override, '') = '' then 'unknown' else 'date' end, nullif(closes_at_override, ''), override_note, '', overridden_at from campaign where overridden_at is not null;
  alter table application add column progress_url text not null default '';
  create table reminder_sent (key text primary key, sent_at text not null);
  `,
  // v29: deleting a campaign makes SQLite look for listings that still point at it (foreign key); without this index
  // that was a scan of the whole listing table per campaign
  `create index source_listing_campaign on source_listing(campaign_id);`,
  // v30: the same for posts. v19 creates this index, but the line was added to v19 after the user's library had
  // already run it, so that library never had it: there, deleting one post scanned all 12 万 listings (a tidy at start
  // took five and a half minutes, 2026-10-13). A library made fresh already has the index.
  `create index if not exists source_listing_position on source_listing(position_id);`,
  // v31: the settings page asks for each subscription's last runs; with 1,500 subscriptions and no index on config_id
  // that was 1,500 scans of the run history — 5 s for source.list on the user's library, the daemon answering nothing
  // meanwhile, after every add / remove / update (2026-10-13; 0.02 s with the index)
  `create index if not exists scan_run_config on scan_run(config_id, started_at);`,
  // v32: ADR-045 — a write or a card made by a harness the daemon started for one chat turn carries that turn's id, so the
  // drawer shows exactly this turn's doings (not whatever another caller did meanwhile)
  `
  alter table agent_action add column turn_id text;
  alter table proposal add column turn_id text;
  `,
  // v33: ADR-046 — a chat turn answered by a harness's command line (Claude Code / Codex): JobOS's own record of what was
  // asked and answered, by whom, what it cost; the harness keeps the full conversation under its session id
  `
  create table chat_turn (
    id text primary key, backend text not null, session_id text not null default '', user_text text not null, answer text not null default '',
    status text not null default 'running', cost_usd real, cost_kind text not null default 'unknown', error text not null default '',
    started_at text not null, finished_at text
  );
  create index chat_turn_backend on chat_turn(backend, started_at);
  `,
  // v34: ADR-057 — model work goes back to the external agent whose call started it; which one is recorded
  `
  alter table model_job add column caller text not null default '';
  `,
  // v35: ADR-062 — a confirm card whose work answers later is marked while that work runs ('running'), so it never looks
  // approved before the work is done; one left running by a stopped daemon is 'interrupted' at the next start and waits
  // for the person. Null on every other card. (proposal is a small table: adding two columns touches no other table.)
  `
  alter table proposal add column execution text;
  alter table proposal add column execution_started_at text;
  `,
  // v36: ADR-050 — every upgrade leaves a line here: when, from / to which schema, by which program, where the original went
  `
  create table upgrade_log (at text not null, from_v integer not null, to_v integer not null, app_version text not null, backup text not null default '');
  `,
  // v37: D-27 — BOSS 直聘 visits through the person's agent: one row per one-time permit (issued → used), and the stops
  `
  create table boss_visit (
    id text primary key, session_id text not null, requested_at text not null, not_before text not null, expires_at text not null,
    consumed_at text, target text not null, kind text not null, outcome text not null default 'issued', detail text not null default ''
  );
  create index boss_visit_at on boss_visit(requested_at);
  create index boss_visit_session on boss_visit(session_id);
  `,
  // v38: D-28 — BOSS posts seen on a search page, kept as candidates until their job page is read (then position_id)
  `
  create table boss_candidate (
    job_id text primary key, url text not null, title text not null, salary text not null default '', city text not null default '',
    district text not null default '', experience text not null default '', degree text not null default '', days text not null default '',
    months text not null default '', brand text not null default '', scale text not null default '', stage text not null default '',
    industry text not null default '', skills text not null default '[]', labels text not null default '[]', query text not null default '',
    city_code text not null default '', first_seen text not null, last_seen text not null, position_id text, detail_at text
  );
  create index boss_candidate_seen on boss_candidate(last_seen);
  `,
  // v39: D-29 — the A-share list and one industry's statements for a year, kept with the time they were fetched, so a
  // comparison of employers can say which data it used and be run again on the same data
  `
  create table peer_snapshot (key text primary key, fetched_at text not null, data_json text not null);
  `,
  // v40: P5 — what the person's model allowance looked like when it was read (Codex app-server, Claude Code's
  // rate_limit_event): one row per window per reading, so background work can see how fast each window fills
  `
  create table budget_reading (id integer primary key, at text not null, channel text not null, win text not null, used real not null, resets_at text, duration_mins integer);
  create index budget_reading_win on budget_reading(channel, win, at);
  `,
];

/**
 * Tables whose row count a migration changes on purpose, by the version it brings the database to. The upgrade check
 * (upgrade.ts) holds every other table to the count it had before. Empty: v1–v35 were never upgraded through it.
 */
export const COUNTS_MAY_CHANGE: Record<number, string[]> = {};

export const SCHEMA_VERSION = MIGRATIONS.length;

export type Db = DatabaseSync;

/** The database file and the program disagree on the schema; nothing was written. */
export class SchemaMismatch extends Error {
  constructor(public code: "NEEDS_UPGRADE" | "TOO_NEW" | "GAPPED" | "NOT_OURS", public have: number, message: string) { super(message); }
}

/**
 * The schema version a database file is at, read without writing anything (no WAL switch, no table made): 0 for a file
 * that is not there or empty. Versions must run 1..n without a hole — a hole means something other than these
 * migrations wrote the table.
 */
export function schemaOf(path: string): number {
  if (path === ":memory:" || !existsSync(path)) return 0;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const has = (name: string) => !!db.prepare("select 1 from sqlite_master where type = 'table' and name = ?").get(name);
    if (!has("schema_version")) {
      if (has("company")) throw new SchemaMismatch("NOT_OURS", 0, `这个数据库没有版本记录，不是 Zhiro / JobOS 建的：${path}`);
      return 0;
    }
    const r = db.prepare("select count(*) as n, coalesce(max(v), 0) as v, coalesce(min(v), 1) as lo from schema_version").get() as { n: number; v: number; lo: number };
    if (r.n !== r.v || r.lo !== 1) throw new SchemaMismatch("GAPPED", r.v, `数据库的版本记录不连续（${r.n} 条，最高 v${r.v}），不打开：${path}`);
    return r.v;
  } finally { db.close(); }
}

/**
 * Open the database at this program's schema. A new (or empty) file gets every migration here; one at an older version
 * is refused — only the upgrade (upgrade.ts, under the data directory's lock, on a copy) moves a database that holds
 * data. One at a newer version is refused before anything is written to it.
 */
export function openDb(path: string): Db {
  const have = schemaOf(path);
  if (have > SCHEMA_VERSION) throw new SchemaMismatch("TOO_NEW", have, `数据是更新的版本写的（数据库 v${have}，这个程序只认到 v${SCHEMA_VERSION}）。请装新版本，或用 \`zhiro vault rollback\` 回到升级前`);
  if (have > 0 && have < SCHEMA_VERSION) throw new SchemaMismatch("NEEDS_UPGRADE", have, `数据库是 v${have}，需要先升级到 v${SCHEMA_VERSION}：启动一次 Zhiro，或运行 \`zhiro vault upgrade\``);
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("pragma journal_mode = wal; pragma foreign_keys = on;");
  if (have === 0) migrate(db);
  return db;
}

/** Run the migrations a database lacks. Only for a new database (openDb) and the upgrade's candidate copy (upgrade.ts). */
export function migrate(db: Db, migrations: string[] = MIGRATIONS): void {
  db.exec("create table if not exists schema_version (v integer primary key)");
  const row = db.prepare("select max(v) as v from schema_version").get() as { v: number | null };
  const current = row.v ?? 0;
  for (let i = current; i < migrations.length; i++) {
    // a table rebuild needs foreign keys off, and that pragma is a no-op inside a transaction
    const rebuild = migrations[i].includes("/* foreign_keys:off */");
    if (rebuild) db.exec("pragma foreign_keys = off");
    db.exec("begin");
    try {
      db.exec(migrations[i]);
      db.prepare("insert into schema_version(v) values (?)").run(i + 1);
      db.exec("commit");
    } catch (e) { db.exec("rollback"); throw e; }
    if (rebuild) {
      db.exec("pragma foreign_keys = on");
      const broken = db.prepare("pragma foreign_key_check").all();
      if (broken.length) throw new Error(`migration v${i + 1} left ${broken.length} dangling references`);
    }
  }
}

export function now(): string {
  return new Date().toISOString();
}

const depth = new WeakMap<Db, number>();

/** Nested-safe transaction: outermost uses BEGIN IMMEDIATE, inner levels use SAVEPOINTs. */
export function tx<T>(db: Db, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  depth.set(db, d + 1);
  const sp = `sp${d}`;
  db.exec(d === 0 ? "begin immediate" : `savepoint ${sp}`);
  try {
    const r = fn();
    db.exec(d === 0 ? "commit" : `release ${sp}`);
    return r;
  } catch (e) {
    db.exec(d === 0 ? "rollback" : `rollback to ${sp}; release ${sp}`);
    throw e;
  } finally {
    depth.set(db, d);
  }
}

export const json = {
  parse<T>(s: string | null | undefined, fallback: T): T {
    if (!s) return fallback;
    try {
      return JSON.parse(s) as T;
    } catch {
      return fallback;
    }
  },
  str(v: unknown): string {
    return JSON.stringify(v ?? null);
  },
};
