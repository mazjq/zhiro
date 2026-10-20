import { useEffect, useState } from "react";
import { CalendarClock, Briefcase, GraduationCap, MessageSquare, Settings as SettingsIcon, Send, Mail, FileText } from "lucide-react";
import { initApi, events, CLIENT_ID, keyFile, loginWithKey } from "./api";
import Today from "./pages/Today";
import Chat from "./pages/Chat";
import Settings from "./pages/Settings";
import Jobs from "./pages/Jobs";
import Internships from "./pages/Internships";
import Gaps from "./pages/Gaps";
import Research from "./pages/Research";
import Compare from "./pages/Compare";
import Pipeline from "./pages/Pipeline";
import Profile from "./pages/Profile";
import InboxPage from "./pages/Inbox";
import Resumes from "./pages/Resumes";
import ImportPanel from "./pages/ImportPanel";
import { call } from "./api";
import { dataChanged } from "./refresh";
import { Card, Button } from "./ui";

const SKIP_KEY = "jobos.onboarding.skipped";

/** Shown once, while the profile is completely empty. Both choices are optional; skipping is remembered. */
function FirstRun({ onClose }: { onClose: (goProfile: boolean) => void }) {
  const [imported, setImported] = useState(false);
  const skip = () => { localStorage.setItem(SKIP_KEY, "1"); onClose(false); };
  return (
    <div className="fixed inset-0 z-30 bg-black/30 flex items-center justify-center">
      <Card className="p-6 w-[44rem] shadow-xl">
        <div className="text-lg font-bold">先建一份你的画像</div>
        <div className="text-sm text-ink-2 mt-1 mb-4">选一份简历，和/或一个放着论文、专利、开题报告、奖状的文件夹。系统从里面抽出带来源的事实卡，推荐、选简历、网申填写都用它。两样都可以跳过。</div>
        <ImportPanel compact onChanged={() => setImported(true)} />
        <div className="flex items-center gap-2 mt-4">
          <span className="text-xs text-ink-3 flex-1">{imported ? "已开始抽取，可以去「画像」页看进度并逐张确认。" : "简历和材料都不选的话，无法自动建档；之后可以在「画像」页手填，或随时回来导入。"}</span>
          {imported ? <Button tone="primary" onClick={() => onClose(true)}>去画像页</Button> : <Button onClick={skip}>跳过</Button>}
        </div>
      </Card>
    </div>
  );
}

/** A browser without a session (ADR-045): paste the key once; it becomes a cookie and is kept nowhere in the page. */
function KeyBox({ onDone }: { onDone: () => void }) {
  const [file, setFile] = useState("");
  const [key, setKey] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => { keyFile().then(setFile); }, []);
  const go = async () => {
    if (!key.trim()) return;
    setBusy(true); setMsg("");
    try { await loginWithKey(key); onDone(); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="p-8 max-w-xl">
      <div className="text-lg font-bold mb-2">打开 Zhiro</div>
      <div className="text-sm text-ink-2 mb-3">这个浏览器还没登录。用记事本打开下面这个文件，把里面那一行复制进来，点进入；以后这个浏览器就不用再输了。</div>
      {file && <div className="text-xs font-mono break-all mb-3 px-3 py-2 bg-ground rounded-md">{file}</div>}
      <div className="flex gap-2">
        <input value={key} onChange={(e) => setKey(e.target.value)} onKeyDown={(e) => e.key === "Enter" && go()} placeholder="粘贴钥匙" className="flex-1 min-w-0 px-3 py-2 border border-line rounded-md bg-paper font-mono text-sm" autoFocus />
        <Button tone="primary" onClick={go} disabled={busy || !key.trim()}>进入</Button>
      </div>
      {msg && <div className="mt-2 text-sm text-bad">{msg}</div>}
      <div className="mt-4 text-xs text-ink-3">另外两种进法：桌面版（托盘）不用钥匙；daemon 启动时终端里打印的那条「open the UI」链接点一次也行。</div>
    </div>
  );
}

// "profile" and "resumes" are the two tabs of 求职资料; settings sits behind the gear, the assistant in a drawer
type Page = "today" | "jobs" | "interns" | "gaps" | "research" | "compare" | "pipeline" | "inbox" | "profile" | "resumes" | "settings";

const NAV: { id: Page; label: string; icon: React.ComponentType<{ size?: number }> }[] = [
  { id: "today", label: "今日", icon: CalendarClock },
  { id: "jobs", label: "找岗位", icon: Briefcase },
  { id: "interns", label: "找实习", icon: GraduationCap },
  { id: "pipeline", label: "投递", icon: Send },
  { id: "inbox", label: "收件箱", icon: Mail },
  { id: "profile", label: "求职资料", icon: FileText },
];

export default function App() {
  const [page, setPage] = useState<Page>("today");
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState("");
  const [firstRun, setFirstRun] = useState(false);
  const [chatOpen, setChatOpen] = useState(false);

  const [needLogin, setNeedLogin] = useState(false);
  const connect = () => initApi().then(() => setReady(true)).catch((e) => { if (e?.code === "NEED_LOGIN") setNeedLogin(true); else setErr(String(e?.message ?? e)); });
  useEffect(() => { void connect(); }, []);
  useEffect(() => {
    const go = (e: Event) => setPage((e as CustomEvent).detail as Page);
    window.addEventListener("jobos:go", go);
    return () => window.removeEventListener("jobos:go", go);
  }, []);
  useEffect(() => {
    if (!ready || localStorage.getItem(SKIP_KEY)) return;
    Promise.all([call("fact.list"), call("document.list")]).then(([f, d]) => setFirstRun(f.items.length === 0 && d.items.length === 0)).catch(() => {});
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    // changes made elsewhere (the other window, an agent) — not our own — make the page on screen fetch again, in place:
    // it keeps its scroll position, what is open and what is typed (refresh.ts)
    const off = events((type, data) => {
      // `data`: changed in the background (a scheduled pull, the matcher, a finished report), sent once it shows. `scan`: a
      // pull started — only 「更新情况」 follows that
      if (type === "hello" || type === "scan" || data?.client === CLIENT_ID) return;
      // an agent turn streams dozens of events; only a finished write can have changed what a page shows
      if (type === "agent" && !(data?.type === "tool_execution_end" && data?.write)) return;
      dataChanged();
    });
    // writes made from the chat drawer (确认卡, 撤销) come back as our own client's events, so the drawer asks explicitly
    window.addEventListener("jobos:refresh", dataChanged);
    return () => { off(); window.removeEventListener("jobos:refresh", dataChanged); };
  }, [ready]);

  if (needLogin) return <KeyBox onDone={() => { setNeedLogin(false); void connect(); }} />;
  if (err) return <div className="p-8 text-bad">{err}</div>;
  if (!ready) return <div className="p-8 text-ink-3">连接 daemon…</div>;

  return (
    <div className="flex h-full">
      <aside className="w-52 shrink-0 border-r border-line bg-paper flex flex-col">
        <div className="px-5 pt-5 pb-4">
          <div className="text-lg font-bold tracking-tight">Zhiro · 职路</div>
          <div className="text-xs text-ink-3">AI 职业调研与求职</div>
        </div>
        <nav className="px-2 flex-1">
          {NAV.map(({ id, label, icon: Icon }) => (
            <button key={id} onClick={() => setPage(id)}
              className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-md text-left mb-0.5 ${page === id || (id === "profile" && page === "resumes") || (id === "jobs" && (page === "gaps" || page === "research" || page === "compare")) ? "bg-accent-soft text-accent font-medium" : "text-ink-2 hover:bg-ground"}`}>
              <Icon size={16} />{label}
            </button>
          ))}
        </nav>
        <div className="px-2 py-3 flex gap-1 border-t border-line">
          <button onClick={() => setChatOpen(!chatOpen)} className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-md text-left ${chatOpen ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-ground"}`}><MessageSquare size={16} />助手</button>
          <button onClick={() => setPage("settings")} title="配置" className={`px-3 py-2 rounded-md ${page === "settings" ? "bg-accent-soft text-accent" : "text-ink-2 hover:bg-ground"}`}><SettingsIcon size={16} /></button>
        </div>
      </aside>
      {firstRun && <FirstRun onClose={(goProfile) => { setFirstRun(false); if (goProfile) setPage("profile"); }} />}
      <main className="flex-1 min-w-0 overflow-auto">
        <div className="max-w-6xl mx-auto px-8 py-7">
          {page === "today" && <Today go={setPage} />}
          {(page === "jobs" || page === "gaps" || page === "research" || page === "compare") && (
            <div className="flex border border-line rounded-md overflow-hidden w-fit mb-4">
              {([["jobs", "找岗位"], ["gaps", "机会缺口"], ["research", "调研"], ["compare", "比较单位"]] as const).map(([id, label]) => <button key={id} onClick={() => setPage(id)} className={`px-4 py-1.5 text-sm ${page === id ? "bg-accent-soft text-accent" : "bg-paper text-ink-2"}`}>{label}</button>)}
            </div>
          )}
          {page === "jobs" && <Jobs go={setPage} />}
          {page === "interns" && <Internships />}
          {page === "gaps" && <Gaps />}
          {page === "research" && <Research />}
          {page === "compare" && <Compare />}
          {page === "pipeline" && <Pipeline go={setPage} />}
          {page === "inbox" && <InboxPage />}
          {(page === "profile" || page === "resumes") && (
            <div className="flex border border-line rounded-md overflow-hidden w-fit mb-4">
              {([["profile", "画像"], ["resumes", "简历"]] as const).map(([id, label]) => <button key={id} onClick={() => setPage(id)} className={`px-4 py-1.5 text-sm ${page === id ? "bg-accent-soft text-accent" : "bg-paper text-ink-2"}`}>{label}</button>)}
            </div>
          )}
          {page === "resumes" && <Resumes />}
          {page === "profile" && <Profile />}
          {page === "settings" && <Settings />}
        </div>
      </main>
      <aside className={`w-[26rem] shrink-0 border-l border-line bg-paper ${chatOpen ? "" : "hidden"}`}><Chat onClose={() => setChatOpen(false)} /></aside>
    </div>
  );
}
