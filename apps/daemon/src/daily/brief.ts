/**
 * 每日简报 (phase-1 plan P4, R1): every morning one card about what changed — not the whole board again. Four parts:
 *   今天必须做  tests and interviews within 48 h, deadlines within 3 days on posts held and not sent yet;
 *   新出现的    posts first seen since the last brief that match the profile (很对口 / 部分对口), not held yet;
 *   重新找过的  what the daily lookup of thin companies found since the last brief;
 *   悬着的      drafts left for 5 days or past their deadline, sent applications quiet for 14 days.
 * Built from rules only (no model). What was in an earlier brief and has not changed is left out (brief_item keeps
 * each item's content hash); the 必须做 part is always shown. A run is kept whole (brief_run) — brief.today reads it,
 * generating nothing — and goes out as one 「知道就行」 notice.
 */
import { createHash } from "node:crypto";
import { ulid } from "ulid";
import type { Db } from "../db.js";
import { deadlineBoard } from "../service/pool.js";
import { enqueue } from "../notify/center.js";

export interface BriefItem { key: string; text: string; why?: string; link?: { page: string; id?: string }; url?: string }
export interface Brief { id: string; at: string; since: string; must: BriefItem[]; fresh: BriefItem[]; found: BriefItem[]; hanging: BriefItem[] }

const H = 3600_000, DAY = 24 * H;
const hm = (iso: string) => new Date(iso).toLocaleString("zh-CN", { month: "numeric", day: "numeric", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false });
const hash = (x: unknown) => createHash("sha256").update(JSON.stringify(x)).digest("hex").slice(0, 16);

export function makeBrief(db: Db, now = Date.now()): Brief {
  const last = db.prepare("select at from brief_run order by at desc limit 1").get() as { at: string } | undefined;
  const since = last?.at ?? new Date(now - DAY).toISOString();
  const iso = (ms: number) => new Date(ms).toISOString();

  // 今天必须做
  const must: BriefItem[] = [];
  for (const r of db.prepare(`select s.id, s.kind, s.scheduled_at, s.link, co.name company, p.title, a.id app from stage s join application a on a.id = s.application_id
      join position p on p.id = a.position_id join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id
      where s.scheduled_at between ? and ? and (s.result is null or s.result = '') and a.state not in ('closed', 'cancelled') order by s.scheduled_at`).all(iso(now - H), iso(now + 48 * H)) as any[])
    must.push({ key: `must:stage:${r.id}:${r.scheduled_at}`, text: `${r.kind} ${hm(r.scheduled_at)} · ${r.company} · ${r.title}`, link: { page: "pipeline", id: r.app }, url: r.link || undefined });
  for (const r of db.prepare(`select id, category, round, company, scheduled_at, link from message where status = 'unlinked' and category in ('笔试', '测评', '面试', '面试改期') and scheduled_at between ? and ?`).all(iso(now - H), iso(now + 48 * H)) as any[])
    must.push({ key: `must:mail:${r.id}`, text: `${r.round || r.category} ${hm(r.scheduled_at)} · ${r.company}（邮件还没归到申请，去收件箱选一下）`, link: { page: "inbox" }, url: r.link || undefined });
  for (const d of deadlineBoard(db, 3).deadlines.filter((x) => !x.applied && x.daysLeft != null && x.daysLeft <= 3))
    must.push({ key: `must:deadline:${d.positionId ?? d.companyId}:${d.closesAt}`, text: `${d.daysLeft === 0 ? "今天" : `${d.daysLeft} 天后`}截止 · ${d.companyName} · ${d.title}${d.verified ? "" : "（截止未核实）"}`, link: { page: "pipeline" }, url: d.url || undefined });

  // 新出现的: matched posts first seen since the last brief, not held yet
  const fresh: BriefItem[] = (db.prepare(`select p.id, p.title, co.name company, r.reason, r.score from recommendation r join position p on p.id = r.position_id
      join campaign c on c.id = p.campaign_id join company co on co.id = c.company_id
      where r.mode = 'profile_match' and r.position_id != '' and p.created_at >= ? and p.status = 'open' and p.watch_priority is null
        and not exists (select 1 from application a where a.position_id = p.id) and (r.reason like '优先考虑%' or r.reason like '可迁移%')
      order by r.score desc limit 15`).all(since) as any[])
    .map((r) => ({ key: `new:${r.id}`, text: `${String(r.reason).startsWith("优先考虑") ? "很对口" : "部分对口"} · ${r.company} · ${r.title}`, why: String(r.reason).replace(/^(优先考虑|可迁移)[：:]?\s*/, "").slice(0, 60), link: { page: "jobs", id: r.id } }));

  // 重新找过的: the daily lookup of thin companies
  const found: BriefItem[] = [];
  const lr = db.prepare("select checkpoint_json, updated_at from workflow where kind = 'lead_resolve' order by updated_at desc limit 1").get() as any;
  if (lr && lr.updated_at >= since) {
    const cp = JSON.parse(lr.checkpoint_json || "{}");
    if (cp.attempted) found.push({ key: `found:${cp.last ?? lr.updated_at}`, text: `补全岗位信息：读了 ${cp.attempted} 家的公告，补出 ${cp.positions ?? 0} 个岗位，还剩 ${cp.remaining ?? "?"} 家待补`, link: { page: "jobs" } });
  }

  // 悬着的
  const hanging: BriefItem[] = [];
  for (const a of db.prepare(`select a.id, a.updated_at, co.name company, p.title, c.closes_at from application a join position p on p.id = a.position_id join campaign c on c.id = a.campaign_id
      join company co on co.id = c.company_id where a.state = 'draft'`).all() as any[]) {
    const past = a.closes_at && a.closes_at < iso(now).slice(0, 10);
    const idle = Date.parse(a.updated_at) < now - 5 * DAY;
    if (past) hanging.push({ key: `hang:past:${a.id}`, text: `草稿已过截止 · ${a.company} · ${a.title}：核实是否延期或补录，否则结束准备`, link: { page: "pipeline", id: a.id } });
    else if (idle) hanging.push({ key: `hang:idle:${a.id}`, text: `草稿放了 ${Math.floor((now - Date.parse(a.updated_at)) / DAY)} 天 · ${a.company} · ${a.title}：投还是不投？`, link: { page: "pipeline", id: a.id } });
  }
  for (const a of db.prepare(`select a.id, a.progress_url, co.name company, p.title, (select max(at) from application_event e where e.application_id = a.id) last
      from application a join position p on p.id = a.position_id join campaign c on c.id = a.campaign_id join company co on co.id = c.company_id where a.state = 'submitted'`).all() as any[])
    if (a.last && Date.parse(a.last) < now - 14 * DAY) hanging.push({ key: `hang:quiet:${a.id}`, text: `已投 ${Math.floor((now - Date.parse(a.last)) / DAY)} 天没动静 · ${a.company} · ${a.title}：去查一下进度`, link: { page: "pipeline", id: a.id }, url: a.progress_url || undefined });

  // past deadlines first (decide or close), then the longest left
  hanging.sort((x, y) => Number(y.key.startsWith("hang:past")) - Number(x.key.startsWith("hang:past")));
  return { id: ulid(), at: iso(now), since, must, fresh, found, hanging };
}

/** Keep only what is new or changed since it was last in a brief (必须做 always stays), and remember what was shown. */
export function keepChanged(db: Db, b: Brief): Brief {
  const seen = (it: BriefItem) => {
    const h = hash([it.text, it.url]);
    const prev = db.prepare("select hash from brief_item where key = ?").get(it.key) as { hash: string } | undefined;
    db.prepare("insert into brief_item(key, hash, first_at, last_at, run_id) values (?,?,?,?,?) on conflict(key) do update set hash = excluded.hash, last_at = excluded.last_at, run_id = excluded.run_id").run(it.key, h, b.at, b.at, b.id);
    return !prev || prev.hash !== h;
  };
  return { ...b, must: b.must.map((x) => (seen(x), x)), fresh: b.fresh.filter(seen), found: b.found.filter(seen), hanging: b.hanging.filter(seen) };
}

/** Make, keep and announce today's brief. */
export function runBrief(db: Db, now = Date.now()): Brief {
  const b = keepChanged(db, makeBrief(db, now));
  const empty = !b.must.length && !b.fresh.length && !b.found.length && !b.hanging.length;
  db.prepare("insert into brief_run(id, at, since, brief_json) values (?,?,?,?)").run(b.id, b.at, b.since, JSON.stringify(b));
  if (!empty) {
    const part = (title: string, xs: BriefItem[], n = 5) => (xs.length ? [`**${title} · ${xs.length}**`, ...xs.slice(0, n).map((x) => `· ${x.text}`), ...(xs.length > n ? [`· 还有 ${xs.length - n} 条，在 Zhiro「今日」里看`] : [])] : []);
    const day = new Date(now).toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", weekday: "short" });
    enqueue(db, { key: `brief:${b.at.slice(0, 10)}`, kind: "brief", urgency: "info", title: `今日简报 · ${day}`, lines: [...part("今天必须做", b.must), ...part("新出现的", b.fresh), ...part("重新找过的", b.found), ...part("悬着的", b.hanging)] }, now);
  }
  return b;
}

/** brief.today: the latest brief as it was made; nothing is generated here. */
export function latestBrief(db: Db): (Brief & { seenAt: string | null }) | null {
  const r = db.prepare("select brief_json, seen_at from brief_run order by at desc limit 1").get() as any;
  return r ? { ...JSON.parse(r.brief_json), seenAt: r.seen_at ?? null } : null;
}
