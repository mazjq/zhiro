/**
 * 「你上次来过之后，本人在窗口里改了这些」(ADR-057): an external agent's tool result carries a short table of what the
 * person changed in the Zhiro window since that agent's previous call, so what it remembers from earlier in its
 * conversation does not go stale unnoticed.
 *
 * Read from the audit log: the person's successful writes between the agent's last call and the start of this one.
 * Only a short list of fields is ever repeated (a state, a priority, a decision…); everything else of an input — a key
 * someone typed, a mail, the contents of a profile card — is not. Same object and same fields twice: the later one.
 * The agents share one key; their audit label (workbuddy / claude / codex) keeps their places apart. ponytail: the
 * places live in memory — after a restart each agent's first call says so instead of listing, at most 50 labels kept.
 */
import { tools, type ToolContract } from "@zhiro/contracts";
import type { Services } from "../registry.js";

const seen = new Map<string, number>(); // agent label → the last audit row it was told about
const MAX_ROWS = 10, CELL = 40;
/** The only input fields ever shown. */
const SHOWN = ["state", "priority", "decision", "tag", "closeReason", "nextAction", "resumeLabel", "channel", "cohort", "mode", "backend", "where", "useModel", "everyHours", "enabled"];
/** Writes whose rows say nothing an agent needs (logins, the person's inbox account). */
const QUIET = /^(model\.|inbox\.(connect|disconnect)|llm\.test|backup\.run|data\.export)/;

const isWrite = (tool: string) => { const c = (tools as Record<string, ToolContract>)[tool]; return !!c && (c.effects.localWrite || c.effects.externalAction) && !QUIET.test(tool); };
const cell = (v: unknown) => [...String(v ?? "").replace(/[|\r\n\t]+/g, " ").trim()].slice(0, CELL).join("");
const stamp = (iso: string) => { const d = new Date(iso), p = (n: number) => String(n).padStart(2, "0"); return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`; };

function nameOf(s: Services, tool: string, inp: any): { key: string; name: string } {
  const db = s.domain.db;
  const position = (id: string) => (db.prepare("select c.name || '·' || p.title as n from position p join campaign ca on ca.id = p.campaign_id join company c on c.id = ca.company_id where p.id = ?").get(id) as any)?.n;
  if (inp?.positionId) return { key: inp.positionId, name: position(inp.positionId) ?? inp.positionId };
  if (tool.startsWith("application.") && inp?.id) {
    const a = db.prepare("select position_id from application where id = ?").get(inp.id) as any;
    return { key: inp.id, name: (a && position(a.position_id)) ?? inp.id };
  }
  if (inp?.applicationId) { const a = db.prepare("select position_id from application where id = ?").get(inp.applicationId) as any; return { key: inp.applicationId, name: (a && position(a.position_id)) ?? inp.applicationId }; }
  if (inp?.companyId) return { key: inp.companyId, name: (db.prepare("select name from company where id = ?").get(inp.companyId) as any)?.name ?? inp.companyId };
  if (tool.startsWith("fact.")) return { key: String(inp?.id ?? inp?.kind ?? ""), name: `画像${inp?.kind ? " " + inp.kind : ""}` };
  return { key: String(inp?.id ?? ""), name: inp?.id ? String(inp.id).slice(0, 12) : "" };
}

/** Where this agent's list starts: the last row it was told about (null on its first call since the daemon started). */
export function changesCursor(via: string, s: Services): { from: number | null; top: number } {
  const top = (s.domain.db.prepare("select max(rowid) as m from audit").get() as any)?.m ?? 0;
  return { from: seen.get(via.slice(0, 32)) ?? null, top };
}

/** The table, or undefined when nothing changed. Moves this agent's place to the start of the call it just made. */
export function changesSince(via: string, c: { from: number | null; top: number }, s: Services): string | undefined {
  const key = via.slice(0, 32);
  if (!seen.has(key) && seen.size >= 50) seen.clear();
  seen.set(key, Math.max(seen.get(key) ?? 0, c.top));
  if (c.from === null) return undefined; // first call since the daemon started: nothing to compare with; it reads fresh anyway
  if (c.top <= c.from) return undefined;
  const rows = s.domain.db.prepare("select at, tool, input_json from audit where rowid > ? and rowid <= ? and actor like 'human:%' and ok = 1 order by rowid").all(c.from, c.top) as any[];
  const byObject = new Map<string, string[]>();
  for (const r of rows) {
    if (!isWrite(r.tool)) continue;
    let inp: any = {}; try { inp = JSON.parse(r.input_json); } catch { /* unreadable: object and fields stay empty */ }
    let tool = r.tool, fields = inp;
    let obj = nameOf(s, tool, inp);
    if (tool === "proposal.decide" && inp?.id) {
      // a card the person decided: say what the card was about
      const p = s.domain.db.prepare("select kind, payload_json from proposal where id = ?").get(inp.id) as any;
      let payload: any = {}; try { payload = JSON.parse(p?.payload_json ?? "{}"); } catch { /* none */ }
      tool = `确认卡 ${p?.kind ?? ""}`.trim();
      obj = nameOf(s, p?.kind ?? "", payload);
      fields = { decision: inp.decision, ...payload };
    }
    const shown = SHOWN.filter((f) => fields?.[f] !== undefined && fields[f] !== "").map((f) => `${f}=${fields[f]}`).join(" ");
    byObject.set(`${tool}|${obj.key}|${SHOWN.filter((f) => fields?.[f] !== undefined).join(",")}`, [stamp(r.at), cell(tool), cell(obj.name), cell(shown)]);
  }
  if (!byObject.size) return undefined;
  const all = [...byObject.values()], list = all.slice(-MAX_ROWS);
  return [`本人在窗口里改了 ${all.length} 处（自你上次调用）`, "时间|工具|对象|改动", ...list.map((r) => r.join("|")), ...(all.length > list.length ? [`…较早的 ${all.length - list.length} 处略`] : [])].join("\n");
}
