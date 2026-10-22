import { useEffect, useState } from "react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Chip, Button, Empty, deadlineTone } from "../ui";
import { describeProposal, FRIENDLY } from "../describe";

/** Notices that did not reach the person: said first on the page, never left to look delivered (B1). */
function NoticeLine({ go }: { go: (p: string) => void }) {
  const [c, setC] = useState<any>(null);
  const latest = useLatest();
  const load = () => { latest("n", call("notice.list", { limit: 1 })).then((r) => setC(r.counts)).catch(() => {}); };
  useEffect(load, []);
  useOnDataChange(load);
  if (!c || (!c.unsent && !c.unread)) return null;
  return (
    <Card className="mb-6 px-4 py-3 border-amber">
      {c.notConfigured > 0 && <div className="text-sm"><b className="text-amber">{c.notConfigured} 条提醒没送出去</b>：飞书还没接通。<button className="text-accent ml-1" onClick={() => go("settings")}>去接通</button></div>}
      {c.unread > 0 && <div className="text-sm"><b className="text-amber">{c.unread} 条提醒你还没看</b>（笔试面试、截止）：打开手机飞书的「Zhiro 职路」看一眼。</div>}
    </Card>
  );
}

/** 待确认: what an agent or the inbox wants to write, said the way the user would say it, decided right here. */
function Pending() {
  const [items, setItems] = useState<any[]>([]);
  const [apps, setApps] = useState<any[]>([]);
  const [err, setErr] = useState("");
  const latest = useLatest();
  const load = () => { latest("p", call("proposal.list", {})).then((r) => setItems(r.items)).catch(() => {}); latest("a", call("application.list")).then((r) => setApps(r.items)).catch(() => {}); };
  useEffect(load, []);
  useOnDataChange(load);
  const app = (id?: string) => { const a = apps.find((x) => x.application.id === id); return a ? `「${a.companyName} · ${a.title}」` : "一条申请"; };
  const describe = (p: any) => describeProposal(p, app);
  const decide = async (p: any, decision: "approved" | "rejected") => {
    try { await call("proposal.decide", { id: p.id, decision, payloadHash: p.payloadHash }); setErr(""); } catch (e: any) { setErr(FRIENDLY[e.code] ?? e.message); }
    load();
  };
  if (!items.length) return null;
  return (
    <>
      <h2 className="font-bold mb-2">待你确认 · {items.length}</h2>
      {err && <div className="text-sm text-bad mb-2">{err}</div>}
      <Card className="mb-7">
        {items.map((p) => (
          <div key={p.id} className="px-4 py-2.5 border-t first:border-t-0 border-line flex items-center gap-2" title={JSON.stringify(p.payload, null, 1)}>
            <div className="flex-1 min-w-0"><div className="text-sm">{describe(p)}</div>{p.execution === "interrupted" && <div className="text-xs text-bad">上次执行到一半被中断，可能已部分完成，请核对后再点</div>}{p.reason && <div className="text-xs text-ink-3 truncate">{p.reason}</div>}</div>
            {p.execution === "running" ? <span className="text-xs text-ink-3">正在执行…</span>
              : <><Button tone="primary" onClick={() => decide(p, "approved")}>确认</Button><Button onClick={() => decide(p, "rejected")}>忽略</Button></>}
          </div>
        ))}
      </Card>
    </>
  );
}

export default function Today({ go }: { go: (p: any) => void }) {
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState("");
  const latest = useLatest();
  const load = () => latest("s", call("today.summary", { days: 14 })).then((d) => { setData(d); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  useOnDataChange(load);
  if (!data) return err ? <div className="text-bad">{err}</div> : null; // a refresh that fails keeps what is on screen
  const today = new Date().toLocaleDateString("zh-CN", { year: "numeric", month: "long", day: "numeric", weekday: "short" });
  return (
    <>
      <H1 sub={today}>今日</H1>
      <NoticeLine go={go} />
      <Pending />

      {data.nextActions.length > 0 && (
        <>
          <h2 className="font-bold mb-2">下一步</h2>
          <Card className="mb-7">
            {data.nextActions.map((n: any) => (
              <div key={n.applicationId} className="px-4 py-2.5 border-t first:border-t-0 border-line flex gap-3 items-baseline cursor-pointer hover:bg-ground" onClick={() => go("pipeline")}>
                <span className="font-medium w-40 shrink-0">{n.companyName}</span>
                <span className="flex-1">{n.nextAction}</span>
                <span className="font-mono text-xs text-ink-3">{n.nextActionAt ?? ""}</span>
              </div>
            ))}
          </Card>
        </>
      )}

      <h2 className="font-bold mb-2">14 天内截止</h2>
      {data.deadlines.length === 0 ? <Empty>没有</Empty> : (
        <Card>
          {data.deadlines.map((d: any) => (
            <div key={d.positionId ?? d.companyId} className="px-4 py-2.5 border-t first:border-t-0 border-line flex items-center gap-2 hover:bg-ground cursor-pointer" onClick={() => go(d.positionId ? "pipeline" : "jobs")} title={d.say}>
              <span className="font-medium shrink-0">{d.companyName}</span><span className="text-sm text-ink-2 flex-1 truncate">{d.title}{d.cities?.length > 0 && <span className="ml-1.5 text-xs text-ink-3">{d.cities.slice(0, 3).join("/")}</span>}</span>
              {d.applied && <Chip tone="good">已投递</Chip>}
              {!d.verified && <Chip tone="amber">待核实</Chip>}
              {d.conflict && <Chip tone="amber">有分歧</Chip>}
              <Chip tone={d.applied ? "" : deadlineTone(d.daysLeft)}>{d.closesAt.slice(5)} · {d.daysLeft} 天</Chip>
            </div>
          ))}
        </Card>
      )}

      {data.verify?.length > 0 && (
        <>
          <h2 className="font-bold mb-2 mt-6">截止待核实</h2>
          <Card>
            {data.verify.map((d: any) => (
              <div key={d.positionId ?? d.companyId} className="px-4 py-2.5 border-t first:border-t-0 border-line hover:bg-ground cursor-pointer" onClick={() => go(d.positionId ? "pipeline" : "jobs")}>
                <div className="flex items-center gap-2"><span className="font-medium shrink-0">{d.companyName}</span><span className="text-sm text-ink-2 flex-1 truncate">{d.title}</span>{d.url && <a className="text-accent text-xs shrink-0" href={d.url} target="_blank" rel="noreferrer" onClick={(e) => e.stopPropagation()}>去官网看</a>}</div>
                <div className="text-xs text-ink-3 mt-0.5">{d.say} · {d.why}</div>
              </div>
            ))}
          </Card>
        </>
      )}
    </>
  );
}
