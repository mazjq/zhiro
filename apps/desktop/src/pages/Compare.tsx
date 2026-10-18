import { useEffect, useState, type ReactNode } from "react";
import { call } from "../api";
import { H1, Card, Button, Chip, Empty } from "../ui";

/**
 * 比较单位 (employer.compare, D-29): where each listed company stands in its own industry on four measures, and its
 * place among the ones typed here under a preference. No total score; places come with how far they move.
 */
const FACETS = [["growth", "成长"], ["rd", "研发"], ["pay", "待遇信号"], ["profit", "盈利"]] as const;
type Facet = (typeof FACETS)[number][0];
const PRESETS = ["成长研发优先", "均衡", "稳定回报优先"] as const;
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const show: Record<Facet, (v: number | null) => string> = { growth: pct, rd: pct, profit: pct, pay: (v) => (v === null ? "—" : `${(v / 10000).toFixed(1)} 万/人`) };
const tone = (p: number | null) => (p === null ? "" : p >= 75 ? "good" : p >= 50 ? "accent" : p >= 25 ? "" : "amber");

export default function Compare() {
  const [text, setText] = useState("");
  const [names, setNames] = useState<string[]>([]);
  return (
    <>
      <H1 sub="每家公司在自己行业的全部上市公司里排在哪；再看在你在意的方面下，这几家谁更靠前。不打总分。">比较单位</H1>
      <div className="flex gap-2 mb-3 items-start">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="公司名或股票代码，用逗号或换行隔开，最多 15 家（只比 A 股上市公司）" className="px-3 py-1.5 border border-line rounded-md bg-paper text-sm flex-1 min-w-0" />
        <Button tone="primary" onClick={() => setNames(text.split(/[\n,，、;；]+/).map((s) => s.trim()).filter(Boolean))}>比较</Button>
      </div>
      {names.length ? <CompareResults names={names} /> : <Empty>输入几家公司，比如「汇川技术，埃斯顿，华中数控」。</Empty>}
    </>
  );
}

/** The comparison of `names`; `aside` adds a line under a company (a report shows its posts there). */
export function CompareResults({ names, aside }: { names: string[]; aside?: (c: any) => ReactNode }) {
  const [view, setView] = useState<string>("均衡");
  const [own, setOwn] = useState<Record<Facet, number>>({ growth: 25, rd: 25, pay: 25, profit: 25 });
  const [r, setR] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const run = async (scenario: string, weights = own) => {
    setBusy(true); setMsg("");
    try { setR(await call("employer.compare", { companies: names.slice(0, 15), ...(scenario === "你设的权重" ? { weights } : {}) })); setView(scenario); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { setR(null); if (names.length) run(view === "你设的权重" ? "均衡" : view); }, [names.join("|")]);
  const rows: any[] = r?.companies ?? [];
  const at = (c: any) => c.under[view]?.place ?? c.under[view]?.byKnown ?? 99;
  const ranked = rows.filter((c) => c.under).sort((a, b) => at(a) - at(b));
  return (
    <>
      <div className="flex flex-wrap gap-2 items-center mb-3 text-sm">
        <span className="text-ink-3">看哪种偏好：</span>
        {PRESETS.map((p) => <Button key={p} tone={view === p ? "primary" : ""} onClick={() => setView(p)}>{p}</Button>)}
        <Button tone={view === "你设的权重" ? "primary" : ""} onClick={() => run("你设的权重")}>按我设的</Button>
      </div>
      {view === "你设的权重" && (
        <Card className="p-3 mb-3 flex flex-wrap gap-4 text-sm">
          {FACETS.map(([k, label]) => (
            <label key={k} className="flex items-center gap-2">{label}
              <input type="range" min={0} max={100} value={own[k]} onChange={(e) => setOwn({ ...own, [k]: Number(e.target.value) })} onMouseUp={() => run("你设的权重")} onKeyUp={() => run("你设的权重")} />
              <span className="w-8 text-ink-3">{own[k]}</span>
            </label>
          ))}
        </Card>
      )}
      {msg && <div className="mb-2 text-sm text-bad">{msg}</div>}
      {busy && !r && <Empty>第一次查一个行业要取它全部上市公司的年报数据，约 20–30 秒…</Empty>}
      {r && !rows.length && <Empty>这里面没有 A 股上市公司，没法比。{notFound(r.notFound)}</Empty>}
      {r && rows.length > 0 && (
        <>
          <Card className="divide-y divide-line">
            {ranked.map((c) => <Row key={c.code} c={c} view={view} aside={aside?.(c)} />)}
            {rows.filter((c) => !c.under).map((c) => <div key={c.code} className="px-4 py-2 text-sm text-ink-3">{c.name}：{c.note}</div>)}
          </Card>
          {r.notFound.length > 0 && <div className="mt-2 text-sm text-ink-3">{notFound(r.notFound)}</div>}
          <div className="mt-3 text-xs text-ink-3 leading-relaxed">
            {r.year} 年报 · 同行：{r.peerGroup}（{Object.entries(r.data.pools).map(([k, v]: any) => `${k} ${v.companies} 家，${v.at.slice(0, 10)} 取数`).join("；")}）· {r.data.source}<br />
            {r.measures.map((m: any) => `${m.label}＝${m.measure}${m.note ? `（${m.note}）` : ""}`).join("；")}<br />
            {r.method}
          </div>
        </>
      )}
    </>
  );
}

/** Names not compared, grouped by why: the reason once, the names after it. */
const notFound = (xs: any[]) => [...xs.reduce((m, n) => m.set(n.reason, [...(m.get(n.reason) ?? []), n]), new Map<string, any[]>())].map(([why, ns]) => `${why}：${ns.map((n: any) => n.query + (n.candidates ? `（${n.candidates.join("、")}）` : "")).join("、")}`).join("；");

function Row({ c, view, aside }: { c: any; view: string; aside?: ReactNode }) {
  const u = c.under?.[view];
  const place = !u ? "" : u.place !== null ? `第 ${u.place} 名${u.usually[0] !== u.usually[1] ? `（通常 ${u.usually[0]}–${u.usually[1]}）` : ""} · 进前三 ${u.top3Share}%` : `缺${u.missing.length}项：按已知第 ${u.byKnown} 名，最好 ${u.best}、最坏 ${u.worst}`;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">{c.name}</span>
        <span className="text-xs text-ink-3">{c.industry} · {c.code}</span>
        {c.labels.map((l: any) => <span key={l.label} title={l.rule}><Chip tone="accent">{l.label}</Chip></span>)}
        <span className="ml-auto text-sm font-medium">{place}</span>
      </div>
      <div className="grid grid-cols-4 gap-2 mt-2 text-sm">
        {FACETS.map(([k, label]) => (
          <div key={k} title={`同行 ${c.peers[k]} 家`}>
            <div className="text-xs text-ink-3">{label}</div>
            <div>{show[k](c.value[k])} {c.percentile[k] !== null && <Chip tone={tone(c.percentile[k]) as any}>同行第 {c.percentile[k]} 百分位</Chip>}</div>
          </div>
        ))}
      </div>
      <div className="mt-1 text-xs text-ink-2">
        {c.movedTogether.length > 0 && <span>{c.movedTogether.join("；")}。</span>}
        {c.outdoneBy?.length > 0 && <span className="text-ink-3"> 四项都不如{c.outdoneBy.join("、")}。</span>}
        {c.anyWeighting !== null && <span className="text-ink-3"> 不论偏好，进前三的权重占 {c.anyWeighting}%。</span>}
      </div>
      {aside && <div className="mt-1 text-xs">{aside}</div>}
    </div>
  );
}
