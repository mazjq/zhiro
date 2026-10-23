/**
 * S1 maintenance mode: the data is opened to be looked at, not changed — for checking an upgrade or a new build against
 * a copy (or the real folder before a switch). Writes are refused in callTool, the schedules are not started (main.ts),
 * and nothing reaches the network: a "read" tool can still fetch (page.read, the public-data tools), so the guard is
 * on fetch itself, plus what goes around it: a browser (page.read, apply.*, a site preview), the mailbox (inbox.peek
 * talks IMAP), and data.export (labelled a read, it writes a file).
 */
/** A tool that reaches outside this computer's database: the internet (effects.network) or the application browser. */
export const reachesOutside = (name: string, effects: { network?: boolean }) => !!effects.network || name.startsWith("apply.");

export function enterMaintenance(): void {
  const real = globalThis.fetch;
  globalThis.fetch = (async (input: any, init?: any) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "127.0.0.1" || url.hostname === "localhost") return real(input, init);
    const e: any = new Error(`MAINTENANCE: 维护模式不联网（${url.hostname}）`);
    e.code = "MAINTENANCE";
    throw e;
  }) as typeof fetch;
}
