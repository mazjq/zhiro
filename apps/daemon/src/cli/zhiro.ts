/**
 * `zhiro` — the one command of the installed program (ADR-052). Picks the subcommand, settles where the data is
 * (`--data` is taken here, before anything reads its arguments), then hands over to the module that does the work.
 */
import "../env.js"; // ZHIRO_* names (before anything reads the environment)
import { VERSION } from "../version.js";
import { dataDir } from "../datadir.js";

const HELP = `Zhiro · 职路 ${VERSION} — AI 职业调研与求职（本地优先）

用法：
  zhiro [--data <文件夹>] [--no-open]   启动（打开界面；数据默认放在系统惯例位置，第一次启动会问）
  zhiro mcp                             给你自己的 agent 用的 MCP（stdio）
  zhiro vault verify [--quick]          检查数据是否完整（随时可跑）
  zhiro vault backup                    备份一次
  zhiro vault upgrade | rollback        升级数据库 / 回到升级前（先停掉 zhiro）
  zhiro vault use <文件夹>              以后都用这个数据文件夹（新的，或已有的数据）
  zhiro vault move <文件夹>             下次启动时把数据搬过去
  zhiro vault export [x.zip] | import <x.zip>
  zhiro data probe|add|list|sync|watch  岗位订阅（表格、招聘站）
  zhiro auth <供应商>                    内置助手的模型登录（可选）
  zhiro --version

文档：https://github.com/mazjq/zhiro`;

const args = process.argv.slice(2);
const first = args.find((a, i) => !a.startsWith("-") && args[i - 1] !== "--data");
if (args.includes("--version") || args.includes("-v")) { console.log(VERSION); process.exit(0); }
if (args.includes("--help") || args.includes("-h") || first === "help") { console.log(HELP); process.exit(0); }

const sub = first ?? "start";
const MODULES: Record<string, () => Promise<unknown>> = {
  start: () => import("../main.js"),
  mcp: () => import("../mcp/stdio.js"),
  vault: () => import("./vault.js"),
  data: () => import("../data/cli.js"),
  auth: () => import("./login.js"),
};
if (!MODULES[sub]) { console.error(`不认识的命令：${sub}\n\n${HELP}`); process.exit(2); }

try { dataDir(); } catch (e: any) { console.error(`[zhiro] ${e?.message ?? e}`); process.exit(1); }
// what the module sees: its own arguments, without the subcommand and the data folder (already settled)
const rest = args.filter((a, i) => a !== sub || i !== args.indexOf(sub)).filter((a, i, all) => a !== "--data" && all[i - 1] !== "--data" && !a.startsWith("--data="));
if (sub === "start") {
  if (process.stdout.isTTY && !rest.includes("--no-open")) process.env.ZHIRO_OPEN = "1";
}
process.argv = [process.argv[0], process.argv[1], ...rest.filter((a) => a !== "--no-open")];
await MODULES[sub]();
