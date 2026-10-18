import { useEffect, useState } from "react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Button, Chip, Empty, STATE_LABEL, deadlineTone } from "../ui";

/**
 * 找实习: every open internship in the pool, one post per row — a post whose name says 实习 / intern, or whose source
 * files the batch as 实习 (position.list `internship`). 找岗位 still lists them too; this page only gathers them.
 */
const PAGE = 50;
const daysTo = (d: string | null) => (d ? Math.ceil((Date.parse(`${d}T23:59:59+08:00`) - Date.now()) / 86400_000) : null);

export default function Internships() {
  const [query, setQuery] = useState("");
  const [city, setCity] = useState<string | null>(null); // null = not yet read from the profile
  const [items, setItems] = useState<any[] | null>(null);
  const [more, setMore] = useState(false);
  const [open, setOpen] = useState("");
  const [msg, setMsg] = useState("");
  const latest = useLatest();
  const load = (offset = 0, c = city ?? "") =>
    latest("interns", call("position.list", { internship: true, query: query.trim() || undefined, city: c.trim() || undefined, detail: "brief", limit: PAGE, offset }))
      .then((r) => { setItems((prev) => (offset ? [...(prev ?? []), ...r.items] : r.items)); setMore(!!r.hasMore); })
      .catch((e) => { setItems((x) => x ?? []); setMsg(e.message); });
  // the city the profile prefers is where to look first; the person can clear it
  useEffect(() => {
    call("fact.list", { kind: "preference" }).then((r) => r.items.find((f: any) => f.data?.field === "城市")?.data?.value ?? "").catch(() => "")
      .then((c: string) => { setCity(c); load(0, c); });
  }, []);
  useOnDataChange(() => { if (city !== null) load(); });

  const watch = async (p: any) => {
    try { await call("position.watch", { positionId: p.id, priority: p.watchPriority ? 0 : 1 }); load(); } catch (e: any) { setMsg(e.message); }
  };
  const input = "px-3 py-1.5 border border-line rounded-md bg-paper text-sm";
  return (
    <>
      <H1 sub="岗位名带「实习」的，和来源标明是实习的，都在这里；「找岗位」里也照样有它们">找实习</H1>
      <div className="flex gap-2 mb-3">
        <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} placeholder="岗位或公司，如 运动控制" className={`${input} flex-1 min-w-0`} />
        <input value={city ?? ""} onChange={(e) => setCity(e.target.value)} onKeyDown={(e) => e.key === "Enter" && load()} placeholder="城市（可空）" className={`${input} w-32`} />
        <Button tone="primary" onClick={() => load()}>搜索</Button>
      </div>
      {msg && <div className="mb-2 text-sm text-bad">{msg}</div>}
      {items === null ? <Empty>正在读取…</Empty> : !items.length ? (
        <Empty>{city || query ? "没有符合条件的实习。换个词，或把城市清空再搜。" : "库里还没有实习岗。订阅招聘网站、高校人才网，或让 AI 助手去 BOSS 上搜，找到的都会出现在这里。"}</Empty>
      ) : (
        <Card className="divide-y divide-line">
          {items.map((p) => <Row key={p.id} p={p} open={open === p.id} onToggle={() => setOpen(open === p.id ? "" : p.id)} onWatch={() => watch(p)} />)}
        </Card>
      )}
      {more && <div className="mt-3 text-center"><Button onClick={() => load(items?.length ?? 0)}>再看 {PAGE} 个</Button></div>}
    </>
  );
}

function Row({ p, open, onToggle, onWatch }: { p: any; open: boolean; onToggle: () => void; onWatch: () => void }) {
  const [d, setD] = useState<any>(null);
  useEffect(() => { if (open && !d) call("position.get", { id: p.id }).then(setD).catch(() => setD({ error: true })); }, [open]);
  const dl = p.deadline ?? {};
  const left = dl.expired === false ? daysTo(p.closesAt) : null;
  const when = p.closesAt ? `截止 ${p.closesAt.slice(5)}` : dl.deadlineKind === "rolling" || dl.deadlineKind === "until_filled" ? "宜尽早" : "截止未写明";
  const pos = d?.position ?? d;
  return (
    <div className="px-4 py-3">
      <div className="flex items-center gap-2">
        <button className="text-left flex-1 min-w-0" onClick={onToggle} title="点开看要求">
          <span className="font-medium">{p.title}</span>
          <span className="text-ink-2 ml-2">{p.companyName}</span>
          <span className="text-xs text-ink-3 ml-2">{(p.cities ?? []).slice(0, 3).join("、")}{p.degreeReq ? ` · ${p.degreeReq}` : ""}</span>
        </button>
        {p.applicationState && <Chip tone="good">{STATE_LABEL[p.applicationState] ?? p.applicationState}</Chip>}
        <span title={dl.say ?? ""}><Chip tone={deadlineTone(left)}>{when}</Chip></span>
        <Button onClick={onWatch}>{p.watchPriority ? "已关注" : "关注"}</Button>
      </div>
      {open && (
        <div className="mt-2 text-sm text-ink-2">
          {!d ? "读取中…" : d.error ? "没读到这个岗位的详情" : (
            <>
              {(pos?.applyUrl || p.applyUrl) && <a className="text-accent text-xs" href={pos?.applyUrl || p.applyUrl} target="_blank" rel="noreferrer">去投递页 ↗</a>}
              <pre className="whitespace-pre-wrap font-sans text-xs bg-ground rounded p-3 mt-1 max-h-80 overflow-auto">{pos?.jdText || "没有岗位描述"}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
