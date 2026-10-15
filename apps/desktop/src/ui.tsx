import type { ReactNode } from "react";

export function H1({ children, sub }: { children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="mb-6">
      <h1 className="text-2xl font-bold tracking-tight">{children}</h1>
      {sub && <div className="text-ink-3 mt-1">{sub}</div>}
    </div>
  );
}

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return <div className={`bg-paper border border-line rounded-lg ${className}`}>{children}</div>;
}

export function Stat({ label, value, tone = "" }: { label: string; value: ReactNode; tone?: "amber" | "good" | "bad" | "" }) {
  const color = tone === "amber" ? "text-amber" : tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink";
  return (
    <Card className="px-5 py-4">
      <div className="text-xs text-ink-3">{label}</div>
      <div className={`text-2xl font-bold tabular mt-1 ${color}`}>{value}</div>
    </Card>
  );
}

export function Chip({ children, tone = "" }: { children: ReactNode; tone?: "accent" | "amber" | "good" | "bad" | "" }) {
  const cls = { accent: "bg-accent-soft text-accent", amber: "bg-amber-soft text-amber", good: "bg-good-soft text-good", bad: "bg-bad-soft text-bad", "": "bg-ground text-ink-2 border border-line" }[tone];
  return <span className={`inline-block text-[11.5px] px-2 py-0.5 rounded-full font-mono ${cls}`}>{children}</span>;
}

export function Button({ children, onClick, tone = "", disabled, title }: { children: ReactNode; onClick?: () => void; tone?: "primary" | "danger" | ""; disabled?: boolean; title?: string }) {
  const cls = tone === "primary" ? "bg-accent text-white hover:opacity-90" : tone === "danger" ? "bg-bad-soft text-bad hover:opacity-90" : "bg-paper border border-line text-ink-2 hover:bg-ground";
  return <button disabled={disabled} onClick={onClick} title={title} className={`px-3 py-1.5 rounded-md text-sm disabled:opacity-40 ${cls}`}>{children}</button>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="text-ink-3 text-sm py-10 text-center border border-dashed border-line rounded-lg">{children}</div>;
}

/** Application states as the user reads them. 待投 = picked but not applied yet; nothing is "已投" until the user says so. */
export const STATE_LABEL: Record<string, string> = { draft: "准备申请", submitted: "已投递", in_process: "流程中", closed: "已结束", cancelled: "已取消" };

export function gradeTone(g: string): "good" | "accent" | "amber" | "" {
  return g === "官方" ? "good" : g === "校方转载" ? "accent" : g === "聚合" ? "amber" : "";
}

/** A post's resolved deadline in a few characters; the full sentence goes in the tooltip (ADR-041). */
export function deadlineShort(d: any): string {
  if (!d) return "";
  const more = (d.status === "unverified" ? " · 待核实" : "") + (d.conflicts?.length ? " · 有分歧" : "");
  if (d.date) return `${d.expired ? "已截止" : "截止"} ${d.date.slice(5)}${more}`;
  if (d.scope === "unspecified") return "截止未确认";
  return d.policy === "unknown" ? "截止未核实" : `宜尽早${more}`;
}

export function deadlineTone(days: number | null): "bad" | "amber" | "" {
  if (days == null) return "";
  return days <= 3 ? "bad" : days <= 7 ? "amber" : "";
}
