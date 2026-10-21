import { useEffect, useRef, useState } from "react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Chip, Button, Empty, plain } from "../ui";
import { CompanyRow, CompanyDetail, Intel } from "./CompanyView";
import { Reader } from "../Reader";

const input = "px-3 py-1.5 border border-line rounded-md bg-paper text-sm";
const split = (s: string) => s.split(/[\/、,，;；|\s]+/).filter(Boolean);

/** 搜索模式编辑器: AND / OR / NOT in plain words, with suggestions counted from what the mode currently returns. */
function PresetEditor({ preset, onSaved, onRemoved, onClose }: { preset: any | null; onSaved: (name: string) => void; onRemoved: () => void; onClose: () => void }) {
  const [name, setName] = useState(preset?.name ?? "");
  const [f, setF] = useState<Record<string, string>>({ must: (preset?.must ?? []).join(" "), any: (preset?.any ?? []).join(" "), exclude: (preset?.exclude ?? []).join(" "), cities: (preset?.cities ?? []).join(" ") });
  const [sug, setSug] = useState<any>(null);
  const [msg, setMsg] = useState("");
  const loadSug = (id?: string) => call("recommend.suggest", id ? { presetId: id } : {}).then(setSug).catch(() => {});
  useEffect(() => { loadSug(preset?.id); }, []);
  const add = (field: string, w: string) => setF((cur) => (split(cur[field]).includes(w) ? cur : { ...cur, [field]: (cur[field] + " " + w).trim() }));
  const save = async () => {
    try {
      const r = await call("preset.save", { id: preset?.id, name, must: split(f.must), any: split(f.any), exclude: split(f.exclude), cities: split(f.cities) });
      setMsg(`命中 ${r.companies} 家公司、${r.hits} 个岗位`); loadSug(r.preset.id); onSaved(r.preset.name);
    } catch (e: any) { setMsg(e.message); }
  };
  const remove = async () => { if (confirm(`删除搜索模式「${preset.name}」？`)) { await call("preset.remove", { id: preset.id }); onRemoved(); } };
  const rows: [string, string, string][] = [
    ["must", "必须含", "如 船舶 控制"],
    ["any", "任一", "如 运动控制 伺服 MPC"],
    ["exclude", "排除", "如 实习 销售"],
    ["cities", "城市", "如 武汉 上海"],
  ];
  return (
    <Card className="p-4 mb-4">
      <div className="flex gap-2 items-center mb-3">
        <input value={name} onChange={(e) => setName(e.target.value)} placeholder="名字，如 精确-船舶控制" className={`${input} w-80`} />
        <Button tone="primary" onClick={save}>保存并运行</Button>
        {preset && <Button tone="danger" onClick={remove}>删除</Button>}
        <Button onClick={onClose}>收起</Button>
        <span className="text-sm text-ink-2">{msg}</span>
      </div>
      <div className="grid grid-cols-[5em_1fr] gap-x-3 gap-y-2 items-center">
        {rows.map(([k, label, ph]) => (<span key={k} className="contents"><label className="text-sm text-ink-2">{label}</label><input value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })} placeholder={ph} className={input} /></span>))}
      </div>
      {sug && (sug.include.length > 0 || sug.exclude.length > 0) && (
        <div className="mt-3 text-xs text-ink-3 space-y-1.5">
          <div className="flex gap-1.5 flex-wrap items-center"><span className="w-16">可加入任一</span>{sug.include.map((x: any) => <button key={x.word} onClick={() => add("any", x.word)}><Chip tone="accent">{x.word} {x.count}</Chip></button>)}</div>
          <div className="flex gap-1.5 flex-wrap items-center"><span className="w-16">可排除</span>{sug.exclude.map((x: any) => <button key={x.word} onClick={() => add("exclude", x.word)}><Chip tone="amber">{x.word} {x.count}</Chip></button>)}</div>
        </div>
      )}
    </Card>
  );
}

/** 调研: dispatched per company, reports listed under the company. */
function Research({ companyName }: { companyName: string }) {
  const [runs, setRuns] = useState<any[]>([]);
  const [report, setReport] = useState<any>(null);
  const [q, setQ] = useState<string | null>(null); // null = closed
  const [msg, setMsg] = useState("");
  const latest = useLatest();
  const load = () => latest("runs", call("research.list", { companyName })).then((r) => setRuns(r.items)).catch(() => setRuns([]));
  useEffect(() => { setReport(null); setQ(null); setMsg(""); load(); }, [companyName]);
  useOnDataChange(load);
  const start = async () => { try { await call("research.company", { companyName, question: q || undefined }); setQ(null); setMsg("已派发，几分钟后回来看"); load(); } catch (e: any) { setMsg(e.message); } };
  return (
    <div className="mt-4">
      <div className="flex items-center mb-1"><div className="font-bold text-sm">调研 · {runs.length}</div><span className="ml-auto">{q === null && <Button onClick={() => setQ("")}>派发调研</Button>}</span></div>
      {q !== null && <div className="flex gap-2 mb-2"><input autoFocus value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={(e) => e.key === "Enter" && start()} placeholder="想了解什么？留空 = 校招全貌" className={`${input} flex-1`} /><Button tone="primary" onClick={start}>派发</Button><Button onClick={() => setQ(null)}>取消</Button></div>}
      {msg && <div className="text-xs text-ink-2 mb-1">{msg}</div>}
      {runs.map((r) => (
        <div key={r.runId} className="py-1.5 border-t border-line text-sm flex items-center gap-2">
          <Chip tone={r.status === "done" ? "good" : r.status === "failed" ? "bad" : "amber"}>{r.status === "done" ? "完成" : r.status === "failed" ? "失败" : "进行中"}</Chip>
          <span className="text-xs text-ink-3 font-mono">{r.startedAt.slice(0, 16).replace("T", " ")}</span>
          <span className="flex-1 truncate">{r.summary || r.error}</span>
          {r.status === "done" && <Button onClick={() => call("research.get", { runId: r.runId }).then(setReport)}>看报告</Button>}
        </div>
      ))}
      {report && (
        <Reader title={`${companyName} · 调研报告`} sub={`${(report.startedAt ?? "").slice(0, 10)} · 证据 ${report.evidence.length} 条`} markdown={report.markdown} onClose={() => setReport(null)}>
          {report.evidence.length > 0 && (
            <div className="mt-6 pt-3 border-t border-line text-xs text-ink-2 space-y-1">
              <div className="font-bold text-sm text-ink mb-1">证据</div>
              {report.evidence.map((e: any, i: number) => <div key={i}><Chip>{e.grade}</Chip> <a className="text-accent" href={e.url} target="_blank" rel="noreferrer">{e.title || e.url}</a>{e.quote && <span className="text-ink-3"> — {e.quote}</span>}</div>)}
            </div>
          )}
        </Reader>
      )}
    </div>
  );
}

/** Nothing in the pool under this name: send the web worker to find the company's campus-recruiting entry, or capture a page the user already has. */
function NotInPool({ name, onAdded }: { name: string; onAdded: () => void }) {
  const [finding, setFinding] = useState<{ runId: string; status: string; text: string } | null>(null);
  const [url, setUrl] = useState("");
  const [msg, setMsg] = useState("");
  // a company with no open posts can still be in the library — researched, compared, its 企业情况 fetched: show that
  const [known, setKnown] = useState<{ companyId: string; companyName: string } | null>(null);
  useEffect(() => { call("company.search", { query: name, limit: 3 }).then((r) => setKnown(r.items.find((x: any) => x.companyName === name || x.matchedBy) ?? null)).catch(() => setKnown(null)); }, [name]);
  useEffect(() => {
    if (finding?.status !== "running") return;
    const t = setInterval(() => call("research.get", { runId: finding.runId }).then((r) => {
      if (r.status === "running" || r.status === "collecting") return;
      setFinding({ ...finding, status: r.status, text: r.status === "done" ? r.summary : r.error || r.summary });
      if (r.status === "done") onAdded();
    }).catch(() => {}), 8000);
    return () => clearInterval(t);
  }, [finding]);
  const find = async () => {
    if (!confirm(`让联网 worker 去找「${name}」的校招入口？\n几分钟，按 API 计费（每次约 $0.5–2）。`)) return;
    try { const r = await call("company.find", { name }); setFinding({ runId: r.runId, status: "running", text: "" }); } catch (e: any) { setFinding({ runId: "", status: "failed", text: e.message }); }
  };
  const capture = async () => { setMsg("抓取中…"); try { const r = await call("listing.capture", { url }); setMsg(r.note); setUrl(""); onAdded(); } catch (e: any) { setMsg(e.message); } };
  return (
    <Card className="p-5 text-sm">
      {known && (
        <div className="mb-5">
          <div className="text-lg font-bold">{known.companyName}</div>
          <div className="text-xs text-ink-3 mb-3">现在没有它在招的岗位；下面是为它取过的企业情况和写过的调研。</div>
          <Intel c={known} />
          <Research companyName={known.companyName} />
        </div>
      )}
      <div className="mb-3">{known ? `要「${known.companyName}」的岗位：` : `岗位库里没有「${name}」`}</div>
      {finding ? <div className="flex items-center gap-2"><Chip tone={finding.status === "running" ? "amber" : finding.status === "done" ? "good" : "bad"}>{finding.status === "running" ? "正在找…" : finding.status === "done" ? "已加入" : "没找到"}</Chip><span className="text-xs text-ink-2 whitespace-pre-wrap">{finding.status === "running" ? "通常 2–8 分钟" : finding.text}</span></div>
        : <Button tone="primary" onClick={find}>让系统去找它的校招入口</Button>}
      <div className="flex gap-2 mt-3"><input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="或粘贴它的招聘简章 / 岗位页链接" className={`${input} flex-1`} onKeyDown={(e) => e.key === "Enter" && url && capture()} /><Button onClick={capture} disabled={!url}>抓取</Button></div>
      {msg && <div className="text-xs text-ink-2 mt-2">{msg}</div>}
    </Card>
  );
}

const VIEW_KEY = "jobos.jobs.view";
const SORT_KEY = "jobos.jobs.sort";
const PAGE = 100;
const SORTS: [string, string][] = [["", "默认排序"], ["match", "匹配度"], ["deadline", "截止日期"], ["new", "新岗位多"]];

/** Another page hands a company over (调研 → 「库里的岗位」): the name it left here is searched for once, as if typed. */
export const JOBS_QUERY_KEY = "jobos.jobs.query";
const handedOver = () => { const q = sessionStorage.getItem(JOBS_QUERY_KEY) ?? ""; sessionStorage.removeItem(JOBS_QUERY_KEY); return q; };

/** 找岗位 = 推荐 + 岗位库: the same company rows, either the recommended subset (ranked by score) or everything (by deadline). */
export default function Jobs({ go }: { go: (p: any) => void }) {
  const [all, setAll] = useState(() => localStorage.getItem(VIEW_KEY) === "all");
  const [query, setQuery] = useState(handedOver);
  const [tag, setTag] = useState("");
  const [items, setItems] = useState<any[]>([]);
  const [total, setTotal] = useState(0);
  const [tags, setTags] = useState<[string, number][]>([]);
  const [presets, setPresets] = useState<any[]>([]);
  const [editing, setEditing] = useState<any | null | undefined>(undefined); // undefined = closed, null = new
  const [sel, setSel] = useState<any>(null);
  const [err, setErr] = useState("");
  const [loading, setLoading] = useState(false);
  const [sort, setSortState] = useState(() => localStorage.getItem(SORT_KEY) ?? "");
  const [tier, setTier] = useState(""); // 岗位适配度 floor (ADR-034): "" / 强匹配 / 可考虑
  const [city, setCity] = useState("");
  const [coType, setCoType] = useState(""); // 央国企 / 民企 / 外企 …
  const [showFail, setShowFail] = useState(false); // 期望卡 (ADR-036): 不符合 hidden by default, 待核实 always shown
  const [hasHard, setHasHard] = useState(false);
  const loadHard = () => { call("fact.list", { kind: "preference" }).then((r) => setHasHard(r.items.some((f: any) => f.data?.mode === "硬性"))).catch(() => {}); };
  useEffect(loadHard, []);
  const setSort = (v: string) => { setSortState(v); try { localStorage.setItem(SORT_KEY, v); } catch { /* private mode */ } };
  const seq = useRef(0);
  const more = useRef<HTMLDivElement>(null);

  // a search looks through the whole pool: a company the user names must be findable whether or not it was recommended
  const query_ = () => { const wide = all || !!query.trim(); return { query: query.trim() || undefined, recommendedOnly: !wide, tag: !wide && tag ? tag : undefined, sort: sort || undefined, minTier: tier || undefined, city: city.trim() || undefined, companyType: coType || undefined, hideExpectationFail: !showFail, limit: PAGE }; };
  // quiet = a refresh for a change made elsewhere: the list is not dimmed, it just updates in place
  const load = (rows = PAGE, quiet = false) => {
    const mine = ++seq.current; // a slower, older answer must not overwrite a newer one
    if (!quiet) setLoading(true);
    // keep however many rows are already on screen, so a refresh does not throw the user back to the top
    call("pool.list", { ...query_(), limit: rows })
      .then((r) => { if (mine !== seq.current) return; setItems(r.items); setTotal(r.total); setTags(r.tagCounts.map((t: any) => [t.tag, t.count])); setSel((s: any) => r.items.find((x: any) => x.companyId === s?.companyId) ?? r.items.find((x: any) => x.companyName === query.trim()) ?? (r.items.length === 1 ? r.items[0] : null)); setErr(""); }) // the company named exactly, or the only one found, is opened: there is nothing else to pick
      .catch((e) => mine === seq.current && setErr(e.message)).finally(() => mine === seq.current && setLoading(false));
  };
  // the next page, when the bottom of the list scrolls into view
  const loadMore = () => {
    if (loading || items.length >= total) return;
    const mine = seq.current;
    setLoading(true);
    call("pool.list", { ...query_(), offset: items.length })
      .then((r) => { if (mine !== seq.current) return; setItems((xs) => [...xs, ...r.items.filter((x: any) => !xs.some((y) => y.companyId === x.companyId))]); setTotal(r.total); })
      .catch((e) => setErr(e.message)).finally(() => mine === seq.current && setLoading(false));
  };
  useEffect(() => {
    const el = more.current; if (!el) return;
    const io = new IntersectionObserver((es) => es[0].isIntersecting && loadMore(), { rootMargin: "400px" });
    io.observe(el); return () => io.disconnect();
  });
  const latest = useLatest();
  const loadTags = () => { latest("presets", call("preset.list")).then((r) => setPresets(r.items)).catch(() => {}); };
  // 关注 is a bookmark on the position: nothing starts until the user picks 准备申请 on the 投递 page.
  // Shown at once; the daemon is told in the background and the flag is put back if it refuses.
  const setWatched = (companyId: string, positionId: string, watched: boolean) => {
    const fix = (c: any) => (c?.companyId !== companyId ? c : { ...c, positions: c.positions.map((p: any) => (p.id === positionId ? { ...p, watched } : p)) });
    setItems((xs) => xs.map(fix)); setSel(fix);
  };
  const watch = (c: any, p: any) => {
    setWatched(c.companyId, p.id, !p.watched);
    call("position.watch", { positionId: p.id, priority: p.watched ? 0 : 2 }).catch((e) => { setWatched(c.companyId, p.id, p.watched); setErr(e.message); });
  };
  useEffect(() => { const t = setTimeout(() => load(), query ? 250 : 0); return () => clearTimeout(t); }, [query, all, tag, sort, tier, city, coType, showFail]);
  useEffect(loadTags, []);
  const setView = (a: boolean) => { setAll(a); localStorage.setItem(VIEW_KEY, a ? "all" : "rec"); };
  const reload = () => { load(Math.max(PAGE, items.length)); loadTags(); };
  // data changed elsewhere (an agent watched a post, a scan brought new ones): same rows, same company open, fresh content
  useOnDataChange(() => { load(Math.max(PAGE, items.length), true); loadTags(); loadHard(); });

  const currentPreset = presets.find((p) => p.name === tag);
  const seg = (on: boolean) => `px-3 py-1.5 text-sm ${on ? "bg-accent-soft text-accent" : "bg-paper text-ink-2"}`;

  return (
    <>
      <H1 sub="每家公司一行；关注的岗位会出现在「投递」">找岗位</H1>
      <div className="flex gap-2 mb-3 items-center flex-wrap">
        <div className="flex border border-line rounded-md overflow-hidden"><button className={seg(!all)} onClick={() => setView(false)}>推荐</button><button className={seg(all)} onClick={() => setView(true)}>全部</button></div>
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜公司 / 岗位" className={`${input} w-72`} />
        {!all && !query && (
          <>
            <select value={tag} onChange={(e) => { setTag(e.target.value); setSel(null); }} className={input}>
              <option value="">全部标签</option>
              {tags.map(([t, n]) => <option key={t} value={t}>{plain(t)} · {n}</option>)}
            </select>
            <Button onClick={() => setEditing(currentPreset ?? null)}>{currentPreset ? "编辑搜索模式" : "＋ 搜索模式"}</Button>
          </>
        )}
        <select value={tier} onChange={(e) => { setTier(e.target.value); setSel(null); }} className={input} title="按资料逐条对照岗位要求：很对口（职责相关、核心要求都有证据）/ 部分对口（相关，部分要求待核实或只能迁移）/ 岗位信息不全（只有岗位名或类别）/ 明显缺口（你确认没做过的核心要求）/ 低相关">
          <option value="">适配度：全部</option><option value="优先考虑">只看很对口</option><option value="可迁移">部分对口及以上</option>
        </select>
        <select value={coType} onChange={(e) => { setCoType(e.target.value); setSel(null); }} className={input} title="按企业类型筛选">
          <option value="">企业类型：全部</option><option value="央国企">央国企</option><option value="民企">民企</option><option value="外企">外企 / 合资</option><option value="事业单位">事业单位 / 研究院所</option><option value="银行">银行</option>
        </select>
        <input value={city} onChange={(e) => setCity(e.target.value)} placeholder="城市" className={`${input} w-24`} title="只看在这个城市的岗位" />
        <select value={sort} onChange={(e) => setSort(e.target.value)} className={input} title="薪资：来源数据里几乎没有（6.8 万个岗位只有 11 个写了），暂不能按薪资排">{SORTS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>
        {hasHard && <label className="text-xs text-ink-2 flex items-center gap-1" title="不符合硬性期望（城市 / 公司类型）或标了「不投」的公司默认不显示；待核实的一直显示"><input type="checkbox" checked={showFail} onChange={(e) => setShowFail(e.target.checked)} />含不符合期望的</label>}
        <span className="ml-auto text-xs text-ink-3">{total} 家公司</span>
      </div>
      {editing !== undefined && <PresetEditor key={editing?.id ?? "new"} preset={editing} onSaved={(n) => { setTag(n); loadTags(); }} onRemoved={() => { setEditing(undefined); setTag(""); loadTags(); }} onClose={() => setEditing(undefined)} />}
      {err && <div className="text-bad mb-3 text-sm">{err}</div>}
      {items.length === 0 ? (query.trim() ? <NotInPool key={query.trim()} name={query.trim()} onAdded={reload} />
        : <Empty>{all ? "岗位库还是空的" : <>还没有推荐。去 <button className="text-accent" onClick={() => go("profile")}>资料</button> 填学位、专业、方向，或新建一个搜索模式。</>}</Empty>) : (
        <div className={`grid grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] gap-5 items-start transition-opacity ${loading ? "opacity-60" : ""}`}>
          <div>
            <Card>{items.map((c) => <CompanyRow key={c.companyId} c={c} selected={sel?.companyId === c.companyId} onClick={() => setSel(c)} />)}</Card>
            <div ref={more} className="text-center text-xs text-ink-3 py-3">{items.length < total ? (loading ? "加载中…" : <button className="hover:text-accent" onClick={loadMore}>已显示 {items.length} / {total} · 加载更多</button>) : `共 ${total} 家`}</div>
          </div>
          <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto">{!sel ? <Empty>选择左侧一家公司</Empty> : <CompanyDetail c={sel} reload={reload} onWatch={(p) => watch(sel, p)}><Research companyName={sel.companyName} /></CompanyDetail>}</div>
        </div>
      )}
    </>
  );
}
