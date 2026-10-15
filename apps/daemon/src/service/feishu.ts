import type { JobosConfig } from "../config.js";

/**
 * Feishu notify. Two paths, cheapest first:
 *  1. custom bot webhook (群自定义机器人): only needs webhookUrl; sends an interactive card.
 *  2. app bot (自建应用): appId/appSecret + receiveId; needed for private chat and (later) long-connection interaction.
 * ponytail: app bot path is a plain fetch; switch to @larksuiteoapi/node-sdk when M3 adds the WS event loop.
 */
export interface Card { title: string; lines: string[]; url?: string }

function card(c: Card) {
  const elements: any[] = [{ tag: "markdown", content: c.lines.join("\n") }];
  if (c.url) elements.push({ tag: "action", actions: [{ tag: "button", text: { tag: "plain_text", content: "打开" }, type: "primary", url: c.url }] });
  return { config: { wide_screen_mode: true }, header: { title: { tag: "plain_text", content: c.title }, template: "orange" }, elements };
}

export async function notify(cfg: JobosConfig["feishu"], c: Card): Promise<{ ok: boolean; messageId?: string }> {
  if (cfg.webhookUrl) {
    const res = await fetch(cfg.webhookUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ msg_type: "interactive", card: card(c) }) });
    const body: any = await res.json().catch(() => ({}));
    if (!res.ok || (body.code && body.code !== 0)) throw new Error(`SEND_FAILED: ${res.status} ${JSON.stringify(body).slice(0, 200)}`);
    return { ok: true };
  }
  if (cfg.appId && cfg.appSecret && cfg.receiveId) {
    const tok = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ app_id: cfg.appId, app_secret: cfg.appSecret }),
    }).then((r) => r.json() as Promise<any>);
    if (!tok.tenant_access_token) throw new Error("SEND_FAILED: token");
    const res = await fetch(`https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=${cfg.receiveIdType ?? "open_id"}`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${tok.tenant_access_token}` },
      body: JSON.stringify({ receive_id: cfg.receiveId, msg_type: "interactive", content: JSON.stringify(card(c)) }),
    });
    const body: any = await res.json().catch(() => ({}));
    if (body.code !== 0) throw new Error(`SEND_FAILED: ${JSON.stringify(body).slice(0, 200)}`);
    return { ok: true, messageId: body.data?.message_id };
  }
  const e: any = new Error("NOT_CONFIGURED");
  e.code = "NOT_CONFIGURED";
  throw e;
}
