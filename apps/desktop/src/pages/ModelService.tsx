import { useEffect, useRef, useState } from "react";
import { call } from "../api";
import { useOnDataChange } from "../refresh";
import { Card, Chip, Button } from "../ui";

const input = "px-3 py-1.5 border border-line rounded-md bg-paper text-sm min-w-0";
const STATE: Record<string, [string, "good" | "amber" | "bad" | ""]> = { ready: ["已配置", "good"], awaiting_user: ["配置中", "amber"], signed_out: ["未登录", ""], error: ["配置异常", "bad"] };

/**
 * 模型服务 — same interaction as FortheFuture's settings module (both apps sit on pi's model layer):
 * 供应商 → 认证方式 → 登录（浏览器自动打开；需要时粘贴授权码 / 设备码 / API key）→ 选模型。Changes apply at once.
 */
// a component of its own (not made in render): its inputs keep focus while the person types
const Box = ({ inside, children }: { inside: boolean; children: any }) => (inside ? <div className="mt-3 pt-3 border-t border-line">{children}</div> : <Card className="p-5 mb-4">{children}</Card>);

/** inside: drawn as a part of the 「AI 用哪家」 card (it serves 内置助手 and 后台整理, not a choice beside them) */
export default function ModelService({ inside = false }: { inside?: boolean }) {
  const title = inside ? "内置模型（内置助手和后台整理用）" : "内置模型";
  const [st, setSt] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [answer, setAnswer] = useState("");
  const [test, setTest] = useState<any>(null);
  const opened = useRef("");

  const run = async (tool: string, args: unknown = {}) => { setBusy(true); setErr(""); try { setSt(await call(tool, args)); } catch (e: any) { setErr(e.message); } finally { setBusy(false); } };
  // switching is instant on the daemon: show the choice at once and don't grey the controls out, or it reads as a stall
  const choose = async (providerId: string, authType: string) => {
    setErr(""); setSt((s: any) => ({ ...s, providerId, authType }));
    try { setSt(await call("model.provider", { providerId, authType })); } catch (e: any) { setErr(e.message); call("model.status").then(setSt).catch(() => {}); }
  };
  useEffect(() => { call("model.status").then(setSt).catch((e) => setErr(e.message)); }, []);
  useOnDataChange(() => { if (!busy && st?.state !== "awaiting_user") call("model.status").then(setSt).catch(() => {}); }); // not in the middle of a login: that is polled, and the code being typed stays
  // while a login is in progress the daemon's state moves on its own (browser callback, device-code approval)
  useEffect(() => { if (st?.state !== "awaiting_user") return; const t = setInterval(() => call("model.status").then(setSt).catch(() => {}), 2500); return () => clearInterval(t); }, [st?.state]);
  // open the provider's login page once per attempt, like a desktop app would
  useEffect(() => { const url = st?.auth?.url; if (url && opened.current !== url) { opened.current = url; window.open(url, "_blank", "noopener"); } }, [st?.auth?.url]);

  if (!st) return <Box inside={inside}><div className="font-bold">{title}</div><div className="text-sm text-ink-3 mt-1">{err || "加载中…"}</div></Box>;
  const provider = st.providers.find((p: any) => p.id === st.providerId);
  const method = provider?.methods.find((m: any) => m.id === st.authType) ?? provider?.methods[0];
  const locked = st.state === "awaiting_user";
  const prompt = st.auth?.prompt;

  return (
    <Box inside={inside}>
      <div className="flex items-center gap-2 mb-3 min-h-8">
        <div className="font-bold">{title}</div><Chip tone={STATE[st.state]?.[1] ?? ""}>{STATE[st.state]?.[0] ?? st.state}</Chip>
        {st.state === "ready" && <span className="text-xs text-ink-3 font-mono">{st.modelId}</span>}
        {st.state === "ready" && st.providerId !== "external" && <span className="ml-auto"><Button disabled={busy} onClick={async () => { setTest(null); setBusy(true); try { setTest(await call("llm.test")); } finally { setBusy(false); } }}>测试</Button></span>}
      </div>
      <div className="grid grid-cols-[1fr_auto] gap-3 items-end">
        <label className="text-xs text-ink-3">供应商
          <select value={st.providerId} disabled={locked} className={`${input} w-full mt-1 block`}
            onChange={(e) => { const p = st.providers.find((x: any) => x.id === e.target.value); if (p) choose(p.id, p.methods[0]?.id ?? "api_key"); }}>
            {!provider && <option value={st.providerId}>{st.providerId}</option>}
            {st.providers.map((p: any) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </label>
        <div><div className="text-xs text-ink-3 mb-1">认证方式</div>
          <div className="flex border border-line rounded-md overflow-hidden">{(provider?.methods ?? []).map((m: any) => (
            <button key={m.id} disabled={locked} onClick={() => choose(st.providerId, m.id)} className={`px-3 py-1.5 text-sm ${m.id === method?.id ? "bg-accent-soft text-accent" : "bg-paper text-ink-2"}`}>{m.label}</button>
          ))}</div>
        </div>
      </div>

      {(st.state === "signed_out" || st.state === "error") && method && <div className="mt-3 min-h-[57px] flex items-end"><Button tone="primary" disabled={busy} onClick={() => run("model.login")}>{method.kind === "api" ? "配置" : "登录"}</Button></div>}

      {locked && (
        <div className="mt-3 border border-line rounded-md p-3 bg-ground/60 text-sm space-y-2">
          {st.auth?.notice && <div className="text-ink-2">{st.auth.notice}</div>}
          <div className="flex gap-2 flex-wrap">
            {st.auth?.url && <Button onClick={() => window.open(st.auth.url, "_blank", "noopener")}>打开认证页面</Button>}
            {(st.auth?.links ?? []).filter((l: any) => l.url !== st.auth?.url).map((l: any) => <Button key={l.url} onClick={() => window.open(l.url, "_blank", "noopener")}>{l.label || "打开相关页面"}</Button>)}
          </div>
          {st.auth?.deviceCode && <div>设备码 <code className="font-mono text-base mx-1">{st.auth.deviceCode.userCode}</code><Button onClick={() => navigator.clipboard?.writeText(st.auth.deviceCode.userCode)}>复制</Button><div className="text-xs text-ink-3 mt-1">{st.auth.deviceCode.verificationUrl}</div></div>}
          {prompt?.type === "select" && <div><div className="text-xs text-ink-3 mb-1">{prompt.label}</div><div className="flex gap-2 flex-wrap">{(prompt.options ?? []).map((o: any) => <Button key={o.id} disabled={busy} onClick={() => run("model.answer", { attemptId: st.auth.attemptId, promptId: prompt.id, value: o.id })}>{o.label}</Button>)}</div></div>}
          {prompt && prompt.type !== "select" && (
            <form className="flex gap-2 items-end" onSubmit={(e) => { e.preventDefault(); if (answer.trim()) run("model.answer", { attemptId: st.auth.attemptId, promptId: prompt.id, value: answer.trim() }).then(() => setAnswer("")); }}>
              <label className="text-xs text-ink-3 flex-1">{prompt.label}<input value={answer} onChange={(e) => setAnswer(e.target.value)} type={prompt.type === "secret" ? "password" : "text"} autoComplete="off" placeholder={prompt.placeholder ?? ""} className={`${input} w-full mt-1 block`} /></label>
              <Button tone="primary" disabled={busy || !answer.trim()}>继续</Button>
            </form>
          )}
          <Button disabled={busy} onClick={() => run("model.cancel")}>取消</Button>
        </div>
      )}

      {st.state === "ready" && (
        <div className="mt-3 min-h-[57px] flex items-end gap-2">
          <label className="text-xs text-ink-3 flex-1">模型
            <select value={st.modelKnown ? st.modelId : ""} disabled={busy} onChange={(e) => e.target.value && run("model.select", { modelId: e.target.value })} className={`${input} w-full mt-1 block`}>
              {!st.modelKnown && <option value="">{st.modelId ? `${st.modelId}（不在列表中）` : "请选择模型"}</option>}
              {st.models.map((m: any) => <option key={m.id} value={m.id}>{m.name}</option>)}
            </select>
          </label>
          {st.providerId !== "external" && <Button disabled={busy} onClick={() => run("model.refresh")}>获取最新模型</Button>}
        </div>
      )}
      {(err || st.error) && <div className="text-sm text-bad mt-2">{err || st.error}</div>}
      {test && <div className={`text-sm mt-2 ${test.ok ? "text-good" : "text-bad"}`}>{test.ok ? `可用 · ${(test.latencyMs / 1000).toFixed(1)} 秒` : `不可用：${test.error}`}</div>}
    </Box>
  );
}
