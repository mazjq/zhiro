import { useEffect, useRef, useState } from "react";
import { chat, call, events, chatHistory, chatReset, chatCancel, type Turn } from "../api";
import { Button } from "../ui";
import { describeProposal, FRIENDLY } from "../describe";

type Step = { line: string; detail?: string };
type Entry = { role: "user" | "agent"; text: string; actions?: any[]; proposals?: any[]; steps?: Step[]; backend?: string };

/** Tool names in the user's words for the step log. */
const DOING: Record<string, string> = {
  "pool.list": "查岗位库", "position.list": "查岗位", "campaign.list": "查招聘项目", "campaign.get": "看项目详情", "company.search": "找公司", "pool.facets": "看筛选项",
  "position.watch": "关注岗位", "application.create": "准备申请", "application.update": "更新申请", "application.list": "查申请", "application.timeline": "看申请时间线",
  "stage.add": "记进展", "stage.update": "更新环节", "fact.list": "看资料", "fact.upsert": "改资料", "profile.gaps": "查资料缺口", "recommend.tag": "打标签", "recommend.suggest": "想搜索词",
  "preset.list": "看搜索模式", "preset.save": "存搜索模式", "resume.list": "看简历库", "resume.pick": "选简历", "resume.analyze": "分析简历", "inbox.list": "看收件箱", "inbox.get": "读邮件",
  "today.summary": "看今日", "proposal.list": "看待确认", "usage.summary": "看用量", "history.list": "看操作记录",
};
const refreshPages = () => window.dispatchEvent(new CustomEvent("jobos:refresh"));

/** The assistant's steps: the last two while it works, all of them on demand; each step opens to its full arguments and result. */
function Steps({ steps, live }: { steps: Step[]; live: boolean }) {
  const [all, setAll] = useState(false);
  const [open, setOpen] = useState<number | null>(null);
  if (!steps.length) return null;
  const from = all ? 0 : Math.max(0, steps.length - 2);
  return (
    <div className="mt-1 px-3 py-1.5 text-xs text-ink-3 font-mono">
      {steps.length > 2 && <button type="button" className="text-accent mb-0.5" onClick={() => setAll(!all)}>{all ? "只看最近两步" : `全部 ${steps.length} 步`}</button>}
      {steps.slice(from).map((s, j) => { const i = from + j; return (
        <div key={i}>
          <div className={`cursor-pointer ${open === i ? "whitespace-pre-wrap break-all" : "truncate"}`} onClick={() => setOpen(open === i ? null : i)} title={open === i ? "收起" : s.detail ? "点开看详情" : ""}>{s.line}</div>
          {open === i && s.detail && <div className="whitespace-pre-wrap break-all text-ink-2 pl-3 border-l border-line my-0.5">{s.detail}</div>}
        </div>
      ); })}
      {live && <div className="animate-pulse">…</div>}
    </div>
  );
}

/** One event of the running turn → a line for the log (empty = nothing to show). */
function stepOf(data: any): Step | null {
  const name = DOING[data?.tool] ?? data?.tool ?? "";
  if (data?.type === "tool_execution_start") return { line: `${name} ${data.args ?? ""}`, detail: `参数：${data.args ?? ""}` };
  if (data?.type === "tool_execution_end") return { line: `${data.ok === false ? "✗" : "→"} ${name}：${data.result ?? ""}`, detail: data.result };
  if (data?.type === "message_end" && (data.thinking || data.text)) return { line: data.text ? data.text : `思考：${data.thinking}`, detail: [data.thinking && `思考：${data.thinking}`, data.text].filter(Boolean).join("\n") };
  return null;
}

/**
 * The assistant lives in a drawer over whatever page is open; it stays mounted so the conversation survives closing it.
 * ADR-025: what the assistant did at once shows under its reply with 撤销; what needs the user shows as a confirm card
 * (the same proposal the 今日 page lists), decided right here. Pages behind the drawer refresh after each of those.
 */
export default function Chat({ onClose }: { onClose: () => void }) {
  const [log, setLog] = useState<Entry[]>([]);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [steps, setSteps] = useState<Step[]>([]); // the running turn's steps
  const stepsRef = useRef<Step[]>([]);
  const [done, setDone] = useState<Record<string, string>>({}); // proposal / action id → what happened to it
  const settle = (id: string, what: string) => setDone((d) => ({ ...d, [id]: what }));
  const [backend, setBackend] = useState("");
  const turnRef = useRef(""); // the turn this window is waiting on; events of other turns (another window's) are not ours
  useEffect(() => { chatHistory().then((h) => { setBackend(h.backend); if (h.items.length) setLog(h.items); }).catch(() => {}); }, []); // the transcript lives in the daemon, so a reload shows it again
  useEffect(() => events((type, data) => {
    if (type !== "agent" || (data?.turnId && data.turnId !== turnRef.current)) return;
    const s = stepOf(data);
    if (!s) return;
    stepsRef.current = [...stepsRef.current, s];
    setSteps(stepsRef.current);
  }), []);
  const fresh = async () => { if (busy) return; await chatReset().catch(() => {}); setLog([]); setDone({}); };
  const stop = () => chatCancel().catch(() => {});
  const send = async () => {
    const t = text.trim();
    if (!t || busy) return;
    setText("");
    setLog((l) => [...l, { role: "user", text: t }]);
    setBusy(true); stepsRef.current = []; setSteps([]);
    turnRef.current = Math.random().toString(36).slice(2) + Date.now().toString(36);
    try {
      const r: Turn = await chat(t, turnRef.current);
      if (r.backend) setBackend(r.backend);
      // the last message_end is the reply itself, shown below in full
      const kept = stepsRef.current.filter((s, i, a) => !(i === a.length - 1 && s.line === (r.answer || "").replace(/\s+/g, " ").trim().slice(0, 200)));
      const tail = [r.note, r.cost?.usd != null ? `约 $${r.cost.usd.toFixed(2)}（估算）` : ""].filter(Boolean).join(" · ");
      setLog((l) => [...l, { role: "agent", text: (r.answer || "（无回复）") + (tail ? `\n\n${tail}` : ""), actions: r.actions, proposals: r.proposals, steps: kept }]);
      if (r.actions.length) refreshPages();
    } catch (e: any) { setLog((l) => [...l, { role: "agent", text: e.code === "BUSY" ? "上一条还在回答，等它答完或先停止。" : `错误：${e.message}`, steps: stepsRef.current }]); }
    finally { setBusy(false); stepsRef.current = []; setSteps([]); turnRef.current = ""; }
  };
  const WHO: Record<string, string> = { builtin: "内置助手", claude: "Claude Code", codex: "Codex" };
  const decide = async (p: any, decision: "approved" | "rejected") => {
    try { await call("proposal.decide", { id: p.id, decision, payloadHash: p.payloadHash }); settle(p.id, decision === "approved" ? "已确认" : "已忽略"); refreshPages(); }
    catch (e: any) { settle(p.id, FRIENDLY[e.code] ?? e.message); }
  };
  const undo = async (a: any) => {
    try { await call("history.undo", { id: a.id }); settle(a.id, "已撤销"); refreshPages(); }
    catch (e: any) { settle(a.id, FRIENDLY[e.code] ?? e.message); }
  };
  return (
    <div className="h-full flex flex-col p-4">
      <div className="flex items-center mb-3 gap-2"><span className="font-bold">助手</span>{backend && <span className="text-xs text-ink-3" title="在 配置 → 助手 里换">· {WHO[backend] ?? backend}</span>}{log.length > 0 && <button className="ml-auto text-xs text-ink-3 hover:text-accent" onClick={fresh} title="忘掉这段对话，重新开始">新对话</button>}<button className={`${log.length ? "" : "ml-auto"} text-ink-3 px-1`} onClick={onClose}>×</button></div>
      <div className="flex-1 space-y-3 overflow-auto">
        {log.length === 0 && <div className="text-ink-3 text-sm">试试：「今天有什么截止的」「帮我关注武汉的控制算法岗」</div>}
        {log.map((m, i) => (
          <div key={i} className={`max-w-[85%] ${m.role === "user" ? "ml-auto" : ""}`}>
            {m.role === "agent" && <Steps steps={m.steps ?? []} live={false} />}
            {m.role === "agent" && m.backend && m.backend !== backend && <div className="text-xs text-ink-3 mb-0.5">{WHO[m.backend] ?? m.backend} 答</div>}
            <div className={`px-3 py-2 rounded-lg text-sm whitespace-pre-wrap ${m.role === "user" ? "bg-accent text-white" : "bg-ground"}`}>{m.text}</div>
            {m.actions?.map((a) => (
              <div key={a.id} className="mt-1 px-3 py-1.5 text-xs text-ink-2 flex items-center gap-2" title={JSON.stringify(a.input, null, 1)}>
                <span className="flex-1">✓ {a.summary}</span>
                {done[a.id] ? <span className="text-ink-3">{done[a.id]}</span> : a.undoable && <button className="text-accent" onClick={() => undo(a)}>撤销</button>}
              </div>
            ))}
            {m.proposals?.map((p) => (
              <div key={p.id} className="mt-1 px-3 py-2 border border-line rounded-md text-sm flex items-center gap-2 bg-paper" title={JSON.stringify(p.payload, null, 1)}>
                <div className="flex-1 min-w-0"><div>{describeProposal(p)}</div>{p.reason && <div className="text-xs text-ink-3 truncate">{p.reason}</div>}</div>
                {done[p.id] ? <span className="text-xs text-ink-3">{done[p.id]}</span> : <><Button tone="primary" onClick={() => decide(p, "approved")}>确认</Button><Button onClick={() => decide(p, "rejected")}>忽略</Button></>}
              </div>
            ))}
          </div>
        ))}
        {busy && (steps.length ? <Steps steps={steps} live /> : <div className="text-ink-3 text-sm">思考中…</div>)}
      </div>
      <div className="flex gap-2 mt-3">
        <input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && send()} placeholder="问它" className="flex-1 min-w-0 px-3 py-2 border border-line rounded-md bg-paper" />
        {busy ? <Button onClick={stop} title="停掉这一条">停止</Button> : <Button tone="primary" onClick={send} disabled={busy}>发送</Button>}
      </div>
    </div>
  );
}
