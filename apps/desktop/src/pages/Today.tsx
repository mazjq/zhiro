import { useEffect, useState } from "react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Chip, Button, Empty, deadlineTone, openInJobs } from "../ui";
import { describeProposal, FRIENDLY } from "../describe";

/** 今天的简报 (P4): what changed since the last one, made each morning at the person's hour. */
function BriefCard({ go }: { go: (p: string) => void }) {
  const [b, setB] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const latest = useLatest();
  const load = () => { latest("b", call("brief.today", {})).then((r) => setB(r.brief)).catch(() => {}); };
  useEffect(load, []);
  useOnDataChange(load);
  const make = async () => { setBusy(true); try { await call("brief.make", {}); load(); } finally { setBusy(false); } };
  const part = (title: string, xs: any[]) => xs?.length ? (
    <div className="mb-2"><div className="text-xs text-ink-3 mb-1">{title} · {xs.length}</div>
      {xs.map((x: any) => (
        <div key={x.key} className="text-sm py-0.5 flex gap-2 items-baseline">
          <span className="flex-1 hover:text-accent cursor-pointer" title={x.why} onClick={() => x.link?.company ? openInJobs(x.link.company, x.link.id) : x.link && go(x.link.page)}>{x.text}</span>
          {x.url && <a className="text-xs text-accent shrink-0" href={x.url} target="_blank" rel="noreferrer">打开</a>}
        </div>))}
    </div>) : null;
  const empty = b && !b.must.length && !b.fresh.length && !b.found.length && !b.hanging.length;
  return (
    <Card className="mb-6 px-4 py-3">
      <div className="flex items-center gap-2 mb-2"><div className="font-bold">今天的简报</div>
        {b && <span className="text-xs text-ink-3">{new Date(b.at).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })} 生成，只讲上一份以来的变化</span>}
        <button className="ml-auto text-xs text-accent disabled:opacity-40" disabled={busy} onClick={make}>现在生成一份</button></div>
      {!b ? <div className="text-sm text-ink-3">还没有简报：每天早上按你设的时间生成（配置页可改）。</div>
        : empty ? <div className="text-sm text-ink-3">上一份以来没有新变化。</div>
        : <>{part("今天必须做", b.must)}{part("新出现的", b.fresh)}{part("重新找过的", b.found)}{part("悬着的", b.hanging)}</>}
    </Card>
  );
}

const SLOT: Record<string, string> = { new: "新机会", decide: "要决定", fill: "可补", company: "重点公司" };
const REASONS: [string, string][] = [["single", "只是这一个"], ["company", "这家公司不投"], ["type", "这类岗位不投"], ["city", "不去这个城市"], ["group", "这个集团只投一个"]];
const DECIDED: Record<string, string> = { apply: "投：草稿建好了", skip: "不投", hold: "先放着", fill: "补一下", seen: "看过了" };

/** 本周短名单: the week's cards, decided here — one main button, 不投 asks why once, what a rule kept out can be put back. */
function ShortlistCard({ go }: { go: (p: string) => void }) {
  const [l, setL] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState<{ key: string; reason: string; detail: string } | null>(null);
  const [showSkipped, setShowSkipped] = useState(false);
  const [err, setErr] = useState("");
  const latest = useLatest();
  const load = () => { latest("sl", call("shortlist.current", {})).then((r) => setL(r.shortlist)).catch(() => {}); };
  useEffect(load, []);
  useOnDataChange(load);
  const run = async (f: () => Promise<any>) => { setBusy(true); setErr(""); try { const r = await f(); if (r?.shortlist) setL(r.shortlist); else load(); } catch (e: any) { setErr(FRIENDLY[e.code] ?? e.message); } finally { setBusy(false); } };
  const decide = (c: any, decision: string, reason?: string, detail?: string) => run(() => call("shortlist.decide", { runId: l.id, key: c.key, decision, reason, detail }));
  const reasonFor = (c: any) => REASONS.filter(([k]) => k !== "group" || (c.group && c.groupApplied?.length));
  if (!l) return null;
  const slots = ["new", "decide", "fill", "company"].map((s) => [s, l.cards.filter((c: any) => c.slot === s)] as const).filter(([, xs]) => xs.length);
  return (
    <Card className="mb-6 px-4 py-3">
      <div className="flex items-center gap-2 mb-2"><div className="font-bold">本周短名单 · {l.cards.length} 张</div>
        <span className="text-xs text-ink-3">{l.week} 这周 · 每张卡定一下就行，一周 15 分钟</span>
        <button className="ml-auto text-xs text-accent disabled:opacity-40" disabled={busy} onClick={() => run(() => call("shortlist.make", {}))}>重出一份</button></div>
      {err && <div className="text-sm text-bad mb-2">{err}</div>}
      {!l.cards.length && <div className="text-sm text-ink-3">这周没有够格的新机会；没上卡的在下面。</div>}
      {slots.map(([slot, xs]) => (
        <div key={slot} className="mb-2"><div className="text-xs text-ink-3 mb-1">{SLOT[slot]} · {xs.length}</div>
          {xs.map((c: any) => { const ask = asking && asking.key === c.key ? asking : null; return (
            <div key={c.key} className="py-2 border-t border-line">
              <div className="flex items-baseline gap-2 flex-wrap">
                <span className="font-medium hover:text-accent cursor-pointer" onClick={() => openInJobs(c.company, c.positionId || undefined)}>{c.company} · {c.title}</span>
                {c.cities?.length > 0 && <span className="text-xs text-ink-3">{c.cities.slice(0, 3).join("/")}</span>}
                {c.notes?.map((n: string) => <Chip key={n} tone={/重点|放回/.test(n) ? "accent" : /截止|到期|剩/.test(n) ? "amber" : ""}>{n}</Chip>)}
              </div>
              {slot === "company" ? <>
                <div className="text-sm text-ink-2 mt-0.5">{c.why}</div>
                <div className="text-sm text-ink-2">怎么投：{c.gap}</div>
                {c.links?.length > 0 && <div className="text-xs mt-0.5 flex gap-3 flex-wrap">{c.links.map((x: any) => <a key={x.url} className="text-accent" href={x.url} target="_blank" rel="noreferrer">{x.text}</a>)}</div>}
              </> : <>
                <div className="text-sm text-ink-2 mt-0.5">为什么是你：{c.why}</div>
                <div className="text-sm text-ink-2">差什么：{c.gap}</div>
                {c.plan && <div className="text-sm text-ink-2 mt-1 pl-2 border-l-2 border-line whitespace-pre-line">{c.plan}</div>}
                {c.planNote && <div className="text-xs text-ink-3 mt-0.5">{c.planNote}</div>}
              </>}
              <div className="flex items-center gap-2 mt-1.5 flex-wrap">
                {c.decision !== "pending" ? <>
                  <Chip tone={c.decision === "apply" ? "good" : c.decision === "skip" ? "" : "amber"}>{DECIDED[c.decision]}{c.reason && c.reason !== "single" ? `（${REASONS.find(([k]) => k === c.reason)?.[1]}${c.detail ? "：" + c.detail : ""}）` : ""}{c.expiresAt && c.decision !== "apply" ? ` · 到 ${c.expiresAt}` : ""}</Chip>
                  {c.decision === "apply" && <button className="text-xs text-accent" onClick={() => go("pipeline")}>去准备申请</button>}
                </> : slot === "company" ? <>
                  <Button tone="primary" disabled={busy} onClick={() => decide(c, "seen")}>看过了</Button>
                  <Button disabled={busy} onClick={() => decide(c, "skip", "company")}>不投这家</Button>
                </> : ask ? <>
                  <span className="text-xs text-ink-3">为什么不投：</span>
                  {reasonFor(c).map(([k, t]) => <button key={k} className={`text-xs px-2 py-0.5 rounded border ${ask.reason === k ? "border-accent text-accent" : "border-line"}`} onClick={() => setAsking({ ...ask!, reason: k })}>{t}</button>)}
                  {(ask.reason === "type" || ask.reason === "city") && <input className="text-xs border border-line rounded px-2 py-0.5 w-40" placeholder={ask.reason === "type" ? "岗位名里的词，如 销售" : "城市"} value={ask.detail} onChange={(e) => setAsking({ ...ask!, detail: e.target.value })} />}
                  <Button tone="primary" disabled={busy} onClick={() => { decide(c, "skip", ask!.reason, ask!.detail); setAsking(null); }}>确定</Button>
                  <Button onClick={() => setAsking(null)}>算了</Button>
                </> : <>
                  <Button tone="primary" disabled={busy} onClick={() => decide(c, "apply")}>{c.applicationId ? "投（去准备）" : "投"}</Button>
                  <Button disabled={busy} onClick={() => setAsking({ key: c.key, reason: "single", detail: "" })}>不投</Button>
                  {slot !== "decide" && <Button disabled={busy} onClick={() => decide(c, "hold")}>先放着</Button>}
                  {slot !== "decide" && <Button disabled={busy} title={c.gapConcept ? `差「${c.gapConcept}」，到期前再问` : "差的那项补一下，到期前再问"} onClick={() => decide(c, "fill")}>补一下</Button>}
                </>}
              </div>
            </div>); })}
        </div>))}
      {l.skippedTotal > 0 && <div className="text-xs text-ink-3 mt-1 border-t border-line pt-2">
        <button className="text-accent" onClick={() => setShowSkipped(!showSkipped)}>本周没上卡 {l.skippedTotal} 个（{Object.entries(l.skippedBy ?? {}).map(([k, n]) => `${k} ${n}`).join("、")}）{showSkipped ? "，收起" : "：看看、放回来"}</button>
        {showSkipped && l.skipped.map((x: any) => (
          <div key={x.positionId} className="flex items-baseline gap-2 py-0.5">
            <span className="flex-1 hover:text-accent cursor-pointer" onClick={() => openInJobs(x.company, x.positionId)}>{x.company} · {x.title}</span>
            <span>{x.reason}</span>
            <button className="text-accent shrink-0" disabled={busy} onClick={() => run(() => call("shortlist.restore", { runId: l.id, positionId: x.positionId }))}>{x.rule ? "放回来（撤销这条规则）" : "放回来"}</button>
          </div>))}
        {showSkipped && l.skipped.length < l.skippedTotal && <div>只列了前 {l.skipped.length} 个</div>}
      </div>}
    </Card>
  );
}

/** Notices that did not reach the person: said first on the page, never left to look delivered (B1). */
function NoticeLine({ go }: { go: (p: string) => void }) {
  const [c, setC] = useState<any>(null);
  const latest = useLatest();
  const load = () => { latest("n", call("notice.list", { limit: 1 })).then((r) => setC(r.counts)).catch(() => {}); };
  useEffect(load, []);
  useOnDataChange(load);
  if (!c || (!c.unsent && !c.unread && !c.failed)) return null;
  const otherUnsent = c.unsent - c.notConfigured;
  return (
    <Card className="mb-6 px-4 py-3 border-amber">
      {c.notConfigured > 0 && <div className="text-sm"><b className="text-amber">{c.notConfigured} 条提醒没送出去</b>：飞书还没接通。<button className="text-accent ml-1" onClick={() => go("settings")}>去接通</button></div>}
      {otherUnsent > 0 && <div className="text-sm"><b className="text-amber">{otherUnsent} 条提醒还在等着发</b>{c.erring > 0 ? `（其中 ${c.erring} 条发送出错，会自动重试）` : "（笔试安静中，结束后发）"}</div>}
      {c.failed > 0 && <div className="text-sm"><b className="text-bad">{c.failed} 条提醒发送失败</b>：重试了 10 次还是不行，看看飞书应用的权限。<button className="text-accent ml-1" onClick={() => go("settings")}>去设置</button></div>}
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
  // P3: only what still needs the person is listed; what is already so or no longer stands folds into one line
  const live = items.filter((p) => !p.view || p.view.state === "待处理" || p.view.state === "需补救");
  const folded = items.filter((p) => p.view && (p.view.state === "已完成" || p.view.state === "已过时"));
  const dismiss = async () => { try { await call("proposal.dismiss", { ids: folded.map((p) => p.id) }); setErr(""); } catch (e: any) { setErr(e.message); } load(); };
  const renew = async (p: any) => { try { await call("proposal.renew", { id: p.id }); setErr(""); } catch (e: any) { setErr(e.message); } load(); };
  if (!items.length) return null;
  return (
    <>
      <h2 className="font-bold mb-2">待你确认 · {live.length}</h2>
      {err && <div className="text-sm text-bad mb-2">{err}</div>}
      {folded.length > 0 && (
        <div className="text-sm text-ink-3 mb-2">
          另有 {folded.filter((p) => p.view.state === "已完成").length} 张已经办到、{folded.filter((p) => p.view.state === "已过时").length} 张已经不算数的卡
          <button className="text-accent ml-2" title={folded.map((p) => `${describe(p)}：${p.view.why}`).join("\n")} onClick={dismiss}>全部收起</button>
        </div>
      )}
      {live.length > 0 && <Card className="mb-7">
        {live.map((p) => (
          <div key={p.id} className="px-4 py-2.5 border-t first:border-t-0 border-line flex items-center gap-2" title={JSON.stringify(p.payload, null, 1)}>
            <div className="flex-1 min-w-0"><div className="text-sm">{describe(p)}</div>{p.execution === "interrupted" && <div className="text-xs text-bad">上次执行到一半被中断，可能已部分完成，请核对后再点</div>}{p.reason && <div className="text-xs text-ink-3 truncate">{p.reason}</div>}</div>
            {p.execution === "running" ? <span className="text-xs text-ink-3">正在执行…</span>
              : p.view?.state === "需补救" ? <><span className="text-xs text-amber" title={p.view.why}>过期了，还有用</span><Button tone="primary" onClick={() => renew(p)}>重新提出</Button><Button onClick={() => decide(p, "rejected")}>忽略</Button></>
              : <><Button tone="primary" onClick={() => decide(p, "approved")}>确认</Button><Button onClick={() => decide(p, "rejected")}>忽略</Button></>}
          </div>
        ))}
      </Card>}
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
      <ShortlistCard go={go} />
      <BriefCard go={go} />
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
            <div key={d.positionId ?? d.companyId} className="px-4 py-2.5 border-t first:border-t-0 border-line flex items-center gap-2 hover:bg-ground cursor-pointer" onClick={() => openInJobs(d.companyName, d.positionId)} title={d.say}>
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
              <div key={d.positionId ?? d.companyId} className="px-4 py-2.5 border-t first:border-t-0 border-line hover:bg-ground cursor-pointer" onClick={() => openInJobs(d.companyName, d.positionId)}>
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
