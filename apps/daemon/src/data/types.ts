/**
 * Data-source contract.
 *
 * Borrowed conventions, deliberately:
 *  - Field names follow schema.org/JobPosting (title, hiringOrganization→company, jobLocation→locations,
 *    datePosted, validThrough, employmentType, identifier→externalId, url) so listings from any site map 1:1
 *    onto the JSON-LD most career pages already emit.
 *  - Source shape follows career-ops' provider contract (`id`, optional `detect`, `fetch(config, ctx)`), so the
 *    ~90 vendored providers can be wrapped without adapters, and ctx carries the same http helpers.
 *  - Three kinds of data (ARCHITECTURE §6): sources produce *observations* (immutable snapshot files +
 *    source_listing rows); ingest normalizes them into *state* (campaign/position in SQLite); *knowledge*
 *    (研报/画像/简历) is file-canonical and never written by a source.
 */
import type { Static } from "@zhiro/contracts";
import { Grade } from "@zhiro/contracts";
import type { Db } from "../db.js";
import type { Table } from "./sheet.js";

export type GradeT = Static<typeof Grade>;

export interface Listing {
  /** provider-scoped stable id (schema.org identifier). Falls back to url when the source has none. */
  externalId: string;
  url: string;
  /** the announcement page when it differs from the apply link */
  noticeUrl?: string;
  title: string;
  company: string;
  companyType?: string;
  industry?: string;
  orgUnit?: string;
  locations: string[];
  description?: string;
  employmentType?: string;
  datePosted?: string;
  /** schema.org validThrough — the application deadline when the source states one */
  validThrough?: string;
  deadlineText?: string;
  degreeReq?: string;
  majorReq?: string;
  /** 校招 extensions */
  cohort?: string;
  batch?: string;
  kind?: string;
  publisher: string;
  grade: GradeT;
  isOriginal: boolean;
  confidence: number;
  raw?: unknown;
}

export interface SourceContext {
  fetchJson(url: string, opts?: any): Promise<unknown>;
  fetchText(url: string, opts?: any): Promise<string>;
  sleep(ms: number): Promise<void>;
  maxPages?: number;
  signal?: AbortSignal;
  log(msg: string): void;
}

/** One configured instance of a source (a row under `sources:` in jobos.yaml). */
export interface SourceConfig {
  id: string;
  source: string;
  name?: string;
  url?: string;
  cohort?: string;
  batch?: string;
  kind?: string;
  keywords?: string[];
  maxPages?: number;
  /** hours between pulls; 0 = manual only */
  everyHours?: number;
  enabled?: boolean;
  /** a table subscription: which column is read as what (data/sheet.ts Columns); absent = the built-in 17-column layout */
  columns?: Record<string, string>;
  [k: string]: unknown;
}

/**
 * A group portal is subscribed once per unit that links it (中船: five institutes → one root, 1,262 posts each time).
 * Same key within six hours = the same answer, no second crawl. Listings carry no per-subscription data.
 */
const recentPulls = new Map<string, { at: number; listings: Listing[] }>();
export async function pullOnce(key: string, pull: () => Promise<Listing[]>): Promise<Listing[]> {
  const hit = recentPulls.get(key);
  if (hit && Date.now() - hit.at < 6 * 3600_000) return hit.listings;
  const listings = await pull();
  recentPulls.set(key, { at: Date.now(), listings });
  return listings;
}

export interface Source {
  id: string;
  /** what a person calls it */
  name: string;
  /** what a link to it looks like, for the person adding one */
  input?: string;
  /** the rows are someone's transcription of the postings (a 汇总表): never 官方, and a row carries no post id of its own */
  aggregate?: boolean;
  /** it reads a group's announcements and their station lists — there is no page per post to read a JD from */
  notices?: boolean;
  /** pull: daemon fetches on a schedule. push: something posts listings to us (bookmarklet, csv, webhook). */
  mode: "pull" | "push";
  describe: string;
  /** used by capture routing and by `detect`-style auto-config */
  detect?(url: string): boolean;
  /** One site = one subscription: two URLs with the same key are the same career site (a job page vs the list page). */
  siteKey?(url: string): string;
  fetch?(config: SourceConfig, ctx: SourceContext): Promise<Listing[]>;
  /** a reader of tables hands the table over as it is: what a preview shows, and what `fetch` reads by the subscription's column mapping */
  table?(config: SourceConfig, ctx: SourceContext): Promise<Table>;
}

/**
 * What the data layer works with, and all it knows of the process around it: the database, the data directory, the
 * live list of subscriptions, and two things to call when something changed. No tools, no agent, no model.
 */
export interface DataContext {
  db: Db;
  vault: string;
  /** `sources:` of jobos.yaml, edited in place so every holder of the list sees the change */
  sources: SourceConfig[];
  /** schedules the daily pulls; absent in a one-shot run */
  workflows?: { ensure(kind: string, subjectId: string, idempotencyKey: string): string; end(idempotencyKey: string): void };
  /** a pull brought or closed posts: matching reruns */
  onDataChanged?(): void;
  /** a pull changed posts it had brought before (a date, a city, a post back up), and brought or closed none */
  onPostsEdited?(): void;
  /** a pull of this subscription has started (`running`), or is over (「更新情况」 shows it under way, then its result) */
  onPull?(configId: string, running: boolean): void;
  onSourcesChanged?(): void;
}
