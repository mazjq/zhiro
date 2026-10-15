// Live check of 美股 企业情况 against 东财 (no vault touched).
// usage: node --import tsx scripts/us-probe.ts 拼多多 蔚来汽车 英伟达
import { resolveUsListing, fetchUsBasic, fetchUsFinance } from "../src/service/us-stock.js";

const yi = (n: number | null) => (n == null ? "—" : `${(n / 1e8).toFixed(1)} 亿`);
for (const name of process.argv.slice(2)) {
  const l = await resolveUsListing(name);
  if (!l) { console.log(`${name}：不是美股上市公司（或名字对不上）`); continue; }
  const b = await fetchUsBasic(l.code), f = await fetchUsFinance(l.code);
  console.log(`${name} → ${l.name} ${l.code} · ${b.market} · ${b.industry} · 员工 ${b.employees ?? "?"} · ${b.enName}`);
  for (const a of f.annual) console.log(`  ${a.period}（${a.currency}）营收 ${yi(a.revenue)} 净利 ${yi(a.netProfit)} 研发 ${yi(a.rdExpense)}`);
  if (f.latest) console.log(`  最新 ${f.latest.period} 营收 ${yi(f.latest.revenue)} 净利 ${yi(f.latest.netProfit)}`);
}
