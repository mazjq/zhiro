import type { SourceContext } from "./types.js";

/** Minimal http context; providers vendored from career-ops expect fetchJson/fetchText/sleep. */
export function httpContext(log: (m: string) => void = () => {}, signal?: AbortSignal): SourceContext {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
  const withTimeout = async (url: string, opts: any = {}) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
    signal?.addEventListener("abort", () => ctl.abort(), { once: true });
    try {
      // a reason code first (sync.ts reasonOf); the regex there stays only for errors thrown below fetch (DNS, reset…)
      const res = await fetch(url, { ...opts, headers: { "user-agent": ua, ...(opts.headers ?? {}) }, signal: ctl.signal }).catch((e) => { throw new Error(`${ctl.signal.aborted ? "TIMEOUT" : "SITE_DOWN"}: ${e?.cause?.code ?? e?.message ?? e} ${url}`); });
      if (!res.ok) throw new Error(`${res.status === 401 ? "LOGIN_REQUIRED" : res.status === 403 || res.status === 429 ? "BLOCKED" : "SITE_DOWN"}: HTTP ${res.status} ${url}`);
      if (opts.expectJson !== false && /fetchJson/.test(opts.__kind ?? "") && !/json/.test(res.headers.get("content-type") ?? "")) throw new Error(`SCHEMA_CHANGED: 没返回 JSON ${url}`);
      return res;
    } finally {
      clearTimeout(t);
    }
  };
  return {
    fetchJson: (url, opts) => withTimeout(url, { ...(opts ?? {}), __kind: "fetchJson" }).then((r) => r.json()),
    fetchText: (url, opts) => withTimeout(url, opts).then((r) => r.text()),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    signal,
    log,
  };
}

const PRIVATE_HOST = /^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.|\[::1\]|\[fe80|\[fc|\[fd|172\.(1[6-9]|2\d|3[01])\.)/i;
/** An http(s) address out on the internet — not this machine, not the local network, not a bare number for a host. */
export const publicUrl = (u: string): boolean => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) && !PRIVATE_HOST.test(x.hostname) && !/^\d+$/.test(x.hostname); } catch { return false; } };

/** An absolute path on this machine (D:\…, \\server\…, /home/…), not a link. */
export const isLocalPath = (s: string): boolean => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(s.trim());
