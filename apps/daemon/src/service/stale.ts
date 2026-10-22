/**
 * 过期信息 (user, 2026-10-22: 「链接还是 26 届的，可能有误导」): why a post should not be in the everyday lists. Hidden
 * from them, not deleted; a post the person watches or prepares / applied to is never hidden (it says why instead).
 *   往届       its batch, or its title, names only cohorts before the one being recruited now — and does not say earlier
 *              ones may also apply (「26届可投」「26届及以后」 stay);
 *   过期一周   its deadline passed more than a week ago (补录 and 延期 show up within days — a week is the margin);
 *   源站撤下   the site no longer lists it.
 * A page that is about an earlier year (only reading it tells) is for the agent check that comes with the shared source.
 */
const YEARS = /(?:20)?(2\d)\s*(?:届|级毕业|年毕业)/g;
/** words that open a post to earlier cohorts rather than limit it to them */
const OPEN = /可投|可报|均可|也可|及以后|及以上|以后|往届|不限|含/;

/** The cohort years a text names: "2026届、2027届" → [2026, 2027]; "26届" → [2026]. */
export const cohortYears = (s: string): number[] => [...(s ?? "").matchAll(YEARS)].map((m) => 2000 + Number(m[1]));

/** The cohort being recruited now: 秋招 from July is for next year's graduates (2026-10 → 2027届). */
export const targetCohort = (today: string) => Number(today.slice(0, 4)) + (Number(today.slice(5, 7)) >= 7 ? 1 : 0);

export const STALE_AFTER_DAYS = 7;

export function staleReason(p: { title: string; status?: string; deadline?: { expired?: boolean; date?: string | null } }, cohort: string, today: string): string {
  if (p.status === "closed") return "源站已撤下";
  const target = targetCohort(today), batch = cohortYears(cohort), mine = cohortYears(p.title);
  if (batch.length && Math.max(...batch) < target) return `往届批次：${[...new Set(batch)].map((y) => String(y).slice(2)).join("、")} 届`;
  if (mine.length && Math.max(...mine) < target && !OPEN.test(p.title)) return `往届：标题写的是 ${[...new Set(mine)].map((y) => String(y).slice(2)).join("、")} 届`;
  const d = p.deadline;
  if (d?.expired && d.date && d.date < addDays(today, -STALE_AFTER_DAYS)) return `截止（${d.date}）已过一周以上`;
  return "";
}

const addDays = (day: string, n: number) => { const t = new Date(`${day}T00:00:00Z`); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
