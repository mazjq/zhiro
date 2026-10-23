/**
 * jobos.yaml checked when it is read (A13): a value that is not what the setting takes falls back to its default and
 * the start says so — the program never stops over a setting, and never guesses what a wrong one meant. The
 * subscriptions are only reported, never changed here: one dropped in memory would be dropped from the file at the
 * next save.
 */
const int = (v: unknown, min: number, max: number) => Number.isInteger(v) && (v as number) >= min && (v as number) <= max;
const num = (v: unknown, min: number, max: number) => typeof v === "number" && Number.isFinite(v) && v >= min && v <= max;
const oneOf = (v: unknown, xs: readonly string[]) => typeof v === "string" && xs.includes(v);
const bool = (v: unknown) => typeof v === "boolean";
const str = (v: unknown) => typeof v === "string";
const AT = /^([01]?\d|2[0-3]):[0-5]\d$/;
const SAFE_ID = /^[^\\/:*?"<>|~%\u0000-\u001f]{1,120}$/;

type Rule = [path: string, ok: (v: unknown) => boolean, says: string];
const RULES: Rule[] = [
  ["http.host", str, "要是文字，如 127.0.0.1"],
  ["http.port", (v) => int(v, 1, 65535), "要是 1–65535 的整数"],
  ["reminders.daysBefore", (v) => Array.isArray(v) && v.every((d) => int(d, 0, 60)), "要是 0–60 天的整数列表，如 [7, 3, 1]"],
  ["agent.mode", (v) => oneOf(v, ["default", "conservative"]), "只能是 default 或 conservative"],
  ["agent.maxWritesPerTurn", (v) => int(v, 0, 1000), "要是 0–1000 的整数"],
  ["agent.harnessConfirm", (v) => oneOf(v, ["harness", "window"]), "只能是 harness 或 window"],
  ["agent.backend", (v) => oneOf(v, ["builtin", "claude", "codex", "dsh"]), "只能是 builtin / claude / codex / dsh"],
  ["brief.at", (v) => str(v) && AT.test(v as string), "要是 0–23 点、0–59 分，如 8:00"],
  ["background.reserve", (v) => num(v, 0, 0.9), "要是 0–0.9（给你留的额度比例）"],
  ["background.apiDailyUsd", (v) => num(v, 0, 10000), "要是不小于 0 的数"],
  ["background.unknownDailyTokens", (v) => int(v, 0, 1e9), "要是不小于 0 的整数"],
  ["background.quietBeforeMins", (v) => int(v, 0, 600), "要是 0–600 分钟"],
  ["background.quietAfterMins", (v) => int(v, 0, 600), "要是 0–600 分钟"],
  ["leads.dailyBudget", (v) => int(v, 0, 10000), "要是不小于 0 的整数"],
  ["pages.dailyBudget", (v) => int(v, 0, 10000), "要是不小于 0 的整数"],
  ["inbox.auto", bool, "要是 true 或 false"],
  ["notify.sms", bool, "要是 true 或 false"],
  ["notify.phone", bool, "要是 true 或 false"],
  ["keepAutoSources", bool, "要是 true 或 false"],
];

/** Problems with the settings as written, each fixed in `doc` by taking the setting out (its default applies). */
export function checkConfig(doc: any): string[] {
  const out: string[] = [];
  if (!doc || typeof doc !== "object") return out;
  for (const [path, ok, says] of RULES) {
    const keys = path.split("."), last = keys.pop()!;
    const parent = keys.reduce((o, k) => (o && typeof o === "object" ? o[k] : undefined), doc);
    if (!parent || typeof parent !== "object" || !(last in parent)) continue;
    if (!ok(parent[last])) { out.push(`${path} 写的是 ${JSON.stringify(parent[last])}，${says}：这次按默认值`); delete parent[last]; }
  }
  if (doc.feeds !== undefined) {
    if (!Array.isArray(doc.feeds)) { out.push("feeds 要是列表：这次不订阅任何数据源"); delete doc.feeds; }
    else doc.feeds = doc.feeds.filter((f: any, i: number) => {
      const bad = !f || !str(f.id) || !SAFE_ID.test(f.id) ? "id" : !str(f.url) || !f.url ? "url" : !str(f.publicKey) || !f.publicKey ? "publicKey" : f.enabled !== undefined && !bool(f.enabled) ? "enabled" : "";
      if (bad) out.push(`feeds 第 ${i + 1} 个的 ${bad} 不对：这次不订阅它`);
      return !bad;
    });
  }
  if (doc.sources !== undefined && !Array.isArray(doc.sources)) out.push("sources 要是列表：这次没有订阅（文件没改）");
  else if (Array.isArray(doc.sources)) {
    const bad = doc.sources.filter((c: any) => !c || !str(c.id) || !str(c.source)).length;
    if (bad) out.push(`sources 里有 ${bad} 个订阅缺 id 或 source：先照旧保留在文件里，读取时会跳过`);
  }
  return out;
}
