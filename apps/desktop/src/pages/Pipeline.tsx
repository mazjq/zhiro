import { useEffect, useRef, useState } from "react";
import { call, daysLeft } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Chip, Button, Empty, STATE_LABEL, deadlineTone, deadlineShort } from "../ui";
import { ResumeChoice } from "./Resumes";
import { Links, applyLink, PostDetails } from "./CompanyView";

const STAGES = ["测评", "笔试", "面试", "一面", "二面", "三面", "终面", "技术面", "综合面", "HR面", "offer", "三方", "体检", "其他"];
const day = (s: string | null) => (s ? s.slice(0, 10) : "");
const minute = (s: string | null) => (s ? s.slice(5, 16).replace("T", " ") : "");
const input = "px-2.5 py-1.5 border border-line rounded-md bg-paper text-sm";

const Deadline = ({ at, r }: { at: string | null; r?: any }) => { const d = daysLeft(at); return at ? <Chip tone={deadlineTone(d)}>{d != null && d < 0 ? `${at.slice(5)} 已截止` : `${at.slice(5)} 截止${d != null ? ` · ${d} 天` : ""}`}</Chip> : <span title={r?.say}><Chip>{deadlineShort(r) || "截止未知"}</Chip></span>; };

/** 准备申请 → 已投递: the moment of applying is when date, resume version and receipt number are known. */
function MarkSubmitted({ id, done }: { id: string; done: () => void }) {
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [externalAppId, setExt] = useState("");
  const save = () => call("application.update", { id, state: "submitted", submittedAt: `${date}T12:00:00+08:00`, externalAppId }).then(done);
  return (
    <div className="flex gap-2 items-center flex-wrap">
      <label className="text-xs text-ink-3">投递日期</label><input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={input} />
      <input value={externalAppId} onChange={(e) => setExt(e.target.value)} placeholder="网申编号（可空）" className={`${input} w-40`} />
      <Button onClick={save}>标记已投递</Button>
    </div>
  );
}

const ACTIVE = ["准备中", "待你操作", "填写中", "待你提交"];
const RUN_TONE: Record<string, "good" | "accent" | "amber" | "bad" | ""> = { 准备中: "accent", 填写中: "accent", 待你操作: "amber", 待你提交: "good", 结果待核实: "amber", 已投递: "good", 已停止: "" };

/**
 * 开始网申 (ADR-024): Zhiro opens the dedicated browser, fills what it is sure of and never submits. Until the submit
 * button the user is only asked for what only they can do; what needs their eye comes back as a short list.
 */
function RunPanel({ a, canStart, onSubmitted }: { a: any; canStart: boolean; onSubmitted: () => void }) {
  const [run, setRun] = useState<any>(null);
  const [err, setErr] = useState("");
  const mine = run?.applicationId === a.id ? run : null;
  const live = !!mine && ACTIVE.includes(mine.state);
  const status = () => call("apply.status").then((r) => setRun(r.run)).catch(() => {});
  useEffect(() => { status(); }, [a.id]);
  useOnDataChange(() => { if (!live) status(); }); // while it runs it is polled every second anyway
  useEffect(() => {
    if (!live) return;
    const t = setInterval(() => call("apply.status").then((r) => { setRun(r.run); if (r.run?.applicationId === a.id && r.run.state === "已投递") onSubmitted(); }).catch(() => {}), 1000);
    return () => clearInterval(t);
  }, [live, a.id]);
  const start = () => { setErr(""); setRun({ applicationId: a.id, state: "准备中", reason: "正在打开专用浏览器", attention: [], learned: [], filled: 0 }); call("apply.start", { applicationId: a.id }).then((r) => setRun(r.run)).catch((e) => { setRun(null); setErr(e.message); }); };
  const pause = (paused: boolean) => call("apply.pause", { paused }).then((r) => setRun(r.run));
  if (!canStart && !mine) return null;
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 flex-wrap">
        {!live && canStart && <Button tone="primary" onClick={start}>{mine ? "重新开始网申" : "开始网申"}</Button>}
        {mine && <Chip tone={mine.paused ? "" : RUN_TONE[mine.state] ?? ""}>{mine.paused ? "已暂停" : mine.state}</Chip>}
        {mine?.platform && <span className="text-xs text-ink-3">{mine.platform}</span>}
        {mine?.reason && !mine.paused && <span className="text-sm text-ink-2">{mine.reason}</span>}
        {mine?.progress && <span className="text-sm text-ink-2">正在填 {mine.progress.done + 1}/{mine.progress.total}：{mine.progress.current}</span>}
        {mine && !mine.progress && (mine.filled > 0 || mine.bySite > 0) && <span className="text-xs text-ink-3">Zhiro 填了 {mine.filled} 项{mine.bySite ? `，网站按简历填了 ${mine.bySite} 项` : ""}</span>}
        {live && <span className="ml-auto flex gap-2"><Button onClick={() => pause(!mine.paused)}>{mine.paused ? "继续" : "暂停"}</Button><Button onClick={() => call("apply.close").then(() => call("apply.status")).then((r) => setRun(r.run))}>关闭浏览器</Button></span>}
      </div>
      {err && <div className="text-sm text-bad">{err}</div>}
      {mine && mine.attention.length > 0 && (
        <div className="border border-line rounded-md bg-ground/50">
          {mine.attention.map((x: any, i: number) => (
            <div key={i} className="px-3 py-1.5 border-t first:border-t-0 border-line text-sm flex items-baseline gap-2">
              <Chip tone={x.kind === "留给你" ? "" : "amber"}>{x.kind}</Chip><span>{x.label}</span>{x.section && <span className="text-xs text-ink-3">{x.section}</span>}<span className="text-xs text-ink-2 ml-auto truncate max-w-[55%]" title={x.detail}>{x.detail}</span>
            </div>
          ))}
        </div>
      )}
      {mine && mine.learned.length > 0 && <div className="text-xs text-ink-3">已写回资料：{mine.learned.join("、")}</div>}
    </div>
  );
}

/** Timeline rows are stored with internal state names; show them the way the rest of the page talks. */
const readable = (e: any) => (e.kind === "created" ? "准备申请" + (e.detail ? "：" + e.detail : "") : (e.detail || e.kind).replace(/draft|submitted|in_process|closed|cancelled/g, (s: string) => STATE_LABEL[s]));

function ResumeLabel({ a, done }: { a: any; done: () => void }) {
  const [v, setV] = useState(a.resumeLabel ?? "");
  return (
    <div className="flex gap-2 items-center">
      <label className="text-xs text-ink-3">简历版本</label>
      <input value={v} onChange={(e) => setV(e.target.value)} placeholder="投这家用的是哪一版" className={`${input} w-64`} />
      {v !== (a.resumeLabel ?? "") && <Button onClick={() => call("application.update", { id: a.id, resumeLabel: v }).then(done)}>保存</Button>}
    </div>
  );
}

function AddProgress({ id, done }: { id: string; done: () => void }) {
  const [kind, setKind] = useState("笔试");
  const [at, setAt] = useState("");
  const [notes, setNotes] = useState("");
  const save = () => call("stage.add", { applicationId: id, kind, scheduledAt: at ? `${at}:00+08:00` : undefined, notes: notes || undefined }).then(() => { setAt(""); setNotes(""); done(); });
  return (
    <div className="flex gap-2 items-center flex-wrap">
      <label className="text-xs text-ink-3">记录新进展</label>
      <select value={kind} onChange={(e) => setKind(e.target.value)} className={input}>{STAGES.map((k) => <option key={k}>{k}</option>)}</select>
      <input type="datetime-local" value={at} onChange={(e) => setAt(e.target.value)} className={input} />
      <input value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="备注：链接、地点、联系人" className={`${input} flex-1 min-w-40`} />
      <Button onClick={save}>添加</Button>
    </div>
  );
}

/** Ending takes a reason, not a confirmation: a sensible default sits in the box, editable, and one click does it. */
function Close({ a, done }: { a: any; done: (reason: string) => void }) {
  const draft = a.state === "draft";
  const [reason, setReason] = useState(draft ? "不感兴趣" : "放弃");
  // before submitting it is only a change of mind (cancelled: the job can be watched and prepared again); after, a real application ends
  const go = () => { const r = reason.trim() || "其他"; call("application.update", { id: a.id, state: draft ? "cancelled" : "closed", closeReason: r }).then(() => done(r)); };
  return (
    <div className="flex gap-2 items-center pt-3 border-t border-line">
      <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="原因" className={`${input} w-48`} />
      <Button tone="danger" onClick={go}>{draft ? "不投了" : "结束这条申请"}</Button>
    </div>
  );
}

type Item = { key: string; p?: any; x?: any };
const TABS = ["关注中", "准备申请", "已投递", "已结束"] as const;
type Tab = (typeof TABS)[number];
const tabOf = (it: Item): Tab => (!it.x ? "关注中" : it.x.application.state === "draft" ? "准备申请" : it.x.application.state === "closed" ? "已结束" : "已投递");
const byDeadline = (a: any, b: any) => Number(a.closesAt == null) - Number(b.closesAt == null) || String(a.closesAt).localeCompare(String(b.closesAt));
const currentOf = (x: any) => { const a = x.application, last = x.stages[x.stages.length - 1]; return a.state === "closed" ? (a.closeReason || "已结束") : last ? last.kind + (last.result ? " · " + last.result : "") : "等消息"; };

/** Left side: one line per job, just enough to pick it. */
function Line({ it, selected, onPick, onPrepare, onUnwatch }: { it: Item; selected: boolean; onPick: () => void; onPrepare: () => void; onUnwatch: () => void }) {
  const info = it.x ?? it.p, a = it.x?.application;
  const next = it.x?.stages.find((s: any) => s.scheduledAt && !s.result && s.scheduledAt >= new Date().toISOString());
  return (
    <div onClick={onPick} className={`px-4 py-2.5 border-t first:border-t-0 border-line cursor-pointer hover:bg-ground ${selected ? "bg-accent-soft/40" : ""}`}>
      <div className="flex items-center gap-2">
        <span className="font-medium shrink-0">{info.companyName}</span><span className="text-ink-2 text-sm flex-1 truncate">{info.title}</span>
        {a && a.state !== "draft" ? <Chip tone={a.state === "closed" ? "" : "good"}>{currentOf(it.x)}</Chip> : <Deadline at={info.closesAt} r={info.deadline} />}
        {!a && <span className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}><Button onClick={onPrepare}>准备申请</Button><button className="text-ink-3 px-1" title="取消关注" onClick={onUnwatch}>×</button></span>}
      </div>
      {next && <div className="text-xs text-accent mt-1">{next.kind} · {minute(next.scheduledAt)}</div>}
    </div>
  );
}

/** Right side: everything about the selected job, and the one thing to do next. It stays put while the job moves between tabs. */
function Detail({ it, reload, onPrepare, onUnwatch, onDropped }: { it: Item; reload: () => void; onPrepare: () => void; onUnwatch: () => void; onDropped: (it: Item, reason: string) => void }) {
  const [events, setEvents] = useState<any[]>([]);
  const { x } = it, a = x?.application, info = x ?? it.p;
  const latest = useLatest();
  const timeline = () => (a ? latest("timeline", call("application.timeline", { id: a.id })).then((r) => setEvents(r.events)).catch(() => {}) : setEvents([]));
  useEffect(() => { timeline(); }, [a?.id, a?.state, x?.stages.length]);
  useOnDataChange(timeline);
  return (
    <Card className="p-5 space-y-3">
      <div><div className="text-lg font-bold">{info.title}</div><div className="text-sm text-ink-2">{info.companyName}</div></div>
      {a?.submittedAt && (
        <div className="flex gap-1.5 items-center flex-wrap text-xs text-ink-2">
          <Chip>投递 {day(a.submittedAt)}</Chip>
          {x.stages.map((s: any) => <span key={s.id} className="flex items-center gap-1.5"><span className="text-ink-3">→</span><Chip tone={s.result === "已取消" || s.result === "未通过" ? "" : s.result ? "good" : "accent"}>{s.kind}{s.scheduledAt ? ` ${minute(s.scheduledAt)}` : ""}{s.result ? ` · ${s.result}` : ""}</Chip></span>)}
          {a.externalAppId && <span className="text-ink-3">网申编号 {a.externalAppId}</span>}
          {a.resumeLabel && <span className="text-ink-3" title="上传时文件名改成「姓名简历」，招聘方看不到库里的名字">用的简历 {a.resumeLabel}</span>}
        </div>
      )}
      {!a && <div className="flex gap-2"><Button tone="primary" onClick={onPrepare}>准备申请</Button><Button onClick={onUnwatch}>取消关注</Button></div>}
      {a?.state === "draft" && (
        <>
          <ResumeChoice positionId={a.positionId} value={a.resumeLabel ?? ""} onChange={(v) => v !== (a.resumeLabel ?? "") && call("application.update", { id: a.id, resumeLabel: v }).then(reload)} />
          <RunPanel a={a} canStart={!!applyLink(info.applyUrl, info.noticeUrl)} onSubmitted={reload} />
          <MarkSubmitted id={a.id} done={reload} />
        </>
      )}
      <dl className="grid grid-cols-[3em_1fr] gap-y-1 text-sm">
        <Links applyUrl={info.applyUrl} noticeUrl={info.noticeUrl} />
        {it.x?.application.progressUrl && <><dt className="text-ink-3">进度</dt><dd><a className="text-accent" href={it.x.application.progressUrl} target="_blank" rel="noreferrer">去官网查进度</a></dd></>}
        {info.cities?.length > 0 && <><dt className="text-ink-3">城市</dt><dd>{info.cities.slice(0, 10).join("、")}</dd></>}
        {(info.deadline?.say || info.closesAt) && <><dt className="text-ink-3">截止</dt><dd>{info.deadline?.say ?? info.closesAt}</dd></>}
      </dl>
      {a?.submittedAt && <ResumeLabel a={a} done={reload} />}
      {(a?.state === "submitted" || a?.state === "in_process") && <AddProgress id={a.id} done={reload} />}
      {x?.stages.some((s: any) => s.notes) && <div className="text-xs text-ink-2">{x.stages.filter((s: any) => s.notes).map((s: any) => <div key={s.id}>{s.kind}：{s.notes}</div>)}</div>}
      <div><div className="text-xs text-ink-3 mb-1">岗位要求</div><PostDetails p={{ id: it.key }} always /></div>
      {events.length > 0 && <div>{events.map((e, i) => <div key={i} className="text-xs py-0.5 flex gap-2 text-ink-3"><span className="font-mono">{minute(e.at)}</span><span className="flex-1 text-ink-2">{readable(e)}</span><span>{e.source}</span></div>)}</div>}
      {a && a.state !== "closed" && <Close key={a.state} a={a} done={(reason) => (a.state === "draft" ? onDropped(it, reason) : reload())} />}
      {a?.state === "closed" && <button className="text-xs text-ink-3 underline decoration-dotted" onClick={() => call("application.update", { id: a.id, state: "in_process", note: "恢复" }).then(reload)}>点错了，恢复这条申请</button>}
    </Card>
  );
}

const LEVEL_TONE: Record<string, "good" | "accent" | "amber" | ""> = { 实测通过: "good", 仿真通过: "accent", 通用填写: "amber", 不支持: "" };

/** Which recruiting platforms 开始网申 can fill, and how many of the user's projects are on each. */
function Platforms() {
  const [items, setItems] = useState<any[]>([]);
  const [open, setOpen] = useState(false);
  const load = () => { call("apply.platforms").then((r) => setItems(r.items)).catch(() => {}); };
  useEffect(load, []);
  useOnDataChange(load);
  if (!items.length) return null;
  const filled = items.filter((p) => p.level !== "不支持");
  return (
    <Card className="px-4 py-3 mt-4 text-sm">
      <button className="flex items-center gap-2 w-full text-left" onClick={() => setOpen(!open)}>
        <span className="font-bold">自动填表支持的平台</span><span className="text-xs text-ink-3">{filled.length} 类</span><span className="ml-auto text-xs text-ink-3">{open ? "收起" : "展开"}</span>
      </button>
      <div className="mt-2 space-y-1.5">
        {(open ? items : items.filter((p) => p.level !== "不支持").slice(0, 4)).map((p) => (
          <div key={p.id} className="flex items-baseline gap-2" title={p.note}>
            <Chip tone={LEVEL_TONE[p.level] ?? ""}>{p.level}</Chip><span>{p.name}</span>
            {p.count > 0 && <span className="text-xs text-ink-3">{p.count} 个项目</span>}
            {open && <span className="text-xs text-ink-3 truncate ml-auto max-w-[55%]">{p.note}</span>}
          </div>
        ))}
      </div>
    </Card>
  );
}

const TAB_KEY = "jobos.pipeline.tab";

/** 投递: one tab per step, the list on the left, the selected job on the right. Acting on a job moves it to the next tab and the view follows it. */
export default function Pipeline({ go }: { go: (p: any) => void }) {
  const [apps, setApps] = useState<any[] | null>(null);
  const [watched, setWatched] = useState<any[] | null>(null);
  const [tab, setTabState] = useState<Tab | null>(() => (TABS as readonly string[]).includes(localStorage.getItem(TAB_KEY) ?? "") ? (localStorage.getItem(TAB_KEY) as Tab) : null);
  const [sel, setSel] = useState("");
  const [dropped, setDropped] = useState<{ it: Item; reason: string } | null>(null);
  const [err, setErr] = useState("");
  const follow = useRef(""); // the job whose move the view should follow after the next load
  const setTab = (t: Tab) => { setTabState(t); localStorage.setItem(TAB_KEY, t); };
  const latest = useLatest();
  const load = () => latest("lists", Promise.all([call("application.list"), call("position.list", { watchedOnly: true, limit: 500 })]))
    .then(([a, w]) => { setApps(a.items); setWatched(w.items); setErr(""); }).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  // changed elsewhere: the same tab, the same job selected with what was typed into it (a job that left this tab
  // hands the selection to the tab's first one, as before)
  useOnDataChange(load);

  const items: Item[] = !apps || !watched ? [] : [...apps.map((x) => ({ key: x.application.positionId as string, x })), ...watched.filter((p) => !p.applicationState).map((p) => ({ key: p.id as string, p }))];
  // a company's jobs sit together; companies are ordered by their earliest deadline, jobs within one by their own
  const rowsOf = (t: Tab) => {
    const rows = items.filter((it) => tabOf(it) === t).sort((a, b) => (t === "关注中" || t === "准备申请" ? byDeadline(a.x ?? a.p, b.x ?? b.p) : 0));
    const first = new Map<string, number>();
    rows.forEach((it, i) => { const c = (it.x ?? it.p).companyName; if (!first.has(c)) first.set(c, i); });
    return rows.sort((a, b) => first.get((a.x ?? a.p).companyName)! - first.get((b.x ?? b.p).companyName)!);
  };
  useEffect(() => {
    if (!apps || !watched) return;
    const moved = items.find((it) => it.key === follow.current);
    if (moved) { follow.current = ""; setTab(tabOf(moved)); setSel(moved.key); return; }
    // first visit: open where something is happening
    const t = tab ?? (["已投递", "准备申请", "关注中"] as Tab[]).find((x) => rowsOf(x).length) ?? "关注中";
    if (t !== tab) setTab(t);
    if (!rowsOf(t).some((it) => it.key === sel)) setSel(rowsOf(t)[0]?.key ?? "");
  }, [apps, watched, tab]);

  const act = (key: string, p: Promise<unknown>) => { follow.current = key; p.then(load).catch((e) => { follow.current = ""; setErr(e.message); }); };
  const prepare = (it: Item) => act(it.key, call("application.create", { positionId: it.key, channel: "官网" }));
  const unwatch = (it: Item) => call("position.watch", { positionId: it.key, priority: 0 }).then(load);
  const undoDrop = () => { if (!dropped) return; const key = dropped.it.key; setDropped(null); act(key, call("application.create", { positionId: key }).then(() => call("position.watch", { positionId: key, priority: 2 }))); };
  const rows = tab ? rowsOf(tab) : [];
  const picked = rows.find((it) => it.key === sel);
  const tabCls = (on: boolean) => `px-4 py-1.5 text-sm ${on ? "bg-accent-soft text-accent font-medium" : "bg-paper text-ink-2 hover:bg-ground"}`;

  return (
    <>
      <H1>投递</H1>
      {err && <div className="text-bad mb-3 text-sm">{err}</div>}
      <div className="flex border border-line rounded-md overflow-hidden w-fit mb-4">
        {TABS.map((t) => <button key={t} className={tabCls(t === tab)} onClick={() => setTab(t)}>{t}<span className="ml-1.5 text-xs tabular opacity-70">{rowsOf(t).length}</span></button>)}
      </div>
      {apps && watched && (rows.length === 0 ? <Empty>{tab === "关注中" ? <>还没有关注的岗位。去 <button className="text-accent" onClick={() => go("jobs")}>找岗位</button></> : "这里还没有"}</Empty> : (
        <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-5 items-start">
          <Card>{rows.map((it) => <Line key={it.key} it={it} selected={it.key === sel} onPick={() => setSel(it.key)} onPrepare={() => prepare(it)} onUnwatch={() => unwatch(it)} />)}</Card>
          <div className="sticky top-6 max-h-[calc(100vh-3rem)] overflow-y-auto">{picked && <Detail key={picked.key} it={picked} reload={() => act(picked.key, Promise.resolve())} onPrepare={() => prepare(picked)} onUnwatch={() => unwatch(picked)} onDropped={(it, reason) => { setDropped({ it, reason }); load(); }} />}<Platforms /></div>
        </div>
      ))}
      {dropped && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 bg-ink text-paper text-sm rounded-md px-4 py-2 shadow-lg flex items-center gap-3 z-20">
          已移出「{dropped.it.x?.companyName} · {dropped.it.x?.title}」<button className="underline" onClick={undoDrop}>撤销</button><button className="opacity-60" onClick={() => setDropped(null)}>×</button>
        </div>
      )}
    </>
  );
}
