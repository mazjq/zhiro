import { moka } from "./moka.js";
import { beisen } from "./beisen.js";
import { feishuBase } from "./feishu-base.js";
import { feishuJobs } from "./feishu-jobs.js";
import { zhilian } from "./zhilian.js";
import { iguopin } from "./iguopin.js";
import { chnenergy } from "./chnenergy.js";
import { chng } from "./chng.js";
import { dayee } from "./dayee.js";
import { job51 } from "./job51.js";
import { kuaishou, xiaohongshu } from "./own-sites.js";
import { csv } from "./csv.js";
import { gaoxiaojob } from "./gaoxiaojob.js";
import { tupu360 } from "./tupu360.js";
import type { Source } from "../types.js";

/** A push source is registered for discovery/documentation; its listings arrive via a tool (listing.capture). */
export const capturePush: Source = { id: "capture", name: "任意页面抓取", mode: "push", describe: "任意招聘页/简章：书签一键捕获，或给 URL 由 daemon 抓取（公众号/就业网/官网），模型抽取岗位" };

/** The registry: a reader is in the system once it is in this list. */
export const sources: Record<string, Source> = Object.fromEntries([moka, beisen, feishuBase, feishuJobs, zhilian, iguopin, chnenergy, chng, dayee, job51, tupu360, kuaishou, xiaohongshu, gaoxiaojob, csv, capturePush].map((s) => [s.id, s]));

export function sourceFor(url: string): Source | undefined {
  return Object.values(sources).find((s) => s.detect?.(url));
}

/** "moka:voyah/146293" — the identity of a career site, whichever page of it a URL points at. */
export function siteKeyOf(url: string): string {
  const src = sourceFor(url);
  return src ? `${src.id}:${src.siteKey?.(url) ?? url}` : url;
}

/** Readers whose rows are a transcription (a 汇总表). "sheet" is a source kind older rows may still carry. */
export const aggregateIds = (): string[] => [...Object.values(sources).filter((s) => s.aggregate).map((s) => s.id), "sheet"];
export const isAggregate = (sourceId: string): boolean => aggregateIds().includes(sourceId);
/** The same list as an SQL literal list, for `source_kind not in (…)`: the ids are constants of this code, not input. */
export const aggregateSql = (): string => aggregateIds().map((id) => `'${id}'`).join(",");
export const isNotices = (sourceId: string): boolean => !!sources[sourceId]?.notices;
export const readerName = (sourceId: string): string => sources[sourceId]?.name ?? sourceId;
