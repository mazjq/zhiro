import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import { PROVIDERS, type MailAccount, type MailFetcher, type RawMail } from "./inbox.js";

const MAX_PER_FOLDER = 200;

/**
 * Read-only IMAP. Opens each folder without marking anything seen, fetches what arrived since `since`, decodes MIME
 * (mailparser handles GBK / base64 / quoted-printable, which Chinese HR systems use freely).
 * - 163 refuses clients that do not identify themselves ("Unsafe Login") — imapflow sends the ID command from clientInfo.
 * - The junk folder is read too: automated HR mail lands there often enough that skipping it would silently lose interviews.
 */
export const imapFetcher: MailFetcher = async (account: MailAccount, since: Date, opts = {}): Promise<RawMail[]> => {
  const p = PROVIDERS[account.provider];
  const client = new ImapFlow({
    host: p.host, port: p.port, secure: true, logger: false,
    auth: { user: account.email, pass: account.authCode },
    clientInfo: { name: "Zhiro", version: "0.0.1", vendor: "Zhiro", "support-email": account.email },
  });
  await client.connect();
  const out: RawMail[] = [];
  try {
    const boxes = await client.list();
    const junk = boxes.find((b) => b.specialUse === "\\Junk") ?? boxes.find((b) => /^(junk|spam|垃圾邮件|垃圾箱)/i.test(b.name));
    for (const folder of ["INBOX", ...(junk ? [junk.path] : [])]) {
      const lock = await client.getMailboxLock(folder, { readOnly: true });
      try {
        const query = opts.messageId ? { header: { "message-id": opts.messageId } } : { since };
        const uids = ((await client.search(query, { uid: true })) || []).slice(-MAX_PER_FOLDER);
        if (uids.length) for await (const msg of client.fetch(uids, { uid: true, source: true }, { uid: true })) {
          const source = msg.source as Buffer;
          const mail = await simpleParser(source);
          const html = typeof mail.html === "string" ? mail.html : "";
          const text = (mail.text || html.replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, "").replace(/<[^>]+>/g, " ")).replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
          out.push({
            messageId: mail.messageId || `${account.id}:${folder}:${msg.uid}`,
            from: mail.from?.text ?? "", subject: mail.subject ?? "", date: (mail.date ?? new Date()).toISOString(),
            text, html, eml: source.length < 5_000_000 ? source : undefined, folder: folder === "INBOX" ? "" : "垃圾箱",
          });
        }
      } finally { lock.release(); }
    }
  } finally { await client.logout().catch(() => {}); }
  return out;
};
