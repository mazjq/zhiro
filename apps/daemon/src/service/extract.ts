import { parseJsonWithRepair, contentText } from "@earendil-works/pi-ai";
import type { Llm } from "../llm.js";
import type { Listing } from "../data/index.js";
import type { SourceContext } from "../data/index.js";
import { decodeQr, isHttpUrl } from "./qr.js";

/** Article text extraction: mp.weixin (#js_content) first, then a generic tag-stripper. No readability dep (ponytail). */
export interface Article { title: string; text: string; images: string[] }

export function articleText(html: string, url: string): Article {
  const strip = (s: string) => s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<!--[\s\S]*?-->/g, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/h\d>|<\/tr>/gi, "\n").replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"')
    .replace(/[ \t]+/g, " ").replace(/\n\s*\n\s*\n+/g, "\n\n").trim();
  const title = strip(/<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? "").split(/[-|｜_]/)[0].trim().slice(0, 80);
  const imagesIn = (seg: string) => Array.from(new Set(Array.from(seg.matchAll(/(?:data-src|src)="(https?:\/\/[^"]+?)"/g)).map((m) => m[1].replace(/&amp;/g, "&")).filter((u) => /mmbiz\.qpic\.cn|\.(?:png|jpe?g|webp)(?:\?|$)/i.test(u))));
  if (/mp\.weixin\.qq\.com/.test(url)) {
    const t = /id="activity-name"[^>]*>([\s\S]*?)<\/h1>/.exec(html)?.[1];
    const start = html.indexOf('id="js_content"');
    const endCandidates = ['id="js_pc_qr_code"', 'class="rich_media_tool"', "</body>"].map((m) => html.indexOf(m, start)).filter((i) => i > start);
    const body = start >= 0 ? html.slice(start, endCandidates.length ? Math.min(...endCandidates) : undefined) : html;
    return { title: t ? strip(t) : title, text: strip(body).replace(/^[^>]*>/, "").trim().slice(0, 40_000), images: imagesIn(body) };
  }
  const main = /<(?:article|main)[^>]*>([\s\S]*?)<\/(?:article|main)>/i.exec(html)?.[1] ?? /<body[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
  return { title, text: strip(main).slice(0, 40_000), images: imagesIn(main) };
}

/** Download up to `max` images (each ≤ maxBytes) for vision extraction. Referer set for mmbiz CDN. */
export async function loadImages(urls: string[], ctx: SourceContext, max = 8, maxBytes = 4_000_000): Promise<{ data: string; mimeType: string; qr: string[] }[]> {
  const out: { data: string; mimeType: string; qr: string[] }[] = [];
  for (const u of urls.slice(0, max)) {
    try {
      const res = await fetch(u, { headers: { referer: "https://mp.weixin.qq.com/", "user-agent": "Mozilla/5.0" }, signal: ctx.signal });
      const mime = res.headers.get("content-type")?.split(";")[0] ?? "";
      if (!res.ok || !/^image\/(png|jpeg|webp|gif)$/.test(mime)) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length > maxBytes || buf.length < 2_000) continue;
      out.push({ data: buf.toString("base64"), mimeType: mime, qr: decodeQr(buf, mime) });
    } catch { /* skip */ }
  }
  return out;
}

/** Thrown when a page is a bot/verification wall (WeChat 环境异常 etc.). Callers tell the user to capture via the bookmarklet instead. */
export class VerificationWall extends Error {
  code = "VERIFY_REQUIRED";
}
const WALL = /环境异常|完成验证后即可继续访问|请在微信客户端打开|访问过于频繁|参数错误|该内容已被发布者删除|此内容因违规无法查看/;

export interface NoticeExtraction {
  isRecruitment: boolean;
  company: string;
  publisherType: "企业官方" | "高校就业网" | "公众号转载" | "聚合平台" | "其他";
  cohort: string;
  batch: string;
  kind: string;
  deadlineText: string;
  applyUrl: string;
  cities: string[];
  degreeReq: string;
  majorReq: string;
  positions: { title: string; closesAt?: string; cities: string[]; degreeReq: string; majorReq: string; jd: string }[];
  notes: string;
  /** decoded QR payloads found in poster images (may include weixin:// mini-program links) */
  qrCodes?: string[];
}

const SYSTEM = `你是校招简章抽取器。输入是一篇招聘公告的纯文本（可能来自企业官网、高校就业网、微信公众号转载或聚合平台）。
只输出一个 JSON 对象，不要 Markdown，不要解释。字段：
{"isRecruitment":bool, "company":"招聘主体全称", "publisherType":"企业官方|高校就业网|公众号转载|聚合平台|其他",
 "cohort":"如 2027届，没有则空", "batch":"提前批|秋招|春招|实习|博士专项|人才计划|社招|空", "kind":"校招|博士专项|人才计划|博士后|社招|实习",
 "deadlineText":"原文里说【投递/网申何时截止】的那句话，没有则空", "applyUrl":"投递链接，没有则空", "cities":["工作城市"], "degreeReq":"整体学历要求", "majorReq":"整体专业要求",
 "positions":[{"title":"岗位名","cities":[],"degreeReq":"","majorReq":"","closesAt":"该岗位自己的投递截止 YYYY-MM-DD，没写则空","jd":"该岗位职责与要求原文摘录，200字内"}],
 "notes":"笔试/宣讲/其他关键信息，60字内"}
规则：不编造；原文没有的字段留空；一篇公告多个岗位就列多个；岗位名去掉序号。
截止只认投递/网申的截止：报名或网申【开始】的日期、笔试、面试、宣讲、发 offer 的日期都不是截止，不要写进 deadlineText 或 closesAt。
各岗位截止不同时，每个岗位的截止写进它自己的 closesAt，deadlineText 写「各岗位截止不同」；只有一个统一截止时才写 deadlineText。「招满即止」「长期有效」照原文写进 deadlineText。`;

export async function extractNotice(llm: Llm, text: string, url: string, title = "", images: { data: string; mimeType: string; qr?: string[] }[] = []): Promise<NoticeExtraction> {
  const model = llm.model();
  const qrs = Array.from(new Set(images.flatMap((im) => im.qr ?? [])));
  const user = `来源 URL：${url}\n标题：${title}\n\n正文：\n${text.slice(0, 24_000)}${images.length ? `\n\n（正文很短，随附 ${images.length} 张公告图片，请从图片中读取招聘信息）` : ""}${qrs.length ? `\n\n图片中解出的二维码内容（可能是投递入口/网申链接/小程序）：\n${qrs.map((q) => "- " + q).join("\n")}` : ""}`;
  const canSee = (model as any).input?.includes?.("image");
  const content: any[] = [{ type: "text", text: user }, ...(canSee ? images.map((im) => ({ type: "image", data: im.data, mimeType: im.mimeType })) : [])];
  const msg = await llm.models.completeSimple(model, { systemPrompt: SYSTEM, messages: [{ role: "user", content, timestamp: Date.now() }] }, { reasoning: "low" });
  const raw = contentText(msg.content).trim().replace(/^```(?:json)?\s*|\s*```$/g, "");
  const ex = parseJsonWithRepair<Partial<NoticeExtraction>>(raw);
  const qrUrl = qrs.find(isHttpUrl);
  return {
    isRecruitment: ex.isRecruitment !== false,
    company: (ex.company ?? "").trim(),
    publisherType: (ex.publisherType as NoticeExtraction["publisherType"]) ?? "其他",
    cohort: ex.cohort ?? "", batch: ex.batch ?? "", kind: ex.kind ?? "校招", deadlineText: ex.deadlineText ?? "", applyUrl: ex.applyUrl || qrUrl || "",
    qrCodes: qrs,
    cities: ex.cities ?? [], degreeReq: ex.degreeReq ?? "", majorReq: ex.majorReq ?? "",
    positions: (ex.positions ?? []).filter((p) => p && p.title).map((p) => ({ title: String(p.title).trim(), cities: p.cities ?? [], degreeReq: p.degreeReq ?? "", majorReq: p.majorReq ?? "", jd: p.jd ?? "" })),
    notes: ex.notes ?? "",
  };
}

export function noticeToListings(ex: NoticeExtraction, url: string, sourceId: string): Listing[] {
  const grade = ex.publisherType === "企业官方" ? "官方" : ex.publisherType === "高校就业网" || ex.publisherType === "公众号转载" ? "校方转载" : "聚合";
  const host = (() => { try { return new URL(url).hostname; } catch { return "web"; } })();
  const base = { company: ex.company, cohort: ex.cohort || undefined, batch: ex.batch || undefined, kind: ex.kind || undefined, deadlineText: ex.deadlineText || undefined, publisher: `${sourceId}:${host}`, grade: grade as Listing["grade"], isOriginal: grade === "官方", confidence: 0.7 };
  const positions = ex.positions.length ? ex.positions : [{ title: `${ex.company} ${ex.batch || ex.kind || "招聘"}`.trim(), cities: ex.cities, degreeReq: ex.degreeReq, majorReq: ex.majorReq, jd: ex.notes }];
  return positions.map((p, i) => ({
    ...base,
    externalId: `${url}#${i}`,
    url: ex.applyUrl || url,
    title: p.title,
    locations: p.cities.length ? p.cities : ex.cities,
    description: p.jd,
    validThrough: /^\d{4}-\d{2}-\d{2}$/.test(p.closesAt ?? "") ? p.closesAt : undefined,
    degreeReq: p.degreeReq || ex.degreeReq || undefined,
    majorReq: p.majorReq || ex.majorReq || undefined,
    raw: { notes: ex.notes, noticeUrl: url, qrCodes: ex.qrCodes ?? [] },
  }));
}

export async function fetchArticle(url: string, ctx: SourceContext): Promise<Article & { html: string }> {
  const html = await ctx.fetchText(url, { headers: { accept: "text/html" } });
  const a = articleText(html, url);
  if (/mp\.weixin\.qq\.com/.test(url) && (!html.includes('id="js_content"') || (a.text.length < 40 && a.images.length === 0)) && WALL.test(html)) {
    throw new VerificationWall("公众号返回了验证/不可访问页，daemon 无法完成人机验证；请在浏览器打开这篇文章后用 Zhiro 书签捕获");
  }
  return { ...a, html };
}
