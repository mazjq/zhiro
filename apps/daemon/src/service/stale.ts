/**
 * 过期信息 (user, 2026-10-22: 「链接还是 26 届的，可能有误导」): why a post should not be in the everyday lists. Hidden
 * from them, not deleted; a post the person watches or prepares / applied to is never hidden (it says why instead).
 *   往届       its title names only earlier cohorts than its batch (2027 批次里「26届校招：营销管培生」);
 *   过期一周   its deadline passed more than a week ago (补录 and 延期 show up within days — a week is the margin);
 *   源站撤下   the site no longer lists it.
 * A page that is about an earlier year (only reading it tells) is for the agent check that comes with the shared source.
 */
const YEARS = /(?:20)?(2\d)\s*(?:届|级毕业|年毕业)/g;

/** The cohort years a text names: "2026届、2027届" → [2026, 2027]; "26届" → [2026]. */
export const cohortYears = (s: string): number[] => [...(s ?? "").matchAll(YEARS)].map((m) => 2000 + Number(m[1]));

export const STALE_AFTER_DAYS = 7;

export function staleReason(p: { title: string; status?: string; deadline?: { expired?: boolean; date?: string | null } }, cohort: string, today: string): string {
  if (p.status === "closed") return "源站已撤下";
  const mine = cohortYears(p.title), batch = cohortYears(cohort);
  if (mine.length && batch.length && Math.max(...mine) < Math.max(...batch)) return `往届：标题写的是 ${[...new Set(mine)].map((y) => String(y).slice(2)).join("、")} 届`;
  const d = p.deadline;
  if (d?.expired && d.date && d.date < addDays(today, -STALE_AFTER_DAYS)) return `截止（${d.date}）已过一周以上`;
  return "";
}

const addDays = (day: string, n: number) => { const t = new Date(`${day}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
