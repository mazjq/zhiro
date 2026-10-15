import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Source } from "../types.js";
import { publicUrl, isLocalPath } from "../http.js";
import { listingsFromTable, csvToTable } from "../sheet.js";

/**
 * A table kept as CSV: a link that answers with CSV text (a Google 表格 「发布到网络」, a file on GitHub, any address that
 * hands out a .csv), or a file on this machine (what Excel / WPS / 腾讯文档 export). Read again at the subscription's
 * pace, so the table can keep changing. Which column is which comes from the subscription (data/sheet.ts).
 */
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";

const isCsvPath = (s: string) => isLocalPath(s) && /\.csv$/i.test(s.trim());
function isCsvLink(s: string): boolean {
  try {
    const u = new URL(s);
    if (!/^https?:$/.test(u.protocol)) return false;
    return /\.csv$/i.test(u.pathname) || ["output", "format", "exportFormat"].some((k) => u.searchParams.get(k)?.toLowerCase() === "csv") || /out:csv/i.test(u.searchParams.get("tqx") ?? "");
  } catch { return false; }
}

/** Excel on a Chinese Windows saves 「CSV（逗号分隔）」 as GBK; everything else is UTF-8. */
function decode(bytes: Uint8Array): string {
  const utf8 = new TextDecoder("utf-8").decode(bytes);
  return utf8.includes("\uFFFD") ? new TextDecoder("gbk").decode(bytes) : utf8;
}

async function read(where: string, signal?: AbortSignal): Promise<Uint8Array> {
  if (isLocalPath(where)) {
    if (!existsSync(where)) throw new Error(`FILE_NOT_FOUND: 找不到这个文件：${where}`);
    return readFileSync(where);
  }
  if (!publicUrl(where)) throw new Error(`BLOCKED: 只读公网上的链接，不读本机或内网地址：${where}`);
  const res = await fetch(where, { signal: signal ?? AbortSignal.timeout(60_000), headers: { "user-agent": UA } });
  if (!publicUrl(res.url)) throw new Error(`BLOCKED: 链接跳到了本机或内网地址：${res.url}`);
  if (res.status === 401 || res.status === 403) throw new Error(`NOT_PUBLIC: 这个链接要登录才能看（HTTP ${res.status}），请换成任何人都能打开的链接`);
  if (!res.ok) throw new Error(`SITE_DOWN: 这个链接打不开（HTTP ${res.status}）。检查链接是否完整、是否还有效`);
  if (/text\/html/i.test(res.headers.get("content-type") ?? "")) throw new Error("NOT_PUBLIC: 这个链接打开的是网页而不是 CSV（可能要登录，或者不是导出 / 发布链接）");
  return new Uint8Array(await res.arrayBuffer());
}

export const csv: Source = {
  id: "csv",
  name: "CSV 表格", input: "以 .csv 结尾或带 output=csv 的链接；或本机 .csv 文件的完整路径", aggregate: true,
  mode: "pull",
  describe: "CSV 表格（链接或本机文件）：按订阅里存的列对应读成岗位；每次按周期重读整张表",
  detect: (url) => isCsvPath(url) || isCsvLink(url),
  siteKey: (url) => (isLocalPath(url) ? resolve(url.trim()).toLowerCase() : url.split("#")[0]),
  async table(config, ctx) { return csvToTable(decode(await read((config.url ?? "").trim(), ctx.signal))); },
  async fetch(config, ctx) { return listingsFromTable(await this.table!(config, ctx), config, "CSV 表格"); },
};
