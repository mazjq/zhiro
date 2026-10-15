/**
 * Interactive provider login for the Career Agent's LLM.
 *   pnpm --filter @zhiro/daemon auth openai-codex        # ChatGPT/Codex subscription (OAuth)
 *   pnpm --filter @zhiro/daemon auth anthropic api_key   # paste an API key
 *   pnpm --filter @zhiro/daemon auth --status
 * Credentials go to vault/config/credentials.json (0600). Uses pi-ai's own login flows; we only render prompts.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { spawn } from "node:child_process";
import { loadConfig } from "../config.js";
import { createLlm } from "../llm.js";

const [providerArg, typeArg] = process.argv.slice(2);
const config = loadConfig();
const llm = createLlm(config);

if (!providerArg || providerArg === "--status") {
  const s = await llm.status();
  console.log(`configured: ${s.provider}/${s.model}  loggedIn=${s.loggedIn}`);
  console.log(`stored credentials: ${s.credentials.map((c) => `${c.providerId}(${c.type})`).join(", ") || "(none)"}`);
  console.log(`providers: ${llm.models.getProviders().map((p) => p.id).join(" ")}`);
  process.exit(0);
}

const provider = llm.models.getProvider(providerArg);
if (!provider) { console.error(`unknown provider ${providerArg}`); process.exit(1); }
const kinds = Object.keys((provider as any).auth ?? {});
const type = (typeArg as "oauth" | "api_key") ?? (kinds.includes("oauth") ? "oauth" : "api_key");
console.log(`login ${providerArg} via ${type} (supported: ${kinds.join(", ")})`);

const rl = createInterface({ input: stdin, output: stdout });
const open = (url: string) => {
  const [bin, args]: [string, string[]] =
    process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try { spawn(bin, args, { stdio: "ignore", detached: true }).unref(); } catch { /* user opens manually */ }
};

try {
  const cred = await llm.models.login(providerArg, type, {
    async prompt(p) {
      if (p.type === "select") {
        console.log(p.message);
        p.options.forEach((o, i) => console.log(`  ${i + 1}. ${o.label}${o.description ? " — " + o.description : ""}`));
        const a = await rl.question("> ");
        return p.options[Number(a) - 1]?.id ?? a;
      }
      return (await rl.question(`${p.message}${p.placeholder ? ` (${p.placeholder})` : ""}\n> `)).trim();
    },
    notify(e) {
      if (e.type === "auth_url") { console.log(`打开浏览器登录：${e.url}${e.instructions ? "\n" + e.instructions : ""}`); open(e.url); }
      else if (e.type === "device_code") { console.log(`访问 ${e.verificationUri} 并输入代码：${e.userCode}`); open(e.verificationUri); }
      else if (e.type === "info") console.log(e.message);
      else if (e.type === "progress") console.log(`… ${e.message}`);
    },
  });
  console.log(`✓ 已保存 ${providerArg} 凭据（${cred.type}）到 vault/config/credentials.json`);
  const s = await llm.status();
  console.log(`configured model ${s.provider}/${s.model} loggedIn=${s.loggedIn}`);
} catch (e: any) {
  console.error(`登录失败：${e?.message ?? e}`);
  process.exit(1);
} finally {
  rl.close();
}
