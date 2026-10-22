import type { WorkflowDef } from "../service/workflow.js";
import type { Services } from "../registry.js";
import { updateConfig } from "../config.js";
import { DomainError } from "../service/domain.js";
import { budgetSettings } from "../budget/index.js";
import { examQuiet } from "../budget/quiet.js";
import { deliver, enqueue, noticeStages, type Channel } from "../notify/center.js";
import { findUser, readers, sendCard, token, urgent, type FeishuApp } from "../notify/feishu.js";

const EVERY_MIN = 2;

/** The Feishu app bot from the settings, as the center's channel; not ready until the app and the person are set. */
export function feishuChannel(s: Services): Channel {
  const f = () => s.config.feishu;
  const app = (): FeishuApp => ({ appId: f().appId ?? "", appSecret: f().appSecret ?? "" });
  const me = () => f().receiveId ?? "";
  return {
    ready: () => !!(f().appId && f().appSecret && me() && (f().receiveIdType ?? "open_id") === "open_id"),
    send: (c) => sendCard(app(), me(), c),
    readBy: async (mid) => (await readers(app(), mid)).includes(me()),
    press: (mid, how) => urgent(app(), mid, me(), how),
  };
}

const options = (s: Services) => {
  const set = budgetSettings(s.config);
  return {
    sms: s.config.notify?.sms !== false,
    phone: s.config.notify?.phone === true,
    // during a test's quiet span only that test's own notices go out
    quiet: (now: number) => { const why = examQuiet(s.domain.db, now, set.quietBeforeMins, set.quietAfterMins); return why ? { why } : null; },
  };
};

/** notice_deliver: every two minutes, file the notices of tests on record, then send, ask and press. Never held back. */
export function noticeDeliver(s: Services): WorkflowDef {
  return {
    kind: "notice_deliver",
    order: ["deliver"],
    steps: {
      deliver: async () => {
        noticeStages(s.domain.db);
        const r = await deliver(s.domain.db, feishuChannel(s), Date.now(), options(s));
        if (r.sent || r.read) s.onBackgroundChanged?.("notices");
        return { type: "sleep", until: new Date(Date.now() + EVERY_MIN * 60_000).toISOString(), checkpoint: { last: new Date().toISOString(), ...r } };
      },
    },
  };
}

export function scheduleNotices(s: Services): void {
  s.workflows.ensure("notice_deliver", "notices", "notice_deliver:notices");
}

/**
 * notify.setup: the person gives the app's ID and secret and the phone number or e-mail they log in to Feishu with;
 * the app is checked, the person found, the settings kept, and a first card sent at once. Whether it arrived shows
 * when Feishu reports it read (notice.list).
 */
export async function setupFeishu(s: Services, i: { appId: string; appSecret: string; who: string }) {
  const app = { appId: i.appId.trim(), appSecret: i.appSecret.trim() };
  if (!/^cli_[a-z0-9]+$/i.test(app.appId)) throw new DomainError("BAD_INPUT", "App ID 应该是 cli_ 开头的一串");
  await token(app); // a wrong ID or secret stops here
  let openId: string | null;
  try { openId = await findUser(app, i.who); }
  catch (e: any) { throw new DomainError("FEISHU_PERMISSION", `找人的权限还没生效：确认开了「通过手机号或邮箱获取用户 ID」并发布了版本（${String(e?.message ?? e).slice(0, 80)}）`); }
  if (!openId) throw new DomainError("NOT_FOUND", "飞书里按这个手机号 / 邮箱没找到你：用飞书登录用的那个，并确认应用的可用范围里有你");
  const feishu = { ...s.config.feishu, appId: app.appId, appSecret: app.appSecret, receiveId: openId, receiveIdType: "open_id" };
  updateConfig(s.config.vault, (doc) => { doc.feishu = { ...(doc.feishu ?? {}), appId: feishu.appId, appSecret: feishu.appSecret, receiveId: openId, receiveIdType: "open_id" }; });
  s.config.feishu = feishu;
  const now = Date.now();
  const id = enqueue(s.domain.db, { key: `test:${now}`, kind: "test", urgency: "info", title: "Zhiro 已接通飞书", lines: ["以后笔试、面试、截止和投递进展会发到这里。", "在手机上看到这条，Zhiro 的设置页会显示「已在手机上看到」。"] }, now);
  const r = await deliver(s.domain.db, feishuChannel(s), now, options(s));
  scheduleNotices(s);
  if (!r.sent) throw new DomainError("SEND_FAILED", "应用和你都找到了，但测试消息没发出去：看看「以应用的身份发消息」权限和机器人能力是否已发布");
  return { ok: true, noticeId: id };
}
