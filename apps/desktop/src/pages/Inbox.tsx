import { useEffect, useState } from "react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Chip, Button, Empty } from "../ui";

const input = "px-3 py-1.5 border border-line rounded-md bg-paper text-sm min-w-0";
const TONE: Record<string, "good" | "accent" | "amber" | "bad" | ""> = { 面试: "good", offer: "good", 通过: "good", 笔试: "accent", 测评: "accent", 面试改期: "amber", 待办: "amber", 面试取消: "bad", 拒信: "bad" };
const when = (s: string | null) => (s ? s.slice(5, 16).replace("T", " ") : "");
const local = (iso: string) => { const d = new Date(iso); return `${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")} ${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`; };

/** Connect 163 / QQ with an IMAP 授权码. The code goes straight to the daemon and is never shown again. */
function Accounts({ onChanged }: { onChanged: () => void }) {
  const [info, setInfo] = useState<any>({ accounts: [], providers: [], lastPull: null });
  const [provider, setProvider] = useState("163");
  const [email, setEmail] = useState("");
  const [authCode, setAuthCode] = useState("");
  const [busy, setBusy] = useState("");
  const [msg, setMsg] = useState("");
  const load = () => call("inbox.accounts").then(setInfo).catch((e) => setMsg(e.message));
  useEffect(() => { load(); }, []);
  useOnDataChange(() => call("inbox.accounts").then(setInfo).catch(() => {}));
  const help = info.providers.find((p: any) => p.id === provider)?.help ?? "";

  const connect = async () => {
    setBusy("connect"); setMsg("正在试登录…");
    try { await call("inbox.connect", { provider, email, authCode }); setAuthCode(""); setEmail(""); setMsg("已连接"); load(); }
    catch (e: any) { setMsg(e.message); } finally { setBusy(""); }
  };
  const pull = async () => {
    setBusy("pull"); setMsg("收取中…");
    try {
      const r = await call("inbox.pull");
      setMsg(`看了 ${r.fetched} 封，招聘相关 ${r.recruiting} 封，新增 ${r.added}，待确认 ${r.proposals}${r.errors.length ? "。出错：" + r.errors.join("；") : ""}`);
      onChanged(); load();
    } catch (e: any) { setMsg(e.message); } finally { setBusy(""); }
  };
  const disconnect = async (id: string) => { if (confirm("断开这个邮箱？保存的授权码会删除，已入库的邮件记录保留。")) { await call("inbox.disconnect", { id }); load(); } };

  return (
    <Card className="p-4 mb-5">
      {info.accounts.map((a: any) => (
        <div key={a.id} className="flex items-center gap-2 text-sm mb-2">
          <Chip tone="good">已连接</Chip><span className="font-medium">{a.email}</span>
          <span className="text-xs text-ink-3">只读 · 每 30 分钟自动收取{info.lastPull?.last ? ` · 上次 ${local(info.lastPull.last)}` : ""}{info.lastPull?.errors?.length ? ` · 上次出错：${info.lastPull.errors[0]}` : ""}</span>
          <span className="ml-auto flex gap-2"><Button tone="primary" onClick={pull} disabled={!!busy}>{busy === "pull" ? "收取中…" : "立即收取"}</Button><Button onClick={() => disconnect(a.id)}>断开</Button></span>
        </div>
      ))}
      <details open={info.accounts.length === 0} className={info.accounts.length ? "mt-2 pt-2 border-t border-line" : ""}>
        <summary className="text-xs text-ink-3 cursor-pointer select-none">{info.accounts.length ? "再连接一个邮箱" : "连接邮箱"}</summary>
        <div className="grid grid-cols-[8rem_1fr_1fr_auto] gap-2 items-center mt-2">
          <select value={provider} onChange={(e) => setProvider(e.target.value)} className={input}>{info.providers.map((p: any) => <option key={p.id} value={p.id}>{p.label}</option>)}</select>
          <input value={email} onChange={(e) => setEmail(e.target.value)} placeholder="邮箱地址" className={input} autoComplete="off" />
          <input value={authCode} onChange={(e) => setAuthCode(e.target.value)} placeholder="授权码（不是登录密码）" type="password" className={input} autoComplete="new-password" />
          <Button tone="primary" onClick={connect} disabled={!!busy || !email || !authCode}>{busy === "connect" ? "连接中…" : "连接邮箱"}</Button>
        </div>
        <div className="text-xs text-ink-3 mt-2">授权码怎么拿：{help}。</div>
      </details>
      <div className="text-xs text-ink-3 mt-2">只读，授权码只存本机；非招聘邮件不读正文。</div>
      {msg && <div className="text-sm text-ink-2 mt-2">{msg}</div>}
    </Card>
  );
}

/**
 * The mail as it was sent. HTML is rendered inside a sandboxed frame with a content policy that allows no scripts and
 * no remote loads — so tracking pixels do not fire and nothing in the mail can run; links still open in the browser.
 */
function Original({ id, skipped }: { id?: string; skipped?: { account: string; messageId: string } }) {
  const [m, setM] = useState<any>(null);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"html" | "text">("html");
  useEffect(() => {
    setM(null); setErr("");
    (id ? call("inbox.get", { id }) : call("inbox.peek", skipped)).then((r) => { setM(r); setMode(r.html ? "html" : "text"); }).catch((e) => setErr(e.message));
  }, [id, skipped?.messageId]);
  if (err) return <div className="mt-2 text-xs text-bad">{err}</div>;
  if (!m) return <div className="mt-2 text-xs text-ink-3">{skipped ? "正在从邮箱取这封邮件…（只用于显示，不入库、不交给模型）" : "加载中…"}</div>;
  const doc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><base target="_blank"><style>body{font:14px/1.6 system-ui,sans-serif;color:#1c2026;margin:12px;word-break:break-word}img{max-width:100%}</style>${m.html}`;
  return (
    <div className="mt-3 border border-line rounded-md overflow-hidden">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-ground text-xs text-ink-3">
        <span>{skipped ? "原邮件（临时取回，仅供查看）" : "原邮件"}</span>
        {m.html && <><button className={mode === "html" ? "text-accent" : ""} onClick={() => setMode("html")}>原样显示</button><button className={mode === "text" ? "text-accent" : ""} onClick={() => setMode("text")}>纯文本</button></>}
        {m.emlPath && <span className="ml-auto font-mono truncate" title="原始邮件文件，可用邮件客户端打开">{m.emlPath}</span>}
      </div>
      {mode === "html" && m.html ? <iframe title="原邮件" sandbox="allow-popups allow-popups-to-escape-sandbox" srcDoc={doc} className="w-full h-96 bg-paper" />
        : <pre className="whitespace-pre-wrap text-xs p-3 max-h-96 overflow-auto font-sans bg-paper">{m.body}</pre>}
    </div>
  );
}

/** A notice from a company you applied to outside Zhiro: find the job in the pool, record the application, link the mail. */
function NewApplication({ m, done }: { m: any; done: () => void }) {
  const [q, setQ] = useState(m.company ?? "");
  const [companies, setCompanies] = useState<any[]>([]);
  const [positions, setPositions] = useState<any[] | null>(null);
  const [err, setErr] = useState("");
  useEffect(() => {
    if (!q.trim()) { setCompanies([]); return; }
    const t = setTimeout(() => call("company.search", { query: q, limit: 6 }).then((r) => setCompanies(r.items)).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [q]);
  const pick = (c: any) => call("pool.list", { companyId: c.companyId, limit: 1 }).then((r) => setPositions(r.items[0]?.positions ?? []));
  const create = async (p: any) => {
    try {
      const id = p.applicationState ? (await call("application.list")).items.find((a: any) => a.application.positionId === p.id)?.application.id : (await call("application.create", { positionId: p.id, channel: "官网", note: "由收件箱里的通知补建" })).application.id;
      if (!p.applicationState) await call("application.update", { id, state: "submitted", note: "投递发生在 Zhiro 之外" });
      await call("inbox.link", { id: m.id, applicationId: id }); done();
    } catch (e: any) { setErr(e.message); }
  };
  return (
    <div className="mt-2 border border-line rounded-md p-2.5 bg-ground/60">
      <div className="text-xs text-ink-3 mb-1.5">还没记过这家的申请？先找到它，选你投的岗位，系统补一条「已投递」的申请并把这封通知挂上去。</div>
      <input value={q} onChange={(e) => { setQ(e.target.value); setPositions(null); }} placeholder="公司名" className={`${input} w-72`} />
      {!positions && companies.map((c) => <button key={c.companyId} onClick={() => pick(c)} className="block w-full text-left px-2 py-1 text-sm hover:bg-paper rounded">{c.companyName} <span className="text-xs text-ink-3">{c.positions} 个岗位</span></button>)}
      {!positions && q.trim() && companies.length === 0 && <div className="text-xs text-ink-3 mt-1">库里没有这家。先去「找岗位」搜它，再回来关联。</div>}
      {positions && <div className="max-h-48 overflow-auto mt-1">{positions.map((p) => <button key={p.id} onClick={() => create(p)} className="block w-full text-left px-2 py-1 text-sm hover:bg-paper rounded">{p.title}{p.applicationState && <span className="text-xs text-ink-3"> · 已有申请</span>}</button>)}</div>}
      {err && <div className="text-xs text-bad mt-1">{err}</div>}
    </div>
  );
}

export default function Inbox() {
  const [items, setItems] = useState<any[]>([]);
  const [skipped, setSkipped] = useState<any[]>([]);
  const [pending, setPending] = useState<Map<string, any>>(new Map());
  const [apps, setApps] = useState<any[]>([]);
  const [showOther, setShowOther] = useState(false);
  const [open, setOpen] = useState("");
  const [creating, setCreating] = useState("");
  const [paste, setPaste] = useState("");
  const [busy, setBusy] = useState("");
  const [err, setErr] = useState("");

  const latest = useLatest();
  const load = () => {
    latest("list", call("inbox.list", { includeOther: showOther })).then((r) => setItems(r.items)).catch((e) => setErr(e.message));
    latest("skipped", call("inbox.skipped", { limit: 60 })).then((r) => setSkipped(r.items)).catch(() => {});
    latest("pending", call("proposal.list", {})).then((r) => setPending(new Map(r.items.map((p: any) => [p.id, p])))).catch(() => {});
    latest("apps", call("application.list")).then((r) => setApps(r.items)).catch(() => {});
  };
  useEffect(() => { load(); }, [showOther]);
  useOnDataChange(load); // the open mail, the half-pasted text and the 补建 search stay as they are

  const appLabel = (id: string | null) => { const a = apps.find((x) => x.application.id === id); return a ? `${a.companyName} · ${a.title}` : "这条申请"; };
  /** What confirming would do, in the user's words — read from the proposal itself, so it is exactly what will run. */
  const describe = (m: any) => {
    const p = pending.get(m.proposalId); const x = p?.payload ?? {}; const app = `「${appLabel(m.applicationId)}」`;
    if (p?.kind === "stage.add") return `给${app}记一条进展：${x.kind}${x.scheduledAt ? " · " + when(x.scheduledAt) : " · 时间未定"}`;
    if (p?.kind === "stage.update") return x.result ? `把${app}的这个环节标为「${x.result}」` : `把${app}的环节改到 ${when(x.scheduledAt)}`;
    if (x.state === "closed") return `把${app}标为已结束（${x.closeReason}）`;
    if (x.state === "submitted") return `把${app}标为已投递`;
    if (x.nextAction) return `给${app}记一条待办：${x.nextAction}${x.nextActionAt ? "（" + when(x.nextActionAt) + " 前）" : ""}`;
    return "更新这条申请";
  };
  const FRIENDLY: Record<string, string> = { INVALID_TRANSITION: "这条申请的状态已经变了（比如已结束），这个改动不再适用，可以点「不对，忽略」。", EXPIRED: "这条待确认已过期。", ALREADY_DECIDED: "已经处理过了。", HASH_MISMATCH: "内容已变化，请刷新后再看。" };
  const decide = async (m: any, decision: "approved" | "rejected") => {
    const p = pending.get(m.proposalId); if (!p) return;
    try { await call("proposal.decide", { id: p.id, decision, payloadHash: p.payloadHash }); setErr(""); } catch (e: any) { setErr(FRIENDLY[e.code] ?? e.message); }
    load();
  };
  const analyse = async () => {
    setBusy("paste"); setErr("");
    try { const r = await call("inbox.paste", { text: paste }); setPaste(""); if (!r.added) setErr("这段内容之前已经处理过了，没有重复记。"); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); }
  };
  const rescue = async (s: any) => { setBusy(s.messageId); try { await call("inbox.rescue", { account: s.account, messageId: s.messageId }); load(); } catch (e: any) { setErr(e.message); } finally { setBusy(""); } };

  const waiting = items.filter((m) => m.proposalId && pending.has(m.proposalId)).length;
  const unplaced = items.filter((m) => m.category !== "其他" && !m.applicationId).length;

  return (
    <>
      <H1 sub="招聘邮件自动分类、对上申请；你确认后才写入">收件箱</H1>
      <Accounts onChanged={load} />
      <Card className="p-4 mb-5">
        <textarea value={paste} onChange={(e) => setPaste(e.target.value)} placeholder="粘贴短信 / 微信 / 其他邮箱里的通知" rows={3} className={`${input} w-full`} />
        <div className="mt-2"><Button onClick={analyse} disabled={!!busy || paste.trim().length < 10}>{busy === "paste" ? "分析中…" : "分析"}</Button></div>
      </Card>
      {err && <div className="text-sm bg-bad-soft text-bad rounded-md px-3 py-2 mb-3">{err}</div>}
      <div className="flex items-center mb-2 gap-3"><div className="text-sm font-bold">消息 · {items.length}</div>
        {waiting > 0 && <Chip tone="amber">{waiting} 条等你确认</Chip>}{unplaced > 0 && <Chip tone="amber">{unplaced} 条没对上申请</Chip>}
        <label className="ml-auto text-xs text-ink-3 flex items-center gap-1.5"><input type="checkbox" checked={showOther} onChange={(e) => setShowOther(e.target.checked)} />显示「其他」</label></div>
      {items.length === 0 ? <Empty>还没有消息</Empty> : (
        <Card>
          {items.map((m) => {
            const isPending = m.proposalId && pending.has(m.proposalId);
            return (
              <div key={m.id} className="px-4 py-3 border-t first:border-t-0 border-line text-sm">
                <div className="flex items-baseline gap-2 cursor-pointer" title="点击查看原邮件" onClick={() => setOpen(open === m.id ? "" : m.id)}>
                  <Chip tone={TONE[m.category] ?? ""}>{m.category === "面试" && m.round ? m.round : m.category}</Chip>
                  {m.folder && <span title="这封是在垃圾邮件文件夹里找到的，建议把发件人加入白名单"><Chip tone="amber">来自{m.folder}</Chip></span>}
                  <span className="font-medium">{m.company || m.from}</span><span className="text-ink-2 truncate flex-1">{m.position ? m.position + " · " : ""}{m.subject}</span>
                  <span className="text-xs text-ink-3 font-mono shrink-0">{local(m.receivedAt)}</span>
                  <span className="text-xs text-ink-3 shrink-0">{open === m.id ? "▾" : "▸"}</span>
                </div>
                {m.summary && <div className="text-ink-2 mt-1">{m.summary}{m.scheduledAt && <span className="ml-2 font-mono text-xs text-accent">{when(m.scheduledAt)}</span>}{m.link && <a className="ml-2 text-accent text-xs" href={m.link} target="_blank" rel="noreferrer">打开链接</a>}</div>}
                {m.category !== "其他" && (
                  <div className="mt-2 flex items-center gap-2 flex-wrap">
                    {isPending ? (<><span className="text-xs bg-amber-soft text-amber rounded px-2 py-1">待你确认：{describe(m)}</span><Button tone="primary" onClick={() => decide(m, "approved")}>确认</Button><Button onClick={() => decide(m, "rejected")}>不对，忽略</Button></>)
                      : m.proposalId ? <span className="text-xs text-ink-3">已处理 · {appLabel(m.applicationId)}</span>
                      : m.applicationId ? <span className="text-xs text-ink-3">{appLabel(m.applicationId)} · {m.note || "这类消息不需要改动申请"}</span>
                      : (<><span className="text-xs text-ink-3">没能确定是哪条申请{apps.length > 1 ? "（同一家公司你可能投了不止一个岗位，或邮件没写岗位）" : ""}：</span>
                          <select className={input} defaultValue="" onChange={(e) => e.target.value && call("inbox.link", { id: m.id, applicationId: e.target.value }).then(load)}>
                            <option value="">选择已有申请…</option>{apps.filter((a) => a.application.state !== "closed").map((a) => <option key={a.application.id} value={a.application.id}>{a.companyName} · {a.title}</option>)}
                          </select>
                          <button className="text-xs text-accent" onClick={() => setCreating(creating === m.id ? "" : m.id)}>这家还没记过申请</button></>)}
                  </div>
                )}
                {creating === m.id && <NewApplication m={m} done={() => { setCreating(""); load(); }} />}
                {open === m.id && <Original id={m.id} />}
              </div>
            );
          })}
        </Card>
      )}
      {skipped.length > 0 && (
        <details className="mt-5">
          <summary className="text-sm text-ink-2 cursor-pointer select-none">没当作招聘通知的邮件 · {skipped.length}</summary>
          <Card className="mt-2">
            {skipped.map((s) => (
              <div key={s.account + s.messageId} className="px-4 py-2 border-t first:border-t-0 border-line text-sm">
                <div className="flex items-center gap-2 cursor-pointer" title="点击查看这封邮件" onClick={() => setOpen(open === s.messageId ? "" : s.messageId)}>
                  <span className="text-xs text-ink-3 font-mono shrink-0">{local(s.receivedAt)}</span>
                  <span className="text-ink-2 shrink-0 max-w-[14rem] truncate">{s.from}</span><span className="flex-1 truncate">{s.subject || "（无主题）"}</span>
                  {s.folder && <Chip tone="amber">{s.folder}</Chip>}
                  <span onClick={(e) => e.stopPropagation()}><Button onClick={() => rescue(s)} disabled={!!busy}>{busy === s.messageId ? "处理中…" : "这封是招聘通知"}</Button></span>
                  <span className="text-xs text-ink-3 shrink-0">{open === s.messageId ? "▾" : "▸"}</span>
                </div>
                {open === s.messageId && <Original skipped={{ account: s.account, messageId: s.messageId }} />}
              </div>
            ))}
          </Card>
        </details>
      )}
    </>
  );
}
