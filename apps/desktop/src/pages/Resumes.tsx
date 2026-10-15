import { useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Chip, Button, Empty } from "../ui";

const input = "px-3 py-1.5 border border-line rounded-md bg-paper text-sm min-w-0";
const ACCEPT = ".pdf,.docx,.html,.htm,.tex,.md,.txt";
const split = (s: string) => s.split(/[\/、,，;；|\s]+/).filter(Boolean);
const toBase64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

/** Toggle chips for 公司类型: the values come from the position pool, so they are the same words the matcher will see. */
function TypePicker({ value, onChange, options }: { value: string[]; onChange: (v: string[]) => void; options: string[] }) {
  const all = [...new Set([...options, ...value])];
  return <div className="flex gap-1.5 flex-wrap">{all.map((t) => <button key={t} type="button" onClick={() => onChange(value.includes(t) ? value.filter((x) => x !== t) : [...value, t])}><Chip tone={value.includes(t) ? "accent" : ""}>{t}</Chip></button>)}</div>;
}

/**
 * Pick-and-advise widget used wherever a job needs a resume (待投 rows on 已投). The pick is rule-based and instant;
 * the sparkle button is the only thing that calls the model, and it only returns advice.
 */
export function ResumeChoice({ positionId, value, onChange }: { positionId: string; value: string; onChange: (name: string) => void }) {
  const [data, setData] = useState<any>(null);
  const [analysis, setAnalysis] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const latest = useLatest();
  // the suggested resume is filled in once, on opening; a refresh (a resume added elsewhere) only updates the choices
  const load = (fill: boolean) => latest("pick", call("resume.pick", { positionId })).then((r) => { setData(r); if (fill && !value && r.pick) onChange(r.pick.resume.name); }).catch(() => {});
  useEffect(() => { load(true); }, [positionId]);
  useOnDataChange(() => load(false));
  if (!data) return null;
  if (!data.pick) return <input value={value} onChange={(e) => onChange(e.target.value)} placeholder="用的简历版本（简历库还是空的，可先手填）" className={`${input} w-64`} />;
  const all = [data.pick, ...data.alternatives];
  const current = all.find((x: any) => x.resume.name === value) ?? data.pick;
  const analyse = async () => {
    setBusy(true); setErr(""); setAnalysis(null);
    try { setAnalysis(await call("resume.analyze", { resumeId: current.resume.id, positionId })); } catch (e: any) { setErr(e.message); } finally { setBusy(false); }
  };
  return (
    <div className="w-full">
      <div className="flex gap-2 items-center flex-wrap">
        <label className="text-xs text-ink-3">用哪份简历</label>
        <select value={current.resume.name} onChange={(e) => { onChange(e.target.value); setAnalysis(null); }} className={input}>
          {all.map((x: any, i: number) => <option key={x.resume.id} value={x.resume.name}>{x.resume.name}{i === 0 ? "（系统建议）" : ""}</option>)}
        </select>
        <button type="button" onClick={analyse} disabled={busy} title="让模型分析这份简历和这个岗位的匹配度，给修改意见（不会改你的简历）" className="p-1.5 rounded-md border border-line bg-paper text-accent hover:bg-ground disabled:opacity-40"><Sparkles size={15} /></button>
        <span className="text-xs text-ink-3">{busy ? "分析中…" : current === data.pick ? data.pick.reason : current.reason || "你手动选的"}</span>
      </div>
      {err && <div className="text-xs text-bad mt-1">{err}</div>}
      {analysis && (
        <div className="mt-2 border border-line rounded-md p-3 bg-paper text-sm">
          <div className="mb-1"><Chip tone={analysis.fit === "高" ? "good" : analysis.fit === "低" ? "bad" : "amber"}>匹配度 {analysis.fit}</Chip> <span className="ml-1">{analysis.summary}</span></div>
          {!analysis.hasJd && <div className="text-xs text-amber mb-1">这个岗位的来源没有 JD 正文，下面只是按岗位名判断的。</div>}
          {([["已有的优势", analysis.strengths], ["岗位要求而简历没体现的", analysis.gaps], ["修改意见（只是建议，不会动你的文件）", analysis.suggestions]] as [string, string[]][]).map(([label, items]) => items.length > 0 && (
            <div key={label} className="mt-2"><div className="text-xs text-ink-3">{label}</div><ul className="list-disc pl-5">{items.map((s, i) => <li key={i}>{s}</li>)}</ul></div>
          ))}
        </div>
      )}
    </div>
  );
}

/** PDF shows as is (what most application systems want); Word gets a simple rendering — its real layout needs Word. */
function Preview({ id }: { id: string }) {
  const [f, setF] = useState<any>(null);
  const [url, setUrl] = useState("");
  const [err, setErr] = useState("");
  const shown = useRef<any>(null), made = useRef("");
  const load = () => call("resume.file", { id }).then((r) => {
    // the same file again (a refresh for some other change) leaves the preview alone, scrolled where it is
    const was = shown.current;
    if (was && was.path === r.path && was.dataBase64 === r.dataBase64 && was.html === r.html && was.text === r.text) return;
    shown.current = r; setF(r); setErr("");
    if (made.current) { URL.revokeObjectURL(made.current); made.current = ""; }
    if (r.dataBase64) { const bytes = Uint8Array.from(atob(r.dataBase64), (ch) => ch.charCodeAt(0)); made.current = URL.createObjectURL(new Blob([bytes], { type: r.mime })); }
    setUrl(made.current);
  }).catch((e) => setErr(e.message));
  useEffect(() => { load(); return () => { if (made.current) URL.revokeObjectURL(made.current); made.current = ""; shown.current = null; }; }, [id]);
  useOnDataChange(load);
  if (err) return <div className="text-xs text-bad mt-2">{err}</div>;
  if (!f) return <div className="text-xs text-ink-3 mt-2">加载预览…</div>;
  const doc = `<!doctype html><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{font:14px/1.7 system-ui,sans-serif;color:#1c2026;margin:24px;max-width:780px}h3{margin:18px 0 6px;border-bottom:1px solid #dde1db;padding-bottom:4px}p{margin:4px 0}table{border-collapse:collapse;margin:6px 0}td{border:1px solid #dde1db;padding:3px 8px;vertical-align:top}</style>${f.html}`;
  return (
    <div className="mt-3 border border-line rounded-md overflow-hidden">
      <div className="px-3 py-1.5 bg-ground text-xs text-ink-3 flex gap-3"><span>{f.fileName}</span>
        {f.html && f.mime.includes("word") && <span className="text-amber">Word 简易预览，版式以 Word 为准</span>}
        <span className="ml-auto font-mono truncate" title="库里的副本">{f.path}</span></div>
      {url ? <iframe title="简历预览" src={url} className="w-full h-[42rem] bg-paper" />
        : f.html ? <iframe title="简历预览" sandbox="" srcDoc={doc} className="w-full h-[42rem] bg-paper" />
        : <pre className="whitespace-pre-wrap text-xs p-4 max-h-[42rem] overflow-auto bg-paper">{f.text}</pre>}
    </div>
  );
}

export default function Resumes() {
  const [items, setItems] = useState<any[]>([]);
  const [types, setTypes] = useState<string[]>([]);
  const [draft, setDraft] = useState<{ id?: string; name: string; companyTypes: string[]; roleKeywords: string; note: string; isDefault: boolean }>({ name: "", companyTypes: [], roleKeywords: "", note: "", isDefault: false });
  const [file, setFile] = useState<File | null>(null);
  const [toProfile, setToProfile] = useState(false);
  const [msg, setMsg] = useState("");
  const [open, setOpen] = useState("");
  const [traces, setTraces] = useState<Record<string, any[]>>({});
  const fileRef = useRef<HTMLInputElement>(null);

  const latest = useLatest();
  const load = () => latest("list", call("resume.list")).then((r) => {
    setItems(r.items);
    for (const x of r.items) call("resume.check", { id: x.id }).then((c) => setTraces((t) => ({ ...t, [x.id]: c.items }))).catch(() => {});
  }).catch((e) => setMsg(e.message));
  useEffect(() => { load(); call("pool.facets").then((r) => setTypes(r.companyTypes.slice(0, 12))).catch(() => {}); }, []);
  useOnDataChange(load); // the form being filled in above is the person's own and is left as it is
  const reset = () => { setDraft({ name: "", companyTypes: [], roleKeywords: "", note: "", isDefault: false }); setFile(null); };

  const save = async () => {
    try {
      const dataBase64 = file ? await toBase64(file) : "";
      await call("resume.save", { id: draft.id, name: draft.name, companyTypes: draft.companyTypes, roleKeywords: split(draft.roleKeywords), note: draft.note, isDefault: draft.isDefault || undefined, ...(file ? { fileName: file.name, dataBase64 } : {}) });
      // same file twice is a no-op on the daemon (content hash), and cards it shares with earlier resumes merge into them
      const stored = items.find((r) => r.id === draft.id)?.filePath;
      if (toProfile && (file || stored)) call("profile.import", file ? { name: file.name, dataBase64 } : { path: stored }).catch(() => {});
      setMsg(""); reset(); setToProfile(false); load();
    } catch (e: any) { setMsg(e.message); }
  };
  const edit = (r: any) => { setDraft({ id: r.id, name: r.name, companyTypes: r.companyTypes, roleKeywords: r.roleKeywords.join(" "), note: r.note, isDefault: r.isDefault }); setFile(null); window.scrollTo({ top: 0, behavior: "smooth" }); };
  const remove = async (r: any) => { if (confirm(`从简历库删除「${r.name}」？库里的副本会删掉，你自己的原文件不受影响。`)) { await call("resume.remove", { id: r.id }); load(); } };

  return (
    <>
      <H1 sub="按公司类型和岗位自动选用，可随时换">简历库</H1>
      <Card className="p-4 mb-5">
        <div className="grid grid-cols-[1fr_auto] gap-2 items-center mb-3">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="名字，如 控制算法-民企版" className={input} />
          <div className="flex items-center gap-2">
            <Button onClick={() => fileRef.current?.click()}>{file ? file.name : draft.id ? "换文件" : "选择简历 PDF"}</Button>
            <input ref={fileRef} type="file" accept={ACCEPT} hidden onChange={(e) => { setFile(e.target.files?.[0] ?? null); e.target.value = ""; }} />
          </div>
        </div>
        <div className="text-xs text-ink-3 mb-1">适用公司类型</div>
        <TypePicker value={draft.companyTypes} onChange={(v) => setDraft({ ...draft, companyTypes: v })} options={types} />
        <div className="grid grid-cols-2 gap-2 mt-3">
          <input value={draft.roleKeywords} onChange={(e) => setDraft({ ...draft, roleKeywords: e.target.value })} placeholder="适用岗位关键词，如 控制 算法 伺服" className={input} />
          <input value={draft.note} onChange={(e) => setDraft({ ...draft, note: e.target.value })} placeholder="备注" className={input} />
        </div>
        <div className="flex items-center gap-3 mt-3">
          <Button tone="primary" onClick={save} disabled={!draft.name || (!draft.id && !file)}>{draft.id ? "保存修改" : "加入简历库"}</Button>
          {draft.id && <Button onClick={reset}>取消</Button>}
          <label className="text-xs text-ink-2 flex items-center gap-1.5"><input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} />设为默认</label>
          <label className="text-xs text-ink-2 flex items-center gap-1.5" title="后台抽取这份简历里的事实，补进画像；和已有的卡相同的会合并"><input type="checkbox" checked={toProfile} onChange={(e) => setToProfile(e.target.checked)} />同时补全画像</label>
          <span className="text-sm text-bad">{msg}</span>
        </div>
      </Card>
      {items.length === 0 ? <Empty>还没有简历</Empty> : (
        <Card>
          {items.map((r) => (
            <div key={r.id} className="px-4 py-3 border-t first:border-t-0 border-line text-sm">
              <div className="flex items-center gap-2 cursor-pointer" title="点击预览" onClick={() => setOpen(open === r.id ? "" : r.id)}>
                <span className="font-medium">{r.name}</span>{r.isDefault && <Chip tone="good">默认</Chip>}
                <span className="text-xs text-ink-3 truncate flex-1" title={r.filePath}>{r.fileName}</span>
                {!r.hasText && <span title="读不出文字（可能是扫描件），自动选用不受影响，但无法做匹配分析"><Chip tone="amber">无文字层</Chip></span>}
                <span onClick={(e) => e.stopPropagation()} className="flex gap-2"><Button onClick={() => edit(r)}>改</Button><Button tone="danger" onClick={() => remove(r)}>删</Button></span>
                <span className="text-xs text-ink-3">{open === r.id ? "▾" : "▸"}</span>
              </div>
              <div className="flex gap-1.5 flex-wrap mt-1.5 items-center">
                {r.companyTypes.map((t: string) => <Chip key={t} tone="accent">{t}</Chip>)}{r.roleKeywords.map((k: string) => <Chip key={k}>{k}</Chip>)}
                {r.companyTypes.length + r.roleKeywords.length === 0 && <span className="text-xs text-ink-3">通用</span>}
                {r.note && <span className="text-xs text-ink-3 ml-1">{r.note}</span>}
              </div>
              {(traces[r.id] ?? []).length > 0 && (
                <div className="mt-2 text-xs bg-amber-soft text-amber rounded-md px-3 py-2 space-y-0.5">
                  <div className="font-medium">HR 打开文件能看到这些：</div>
                  {traces[r.id].map((t: any, i: number) => <div key={i}>{t.where}：「{t.found}」— {t.advice}</div>)}
                  <div className="text-ink-3">Zhiro 上传时会把文件名改成「姓名简历」，但文件里面的属性要在 WPS / Word 的「文件 → 属性」里改掉后重新导出 PDF。</div>
                </div>
              )}
              {open === r.id && <Preview id={r.id} />}
            </div>
          ))}
        </Card>
      )}
    </>
  );
}
