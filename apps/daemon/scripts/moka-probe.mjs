// Probe the vendored career-ops Moka provider against real campus tenants (read-only, zero-token).
// usage: node scripts/moka-probe.mjs <careers_url> [<careers_url> ...]
import path from "node:path";
import { pathToFileURL } from "node:url";

const root = path.resolve(import.meta.dirname, "../../../vendor/career-ops/providers");
const { default: moka } = await import(pathToFileURL(path.join(root, "mokahr.mjs")).href);
const { makeHttpCtx } = await import(pathToFileURL(path.join(root, "_http.mjs")).href);

const urls = process.argv.slice(2);
if (!urls.length) { console.error("give at least one https://app.mokahr.com/campus-recruitment/<org>/<site> url"); process.exit(1); }
const ctx = { ...makeHttpCtx(), maxPages: 3 };
for (const url of urls) {
  const t0 = Date.now();
  try {
    const jobs = await moka.fetch({ name: url.split("/")[4], careers_url: url, keywords: [""], max_pages: 3 }, ctx);
    console.log(`\n== ${url}\n   ${jobs.length} jobs in ${Date.now() - t0} ms`);
    for (const j of jobs.slice(0, 8)) console.log(`   - ${j.title} | ${j.location} | ${j.postedAt ? new Date(j.postedAt).toISOString().slice(0, 10) : "?"} | ${j.url.slice(-14)}`);
    if (jobs[0]) console.log(`   desc[0]: ${jobs[0].description.replace(/\s+/g, " ").slice(0, 160)}…`);
  } catch (e) {
    console.log(`\n== ${url}\n   FAILED: ${e.message}`);
  }
}
