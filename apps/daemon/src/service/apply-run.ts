import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import type { Frame, Page } from "playwright-core";
import type { Services } from "../services.js";
import type { Db } from "../db.js";
import { DomainError, NotFound } from "./domain.js";
import { openBrowser, browserOpen, activePage, readForm, mapFields, normLabel, SENSITIVE, peopleSection, type Mapped, type FormField } from "./apply.js";
import { pickResume } from "./resumes.js";
import { upsertFact } from "./profile.js";
import { choose } from "./apply-widgets.js";
import { planBlocks, slotsOf, valueIn, addEntry, blockKind, partOf, planRecords, sameName, projectPart } from "./apply-blocks.js";
import { readReference } from "./apply-reference.js";
const MAX_ENTRIES = 30;
/** Fields whose answer was cut to the box's length limit this run, and that limit. */
const shortened = new Map<string, number>();
import { checkResume } from "./resume-check.js";
import { platformOf } from "./platforms.js";

/**
 * 开始网申 (ADR-024): one run takes one prepared application from "browser opened" to "submitted".
 * Nothing is asked of the user before the submit button except what only they can do (log in, walk to the form
 * until navigation is automated). So the run is conservative instead of confirmed: it writes only fields the profile
 * answers for sure, never overwrites a value that is already there, never touches sensitive fields or personal
 * choices, reads every value back after blur, and never clicks anything that submits. Whatever needs the user's eye
 * goes into a short report. Re-running is safe by construction: it reads the form again and fills what is still empty.
 */
export type RunState = "准备中" | "待你操作" | "填写中" | "待你提交" | "结果待核实" | "已投递" | "已停止";
export interface Attention { section: string; label: string; kind: "没填上" | "留给你" | "和画像不同" | "请上传简历" | "简历痕迹"; detail: string }
export interface Run {
  applicationId: string; positionId: string; title: string; url: string; resume: string;
  state: RunState; reason: string; paused: boolean; filled: number; attention: Attention[]; learned: string[]; startedAt: string; updatedAt: string;
  /** fields the site filled itself from the uploaded resume (Moka parses it), told apart from Zhiro's own */
  bySite: number;
  /** the recruiting platform the form is on (Moka, 北森, 企业自建站 …) */
  platform: string;
  /** while filling: how far along, and the field being set now */
  progress: { done: number; total: number; current: string } | null;
}

let run: Run | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let busy = false;
/** what the form looked like the last time it was on screen: the submission snapshot, and where the user's own additions are found */
let lastForm: Mapped[] = [];
/** label → value for everything the run wrote itself, so the user's additions can be told apart */
let ours = new Map<string, string>();
let filledSignature = "";
/** The page text when we handed the form over: success words that were already there (a hint like 「提交成功后…」) do not count. */
let fillText = "";
let lastText = "";
let uploaded = false;
/** field values just before the resume went in: whatever changes after it is the site's parser at work */
let beforeUpload: FormField[] | null = null;
/** what the uploaded resume gives away (metadata, leftovers): reported with the rest */
let traces: Attention[] = [];
let gone = 0;
/** whether the run opened the job's own application page (true) or only the site's job list (false) */
let located = true;
/** on a list page: how many looks for the job so far, and the job's name as the site shows it once found */
let hunts = 0;
let foundAs = "";

const titleKey = (s: string) => s.normalize("NFKC").replace(/\s+/g, "").toLowerCase();

/**
 * The official page of exactly this job. A position that came from a summary sheet has only the site's list page;
 * the same company's official source (Moka / 北森, synced automatically) usually has the job itself. Matched on the
 * exact title only, and only when that is unambiguous: a wrong guess would file an application for another job.
 */
export function officialTarget(db: Db, positionId: string): { url: string; exact: boolean } | null {
  // a captured page counts when it is the job itself (Moka …#/job/<id>): a real list-page application, 2026-10-14
  const own = db.prepare("select provider, url from source_listing where position_id = ? and url != '' and (provider in ('moka', 'beisen') or url like '%#/job/%') order by provider in ('moka', 'beisen') desc").get(positionId) as any;
  const p = db.prepare("select p.title, c.company_id from position p join campaign c on c.id = p.campaign_id where p.id = ?").get(positionId) as any;
  if (!p) return null;
  const hits = own ? [own] : (db.prepare(`select sl.provider, sl.url, p.title from source_listing sl join position p on p.id = sl.position_id join campaign c on c.id = p.campaign_id
    where c.company_id = ? and sl.provider in ('moka', 'beisen') and sl.url != ''`).all(p.company_id) as any[]).filter((r) => titleKey(r.title) === titleKey(p.title));
  const urls = [...new Set(hits.map((h) => h.url as string))];
  if (urls.length !== 1) return null;
  const u = urls[0];
  // Moka: the job page is …#/job/<id>; its application form is …#/job/<id>/apply — reached by address, no button clicked
  return { url: /#\/job\/[^/?]+$/.test(u) ? u + "/apply" : u, exact: true };
}

const now = () => new Date().toISOString();
const keyOf = (f: { section: string; label: string; local: number }) => `${f.section}|${f.label}|${f.local}`;

/**
 * How many fields the site filled after the resume upload (D15): matched by 分组|标签 in order, not by element index —
 * an entry the site inserts at the top of a block shifts every index after it, so a field that already had a value
 * would have counted as "filled by the site".
 */
export function siteFilled(before: { section: string; label: string; type: string; value: string }[], now: { section: string; label: string; type: string; value: string }[]): number {
  const had = new Map<string, string[]>();
  for (const f of before) { const k = `${f.section}|${f.label}`; had.set(k, [...(had.get(k) ?? []), f.value]); }
  let n = 0;
  for (const f of now) {
    if (f.type === "file" || EMPTY.test(f.value.trim())) continue;
    const k = `${f.section}|${f.label}`, prev = had.get(k)?.shift();
    if (EMPTY.test((prev ?? "").trim())) n++;
  }
  return n;
}
const EMPTY = /^(请选择|请输入|请填写|选择|年|月|-+|select|choose|please)?$/i;
const TEXTUAL = new Set(["text", "textarea", "email", "tel", "number", "url"]);
// 「提交成功后将无法修改」 is a hint or a confirm prompt, not the success itself (N14/N16)
// 「感谢您申请示例汽车」 is a welcome line at the top of many forms (N27/N28); the thanks that means success says 「感谢您的投递」
const SUCCESS = /(投递|申请|提交)成功(?!后)|已成功(投递|提交)|感谢(您|你)?的(投递|申请)|application (has been )?(submitted|received)/i;
/** The page is asking the user whether to submit, or to check before submitting: not submitted yet, whatever else it says. */
const CONFIRMING = /确定(要)?提交|确认提交|是否提交|提交吗|提交前请|提交成功后(将)?(无法|不可|不能)/;
/** A page that shows the answers for checking before the real submit (N19/N21): the form is gone, but nothing was sent. */
const CHECK_PAGE = /核对|预览|确认提交|确定提交|提交前|确认(以下|以上|您的|你的|所填|填写的?|个人)?信息|信息(无误|是否正确|确认)|检查(一下|以下|您的|你的)?(信息|填写)|最后确认|确认无误/;
/** Whole lines that were not on the earlier page (N18; whole lines, not substrings — 「提交成功」 is not part of 「提交成功后不可修改」, N20). */
const newLines = (text: string, earlier: string): string => { const had = new Set(earlier.split(/\n+/).map((l) => l.trim())); return text.split(/\n+/).map((l) => l.trim()).filter((l) => l && !had.has(l)).join("\n"); };
const LOGIN = /扫码登录|微信登录|验证码登录|密码登录|短信登录|请先登录|登录后|sign in|log in/i;
const JOB_PAGE = /职位(列表|名称|类别|搜索|详情)|岗位(列表|名称|详情)|查看详情|立即申请|我要应聘|投递简历|申请职位/;

/**
 * Did the user submit? A success message counts when (N7) the form is gone, or it appeared after we handed the form
 * over (a 「提交成功」 dialog over the form), or every field left is read-only (a success page echoing name / phone).
 * A success phrase that was on the page before the user clicked (a hint) never counts on its own.
 */
export function submittedNow(text: string, textAtFill: string, fields: { label: string; disabled?: boolean }[], known: Set<string>, textLastTick = textAtFill): boolean {
  if (!SUCCESS.test(text)) return false;
  const formStillThere = fields.filter((f) => known.has(normLabel(f.label))).length >= 3;
  // N27: the form is gone, but the success words must be new too — a page header that says thanks follows the user to a
  // thin second step or a check page
  if (!formStillThere) return SUCCESS.test(newLines(text, textAtFill));
  // the form is still on screen: only what appeared since the hand-over decides — a 「确定要提交吗」 dialog or a
  // 「提交成功后不可修改」 check page (N14) is not a submission, a success dialog is (N7), even over a form that always
  // carried such a hint (N16/N18). A success dialog that appears while the confirm dialog is still up (N22) is judged
  // by what is new since the last look.
  // N23: "since the last look" still excludes what the page had at hand-over — a welcome line that scrolls away and back is not news
  const fresh = newLines(text, textAtFill), sinceLast = newLines(newLines(text, textLastTick), textAtFill);
  if (SUCCESS.test(sinceLast) && !CONFIRMING.test(sinceLast)) return true;
  if (CONFIRMING.test(fresh)) return false;
  return SUCCESS.test(fresh);
}

export const currentRun = (): Run | null => run;

function set(s: Services, patch: Partial<Run>) {
  if (!run) return;
  Object.assign(run, patch, { updatedAt: now() });
  const dir = join(s.config.vault, "runs", "apply");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${run.applicationId}.json`), JSON.stringify({ ...run, form: lastForm.map(({ section, label, type, value, status }) => ({ section, label, type, value: SENSITIVE.test(label) ? "" : value, status })) }, null, 1), "utf8");
}

export async function startRun(s: Services, applicationId: string, opts: { tickMs?: number; headless?: boolean; url?: string } = {}): Promise<Run> {
  const x = s.domain.listApplications().items.find((i) => i.application.id === applicationId);
  if (!x) throw new NotFound(`application ${applicationId}`);
  if (x.application.state !== "draft") throw new DomainError("NOT_DRAFT", "只有「准备申请」里的岗位可以开始网申");
  const target = opts.url ? { url: opts.url, exact: true } : officialTarget(s.domain.db, x.application.positionId) ?? { url: [x.applyUrl, x.noticeUrl].find((u) => u && !u.includes("mp.weixin.qq.com")) ?? "", exact: false };
  const url = target.url;
  if (!url) throw new DomainError("NO_APPLY_URL", "这个岗位没有可用的投递链接");
  located = target.exact;
  // the resume was chosen by rule when the application was prepared; if the user never looked, choose it now
  let resume = x.application.resumeLabel ?? "";
  if (!resume) { resume = pickResume(s.domain.db, x.application.positionId).pick?.resume.name ?? ""; if (resume) s.domain.updateApplication({ id: applicationId, resumeLabel: resume }, "jobos:apply"); }
  stopRun();
  run = { applicationId, positionId: x.application.positionId, title: `${x.companyName} · ${x.title}`, url, resume, state: "准备中", reason: "正在打开专用浏览器", paused: false, filled: 0, attention: [], learned: [], startedAt: now(), updatedAt: now(), bySite: 0, progress: null, platform: platformOf(url)?.name ?? "" };
  lastForm = []; ours = new Map(); filledSignature = ""; fillText = ""; lastText = ""; uploaded = false; gone = 0; beforeUpload = null; traces = []; shortened.clear(); hunts = 0; foundAs = "";
  await openBrowser(s.config.vault, url, { headless: opts.headless });
  const every = opts.tickMs ?? 2000;
  const loop = () => { timer = setTimeout(async () => { if (!busy) { busy = true; try { await tick(s); } catch (e: any) { set(s, { state: "待你操作", reason: `出错了：${String(e?.message ?? e).split("\n")[0]}` }); } finally { busy = false; } } if (run && !["已投递", "已停止", "结果待核实"].includes(run.state)) loop(); }, every); };
  loop();
  return run;
}

export function stopRun(): void { if (timer) clearTimeout(timer); timer = null; if (run && !["已投递", "结果待核实"].includes(run.state)) run.state = "已停止"; }
/** Pausing promises one thing: no further write starts. */
export function pauseRun(s: Services, paused: boolean): Run | null { if (run) set(s, { paused, reason: paused ? "已暂停" : run.reason === "已暂停" ? "" : run.reason }); return run; }

async function tick(s: Services): Promise<void> {
  if (!run || run.paused) return;
  if (!browserOpen()) return run.state === "待你提交" ? finish(s, false, "浏览器关了，没看到投递成功的提示") : set(s, { state: "已停止", reason: "浏览器已关闭" });
  const page = await activePage();
  page.setDefaultTimeout(5000);
  const form = await readForm();
  const labelled = form.fields.filter((f) => f.label && f.type !== "file");
  const text = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => "");

  // a multi-step form: "next" brought up a page of new questions — fill it too (the user clicked, never us)
  const known = new Set(lastForm.map((f) => normLabel(f.label)));
  const prevText = lastText; lastText = text;
  if (run.state === "待你提交" && submittedNow(text, fillText, labelled, known, prevText || fillText)) return finish(s, true, "页面显示投递成功");
  // N12/N13: a real next page has three new captions AND enough fields to be a form; a thin page (an applications list,
  // a small second step) is only watched, so the success page after it is still recognised
  const nextStep = run.state === "待你提交" && !SUCCESS.test(text) && labelled.length >= 5 && labelled.filter((f) => !known.has(normLabel(f.label))).length >= 3;
  if (run.state === "待你提交" && !nextStep) {
    // keep watching while the user finishes the form: the mapping stays as decided, only the values move.
    // N4: fields of earlier steps that are no longer on screen stay in lastForm, so what the user typed there is learned too
    if (labelled.length >= 3) {
      gone = 0;
      const fresh = await mapFields(s.domain.db, undefined, form.fields);
      const merged = fresh.map((f) => { const old = lastForm.find((o) => keyOf(o) === keyOf(f)); return old ? { ...old, value: f.value } : f; });
      const seen = new Set(merged.map(keyOf));
      lastForm = [...lastForm.filter((o) => !seen.has(keyOf(o))), ...merged];
      return;
    }
    if (SUCCESS.test(text)) return finish(s, true, "页面显示投递成功");
    if (CONFIRMING.test(text) || CHECK_PAGE.test(text)) { gone = 0; return; } // N19/N21: a text-only 核对 page before the real submit — keep waiting
    if (++gone >= 5) return finish(s, false, "申请表不见了，但没看到投递成功的提示");
    return;
  }

  const where = platformOf(page.url());
  if (where) run.platform = where.name;
  if (where?.level === "不支持") return set(s, { state: "待你操作", reason: `${where.name}：${where.note}` });
  const hasPassword = form.fields.some((f) => f.type === "password" || /密码|验证码/.test(f.label + f.placeholder));
  if (labelled.length < 5) {
    // D13: a job listing whose header offers 「扫码登录」 is not a login wall — the user needs to open a position first
    if (hasPassword || (LOGIN.test(text) && !JOB_PAGE.test(text))) return set(s, { state: "待你操作", reason: "请在浏览器里登录（扫码）" });
    const job = run.title.split(" · ")[1] ?? run.title;
    if (!located && hunts++ < 4) {
      const shown = await findJob(page, job).catch(() => "");
      if (shown) { located = true; foundAs = shown; return; }
    }
    if (foundAs && !/#\/job\//.test(page.url())) {
      await banner(page, "Zhiro：已找到这个职位，请点「申请」进入申请表", "#d97706");
      return set(s, { state: "待你操作", reason: `已在官网找到「${foundAs}」，请点「申请」进入申请表` });
    }
    await banner(page, located ? "Zhiro：等申请表出现（如需登录请扫码）" : "Zhiro：请点开这个职位并进入申请表", "#d97706");
    return set(s, { state: "待你操作", reason: located ? "等申请表出现（如需登录请扫码）" : `没能在官网对上这个岗位，请在浏览器里点开「${job}」并进入申请表` });
  }
  const signature = labelled.map((f) => f.label).join("|");
  if (signature === filledSignature) return set(s, { state: "待你提交", reason: "" });

  set(s, { state: "填写中", reason: "" });
  // The resume goes in first, while the form is still empty: sites like Moka parse it into the fields ("上传简历后会自动解析、
  // 填充申请表信息"), and whatever they fill is left alone — we only fill what is still empty afterwards.
  const files = form.fields.filter((f) => f.type === "file");
  const file = files.find((f) => /简历|resume|cv/i.test(f.label + f.section) && !/附件|其他|作品/.test(f.label)) ?? (files.length === 1 ? files[0] : undefined);
  const attention: Attention[] = [...traces];
  if (foundAs) attention.push({ section: "岗位", label: foundAs, kind: "和画像不同", detail: "Zhiro 按岗位名在官网列表里找到的这一个，提交前请核对是不是你要投的岗位" });
  if (!uploaded) {
    const r = s.domain.db.prepare("select file_path, file_name from resume where name = ?").get(run.resume) as any;
    const path = r?.file_path as string | undefined;
    if (path && existsSync(path)) {
      // named 姓名+简历 — the library's own name ("通用 v6 Codex …") is nobody's business
      const owner = (s.domain.db.prepare("select data_json from fact where kind = 'basic'").all() as { data_json: string }[]).map((x) => JSON.parse(x.data_json)).find((d) => d.field === "姓名")?.value ?? "";
      const ext = (r.file_name ?? "").match(/\.[a-z0-9]+$/i)?.[0] ?? ".pdf";
      const upload = { name: `${owner}简历${ext}`, mimeType: /\.docx?$/i.test(r.file_name ?? "") ? "application/msword" : "application/pdf", buffer: readFileSync(path) };
      beforeUpload = form.fields;
      if (file) await locate(page, file).setInputFiles(upload).then(() => { uploaded = true; }).catch(() => {});
      else {
        // no file input in the DOM yet: some sites create it when their upload button is clicked — the one click a run makes
        const button = page.getByText(/^\s*上传简历\s*$/).first();
        if (await button.isVisible().catch(() => false)) {
          const chooser = page.waitForEvent("filechooser", { timeout: 5000 });
          await button.click({ timeout: 3000 }).catch(() => {});
          await chooser.then((c) => c.setFiles(upload)).then(() => { uploaded = true; }).catch(() => {});
        }
      }
      if (uploaded) {
        const id = (s.domain.db.prepare("select id from resume where name = ?").get(run.resume) as any)?.id;
        traces = id ? (await checkResume(s.domain.db, id).catch(() => ({ items: [] }))).items.map((t) => ({ section: "上传", label: t.where, kind: "简历痕迹" as const, detail: `「${t.found}」${t.advice}` })) : [];
      }
      if (uploaded) {
        // Moka parses for a while and fills fields one after another; filling alongside it raced it (and made its own
        // work look like ours). Wait until two readings 1.5 s apart agree, at most 25 s; the next tick maps afresh.
        await banner(page, "Zhiro 已上传简历，等网站解析…", "#2563eb");
        let last = "", same = 0;
        for (let t = Date.now(); Date.now() - t < 25_000 && same < 2; ) {
          await page.waitForTimeout(1500);
          const now = (await readForm().catch(() => form)).fields.map((f) => f.value).join("|");
          same = now === last ? same + 1 : 0; last = now;
        }
        return;
      }
    }
    if (file || files.length) attention.push({ section: (file ?? files[0]).section, label: (file ?? files[0]).label || "简历附件", kind: "请上传简历", detail: run.resume ? `没能自动传上「${run.resume}」` : "简历库里还没有简历" });
  }

  const ref = readReference(s.config.apply?.referenceDoc);
  const mapped = await mapFields(s.domain.db, s.llm, form.fields, ref);
  const bySite = beforeUpload ? siteFilled(beforeUpload, form.fields) : 0;
  const todo = mapped.filter((f) => f.status === "可填" && f.proposed && EMPTY.test(f.value.trim()));
  let filled = 0, done = 0, wroteYear = "";
  for (const f of mapped) {
    if (run.paused) break;
    if (todo.includes(f)) { set(s, { progress: { done: done++, total: todo.length, current: f.label } }); await banner(page, `Zhiro 正在填写 ${done}/${todo.length}：${f.label}　请先别操作这个页面`, "#2563eb"); }
    if (f.status === "已有内容") { attention.push({ section: f.section, label: f.label, kind: "和画像不同", detail: `页面：${f.value}　画像：${f.proposed}` }); continue; }
    if (f.status === "由你填写" || (f.status === "画像里没有" && f.required)) { attention.push({ section: f.section, label: f.label, kind: "留给你", detail: f.status === "由你填写" ? "" : f.source || "画像里没有" }); continue; }
    if (f.status !== "可填" || !f.proposed) continue;
    if (!EMPTY.test(f.value.trim())) continue; // already there (account-level fields, the site's own parse): not ours to count
    const cur = await current(page, f);
    // Moka puts 1 into the 月 box once its 年 is chosen (毕业时间 came out 2027年1月, 2026-10-14): that 1 is not the site's answer
    const autoMonth = f.placeholder === "月" && wroteYear === `${f.section}|${f.label}`;
    if (cur && (cur.disabled || (!EMPTY.test(cur.value) && !autoMonth))) continue; // filled or locked by the site meanwhile: not ours
    const why = await write(page, f).catch((e) => String(e?.message ?? e).split("\n")[0]);
    wroteYear = !why && f.placeholder === "年" ? `${f.section}|${f.label}` : "";
    if (why) { attention.push({ section: f.section, label: f.label, kind: "没填上", detail: why }); await keepDom(s, page, f, why); } else { filled++; ours.set(keyOf(f), f.proposed); }
    if (!why && shortened.has(keyOf(f))) attention.push({ section: f.section, label: f.label, kind: "和画像不同", detail: `这一栏最多 ${shortened.get(keyOf(f))} 字，已按句截短，请看一眼` });
  }
  if (!run.paused) filled += await fillBlocks(s, page, attention);
  // keep what earlier steps of the form held (a multi-step form): the snapshot and what is learned from it
  lastForm = [...lastForm.filter((o) => !mapped.some((m) => keyOf(m) === keyOf(o))), ...mapped];
  if (run.paused) { await banner(page, "Zhiro 已暂停，页面交给你", "#6b7280"); return set(s, { filled, attention, bySite, progress: null }); }
  // entries added above changed the form: remember its new shape, or the next tick would take it for a new form
  filledSignature = (await readForm().catch(() => form)).fields.filter((f) => f.label && f.type !== "file").map((f) => f.label).join("|");
  fillText = await page.evaluate(() => document.body?.innerText?.slice(0, 4000) ?? "").catch(() => text);
  set(s, { state: "待你提交", reason: "", filled, attention, bySite, progress: null });
  const left = attention.filter((a) => a.kind !== "和画像不同").length;
  await banner(page, `Zhiro 填完了：填了 ${filled} 项${bySite ? `，网站按简历填了 ${bySite} 项` : ""}${left ? `，还有 ${left} 项要你补（清单在 Zhiro 里）` : ""}。检查后请你自己点提交。`, "#16a34a");
}

/** The markup around a control that could not be set, plus any open pop-up: what is needed to fix its driver. Local only. */
async function keepDom(s: Services, page: Page, f: Mapped, why: string): Promise<void> {
  if (!run) return;
  const html = await locate(page, f).evaluate((e) => {
    const field = e.closest("[class*='apply-field'], .form-item, .ant-form-item, .el-form-item") ?? e.parentElement ?? e;
    const pops = Array.from(document.querySelectorAll("body > div, body > section")).filter((d) => getComputedStyle(d).position !== "static" && (d as HTMLElement).offsetHeight > 0 && !d.contains(field));
    return [field.outerHTML, ...pops.map((p) => p.outerHTML)].join("\n<!-- pop-up -->\n").slice(0, 60_000);
  }).catch(() => "");
  if (!html) return;
  const file = join(s.config.vault, "runs", "apply", `${run.applicationId}.debug.html`);
  const prev = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, (prev + `\n<!-- ${new Date().toISOString()} ${f.section} / ${f.label}: ${why} -->\n` + html).slice(-400_000), "utf8");
}

/**
 * The application link was the site's job list (a real Moka site, 2026-10-14): find the job by its name — on the page, or through
 * the list's search box — and open it. Only when exactly one job carries the name; a guess could file for another job.
 * Moka's job page then goes to its form by address (…#/job/<id>/apply). Returns the name as the site shows it, or "".
 */
async function findJob(page: Page, title: string): Promise<string> {
  const hit = async () => {
    const all = page.getByText(title).filter({ visible: true });
    const texts = [...new Set((await all.allInnerTexts()).map((t) => t.trim()))];
    return texts.length === 1 ? { el: all.first(), text: texts[0] } : null;
  };
  let h = await hit();
  if (!h) {
    const box = page.locator("input[placeholder*='关键'], input[placeholder*='搜索'], input[placeholder*='职位'], input[type=search]").filter({ visible: true }).last();
    if (!(await box.count())) return "";
    await box.fill(title); await box.press("Enter");
    await page.waitForTimeout(3000);
    h = await hit();
  }
  if (!h) return "";
  await h.el.click({ timeout: 3000 });
  await page.waitForTimeout(2500);
  const p = await activePage(); // some sites open the job in a new tab
  if (/#\/job\/[^/?]+$/.test(p.url())) await p.goto(p.url() + "/apply", { waitUntil: "domcontentloaded" }).catch(() => {});
  return h.text;
}

/**
 * A strip across the top of the page the run is working on, so the user can see from the browser itself whether Zhiro
 * is still typing or done. It takes no clicks (pointer-events: none) and never covers the form's own buttons for long.
 */
async function banner(page: Page, text: string, color: string): Promise<void> {
  await page.evaluate(([t, c]) => {
    let b = document.getElementById("jobos-banner");
    if (!b) { b = document.createElement("div"); b.id = "jobos-banner"; document.documentElement.appendChild(b); }
    b.setAttribute("style", `position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;background:${c};color:#fff;font:14px/1.4 system-ui,sans-serif;padding:6px 14px;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.2);max-width:90vw`);
    b.textContent = t;
  }, [text, color] as const).catch(() => {});
}

/**
 * 教育背景 / 实习经历 / 项目经验 / 获奖经历, one record per entry (apply-blocks has the rules): fill the next empty entry,
 * or add one entry and read the form again; never two additions without the new block showing up in between.
 */
async function fillBlocks(s: Services, page: Page, attention: Attention[]): Promise<number> {
  let filled = 0;
  const done = new Set<string>(), gaveUp = new Set<string>(), adds = new Map<string, number>();
  // N15: the ceiling on additions per block is the number of records that needed one at the start — the plan shrinks
  // as records are placed, so comparing against the remaining plan gave up on the second addition every time
  const need = new Map<string, number>();
  const ref = readReference(s.config.apply?.referenceDoc);
  for (const p of planBlocks(s.domain.db, (await readForm()).fields, ref)) if (!p.slot) need.set(p.section, (need.get(p.section) ?? 0) + 1);
  await repairProjects(s, page, attention, ref);
  for (let round = 0; round < MAX_ENTRIES * 3 && run && !run.paused; round++) {
    const form = await readForm();
    const plan = planBlocks(s.domain.db, form.fields, ref).filter((p) => !done.has(p.section + "|" + p.name) && !gaveUp.has(p.section));
    const next = plan.find((p) => p.slot) ?? plan[0];
    if (!next) break;
    if (!next.slot) {
      const count = async () => slotsOf((await readForm()).fields).filter((x) => x.section === next.section).length;
      const before = slotsOf(form.fields).filter((x) => x.section === next.section).length;
      await banner(page, `Zhiro 正在添加一条${next.section}：${next.name}`, "#2563eb");
      // never more additions than records to place: an entry that keeps looking taken must not make us add forever
      const n = (adds.get(next.section) ?? 0) + 1; adds.set(next.section, n);
      // the ceiling was 6 entries a block; a person with 18 awards hit it on the first real form (2026-10-14)
      if (before >= MAX_ENTRIES || n > (need.get(next.section) ?? 0) || !(await addEntry(page, next.section, before, count))) {
        gaveUp.add(next.section);
        for (const p of plan.filter((x) => x.section === next.section)) attention.push({ section: p.section, label: p.name, kind: "留给你", detail: "没能添加新的一条，请手动添加并填写" });
      }
      continue;
    }
    done.add(next.section + "|" + next.name);
    await banner(page, `Zhiro 正在填写${next.section}：${next.name}`, "#2563eb");
    const nth = new Map<string, number>();
    for (const f of next.slot.fields) {
      const k = normLabel(f.label), n = nth.get(k) ?? 0;
      if (f.type !== "checkbox") nth.set(k, n + 1);
      const v = f.type === "checkbox" ? (/至今/.test(next.record.period ?? "") && f.options.some((o) => /至今/.test(o)) ? "至今" : "") : valueIn(next.kind, next.record, f, n, next.slot.fields);
      if (!v) continue;
      // N3: a control that already shows something else (a select's default 「本科」 in the PhD's entry) is left alone but reported
      if (!EMPTY.test(f.value.trim())) { if (f.value.trim().normalize("NFKC") !== v.normalize("NFKC")) attention.push({ section: f.section, label: `${next.name} · ${f.label}`, kind: "和画像不同", detail: `表单里是「${f.value.trim()}」，画像里是「${v}」` }); continue; }
      const why = await write(page, { ...f, proposed: v, factKey: "", source: "", status: "可填", how: "" }).catch((e) => String(e?.message ?? e).split("\n")[0]);
      if (why) { attention.push({ section: f.section, label: `${next.name} · ${f.label}`, kind: "没填上", detail: why }); await keepDom(s, page, f as Mapped, why); } else filled++;
    }
  }
  return filled;
}

/**
 * A project entry the site filled from the uploaded résumé puts what the person did into 项目描述 and leaves 职责 empty.
 * For the projects the profile knows (by name) and has an introduction for: 项目描述 becomes the project itself and 职责
 * what the person did (the person asked for exactly this, 2026-10-14). Only when 职责 is still empty — an entry they
 * edited themselves is theirs — and each change is listed for them to look at.
 */
async function repairProjects(s: Services, page: Page, attention: Attention[], ref: ReturnType<typeof readReference>): Promise<void> {
  const form = await readForm();
  const records = planRecords(s.domain.db, "project", ref);
  for (const slot of slotsOf(form.fields).filter((x) => blockKind(x.section) === "project")) {
    const title = slot.fields.find((f) => partOf("project", f.label) === "title")?.value ?? "";
    const rec = records.find((r) => sameName(r.title ?? "", title));
    const desc = slot.fields.find((f) => partOf("project", f.label) === "description"), duty = slot.fields.find((f) => projectPart(f, slot.fields) === "duty");
    if (!rec?.description || !desc || !duty || !EMPTY.test(duty.value.trim()) || desc.value.trim() === rec.description.trim()) continue;
    const want = valueIn("project", rec, duty, 0, slot.fields);
    const a = await write(page, { ...desc, proposed: rec.description, factKey: "", source: "", status: "可填", how: "" }).catch((e) => String(e?.message ?? e));
    const b = want ? await write(page, { ...duty, proposed: want, factKey: "", source: "", status: "可填", how: "" }).catch((e) => String(e?.message ?? e)) : "";
    attention.push({ section: slot.section, label: `${title} · 项目描述`, kind: "和画像不同", detail: a || b ? `想把网站按简历解析的描述换成项目本身的介绍，没成：${a || b}` : "网站按简历解析出的描述已换成项目本身的介绍，你做的事放进了「项目中职责」，请看一眼" });
  }
}

/** What a field holds right now, and whether the site has locked it (Moka locks what it takes from the account or the parse). */
async function current(page: Page, f: Mapped): Promise<{ value: string; disabled: boolean } | null> {
  return locate(page, f).evaluate((e) => {
    const box = e.closest("[class*='Dropdown-container'], .phoenix-select") ?? e.parentElement;
    const shown = (box?.querySelector("[class*='display-value'], .phoenix-select__tipEle")?.textContent ?? "").trim();
    const value = (/^(请选择|年|月|请输入.*)?$/.test(shown) ? "" : shown) || ((e as HTMLInputElement).value ?? "").trim();
    return { value, disabled: !!(e as HTMLInputElement).disabled || !!e.closest("[class*='containerDisabled'], [class*='Input-disabled'], .is-disabled, .ant-select-disabled") };
  }, null, { timeout: 3000 }).catch(() => null);
}

const frameOf = (page: Page, f: Mapped | { frame: string }): Frame => (f.frame ? page.frames().find((x) => x.url() === f.frame) ?? page.mainFrame() : page.mainFrame());
const locate = (page: Page, f: { frame: string; local: number }) => frameOf(page, f).locator(`[data-jobos-i="${f.local}"]`).first();

/** Write one field and read it back after blur. Returns "" on success, otherwise why it did not take. */
async function write(page: Page, f: Mapped): Promise<string> {
  const el = locate(page, f);
  if (!(await el.count())) return "页面变了，没找到这个字段";
  if (f.type === "radio" || f.type === "checkbox") {
    // the option whose whole text is the value: "是" must not find the question "是否服从调剂"
    const exact = new RegExp(`^\\s*${f.proposed.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`);
    const byLabel = el.locator("label", { hasText: exact }).first();
    const byFor = el.locator("[for]", { hasText: exact }).first(); // 问卷星: div.label[for=q1_2] beside a hidden radio
    const option = (await byLabel.count()) ? byLabel : byFor;
    if (!(await option.count())) return `没有「${f.proposed}」这个选项`;
    await option.click({ timeout: 3000 });
    const id = await option.getAttribute("for").catch(() => null);
    const input = id ? el.locator(`[id="${id}"]`) : option.locator("input").first();
    return (await input.isChecked().catch(() => false)) ? "" : "点了但没选中";
  }
  if (f.type === "select") { await el.selectOption({ label: f.proposed }, { timeout: 3000 }); return (await el.evaluate((e) => (e as HTMLSelectElement).selectedOptions[0]?.text.trim())) === f.proposed ? "" : "没选中"; }
  if (["dropdown", "cascader", "date", "month"].includes(f.type)) return choose(page, el, f.proposed, { monthBox: f.placeholder === "月" });
  if (!TEXTUAL.has(f.type)) return "这种控件还不会自动操作";
  if (!(await el.isEditable().catch(() => false))) return "只读";
  // a one-line box keeps no line breaks: items go on one line, without their numbers (the page dropped the breaks and
  // the read-back never matched — 「个人特长」, 2026-10-14)
  if (f.type !== "textarea" && /\n/.test(f.proposed)) f = { ...f, proposed: f.proposed.replace(/^\s*\d+[.、．]\s*/gm, "").split(/\n+/).map((x) => x.trim()).filter(Boolean).join("；") };
  // a box with a length limit (Moka: 255): cut at the last sentence or item that fits, and say so
  const max = Number(await el.getAttribute("maxlength").catch(() => null)) || 0;
  if (max > 0 && f.proposed.length > max) {
    const flat = f.proposed.replace(/^\s*\d+[.、．]\s*/gm, "").split(/\n+/).map((x) => x.trim()).filter(Boolean).join("；");
    const cut = flat.length <= max ? flat : flat.slice(0, max);
    const end = Math.max(cut.lastIndexOf("；"), cut.lastIndexOf("。"));
    f = { ...f, proposed: flat.length <= max ? flat : cut.slice(0, end > max * 0.5 ? end + 1 : max) };
    shortened.set(keyOf(f), max);
  }
  await el.fill(f.proposed, { timeout: 3000 });
  await el.blur();
  let now = "";
  for (let i = 0; i < 8; i++) { await page.waitForTimeout(150); now = (await el.inputValue().catch(() => "")).trim(); if (now === f.proposed.trim()) return ""; }
  return now ? `页面改成了「${now}」` : "填了但页面没有接受";
}

/**
 * The form is gone. With a success message the application is marked submitted; without one the user is asked once.
 * Either way what the user typed themselves — fields the profile could not answer — goes back into the profile, so the
 * next form needs less of them. Sensitive fields never do.
 */
function finish(s: Services, ok: boolean, why: string): void {
  if (!run) return;
  const learned: string[] = [];
  for (const f of lastForm) {
    const v = f.value.trim();
    if (!f.label || f.type === "file" || f.type === "password" || SENSITIVE.test(f.label) || peopleSection(f.section) || EMPTY.test(v) || ours.has(keyOf(f))) continue;
    if (f.status !== "画像里没有" && f.status !== "由你填写") continue;
    if (f.factKey && !/^(basic|pref)\./.test(f.factKey)) continue; // an entry of a multi-row kind or a part of an education record
    if (blockKind(f.section)) continue; // 教育 / 实习 / 项目 entries are records, not 基本信息
    if (!f.factKey && (f.type === "checkbox" || f.type === "radio" || v.length > 200)) continue;
    if (/^[+\-\d\s]*$/.test(normLabel(f.label)) || /发送|获取|重新/.test(f.label)) continue; // 「+86」, a button's text: not a question
    const kind = f.factKey.startsWith("pref.") ? "preference" : "basic";
    const field = f.factKey ? f.factKey.slice(f.factKey.indexOf(".") + 1) : normLabel(f.label);
    try { upsertFact(s.domain.db, { kind, data: { field, value: v } }, "本人确认"); learned.push(f.label); } catch { /* not a fact the profile can hold */ }
  }
  if (ok) s.domain.updateApplication({ id: run.applicationId, state: "submitted", resumeLabel: run.resume || undefined, note: `网申：${why}` }, "jobos:apply");
  if (learned.length) s.onDataChanged?.();
  set(s, { state: ok ? "已投递" : "结果待核实", reason: ok ? "" : why, learned });
}
