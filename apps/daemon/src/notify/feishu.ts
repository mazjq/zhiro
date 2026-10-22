/**
 * The Feishu app bot (企业自建应用) as a notice channel: a private card to the person, whether they have read it
 * (read_users — for a message the bot sent, within 7 days), and the three ways to press (加急: in the app, by SMS, by a
 * phone call). A group webhook cannot say whether anyone read it, so it is not used for notices that must be confirmed.
 * Plain fetch; the tenant token is kept until a few minutes before it expires.
 */
import { createHash } from "node:crypto";

const BASE = "https://open.feishu.cn/open-apis";

export interface FeishuApp { appId: string; appSecret: string }
export interface Card { title: string; lines: string[]; url?: string; tone?: "red" | "orange" | "blue" | "green" }

const tokens = new Map<string, { token: string; until: number }>();
/** The cache key: the app and a hash of its secret — a changed secret is never answered by the old one's token. */
const keyOf = (app: FeishuApp) => `${app.appId}:${createHash("sha256").update(app.appSecret).digest("hex").slice(0, 12)}`;

async function api(app: FeishuApp, method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(BASE + path, { method, headers: { "content-type": "application/json; charset=utf-8", authorization: `Bearer ${await token(app)}` }, body: body === undefined ? undefined : JSON.stringify(body) });
  const out: any = await res.json().catch(() => ({}));
  if (out.code !== 0) throw Object.assign(new Error(`FEISHU_${out.code ?? res.status}: ${String(out.msg ?? res.statusText).slice(0, 160)}`), { code: "FEISHU_ERROR", feishuCode: out.code });
  return out.data ?? {};
}

/** The app's tenant token; also how a wrong App ID / Secret is found out. */
export async function token(app: FeishuApp, fresh = false): Promise<string> {
  const k = keyOf(app), hit = tokens.get(k);
  if (hit && hit.until > Date.now() && !fresh) return hit.token;
  const res = await fetch(`${BASE}/auth/v3/tenant_access_token/internal`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: app.appId, app_secret: app.appSecret }) });
  const out: any = await res.json().catch(() => ({}));
  if (!out.tenant_access_token) throw Object.assign(new Error(`FEISHU_AUTH: App ID 或 App Secret 不对（${String(out.msg ?? res.status).slice(0, 80)}）`), { code: "FEISHU_AUTH" });
  tokens.set(k, { token: out.tenant_access_token, until: Date.now() + Math.max(60, (out.expire ?? 7200) - 300) * 1000 });
  return out.tenant_access_token;
}

/** The person's open_id in this app, from the phone number or e-mail they log in to Feishu with; null when not found. */
export async function findUser(app: FeishuApp, who: string): Promise<string | null> {
  const w = who.trim();
  const body = w.includes("@") ? { emails: [w] } : { mobiles: [w.replace(/[\s-]/g, "").replace(/^\+?86(?=1\d{10}$)/, "")] };
  const d = await api(app, "POST", "/contact/v3/users/batch_get_id?user_id_type=open_id", body);
  return (d.user_list ?? []).find((u: any) => u.user_id)?.user_id ?? null;
}

export function card(c: Card) {
  const elements: any[] = [{ tag: "markdown", content: c.lines.join("\n") }];
  if (c.url) elements.push({ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开" }, type: "primary", url: c.url }] });
  return { config: { wide_screen_mode: true }, header: { title: { tag: "plain_text", content: c.title }, template: c.tone ?? "blue" }, elements };
}

/** A private card to `openId`; the message id, to ask later whether it was read. */
export async function sendCard(app: FeishuApp, openId: string, c: Card, dedupe?: string): Promise<string> {
  // uuid: Feishu sends at most one message per uuid within an hour — a retry after a lost answer is not a second card
  const d = await api(app, "POST", "/im/v1/messages?receive_id_type=open_id", { receive_id: openId, msg_type: "interactive", content: JSON.stringify(card(c)), ...(dedupe ? { uuid: dedupe.slice(0, 50) } : {}) });
  if (!d.message_id) throw Object.assign(new Error("FEISHU_SEND: 没拿到消息 id"), { code: "FEISHU_ERROR" });
  return d.message_id;
}

/** The open_ids who have read a message the bot sent (7 days at most). */
export async function readers(app: FeishuApp, messageId: string): Promise<string[]> {
  const ids: string[] = [];
  let page = "";
  for (let i = 0; i < 5; i++) {
    const d = await api(app, "GET", `/im/v1/messages/${messageId}/read_users?user_id_type=open_id&page_size=100${page ? `&page_token=${encodeURIComponent(page)}` : ""}`);
    for (const it of d.items ?? []) if (it.user_id) ids.push(it.user_id);
    if (!d.has_more || !d.page_token) break;
    page = d.page_token;
  }
  return ids;
}

/** 加急: "app" a banner that stays in Feishu, "sms" a text message, "phone" a call (the last two may cost the tenant). */
export async function urgent(app: FeishuApp, messageId: string, openId: string, how: "app" | "sms" | "phone"): Promise<void> {
  await api(app, "PATCH", `/im/v1/messages/${messageId}/urgent_${how}?user_id_type=open_id`, { user_id_list: [openId] });
}
