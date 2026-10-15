/**
 * Smoke check under the daemon's real runtime (tsx): functions injected into the page are compiled differently here
 * than under vitest (keepNames wraps them in __name(...)), so a green test suite does not prove the page scripts run.
 * Reads a form, then lets a run fill it.   pnpm --filter @zhiro/daemon check:apply
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { openDb } from "../db.js";
import { Domain } from "../service/domain.js";
import { WorkflowEngine } from "../service/workflow.js";
import { ingest } from "../data/index.js";
import { upsertFact } from "../service/profile.js";
import { openBrowser, closeBrowser, readForm, activePage } from "../service/apply.js";
import { startRun, currentRun, stopRun } from "../service/apply-run.js";

const vault = mkdtempSync(join(tmpdir(), "jobos-check-"));
process.on("exit", () => { try { rmSync(vault, { recursive: true, force: true }); } catch { /* a file still held */ } }); // a browser profile each run, never removed before
const html = join(vault, "form.html");
const field = (label: string, control = "<input>") => `<div class="apply-field-a1"><div class="title-b1">${label}</div>${control}</div>`;
writeFileSync(html, `<!doctype html><meta charset="utf-8"><div class="blockTitle-x1">基本信息</div>${field("姓名")}${field("邮箱")}${field("手机号码")}${field("政治面貌")}${field("现居住地")}${field("最高学历", "<select><option>请选择</option><option>博士研究生</option></select>")}<div class="apply-field-a"><div class="title-b1">性别</div><div class="sd-Dropdown-container-1"><label class="sd-Select-container-1" onclick="if(!this.parentNode.querySelector('.m')){const m=document.createElement('div');m.className='m';m.innerHTML='<div class=sd-Menu-content-item-1><span class=option-label-1>男</span></div>';m.onclick=(e)=>{e.stopPropagation();this.querySelector('span').textContent='男';m.remove()};this.parentNode.appendChild(m)}"><span class="sd-Input-display-value-1">请选择</span><input readonly placeholder="请选择"></label></div></div>`, "utf8");

try {
  await openBrowser(vault, pathToFileURL(html).href, { headless: true });
  const form = await readForm();
  if (form.fields.length !== 7 || form.fields[0].label !== "姓名") throw new Error(`read ${form.fields.length} fields: ${JSON.stringify(form.fields.map((f) => f.label))}`);

  const db = openDb(join(vault, "t.db"));
  const domain = new Domain(db);
  const s: any = { domain, workflows: new WorkflowEngine(db), config: { vault, http: { host: "127.0.0.1", port: 0 }, llm: { provider: "x", model: "y" }, feishu: {}, reminders: { daysBefore: [] }, sources: [] } };
  upsertFact(db, { kind: "basic", data: { field: "姓名", value: "李示例" } }, "本人确认");
  upsertFact(db, { kind: "basic", data: { field: "性别", value: "男" } }, "本人确认");
  upsertFact(db, { kind: "education", data: { school: "示例大学", degree: "博士", major: "控制" } }, "本人确认");
  ingest(domain, vault, "moka", "demo", [{ externalId: "1", url: "https://example.com/j", title: "工程师", company: "示例", locations: [], publisher: "示例", grade: "官方", isOriginal: true, confidence: 1 } as any]);
  const app = domain.createApplication((db.prepare("select id from position").get() as any).id);
  await startRun(s, app.id, { tickMs: 100, headless: true, url: pathToFileURL(html).href });
  for (let i = 0; currentRun()?.state !== "待你提交"; i++) { if (i > 150) throw new Error(`run stuck in ${currentRun()?.state}: ${currentRun()?.reason}`); await new Promise((r) => setTimeout(r, 100)); }
  const got = await (await activePage()).evaluate(() => [(document.querySelector("input") as HTMLInputElement).value, (document.querySelector("select") as HTMLSelectElement).selectedOptions[0].text, document.querySelector("[class*=display-value]")!.textContent]);
  if (got.join() !== "李示例,博士研究生,男") throw new Error(`filled ${JSON.stringify(got)}`);
  console.log(`check:apply OK — ${form.fields.length} fields read, ${currentRun()!.filled} filled under tsx`);
} finally { stopRun(); await closeBrowser(); }
