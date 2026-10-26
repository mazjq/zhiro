import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../services.js";
import { verifyNotice } from "../service/notice-verify.js";

/**
 * notice_verify: a batch's announcement checked again because the person is preparing to apply to one of its posts.
 * In the background, never in the way of the preparing; held by the allowance like the other model work Zhiro starts.
 */
export function noticeVerify(s: Services): WorkflowDef {
  return {
    kind: "notice_verify",
    order: ["check"],
    steps: {
      check: async ({ subjectId: campaignId }) => {
        if (!s.llm) return { type: "done" };
        try {
          await verifyNotice(s, { campaignId });
        } catch (e: any) {
          if (e?.code === "BUDGET_DEFERRED") throw e; // waits for the allowance, then reads again
          // ponytail: any other failure leaves the batch as it was (what was known still stands); the next preparing tries again
        }
        return { type: "done" };
      },
    },
  };
}

/** Check a batch's announcement soon, once an hour at most: the same batch prepared twice is read once. */
export function checkNoticeSoon(s: Services, campaignId: string): void {
  const c = s.domain.db.prepare("select notice_url, apply_url from campaign where id = ?").get(campaignId) as { notice_url: string; apply_url: string } | undefined;
  if (!c || !/^https?:\/\//i.test(c.notice_url || c.apply_url || "")) return;
  // preparing never fails for this: where no workflows run (tests, evals, maintenance) the check is simply not started
  try { s.workflows.start("notice_verify", campaignId, `notice_verify:${campaignId}:${new Date().toISOString().slice(0, 13)}`); } catch { /* not registered */ }
}
