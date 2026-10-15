import { createCipheriv } from "node:crypto";
import type { Listing, Source, SourceContext } from "../types.js";

/**
 * 中国华能招聘 (zhaopin.chng.com.cn): a yudao/ruoyi Vue app whose read API wants the path tail (GET) or the body
 * (POST) AES-256-CBC encrypted, hex. The key and IV sit in the public bundle as Utf8.parse("…"); they are read from it on
 * every run, so a rebuilt bundle does not break us (verified 2026-09-29: 151 announcements, 150 for 2027). The whole
 * site is one subscription: announcement/index (recruitType=1 is required — without it page 1 is a cached 5-row list)
 * → announcement/select per announcement → its positions, each with unit, city, degree, majors, HTML JD, deadline.
 */
const BASE = "https://zhaopin.chng.com.cn";
const EDU: Record<string, string> = { "3": "专科", "4": "本科", "5": "硕士研究生", "6": "博士研究生" };
const ROUTE = ["CampusRecruit", "InternRecruit", "ManagementTraineeRecruit"];

async function keys(ctx: SourceContext): Promise<{ key: Buffer; iv: Buffer }> {
  const html = await ctx.fetchText(BASE + "/");
  for (const m of html.matchAll(/src="([^"]+\.js)"/g)) {
    const js = await ctx.fetchText(new URL(m[1], BASE + "/").toString());
    const s = [...js.matchAll(/Utf8\.parse\("([^"]+)"\)/g)].map((x) => x[1]);
    const key = s.find((x) => x.length === 32), iv = s.find((x) => x.length === 16);
    if (key && iv) return { key: Buffer.from(key), iv: Buffer.from(iv) };
  }
  throw new Error("SCHEMA_CHANGED: 华能：页面脚本里没找到接口密钥");
}

const text = (h?: string | null) => (h ?? "").replace(/<\/p>|<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, "").replace(/&nbsp;/g, " ").replace(/\n{3,}/g, "\n\n").trim();

/** One position of an announcement → Listing. Exported for tests. */
export function positionToListing(p: any, a: any, cohort: string): Listing | null {
  if (!p?.id || !p.positionName) return null;
  const end = String(p.endDate ?? a.endTime ?? "").slice(0, 10);
  return {
    externalId: String(p.id), url: `${BASE}/${ROUTE[a.taskType] ?? "CampusRecruit"}?positionId=${p.id}`, noticeUrl: `${BASE}/${ROUTE[a.taskType] ?? "CampusRecruit"}?aId=${a.id}`,
    title: String(p.positionName).trim(), company: String(p.recruitCompanyName || a.recruitCompanyName || "中国华能").trim(),
    locations: p.address ? String(p.address).split(/[,，、\s]+/).filter(Boolean) : [], description: text(p.jobReq),
    validThrough: /^\d{4}-\d{2}-\d{2}$/.test(end) ? end : undefined, deadlineText: p.endDate ?? undefined,
    degreeReq: EDU[String(p.eduType)] ?? undefined, majorReq: ((p.majors ?? []) as any[]).map((m) => m.majorName).filter(Boolean).join("、") || undefined,
    cohort, batch: a.taskType === 2 ? "管培生" : a.taskType === 1 ? "实习" : "校招", kind: a.taskType === 1 ? "实习" : String(p.eduType) === "6" ? "博士专项" : "校招",
    publisher: "chng", grade: "官方", isOriginal: true, confidence: 0.9,
  };
}

export const chng: Source = {
  id: "chng",
  name: "华能招聘网", input: "zhaopin.chng.com.cn 任一页面（整站校招/管培公告）", notices: true,
  mode: "pull",
  describe: "中国华能招聘网（zhaopin.chng.com.cn）：整站当前校招/管培/实习公告的全部岗位（含专业与截止），零 token",
  detect: (url) => /^https?:\/\/zhaopin\.chng\.com\.cn/i.test(url),
  siteKey: () => "zhaopin.chng.com.cn",
  async fetch(cfg, ctx) {
    const { key, iv } = await keys(ctx);
    const enc = (s: string) => { const c = createCipheriv("aes-256-cbc", key, iv); return c.update(s, "utf8", "hex") + c.final("hex"); };
    const get = async (rest: string, params: Record<string, string | number>) => {
      const r: any = await ctx.fetchJson(`${BASE}/app-api/recruit/${enc(`${rest}?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}`)}`, { headers: { referer: BASE + "/" } });
      if (r?.code !== 0) throw new Error(`SCHEMA_CHANGED: 华能 ${rest}：${r?.msg ?? "接口返回异常"}`);
      return r.data;
    };
    const year = (cfg.cohort ?? "2027").replace(/\D/g, "").slice(0, 4) || "2027";
    const anns: any[] = [];
    for (let p = 1; p <= 10; p++) {
      const d = await get("announcement/index", { pageNo: p, pageSize: 100, recruitType: 1 });
      anns.push(...(d?.list ?? []));
      if (!d?.list?.length || anns.length >= (d.total ?? 0)) break;
      await ctx.sleep(300);
    }
    const out: Listing[] = [];
    for (const a of anns.filter((x) => !x.recruitYear || String(x.recruitYear) >= year)) {
      const full = await get("announcement/select", { aId: a.id });
      for (const p of full?.positions ?? []) { const l = positionToListing(p, { ...a, ...full }, cfg.cohort ?? `${year}届`); if (l) out.push(l); }
      ctx.log(`chng ${String(a.title ?? "").slice(0, 20)}: ${out.length}`);
      await ctx.sleep(300);
    }
    return out;
  },
};
