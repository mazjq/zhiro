import { now } from "../db.js";
import { dataOf, type Services } from "../registry.js";
import type { WorkflowDef } from "../service/workflow.js";
import { spawnRun, readRun } from "./worker.js";
import { researchTarget } from "./route.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { sources, sourceFor, siteKeyOf, isAggregate, addSource, removeSource, reasonOf, SYNC_REASONS, httpContext } from "../data/index.js";
import { killTree } from "./backends/cli.js";
import { dropOrphanCampaigns } from "../service/tidy.js";

/**
 * 找新地址: a subscription whose address is wrong — the site went (SITE_GONE), the link points at a post that is gone
 * (LINK_STALE), or the page only sends applicants to another system (ELSEWHERE). Waiting does not fix that, a new
 * address does. A web-capable worker looks for it; the daemon switches the subscription only when the worker shows
 * the address from the company's own site, its verified 公众号 or the recruiting system itself (a search result is a
 * lead, not evidence), says it is the same company — not one of the same name — and the new address reads.
 * Asked once per subscription, address and reason: the same evidence is not put to the model twice.
 */
export const RELOCATE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["verdict", "url", "same_company", "evidence", "summary"],
  properties: {
    verdict: { type: "string", enum: ["moved", "season_over", "not_found"], description: "moved=找到了现在收简历的新地址；season_over=招聘站本季下线、还没有新站；not_found=没找到可靠的新地址" },
    url: { type: "string", description: "新地址（岗位列表页优先），verdict 不是 moved 时给空字符串" },
    same_company: { type: "boolean", description: "新地址上的公司就是订阅里这家（不是同名、同集团的另一家单位）" },
    evidence: {
      type: "array", maxItems: 3,
      items: {
        type: "object", additionalProperties: false, required: ["url", "kind", "says"],
        properties: {
          url: { type: "string", description: "你实际打开过的页面" },
          kind: { type: "string", enum: ["official_site", "wechat_verified", "ats", "search"], description: "official_site=公司官网；wechat_verified=已认证的公司公众号；ats=招聘系统本身的页面；search=搜索结果或第三方转载" },
          says: { type: "string", description: "这页上哪句话或哪个链接指向新地址" },
        },
      },
    },
    summary: { type: "string", description: "两句话：找到了什么、为什么认定是同一家" },
  },
} as const;
type Answer = { verdict: "moved" | "season_over" | "not_found"; url: string; same_company: boolean; evidence: { url: string; kind: string; says: string }[]; summary: string };

const readable = () => Object.values(sources).filter((x) => x.fetch && !isAggregate(x.id) && x.input).map((x) => `- ${x.name}：${x.input}`).join("\n");

const prompt = (name: string, url: string, error: string) => `你是校招信息员。今天：${now().slice(0, 10)}。
订阅「${name}」读不成了：${SYNC_REASONS[reasonOf(error)]}。
原地址：${url}
读取器的原话：${error.slice(0, 400)}

任务：找到这家公司现在收校招简历的地址。用 WebSearch / WebFetch。
- 新地址必须由公司官网、已认证的公司公众号、或招聘系统本身的页面给出；搜索结果和第三方转载只当线索，打开核实后才算。
- 必须是同一家公司：同名、同品牌、同集团的另一家单位都不算（例：siemens.tupu360 是西门子医疗，不是西门子中国）。
- 能自动读的招聘系统（新地址最好是其中之一的岗位列表页）：
${readable()}
- 招聘站只是本季下线、还没有下一季的站：verdict 写 season_over。找不到可靠的新地址：not_found，不要猜。
只输出符合 schema 的 JSON。`;

/** Claude Code is the person's own and in use: a read failing is no reason to spend it unasked (Codex, or the person's
 * own agent through the queue, may). ponytail: the background gate checks the built-in model's allowance, not the
 * research worker's; when it does, this goes. */
const mayRun = (s: Services, asked: boolean) => { const t = researchTarget(s); return asked || !(t.kind === "worker" && t.runner === "claude"); };

/** Started on every read that fails for one of these reasons; a second start for the same address and reason is the first. */
export function startRelocate(s: Services, configId: string, error: string, asked = false): string | null {
  const cfg = s.config.sources.find((c) => c.id === configId);
  if (!cfg?.url || !mayRun(s, asked)) return null;
  // the address and error are frozen here: the run asks about the address that failed, not one set meanwhile
  return s.workflows.start("source_relocate", configId, `source_relocate:${configId}:${reasonOf(error)}:${cfg.url}`, { error: error.slice(0, 600), url: cfg.url, asked });
}

const finish = (s: Services, runId: string, status: string, summary: string, costUsd = 0) =>
  s.domain.db.prepare("update agent_run set status = ?, summary = ?, error = ?, cost_usd = ?, finished_at = ? where id = ?")
    .run(status, summary.slice(0, 1500), status === "failed" ? summary.slice(0, 1000) : "", costUsd, now(), runId);

export function sourceRelocate(s: Services): WorkflowDef {
  return {
    kind: "source_relocate",
    order: ["ask", "collect"],
    steps: {
      ask: async ({ subjectId, checkpoint }) => {
        const cfg = s.config.sources.find((c) => c.id === subjectId);
        // unsubscribed or readdressed meanwhile, or the worker is now Claude Code: nothing to ask
        if (cfg?.url !== checkpoint.url || !mayRun(s, !!checkpoint.asked)) return { type: "done" };
        // ponytail: a crash between the spawn and this checkpoint asks twice; the run would need an id of its own first
        const { runId } = spawnRun(s, { mode: "source.relocate", subjectType: "source", subjectId, subjectLabel: cfg!.name ?? subjectId, prompt: prompt(cfg!.name ?? "", cfg!.url!, String(checkpoint.error)), schema: RELOCATE_SCHEMA, maxTurns: 25, maxBudgetUsd: 1 });
        return { type: "done", checkpoint: { ...checkpoint, runId } };
      },
      collect: async ({ subjectId, checkpoint }) => {
        if (!checkpoint.runId) return { type: "done" };
        const runId = String(checkpoint.runId);
        const row = s.domain.db.prepare("select * from agent_run where id = ?").get(runId) as any;
        if (!row) return { type: "fail", error: "agent_run missing" };
        const r = readRun(row.run_dir);
        if (r.status === "running") {
          if (row.runner !== "external" && (Date.now() - Date.parse(row.started_at)) / 60_000 > 20) {
            const pid = existsSync(join(row.run_dir, "pid.txt")) ? Number(readFileSync(join(row.run_dir, "pid.txt"), "utf8")) : 0;
            if (pid) killTree(pid);
            finish(s, runId, "failed", "20 分钟内没找完，已停止");
            return { type: "done" };
          }
          return { type: "sleep", until: new Date(Date.now() + 30_000).toISOString(), checkpoint };
        }
        if (r.status === "failed") { finish(s, runId, "failed", r.error ?? "failed"); return { type: "done" }; }
        finish(s, runId, "done", await apply(s, subjectId, String(checkpoint.url), r.structured as Answer), r.costUsd ?? 0);
        return { type: "done" };
      },
    },
  };
}

/** The new address read as a subscription would read it, nothing filed: how many posts it lists, or why it cannot be read. */
async function probe(url: string, name: string): Promise<{ posts: number } | { error: string }> {
  const src = sourceFor(url)!;
  try { return { posts: (await src.fetch!({ id: "relocate-probe", source: src.id, url, name }, httpContext(() => {}))).length }; }
  catch (e: any) { return { error: String(e?.message ?? e) }; }
}

/**
 * What the answer changes: the subscription switched to the new address, or nothing but the record of why not. The
 * new address is read first without subscribing it; the switch itself is one synchronous step after that read, so a
 * subscription changed meanwhile is seen and nothing is half-done.
 */
export async function apply(s: Services, oldId: string, oldUrl: string, a: Answer | undefined, read = probe): Promise<string> {
  const said = `${a?.summary ?? ""}
证据：${(a?.evidence ?? []).map((e) => `${e.kind} ${e.url}（${e.says}）`).join("；") || "无"}`;
  if (a?.verdict !== "moved" || !a.url) return `${a?.verdict === "season_over" ? "本季下线，等下一季" : "没找到新地址"}。${said}`;
  const keep = (why: string) => `${why}，订阅没换：${a.url}。${said}`;
  if (!a.same_company) return keep("新地址不能确认是同一家公司");
  if (!a.evidence.some((e) => e.kind !== "search")) return keep("新地址只有搜索结果作证");
  if (!sourceFor(a.url)?.fetch) return keep("新地址的招聘系统还不能自动读");
  // the same site under another link is the reader's business (it widens a post link to the site itself), not a move
  if (siteKeyOf(a.url) === siteKeyOf(oldUrl)) return keep("新地址和原订阅是同一个站");
  const old0 = s.config.sources.find((c) => c.id === oldId);
  const r = await read(a.url, old0?.name ?? "");
  if ("error" in r) return keep(`新地址读不成（${SYNC_REASONS[reasonOf(r.error)]}）`);
  if (!r.posts) return keep("新地址读到了，但一个岗位都没有");
  const old = s.config.sources.find((c) => c.id === oldId);
  if (!old || old.url !== oldUrl) return keep("订阅在找的时候已经改过");
  const ctx = dataOf(s), had = s.config.sources.some((c) => c.url && siteKeyOf(c.url) === siteKeyOf(a.url));
  addSource(ctx, { url: a.url, name: old.name ?? "", cohort: old.cohort, batch: old.batch, everyHours: old.everyHours, auto: old.auto === true });
  removeSource(ctx, oldId);
  dropOrphanCampaigns(s, oldId); // what only the old address brought, unless a person holds one of its posts
  s.onDataChanged?.();
  // the new subscription's own scan starts at once (onSourcesChanged → scheduleSources) and files what it lists
  return `订阅已从 ${oldUrl} 换到 ${a.url}（试读 ${r.posts} 个岗位）${had ? "；这个地址本来就订阅了，只去掉了旧的" : ""}。${said}`;
}
