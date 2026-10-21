import { useEffect, useRef, useState, type ReactNode } from "react";
import { call, daysLeft } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { Card, Chip, Button, gradeTone, deadlineTone, deadlineShort, STATE_LABEL } from "../ui";

/** A 公众号 article is a poster, not a place to apply — whichever column the sheet put it in. */
const isPoster = (u: string) => u.includes("mp.weixin.qq.com");
const A = ({ href }: { href: string }) => <a className="text-accent" href={href} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>{href}</a>;

/** 投递 = where to apply, 简章 = the announcement. Sources often give both; show both, each under its real name. */
/** The link one can actually apply at, or "" when the source only gave a poster. */
export const applyLink = (applyUrl: string, noticeUrl: string) => [applyUrl, noticeUrl].find((u) => u && !isPoster(u)) ?? "";

export function Links({ applyUrl, noticeUrl }: { applyUrl: string; noticeUrl: string }) {
  const apply = applyLink(applyUrl, noticeUrl);
  const notice = [noticeUrl, applyUrl].find((u) => u && u !== apply) ?? "";
  return (
    <>
      <dt className="text-ink-3">投递</dt><dd className="truncate">{apply ? <A href={apply} /> : "—"}</dd>
      {notice && <><dt className="text-ink-3">简章</dt><dd className="truncate"><A href={notice} /></dd></>}
    </>
  );
}

/** One company as the pool sees it: merged across sources. Shared by 推荐, 岗位库 and the "add this company?" card. */
export function CompanyFacts({ c }: { c: any }) {
  return (
    <dl className="grid grid-cols-[5em_1fr] gap-y-1 text-sm">
      <dt className="text-ink-3">截止</dt><dd title={c.deadline?.why || undefined}>{c.deadline?.summary || c.closesAt || c.deadlineText || "未知"}{c.expired && <span className="ml-2 font-sans"><Chip>已截止</Chip></span>}</dd>
      {c.deadline?.process && <><dt className="text-ink-3">流程</dt><dd>{c.deadline.process}</dd></>}
      {c.deadline?.rules?.length > 0 && <><dt className="text-ink-3">投递规则</dt><dd>{c.deadline.rules.map((r: any, i: number) => <div key={i}>{r.text}{r.url && <a className="ml-1.5 text-accent text-xs" href={r.url} target="_blank" rel="noreferrer">官网原文</a>}</div>)}</dd></>}
      <dt className="text-ink-3">城市</dt><dd>{c.cities.slice(0, 8).join("、") || "—"}</dd>
      <dt className="text-ink-3">学历/专业</dt><dd>{c.degreeReq || "—"} · {c.majorReq || "—"}</dd>
      <Links applyUrl={c.applyUrl} noticeUrl={c.noticeUrl} />
    </dl>
  );
}

/** The company's recruiting projects (批次) and where each came from — the same sheet imported twice shows up here, not as two companies. */
export function CompanyProjects({ c }: { c: any }) {
  return (
    <div className="text-sm">
      <div className="font-bold text-sm mb-1">招聘项目 · {c.sources.length}</div>
      {c.sources.map((s: any) => (
        <div key={s.campaignId} className="flex items-center gap-2 py-1 border-t border-line">
          <span className="flex-1">{s.batch || "校招"} <span className="text-xs text-ink-3">{s.cohort}</span></span>
          <span className="text-xs text-ink-3">{s.positions} 岗</span>
          <span className="font-mono text-xs">{s.closesAt ?? (s.deadlineText || "截止未知")}</span>
          <Chip tone={gradeTone(s.grade)}>{s.grade} · {s.sourceKind}</Chip>
        </div>
      ))}
    </div>
  );
}

/**
 * "京东" / "京东集团", "大疆" / "DJI大疆": spellings only a person can call the same employer. Search the other one,
 * confirm, and it folds into this company (its name stays as an alias, so later scans land here too).
 */
function MergeInto({ c, reload }: { c: any; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<any[]>([]);
  useEffect(() => {
    if (!q.trim()) { setHits([]); return; }
    const t = setTimeout(() => call("company.search", { query: q, limit: 8 }).then((r) => setHits(r.items.filter((x: any) => x.companyId !== c.companyId))).catch(() => setHits([])), 150);
    return () => clearTimeout(t);
  }, [q]);
  const merge = async (other: any) => {
    if (!confirm(`把「${other.companyName}」（${other.positions} 个岗位）并入「${c.companyName}」？\n两家会变成一家，「${other.companyName}」记为别名。这一步不能撤销。`)) return;
    await call("company.merge", { fromId: other.companyId, intoId: c.companyId }); setOpen(false); setQ(""); reload();
  };
  // the same unit spelled another way (「中船七二二所」 ↔ 「中国船舶集团有限公司第七二二研究所」): offered, never merged by itself
  const [twins, setTwins] = useState<any[]>([]);
  const latest = useLatest();
  const loadTwins = () => latest("twins", call("company.similar", { companyId: c.companyId })).then((r) => setTwins(r.items)).catch(() => setTwins([]));
  useEffect(() => { loadTwins(); }, [c.companyId]);
  useOnDataChange(loadTwins);
  const suggest = twins.length > 0 && (
    <div className="text-xs text-ink-2 mb-1">可能是同一家：{twins.map((t) => <button key={t.companyId} className="text-accent mr-2" title={`${t.positions} 个岗位${t.official ? "，有官方岗位" : "，只有汇总信息"}`} onClick={() => merge({ companyId: t.companyId, companyName: t.companyName, positions: t.positions })}>{t.companyName} 并入</button>)}</div>
  );
  if (!open) return <>{suggest}<button className="text-xs text-ink-3 underline decoration-dotted" onClick={() => setOpen(true)}>合并另一种写法</button></>;
  return (
    <div className="border border-line rounded-md p-2">
      <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜另一种写法，如 京东集团" className="w-full px-2.5 py-1.5 border border-line rounded-md bg-paper text-sm" />
      {hits.map((h) => <button key={h.companyId} onClick={() => merge(h)} className="w-full text-left px-2 py-1.5 text-sm hover:bg-ground border-t border-line mt-1">{h.companyName} <span className="text-xs text-ink-3">{h.positions} 个岗位 · 并入</span></button>)}
      <button className="text-xs text-ink-3 mt-1" onClick={() => setOpen(false)}>取消</button>
    </div>
  );
}

/**
 * The sheet often lists a company's jobs as loose categories. When its apply link is a system we can read (Moka / 北森),
 * one click pulls the real job list and keeps it updated daily.
 */
function OfficialSync({ c, reload }: { c: any; reload: () => void }) {
  const [links, setLinks] = useState<any[]>([]);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const latest = useLatest();
  const load = () => latest("links", call("company.official", { companyId: c.companyId })).then((r) => setLinks(r.links)).catch(() => setLinks([]));
  useEffect(() => { setMsg(""); load(); }, [c.companyId]);
  useOnDataChange(load);
  if (!links.length) return null;
  const todo = links.filter((l) => !l.configured);
  const sync = async () => {
    setBusy(true); setMsg("正在读取官方招聘页…");
    try {
      const r = await call("company.syncOfficial", { companyId: c.companyId });
      setMsg(r.message);
      load(); reload();
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="mb-3 text-xs rounded-md border border-line px-3 py-2 bg-ground/60">
      {todo.length ? <>官方招聘页（{todo.map((l) => l.source).join(" / ")}）正在自动接入</> : <>官方招聘页已接入，每天更新</>}
      <button className="ml-2 text-accent disabled:opacity-40" disabled={busy} onClick={sync}>{busy ? "同步中…" : "立即同步"}</button>
      {msg && <div className="mt-1 text-ink-2">{msg}</div>}
    </div>
  );
}

const yi = (v: any) => (v == null || Number.isNaN(Number(v)) ? "—" : `${(Number(v) / 1e8).toFixed(1)} 亿`);
const pct = (v: any) => (v == null || Number.isNaN(Number(v)) ? "" : `${Number(v) > 0 ? "+" : ""}${Number(v).toFixed(1)}%`);

/** What a kind of 企业情况 is called on the card, for saying which ones were not fetched. */
const KIND_LABEL: Record<string, string> = { listing: "上市信息", basic: "基本盘", finance: "财报", dividends: "分红", announcements: "公告", holders: "股东", irm: "投资者问答", sectors: "板块", reports: "研报", forecast: "业绩预告", news: "新闻", ipo: "上市审核进度" };

/** 企业情况 (ADR-029): one card, each kind of fact with the date it was fetched; refresh is one click or the assistant's call. */
function Intel({ c }: { c: any }) {
  const [x, setX] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const latest = useLatest();
  const load = () => latest("intel", call("company.intel", { companyId: c.companyId })).then(setX).catch(() => setX(null));
  useEffect(() => { setErr(""); load(); }, [c.companyId]);
  // kinds the person expanded: after a refresh (an agent updated the card) they are asked for in full again
  const expanded = useRef(new Set<string>());
  useEffect(() => { expanded.current.clear(); }, [c.companyId]);
  useOnDataChange(() => { if (!busy) load().then(() => { for (const k of expanded.current) detail(k); }); });
  const refresh = async () => { setBusy(true); setErr(""); try { const r = await call("company.intelRefresh", { companyId: c.companyId }); setX(r); const e = Object.keys(r.errors ?? {}); if (e.length) setErr(`这几类这次没取到，下次更新再试：${e.map((k) => KIND_LABEL[k] ?? k).join("、")}`); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  const row = (k: string) => x?.rows?.find((r: any) => r.kind === k);
  // the card gets summaries (more=true when something was left out); the whole kind is one call away
  const detail = (k: string) => call("company.intelDetail", { companyId: c.companyId, kind: k }).then((d) => setX((x: any) => (x?.rows ? { ...x, rows: x.rows.map((r: any) => (r.kind === k ? { ...r, data: d.data, more: false } : r)) } : x))).catch(() => {});
  const more = (k: string) => { if (!row(k)?.more) return; expanded.current.add(k); detail(k); };
  const More = ({ r }: { r: any }) => (r?.more ? <button className="text-xs text-accent ml-2" onClick={() => more(r.kind)}>展开</button> : null);
  const age = (r: any) => (r ? <span className="text-xs text-ink-3 ml-2" title={r.fetchedAt}>{r.ageDays === 0 ? "今天" : `${r.ageDays} 天前`}{r.ageDays > 30 ? " · 过期" : ""}</span> : null);
  const basic = row("basic"), fin = row("finance"), div = row("dividends"), ann = row("announcements"), news = row("news"), ipo = row("ipo"), holders = row("holders"), sectors = row("sectors"), forecast = row("forecast"), reports = row("reports"), irm = row("irm");
  const listed = x?.listing && !x.listing.none;
  const [researchMsg, setResearchMsg] = useState("");
  const [assessing, setAssessing] = useState(false);
  const assess = async () => {
    setAssessing(true);
    try { const r = await call("research.company", { companyName: c.companyName, question: "就业评估" }); setResearchMsg(`已交给你的 AI 助手写就业评估报告（约十几分钟），写好在这张公司卡下方的「调研」里，点「看报告」。运行 ${r.runId.slice(-6)}`); }
    catch (e: any) { setResearchMsg(e.message); setAssessing(false); }
  };
  return (
    <div className="mb-3 text-sm">
      <div className="flex items-center gap-2 mb-1">
        <span className="font-bold text-sm">企业情况</span>
        {x?.listing && (listed ? <Chip tone="good">{x.listing.market} {x.listing.code}</Chip> : <Chip>非上市</Chip>)}
        <span className="ml-auto"><Button onClick={refresh} disabled={busy}>{busy ? "抓取中…" : x?.rows?.length ? "更新" : "生成"}</Button></span>
      </div>
      {err && <div className="text-xs text-amber mb-1" title="多半是网络或数据源一时没响应；已有的数据照常显示">{err}</div>}
      {!x?.listing && !busy && <div className="text-xs text-ink-3">还没生成。上市公司能拿到财报、公告、分红；非上市只匹配专精特新名录，其余让助手联网调研。</div>}
      {basic && <div className="py-1 border-t border-line" title={`来源 ${basic.source}`}>{basic.data.industry}{basic.data.province && ` · ${basic.data.province}`}{basic.data.market?.startsWith("新三板") && ` · ${basic.data.market}`}{basic.data.employees != null && ` · 员工 ${Number(basic.data.employees).toLocaleString()} 人`}{basic.data.rdStaff != null && `（研发 ${basic.data.rdStaff}）`}{basic.data.staffYear && <a className="text-xs text-accent ml-1" href={basic.data.report?.url} target="_blank" rel="noreferrer">{basic.data.staffYear} 年报</a>}{basic.data.founded && ` · ${basic.data.founded.slice(0, 4)} 年成立`}{basic.data.listed && `，${basic.data.listed.slice(0, 4)} 年上市`}{age(basic)}</div>}
      {fin && (
        <div className="py-1 border-t border-line" title={`来源 ${fin.source}`}>
          <div className="text-xs text-ink-3">营收 / 归母净利 / 研发{fin.data.annual?.[0]?.currency && fin.data.annual[0].currency !== "人民币" ? `（${fin.data.annual[0].currency}）` : ""}{age(fin)}</div>
          {fin.data.annual?.map((a: any) => <div key={a.period} className="flex gap-3"><span className="w-16 text-ink-3">{a.period}</span><span>{yi(a.revenue)} <span className="text-xs text-ink-3">{pct(a.revenueYoy)}</span></span><span>{yi(a.netProfit)} <span className="text-xs text-ink-3">{pct(a.netProfitYoy)}</span></span><span className="text-ink-2">{a.rdExpense != null ? `研发 ${yi(a.rdExpense)}` : ""}</span></div>)}
          {fin.data.annual?.[0]?.staffCash && basic?.data.employees ? <div className="text-xs text-ink-2" title="现金流量表「支付给职工以及为职工支付的现金」÷ 员工数，含社保公积金与奖金，是公开数据里最接近人均薪酬的口径">人均职工现金 {fin.data.annual[0].period.slice(0, 4)}：约 {(fin.data.annual[0].staffCash / basic.data.employees / 1e4).toFixed(1)} 万/年</div> : null}
          {fin.data.latest && <div className="text-xs text-ink-3">最新 {fin.data.latest.period}：营收 {yi(fin.data.latest.revenue)} {pct(fin.data.latest.revenueYoy)}，净利 {yi(fin.data.latest.netProfit)} {pct(fin.data.latest.netProfitYoy)}</div>}
        </div>
      )}
      {div && div.data.items?.length > 0 && <div className="py-1 border-t border-line" title={`来源 ${div.source}`}>分红：{div.data.items.map((d: any) => `${d.period.slice(0, 7)} ${d.plan}`).join("；")}<More r={div} />{age(div)}</div>}
      {ann && (
        <div className="py-1 border-t border-line" title={`来源 ${ann.source}`}>
          <div>近一年公告 {ann.data.total} 条{Object.keys(ann.data.flags ?? {}).length > 0 && <>：{Object.entries(ann.data.flags).map(([k, n]) => <span key={k} className="mr-1.5"><Chip tone={/专精特新|政府补助|增持|回购|股权激励/.test(k) ? "good" : /减持/.test(k) ? "amber" : ""}>{k} {String(n)}</Chip></span>)}</>}{age(ann)}</div>
          {ann.data.hits?.length > 0 && <details className="text-xs text-ink-2" onToggle={() => more("announcements")}><summary className="cursor-pointer text-ink-3">看命中的公告</summary>{ann.data.hits.map((h: any) => <div key={h.url}>{h.date} <a className="text-accent" href={h.url} target="_blank" rel="noreferrer">{h.title}</a></div>)}</details>}
        </div>
      )}
      {x?.sme && (x.sme.matches.length > 0 || x.sme.near.length > 0) && <div className="py-1 border-t border-line">专精特新：{x.sme.matches.map((m: any) => `${m.level}${m.batch ? `（${m.batch}）` : ""}`).join("、") || `疑似 ${x.sme.near.map((m: any) => m.name).join("、")}`}<span className="text-xs text-ink-3 ml-2">名录 {x.sme.rosterSize} 家，更新于 {x.sme.rosterUpdatedAt?.slice(0, 10) ?? "—"}</span></div>}
      {holders && holders.data.top?.length > 0 && <div className="py-1 border-t border-line" title={`来源 ${holders.source}，截至 ${holders.data.asOf}`}>股东：{holders.data.controller && <>实控人 {holders.data.controller}；</>}{holders.data.top.map((h: any) => `${h.name} ${Number(h.pct).toFixed(1)}%`).join("、")}<More r={holders} />{age(holders)}</div>}
      {sectors && sectors.data.tags?.length > 0 && <div className="py-1 border-t border-line text-xs" title={`来源 ${sectors.source}`}>{sectors.data.tags.map((t: string) => <span key={t} className="mr-1"><Chip>{t}</Chip></span>)}<More r={sectors} /></div>}
      {forecast && forecast.data.period && <div className="py-1 border-t border-line text-xs" title={forecast.data.text} onMouseEnter={() => more("forecast")}>业绩预告 {forecast.data.period.slice(0, 7)}：{forecast.data.type}<span className="text-ink-3 ml-1">（{forecast.data.noticeDate} 发布）</span></div>}
      {reports && reports.data.items?.length > 0 && <div className="py-1 border-t border-line text-xs" title={`来源 ${reports.source}`}><span className="text-ink-3">近一年研报 {reports.data.total} 篇：</span>{reports.data.items.map((r: any) => `${r.org}「${r.rating}」${r.title}`).join("；")}<More r={reports} /></div>}
      {irm && irm.data.items?.length > 0 && (
        <details className="py-1 border-t border-line text-xs" onToggle={() => more("irm")}><summary className="cursor-pointer">投资者问答（公司回复）{age(irm)}</summary>
          {irm.data.items.map((q: any, i: number) => <div key={i} className="mt-1"><div className="text-ink-3">{q.date} 问：{q.q}</div><div>答：{q.a}</div></div>)}
        </details>
      )}
      {ipo?.data?.szse &&<div className="py-1 border-t border-line" title={`来源 ${ipo.source}`}>IPO：{ipo.data.szse.exchange}{ipo.data.szse.board && ` ${ipo.data.szse.board}`} · {ipo.data.szse.stage}{ipo.data.szse.sponsor && ` · ${ipo.data.szse.sponsor}`}{age(ipo)}</div>}
      {news && news.data.items?.length > 0 && (
        <div className="py-1 border-t border-line" title={`来源 ${news.source}`}>
          <div className="text-xs text-ink-3">新闻 {news.data.total} 条<More r={news} />{age(news)}</div>
          {news.data.items.map((n: any) => <div key={n.url} className="text-xs truncate">{n.date} <a className="text-accent" href={n.url} target="_blank" rel="noreferrer">{n.title}</a></div>)}
        </div>
      )}
      {x?.listing && !listed && (
        <div className="text-xs text-ink-3 py-1 border-t border-line flex items-center gap-2">
          <span className="flex-1">非上市{x.sme?.matches.length === 0 ? `，不在本地专精特新名录（${x.sme?.rosterSize ?? 0} 家）` : ""}。融资、人员、上市进展、口碑写在下面的就业评估报告里。</span>
        </div>
      )}
      {/* not behind 「生成」: the report fetches its own facts (a video session looked for this button, 2026-10-21) */}
      <div className="text-xs text-ink-3 py-1 border-t border-line flex items-center gap-2">
        <span className="flex-1">就业评估报告：利润为什么变、人员和人均、钱去了哪、技术人员有没有激励、融资和上市进展、和你的匹配。数字由职路取，解读由你的 AI 助手写，不打分。</span>
        <Button onClick={assess} disabled={assessing}>{assessing ? "已派发" : "写一份"}</Button>
      </div>
      {researchMsg && <div className="text-xs text-ink-3">{researchMsg}</div>}
    </div>
  );
}

/** 岗位适配度 (ADR-035): the score bands the daemon uses — 优先考虑 200+, 可迁移 100+, 待补资料 50+; a search preset's score is its own. */
const tierOf = (score: number) => (score >= 200 ? "优先考虑" : score >= 100 ? "可迁移" : score >= 50 ? "待补资料" : `${score} 分`);
const tierTone = (t: string) => (t === "优先考虑" ? "good" : t === "可迁移" ? "accent" : t === "明显缺口" ? "amber" : "");

export function CompanyRow({ c, selected, onClick }: { c: any; selected: boolean; onClick: () => void }) {
  const dl = daysLeft(c.closesAt);
  const matched = c.positions.filter((p: any) => p.match).length;
  return (
    <div onClick={onClick} className={`px-4 py-3 border-t first:border-t-0 border-line cursor-pointer hover:bg-ground ${selected ? "bg-accent-soft/40" : ""}`}>
      <div className="flex items-baseline gap-2">
        <span className="font-medium">{c.companyName}</span>
        {c.applied && <Chip tone="good">已投递</Chip>}
        {c.positions.some((p: any) => p.watched && !p.applicationState) && <Chip tone="accent">已关注</Chip>}
        {c.newPositions > 0 && <Chip tone="amber">新 {c.newPositions}</Chip>}
        <span className="ml-auto text-xs text-ink-3 tabular">{c.score ? <Chip tone={tierTone(tierOf(c.score))}>{tierOf(c.score)}</Chip> : <Chip tone={gradeTone(c.grade)}>{c.grade}</Chip>}</span>
      </div>
      <div className="flex gap-1.5 mt-1.5 items-center flex-wrap">
        {c.tags.map((t: any) => <Chip key={t.tag} tone="accent">{t.tag}</Chip>)}
        <span className="text-xs text-ink-3">{matched ? `${matched} 个匹配岗位 · ` : ""}{c.positions.length} 个岗位{c.sources.length > 1 ? ` · ${c.sources.length} 个项目` : ""}</span>
        <span className="ml-auto">{c.expired ? <Chip>已截止</Chip> : c.closesAt ? <Chip tone={deadlineTone(dl)}>{c.closesAt}{dl != null ? ` · ${dl} 天` : ""}</Chip> : <Chip>{c.deadline?.asap ? "招满即止 · 宜尽早" : c.deadline?.unverified ? "截止待核实" : c.deadlineText || "截止未知"}</Chip>}</span>
      </div>
    </div>
  );
}

/**
 * 岗位适配度 layer 2 (ADR-034): the model reads this company's 强匹配/可考虑 posts against the profile. Costs tokens, so
 * only on a click; the button says how many. Runs in the background — the list refreshes every few seconds meanwhile.
 */
function DeepFit({ c, reload }: { c: any; reload: () => void }) {
  const ids = c.positions.filter((p: any) => p.match && !p.fit && /^(优先考虑|可迁移)/.test(p.match.reason)).slice(0, 20).map((p: any) => p.id);
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (!left) return;
    const t = setInterval(async () => { const r = await call("fit.list", { companyId: c.companyId }).catch(() => null); const n = r ? r.pending.length : 0; reload(); if (!n) { setLeft(0); clearInterval(t); } else setLeft(n); }, 4000);
    return () => clearInterval(t);
  }, [left > 0, c.companyId]);
  if (left) return <span className="text-xs text-ink-3">模型正在逐条比对…还剩 {left} 个</span>;
  if (!ids.length) return null;
  return <button className="text-xs text-accent" title="让模型逐条对照岗位要求和你的画像，给出分数、满足项和缺口；每个岗位约 1–2k token" onClick={async () => { const r = await call("fit.deep", { positionIds: ids }); setLeft(r.pending || 0); }}>深度匹配 {ids.length} 个</button>;
}

/** The model's verdict on one post; meets and gaps on hover (fetched once). */
function FitLine({ p, companyId }: { p: any; companyId: string }) {
  const [d, setD] = useState<any>(null);
  const fetch = () => call("fit.list", { companyId }).then((r) => setD(r.items.find((x: any) => x.positionId === p.id) ?? {}));
  const load = () => d || fetch();
  useOnDataChange(() => d && fetch()); // fetched once on hover; after that kept current
  const tone = p.fit.score >= 80 ? "good" : p.fit.score >= 55 ? "accent" : "amber";
  return (
    <div className="text-xs text-ink-2 mt-0.5" onMouseEnter={load} title={d?.meets ? `满足：${d.meets.join("；") || "—"}\n缺口：${d.gaps.join("；") || "—"}${d.stale ? "\n（画像之后改过，可重新深度匹配）" : ""}` : "悬停查看满足项与缺口"}>
      <Chip tone={tone}>模型 {p.fit.score}</Chip> {p.fit.verdict}
    </div>
  );
}

/** 点开看岗位要求: the post's own description, requirements and per-requirement judgement, fetched once on click. */
export function PostDetails({ p, always }: { p: any; always?: boolean }) {
  const [d, setD] = useState<any>(null);
  const [open, setOpen] = useState(!!always);
  const latest = useLatest();
  const fetch = () => latest("post", call("position.get", { id: p.id })).then(setD).catch(() => setD({ error: true }));
  const load = () => { if (!d) fetch(); };
  useEffect(() => { if (always) load(); }, [p.id]);
  useOnDataChange(() => { if (d) fetch(); }); // once read (open, or opened before), kept current; stays open or closed as it was
  useEffect(() => {
    const on = (e: any) => { if (e.detail !== p.id) return; setOpen((o) => !o); load(); };
    document.addEventListener("jobos:post", on); return () => document.removeEventListener("jobos:post", on);
  }, [p.id, d]);
  if (!open) return null;
  if (!d) return <div className="text-xs text-ink-3">读取中…</div>;
  const a = d.assessment;
  const st: Record<string, string> = { supported: "有证据", transferable: "可迁移", unknown: "待核实", gap: "缺口" };
  return (
    <div className="text-xs text-ink-2 mb-1.5 border border-line rounded-md bg-ground/50 p-2.5 space-y-1.5">
      <div className="flex gap-3 flex-wrap text-ink-3">{d.position.degreeReq && <span>学历 {d.position.degreeReq}</span>}{d.majorReq && <span>专业 {d.majorReq}</span>}{d.deadline?.say ? <span className={d.deadline.status === "verified" ? "" : "text-amber"}>{d.deadline.say}</span> : d.closesAt && <span>截止 {d.closesAt}</span>}<span>来源 {d.sourceKind}</span>{d.applyUrl && <a className="text-accent" href={d.applyUrl} target="_blank" rel="noreferrer">投递页</a>}</div>
      {d.position.jdText ? <div className="whitespace-pre-wrap max-h-72 overflow-auto">{d.position.jdText}</div> : <div className="text-ink-3">这条只有岗位名，没有岗位描述；来源是汇总表或一行公告。线索补全会尝试从公告页抓具体岗位。</div>}
      {a?.judgements?.length > 0 && <div className="border-t border-line pt-1.5">{a.judgements.filter((j: any) => j.modality === "required").map((j: any, i: number) => <div key={i}><span className="text-ink-3">{st[j.status] ?? j.status}</span> · {j.quote}</div>)}</div>}
    </div>
  );
}

export function CompanyDetail({ c, reload, onWatch, children }: { c: any; reload: () => void; onWatch: (p: any) => void; children?: ReactNode }) {
  const untag = (t: string) => call("recommend.untag", { companyId: c.companyId, tag: t }).then(reload);
  const [newTag, setNewTag] = useState<string | null>(null); // null = not adding
  const addTag = async () => { if (newTag?.trim()) await call("recommend.tag", { companyId: c.companyId, tag: newTag.trim() }); setNewTag(null); reload(); };
  // 重点 / 不投 (ADR-036): the two company marks; one click sets, a second click clears, they exclude each other
  const has = (t: string) => c.tags.some((x: any) => x.tag === t);
  const mark = (t: string) => (has(t) ? untag(t) : call("recommend.tag", { companyId: c.companyId, tag: t }).then(reload));
  return (
    <Card className="p-5">
      <div className="text-lg font-bold">{c.companyName}</div>
      <div className="flex gap-1.5 flex-wrap my-2 items-center">
        <span title="重点公司：推荐排最前，探索线永不代投"><Button tone={has("重点") ? "primary" : ""} onClick={() => mark("重点")}>重点</Button></span>
        <span title="不投：推荐、探索、线索补全都跳过；「含不符合期望的」里还能看到"><Button tone={has("不投") ? "danger" : ""} onClick={() => mark("不投")}>不投</Button></span>
        {c.tags.filter((t: any) => t.tag !== "重点" && t.tag !== "不投").map((t: any) => <span key={t.tag} title={t.reason}><Chip tone="accent">{t.tag}{t.mode === "manual" && <button className="ml-1" onClick={() => untag(t.tag)}>×</button>}</Chip></span>)}
        {newTag === null ? <button className="text-xs text-ink-3" onClick={() => setNewTag("")}>＋标签</button>
          : <input autoFocus value={newTag} onChange={(e) => setNewTag(e.target.value)} onBlur={addTag} onKeyDown={(e) => { if (e.key === "Enter") addTag(); if (e.key === "Escape") setNewTag(null); }} placeholder="标签，回车保存" className="px-2 py-0.5 border border-line rounded-md bg-paper text-xs w-32" />}
      </div>
      <div className="mb-3"><CompanyFacts c={c} /></div>
      <div className="mb-3"><CompanyProjects c={c} /></div>
      {c.conflicts.length > 0 && (
        <div className="text-xs bg-amber-soft text-amber rounded p-2 mb-3">其他来源写的截止：{c.conflicts.map((x: any) => `${x.batch || x.sourceKind} ${x.value}（${x.grade}）`).join("；")}</div>
      )}
      <div className="flex items-center gap-2 mb-1"><span className="font-bold text-sm">岗位 · {c.positions.length}</span><DeepFit c={c} reload={reload} /></div>
      <div className="mb-4">
        {c.positions.map((p: any) => (
          <div key={p.id} className="py-1.5 border-t border-line text-sm">
            <PostDetails p={p} />
            <div className="flex items-center gap-2">
              <span className="flex-1 cursor-pointer hover:text-accent" title="点开看岗位要求" onClick={() => document.dispatchEvent(new CustomEvent("jobos:post", { detail: p.id }))}>{p.title}{p.cities?.length > 0 && <span className="ml-1.5 text-xs text-ink-3">{p.cities.slice(0, 3).join("/")}</span>}{p.deadline && <span className={`ml-1.5 text-xs ${p.deadline.status === "verified" ? "text-ink-3" : "text-amber"}`} title={p.deadline.say}>{deadlineShort(p.deadline)}</span>}{p.isNew && <span className="ml-1.5"><Chip tone="amber">新</Chip></span>}</span>
              {p.expectation && p.expectation.status !== "pass" && <span title={p.expectation.reasons.map((r: any) => `${r.field}：${r.evidence}`).join("；")}><Chip tone={p.expectation.status === "unknown" ? "amber" : ""}>{p.expectation.status === "unknown" ? "待核实" : "不符合期望"}</Chip></span>}
              {p.applicationState ? <Chip tone={p.applicationState === "draft" ? "amber" : "good"}>{STATE_LABEL[p.applicationState] ?? p.applicationState}</Chip>
                : <Button tone={p.watched ? "" : p.match ? "primary" : ""} onClick={() => onWatch(p)}>{p.watched ? "已关注 ✓" : "关注"}</Button>}
            </div>
            {p.fit && <FitLine p={p} companyId={c.companyId} />}
            {p.match && <div className="text-xs text-ink-3 mt-0.5">{(() => { const [t, ...why] = p.match.reason.split(" · "); return why.length ? <><Chip tone={tierTone(t)}>{t}</Chip> {why.join(" · ")}</> : p.match.reason; })()}</div>}
          </div>
        ))}
      </div>
      <OfficialSync c={c} reload={reload} />
      <Intel c={c} />
      <div className="mb-3"><MergeInto c={c} reload={reload} /></div>
      {children}
    </Card>
  );
}
