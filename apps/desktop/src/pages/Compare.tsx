import { useEffect, useState, type ReactNode } from "react";
import { call } from "../api";
import { Card, Button, Chip, Empty } from "../ui";

/**
 * 比较几家公司 (employer.compare, D-29): where each listed company stands in its own industry on four measures, and its
 * place among the ones named here under a preference. No total score; places come with how far they move. Every name
 * asked about gets a row: one that cannot be placed says why, and can still get an employer report.
 */
const FACETS = [["growth", "成长"], ["rd", "研发"], ["pay", "待遇信号"], ["profit", "盈利"]] as const;
type Facet = (typeof FACETS)[number][0];
const PRESETS = ["成长研发优先", "均衡", "稳定回报优先"] as const;
const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
const show: Record<Facet, (v: number | null) => string> = { growth: pct, rd: pct, profit: pct, pay: (v) => (v === null ? "—" : `${(v / 10000).toFixed(1)} 万/人`) };
const tone = (p: number | null) => (p === null ? "" : p >= 75 ? "good" : p >= 50 ? "accent" : p >= 25 ? "" : "amber");
const input = "px-3 py-1.5 border border-line rounded-md bg-paper text-sm";
/** Answers already had on this page, by what was asked: shown at once when asked again, then refreshed quietly. */
const answered = new Map<string, any>();

/** The names typed in, compared. Used by 调研 as its second entry. */
export function CompareBox() {
  const [text, setText] = useState("");
  const [names, setNames] = useState<string[]>([]);
  const [peer, setPeer] = useState("");
  const [asked, setAsked] = useState("");
  return (
    <>
      <div className="flex gap-2 items-start">
        <textarea value={text} onChange={(e) => setText(e.target.value)} rows={2} placeholder="公司名或股票代码，用逗号或换行隔开，最多 15 家（A 股、新三板、港股、美股；未上市的也可以写，会单独列出）" className={`${input} flex-1 min-w-0`} />
        <input value={peer} onChange={(e) => setPeer(e.target.value)} placeholder="港美股按哪个行业比（可空）" title="申万一级行业名，如 机械设备、电子、汽车。空着就按一起比的 A 股公司所在行业" className={`${input} w-48`} />
        <Button tone="primary" onClick={() => { setAsked(peer.trim()); setNames(text.split(/[\n,，、;；]+/).map((s) => s.trim()).filter(Boolean)); }}>比较</Button>
      </div>
      <div className="text-xs text-ink-3 mt-2">每家在自己行业的全部上市公司里排第几（百分位），再看在你在意的方面下谁更靠前。不打总分，不用 AI，约半分钟。</div>
      {names.length > 0 && <div className="mt-4"><CompareResults names={names} peerIndustry={asked} /></div>}
    </>
  );
}

/** One click to have the person's agent write the employer report (research.company 就业评估). */
export function AssessButton({ companyName }: { companyName: string }) {
  const [state, setState] = useState<"" | "sending" | "sent" | string>("");
  const go = async () => {
    setState("sending");
    try { await call("research.company", { companyName, question: "就业评估" }); setState("sent"); } catch (e: any) { setState(e.message); }
  };
  if (state === "sent") return <span className="text-xs text-good" title="写好后在公司卡的「调研」里，约十几分钟">已交给助手写</span>;
  return <span className="inline-flex items-center gap-1"><Button onClick={go} disabled={state === "sending"} title="交给你的 AI 助手：利润为什么变、人员和人均、钱去了哪、激励、上市进展、和你的匹配">{state === "sending" ? "派发中…" : "写就业评估报告"}</Button>{state && state !== "sending" && <span className="text-xs text-bad">{state}</span>}</span>;
}

/**
 * The comparison of `names`. `aside` adds a line under a company (a report shows its posts there); `nameOf` gives the
 * name an employer report is filed under (a report knows the pool's name for its companies).
 */
export function CompareResults({ names, aside, peerIndustry, nameOf }: { names: string[]; aside?: (c: { name: string; org?: string }) => ReactNode; peerIndustry?: string; nameOf?: (c: { name: string; org?: string }) => string }) {
  const [view, setView] = useState<string>("均衡");
  const [own, setOwn] = useState<Record<Facet, number>>({ growth: 25, rd: 25, pay: 25, profit: 25 });
  const [r, setR] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const run = async (scenario: string, weights = own) => {
    const ask = { companies: names.slice(0, 15), ...(peerIndustry ? { peerIndustry } : {}), ...(scenario === "你设的权重" ? { weights } : {}) };
    const key = JSON.stringify(ask), had = answered.get(key);
    if (had) { setR(had); setView(scenario); } // seen before: shown at once, refreshed below
    setBusy(!had); setMsg("");
    try { const fresh = await call("employer.compare", ask); answered.set(key, fresh); setR(fresh); setView(scenario); }
    catch (e: any) { if (!had) setMsg(e.message); } finally { setBusy(false); }
  };
  useEffect(() => { if (names.length) run(view === "你设的权重" ? "均衡" : view); }, [names.join("|"), peerIndustry]);
  const rows: any[] = r?.companies ?? [];
  const at = (c: any) => c.under[view]?.place ?? c.under[view]?.byKnown ?? 99;
  const ranked = rows.filter((c) => c.under).sort((a, b) => at(a) - at(b));
  const reportName = (c: { name: string; org?: string }) => nameOf?.(c) || c.org || c.name;
  // everything that could not be placed, each as a row with why: no annual report yet, not listed, a name to pin down
  const unplaced = [
    ...rows.filter((c) => !c.under).map((c) => ({ key: c.code, name: c.name, org: c.org, why: c.note })),
    ...(r?.notFound ?? []).map((n: any) => ({ key: n.query, name: n.query, org: undefined, why: n.reason + (n.candidates ? `：${n.candidates.join("、")}` : ""), known: n.known })),
  ];
  return (
    <>
      {msg && <div className="mb-2 text-sm text-bad">{msg}</div>}
      {busy && !r && <Empty>第一次查一个行业要取它全部上市公司的年报数据，约 20–30 秒…</Empty>}
      {r && ranked.length > 0 && (
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
        </>
      )}
      {r && (
        <Card className="divide-y divide-line">
          {ranked.map((c) => <Row key={c.code} c={c} view={view} aside={aside?.(c)} assess={reportName(c)} />)}
          {unplaced.map((u) => (
            <div key={u.key} className="px-4 py-3">
              <div className="flex items-center gap-2 flex-wrap">
                <span className="font-medium">{u.name}</span>
                <Chip>不参与排名</Chip>
                <span className="ml-auto"><AssessButton companyName={reportName(u)} /></span>
              </div>
              {u.known && <Known k={u.known} />}
              <div className="text-xs text-ink-3 mt-1">{u.why}</div>
              {aside && <div className="mt-1 text-xs">{aside(u)}</div>}
            </div>
          ))}
        </Card>
      )}
      {r && ranked.length > 0 && (
        <div className="mt-3 text-xs text-ink-3 leading-relaxed">
          {r.year} 年报 · 同行：{r.peerGroup}（{Object.entries(r.data.pools).map(([k, v]: any) => `${k} ${v.companies} 家，${v.at.slice(0, 10)} 取数`).join("；")}）· {r.data.source}<br />
          {r.measures.map((m: any) => `${m.label}＝${m.measure}${m.note ? `（${m.note}）` : ""}`).join("；")}<br />
          {r.method}
        </div>
      )}
    </>
  );
}

/** What is known of a company with no listing: funding stage, size and industry as BOSS showed them, 专精特新, a listing review. */
function Known({ k }: { k: any }) {
  const bits = [
    k.boss && [k.boss.stage, k.boss.scale, k.boss.industry].filter(Boolean).length ? `BOSS 直聘：${[k.boss.stage, k.boss.scale, k.boss.industry].filter(Boolean).join(" · ")}（${k.boss.seen} 见到）` : "",
    k.sme ? `专精特新：${k.sme}` : "",
    k.ipo ? `${k.ipo.board}项目库：${k.ipo.stage}${k.ipo.date ? `（${k.ipo.date}）` : ""}` : "",
  ].filter(Boolean);
  return bits.length ? <div className="text-xs text-ink-2 mt-1 flex flex-wrap gap-1.5">{bits.map((b) => <Chip key={b}>{b}</Chip>)}</div> : <div className="text-xs text-ink-3 mt-1">职路手上还没有它的融资和规模信息：BOSS 上搜到过它就会有；更全的（融资轮次、投资方、上市计划）在就业评估报告里。</div>;
}

function Row({ c, view, aside, assess }: { c: any; view: string; aside?: ReactNode; assess: string }) {
  const u = c.under?.[view];
  const place = !u ? "" : u.place !== null ? `第 ${u.place} 名${u.usually[0] !== u.usually[1] ? `（通常 ${u.usually[0]}–${u.usually[1]}）` : ""}${u.top3Share !== null ? ` · 进前三 ${u.top3Share}%` : ""}` : `缺${u.missing.length}项：按已知第 ${u.byKnown} 名，最好 ${u.best}、最坏 ${u.worst}`;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="font-medium">{c.name}</span>
        <span className="text-xs text-ink-3">{c.market && c.market !== "A股" ? `${c.market} · ` : ""}{c.industry ? `${c.industry} · ` : ""}{c.code} · 同行：{c.peerGroup}</span>
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
      <div className="mt-1 text-xs text-ink-2 flex items-start gap-2">
        <span className="flex-1">
          {c.movedTogether.length > 0 && <span>{c.movedTogether.join("；")}。</span>}
          {c.outdoneBy?.length > 0 && <span className="text-ink-3"> 四项都不如{c.outdoneBy.join("、")}。</span>}
          {c.anyWeighting !== null && <span className="text-ink-3"> 不论偏好，进前三的权重占 {c.anyWeighting}%。</span>}
        </span>
        <AssessButton companyName={assess} />
      </div>
      {c.yardstick && <div className="mt-1 text-xs text-amber">{c.yardstick}</div>}
      {aside && <div className="mt-1 text-xs">{aside}</div>}
    </div>
  );
}
