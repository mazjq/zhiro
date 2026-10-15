import type { Db } from "../db.js";

/**
 * Where an application form lives, and how well Zhiro fills it. The level is only raised on evidence:
 *   实测通过 — filled end to end on a real form by the user
 *   仿真通过 — drivers written from the platform's documented structure and passing on a replica page; not yet on a real one
 *   通用填写 — no platform-specific driver: the generic one (plain inputs, Element / Ant Design / ARIA controls) is used
 *   不支持   — there is no form to fill (a poster, a chat-based site)
 * `count` is how many of the user's relevant recruiting projects (tagged / watched / applied) point there.
 */
export type Level = "实测通过" | "仿真通过" | "通用填写" | "不支持";
export interface Platform { id: string; name: string; hosts: RegExp; level: Level; note: string }

export const PLATFORMS: Platform[] = [
  { id: "moka", name: "Moka", hosts: /mokahr\.com/i, level: "实测通过", note: "单项字段实测：下拉、年月、学校专业搜索、出生日期、籍贯三级联动；多段经历仅仿真通过；上传简历后等网站解析再补空" },
  { id: "beisen", name: "北森", hosts: /zhiye\.com|beisen/i, level: "通用填写", note: "弹层下拉、年月面板、日历、省市选择有专用驱动（验收后再升级）；多段经历只填第一段；进申请表需要你在职位页点一次「申请」" },
  { id: "feishu", name: "飞书招聘", hosts: /jobs\.feishu\.cn|jobs\.bytedance\.com/i, level: "仿真通过", note: "atsx 下拉、地区树、年月面板、多段经历；网站会解析上传的简历" },
  { id: "dayee", name: "大易（hotjob / WinTalent）", hosts: /hotjob\.cn|wintalent\.cn|dayee\.com/i, level: "通用填写", note: "新版 Ant Design 3（下拉、输入日期、级联）；不少租户仍是旧版 jQuery 页面" },
  { id: "wjx", name: "问卷星", hosts: /wjx\.(cn|top|com)/i, level: "通用填写", note: "真实公开表单读表全对；填空、单选、多选；日期 / 地区 / 学校弹层需你手动选" },
  { id: "iguopin", name: "国聘", hosts: /iguopin\.com/i, level: "通用填写", note: "Ant Design 5；日期框只读、需点选，暂列为留给你" },
  { id: "zhaopin", name: "智联招聘", hosts: /zhaopin\.com/i, level: "通用填写", note: "网申表单可能跳到别的系统，结构未核实" },
  { id: "51job", name: "前程无忧 51job", hosts: /51job\.com|yingjiesheng\.com/i, level: "通用填写", note: "网申页要登录后才能看，结构未核实；campus.51job.com 已停用" },
  { id: "self", name: "企业自建站（Element UI / Ant Design 等）", hosts: /./, level: "通用填写", note: "普通输入框、下拉、单选多选、日期、省市级联" },
];
const NO_FORM: Platform[] = [
  { id: "weixin", name: "公众号文章", hosts: /mp\.weixin\.qq\.com|doc\.weixin\.qq\.com/i, level: "不支持", note: "只是招聘海报，没有网申表单；投递入口通常在文中二维码或链接里" },
  { id: "boss", name: "BOSS直聘 / 猎聘", hosts: /zhipin\.com|liepin\.com/i, level: "不支持", note: "沟通式投递，没有网申表单" },
];

export function platformOf(url: string): Platform | null {
  let host = "";
  try { host = new URL(url).hostname; } catch { return null; }
  return [...NO_FORM, ...PLATFORMS].find((p) => p.hosts.test(host)) ?? null;
}

export function listPlatforms(db: Db) {
  const counts = new Map<string, number>();
  const rows = db.prepare(`select distinct c.id, c.apply_url from campaign c
    where exists (select 1 from recommendation r where r.company_id = c.company_id)
       or exists (select 1 from position p where p.campaign_id = c.id and p.watch_priority > 0)
       or exists (select 1 from application a where a.campaign_id = c.id and a.state != 'cancelled')`).all() as { apply_url: string }[];
  for (const r of rows) { const p = platformOf(r.apply_url ?? ""); if (p) counts.set(p.id, (counts.get(p.id) ?? 0) + 1); }
  return { items: [...PLATFORMS, ...NO_FORM].map(({ hosts: _h, ...p }) => ({ ...p, count: counts.get(p.id) ?? 0 })) };
}
