import { updateConfig } from "../config.js";
import { sourceFor, siteKeyOf } from "./readers/index.js";
import type { DataContext, SourceConfig } from "./types.js";
import type { Columns } from "./sheet.js";

/**
 * Subscriptions: the user's configuration of a reader — `sources:` in <vault>/config/jobos.yaml. The file stays the
 * authority; this module is the only code that writes that key.
 */
function write(vault: string, list: SourceConfig[]): void {
  updateConfig(vault, (doc) => { doc.sources = list; }); // a crash mid-write leaves the old file, not half of a new one
}

/** Replace the whole list (in the file and in memory). */
export function saveSources(ctx: DataContext, list: SourceConfig[]): void {
  write(ctx.vault, list);
  // a subscription that is gone stops being scheduled now — left sleeping until its next turn, it would be found
  // "already scheduled" if the same table came back today, and that table would not be read until tomorrow
  const kept = new Set(list.map((c) => c.id));
  for (const c of ctx.sources) if (!kept.has(c.id)) ctx.workflows?.end(`source_scan:${c.id}`);
  ctx.sources.splice(0, ctx.sources.length, ...list);
  ctx.onSourcesChanged?.();
}

/** Subscribe to the site a URL points at. One subscription per site: a second link into the same site returns the existing one (was 155 duplicates). */
export function addSource(ctx: DataContext, p: { url: string; name: string; cohort?: string; batch?: string; everyHours?: number; auto?: boolean; columns?: Columns }): { id: string; source: string } {
  p = { ...p, url: p.url.trim() };
  const src = sourceFor(p.url);
  if (!src) throw Object.assign(new Error(`UNSUPPORTED_URL: no pull source detects ${p.url}`), { code: "UNSUPPORTED_URL" });
  const key = siteKeyOf(p.url);
  const same = ctx.sources.find((c) => c.url && siteKeyOf(c.url) === key);
  if (same) return { id: same.id, source: same.source };
  const base = `${src.id}-${p.name.replace(/[^\w一-鿿]+/g, "").slice(0, 20) || "src"}`;
  let id = base;
  for (let i = 2; ctx.sources.some((c) => c.id === id); i++) id = `${base}-${i}`;
  const entry: SourceConfig = { id, source: src.id, name: p.name, url: p.url, cohort: p.cohort, batch: p.batch, everyHours: p.everyHours ?? 24, enabled: true, ...(p.auto ? { auto: true } : {}), ...(p.columns && src.table ? { columns: p.columns } : {}) };
  write(ctx.vault, [...ctx.sources, entry]);
  ctx.sources.push(entry);
  ctx.onSourcesChanged?.();
  return { id, source: src.id };
}

/** Unsubscribe. What the subscription had brought in is the caller's to clear (the posts a person holds must stay). */
export function removeSource(ctx: DataContext, id: string): SourceConfig {
  const cfg = ctx.sources.find((c) => c.id === id);
  if (!cfg) throw Object.assign(new Error(`NOT_FOUND: 没有这个订阅：${id}`), { code: "NOT_FOUND" });
  saveSources(ctx, ctx.sources.filter((c) => c.id !== id));
  return cfg;
}
