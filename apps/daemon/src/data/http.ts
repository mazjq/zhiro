import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";
import type { SourceContext } from "./types.js";

/** Minimal http context; providers vendored from career-ops expect fetchJson/fetchText/sleep. */
export function httpContext(log: (m: string) => void = () => {}, signal?: AbortSignal, stats?: { requests: number }): SourceContext {
  const ua = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
  const withTimeout = async (url: string, opts: any = {}) => {
    if (stats) stats.requests++;
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), opts.timeoutMs ?? 20_000);
    signal?.addEventListener("abort", () => ctl.abort(), { once: true });
    try {
      // a reason code first (sync.ts reasonOf); the regex there stays only for errors thrown below fetch (DNS, reset…)
      const res = await guardedFetch(url, { ...opts, headers: { "user-agent": ua, ...(opts.headers ?? {}) }, signal: ctl.signal }).catch((e) => { if (/^(BLOCKED|SITE_DOWN): /.test(e?.message ?? "")) throw e; throw new Error(`${ctl.signal.aborted ? "TIMEOUT" : "SITE_DOWN"}: ${e?.cause?.code ?? e?.message ?? e} ${url}`); });
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

// where a name may not point: this machine, the local network, link-local (cloud metadata 169.254.169.254), carrier NAT,
// multicast and reserved. 198.18/15 stays allowed: proxies in fake-ip mode (Clash) answer every name from it. IPv4-mapped IPv6 (::ffff:127.0.0.1) is matched by the IPv4 rules (node BlockList).
const NOT_PUBLIC = new BlockList();
for (const [a, p] of [["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12], ["192.0.0.0", 24], ["192.168.0.0", 16], ["224.0.0.0", 3]] as const) NOT_PUBLIC.addSubnet(a, p, "ipv4");
for (const [a, p] of [["::", 127], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8]] as const) NOT_PUBLIC.addSubnet(a, p, "ipv6");
export const publicAddress = (ip: string): boolean => { const v = isIP(ip); return v !== 0 && !NOT_PUBLIC.check(ip, v === 6 ? "ipv6" : "ipv4"); };

const hostOk = new Map<string, { ok: boolean; at: number }>();
/**
 * Throws BLOCKED unless the URL is http(s) on the internet by what its name resolves to now, not only by how it is
 * written (a public-looking name can point at 127.0.0.1). A name that does not resolve is left to the request to fail.
 * ponytail: checked before the request, not pinned to it — a name that answers public then private (DNS rebinding)
 * slips through; pin the address in the connection (undici Agent `connect.lookup`) if that ever matters.
 */
export async function assertPublic(url: string): Promise<void> {
  if (!publicUrl(url)) throw new Error(`BLOCKED: 只读公网上的地址，不读本机或内网：${url}`);
  const host = new URL(url).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) { if (!publicAddress(host)) throw new Error(`BLOCKED: 只读公网上的地址，不读本机或内网：${url}`); return; }
  const c = hostOk.get(host);
  let ok = c && Date.now() - c.at < 5 * 60_000 ? c.ok : undefined;
  if (ok === undefined) {
    const addrs = await lookup(host, { all: true, verbatim: true }).catch(() => null);
    if (!addrs) return;
    ok = addrs.every((a) => publicAddress(a.address));
    hostOk.set(host, { ok, at: Date.now() });
  }
  if (!ok) throw new Error(`BLOCKED: 这个域名指向本机或内网地址：${url}`);
}

/** fetch for addresses that came from outside: every hop of a redirect is checked as the first one is. */
export async function guardedFetch(url: string, init: RequestInit = {}, hops = 8): Promise<Response> {
  return (await guardedFetchTo(url, init, hops)).res;
}

/** guardedFetch, and the address it landed on after the redirects (a response's own `url` may be blank). */
export async function guardedFetchTo(url: string, init: RequestInit = {}, hops = 8): Promise<{ res: Response; url: string }> {
  if (init.redirect === "manual") { await assertPublic(url); return { res: await fetch(url, init), url }; } // the caller follows the hops itself
  for (let i = 0; ; i++) {
    await assertPublic(url);
    const res = await fetch(url, { ...init, redirect: "manual" });
    const to = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
    if (!to) return { res, url };
    await res.body?.cancel().catch(() => {});
    if (i >= hops) throw new Error(`SITE_DOWN: 跳转太多次 ${url}`);
    // what fetch's own follow does: 303, and 301 / 302 after a POST, go on as a GET without the body
    if (res.status === 303 || ((res.status === 301 || res.status === 302) && init.method && !/^(GET|HEAD)$/i.test(init.method))) init = { ...init, method: "GET", body: undefined };
    url = new URL(to, url).href;
  }
}

/** An absolute path on this machine (D:\…, \\server\…, /home/…), not a link. */
export const isLocalPath = (s: string): boolean => /^([a-zA-Z]:[\\/]|\\\\|\/)/.test(s.trim());
