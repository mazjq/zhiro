import { readFileSync } from "node:fs";
import { configFile, updateConfig } from "../config.js";
import YAML from "yaml";
import type { Services } from "../services.js";
import { DomainError } from "../service/domain.js";
import { createOAuthLoginManager, listProviderCapabilities, listProviderModels, type OAuthLoginManager } from "./model-auth.js";

type AuthType = "api_key" | "oauth";

/**
 * 模型服务 (the settings module the user asked to mirror from FortheFuture): choose provider → auth method → log in from
 * the GUI → choose model. Thin layer over FortheFuture's login manager, bound to Zhiro's own pi `models` and credential
 * file, so an existing login (e.g. the ChatGPT subscription) keeps working. The active provider/model live in
 * jobos.yaml (`llm`) and in `s.config.llm`, which every model call reads at call time — so a switch applies immediately.
 */
// ADR-032: not a pi provider — the model calls become jobs an external agent answers over MCP (llm.pending / llm.reply)
const EXTERNAL = { id: "external", name: "外部 agent 代答（MCP）", methods: [{ id: "api_key", label: "无需登录", kind: "none" }] };
const EXTERNAL_MODELS = [{ id: "agent", name: "由调用 Zhiro 的 agent 作答" }];

let manager: OAuthLoginManager | null = null;
let chosenAuth: AuthType | null = null;

function login(s: Services): OAuthLoginManager {
  if (!s.llm) throw new DomainError("NO_MODEL", "模型层未初始化");
  return (manager ??= createOAuthLoginManager({ models: s.llm.models as any }));
}

const remembered = (s: Services, provider: string): string => ((YAML.parse(readFileSync(configFile(s.config.vault), "utf8")) as any)?.llm?.selections ?? {})[provider] ?? "";

function persist(s: Services, provider: string, model: string) {
  updateConfig(s.config.vault, (doc) => {
    doc.llm = { ...(doc.llm ?? {}), provider, model, selections: { ...(doc.llm?.selections ?? {}), ...(model ? { [provider]: model } : {}) } };
  });
  s.config.llm.provider = provider; s.config.llm.model = model;
}

export async function modelStatus(s: Services) {
  const lm = login(s), models = s.llm!.models;
  const providers = [...listProviderCapabilities(models as any), EXTERNAL] as any[];
  const providerId = s.config.llm.provider;
  if (providerId === EXTERNAL.id) return { state: "ready", providerId, authType: "api_key", providers, modelId: "agent", models: EXTERNAL_MODELS, modelKnown: true, auth: null, error: "" };
  const provider = providers.find((p) => p.id === providerId);
  const check = await models.checkAuth(providerId).catch(() => undefined);
  const authType: AuthType = chosenAuth ?? (check?.type as AuthType | undefined) ?? provider?.methods[0]?.id ?? "api_key";
  const cur = lm.status();
  const mine = cur.providerId === providerId && cur.authType === authType ? cur : { phase: "idle" as const };
  const active = mine.phase === "running" || mine.phase === "waiting_for_input";
  const list = provider ? listProviderModels(models as any, providerId).map(({ id, name }) => ({ id, name })) : [];
  const state = active ? "awaiting_user" : !provider || mine.phase === "failed" ? "error" : check ? "ready" : "signed_out";
  return {
    state, providerId, authType, providers, modelId: s.config.llm.model, models: list,
    modelKnown: list.some((m) => m.id === s.config.llm.model),
    auth: active ? {
      attemptId: (mine as any).attemptId ?? "", url: (mine as any).loginUrl ?? "", prompt: (mine as any).prompt ?? null, deviceCode: (mine as any).deviceCode ?? null,
      notice: (mine as any).notice?.message ?? "", links: (mine as any).notice?.links ?? [],
    } : null,
    error: !provider ? `未知供应商 ${providerId}` : (mine as any).error?.message ?? "",
  };
}

export function modelLogin(s: Services) { const lm = login(s); return modelStatus(s).then((st) => { lm.begin(st.providerId, st.authType as AuthType); return modelStatus(s); }); }
export function modelAnswer(s: Services, p: { attemptId?: string; promptId: string; value: string }) { login(s).submitPrompt(p); return modelStatus(s); }
export function modelCancel(s: Services) { login(s).cancel(); return modelStatus(s); }

export async function modelProvider(s: Services, providerId: string, authType: AuthType) {
  const lm = login(s);
  if (providerId === EXTERNAL.id) { if (lm.status().phase === "running" || lm.status().phase === "waiting_for_input") lm.cancel(); chosenAuth = null; persist(s, EXTERNAL.id, "agent"); return modelStatus(s); }
  const p = listProviderCapabilities(s.llm!.models as any).find((x) => x.id === providerId);
  if (!p || !p.methods.some((m) => m.id === authType)) throw new DomainError("INVALID_PROVIDER_METHOD", "这个供应商不支持这种认证方式");
  const phase = lm.status().phase;
  if (phase === "running" || phase === "waiting_for_input") lm.cancel(); // switching away abandons a half-done login
  chosenAuth = authType;
  if (providerId !== s.config.llm.provider) {
    const list = listProviderModels(s.llm!.models as any, providerId), was = remembered(s, providerId);
    persist(s, providerId, list.some((m) => m.id === was) ? was : list[0]?.id ?? "");
  }
  return modelStatus(s);
}

export async function modelSelect(s: Services, modelId: string) {
  if (s.config.llm.provider === EXTERNAL.id) return modelStatus(s);
  if (!listProviderModels(s.llm!.models as any, s.config.llm.provider).some((m) => m.id === modelId)) throw new DomainError("MODEL_NOT_FOUND", `这个供应商没有模型 ${modelId}`);
  persist(s, s.config.llm.provider, modelId);
  return modelStatus(s);
}

/** Ask the provider for its current catalogue (new models appear without a Zhiro update). */
export async function modelRefresh(s: Services) {
  if (s.config.llm.provider === EXTERNAL.id) return modelStatus(s);
  const r = await (s.llm!.models as any).refresh({ providers: [s.config.llm.provider], allowNetwork: true, force: true, signal: AbortSignal.timeout(30_000) }).catch((e: any) => ({ aborted: true, errors: new Map([["", e]]) }));
  if (r.aborted || r.errors?.size) throw new DomainError("MODEL_REFRESH_FAILED", "获取模型列表失败（先确认已登录）");
  return modelStatus(s);
}
