import { createHash } from "node:crypto";
import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../registry.js";
import { now } from "../db.js";
import { httpContext } from "../data/index.js";
import { fetchArticle, extractNotice, noticeToListings } from "../service/extract.js";
import { ingest, recordFailedRun } from "../data/index.js";

/**
 * capture_recheck: campaigns that came from a captured notice (push source) have no scheduled pull.
 * Every `everyHours` (default 72) re-fetch the notice URL: unchanged → touch last_verified_at; changed → re-extract & ingest
 * (same campaign key, so positions/deadline update in place); unreachable twice → note it on the campaign, never delete.
 */
export function captureRecheck(s: Services): WorkflowDef {
  return {
    kind: "capture_recheck",
    order: ["check"],
    steps: {
      check: async ({ subjectId: campaignId, checkpoint }) => {
        const c = s.domain.db.prepare("select c.id, c.notice_url, c.apply_url, c.notes, co.name as company from campaign c join company co on co.id = c.company_id where c.id = ? and c.source_kind = 'capture'").get(campaignId) as any;
        if (!c) return { type: "done" };
        const url: string = c.notice_url || c.apply_url;
        if (!/^https?:\/\//.test(url)) return { type: "done" };
        const every = ((s.config as any).recheck?.everyHours ?? 72) * 3600_000;
        const next = () => new Date(Date.now() + every).toISOString();
        let text = "", title = "";
        try {
          const a = await fetchArticle(url, httpContext());
          text = a.text; title = a.title;
        } catch (e: any) {
          const fails = (checkpoint?.fails ?? 0) + 1;
          recordFailedRun(s.domain, "capture", campaignId, `recheck: ${String(e?.message ?? e).slice(0, 200)}`);
          if (fails >= 2 && !/页面不可达/.test(c.notes)) {
            s.domain.db.prepare("update campaign set notes = trim(notes || ' ' || ?), updated_at = ? where id = ?").run(`[页面不可达 ${now().slice(0, 10)}]`, now(), campaignId);
          }
          return { type: "sleep", until: next(), checkpoint: { ...checkpoint, fails } };
        }
        const hash = createHash("sha256").update(text).digest("hex");
        if (checkpoint?.hash === hash) {
          s.domain.db.prepare("update campaign set last_verified_at = ? where id = ?").run(now(), campaignId);
          return { type: "sleep", until: next(), checkpoint: { hash, fails: 0 } };
        }
        if (checkpoint?.hash && s.llm) {
          try {
            const ex = await extractNotice(s.llm, text, url, title);
            if (ex.isRecruitment && ex.company) ingest(s.domain, s.config.vault, "capture", campaignId, noticeToListings(ex, url, "capture"));
          } catch (e: any) {
            recordFailedRun(s.domain, "capture", campaignId, `recheck extract: ${String(e?.message ?? e).slice(0, 200)}`);
          }
        }
        s.domain.db.prepare("update campaign set last_verified_at = ? where id = ?").run(now(), campaignId);
        return { type: "sleep", until: next(), checkpoint: { hash, fails: 0 } };
      },
    },
  };
}

export function scheduleRechecks(s: Services): number {
  const rows = s.domain.db.prepare("select id from campaign where source_kind = 'capture' and (notice_url like 'http%' or apply_url like 'http%')").all() as any[];
  for (const r of rows) s.workflows.start("capture_recheck", r.id, `capture_recheck:${r.id}`);
  return rows.length;
}
