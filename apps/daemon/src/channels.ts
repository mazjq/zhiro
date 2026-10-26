import type { Services } from "./services.js";
import { sources } from "./data/index.js";

/**
 * The data layer in one place (ADR-031). Three things kept apart:
 *  - Channel: code in the repo that knows how to get one kind of data (this list).
 *  - Subscription: the user's configuration of a channel, in their vault (`sources:` in jobos.yaml, mail accounts, …).
 *  - Record: the data itself, in jobos.db / vault files, each row with its source and fetch time.
 * Only this description is shared; each channel keeps its own code where it already lives.
 */
export type Produces = "岗位" | "企业情况" | "行业" | "专精特新名录" | "调研报告" | "申请进展";
export interface Channel {
  id: string; name: string; produces: Produces;
  trigger: "定时" | "按需" | "推送";
  cost: "免费" | "模型" | "联网调研";
  input: string;
  covers?: string;
  /** tools that read or feed this channel */
  tools: string[];
}

const pull = (id: string, name: string, input: string): Channel => ({ id, name, produces: "岗位", trigger: "定时", cost: "免费", input, tools: ["source.add", "scan.run", "source.list"] });
const intel = (id: string, name: string, covers: string): Channel => ({ id: `intel:${id}`, name, produces: "企业情况", trigger: "按需", cost: "免费", input: "公司", covers, tools: ["company.intelRefresh", "company.intel", "company.intelDetail"] });

/** 岗位 readers come from the registry at the time of asking, so a reader is listed the moment it is registered. */
export const channels = (): Channel[] => [
  ...Object.values(sources).filter((x) => x.fetch).map((x) => pull(x.id, x.name, x.input ?? "")),
  { id: "leads", name: "线索补全（待补资料 → 具体岗位）", produces: "岗位", trigger: "定时", cost: "模型", input: "方向相关、只有类别的公司的公告页；预算 leads.dailyBudget", tools: ["lead.list", "lead.resolve"] },
  { id: "capture", name: "任意页面抓取", produces: "岗位", trigger: "按需", cost: "模型", input: "链接或书签（公众号、就业网、官网）", tools: ["listing.capture"] },
  { id: "csv:import", name: "CSV 一次性导入（旧；要持续更新请用订阅）", produces: "岗位", trigger: "按需", cost: "免费", input: "17 列汇总表 CSV", tools: ["import.csv"] },
  intel("listing", "上市身份（巨潮；新三板经东财代码表；美股经东财搜索）", "所有公司"),
  intel("basic", "公司概况：行业、省份、员工数、成立与上市日（东财 F10）；新三板取股转年报的员工总数与研发人员", "A股、新三板、美股"),
  intel("finance", "近三年营收、净利、研发、职工现金（东财 + 新浪；新三板东财三板 F10）", "A股、港股、新三板、美股"),
  intel("dividends", "分红（东财）", "A股"),
  intel("announcements", "近一年公告关键词（巨潮）", "A股"),
  intel("holders", "十大股东、实际控制人（东财 F10）", "A股"),
  intel("irm", "投资者问答：公司自己的回复（互动易 / e互动）", "A股"),
  intel("sectors", "所属行业与概念（东财）", "A股"),
  intel("reports", "近一年券商研报（东财）", "A股"),
  intel("forecast", "业绩预告（东财）", "A股"),
  intel("news", "新闻（华尔街见闻）", "所有公司"),
  intel("ipo", "IPO 审核进度（深交所）", "所有公司"),
  { id: "industry:reports", name: "券商行业研报（东财研报中心）：标题、机构、日期、评级、原文", produces: "行业", trigger: "按需", cost: "免费", input: "行业名或主题词", covers: "A 股行业分类与热门主题；观点，不是事实", tools: ["industry.reports"] },
  { id: "industry:companies", name: "主题 / 行业在股市里的上市公司（东财板块成分股）：市值、主营行业", produces: "行业", trigger: "按需", cost: "免费", input: "主题词或行业名", covers: "A 股；候选名单，不是行业样本", tools: ["industry.companies"] },
  { id: "company:financials", name: "按公司名或代码查上市公司经营数据：员工数、近三年营收 / 净利 / 研发", produces: "企业情况", trigger: "按需", cost: "免费", input: "公司名或股票代码（不必在岗位库里）", covers: "A股、港股、美股、新三板", tools: ["company.financials"] },
  { id: "labor:us", name: "美国分职业就业人数与年薪（劳工统计局 BLS · OEWS）", produces: "行业", trigger: "按需", cost: "免费", input: "SOC 职业代码", covers: "美国，全国合计，年度；每天约 25 次", tools: ["labor.us"] },
  { id: "sme:url", name: "名单链接解析", produces: "专精特新名录", trigger: "按需", cost: "免费", input: "公示网页 / PDF / xlsx / docx / 飞书表", tools: ["intel.smeFromUrl"] },
  { id: "sme:research", name: "联网找名单", produces: "专精特新名录", trigger: "按需", cost: "联网调研", input: "省或市", tools: ["intel.smeResearch"] },
  { id: "sme:csv", name: "名单 CSV 导入", produces: "专精特新名录", trigger: "按需", cost: "免费", input: "vault/research/sme-list.csv", tools: ["intel.smeImport"] },
  { id: "research", name: "联网调研公司", produces: "调研报告", trigger: "按需", cost: "联网调研", input: "公司", covers: "所有公司（非上市主要靠它）", tools: ["research.company"] },
  { id: "topic", name: "主题调研（行业 / 方向 → 公司 → 岗位）", produces: "调研报告", trigger: "按需", cost: "联网调研", input: "主题、地区", covers: "报告只存档，不改岗位库；公司与岗位库的对照打开时现算", tools: ["research.topic", "research.topics", "research.report"] },
  { id: "find", name: "找库外公司的校招入口", produces: "调研报告", trigger: "按需", cost: "联网调研", input: "公司名", tools: ["company.find"] },
  { id: "inbox", name: "邮箱（163 / QQ IMAP）", produces: "申请进展", trigger: "定时", cost: "模型", input: "邮箱 + 授权码（只能本人在界面填）", tools: ["inbox.pull"] },
  { id: "inbox:paste", name: "粘贴通知（短信、微信）", produces: "申请进展", trigger: "推送", cost: "模型", input: "通知文本", tools: ["inbox.paste"] },
];

/** Channels with their subscriptions and how much data they hold — the settings page and the assistant read this. */
export function listChannels(s: Services) {
  const db = s.domain.db;
  const one = (sql: string, ...a: any[]) => db.prepare(sql).get(...a) as any;
  const subs = (id: string) => s.config.sources.filter((c) => c.source === id);
  return channels().map((c) => {
    let subscriptions: number | undefined, records = 0, updatedAt: string | null = null;
    if (c.produces === "岗位" && sources[c.id]?.fetch) {
      subscriptions = subs(c.id).length;
      const r = one("select count(*) n, max(fetched_at) u from source_listing where provider = ?", c.id);
      // a listing row is rewritten only when it changed (ADR-063): the last read that found posts says when it was current
      const read = one("select max(finished_at) u from scan_run where source = ? and error = '' and found > 0", c.id);
      records = r.n; updatedAt = [r.u, read?.u].filter(Boolean).sort().pop() ?? null;
    } else if (c.id.startsWith("intel:")) {
      const r = one("select count(*) n, max(fetched_at) u from company_intel where kind = ?", c.id.slice(6));
      records = r.n; updatedAt = r.u;
    } else if (c.produces === "专精特新名录") {
      const r = one("select count(*) n, max(updated_at) u from sme_list"); records = r.n; updatedAt = r.u;
    } else if (c.id === "research" || c.id === "find" || c.id === "topic") {
      const r = one("select count(*) n, max(started_at) u from agent_run where mode = ?", c.id === "research" ? "research.company" : c.id === "topic" ? "research.topic" : "company.find"); records = r.n; updatedAt = r.u;
    } else if (c.produces === "申请进展") {
      const r = one(`select count(*) n, max(received_at) u from message where account ${c.id === "inbox" ? "!=" : "="} 'paste'`); records = r?.n ?? 0; updatedAt = r?.u ?? null;
    }
    return { ...c, subscriptions, records, updatedAt };
  });
}
