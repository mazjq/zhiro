import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../registry.js";
import { inboxDeps } from "../registry.js";
import { loadAccounts, pullAll } from "../service/inbox.js";
import { withPurpose } from "../service/usage.js";
import { imapFetcher } from "../service/imap.js";

const EVERY_MIN = 30;

/** inbox_poll: one workflow for all connected mailboxes; pulls, classifies, proposes, then sleeps. */
export function inboxPoll(s: Services): WorkflowDef {
  return {
    kind: "inbox_poll",
    order: ["pull"],
    steps: {
      pull: async () => {
        if (!loadAccounts(s.config.vault).length) return { type: "done" };
        const r = await withPurpose("inbox.poll", "", () => pullAll(inboxDeps(s), imapFetcher));
        if (r.added || r.proposals) s.onBackgroundChanged?.("inbox"); // a recruiting mail filed, or a card made from one
        const until = new Date(Date.now() + EVERY_MIN * 60_000).toISOString();
        return { type: "sleep", until, checkpoint: { last: new Date().toISOString(), ...r, errors: r.errors.slice(0, 3) } };
      },
    },
  };
}

/** Idempotent; call at startup and after a mailbox is connected. */
export function scheduleInbox(s: Services): void {
  // ensure, not start (B26): the poll ends itself when the last mailbox goes, and a later connect must set it going again
  if (loadAccounts(s.config.vault).length) s.workflows.ensure("inbox_poll", "inbox", "inbox_poll:inbox");
}
