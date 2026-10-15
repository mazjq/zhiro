import { useEffect, useRef, useState } from "react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { Card, Chip, Button } from "../ui";

const ACCEPT = ".html,.htm,.docx,.tex,.md,.txt,.pdf,.png,.jpg,.jpeg,.webp";
const OK = new RegExp(`(${ACCEPT.split(",").map((e) => "\\" + e).join("|")})$`, "i");
const STATUS: Record<string, [string, "amber" | "good" | "bad" | ""]> = { pending: ["排队中", ""], processing: ["抽取中…", "amber"], done: ["完成", "good"], failed: ["失败", "bad"] };

const toBase64 = (f: File) => new Promise<string>((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(",")[1] ?? ""); r.onerror = () => rej(r.error); r.readAsDataURL(f); });

/**
 * Pick a resume file and/or a folder of materials. Files are read in the page and handed to the daemon, so this works
 * the same in the Tauri window and in a browser tab (a web page never learns local paths).
 */
export default function ImportPanel({ onChanged, compact }: { onChanged?: () => void; compact?: boolean }) {
  const [docs, setDocs] = useState<any[]>([]);
  const [msg, setMsg] = useState("");
  const fileRef = useRef<HTMLInputElement>(null);
  const dirRef = useRef<HTMLInputElement>(null);
  const [, tick] = useState(0);
  const active = docs.filter((d) => d.status === "pending" || d.status === "processing");
  const busy = active.length > 0;
  // the batch = everything registered since the oldest file still waiting; one file is one model call, so the honest
  // progress unit is files, plus the step and elapsed time of the file being worked on
  const since = active.reduce((m, d) => (d.addedAt < m ? d.addedAt : m), "9999");
  const batch = busy ? docs.filter((d) => d.addedAt >= since) : [];
  const finished = batch.filter((d) => d.status === "done" || d.status === "failed").length;
  const percent = batch.length ? Math.round((finished / batch.length) * 100) : 0;
  const current = docs.find((d) => d.status === "processing");
  const elapsed = current?.startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(current.startedAt)) / 1000)) : 0;

  const latest = useLatest();
  const load = () => latest("docs", call("document.list")).then((r) => setDocs(r.items)).catch(() => {});
  useEffect(() => { load(); }, []);
  useOnDataChange(load);
  useEffect(() => { if (!busy) return; const t = setInterval(() => { load(); onChanged?.(); }, 3000); return () => clearInterval(t); }, [busy]);
  useEffect(() => { if (!busy) return; const t = setInterval(() => tick((n) => n + 1), 1000); return () => clearInterval(t); }, [busy]);
  useEffect(() => { dirRef.current?.setAttribute("webkitdirectory", ""); }, []);

  const upload = async (list: FileList | null) => {
    const files = Array.from(list ?? []).filter((f) => OK.test(f.name) && f.size < 30_000_000).slice(0, 200);
    if (!files.length) { setMsg("没有可导入的文件（支持 " + ACCEPT.replaceAll(",", " ") + "）"); return; }
    let added = 0;
    for (const [i, f] of files.entries()) {
      setMsg(`上传 ${i + 1}/${files.length}：${f.name}`);
      try { const r = await call("profile.import", { name: (f as any).webkitRelativePath || f.name, dataBase64: await toBase64(f) }); if (r.added) added++; } catch (e: any) { setMsg(`${f.name}：${e.message}`); }
    }
    setMsg(`${files.length} 个文件，新增 ${added} 个`);
    load();
  };

  return (
    <Card className={compact ? "p-4" : "p-4 mb-5"}>
      <div className="flex gap-2 items-center flex-wrap">
        <Button tone="primary" onClick={() => fileRef.current?.click()}>选择简历文件</Button>
        <Button onClick={() => dirRef.current?.click()}>选择材料文件夹</Button>
        
        <input ref={fileRef} type="file" accept={ACCEPT} multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
        <input ref={dirRef} type="file" multiple hidden onChange={(e) => { upload(e.target.files); e.target.value = ""; }} />
      </div>
      {msg && <div className="text-sm text-ink-2 mt-2">{msg}</div>}
      {busy && (
        <div className="mt-3">
          <div className="flex items-baseline gap-2 text-sm"><span className="font-bold tabular">{percent}%</span><span className="text-ink-2">已完成 {finished} / {batch.length} 个文件</span>
            {current && <span className="text-ink-3 text-xs ml-auto truncate max-w-[60%]">{current.name} · {current.stage || "准备中"} · {elapsed} 秒</span>}</div>
          <div className="h-1.5 bg-ground rounded-full mt-1.5 overflow-hidden"><div className="h-full bg-accent transition-all" style={{ width: `${Math.max(percent, 3)}%` }} /></div>
        </div>
      )}
      {docs.length > 0 && (
        <div className="mt-3 max-h-56 overflow-auto">
          {docs.map((d) => (
            <div key={d.id} className="flex items-center gap-2 py-1 border-t border-line text-sm">
              <span className="flex-1 truncate" title={d.name}>{d.name}</span>
              {d.kind && <span className="text-xs text-ink-3">{d.kind}</span>}
              {d.status === "done" && <span className="text-xs text-ink-3">{d.facts} 张卡</span>}
              {(d.status === "done" || d.status === "failed") && <button className="text-xs text-accent" title="再抽一遍：误删的卡会回来，已有的卡不会被改" onClick={() => call("document.reextract", { id: d.id }).then(load)}>重新抽取</button>}
              {d.status === "failed" && <span className="text-xs text-bad truncate max-w-[40%]" title={d.error}>{d.error}</span>}
              <Chip tone={STATUS[d.status]?.[1] ?? ""}>{d.status === "processing" ? d.stage || "处理中" : STATUS[d.status]?.[0] ?? d.status}</Chip>
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
