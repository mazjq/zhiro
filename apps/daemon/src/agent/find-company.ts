import { now } from "../db.js";
import { dataOf, type Services } from "../registry.js";
import type { WorkflowDef } from "../service/workflow.js";
import { spawnRun, readRun } from "./worker.js";
import { sourceFor } from "../data/index.js";
import { addSource, runSource } from "../data/index.js";
import { capture } from "../service/capture.js";
import { tagCompany } from "../recommenders/index.js";
import { companyKey } from "../service/domain.js";

/**
 * 点名一家库里没有的公司 (PLAN §14 B3): a web-capable worker finds where the company takes campus applications; the
 * daemon then does what it already knows how to do with a URL — register a Moka/北森/飞书 source and scan it, or capture a
 * notice page — and tags the company 我点名的. The worker only returns links; it never writes to the library itself.
 */
export const FIND_SCHEMA = {
  type: "object", additionalProperties: false, required: ["official_name", "entries", "summary"],
  properties: {
    official_name: { type: "string", description: "公司对外招聘用的名称" },
    summary: { type: "string", description: "两句话：找到了什么入口、本届校招是否已开启" },
    entries: {
      type: "array", maxItems: 4,
      items: {
        type: "object", additionalProperties: false, required: ["url", "kind", "note"],
        properties: {
          url: { type: "string", description: "能直接打开的入口 URL（校招岗位列表页优先）" },
          kind: { type: "string", enum: ["moka", "beisen", "feishu", "official", "notice"], description: "moka=app.mokahr.com 租户；beisen=*.zhiye.com；feishu=*.jobs.feishu.cn；official=公司自建校招站；notice=公众号/就业网简章" },
          note: { type: "string" },
        },
      },
    },
  },
} as const;

const prompt = (name: string) => `你是校招信息员。目标公司：**${name}**。今天：${now().slice(0, 10)}。
任务：找到这家公司 **2027 届校园招聘** 的网申入口。用 WebSearch / WebFetch，优先级：
1. 公司校招岗位列表页（Moka：app.mokahr.com/campus-recruitment/<公司>/<数字>；北森：<公司>.zhiye.com；飞书招聘：<公司>.jobs.feishu.cn；或自建 campus / careers 站）
2. 找不到岗位列表页时，给本届校招的官方简章（公司公众号文章、高校就业网转载）
要求：URL 必须是你实际打开确认过的；不要给招聘聚合平台（牛客、智联、实习僧等）的链接；最多 4 条，最可靠的放前面；2027 届还没开就如实写在 summary 里，并给出往年入口。
只输出符合 schema 的 JSON。`;

export function startFindCompany(s: Services, name: string): { runId: string; workflowId: string } {
  const companyName = name.trim();
  const { runId } = spawnRun(s, { runner: "claude", mode: "company.find", subjectType: "company", subjectId: "", subjectLabel: companyName, prompt: prompt(companyName), schema: FIND_SCHEMA });
  const workflowId = s.workflows.start("company_find", runId, `company_find:${runId}`, { companyName });
  return { runId, workflowId };
}

const fail = (s: Services, runId: string, error: string) => s.domain.db.prepare("update agent_run set status = 'failed', error = ?, finished_at = ? where id = ?").run(error.slice(0, 1000), now(), runId);

export function companyFind(s: Services): WorkflowDef {
  return {
    kind: "company_find",
    order: ["collect"],
    steps: {
      collect: async ({ subjectId: runId, checkpoint }) => {
        const row = s.domain.db.prepare("select * from agent_run where id = ?").get(runId) as any;
        if (!row) return { type: "fail", error: "agent_run missing" };
        const r = readRun(row.run_dir);
        if (r.status === "running") {
          if (row.runner !== "external" && (Date.now() - Date.parse(row.started_at)) / 60_000 > 15) { fail(s, runId, "15 分钟内没找完，已停止"); return { type: "done" }; }
          return { type: "sleep", until: new Date(Date.now() + 15_000).toISOString(), checkpoint };
        }
        if (r.status === "failed") { fail(s, runId, r.error ?? "failed"); return { type: "done" }; }
        const so = r.structured as { official_name?: string; summary?: string; entries?: { url: string; kind: string; note: string }[] } | undefined;
        if (!so?.entries?.length) { fail(s, runId, `没找到可用的校招入口。${so?.summary ?? ""}`); return { type: "done" }; }

        const name = String(so.official_name || checkpoint.companyName);
        const done: string[] = [];
        for (const e of so.entries.slice(0, 4)) {
          try {
            const pull = sourceFor(e.url);
            if (pull?.fetch) {
              const added = s.config.sources.find((c) => c.url === e.url) ?? (() => { const a = addSource(dataOf(s), { url: e.url, name, cohort: "2027届", batch: "校招" }); return s.config.sources.find((c) => c.id === a.id)!; })();
              const res = await runSource(dataOf(s), added.id);
              done.push(res.ok ? `已接入 ${pull.id} 数据源（${res.result.received} 个岗位，之后每天自动更新）` : `${pull.id} 入口扫描失败：${res.error}`);
            } else {
              const c = await capture(s.domain, s.config.vault, { url: e.url }, s.llm);
              done.push(`已抓取${e.kind === "notice" ? "简章" : "页面"}：${c.note}`);
            }
          } catch (err: any) { done.push(`${e.url} 处理失败：${err?.message ?? err}`); }
        }
        // tag whichever company row the ingest produced (its name may differ slightly from what the user typed)
        const key = companyKey(name), typed = companyKey(String(checkpoint.companyName));
        const co = (s.domain.db.prepare("select id, name from company").all() as any[]).find((c) => { const k = companyKey(c.name); return k === key || k === typed || k.includes(typed) || typed.includes(k); });
        if (co && s.domain.db.prepare("select 1 from campaign where company_id = ?").get(co.id)) tagCompany(s, { companyId: co.id, tag: "我点名的", reason: `点名添加：${so.summary ?? ""}`.slice(0, 200) });
        s.onDataChanged?.();
        s.domain.db.prepare("update agent_run set status = ?, summary = ?, cost_usd = ?, session_id = ?, finished_at = ? where id = ?")
          .run(co ? "done" : "failed", `${so.summary ?? ""}\n${done.join("\n")}`.slice(0, 1500), r.costUsd ?? 0, r.sessionId ?? "", now(), runId);
        return { type: "done" };
      },
    },
  };
}
