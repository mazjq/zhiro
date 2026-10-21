import { useEffect, useRef, useState } from "react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Chip, Button, Empty } from "../ui";
import { applyLink } from "./CompanyView";
import { JOBS_QUERY_KEY } from "./Jobs";
import { CompareBox, CompareResults } from "./Compare";
import { Reader } from "../Reader";

/**
 * 调研: a direction looked into (an industry, a kind of job), and what the report's companies have in the pool right now;
 * or a few companies compared as employers (比较几家公司, D-29) — one line from a direction to a short list to one company.
 * The report itself changes nothing in the pool; a company gets in only when the person sends the system to find its
 * careers page, one company at a time.
 */
const OPEN_KEY = "jobos.research.open";
const MODE_KEY = "zhiro.research.mode";
const STATUS: Record<string, { label: string; tone: "good" | "bad" | "amber" }> = { done: { label: "完成", tone: "good" }, failed: { label: "没做成", tone: "bad" }, running: { label: "进行中", tone: "amber" } };
const input = "px-3 py-1.5 border border-line rounded-md bg-paper text-sm";
/** An amount as a person reads it (12.3 亿), in the currency the filing is in. */
const amount = (v: number | null | undefined) => (v == null ? "—" : Math.abs(v) >= 1e8 ? `${(v / 1e8).toFixed(1)} 亿` : Math.abs(v) >= 1e4 ? `${Math.round(v / 1e4)} 万` : String(v));
/** A sentence whose author copied amounts out of the data to the last 分 (「1699269304.88 元」): shown as a person reads them; the sentence as written stays in the tooltip. */
const readable = (text: string) => text.replace(/(-?\d{6,}(?:\.\d+)?)\s*(元|港元|美元|人民币)/g, (_m, n: string, unit: string) => `${amount(Number(n))}${unit === "人民币" ? "元" : unit}`);
const pct = (v: number | null | undefined) => (v == null ? "" : `（${v > 0 ? "+" : ""}${v.toFixed(1)}%）`);

/**
 * Out of the report and to the company's posts: its careers page as the pool has it (a new tab), its announcement when
 * that is another page, and its posts in 找岗位. A report that names a company and leaves the person to search for where
 * it hires is half a report (user, 2026-10-13).
 */
function Entry({ companyName, applyUrl, noticeUrl }: { companyName: string; applyUrl: string; noticeUrl: string }) {
  const apply = applyLink(applyUrl, noticeUrl), notice = [noticeUrl, applyUrl].find((u) => u && u !== apply) ?? "";
  const toJobs = () => { sessionStorage.setItem(JOBS_QUERY_KEY, companyName); window.dispatchEvent(new CustomEvent("jobos:go", { detail: "jobs" })); };
  const link = "px-2 py-0.5 rounded border border-line text-xs text-accent bg-paper hover:bg-accent-soft whitespace-nowrap";
  return (
    <span className="flex items-center gap-1.5">
      {apply ? <a className={link} href={apply} target="_blank" rel="noreferrer" title={apply}>招聘入口 ↗</a> : <span className="text-xs text-ink-3" title="岗位库里这家公司没有记下可以投递的链接">没有记下入口</span>}
      {notice && <a className={link} href={notice} target="_blank" rel="noreferrer" title={notice}>简章 ↗</a>}
      <button className={link} onClick={toJobs} title="在「找岗位」里打开这家公司的全部岗位">库里的岗位</button>
    </span>
  );
}

/** A company's filings as Zhiro fetched them by its name — figures from the data source, not from the report's author. */
function Financials({ f, pending }: { f: any; pending: boolean }) {
  if (!f) return pending ? <div className="text-xs text-ink-3">正在取经营数据…</div> : null;
  if (f.status === "not_found") return <div className="text-xs text-ink-3" title="可能未上市，也可能是名字写法不同">经营数据：没查到上市信息</div>;
  if (f.status === "ambiguous") return <div className="text-xs text-ink-3">经营数据：有几家名字相近的上市公司，没有替你认：{f.candidates.join("、")}</div>;
  if (!f.year && !f.latest) return <div className="text-xs text-amber">经营数据：{f.security ? `认出是 ${f.security.name}（${f.security.market} ${f.security.code}），` : ""}没取成{f.message ? `。${f.message}` : ""}</div>;
  const y = f.year ?? f.latest;
  return (
    <div className="text-xs text-ink-2" title={`由 Zhiro 从数据接口取的，${f.fetchedAt.slice(0, 10)}。金额币种：${y.currency}`}>
      <span className={f.approx ? "text-amber" : "text-ink-3"}>{f.security.name} · {f.security.market} {f.security.code}{f.approx ? "（按名字相近认的，请核对）" : ""}</span>
      {f.employees != null && <span> · 员工 {f.employees.toLocaleString()}</span>}
      <span> · {y.period} 营收 {amount(y.revenue)}{pct(y.revenueYoy)} · 净利 {amount(y.netProfit)}{y.rdExpense != null ? ` · 研发 ${amount(y.rdExpense)}` : ""} · {y.currency}</span>
    </div>
  );
}

const POINT: Record<string, { label: string; tone: "good" | "amber" | "bad" | undefined; title: string }> = {
  matched: { label: "数字对得上", tone: "good", title: "这句话里的数字，在它引的数据里都找得到" },
  unmatched: { label: "有数字没对上", tone: "amber", title: "引了数据，但句子里有数字不在那条数据里：可能是换算或推算出来的，也可能写错了。请对着数据看" },
  cited: { label: "引了数据", tone: undefined, title: "引了数据，这句话里没有可以核对的数字" },
  none: { label: "没有引数据", tone: undefined, title: "来自网页，或是做调研的 agent 自己的判断" },
  unknown: { label: "引的数据不在", tone: "bad", title: "它引的编号不在这次调研取到的数据里" },
};
/** 要点与依据: each conclusion with the data it cites and what checking the two against each other found. */
function KeyPoints({ points }: { points: any[] }) {
  const n = (s: string) => points.filter((p) => p.status === s).length;
  return (
    <div className="mb-3">
      <div className="text-xs text-ink-3 mb-1">
        要点与依据 · {points.length} 条：数字对得上 {n("matched")}，引了数据 {n("cited")}，有数字没对上 {n("unmatched")}，没有引数据 {n("none")}{n("unknown") ? `，引的数据不在 ${n("unknown")}` : ""}
        <span className="ml-2">（核对的是数字在不在数据里，不是结论对不对）</span>
      </div>
      {points.map((p, i) => (
        <div key={i} className="py-1 border-t border-line text-sm flex gap-2 items-baseline">
          <span className="w-24 shrink-0" title={POINT[p.status].title}><Chip tone={POINT[p.status].tone as any}>{POINT[p.status].label}</Chip></span>
          <span className="flex-1">
            <span title={readable(p.text) === p.text ? undefined : p.text}>{readable(p.text)}</span>
            {p.unmatched.length > 0 && <span className="text-xs text-amber ml-2">没对上：{p.unmatched.join("、")}</span>}
            {(p.refs.length > 0 || p.unknownRefs.length > 0) && <div className="text-xs text-ink-3">依据：{p.refs.map((r: any) => `${r.kind} · ${r.label}`).join("；")}{p.unknownRefs.length > 0 && <span className="text-bad"> {p.unknownRefs.join("、")}（不在这次取到的数据里）</span>}</div>}
          </span>
        </div>
      ))}
    </div>
  );
}

function Company({ c, pending, onChanged }: { c: any; pending: boolean; onChanged: () => void }) {
  const [armed, setArmed] = useState(false);
  const [msg, setMsg] = useState("");
  const [watched, setWatched] = useState<Record<string, boolean>>({});
  // a click is shown at once; once a fresh report agrees with it, the report's value rules again (so a later change by
  // an agent shows up instead of being hidden behind the click)
  useEffect(() => {
    const rows = new Map<string, any>((c.suitable ?? []).map((p: any) => [p.positionId, p]));
    setWatched((w) => { const kept = Object.fromEntries(Object.entries(w).filter(([id, on]) => rows.get(id)?.watched !== on)); return Object.keys(kept).length === Object.keys(w).length ? w : kept; });
  }, [c]);
  const find = async () => {
    if (!armed) { setArmed(true); return; } // the second click sends it: a web lookup, which may cost
    setArmed(false);
    try { await call("company.find", { name: c.name }); setMsg("已去找，几分钟后这里会更新"); onChanged(); } catch (e: any) { setMsg(e.message); }
  };
  // 「就是它」: the report's name becomes an alias of that company, so from now on it is found by this name
  const same = async (x: any) => { try { await call("company.alias", { companyId: x.companyId, alias: c.name }); onChanged(); } catch (e: any) { setMsg(e.message); } };
  const watch = (p: any) => {
    const now = !(watched[p.positionId] ?? p.watched);
    setWatched({ ...watched, [p.positionId]: now }); // shown at once
    call("position.watch", { positionId: p.positionId, priority: now ? 2 : 0 }).catch((e) => { setWatched({ ...watched, [p.positionId]: !now }); setMsg(e.message); });
  };
  return (
    <div className="py-2 border-t border-line text-sm">
      <div className="flex items-baseline gap-2">
        <span className="font-bold">{c.status === "in" ? c.companyName : c.name}</span>
        {c.status === "in" && <span className="text-xs text-ink-3">{c.openPosts} 个在招{c.deadline ? ` · ${c.deadline}` : ""}</span>}
        {c.sourceUrl ? <a className="text-xs text-accent" href={c.sourceUrl} target="_blank" rel="noreferrer" title="报告是在哪个网页读到这家公司的">出处</a> : <span className="text-xs text-amber">无出处</span>}
        {c.status === "in" && <span className="ml-auto"><Entry companyName={c.companyName} applyUrl={c.applyUrl ?? ""} noticeUrl={c.noticeUrl ?? ""} /></span>}
        {c.status === "out" && (
          <span className="ml-auto">
            {c.finding === "running" ? <Chip tone="amber">正在找…</Chip>
              : <Button tone={armed ? "primary" : ""} onClick={find}>{armed ? "确认：联网查找，可能产生费用" : c.finding === "done" || c.finding === "failed" ? "再找一次" : "找招聘入口"}</Button>}
          </span>
        )}
      </div>
      <div className="text-xs text-ink-2">{c.why}</div>
      <Financials f={c.financials} pending={pending} />
      {c.status === "out" && c.finding && c.finding !== "running" && <div className="text-xs text-ink-3">{c.finding === "done" ? "上次找过：没有读到这家公司名下的岗位（可能入口记在了别的名字下）" : "上次没找到招聘入口"}</div>}
      {c.status === "maybe" && (
        <div className="text-xs text-ink-2 mt-1 flex items-center gap-2 flex-wrap">
          <span>库里有名字相近的，是不是它由你定：</span>
          {c.candidates.map((x: any) => <span key={x.companyId} className="flex items-center gap-1.5">{x.companyName}（{x.openPosts} 个在招）<Entry companyName={x.companyName} applyUrl={x.applyUrl ?? ""} noticeUrl={x.noticeUrl ?? ""} /><Button onClick={() => same(x)}>就是它</Button></span>)}
        </div>
      )}
      {c.status === "in" && (c.suitable.length ? (
        <div className="mt-1 space-y-0.5">
          {c.suitable.map((p: any) => {
            const on = watched[p.positionId] ?? p.watched;
            return (
              <div key={p.positionId} className="flex items-center gap-2 text-xs">
                <span className="w-56 truncate text-sm">{p.title}</span>
                <span className="text-ink-3 w-24 truncate">{p.cities.join("、")}</span>
                <span className="flex-1 truncate text-ink-2" title={p.reason}>{p.reason}</span>
                <span className="text-ink-3 truncate max-w-56" title={p.deadline}>{p.deadline}</span>
                {p.applicationState ? <Chip tone="accent">已在投递</Chip> : <Button tone={on ? "primary" : ""} onClick={() => watch(p)}>{on ? "已关注" : "关注"}</Button>}
              </div>
            );
          })}
          {c.suitableTotal > c.suitable.length && <div className="text-xs text-ink-3">另有 {c.suitableTotal - c.suitable.length} 个适合的没列出。点右上的「库里的岗位」看全部。</div>}
        </div>
      ) : <div className="text-xs text-ink-3 mt-1">{c.openPosts ? "在招的岗位里，按你的资料还没有判为适合的。点右上的「库里的岗位」看全部。" : "库里有这家公司，但现在没有在招的岗位。"}</div>)}
      {msg && <div className="text-xs text-ink-2 mt-1">{msg}</div>}
    </div>
  );
}

/** The report's company a compared row is, by the report's name, the pool's name or the listing's names. */
const reportCompany = (companies: any[], x: { name: string; org?: string }) =>
  companies.find((c) => [c.companyName, c.name].some((n: string) => n && (n === x.org || n === x.name || n.includes(x.name) || x.name.includes(n))));

/** Under a company in the comparison: its posts in the pool that suit the person — the other line, not mixed in. */
function PostsOf({ x, companies }: { x: any; companies: any[] }) {
  const c = reportCompany(companies, x);
  if (!c || c.status !== "in") return <span className="text-ink-3">岗位库里还没有它的岗位</span>;
  if (!c.suitableTotal) return <span className="text-ink-3">库里在招 {c.openPosts} 个，和你的资料相关的还没有</span>;
  return <span className="text-ink-2">和你的资料相关的在招岗位 {c.suitableTotal} 个：{c.suitable.map((p: any) => p.title).join("、")}{c.suitableTotal > c.suitable.length ? " 等" : ""}</span>;
}

export default function Research() {
  const [items, setItems] = useState<any[] | null>(null); // null = not answered yet
  const [open, setOpen] = useState<string>(() => localStorage.getItem(OPEN_KEY) ?? "");
  const [report, setReport] = useState<any>(null);
  const [mode, setMode] = useState<"topic" | "compare">(() => (localStorage.getItem(MODE_KEY) === "compare" ? "compare" : "topic"));
  const [companiesView, setCompaniesView] = useState<"pool" | "compare">("pool");
  const [compared, setCompared] = useState(""); // the report whose comparison was opened: kept while switching views
  const [reading, setReading] = useState(false);
  const [topic, setTopic] = useState("");
  const [region, setRegion] = useState("");
  const [armed, setArmed] = useState(false);
  const [starting, setStarting] = useState(false);
  const [msg, setMsg] = useState("");
  const timer = useRef<ReturnType<typeof setInterval> | undefined>(undefined);
  const latest = useLatest();
  const load = () => latest("topics", call("research.topics")).then((r) => setItems(r.items)).catch(() => setItems((x) => x ?? []));
  const list = items ?? [];
  const fetchReport = (runId: string) => latest("report", call("research.report", { runId }));
  const show = (runId: string) => { setOpen(runId); localStorage.setItem(OPEN_KEY, runId); fetchReport(runId).then(setReport).catch(() => setReport(null)); };
  useEffect(() => { load(); if (open) show(open); }, []);
  // changed elsewhere (a company found, a post watched, a run finished): the list and the open report update where they are
  useOnDataChange(() => { load(); if (open) fetchReport(open).then(setReport).catch(() => {}); });
  // something is still being worked on (a report, or a company being looked for): look again every few seconds
  const busy = list.some((x) => x.status === "running") || !!report?.companies?.some((c: any) => c.finding === "running") || report?.data?.pending > 0;
  useEffect(() => {
    clearInterval(timer.current);
    if (busy) timer.current = setInterval(() => { load(); if (open) fetchReport(open).then(setReport).catch(() => {}); }, 8000);
    return () => clearInterval(timer.current);
  }, [busy, open]);
  const start = async () => {
    if (!armed) { setArmed(true); return; }
    setArmed(false); setStarting(true); setMsg("正在取数据：券商研报、这个主题在股市里的上市公司…（几秒）");
    try { const r = await call("research.topic", { topic: topic.trim(), region: region.trim() || undefined }); setMsg("数据取好了，已交给做调研的 agent。查完会出现在下面，通常要几分钟；如果你用的是自己的 agent，它会在待办里看到这份提纲。"); setTopic(""); await load(); show(r.runId); }
    catch (e: any) { setMsg(`没发起成：${e.message}`); } finally { setStarting(false); }
  };
  const groups: [string, string][] = [["in", "已在岗位库"], ["maybe", "可能在库"], ["out", "不在岗位库"]];
  const pick = (m: "topic" | "compare") => { setMode(m); localStorage.setItem(MODE_KEY, m); };
  const tab = (on: boolean) => `px-4 py-1.5 text-sm ${on ? "bg-accent text-white" : "bg-paper text-ink-2 hover:bg-ground"}`;
  return (
    <>
      <H1 sub="先调研一个方向，找出公司；再把几家公司比一比；挑中的一家写就业评估报告。报告只存档，不改岗位库。">调研</H1>
      <div className="flex border border-line rounded-md overflow-hidden w-fit mb-3">
        <button className={tab(mode === "topic")} onClick={() => pick("topic")}>调研一个方向</button>
        <button className={tab(mode === "compare")} onClick={() => pick("compare")}>比较几家公司</button>
      </div>
      {mode === "compare" && <Card className="p-5 mb-4"><CompareBox /></Card>}
      {mode === "topic" && (<>
      <Card className="p-5 mb-4">
        <div className="flex gap-2">
          <input value={topic} onChange={(e) => { setTopic(e.target.value); setArmed(false); }} placeholder="想了解的行业或方向，如 人形机器人、工业软件" className={`${input} flex-1`} />
          <input value={region} onChange={(e) => setRegion(e.target.value)} placeholder="地区（可空），如 中国、美国" className={`${input} w-56`} />
          <Button tone="primary" onClick={start} disabled={!topic.trim() || starting}>{starting ? "正在取数据…" : armed ? "确认：联网调研，几分钟，可能产生费用" : "开始调研"}</Button>
        </div>
        {msg && <div className="text-xs text-ink-2 mt-2">{msg}</div>}
        {list.length > 0 && (
          <div className="mt-3">
            {list.map((r) => (
              <button key={r.runId} onClick={() => show(r.runId)} className={`w-full text-left py-1.5 border-t border-line text-sm flex items-center gap-2 ${open === r.runId ? "bg-accent-soft" : "hover:bg-ground"}`}>
                <Chip tone={(STATUS[r.status] ?? STATUS.running).tone}>{(STATUS[r.status] ?? STATUS.running).label}</Chip>
                <span className="font-bold whitespace-nowrap">{r.topic}</span>
                <span className="text-xs text-ink-3 font-mono whitespace-nowrap">{new Date(r.startedAt).toLocaleDateString("zh-CN")}</span>
                <span className="flex-1 truncate text-ink-2">{r.summary || r.error}</span>
              </button>
            ))}
          </div>
        )}
      </Card>
      {items === null ? <Empty>正在读取调研列表…</Empty> : !items.length && <Empty>还没有调研。写一个方向点「开始调研」，或者对助手说「帮我调研一下某某行业」。</Empty>}
      {open && list.some((r) => r.runId === open) && !(report && report.runId === open) && <Card className="p-5 text-sm text-ink-3">正在读取报告…</Card>}
      {report && report.runId === open && (
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-1">
            <div className="font-bold">{report.topic}{report.region && <span className="text-ink-3 font-normal"> · {report.region}</span>}</div>
            <span className="text-xs text-ink-3">{report.status === "running" ? "还在查…" : report.status === "failed" ? `没做成：${report.error}` : `信源 ${report.sources.length} 条`}</span>
            {report.markdown && <span className="ml-auto"><Button tone="primary" onClick={() => setReading(true)}>阅读正文</Button></span>}
          </div>
          {report.summary && <div className="text-sm mb-3">{report.summary}</div>}
          {report.status === "done" && (report.keyPoints?.length > 0 ? <KeyPoints points={report.keyPoints} /> : <div className="text-xs text-amber mb-3">这份报告没有给出可核对的要点：下面的结论哪些有数据依据，看不出来。</div>)}
          {report.roles?.length > 0 && <div className="text-sm mb-3"><span className="text-ink-3">报告认为合适的岗位类型：</span>{report.roles.map((r: any) => <span key={r.title} className="mr-2" title={r.why}><Chip>{r.title}</Chip></span>)}</div>}
          {report.companies.length > 0 && (
            <div className="mt-4 mb-3">
              <div className="flex items-center gap-3 mb-2">
                <div className="font-bold">报告里的公司 · {report.companies.length} 家</div>
                <div className="flex border border-line rounded-md overflow-hidden">
                  <button className={tab(companiesView === "pool")} onClick={() => setCompaniesView("pool")}>名单与岗位</button>
                  <button className={tab(companiesView === "compare")} onClick={() => { setCompaniesView("compare"); setCompared(report.runId); }}>比一比</button>
                </div>
              </div>
              {companiesView === "pool" && groups.map(([status, label]) => {
                const cs = report.companies.filter((c: any) => c.status === status);
                return cs.length ? (
                  <div key={status} className="mb-3">
                    <div className="text-xs text-ink-3">{label} · {cs.length} 家{status === "out" ? "（要它们的岗位：逐家去找招聘入口）" : ""}</div>
                    {cs.map((c: any) => <Company key={c.name} c={c} pending={report.data?.pending > 0} onChanged={() => show(report.runId)} />)}
                  </div>
                ) : null;
              })}
              {compared === report.runId && (
                <div className={companiesView === "compare" ? "" : "hidden"}><CompareResults
                  names={report.companies.map((c: any) => c.name)}
                  aside={(x) => <PostsOf x={x} companies={report.companies} />}
                  nameOf={(x) => reportCompany(report.companies, x)?.companyName || ""}
                /></div>
              )}
            </div>
          )}
          {report.status === "done" && (
            <details className="mt-2">
              <summary className="text-sm text-accent cursor-pointer">这次取了哪些数据 · {report.data?.items?.length ? ["研报", "财报", "板块", "美国劳工统计"].map((k) => [k, report.data.items.filter((d: any) => d.kind === k).length] as const).filter(([, n]) => n > 0).map(([k, n]) => `${k} ${n}`).join("，") : "没有"}{report.data?.failed?.length ? `，${report.data.failed.length} 次没取成` : ""}</summary>
              <div className="text-xs text-ink-2 mt-2 space-y-0.5">
                {(report.data?.items ?? []).map((d: any) => <div key={d.ref}><Chip>{d.kind}</Chip> {d.label}<span className="text-ink-3 font-mono"> · {d.ref} · {d.at.slice(0, 10)}</span></div>)}
                {(report.data?.failed ?? []).map((f: string, i: number) => <div key={i} className="text-amber">没取成：{f}</div>)}
                {!report.data?.items?.length && <div className="text-ink-3">这份报告做的时候没有从数据工具取数（2026-10-13 之前的报告都是这样）。公司的经营数据是打开时补取的。</div>}
              </div>
            </details>
          )}
          {reading && report.markdown && (
            <Reader title={report.topic} sub={`${report.region ? `${report.region} · ` : ""}信源 ${report.sources.length} 条`} markdown={report.markdown} onClose={() => setReading(false)}>
              {report.sources.length > 0 && (
                <div className="mt-6 pt-3 border-t border-line text-xs text-ink-2 space-y-1">
                  <div className="font-bold text-sm text-ink mb-1">信源</div>
                  {report.sources.map((e: any) => <div key={e.url}><Chip>{e.grade}</Chip> <a className="text-accent" href={e.url} target="_blank" rel="noreferrer">{e.title || e.url}</a>{e.quote && <span className="text-ink-3"> — {e.quote}</span>}</div>)}
                </div>
              )}
            </Reader>
          )}
        </Card>
      )}
      </>)}
    </>
  );
}
