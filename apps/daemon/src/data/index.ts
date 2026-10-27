/**
 * The data layer (ADR-042): readers, subscriptions, the one ingest path, the catalog of companies / campaigns / posts,
 * and the daily sync. It imports the database and the workflow engine and nothing above them — no tools, no agent,
 * no model, no UI (data/boundary.test.ts holds that line). Everything outside this directory imports from this file.
 */
export type { Listing, Source, SourceConfig, SourceContext, DataContext, GradeT } from "./types.js";
export { pullOnce } from "./types.js";
export { sources, sourceFor, siteKeyOf, aggregateIds, isAggregate, aggregateSql, isNotices, readerName } from "./readers/index.js";
export { httpContext, publicUrl, isLocalPath, assertPublic, guardedFetch, guardedFetchTo } from "./http.js";
export { ingest, recordFailedRun, campaignUrl, releaseClaims, type IngestResult, type Listed } from "./ingest.js";
export { importFeed, liveFeedConfigs, feedConfigId, checkManifest, cleanListing, signedPart, FEED_PROTOCOL, type FeedConfig, type FeedManifest, type FeedSub, type FeedResult } from "./feed.js";
export { runSource, type Progress, listSources, previewSource, forgetPreviews, reasonOf, SYNC_REASONS, sourceScan, scheduleSources } from "./sync.js";
export { addSource, removeSource, saveSources } from "./subscriptions.js";
export { parseCsv, parseDeadline, splitList, gradeFromSource, FIELDS, BUILTIN_COLUMNS, guessColumns, csvToTable, listingsFromTable, type Columns, type Table } from "./sheet.js";
export { genericCompany, companyKey, sha, campaignKey, upsertCompany, upsertCampaign, upsertPosition, type CampaignInput, type PositionExtra } from "./catalog.js";
// two readers lend a part of themselves to the layer above: any public Bitable (a name list), and a 51job page's links
export { readBase, parseBaseUrl } from "./readers/feishu-base.js";
export { siteLinks } from "./readers/job51.js";
