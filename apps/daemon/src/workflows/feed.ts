import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../registry.js";
import { importFeed, type FeedResult } from "../data/index.js";

/** Pull every configured feed (or one): each checked and filed whole, or not at all (data/feed.ts). */
export function pullFeeds(s: Services, only?: string): (FeedResult | { feed: string; error: string })[] {
  const out: (FeedResult | { feed: string; error: string })[] = [];
  for (const f of (s.config.feeds ?? []).filter((x) => x.enabled !== false && (!only || x.id === only))) {
    try {
      const r = importFeed(s.domain, s.config.vault, f, new Set(s.config.sources.filter((c) => c.enabled !== false).map((c) => c.id)));
      if (r.positionsNew || r.positionsClosed || r.applied) s.onDataChanged?.();
      out.push(r);
    } catch (e: any) { out.push({ feed: f.id, error: String(e?.message ?? e) }); }
  }
  return out;
}

/** feed_pull: every six hours, look for a newer package (a look at an unchanged manifest costs one small file read). */
export function feedPull(s: Services): WorkflowDef {
  return {
    kind: "feed_pull",
    order: ["pull"],
    steps: {
      pull: async () => {
        const results = pullFeeds(s);
        return { type: "sleep", until: new Date(Date.now() + 6 * 3600_000).toISOString(), checkpoint: { last: new Date().toISOString(), results } };
      },
    },
  };
}

export function scheduleFeeds(s: Services): void {
  if ((s.config.feeds ?? []).some((f) => f.enabled !== false)) s.workflows.ensure("feed_pull", "feeds", "feed_pull:feeds");
}
