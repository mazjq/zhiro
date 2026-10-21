import { useEffect, useRef, useState } from "react";
import { Trash2, GripVertical } from "lucide-react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Chip, Button, Empty } from "../ui";
import ImportPanel from "./ImportPanel";

/**
 * kind → [label, fields]; a field is [key, placeholder, choices?, free?]. Mirrors FACT_KINDS in the daemon.
 * choices: a list renders a <select>, or with free=true a combo box that offers the list but accepts anything;
 * "@byField" offers values seen in the position pool (cities / industries / company types).
 */
type Field = [key: string, placeholder: string, choices?: string[] | string, free?: boolean];
const AUTHOR = ["第一作者", "学生一作（导师一作）", "第二作者", "学生二作（导师一作）", "第三作者", "通讯作者", "共同一作", "其他"];
const KINDS: Record<string, [string, Field[]]> = {
  education: ["教育", [["school", "学校"], ["degree", "学位", ["本科", "硕士", "博士"]], ["major", "专业"], ["period", "起止时间，如 2021-2027"]]],
  direction: ["方向关键词", [["keyword", "一个关键词一张卡，如 运动控制；多个可用 / 分隔"]]],
  exclude: ["排除词", [["keyword", "标题里含这个词的岗位，任何推荐方式都不再出现，如 实习 / 销售"]]],
  preference: ["期望", [["field", "类别", ["城市", "公司类型", "行业", "岗位类型", "期望薪资", "到岗时间", "发展偏好"], true], ["value", "值，多个用、分隔", "@byField"], ["mode", "软（只排序）", ["硬性"]], ["note", "备注，给人和模型看"]]],
  basic: ["基本信息", [["field", "字段", ["姓名", "性别", "出生年月", "电话", "邮箱", "微信", "政治面貌", "民族", "籍贯", "现居地", "预计毕业时间", "工作经验", "英语水平", "个人主页", "自我描述"], true], ["value", "值"]]],
  publication: ["论文", [["title", "题目"], ["venue", "期刊/会议"], ["year", "年份"], ["status", "状态", ["发表", "录用", "在审", "在投"], true], ["authorOrder", "作者顺序（可选可自填）", AUTHOR, true]]],
  patent: ["专利", [["title", "名称"], ["number", "专利号/申请号"], ["status", "状态", ["授权", "公开", "申请"], true], ["authorOrder", "发明人顺序（可选可自填）", AUTHOR.map((a) => a.replace("作者", "发明人")), true]]],
  project: ["项目", [["title", "名称"], ["role", "本人角色"], ["period", "时间"], ["summary", "做了什么 / 结果"]]],
  experience: ["经历", [["org", "单位"], ["role", "职位"], ["period", "时间"], ["summary", "内容"]]],
  award: ["奖项", [["title", "名称"], ["year", "年份"], ["level", "级别", ["国家级", "省部级", "校级", "企业/行业", "其他"], true]]],
  skill: ["技能", [["name", "名称"], ["level", "熟练度", ["精通", "熟练", "了解"], true]]],
};
const FACET_BY_FIELD: Record<string, string> = { 城市: "cities", 行业: "industries", 公司类型: "companyTypes" };
const gradeTone = (g: string) => (g === "本人确认" ? "good" : g === "材料自述" ? "accent" : "amber") as "good" | "accent" | "amber";
const input = "px-3 py-1.5 border border-line rounded-md bg-paper text-sm min-w-0 w-full";

/**
 * Text box + the full option list on focus. A native <datalist> filters by what is already typed, so a field holding
 * "第一作者" would only ever offer "第一作者" back — here the whole list shows until the user actually types something new.
 */
function Combo({ value, onChange, options, placeholder, onEnter }: { value: string; onChange: (v: string) => void; options: string[]; placeholder: string; onEnter: () => void }) {
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState(false);
  const shown = typed && value ? options.filter((o) => o.includes(value)) : options;
  return (
    <div className="relative min-w-0">
      <input value={value} placeholder={placeholder} className={input}
        onFocus={() => { setOpen(true); setTyped(false); }} onBlur={() => setTimeout(() => setOpen(false), 120)}
        onChange={(e) => { onChange(e.target.value); setTyped(true); setOpen(true); }} onKeyDown={(e) => { if (e.key === "Enter") { setOpen(false); onEnter(); } if (e.key === "Escape") setOpen(false); }} />
      {open && shown.length > 0 && (
        <div className="absolute z-10 mt-1 w-full max-h-56 overflow-auto bg-paper border border-line rounded-md shadow-lg">
          {shown.map((o) => <button key={o} type="button" onMouseDown={(e) => { e.preventDefault(); onChange(o); setOpen(false); }} className={`w-full text-left px-3 py-1.5 text-sm hover:bg-ground ${o === value ? "text-accent" : ""}`}>{o}</button>)}
        </div>
      )}
    </div>
  );
}

/** The inputs for one card — used by the add form on top and by a row being edited in place. */
function Fields({ kind, value, onChange, facets, onEnter }: { kind: string; value: Record<string, string>; onChange: (v: Record<string, string>) => void; facets: Record<string, string[]>; onEnter: () => void }) {
  return (
    <>
      {KINDS[kind][1].map(([key, ph, choices, free]) => {
        const set = (v: string) => onChange({ ...value, [key]: v });
        if (Array.isArray(choices) && !free) return (
          <select key={key} value={value[key] ?? ""} onChange={(e) => set(e.target.value)} className={`${input} ${value[key] ? "" : "text-ink-3"}`}>
            <option value="">{ph}…</option>{choices.map((c) => <option key={c}>{c}</option>)}
            {value[key] && !choices.includes(value[key]) && <option>{value[key]}</option>}
          </select>
        );
        const options = Array.isArray(choices) ? choices : choices === "@byField" ? facets[FACET_BY_FIELD[value.field ?? ""]] ?? [] : [];
        return options.length
          ? <Combo key={key} value={value[key] ?? ""} onChange={set} options={options} placeholder={ph} onEnter={onEnter} />
          : <input key={key} value={value[key] ?? ""} onChange={(e) => set(e.target.value)} placeholder={ph} className={input} onKeyDown={(e) => e.key === "Enter" && onEnter()} />;
      })}
    </>
  );
}

/** "来源 2" with a bubble on hover: which file, and the sentence it was read from. */
function Sources({ sources }: { sources: any[] }) {
  if (!sources.length) return <span className="text-xs text-ink-3">手填</span>;
  return (
    <span className="relative group text-xs text-ink-3 cursor-help shrink-0">
      <span className="underline decoration-dotted">来源 {sources.length}</span>
      <span className="hidden group-hover:block absolute right-0 top-5 z-20 w-96 bg-paper border border-line rounded-md shadow-lg p-3 text-left cursor-auto">
        {sources.map((s, i) => (
          <span key={i} className="block mb-2 last:mb-0">
            <span className="block text-ink font-medium break-all">{s.documentName || "手填"}</span>
            {s.quote && <span className="block text-ink-2 mt-0.5">「{s.quote}」</span>}
          </span>
        ))}
      </span>
    </span>
  );
}

/** 最近删除: slides in from the right, a third of the window; the newest 10 deleted cards, each restorable. */
function TrashDrawer({ items, onClose, onRestore }: { items: any[]; onClose: () => void; onRestore: (id: string) => void }) {
  return (
    <div className="fixed inset-0 z-30" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <aside className="absolute right-0 top-0 h-full w-1/3 min-w-[22rem] bg-paper border-l border-line shadow-xl p-5 overflow-auto" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center mb-1"><div className="text-lg font-bold">最近删除</div><span className="ml-auto"><Button onClick={onClose}>关闭</Button></span></div>
        <div className="text-xs text-ink-3 mb-4">只保留最近删除的 10 张卡，更早的会被挤掉。恢复后连同出处一起回来。</div>
        {items.length === 0 ? <Empty>没有删除过的卡</Empty> : items.map((t) => (
          <div key={t.id} className="py-2.5 border-t border-line flex items-start gap-2 text-sm">
            <div className="flex-1 min-w-0">
              <div><Chip>{KINDS[t.kind]?.[0] ?? t.kind}</Chip> <span className="text-xs text-ink-3 ml-1">{t.deletedAt.slice(5, 16).replace("T", " ")} 删除</span></div>
              <div className="mt-1 break-words">{t.statement}</div>
            </div>
            <Button tone="primary" onClick={() => onRestore(t.id)}>恢复</Button>
          </div>
        ))}
      </aside>
    </div>
  );
}

export default function Profile() {
  const [facts, setFacts] = useState<any[]>([]);
  const [facets, setFacets] = useState<Record<string, string[]>>({});
  const [dupIds, setDupIds] = useState<Set<string>>(new Set());
  const [trash, setTrash] = useState<any[]>([]);
  const [drawer, setDrawer] = useState(false);
  const [undo, setUndo] = useState<{ id: string; statement: string } | null>(null);
  const undoTimer = useRef<number | undefined>(undefined);
  const [kind, setKind] = useState("education");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [editing, setEditing] = useState<{ id: string; data: Record<string, string> } | null>(null);
  const [err, setErr] = useState("");
  const [sug, setSug] = useState<any>(null);
  const [drag, setDrag] = useState<{ id: string; over: string } | null>(null);
  const [gaps, setGaps] = useState<any[]>([]);
  const [hint, setHint] = useState("");
  const addForm = useRef<HTMLDivElement>(null);

  const latest = useLatest();
  const load = () => {
    latest("facts", call("fact.list")).then((r) => setFacts(r.items)).catch((e) => setErr(e.message));
    latest("trash", call("fact.trash")).then((r) => setTrash(r.items)).catch(() => {});
    latest("sug", call("recommend.suggest")).then(setSug).catch(() => {});
    latest("dups", call("fact.duplicates")).then((r) => setDupIds(new Set(r.items.flatMap((x: any) => [x.a.id, x.b.id])))).catch(() => {});
    latest("gaps", call("profile.gaps")).then((r) => setGaps(r.items)).catch(() => {});
  };
  // changed elsewhere (an agent added or confirmed a card): the cards update; a card being edited keeps what is typed in
  // it, and so does the add form — neither is ever filled from the server again
  useOnDataChange(load);
  const fillGap = (g: any) => {
    const f = g.factId && facts.find((x) => x.id === g.factId);
    if (f) { setEditing({ id: f.id, data: { ...f.data } }); setTimeout(() => document.getElementById(`fact-${f.id}`)?.scrollIntoView({ behavior: "smooth", block: "center" }), 50); return; }
    setKind(g.kind); setDraft(g.kind === "basic" || g.kind === "preference" ? { field: g.field } : {}); setHint(g.hint || "");
    addForm.current?.scrollIntoView({ behavior: "smooth", block: "center" });
  };
  useEffect(() => { load(); call("pool.facets").then(setFacets).catch(() => {}); }, []);

  // only cards still waiting for the user's confirmation can be "possibly duplicate"; the notice is counted from
  // exactly the cards that carry the chip, so the two can never disagree
  const flagged = facts.filter((f) => dupIds.has(f.id) && f.grade !== "本人确认");
  const flaggedIds = new Set(flagged.map((f) => f.id));
  const dupSummary = Object.entries(KINDS).map(([k, [label]]) => [label, flagged.filter((f) => f.kind === k).length] as const).filter(([, n]) => n > 0).map(([label, n]) => `${label} ${n} 张`).join("、");

  const guard = (p: Promise<unknown>) => p.then(() => { setErr(""); load(); }).catch((e) => setErr(e.message));
  const add = () => guard(call("fact.upsert", { kind, data: draft, grade: "本人确认" }).then(() => { setDraft({}); setHint(""); }));
  const saveEdit = (f: any) => guard(call("fact.upsert", { id: f.id, kind: f.kind, data: editing!.data, grade: "本人确认" }).then(() => setEditing(null)));
  const quickAdd = (k: string, keyword: string) => guard(call("fact.upsert", { kind: k, data: { keyword }, grade: "本人确认" }));
  const confirmFact = (f: any) => guard(call("fact.upsert", { id: f.id, kind: f.kind, data: f.data, grade: "本人确认" }));
  const restore = (id: string) => guard(call("fact.restore", { id }).then(() => setUndo(null)));
  // drag a card onto another of the same kind: it takes that place. Shown at once, saved in the background, kept across restarts.
  const drop = (target: any) => {
    const from = drag?.id; setDrag(null);
    if (!from || from === target.id) return;
    const rows = facts.filter((f) => f.kind === target.kind);
    const moving = rows.find((f) => f.id === from); if (!moving) return;
    const rest = rows.filter((f) => f.id !== from);
    rest.splice(rest.findIndex((f) => f.id === target.id) + (rows.indexOf(moving) < rows.indexOf(target) ? 1 : 0), 0, moving);
    setFacts((all) => [...all.filter((f) => f.kind !== target.kind), ...rest]);
    call("fact.reorder", { ids: rest.map((f) => f.id) }).catch((e) => { setErr(e.message); load(); });
  };
  // no "are you sure?": deleting is reversible, so offer undo instead of asking first
  const remove = (f: any) => guard(call("fact.remove", { id: f.id }).then(() => {
    setUndo({ id: f.id, statement: f.statement });
    window.clearTimeout(undoTimer.current);
    undoTimer.current = window.setTimeout(() => setUndo(null), 8000);
  }));

  return (
    <>
      <div className="flex items-start">
        <div className="flex-1"><H1 sub="推荐、选简历、网申都从这里取值">资料</H1></div>
        <button onClick={() => setDrawer(true)} className="mt-1 flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm border border-line bg-paper text-ink-2 hover:bg-ground" title="找回最近删掉的卡"><Trash2 size={15} />最近删除{trash.length > 0 && <span className="text-ink-3">· {trash.length}</span>}</button>
      </div>
      <ImportPanel onChanged={load} />
      {err && <div className="text-bad mb-3">{err}</div>}
      {gaps.length > 0 && (
        <Card className="px-4 py-3 mb-4">
          <div className="text-sm font-bold mb-2">还缺 {gaps.length} 项 <span className="text-xs text-ink-3 font-normal">网申会问到，点一项就地补上</span></div>
          <div className="flex gap-1.5 flex-wrap">{gaps.map((g) => (
            <button key={g.kind + g.field} onClick={() => fillGap(g)} title={g.hint}><Chip tone={g.asked ? "amber" : ""}>{g.field}{g.asked ? ` · 问过 ${g.asked} 次` : ""}</Chip></button>
          ))}</div>
        </Card>
      )}
      {dupSummary && <div className="text-sm bg-amber-soft text-amber rounded-md px-3 py-2 mb-4">可能重复：{dupSummary}。重复就删一张，不是就点「确认」。</div>}
      <Card className="p-4 mb-5">
        <div ref={addForm} className="flex gap-1.5 flex-wrap mb-3 items-center">
          <span className="text-xs text-ink-3 mr-1">手动添加</span>
          {Object.entries(KINDS).map(([k, [label]]) => <button key={k} onClick={() => { setKind(k); setDraft({}); setHint(""); }}><Chip tone={kind === k ? "accent" : ""}>{label}</Chip></button>)}
        </div>
        <div className="grid grid-cols-2 gap-2"><Fields kind={kind} value={draft} onChange={setDraft} facets={facets} onEnter={add} /></div>
        {hint && <div className="text-xs text-accent mt-2">{draft.field ? `「${draft.field}」：` : ""}{hint}</div>}
        {(kind === "direction" || kind === "exclude") && sug && (kind === "direction" ? sug.include : sug.exclude).length > 0 && (
          <div className="mt-3 text-xs text-ink-3 flex gap-1.5 flex-wrap items-center">
            <span>命中岗位里常见的词，点一下加入：</span>
            {(kind === "direction" ? sug.include : sug.exclude).map((x: any) => <button key={x.word} onClick={() => quickAdd(kind, x.word)}><Chip tone={kind === "direction" ? "accent" : "amber"}>{x.word} {x.count}</Chip></button>)}
          </div>
        )}
        <div className="mt-3"><Button tone="primary" onClick={add}>添加</Button></div>
      </Card>
      {facts.length === 0 ? <Empty>还没有事实卡。导入简历，或在上面手填。</Empty> : Object.entries(KINDS).map(([k, [label]]) => {
        const rows = facts.filter((f) => f.kind === k);
        if (!rows.length) return null;
        return (
          <div key={k} className="mb-4">
            <div className="text-sm font-bold mb-1.5">{label} · {rows.length}</div>
            <Card>
              {rows.map((f) => editing?.id === f.id ? (
                <div key={f.id} id={`fact-${f.id}`} className="px-4 py-3 border-t first:border-t-0 border-line bg-accent-soft/30">
                  <div className="grid grid-cols-2 gap-2"><Fields kind={f.kind} value={editing!.data} onChange={(data) => setEditing({ id: f.id, data })} facets={facets} onEnter={() => saveEdit(f)} /></div>
                  <div className="mt-2 flex gap-2 items-center"><Button tone="primary" onClick={() => saveEdit(f)}>保存</Button><Button onClick={() => setEditing(null)}>取消</Button><span className="ml-auto"><Sources sources={f.sources} /></span></div>
                </div>
              ) : (
                <div key={f.id} draggable={rows.length > 1} onDragStart={(e) => { e.dataTransfer.effectAllowed = "move"; setDrag({ id: f.id, over: f.id }); }}
                  onDragOver={(e) => { if (drag && facts.find((x) => x.id === drag.id)?.kind === f.kind) { e.preventDefault(); if (drag.over !== f.id) setDrag({ ...drag, over: f.id }); } }}
                  onDrop={() => drop(f)} onDragEnd={() => setDrag(null)}
                  className={`px-4 py-2.5 border-t first:border-t-0 border-line flex items-center gap-2 text-sm ${drag?.id === f.id ? "opacity-40" : ""} ${drag && drag.over === f.id && drag.id !== f.id ? "bg-accent-soft/40" : ""}`}>
                  {rows.length > 1 && <GripVertical size={14} className="text-ink-3 cursor-grab shrink-0 -ml-2" />}
                  <span className="flex-1 min-w-0">{f.statement}</span>
                  {flaggedIds.has(f.id) && <Chip tone="amber">可能重复</Chip>}
                  <Sources sources={f.sources} />
                  <Chip tone={gradeTone(f.grade)}>{f.grade}</Chip>
                  {f.grade !== "本人确认" && <Button onClick={() => confirmFact(f)}>确认</Button>}
                  <Button onClick={() => setEditing({ id: f.id, data: { ...f.data } })}>改</Button><Button tone="danger" onClick={() => remove(f)}>删</Button>
                </div>
              ))}
            </Card>
          </div>
        );
      })}
      {undo && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-20 bg-ink text-paper rounded-md shadow-lg px-4 py-2.5 text-sm flex items-center gap-3 max-w-[40rem]">
          <span className="truncate">已删除「{undo.statement}」</span>
          <button className="underline shrink-0" onClick={() => restore(undo.id)}>撤销</button>
        </div>
      )}
      {drawer && <TrashDrawer items={trash} onClose={() => setDrawer(false)} onRestore={restore} />}
    </>
  );
}
