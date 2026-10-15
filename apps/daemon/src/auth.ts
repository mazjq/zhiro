/**
 * Who is calling — decided by the credential the request carries, never by what it says about itself (ADR-045).
 *
 * Four credentials, three of them files in vault/config, one issued per chat turn:
 *   .daemon-token   the person: the Tauri window (read from disk), scripts
 *   .agent-token    any agent of the person's: the MCP forwarder, a harness opened in the agent directory
 *   .capture-key    the bookmarklet, good for listing.capture only
 *   turn token      a harness the daemon itself started for one chat turn (embedded); gone when the turn ends
 * plus a browser session: a one-time launch code (printed at start, made by the tray) exchanged for an HttpOnly cookie,
 * so the page's JavaScript never holds a token.
 *
 * The credential sets the ceiling; the x-jobos-actor header can only lower it (a person may act as an agent, an agent
 * can never act as the person) and otherwise just labels the audit row.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Actor } from "./registry.js";

export interface Credentials { human: string; agent: string; capture: string }

function loadOrCreate(path: string): string {
  if (existsSync(path)) return readFileSync(path, "utf8").trim();
  const t = randomBytes(24).toString("hex");
  writeFileSync(path, t, { encoding: "utf8", mode: 0o600 });
  return t;
}

export function loadCredentials(vault: string): Credentials {
  const c = join(vault, "config");
  return { human: loadOrCreate(join(c, ".daemon-token")), agent: loadOrCreate(join(c, ".agent-token")), capture: loadOrCreate(join(c, ".capture-key")) };
}

export type Principal =
  | { kind: "human"; cred: "daemon" | "session" }
  | { kind: "agent"; cred: "agent" }
  | { kind: "agent"; cred: "turn"; turnId: string };

const HUMAN_VIA = new Set(["desktop", "cli", "feishu", "mcp-human"]);
/** An audit label, nothing more: letters, digits, dashes; anything else is "mcp". */
export const sanitizeVia = (v: string | undefined): string => (/^[a-z0-9-]{1,32}$/i.test(v ?? "") ? (v as string).toLowerCase() : "mcp");

const eq = (a: string, b: string) => { const x = Buffer.from(a), y = Buffer.from(b); return x.length === y.length && timingSafeEqual(x, y); };
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const fresh = () => randomBytes(24).toString("hex");

export const LAUNCH_TTL_MS = 10 * 60_000; // a link printed in a terminal is clicked within minutes, not seconds
export const TICKET_TTL_MS = 60_000;
export const SESSION_TTL_MS = 30 * 24 * 3600_000;

export class Auth {
  private launches = new Map<string, number>();
  private tickets = new Map<string, number>();
  private sessions = new Map<string, number>();
  private turns = new Map<string, { turnId: string; expires: number }>(); // sha256(token) → turn; the token itself is never stored

  /**
   * Browser sessions outlive the daemon: a person logs in once per browser, not once per restart. They are kept hashed
   * in vault/config/.sessions.json; the cookie value itself is never written down.
   */
  private sessionsFile: string | null = null;
  constructor(readonly creds: Credentials, private now: () => number = Date.now, vault?: string) {
    if (vault) {
      this.sessionsFile = join(vault, "config", ".sessions.json");
      try { for (const [k, exp] of Object.entries(JSON.parse(readFileSync(this.sessionsFile, "utf8")) as Record<string, number>)) if (exp > this.now()) this.sessions.set(k, exp); } catch { /* none yet */ }
    }
  }
  private persistSessions(): void {
    if (!this.sessionsFile) return;
    try { writeFileSync(this.sessionsFile, JSON.stringify(Object.fromEntries(this.sessions)), { encoding: "utf8", mode: 0o600 }); } catch { /* the login still works until the next restart */ }
  }

  /** The bearer token or the session cookie → who this is; null when neither is good. */
  principalOf(bearer: string | undefined, cookie: string | undefined): Principal | null {
    if (bearer) {
      if (eq(bearer, this.creds.human)) return { kind: "human", cred: "daemon" };
      if (eq(bearer, this.creds.agent)) return { kind: "agent", cred: "agent" };
      const t = this.turns.get(hash(bearer));
      if (t && t.expires > this.now()) return { kind: "agent", cred: "turn", turnId: t.turnId };
      return null;
    }
    if (cookie) { const exp = this.sessions.get(hash(cookie)); if (exp && exp > this.now()) return { kind: "human", cred: "session" }; }
    return null;
  }

  /** The principal plus the header → the actor the registry sees. The header only ever lowers. */
  actorOf(p: Principal, viaHeader: string | undefined): Actor {
    if (p.kind === "human") {
      if (!viaHeader || HUMAN_VIA.has(viaHeader)) return { kind: "human", via: (viaHeader ?? "desktop") as any };
      return { kind: "agent", via: sanitizeVia(viaHeader), cred: "agent" }; // the person choosing to act as an agent
    }
    if (p.cred === "turn") return { kind: "agent", via: sanitizeVia(viaHeader), cred: "turn", turnId: p.turnId };
    return { kind: "agent", via: sanitizeVia(viaHeader), cred: "agent" };
  }

  isCaptureKey(k: string | undefined): boolean { return !!k && eq(k, this.creds.capture); }

  // ---------- browser session: launch code → cookie, or the person's key pasted once → cookie ----------
  newLaunch(): string { this.sweep(); const c = fresh(); this.launches.set(c, this.now() + LAUNCH_TTL_MS); return c; }
  newSession(): string { this.sweep(); const s = fresh(); this.sessions.set(hash(s), this.now() + SESSION_TTL_MS); this.persistSessions(); return s; }
  /** One use: the code is gone whether or not it was still valid. */
  redeemLaunch(code: string | undefined): string | null {
    if (!code) return null;
    const exp = this.launches.get(code);
    this.launches.delete(code);
    if (!exp || exp <= this.now()) return null;
    return this.newSession();
  }

  // ---------- event stream for a client that holds a bearer token (EventSource cannot set headers) ----------
  newTicket(): string { this.sweep(); const t = fresh(); this.tickets.set(t, this.now() + TICKET_TTL_MS); return t; }
  redeemTicket(t: string | undefined): boolean {
    if (!t) return false;
    const exp = this.tickets.get(t);
    this.tickets.delete(t);
    return !!exp && exp > this.now();
  }

  // ---------- one chat turn of an embedded harness ----------
  issueTurn(turnId: string, ttlMs: number): string { const t = fresh(); this.turns.set(hash(t), { turnId, expires: this.now() + ttlMs }); return t; }
  revokeTurn(turnId: string): void { for (const [k, v] of this.turns) if (v.turnId === turnId) this.turns.delete(k); }

  private sweep(): void {
    const t = this.now();
    for (const m of [this.launches, this.tickets, this.sessions]) for (const [k, exp] of m) if (exp <= t) m.delete(k);
    for (const [k, v] of this.turns) if (v.expires <= t) this.turns.delete(k);
  }
}
