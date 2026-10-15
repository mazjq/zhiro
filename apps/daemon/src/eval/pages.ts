/**
 * 读页基准 (ADR-038): does page.read reach the content a person would reach — not "did it return text". Each case is a
 * real page, the steps a person would take, and facts that must appear. Run against the live daemon:
 *   pnpm --filter @zhiro/daemon eval:pages            # all
 *   pnpm --filter @zhiro/daemon eval:pages -- pipechina   # cases whose id contains the word
 * Pass = every expected string in the text (or a table); the report is printed and written to docs/reports/page-read/.
 */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const vault = process.env.JOBOS_VAULT ?? join(process.env.APPDATA ?? "", "Zhiro", "vault");
const token = readFileSync(join(vault, "config", ".daemon-token"), "utf8").trim();
const call = (name: string, input: unknown) => fetch(`http://127.0.0.1:8787/api/tools/${name}`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}`, "x-jobos-actor": "cli" }, body: JSON.stringify(input) }).then((r) => r.json());

interface Case { id: string; goal: string; input: Record<string, unknown>; expect: string[]; forbid?: string[]; expectStatus?: string; then?: { steps: unknown[]; expect: string[] } }
const CASES: Case[] = [
  { id: "pipechina-unit", goal: "国家管网：选一个子单位后看到它的校招岗位", input: { url: "https://zhaopin.pipechina.com.cn/recruit#/portal_job_list?job_class=campus", steps: [{ click: "国家管网集团科学技术研究总院分公司" }], refresh: true }, expect: ["管网仿真优化技术研究岗", "博士研究生"] },
  { id: "pipechina-search", goal: "国家管网：搜索框输词后得到结果或明确的 0 条", input: { url: "https://zhaopin.pipechina.com.cn/recruit#/portal_job_list?job_class=campus", steps: [{ click: "国家管网集团工程技术创新有限公司" }, { fill: "请搜索", value: "智能化" }, { press: "Enter" }], refresh: true }, expect: ["新的机会"] },
  { id: "nxp-static", goal: "恩智浦：岗位写在页面脚本里也能读到岗位名与城市", input: { url: "https://campus.51job.com/nxp/graduates.html", refresh: true }, expect: ["Analog Design Engineer", "上海", "天津"] },
  { id: "cict-menu", goal: "中国信科：岗位页先列子公司，不能当成空页", input: { url: "https://campus.51job.com/cict2027/jobs.html", refresh: true }, expect: ["烽火通信", "中信科移动"], expectStatus: "ok" },
  { id: "cict-unit", goal: "中国信科：点一家子公司后看到它的岗位", input: { url: "https://campus.51job.com/cict2027/jobs.html", steps: [{ click: "查看详情", near: "中信科移动通信技术股份有限公司" }], refresh: true }, expect: ["2027校招-", "条/页"] },
  { id: "chnenergy-login-wall", goal: "国家能源集团：站点要登录才能看，必须如实报 needsLogin（Zhiro 有专用读取器走接口）", input: { url: "https://zhaopin.chnenergy.com.cn/", refresh: true }, expect: [], expectStatus: "needsLogin" },
  { id: "zhilian-search", goal: "智联校园：搜索结果页要登录就如实报", input: { url: "https://xiaoyuan.zhaopin.com/search/jn=2&jl=武汉&kw=控制算法", wait: "idle", refresh: true }, expect: [], expectStatus: "needsLogin" },
  { id: "pipechina-session", goal: "国家管网：开会话选单位，再在同一标签页里点岗位看详情，不重放", input: { url: "https://zhaopin.pipechina.com.cn/recruit#/portal_job_list?job_class=campus", mode: "open", steps: [{ click: "国家管网集团科学技术研究总院分公司" }, { scroll: 2 }], refresh: true }, expect: ["管网仿真优化技术研究岗"], then: { steps: [{ click: "管网仿真优化技术研究岗" }], expect: ["外语", "天津"] } },
  { id: "mp-article", goal: "公众号文章走 HTTP 不开浏览器（或如实报验证）", input: { url: "https://mp.weixin.qq.com/s/placeholder", refresh: true }, expect: [] },
];

const only = process.argv.slice(2).find((a) => !a.startsWith("-")) ?? "";
const rows: string[] = [];
let pass = 0, n = 0;
for (const c of CASES.filter((c) => c.id.includes(only))) {
  n++;
  const t0 = Date.now();
  const r: any = await call("page.read", c.input).catch((e) => ({ error: String(e) }));
  let hay = r.text ? r.text + "\n" + JSON.stringify(r.tables ?? []) : "";
  let missing = c.expect.filter((e) => !hay.includes(e));
  if (c.then && r.session?.id) {
    const r2: any = await call("page.read", { mode: "continue", sessionId: r.session.id, steps: c.then.steps }).catch((e) => ({ error: String(e) }));
    hay = r2.text ?? "";
    missing = missing.concat(c.then.expect.filter((e) => !hay.includes(e)).map((e) => "续读缺 " + e));
    if (r2.status !== "ok") missing.push(`续读状态 ${r2.status ?? r2.error}`);
    await call("page.read", { mode: "close", sessionId: r.session.id }).catch(() => {});
  } else if (c.then) missing.push("没有 session");
  const ms = Date.now() - t0;
  const seen = (c.forbid ?? []).filter((f) => hay.includes(f));
  const ok = !r.error && r.status !== "busy" && missing.length === 0 && seen.length === 0 && (!c.expectStatus || r.status === c.expectStatus);
  if (ok) pass++;
  const stepNote = (r.steps ?? []).filter((s: any) => !s.ok).map((s: any) => `${s.step} → ${s.note}`).join("; ");
  const line = `| ${c.id} | ${ok ? "✓" : "✗"} | ${r.error ? "error" : r.status ?? "?"} / ${r.via ?? "-"} | ${ms} ms | ${r.chars ?? 0} 字 | ${c.expectStatus && r.status !== c.expectStatus ? `状态应为 ${c.expectStatus} ` : ""}${missing.length ? "缺 " + missing.join("、") : ""}${seen.length ? " 不该有 " + seen.join("、") : ""}${stepNote ? " 步骤 " + stepNote : ""}${r.error ? " " + JSON.stringify(r).slice(0, 120) : ""} |`;
  rows.push(line);
  console.log(`${ok ? "PASS" : "FAIL"} ${c.id} ${r.status ?? r.error} ${ms}ms${missing.length ? " missing " + missing.join(",") : ""}${stepNote ? " | " + stepNote : ""}`);
}
const report = `# 读页基准 ${new Date().toISOString().slice(0, 16).replace("T", " ")}\n\n通过 ${pass} / ${n}\n\n| 用例 | 结果 | 状态 / 路径 | 用时 | 字数 | 备注 |\n|---|---|---|---|---|---|\n${rows.join("\n")}\n`;
const dir = join(process.cwd(), "..", "..", "docs", "reports", "page-read");
mkdirSync(dir, { recursive: true });
const out = join(dir, `${new Date().toISOString().slice(0, 10)}.md`);
writeFileSync(out, report, "utf8");
console.log(`\n${pass} / ${n} passed → ${out}`);
