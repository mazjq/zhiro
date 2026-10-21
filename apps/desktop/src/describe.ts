const when = (s: string) => s.slice(5, 16).replace("T", " ");

export const FRIENDLY: Record<string, string> = { INVALID_TRANSITION: "这条申请的状态已经变了，这个改动不再适用，可以忽略。", EXPIRED: "已过期。", ALREADY_DECIDED: "已经处理过了。", HASH_MISMATCH: "内容已变化，请刷新。", NOT_UNDOABLE: "这个操作没有自动撤销，请手动改回。", ALREADY_UNDONE: "已经撤销过了。" };

/** A proposal (confirm card) said the way the user would say it. `app` turns an application id into 「公司 · 岗位」. */
export function describeProposal(p: any, app: (id?: string) => string = () => "一条申请"): string {
  const x = p.payload ?? {}, target = app(x.applicationId ?? x.id);
  if (p.kind === "stage.add") return `给${target}记一条进展：${x.kind}${x.scheduledAt ? " · " + when(x.scheduledAt) : ""}`;
  if (p.kind === "stage.update") return x.result ? `把${target}的环节标为「${x.result}」` : `把${target}的环节改到 ${when(x.scheduledAt ?? "")}`;
  if (p.kind === "application.update") return x.state === "closed" ? `把${target}标为已结束（${x.closeReason ?? ""}）` : x.state === "submitted" ? `把${target}标为已投递` : x.nextAction ? `给${target}记一条待办：${x.nextAction}` : `更新${target}`;
  if (p.kind === "recommend.tag") return `打标签「${x.tag}」`;
  if (p.kind === "application.create") return "为一个岗位准备申请";
  if (p.kind === "fact.remove") { const c: string[] = p.context?.cards ?? []; return c.length > 1 ? `删除 ${c.length} 张事实卡（进最近删除）：${c.join("；")}` : c.length ? `删除事实卡「${c[0]}」（进最近删除）` : "删除一张事实卡（进最近删除）"; }
  if (p.kind === "fact.merge") { const m: string[] = p.context?.merges ?? []; return m.length ? `合并近似重复的事实卡（${m.length} 对，被并入的那张的来源会转过去）：${m.join("；")}` : "合并两张事实卡"; }
  if (p.kind === "company.merge") {
    const c = p.context;
    if (!c?.from) return "合并两家公司";
    const side = (x: any) => `「${x.name || "（已不在库里）"}」${x.exists ? `（${x.positions} 个岗位${x.official ? "，有官方来源" : "，只有汇总表"}）` : ""}`;
    return `把${side(c.from)}并入${side(c.into)}${c.signals?.length ? "。依据：" + c.signals.join("；") : "。数据里没有找到是同一家的证据"}`;
  }
  if (p.kind === "resume.remove") return "从简历库移除一份简历";
  if (p.kind === "preset.remove") return "删除一个搜索模式";
  if (p.kind === "feishu.notify") return `发一条飞书通知：${x.title ?? ""}`;
  if (p.kind === "company.find") return `联网去找「${x.companyName ?? x.name ?? ""}」的校招入口（会消耗模型额度）`;
  if (p.kind === "research.company") return `联网调研「${x.companyName ?? ""}」（会消耗模型额度）`;
  if (p.kind === "research.topic") return `联网调研主题「${x.topic ?? ""}」${x.region ? `（${x.region}）` : ""}：几分钟，会消耗联网 worker 的额度；资料摘要会发给它用来判断合不合适`;
  if (p.kind === "import.csv") return `导入 CSV：${x.path ?? ""}`;
  if (p.kind === "company.alias") return `把「${x.alias ?? ""}」记为一家公司的别名（之后这个名字就指它）`;
  if (p.kind === "source.add") return `把这张表接成每天自动更新的数据源：${x.url ?? ""}`;
  if (p.kind === "apply.reference") return x.path ? `网申时以这份文档为准（获奖、项目、特长、常见栏目）：${x.path}` : "网申不再读那份文档";
  if (p.kind === "source.remove") return `删除订阅 ${x.id ?? ""}（它带来的、你没关注也没申请的岗位会一起清掉）`;
  if (p.kind === "campaign.deadline") return `把「${x.companyName ?? ""}」的截止日期改为 ${x.date ?? ""}`;
  if (p.kind === "intel.smeResearch") return `联网查找「${x.region ?? ""}」的专精特新名单并入库（会消耗模型额度）`;
  if (p.kind === "intel.smeImport") return `导入专精特新名单：${x.path ?? "vault/research/sme-list.csv"}`;
  return p.kind;
}
