import { useEffect, useRef, useState } from "react";
import { call, bookmarkletUrl, events } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Button, Chip } from "../ui";
import ModelService from "./ModelService";

const k = (n: number) => (n >= 10_000 ? `${(n / 10_000).toFixed(1)} 万` : n.toLocaleString());

/** What the background tidying is (said on the page because the person asked). */
const BACKGROUND_WORK = [
  "收件箱分类：判断邮件是笔试、面试、offer、拒信还是别的，抽出公司和时间",
  "招聘简章抽取：从存下或读到的招聘页里抽公司、岗位、截止、投递链接；「待补资料」自动补截止日期也是它",
  "求职材料抽取：从简历、论文、证书里抽事实卡；简历分析",
  "网申读表与认字段：判断网申表格每一栏该填画像里的哪一项",
  "岗位深度匹配：一个岗位和你的画像对一遍，给出符合与差距",
];

/**
 * AI 用哪家 (ADR-057): one harness does the AI work, with the model chosen inside it. The built-in model is kept for
 * those who want it, and as an optional home for the background tidying. Work an agent starts from outside (through
 * MCP) is done by that agent itself — said here because it is not a setting.
 */
function AiCard({ cfg, reload, onError }: { cfg: any; reload: () => void; onError: (m: string) => void }) {
  const tauri = !!window.__TAURI_INTERNALS__;
  const backend = cfg?.chat?.backend ?? "builtin";
  const useModel = cfg?.background?.useModel ?? true;
  const followed = backend === "claude" ? cfg?.chat?.models?.claude : backend === "codex" ? cfg?.chat?.models?.codex : "";
  const refused = backend === "claude" || backend === "codex" ? cfg?.chat?.models?.refused?.[backend] : undefined;
  const pick = async (b: string) => { try { await call("agent.backend", { backend: b }); reload(); } catch (e: any) { onError(e.message); } };
  const setBackground = async (v: boolean) => { try { await call("agent.background", { useModel: v }); reload(); } catch (e: any) { onError(e.message); } };
  const open = async (path: string) => (await import("@tauri-apps/api/core")).invoke("open_dir", { path }).catch(() => {});
  return (
    <>
      <Card className="p-5 mb-4">
        <div className="flex items-center gap-3">
          <div className="font-bold">AI 用哪家</div>
          <span className="text-xs text-ink-3">选一个，Zhiro 里要 AI 的事都交给它</span>
          <div className="ml-auto flex gap-2">
            {([["claude", "Claude Code"], ["codex", "Codex"], ["dsh", "DeepSeek（dsh）"], ["builtin", "内置助手"]] as const).map(([b, label]) => {
              const st = cfg?.chat?.backends?.[b];
              return <Button key={b} tone={backend === b ? "primary" : ""} disabled={st && !st.available} title={st?.detail ?? ""} onClick={() => pick(b)}>{label}{st && !st.available ? "（没装）" : ""}</Button>;
            })}
          </div>
        </div>
        <div className="text-sm text-ink-2 mt-2">
          {backend === "builtin" ? "模型在下面「内置模型」里选。" : backend === "dsh" ? "模型和 DeepSeek 密钥在 dsh 自己的设置里（它的 acp 档）。dsh 还不能做后台整理，请保持下面的开关打开。" : `模型：跟随你在 ${backend === "claude" ? "Claude Code" : "Codex"} 里的设置${followed ? `（${followed}）` : "（没设，用它的默认）"}。`}
          {refused && <span className="text-amber"> 你设的 {refused} 在这台电脑装的 {backend === "codex" ? "Codex" : "Claude Code"} 上用不了，暂用它的默认模型；把它更新到最新版就能用。</span>}
          <span className="text-ink-3"> 在你自己的 AI 助手里（经 MCP）发起的事，由那个助手自己做。</span>
        </div>
        <div className="mt-3 pt-3 border-t border-line">
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={useModel} onChange={(e) => setBackground(e.target.checked)} />
            <span>后台整理改用内置模型</span>
            <span className="text-xs text-ink-3">现在由：{cfg?.background?.doneBy ?? "…"}</span>
          </label>
          <details className="mt-1 text-xs text-ink-3">
            <summary className="cursor-pointer">后台整理包括什么</summary>
            <ul className="list-disc ml-5 mt-1 space-y-0.5">{BACKGROUND_WORK.map((w) => <li key={w}>{w}</li>)}</ul>
            <div className="mt-1">不包括聊天和联网调研。关掉这个开关，就交给上面选的那家，它在做这些时拿不到任何工具（读不了你电脑上的文件）。</div>
          </details>
        </div>
        {cfg?.chat?.agentDir && (
          <div className="mt-3 pt-3 border-t border-line text-xs text-ink-3 flex items-center gap-2">
            <span className="min-w-0">想在你自己的 Claude Code / Codex / WorkBuddy 里用 Zhiro：在这个文件夹里打开它 <span className="font-mono break-all">{cfg.chat.agentDir}</span></span>
            {tauri && <Button onClick={() => open(cfg.chat.agentDir)}>打开</Button>}
          </div>
        )}
      </Card>
      {(backend === "builtin" || useModel) && <ModelService />}
    </>
  );
}

/** 模型用量: tokens per purpose, and per piece of work (one 网申, one document) where that is what the user thinks in. */
function Usage() {
  const [u, setU] = useState<any>(null);
  const load = () => { call("usage.summary").then(setU).catch(() => {}); };
  useEffect(load, []);
  useOnDataChange(load);
  if (!u) return null;
  return (
    <Card className="p-5 mb-4">
      <div className="flex items-baseline gap-2 mb-2">
        <div className="font-bold">模型用量</div>
        <span className="text-xs text-ink-3">{u.total.since ? `自 ${u.total.since.slice(0, 10)} 起 ${u.total.calls} 次调用，共 ${k(u.total.total)} tokens` : "还没有记录"}</span>
        {u.total.cost > 0 && <span className="text-xs text-ink-3 ml-auto" title="用订阅登录（如 ChatGPT）时不按 token 计费，这里只是按官方 API 价格折算，方便比较">按 API 价格折算约 ${u.total.cost.toFixed(2)}</span>}
      </div>
      {u.items.length > 0 && (
        <table className="w-full text-sm">
          <thead className="text-xs text-ink-3"><tr><th className="text-left py-1">用途</th><th className="text-right">次数</th><th className="text-right">输入</th><th className="text-right">输出</th><th className="text-right">平均每件</th><th className="text-right">近 7 天</th></tr></thead>
          <tbody>{u.items.map((x: any) => (
            <tr key={x.purpose} className="border-t border-line">
              <td className="py-1.5">{x.purpose}</td><td className="text-right tabular">{x.calls}</td><td className="text-right tabular">{k(x.input)}</td><td className="text-right tabular">{k(x.output)}</td>
              <td className="text-right tabular" title={x.jobs ? `${x.jobs} 件事（如 ${x.jobs} 次网申）的平均` : "每次调用的平均"}>{k(x.perJob)}</td><td className="text-right tabular">{k(x.week)}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

const gb = (n: number) => (n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.round(n / 1e6)} MB`);

/**
 * 数据 (ADR-048, ADR-058): where the data is and how much room it takes, moving it to another disk, backups, and the
 * directory as one zip. Opening folders and importing need the desktop shell.
 */
function DataCard({ cfg }: { cfg: any }) {
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);
  const [zip, setZip] = useState("");
  const [owned, setOwned] = useState<boolean | null>(null);
  const [loc, setLoc] = useState<any>(null);
  const [moving, setMoving] = useState(false);
  const [to, setTo] = useState("");
  const tauri = !!window.__TAURI_INTERNALS__;
  const reload = () => call("data.location").then(setLoc).catch(() => {});
  useEffect(() => { reload(); }, []);
  useEffect(() => { if (tauri) import("@tauri-apps/api/core").then(({ invoke }) => invoke<boolean>("daemon_owned").then(setOwned)).catch(() => {}); }, [tauri]);
  const invoke = async (cmd: string, args: any) => (await import("@tauri-apps/api/core")).invoke<any>(cmd, args);
  const backup = async () => {
    setBusy(true); setMsg("正在备份并检查…");
    try { const r = await call("backup.run"); setMsg(`备份好了，已检查：${r.path}（${gb(r.bytes)}）`); reload(); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  const exportNow = async () => {
    setBusy(true); setMsg("正在导出，大库要几十秒…");
    try {
      const r = await call("data.export");
      setMsg(`已导出到 ${r.path}（${(r.bytes / 1e6).toFixed(1)} MB；招聘项目 ${r.counts.campaign ?? 0}、岗位 ${r.counts.position ?? 0}、申请 ${r.counts.application ?? 0}、事实卡 ${r.counts.fact ?? 0}；文件 ${r.files} 个）。不含钥匙、模型登录、浏览器状态，配置里的密钥已去掉。`);
      if (tauri) await invoke("open_dir", { path: r.path.replace(/[\\/][^\\/]+$/, "") }).catch(() => {});
    } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  const importNow = async () => {
    if (!zip.trim()) return;
    setBusy(true); setMsg("正在导入：先备份现有数据，再替换，然后重启后台…");
    try { setMsg(await invoke("import_vault", { zip: zip.trim() })); window.dispatchEvent(new CustomEvent("jobos:refresh")); }
    catch (e: any) { setMsg(String(e)); } finally { setBusy(false); }
  };
  const move = async (target: string) => {
    setBusy(true);
    try { await call("data.move", { to: target }); setMsg(""); setMoving(false); await reload(); } catch (e: any) { setMsg(e.message); } finally { setBusy(false); }
  };
  const restartHow = tauri && owned ? "从托盘「退出」再打开 Zhiro，就开始搬" : "重启 Zhiro 的后台后开始搬（后台是终端起的：停掉它，再起一次）";
  return (
    <Card className="p-5 col-span-2">
      <div className="flex items-center gap-3">
        <div className="font-bold">数据</div>
        <div className="ml-auto flex gap-2">
          <Button onClick={backup} disabled={busy}>立即备份</Button>
          <Button onClick={exportNow} disabled={busy}>导出数据</Button>
          {tauri && <Button onClick={() => invoke("open_dir", { path: cfg?.vault })} disabled={!cfg?.vault}>打开数据文件夹</Button>}
        </div>
      </div>
      {loc && (
        <div className="mt-2 text-sm">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">在 <span className="font-mono text-xs break-all">{loc.path}</span>，占 {gb(loc.bytes)}（其中备份 {gb(loc.backupsBytes)}），这个盘还剩 {gb(loc.freeBytes)}</div>
            {!loc.pending && <Button onClick={() => { setMoving(!moving); setMsg(""); }}>{moving ? "收起" : "换个位置"}</Button>}
          </div>
          <div className="text-xs text-ink-3 mt-1">备份只留最近 5 份和 1 份一周以前的{loc.path.toLowerCase() !== loc.entry.toLowerCase() ? `；原来的地址 ${loc.entry} 照样能用，它通向这里` : ""}</div>
          {loc.pending && <div className="mt-2 text-amber">已登记：下次启动时搬到 <span className="font-mono text-xs">{loc.pending}</span>。{restartHow}。搬之前关掉在数据文件夹里开着的 Claude Code / Codex 窗口和 Zhiro 打开的网申浏览器。 <Button onClick={() => move("")} disabled={busy}>取消</Button></div>}
          {loc.lastError && <div className="mt-2 text-bad">上次没搬成，数据还在原位置：{loc.lastError}</div>}
          {loc.old && <div className="mt-2 text-ink-2">旧的一份还在：<span className="font-mono text-xs break-all">{loc.old.path}</span>（{gb(loc.old.bytes)}）。确认新位置没问题后，由你自己把这个文件夹删掉；Zhiro 不会删它。{tauri && <> <Button onClick={() => invoke("open_dir", { path: loc.old.path.replace(/[\\/][^\\/]+$/, "") })}>打开所在文件夹</Button></>}</div>}
          {moving && (
            <div className="mt-3 border border-line rounded-md p-3 space-y-2">
              <div className="flex flex-wrap gap-2 items-center">
                <span className="text-xs text-ink-3">搬到机内硬盘：</span>
                {loc.drives.map((d: any) => <Button key={d.root} onClick={() => setTo(`${d.root}Zhiro数据`)}>{d.root.slice(0, 1)} 盘 · 剩 {gb(d.freeBytes)}</Button>)}
                {!loc.drives.length && <span className="text-xs text-ink-3">没读到硬盘列表，直接写文件夹路径</span>}
              </div>
              <div className="flex gap-2">
                <input value={to} onChange={(e) => setTo(e.target.value)} placeholder="一个空文件夹的完整路径，例如 E:\Zhiro数据" className="flex-1 min-w-0 px-3 py-1.5 border border-line rounded-md bg-paper text-sm" />
                <Button tone="primary" onClick={() => move(to.trim())} disabled={busy || !to.trim()}>搬过去</Button>
              </div>
              <div className="text-xs text-ink-3">下次启动 Zhiro 时搬：整体复制过去，逐个文件比对，全部一致才换到新位置；有一处不一致就放弃，数据留在原位置。旧的一份不会被删。</div>
            </div>
          )}
        </div>
      )}
      <div className="flex items-center gap-2 mt-3">
        <input value={zip} onChange={(e) => setZip(e.target.value)} placeholder="要导入的 zip 的完整路径" className="flex-1 min-w-0 px-3 py-1.5 border border-line rounded-md bg-paper text-sm" />
        {tauri && owned ? <Button onClick={importNow} disabled={busy || !zip.trim()}>导入</Button>
          : <span className="text-xs text-ink-3" title="导入要先停掉后台进程，所以只有由这个窗口启动后台时才能在这里做">{tauri ? "后台是终端起的：先停掉它，再在终端里跑" : "在终端里跑"} <span className="font-mono">pnpm --filter @zhiro/daemon vault import &lt;zip&gt;</span></span>}
      </div>
      {msg && <div className="mt-2 text-sm text-ink-2 break-all">{msg}</div>}
      <div className="mt-2 text-xs text-ink-3">卸载：先导出；卸载程序只删程序，数据文件夹留着，不要了就手动删。</div>
    </Card>
  );
}

/** 数据通道 (ADR-031): every place data comes from, grouped by what it produces — one view instead of scattered panels. */
function Channels({ ver }: { ver: number }) {
  // the card is always there: while the answer is on its way (the daemon can be busy reading a big sheet) it says so,
  // and it keeps the last numbers while newer ones are fetched — it used to vanish whenever it had nothing yet
  const [items, setItems] = useState<any[]>([]);
  const [err, setErr] = useState("");
  useEffect(() => { call("channel.list").then((r) => { setItems(r.items); setErr(""); }).catch((e) => setErr(e.message)); }, [ver]);
  const groups = [...new Set(items.map((c) => c.produces))];
  const costTone = (c: string) => (c === "免费" ? "good" : c === "模型" ? "amber" : "bad") as any;
  return (
    <Card className="p-5 mb-4">
      <div className="font-bold mb-2">数据通道 <span className="text-xs text-ink-3 font-normal ml-2">通道是程序，订阅和数据在你自己的 vault 里</span></div>
      {!items.length && <div className="text-sm text-ink-3">{err ? `没读到：${err}` : "读取中…"}</div>}
      {groups.map((g) => (
        <div key={g} className="mb-2">
          <div className="text-xs text-ink-3 mb-0.5">{g}</div>
          {items.filter((c) => c.produces === g).map((c) => (
            <div key={c.id} className="flex items-center gap-2 text-sm py-0.5" title={`输入：${c.input}${c.covers ? `\n覆盖：${c.covers}` : ""}\n工具：${c.tools.join("、")}`}>
              <span className="flex-1 truncate">{c.name}{c.covers && <span className="text-xs text-ink-3 ml-1.5">{c.covers}</span>}</span>
              <span className="text-xs text-ink-3 w-10">{c.trigger}</span>
              <span className="w-16"><Chip tone={costTone(c.cost)}>{c.cost}</Chip></span>
              <span className="text-xs text-ink-3 w-40 text-right tabular">{c.subscriptions != null ? `订阅 ${c.subscriptions} · ` : ""}{c.records.toLocaleString()} 条{c.updatedAt ? ` · ${c.updatedAt.slice(5, 10)}` : ""}</span>
            </div>
          ))}
        </div>
      ))}
    </Card>
  );
}

/** 接入一个订阅：贴链接 → 预览（表格可以改每一列读成什么）→ 确认。 */
function AddSource({ onDone, onCancel }: { onDone: (msg: string) => void; onCancel: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [cohort, setCohort] = useState("");
  const [pv, setPv] = useState<any>(null);
  // two things can be under way and they are told apart: a preview being read, and the table being added. One flag for
  // both let a preview that finished late switch the 确认接入 button back on in the middle of an add (a 9-万-row sheet
  // needed two or three clicks, 2026-10-13). Of several previews only the newest one's answer is shown.
  const [loading, setLoading] = useState(false);
  const [adding, setAdding] = useState(false);
  const [err, setErr] = useState("");
  const latest = useRef(0), shownCohort = useRef("");
  const input = "px-3 py-1.5 border border-line rounded-md bg-paper text-sm";
  const preview = async (columns?: Record<string, string>) => {
    if (adding) return;
    const mine = ++latest.current, asked = cohort;
    setLoading(true); setErr("");
    try { const r = await call("source.preview", { url: url.trim(), columns, cohort: asked || undefined }); if (mine === latest.current) { setPv(r); shownCohort.current = asked; } }
    catch (e: any) { if (mine === latest.current) { setPv(null); setErr(e.message); } }
    finally { if (mine === latest.current) setLoading(false); }
  };
  const setColumn = (field: string, header: string) => { const c = { ...pv.columns }; if (header) c[field] = header; else delete c[field]; preview(c); };
  const add = async () => {
    latest.current++; // a preview still on its way no longer matters
    setAdding(true); setLoading(false); setErr("");
    try {
      const label = name.trim() || pv.name, since = new Date().toISOString();
      const r = await call("source.add", { url: url.trim(), name: label, cohort: cohort || undefined, ...(pv.table ? { columns: pv.columns } : {}) });
      // its first read starts by itself within seconds of being added; wait for that one instead of reading the table twice
      let first: any = null;
      for (let i = 0; i < 60 && !first; i++) {
        await new Promise((ok) => setTimeout(ok, 2000));
        const last = (await call("source.list")).configured.find((c: any) => c.id === r.id)?.lastRun;
        if (last && last.at >= since) first = last; // a table added before under the same name has older runs on record
      }
      onDone(!first ? `已接入「${label}」，第一次读取还在进行，稍后在下面这一行看结果。之后每天自动更新。`
        : first.error ? `已接入「${label}」，但第一次没读成：${first.error.replace(/^[A-Z_]{4,}: /, "")}`
        : `已接入「${label}」：读到 ${first.found} 条，其中新岗位 ${first.newPositions} 个。之后每天自动更新。`);
    } catch (e: any) { setErr(e.message); } finally { setAdding(false); }
  };
  return (
    <div className="mb-3 space-y-2">
      <div className="flex gap-2">
        <input value={url} disabled={adding} onChange={(e) => { setUrl(e.target.value); setPv(null); }} onKeyDown={(e) => e.key === "Enter" && url.trim() && preview()} placeholder="招聘站链接、飞书多维表格链接、CSV 链接，或本机 CSV 文件的完整路径" className={`${input} flex-1`} />
        <Button tone={pv ? "" : "primary"} onClick={() => preview()} disabled={!url.trim() || loading || adding}>{loading ? "读取中…" : "预览"}</Button>
        <Button onClick={onCancel}>取消</Button>
      </div>
      {err && <div className="text-sm text-bad">{err}</div>}
      {pv && (
        <div className="border border-line rounded-md p-3 space-y-2">
          <div className="text-sm">识别为 <Chip tone="accent">{pv.name}</Chip>{pv.subscribed && <span className="text-amber ml-2">已经订阅过了</span>}</div>
          {pv.table && (
            <>
              <div className="grid grid-cols-[6em_1fr_6em_1fr] gap-x-3 gap-y-1 text-sm items-center">
                {pv.fields.map((f: any) => (
                  <label key={f.field} className="contents">
                    <span className="text-ink-3">{f.label}{f.required && <span className="text-bad"> *</span>}</span>
                    <select value={pv.columns[f.field] ?? ""} disabled={adding} onChange={(e) => setColumn(f.field, e.target.value)} className={`${input} py-1`}>
                      <option value="">（不用）</option>
                      {pv.headers.map((h: string) => <option key={h} value={h}>{h}</option>)}
                    </select>
                  </label>
                ))}
              </div>
              <div className="text-sm text-ink-2">{pv.rows} 行 → {pv.posts} 个岗位，{pv.companies} 家公司</div>
              {pv.problem && <div className="text-sm text-bad">{pv.problem}</div>}
              {pv.sample.length > 0 && (
                <table className="w-full text-xs">
                  <tbody>{pv.sample.map((r: any, i: number) => (
                    <tr key={i} className="border-t border-line"><td className="py-1">{r.company}</td><td>{r.title}</td><td>{r.cities.join("、")}</td><td>{r.deadline}</td><td className="font-mono truncate max-w-48">{r.url}</td></tr>
                  ))}</tbody>
                </table>
              )}
            </>
          )}
          <div className="flex gap-2">
            <input value={name} disabled={adding} onChange={(e) => setName(e.target.value)} placeholder={pv.table ? "给这张表起个名字" : "公司名"} className={`${input} w-56`} />
            {pv.table && pv.columns.cohort && <input value={cohort} disabled={adding} onChange={(e) => setCohort(e.target.value)} onBlur={() => { if (cohort !== shownCohort.current) preview(pv.columns); }} placeholder="只要哪一届（可空），如 2027届" className={`${input} w-56`} />}
            <Button tone="primary" onClick={add} disabled={adding || !!pv.problem || !!pv.subscribed || (!pv.table && !name.trim())}>{adding ? "接入并读取中…" : "确认接入"}</Button>
          </div>
          {adding && <div className="text-xs text-ink-3">已接入，正在第一次读取。几万行的大表要一两分钟，读完这里会显示结果，不用再点。</div>}
        </div>
      )}
    </div>
  );
}

export default function Settings() {
  const [cfg, setCfg] = useState<any>(null);
  const [src, setSrc] = useState<any>({ kinds: [], configured: [] });
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState("");
  const [ver, setVer] = useState(0); // every reload of the subscriptions also refreshes the 数据通道 numbers above
  const latest = useLatest();
  const load = () => {
    setVer((v) => v + 1);
    latest("cfg", call("config.get")).then((r) => setCfg(r.config)).catch((e) => setMsg(e.message));
    latest("src", call("source.list")).then(setSrc).catch(() => {});
  };
  useEffect(load, []);
  // changed elsewhere (an agent added a subscription, a scan finished): the cards update; a link being previewed in
  // 添加, a path being typed and the open rows stay as they are. 数据 (disk sizes) is not re-measured for this: it walks
  // the whole data folder, and nothing an agent writes moves it noticeably — it updates after backup / move as before.
  useOnDataChange(load);
  const scan = async (id: string) => {
    setBusy(id);
    try { const r = await call("scan.run", { configId: id }); setSrcMsg(`已更新：读到 ${r.received} 条，其中新岗位 ${r.positionsNew} 个${r.positionsClosed ? `，${r.positionsClosed} 个已不在表里、标为关闭` : ""}`); load(); }
    catch (e: any) { setSrcMsg(`没读成：${e.message}`); } finally { setBusy(""); }
  };
  // a pull under way (the daily read of a big sheet, or 立即更新): its row says how far it is, asked again every 2 s until it is done
  const reading = !!busy || src.configured.some((c: any) => c.running);
  useEffect(() => {
    if (!reading) return;
    const t = setInterval(() => latest("src", call("source.list")).then(setSrc).catch(() => {}), 2000);
    return () => clearInterval(t);
  }, [reading]);
  // a pull started or ended in the background (the daily schedule): look again — at most once a second, however many
  // start together — and a pull still under way is followed from there
  const readingRef = useRef(reading), scanLook = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  readingRef.current = reading;
  useEffect(() => {
    const off = events((type) => {
      if (type !== "scan" || readingRef.current || scanLook.current) return;
      scanLook.current = setTimeout(() => { scanLook.current = undefined; latest("src", call("source.list")).then(setSrc).catch(() => {}); }, 1000);
    });
    return () => { off(); clearTimeout(scanLook.current); };
  }, []);
  const progress = (r: any) => (r.stage === "reading" ? `读取中${r.total ? ` ${r.done.toLocaleString()}/${r.total.toLocaleString()} 行` : "…"}` : `比对入库 ${r.total.toLocaleString()} 条…`);
  const [adding, setAdding] = useState(false);
  const [showAuto, setShowAuto] = useState(false);
  const [removing, setRemoving] = useState(""), [deleting, setDeleting] = useState("");
  const [srcMsg, setSrcMsg] = useState(""); // said inside the 岗位订阅 card: that is where the person is looking
  const remove = async (c: any) => {
    if (removing !== c.id) { setRemoving(c.id); return; } // the second click on the same row does it
    setRemoving(""); setDeleting(c.id); setSrcMsg(`正在删除「${c.name}」，并清掉只由它带来的岗位…`); // said at the click, not when it is over
    try { const r = await call("source.remove", { id: c.id }); setSrcMsg(`已删除订阅「${r.name}」${r.droppedCampaigns ? `，清掉它带来的 ${r.droppedCampaigns} 个招聘项目（你关注或申请过的保留）` : ""}`); }
    catch (e: any) { setSrcMsg(`没删成：${e.message}`); } finally { setDeleting(""); load(); }
  };
  const autoCount = src.configured.filter((c: any) => c.auto).length;
  const said = (error: string) => error.replace(/^[A-Z_]{4,}: /, "").slice(0, 60);
  const testFeishu = async () => { try { await call("feishu.notify", { title: "Zhiro 测试", lines: ["飞书通知已接通 ✅"] }); setMsg("已发送"); } catch (e: any) { setMsg(e.message); } };
  return (
    <>
      <H1>配置</H1>
      {msg && <div className="mb-3 text-sm text-ink-2">{msg}</div>}
      <AiCard cfg={cfg} reload={load} onError={setMsg} />
      <Usage />
      <Channels ver={ver} />
      <div className="grid grid-cols-2 gap-4">
        <Card className="p-5">
          <div className="font-bold mb-2">捕获书签</div>
          <p className="text-sm text-ink-2 mb-3">把页面里的按钮拖到书签栏，在招聘页点它即可入库。</p>
          <a className="text-accent text-sm font-mono" href={bookmarkletUrl()} target="_blank" rel="noreferrer">{bookmarkletUrl()}</a>
        </Card>
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-2"><div className="font-bold">飞书通知</div>{cfg?.feishu?.configured ? <Chip tone="good">已配置</Chip> : <Chip tone="amber">未配置</Chip>}</div>
          <p className="text-sm text-ink-2 mb-3">截止提醒和进展发到你的飞书。</p>
          <Button onClick={testFeishu} disabled={!cfg?.feishu?.configured}>发一条测试</Button>
        </Card>
        <DataCard cfg={cfg} />
        <Card className="p-5 col-span-2">
          <div className="flex items-center gap-3">
            <div className="font-bold">助手权限</div>
            <span className="text-xs text-ink-3" title="默认：关注、标签、准备申请、不投了、画像字段、搜索模式直接做，聊天里可撤销；结束已投递的申请、删除、发送、联网调研、一次超过 10 条写操作仍要你确认。保守：所有写操作都要确认。">悬停看说明</span>
            <div className="ml-auto flex gap-2">
              {([["default", "默认"], ["conservative", "保守"]] as const).map(([m, label]) => (
                <Button key={m} tone={(cfg?.agent?.mode ?? "default") === m ? "primary" : ""} onClick={async () => { try { await call("agent.mode", { mode: m }); load(); } catch (e: any) { setMsg(e.message); } }}>{label}</Button>
              ))}
            </div>
          </div>
        </Card>
        <Card className="p-5 col-span-2">
          <div className="flex items-center mb-2"><div className="font-bold">岗位订阅 · {src.configured.filter((c: any) => !c.auto).length}<span className="text-xs text-ink-3 font-normal ml-2">招聘站、飞书多维表格、CSV 表格，每天自动更新</span></div><span className="ml-auto">{!adding && <Button onClick={() => setAdding(true)}>＋ 添加</Button>}</span></div>
          {srcMsg && <div className="mb-2 text-sm text-ink-2">{srcMsg}</div>}
          {adding && <AddSource onCancel={() => setAdding(false)} onDone={(m) => { setSrcMsg(m); setAdding(false); load(); }} />}
          {src.configured.length === 0 ? <div className="text-ink-3 text-sm">还没有订阅。点「添加」，贴一个招聘站或表格的链接。</div> : (
            <table className="w-full text-sm">
              <thead className="text-xs text-ink-3"><tr><th className="text-left py-1">名称</th><th className="text-left">类型</th><th className="text-left">周期</th><th className="text-left">上次</th><th className="text-left">结果</th><th></th></tr></thead>
              <tbody>{src.configured.filter((c: any) => showAuto || !c.auto).map((c: any) => (
                <tr key={c.id} className="border-t border-line">
                  <td className="py-1.5">{c.name}<div className="text-xs text-ink-3 font-mono truncate max-w-xs">{c.url}</div></td>
                  <td className="pr-3"><Chip>{c.source}</Chip></td>
                  <td className="tabular whitespace-nowrap pr-3">{c.everyHours} h</td>
                  <td className="font-mono text-xs whitespace-nowrap pr-3">{c.lastRun?.at ? new Date(c.lastRun.at).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }) : "—"}</td>
                  <td className="text-xs">{c.running ? <span className="text-accent">{progress(c.running)}</span> : c.lastRun ? (c.lastRun.error ? <span className="text-bad" title={c.lastRun.error}>{said(c.lastRun.error)}</span> : `${c.lastRun.found} 条 · 新增 ${c.lastRun.newPositions}${c.lastRun.complete ? "" : " · 不完整"}`) : ""}</td>
                  <td className="text-right whitespace-nowrap"><Button onClick={() => scan(c.id)} disabled={busy === c.id || deleting === c.id}>{busy === c.id ? "读取中…" : "立即更新"}</Button> <Button tone={removing === c.id ? "danger" : ""} onClick={() => remove(c)} disabled={deleting === c.id}>{deleting === c.id ? "删除中…" : removing === c.id ? "确认删除" : "删除"}</Button></td>
                </tr>
              ))}</tbody>
            </table>
          )}
          {autoCount > 0 && <button className="text-xs text-ink-3 mt-2" onClick={() => setShowAuto(!showAuto)}>{showAuto ? "收起" : `＋ ${autoCount} 个自动接入的官方招聘页`}</button>}
        </Card>
      </div>
    </>
  );
}
