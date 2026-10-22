/**
 * A browser on a Windows zone newer than its own table (Alberta, 2026) names no zone and shows times an hour off. The
 * daemon, on the same computer, knows the zone (daemon env.ts) and puts it in the page: dates are shown in it.
 * ponytail: only the toLocale* methods follow it (all the pages use); getHours() and friends still read the browser's.
 */
const tz = document.querySelector('meta[name="zhiro-tz"]')?.getAttribute("content");
if (tz && !Intl.DateTimeFormat().resolvedOptions().timeZone) {
  for (const m of ["toLocaleString", "toLocaleDateString", "toLocaleTimeString"] as const) {
    const show = Date.prototype[m];
    Date.prototype[m] = function (this: Date, locales?: Intl.LocalesArgument, o?: Intl.DateTimeFormatOptions) { return show.call(this, locales, { timeZone: tz, ...o }); };
  }
}
export {};
