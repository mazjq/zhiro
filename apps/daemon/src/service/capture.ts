import { ulid } from "ulid";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { now } from "../db.js";
import { Domain, DomainError, genericCompany } from "./domain.js";
import { parseDeadline, splitList } from "../data/index.js";
import { ingest } from "../data/index.js";
import { httpContext } from "../data/index.js";
import { articleText, extractNotice, noticeToListings, fetchArticle, loadImages } from "./extract.js";
import type { Listing } from "../data/index.js";
import type { Llm } from "../llm.js";

/**
 * listing.capture — the push path for any recruiting page or notice:
 *  bookmarklet posts { url, title, text, html } · user pastes { url } (we fetch) · user pastes { text }.
 * Raw page is stored immutably, then extraction (LLM when configured, heuristics otherwise) → Listing[] → ingest().
 */
export interface CaptureInput { url: string; title?: string; text?: string; html?: string; publisher?: string; companyName?: string }

function host(url: string): string {
  try { return new URL(url).hostname; } catch { return ""; }
}

export function providerOf(url: string): { provider: string; grade: Listing["grade"] } {
  const h = host(url);
  if (/mokahr\.com/.test(h)) return { provider: "moka", grade: "官方" };
  if (/zhiye\.com|beisen\.com/.test(h)) return { provider: "beisen", grade: "官方" };
  if (/51job\.com/.test(h)) return { provider: "51job", grade: /campus/.test(url) ? "官方" : "聚合" };
  if (/nowcoder\.com/.test(h)) return { provider: "nowcoder", grade: "聚合" };
  if (/mp\.weixin\.qq\.com/.test(h)) return { provider: "mp-weixin", grade: "校方转载" };
  if (/zhipin\.com/.test(h)) return { provider: "boss", grade: "聚合" };
  if (/\.edu\.cn$/.test(h)) return { provider: "jyw", grade: "校方转载" };
  return { provider: "web", grade: "聚合" };
}

/** Regex fallback when no LLM is configured. Exported for tests. */
export function extractHeuristic(text: string, title = "") {
  const t = text.replace(/\r/g, "");
  const pick = (re: RegExp) => (t.match(re)?.[1] ?? "").trim();
  const company = pick(/(?:公司|企业|单位)[名称]*[:：]\s*([^\n]{2,40})/) || title.split(/[-|｜–—]/)[0].trim().slice(0, 40);
  const cohort = pick(/(20\d\d\s*届)/).replace(/\s/g, "");
  const batch = pick(/(提前批|秋招|春招|秋季校园招聘|春季校园招聘|校园招聘|博士专项|实习)/);
  const deadlineText = pick(/(?:截止|投递时间|网申时间|报名时间)[^\n]*?(?:至|到|-|—|~)?\s*([^\n]{4,30})/);
  const cities = splitList(pick(/(?:工作地点|城市|地点)[:：]\s*([^\n]{2,60})/));
  const degree = pick(/(博士|硕士及以上|硕士|本科及以上|本科)/);
  const titles = Array.from(t.matchAll(/^\s*[\d一二三四五六七八九十]*[.、)]?\s*([^\n]{2,30}?(?:工程师|研究员|算法|开发|架构师|专家|经理|设计师|科学家|博士后|管培生))\s*$/gm)).map((m) => m[1].trim());
  return { company, cohort, batch, deadlineText, cities, degree, titles: Array.from(new Set(titles)).slice(0, 30) };
}

function heuristicListings(text: string, title: string, url: string): Listing[] {
  const ex = extractHeuristic(text, title);
  if (!ex.company) return [];
  const { provider, grade } = providerOf(url);
  const dl = parseDeadline(ex.deadlineText);
  const titles = ex.titles.length ? ex.titles : [title.slice(0, 40) || "未命名岗位"];
  return titles.map((t, i) => ({
    externalId: `${url}#${i}`, url, title: t, company: ex.company, locations: ex.cities, description: ex.titles.length ? "" : text.slice(0, 4000),
    degreeReq: ex.degree || undefined, cohort: ex.cohort || undefined, batch: ex.batch || undefined, kind: /博士/.test(ex.batch) ? "博士专项" : "校招",
    validThrough: dl.closesAt ? `${dl.closesAt}T00:00:00.000Z` : undefined, deadlineText: ex.deadlineText || undefined,
    publisher: `capture:${provider}`, grade, isOriginal: grade === "官方", confidence: 0.4,
  }));
}

export async function capture(domain: Domain, vault: string, input: CaptureInput, llm?: Llm) {
  const id = ulid();
  const dir = join(vault, "captures");
  mkdirSync(dir, { recursive: true });
  let { title = "", text = "", html } = input;
  let images: string[] = [];
  const ctx = httpContext();
  if (!text) {
    let a: Awaited<ReturnType<typeof fetchArticle>>;
    try { a = await fetchArticle(input.url, ctx); }
    catch (e: any) {
      if (e?.code === "VERIFY_REQUIRED") return { captureId: id, campaignId: null, positionIds: [], note: e.message };
      throw e;
    }
    title = title || a.title; text = a.text; html = html ?? a.html; images = a.images;
  } else if (html) {
    const a = articleText(html, input.url);
    title = title || a.title; images = a.images;
    if (text.trim().length < 200 && a.text.length > text.length) text = a.text;
  }
  const textPath = join(dir, `${id}.txt`);
  writeFileSync(textPath, `# ${title}\n# ${input.url}\n# ${now()}\n# images: ${images.length}\n\n${text}${images.length ? "\n\n## images\n" + images.join("\n") : ""}`, "utf8");
  if (html) writeFileSync(join(dir, `${id}.html`), html, "utf8");
  const { provider } = providerOf(input.url);
  domain.db.prepare("insert into capture(id, url, title, text_path, publisher, created_at) values (?,?,?,?,?,?)").run(id, input.url, title, textPath, input.publisher ?? provider, now());

  let listings: Listing[];
  let how: string;
  if (llm) {
    try {
      const pics = text.trim().length < 600 && images.length ? await loadImages(images, ctx) : [];
      const ex = await extractNotice(llm, text, input.url, title, pics);
      if (!ex.isRecruitment) return { captureId: id, campaignId: null, positionIds: [], note: "模型判断这不是招聘公告，已保存原文未入库" };
      if (input.companyName?.trim()) ex.company = input.companyName.trim();
      if (!ex.company) return { captureId: id, campaignId: null, positionIds: [], note: "未识别招聘主体，已保存原文，请手动补录" };
      listings = noticeToListings(ex, input.url, "capture");
      how = `LLM 抽取${ex.notes ? "；" + ex.notes : ""}${ex.qrCodes?.length ? `；二维码 ${ex.qrCodes.length} 个` : ""}`;
    } catch (e: any) {
      if (e?.code === "MODEL_DELEGATED") throw e; // ADR-032: the answer comes later, from the agent
      if (e?.code === "BUDGET_DEFERRED") throw e; // the allowance is short: wait, never file a rough guess instead (budget/)
      listings = heuristicListings(text, title, input.url);
      how = `LLM 抽取失败（${String(e?.message ?? e).slice(0, 80)}），已用启发式`;
    }
  } else {
    listings = heuristicListings(text, title, input.url);
    how = "启发式抽取（未配置模型），置信度低";
  }
  if (input.companyName?.trim()) for (const l of listings) l.company = input.companyName.trim();
  if (!listings.length) return { captureId: id, campaignId: null, positionIds: [], note: `未识别公司名，已保存原文（${how}）` };
  // the page calls itself 「公司」 and never says which: filing it would make a company named 公司 (it did, three times)
  if (listings.some((l) => genericCompany(l.company))) throw new DomainError("COMPANY_UNKNOWN", `页面里只写了「${listings.find((l) => genericCompany(l.company))!.company}」，没认出是哪家公司；原文已保存。请带 companyName 再调一次 listing.capture`);
  const { campaignIds, positionIds } = ingest(domain, vault, "capture", id, listings).listed;
  const campaignId = campaignIds[0] ?? null;
  return { captureId: id, campaignId, positionIds, note: `${listings[0].company} · ${listings[0].batch ?? listings[0].kind ?? ""} · ${positionIds.length} 个岗位（${how}）` };
}
