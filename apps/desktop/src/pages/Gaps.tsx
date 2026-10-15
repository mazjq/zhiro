import { useEffect, useState } from "react";
import { call } from "../api";
import { useLatest, useOnDataChange } from "../refresh";
import { H1, Card, Chip, Empty } from "../ui";

/**
 * 机会缺口 (ADR-035), read side: what task-related posts asked for that the profile could not confirm, grouped by
 * capability. 待核实 is "the profile never mentions it" — the user answers 我会 (a skill card, evidence from now on) or
 * 没做过 (a confirmed gap, the matcher's only negative). Counts are posts and distinct companies.
 */
const STATUS: Record<string, { label: string; tone: "" | "amber" | "accent"; hint: string }> = {
  unknown: { label: "待核实", tone: "amber", hint: "画像里没提到，不代表不会：答一下就能定" },
  transferable: { label: "有相关经历，但不完全对口", tone: "accent", hint: "比如你在海洋平台上做过动力学建模，岗位要的是机器人的；或岗位要「有项目经验」而你只有技能卡" },
  gap: { label: "已确认没做过", tone: "", hint: "你确认过的缺口；补上经历后点撤回" },
};

export default function Gaps() {
  const [d, setD] = useState<any>(null);
  const [busy, setBusy] = useState("");
  const [note, setNote] = useState("");
  const latest = useLatest();
  // a refresh that fails keeps the list on screen; only a first load with nothing to show falls back to empty
  const load = () => latest("gaps", call("gap.list", {})).then(setD).catch(() => setD((x: any) => x ?? { items: [], assessed: 0, related: 0 }));
  useEffect(() => { load(); }, []);
  useOnDataChange(load);
  const say = async (row: any, what: "know" | "no" | "clear") => {
    setBusy(row.conceptId);
    // shown at once: the row moves (or goes) now; the daemon reruns the matcher for a few seconds, then the list reloads
    setD((x: any) => ({ ...x, items: what === "know" ? x.items.filter((r: any) => r.conceptId !== row.conceptId) : x.items.map((r: any) => (r.conceptId === row.conceptId ? { ...r, status: what === "no" ? "gap" : "unknown" } : r)) }));
    setNote(what === "know" ? `已记下「${row.label}」为你的技能，正在重算相关岗位…` : what === "no" ? `已记下「${row.label}」没做过，正在重算相关岗位…` : `已撤回「${row.label}」，正在重算…`);
    try {
      if (what === "know") await call("fact.upsert", { kind: "skill", data: { name: row.label } });
      else await call("gap.confirm", { conceptId: row.conceptId, status: what === "no" ? "confirmed" : "cleared", note: what === "no" ? "没做过" : "" });
      setTimeout(() => { load(); setNote(""); }, 5000);
    } catch (e: any) { setNote(e.message); load(); } finally { setBusy(""); }
  };
  if (!d) return null;
  const groups = ["unknown", "transferable", "gap"].map((st) => [st, d.items.filter((x: any) => x.status === st)] as const);
  return (
    <>
      <H1 sub={`和你工作相关的 ${d.related} 个岗位里，规则没能确认的要求，按「作为核心要求出现的次数」排序；答一下「我会 / 没做过」，相关岗位会重算。点错了：「我会」记的是画像里的一张技能卡，去 求职资料 → 画像 删掉即可；「没做过」可直接撤回`}>机会缺口</H1>
      {note && <div className="text-xs bg-amber-soft text-amber rounded px-3 py-2 mb-3">{note}</div>}
      {d.items.length === 0 ? <Empty>还没有可统计的缺口：等推荐重算后再看</Empty> : groups.map(([st, rows]) => rows.length > 0 && (
        <div key={st} className="mb-5">
          <div className="text-sm font-bold mb-1 flex items-center gap-2"><Chip tone={STATUS[st].tone}>{STATUS[st].label}</Chip><span className="text-xs text-ink-3 font-normal">{STATUS[st].hint}</span></div>
          <Card>
            {rows.map((r: any) => (
              <div key={r.conceptId} className="px-4 py-2.5 border-t first:border-t-0 border-line text-sm">
                <div className="flex items-center gap-2">
                  <span className="font-medium">{r.label}</span>
                  <span className="text-xs text-ink-3">{r.positions} 个岗位 · {r.companies} 家公司{r.core ? ` · ${r.core} 次为核心要求` : ""}</span>
                  <span className="ml-auto flex gap-3 text-xs">
                    {st !== "gap" && <button className="text-accent" disabled={busy === r.conceptId} onClick={() => say(r, "know")} title="记一张技能卡，之后按有证据算">我会</button>}
                    {st !== "gap" && <button className="text-ink-2" disabled={busy === r.conceptId} onClick={() => say(r, "no")} title="只记「没做过」：不影响别的能力">没做过</button>}
                    {st === "gap" && <button className="text-accent" disabled={busy === r.conceptId} onClick={() => say(r, "clear")}>撤回</button>}
                  </span>
                </div>
                <div className="text-xs text-ink-3 mt-1">{r.examples.map((e: any) => <div key={e.positionId} className="truncate" title={e.quote}>{e.company} · {e.title} <span className="text-ink-3/70">— {e.quote}</span></div>)}</div>
              </div>
            ))}
          </Card>
        </div>
      ))}
    </>
  );
}
