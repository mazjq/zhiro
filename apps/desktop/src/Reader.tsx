import { useEffect, type ReactNode } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";

/**
 * A report to read: slides in from the right over the page, the text rendered (headings, lists, tables, links), Esc or
 * a click outside closes it. Raw HTML in the text is not rendered — reports are written from web pages and by agents.
 */
export function Reader({ title, sub, markdown, children, onClose }: { title: string; sub?: ReactNode; markdown: string; children?: ReactNode; onClose: () => void }) {
  useEffect(() => {
    const esc = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", esc);
    return () => window.removeEventListener("keydown", esc);
  }, [onClose]);
  // a stored report starts with its front matter (company, run, date): that belongs to the file, not to the reading
  const body = markdown.replace(/^---\n[\s\S]*?\n---\n/, "");
  return (
    <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 bg-black/20" onClick={onClose} />
      <div className="relative h-full w-full max-w-3xl bg-paper border-l border-line shadow-xl flex flex-col">
        <div className="flex items-start gap-3 px-6 py-4 border-b border-line">
          <div className="flex-1 min-w-0">
            <div className="font-bold text-lg truncate">{title}</div>
            {sub && <div className="text-xs text-ink-3 mt-0.5">{sub}</div>}
          </div>
          <button onClick={onClose} className="px-2 py-1 rounded text-ink-3 hover:bg-ground" title="关闭（Esc）">✕</button>
        </div>
        <div className="flex-1 overflow-auto px-6 py-5 text-[14.5px] leading-7 text-ink">
          <Markdown
            remarkPlugins={[remarkGfm]}
            components={{
              h1: (p) => <h2 className="text-xl font-bold mt-6 mb-2" {...p} />,
              h2: (p) => <h2 className="text-lg font-bold mt-6 mb-2 pb-1 border-b border-line" {...p} />,
              h3: (p) => <h3 className="text-base font-bold mt-4 mb-1" {...p} />,
              h4: (p) => <h4 className="font-bold mt-3 mb-1" {...p} />,
              p: (p) => <p className="my-2" {...p} />,
              ul: (p) => <ul className="list-disc pl-6 my-2 space-y-0.5" {...p} />,
              ol: (p) => <ol className="list-decimal pl-6 my-2 space-y-0.5" {...p} />,
              a: ({ node: _n, ...p }) => <a className="text-accent underline-offset-2 hover:underline break-all" target="_blank" rel="noreferrer" {...p} />,
              table: (p) => <div className="overflow-x-auto my-3"><table className="text-[13px] border-collapse w-full" {...p} /></div>,
              th: (p) => <th className="border border-line bg-ground px-2 py-1 text-left font-bold" {...p} />,
              td: (p) => <td className="border border-line px-2 py-1 align-top" {...p} />,
              code: (p) => <code className="font-mono text-[13px] bg-ground rounded px-1" {...p} />,
              blockquote: (p) => <blockquote className="border-l-4 border-line pl-3 text-ink-2 my-2" {...p} />,
              hr: () => <hr className="my-4 border-line" />,
            }}
          >
            {body}
          </Markdown>
          {children}
        </div>
      </div>
    </div>
  );
}
