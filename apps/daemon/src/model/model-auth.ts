// Copied verbatim (2026-09-19) from the author's sibling project FortheFuture (packages/agent-runtime/src/model-auth.ts),
// built on the same pi-ai 0.85.1. It turns pi's terminal-style login (OAuth / device code / API key prompts)
// into pollable state a GUI can drive. Zhiro uses createOAuthLoginManager + the list helpers with its own credential store
// (vault/config/credentials.json); AtomicCredentialStore / createProductModelAuth are unused here. Do not edit — re-copy to update.

import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import type {
  Api,
  AuthEvent,
  AuthInteraction,
  AuthOperationOptions,
  AuthType,
  AuthPrompt,
  Credential,
  CredentialInfo,
  CredentialStore,
  Model,
  Models,
  MutableModels
} from '@earendil-works/pi-ai';
import { builtinModels } from '@earendil-works/pi-ai/providers/all';

export const CODEX_PROVIDER = 'openai-codex';
export const DEFAULT_CODEX_MODEL_PREFERENCE = [
  'gpt-5.6-terra',
  'gpt-5.6-luna',
  'gpt-5.5',
  'gpt-5.4-mini',
  'gpt-5.4',
  'gpt-5.6-sol',
  'gpt-6-astra'
] as const;

export const DEFAULT_API_MODEL_PREFERENCE: Record<string, readonly string[]> = {
  openai: ['gpt-5.5', 'gpt-5.4', 'gpt-5.2', 'gpt-4.1'],
  deepseek: ['deepseek-v4-pro', 'deepseek-v4-flash'],
  anthropic: ['claude-sonnet-5', 'claude-sonnet-4-6', 'claude-haiku-4-5'],
  google: ['gemini-3.8-flash', 'gemini-3.7-flash', 'gemini-2.5-pro', 'gemini-2.5-flash']
};const MAX_LABEL = 500;
const MAX_INPUT = 16_000;

type CredentialMap = Record<string, Credential>;

export class ModelAuthError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ModelAuthError';
    this.code = code;
  }
}

function abortIfRequested(options?: AuthOperationOptions): void {
  options?.signal?.throwIfAborted();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

const LOGIN_METHOD_FIELD = 'ftfLoginMethod';

function credentialLoginMethod(value: Credential | undefined): AuthType | undefined {
  if (!value || !isRecord(value)) return undefined;
  const method = value[LOGIN_METHOD_FIELD];
  return method === 'api_key' || method === 'oauth' ? method : undefined;
}

function withLoginMethod<T extends Credential>(credential: T, method: AuthType): T {
  return { ...credential, [LOGIN_METHOD_FIELD]: method } as T;
}

function isCredential(value: unknown): value is Credential {
  if (!isRecord(value)) return false;
  const method = value[LOGIN_METHOD_FIELD];
  if (method !== undefined && method !== 'api_key' && method !== 'oauth') return false;
  if (value.type === 'api_key') {
    return (value.key === undefined || typeof value.key === 'string')
      && (value.env === undefined || (isRecord(value.env) && Object.values(value.env).every(item => typeof item === 'string')));
  }
  return value.type === 'oauth'
    && typeof value.refresh === 'string'
    && typeof value.access === 'string'
    && typeof value.expires === 'number'
    && Number.isFinite(value.expires);
}

function cloneCredential<T extends Credential | undefined>(value: T): T {
  return value === undefined ? value : structuredClone(value);
}

/**
 * Product-owned credential file. It never reads Codex, Zhiro, or Pi's default auth paths.
 * The daemon remains the sole process writer; all in-process read-modify-write operations
 * share one queue because every provider lives in the same JSON file.
 */
export class AtomicCredentialStore implements CredentialStore {
  readonly path: string;
  private chain: Promise<void> = Promise.resolve();

  constructor(dataDir: string) {
    this.path = join(resolve(dataDir), 'auth', 'credentials.json');
  }

  private async load(): Promise<CredentialMap> {
    let raw: string;
    try { raw = await readFile(this.path, 'utf8'); }
    catch (error) {
      if (isRecord(error) && error.code === 'ENOENT') return Object.create(null) as CredentialMap;
      throw new ModelAuthError('CREDENTIAL_READ_FAILED', 'Unable to read the product credential store');
    }
    let parsed: unknown;
    try { parsed = JSON.parse(raw); }
    catch { throw new ModelAuthError('CREDENTIAL_STORE_CORRUPT', 'The product credential store is not valid JSON'); }
    if (!isRecord(parsed)) throw new ModelAuthError('CREDENTIAL_STORE_CORRUPT', 'The product credential store has an invalid shape');
    const result: CredentialMap = Object.create(null) as CredentialMap;
    for (const [providerId, credential] of Object.entries(parsed)) {
      if (!providerId || !isCredential(credential)) throw new ModelAuthError('CREDENTIAL_STORE_CORRUPT', 'The product credential store contains an invalid credential');
      result[providerId] = credential;
    }
    return result;
  }

  private async save(all: CredentialMap): Promise<void> {
    const folder = dirname(this.path);
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    try {
      handle = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await handle.writeFile(`${JSON.stringify(all)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporary, this.path);
      await chmod(this.path, 0o600).catch(() => undefined);
    } catch {
      throw new ModelAuthError('CREDENTIAL_WRITE_FAILED', 'Unable to persist the product credential store');
    } finally {
      await handle?.close().catch(() => undefined);
      await rm(temporary, { force: true }).catch(() => undefined);
    }
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.then(() => undefined, () => undefined);
    return run;
  }

  read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      abortIfRequested(options);
      return cloneCredential((await this.load())[providerId]);
    });
  }

  list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
    return this.enqueue(async () => {
      abortIfRequested(options);
      return Object.entries(await this.load()).map(([providerId, credential]) => ({ providerId, type: credential.type }));
    });
  }

  modify(
    providerId: string,
    mutate: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions
  ): Promise<Credential | undefined> {
    return this.enqueue(async () => {
      abortIfRequested(options);
      const all = await this.load();
      const current = cloneCredential(all[providerId]);
      let next = await mutate(current);
      abortIfRequested(options);
      if (next === undefined) return cloneCredential(all[providerId]);
      if (!isCredential(next)) throw new ModelAuthError('INVALID_CREDENTIAL', 'Credential update returned an invalid value');
      const previousMethod = credentialLoginMethod(current);
      if (current?.type === next.type && previousMethod && !credentialLoginMethod(next)) {
        next = withLoginMethod(next, previousMethod);
      }
      all[providerId] = cloneCredential(next);
      await this.save(all);
      return cloneCredential(next);
    });
  }

  delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    return this.enqueue(async () => {
      abortIfRequested(options);
      const all = await this.load();
      if (!(providerId in all)) return;
      delete all[providerId];
      await this.save(all);
    });
  }

  async drain(): Promise<void> {
    while (true) {
      const queued = this.chain;
      await queued;
      if (queued === this.chain) return;
    }
  }
}

export interface PublicAuthPrompt {
  id: string;
  type: 'text' | 'secret' | 'select' | 'manual_code';
  label: string;
  placeholder?: string;
  options?: readonly { id: string; label: string; description?: string }[];
}

export interface PublicAuthLink {
  url: string;
  label?: string;
}

export interface PublicAuthNotice {
  type: 'info' | 'progress';
  message: string;
  links?: readonly PublicAuthLink[];
}

export interface ProviderInfo {
  id: string;
  name: string;
  methods: Array<{
    id: AuthType;
    label: string;
    kind: 'api' | 'subscription' | 'oauth';
    interactive: boolean;
  }>;
}

export type LoginPhase = 'idle' | 'running' | 'waiting_for_input' | 'succeeded' | 'failed' | 'cancelled';

export interface LoginStatus {
  phase: LoginPhase;
  attemptId?: string;
  providerId?: string;
  authType?: AuthType;
  credentialType?: Credential['type'];
  loginUrl?: string;
  deviceCode?: { userCode: string; verificationUrl: string; expiresInSeconds?: number };
  prompt?: PublicAuthPrompt;
  notice?: PublicAuthNotice;
  error?: { code: string; message: string };
}

export interface OAuthLoginManager {
  begin(providerId?: string, authType?: AuthType): LoginStatus;
  status(): LoginStatus;
  submitPrompt(input: { attemptId?: string; promptId: string; value: string }): LoginStatus;
  cancel(attemptId?: string): LoginStatus;
  drain(): Promise<void>;
}

export interface ModelsAuthApi {
  login(providerId: string, type: AuthType, interaction: AuthInteraction): Promise<Credential>;
  checkAuth: Models['checkAuth'];
  getAvailable: Models['getAvailable'];
  getProviders: Models['getProviders'];
  getProvider: Models['getProvider'];
  getModels: Models['getModels'];
  getModel: Models['getModel'];
}
type PendingPrompt = {
  attemptId: string;
  prompt: PublicAuthPrompt;
  source: AuthPrompt;
  resolve(value: string): void;
  reject(error: Error): void;
  cleanup(): void;
};

function safeLabel(value: string): string {
  return value.replace(/[\r\n\t]+/g, ' ').trim().slice(0, MAX_LABEL);
}

function trustedLoginUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new ModelAuthError('UNTRUSTED_LOGIN_URL', 'Provider returned an invalid login URL'); }
  if (url.protocol !== 'https:' || url.port || url.username || url.password) {
    throw new ModelAuthError('UNTRUSTED_LOGIN_URL', 'Provider returned an untrusted login URL');
  }
  return url.toString();
}

function publicPrompt(id: string, prompt: AuthPrompt): PublicAuthPrompt {
  if (prompt.type === 'select') {
    return {
      id,
      type: 'select',
      label: safeLabel(prompt.message),
      options: prompt.options.map(option => ({
        id: option.id,
        label: safeLabel(option.label),
        ...(option.description ? { description: safeLabel(option.description) } : {})
      }))
    };
  }
  return {
    id,
    type: prompt.type,
    label: safeLabel(prompt.message),
    ...(prompt.placeholder ? { placeholder: safeLabel(prompt.placeholder) } : {})
  };
}

function cloneStatus(status: LoginStatus): LoginStatus {
  return structuredClone(status);
}

export function createOAuthLoginManager(input: {
  models: Pick<ModelsAuthApi, 'login' | 'getProvider'>;
  onChange?: () => void;
}): OAuthLoginManager {
  type LoginAttempt = { id: string; controller: AbortController; providerId: string; authType: AuthType };
  let state: LoginStatus = { phase: 'idle', providerId: CODEX_PROVIDER, authType: 'oauth' };
  let current: LoginAttempt | undefined;
  let pending: PendingPrompt | undefined;
  const inFlight = new Set<Promise<void>>();

  const setState = (next: LoginStatus) => { state = next; };
  const isCurrent = (attempt: LoginAttempt) => current === attempt;
  const isActive = (attempt: LoginAttempt) =>
    isCurrent(attempt) && (state.phase === 'running' || state.phase === 'waiting_for_input');

  function validateMethod(providerId: string, authType: AuthType): void {
    const provider = input.models.getProvider(providerId);
    if (!provider) throw new ModelAuthError('PROVIDER_NOT_FOUND', `Unknown model provider: ${providerId}`);
    const method = authType === 'api_key' ? provider.auth.apiKey : provider.auth.oauth;
    if (!method) throw new ModelAuthError('AUTH_METHOD_NOT_SUPPORTED', `Provider does not support ${authType}: ${providerId}`);
    if (authType === 'api_key' && !provider.auth.apiKey?.login) {
      throw new ModelAuthError('AUTH_METHOD_NOT_INTERACTIVE', `Provider has no interactive API credential flow: ${providerId}`);
    }
  }

  function takePending(attemptId: string): PendingPrompt | undefined {
    if (pending?.attemptId !== attemptId) return undefined;
    const taken = pending;
    pending = undefined;
    taken.cleanup();
    return taken;
  }

  function rejectPending(attemptId: string, error: Error): void {
    takePending(attemptId)?.reject(error);
  }

  function scope(attempt: LoginAttempt): Pick<LoginStatus, 'attemptId' | 'providerId' | 'authType'> {
    return { attemptId: attempt.id, providerId: attempt.providerId, authType: attempt.authType };
  }

  function fail(attempt: LoginAttempt, code: string, message: string): void {
    if (!isCurrent(attempt)) return;
    setState({ phase: 'failed', ...scope(attempt), error: { code, message } });
    current = undefined;
    attempt.controller.abort();
    rejectPending(attempt.id, new ModelAuthError(code, message));
  }

  function notify(attempt: LoginAttempt, event: AuthEvent): void {
    if (!isActive(attempt)) return;
    try {
      if (event.type === 'auth_url') {
        setState({
          ...state,
          loginUrl: trustedLoginUrl(event.url),
          ...(event.instructions ? { notice: { type: 'info', message: safeLabel(event.instructions) } } : {})
        });
      } else if (event.type === 'device_code') {
        const verificationUrl = trustedLoginUrl(event.verificationUri);
        setState({
          ...state,
          loginUrl: verificationUrl,
          deviceCode: {
            userCode: event.userCode,
            verificationUrl,
            ...(event.expiresInSeconds === undefined ? {} : { expiresInSeconds: event.expiresInSeconds })
          }
        });
      } else if (event.type === 'info') {
        setState({
          ...state,
          notice: {
            type: 'info',
            message: safeLabel(event.message),
            ...(event.links ? {
              links: event.links.map(link => ({
                url: trustedLoginUrl(link.url),
                ...(link.label ? { label: safeLabel(link.label) } : {})
              }))
            } : {})
          }
        });
      } else if (event.type === 'progress') {
        setState({ ...state, notice: { type: 'progress', message: safeLabel(event.message) } });
      }
    } catch (error) {
      const authError = error instanceof ModelAuthError
        ? error
        : new ModelAuthError('LOGIN_EVENT_INVALID', 'Provider returned an invalid login event');
      fail(attempt, authError.code, authError.message);
      throw authError;
    }
  }

  function prompt(attempt: LoginAttempt, source: AuthPrompt): Promise<string> {
    if (!isActive(attempt)) return Promise.reject(new ModelAuthError('LOGIN_NOT_ACTIVE', 'Login is not active'));
    if (source.signal?.aborted) return Promise.reject(new ModelAuthError('PROMPT_ABORTED', 'Login prompt was superseded by the provider callback'));
    if (pending) return Promise.reject(new ModelAuthError('PROMPT_ALREADY_PENDING', 'Another login prompt is already pending'));
    const id = randomUUID();
    const shown = publicPrompt(id, source);
    let onAbort: (() => void) | undefined;
    return new Promise<string>((resolvePrompt, rejectPrompt) => {
      const cleanup = () => {
        if (onAbort) source.signal?.removeEventListener('abort', onAbort);
        onAbort = undefined;
      };
      pending = {
        attemptId: attempt.id,
        prompt: shown,
        source,
        resolve(value) { cleanup(); resolvePrompt(value); },
        reject(error) { cleanup(); rejectPrompt(error); },
        cleanup
      };
      onAbort = () => {
        if (pending?.prompt.id !== id || pending.attemptId !== attempt.id) return;
        pending = undefined;
        cleanup();
        if (isCurrent(attempt)) {
          const { prompt: _prompt, ...rest } = state;
          setState({ ...rest, phase: 'running' });
        }
        rejectPrompt(new ModelAuthError('PROMPT_ABORTED', 'Login prompt was superseded by the provider callback'));
      };
      source.signal?.addEventListener('abort', onAbort, { once: true });
      if (source.signal?.aborted) {
        onAbort();
        return;
      }
      setState({ ...state, phase: 'waiting_for_input', prompt: shown });
    });
  }

  function start(providerId = CODEX_PROVIDER, authType: AuthType = 'oauth'): LoginStatus {
    if (current && isActive(current)) throw new ModelAuthError('LOGIN_IN_PROGRESS', 'A provider login is already active');
    validateMethod(providerId, authType);
    const attempt: LoginAttempt = { id: randomUUID(), controller: new AbortController(), providerId, authType };
    current = attempt;
    setState({ phase: 'running', ...scope(attempt) });
    const interaction: AuthInteraction = {
      signal: attempt.controller.signal,
      prompt: source => prompt(attempt, source),
      notify: event => notify(attempt, event)
    };
    let task!: Promise<void>;
    task = Promise.resolve().then(() => input.models.login(attempt.providerId, attempt.authType, interaction)).then(credential => {
      if (!isCurrent(attempt)) return;
      rejectPending(attempt.id, new ModelAuthError('LOGIN_COMPLETED', 'Login completed before the pending prompt returned'));
      current = undefined;
      setState({ phase: 'succeeded', ...scope(attempt), credentialType: credential.type });
      try { input.onChange?.(); } catch { /* Wake-up callbacks cannot invalidate persisted login success. */ }
    }).catch((error: unknown) => {
      if (!isCurrent(attempt)) return;
      rejectPending(attempt.id, new ModelAuthError('LOGIN_FAILED', 'Provider login failed'));
      current = undefined;
      const code = error instanceof ModelAuthError ? error.code : 'LOGIN_FAILED';
      const message = error instanceof ModelAuthError ? error.message : 'Provider login failed';
      setState({ phase: 'failed', ...scope(attempt), error: { code, message } });
    }).finally(() => {
      inFlight.delete(task);
    });
    inFlight.add(task);
    return cloneStatus(state);
  }

  return {
    begin: start,
    status: () => cloneStatus(state),
    submitPrompt({ attemptId, promptId, value }) {
      const targetAttemptId = attemptId ?? state.attemptId;
      if (!pending || state.phase !== 'waiting_for_input' || pending.attemptId !== targetAttemptId || pending.prompt.id !== promptId) {
        throw new ModelAuthError('PROMPT_MISMATCH', 'Login prompt is no longer active');
      }
      const entered = pending.prompt.type === 'text' || pending.prompt.type === 'secret' ? value : value.trim();
      if (entered.length > MAX_INPUT) throw new ModelAuthError('INVALID_PROMPT_VALUE', 'Login prompt value is too long');
      if (pending.prompt.type === 'manual_code' && !entered) {
        throw new ModelAuthError('INVALID_PROMPT_VALUE', 'Authorization code is empty');
      }
      if (pending.prompt.type === 'select' && !pending.prompt.options?.some(option => option.id === entered)) {
        throw new ModelAuthError('INVALID_PROMPT_VALUE', 'Login selection is not one of the offered options');
      }
      const activePrompt = takePending(targetAttemptId!);
      const { prompt: _prompt, ...rest } = state;
      setState({ ...rest, phase: 'running' });
      activePrompt!.resolve(entered);
      return cloneStatus(state);
    },
    cancel(attemptId) {
      const targetAttemptId = attemptId ?? state.attemptId;
      const attempt = current;
      if (!attempt || !isActive(attempt) || attempt.id !== targetAttemptId) {
        throw new ModelAuthError('LOGIN_NOT_ACTIVE', 'Login attempt is no longer active');
      }
      setState({ phase: 'cancelled', ...scope(attempt) });
      current = undefined;
      attempt.controller.abort();
      rejectPending(attempt.id, new ModelAuthError('LOGIN_CANCELLED', 'Login cancelled'));
      return cloneStatus(state);
    },
    async drain() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    }
  };
}

export interface PublicModelInfo {
  id: string;
  name: string;
  reasoning: boolean;
  input: readonly ('text' | 'image')[];
}

function registeredProvider(models: Pick<Models, 'getProvider'>, providerId: string) {
  const provider = models.getProvider(providerId);
  if (!provider) throw new ModelAuthError('PROVIDER_NOT_FOUND', `Unknown model provider: ${providerId}`);
  return provider;
}

export function listProviderCapabilities(models: Pick<Models, 'getProviders'>): ProviderInfo[] {
  return models.getProviders().map(provider => {
    const methods: ProviderInfo['methods'] = [];
    if (provider.auth.apiKey) {
      methods.push({
        id: 'api_key',
        label: provider.auth.apiKey.name,
        kind: 'api',
        interactive: provider.auth.apiKey.login !== undefined
      });
    }
    if (provider.auth.oauth) {
      methods.push({
        id: 'oauth',
        label: provider.auth.oauth.loginLabel ?? provider.auth.oauth.name,
        kind: provider.auth.oauth.isSubscription ? 'subscription' : 'oauth',
        interactive: true
      });
    }
    return { id: provider.id, name: provider.name, methods };
  });
}

export function listProviderModels(
  models: Pick<Models, 'getProvider' | 'getModels'>,
  providerId = CODEX_PROVIDER
): PublicModelInfo[] {
  registeredProvider(models, providerId);
  return models.getModels(providerId).map(model => ({
    id: model.id,
    name: model.name,
    reasoning: model.reasoning,
    input: [...model.input]
  }));
}

/** Backward-compatible OpenAI Codex catalog helper. */
export function listCodexModels(models: Pick<Models, 'getProvider' | 'getModels'>): PublicModelInfo[] {
  return listProviderModels(models, CODEX_PROVIDER);
}

export async function selectProviderModel(
  models: Pick<Models, 'getProvider' | 'getAvailable'>,
  requestedId?: string,
  options?: AuthOperationOptions,
  providerId = CODEX_PROVIDER
): Promise<Model<Api>> {
  registeredProvider(models, providerId);
  const available = [...await models.getAvailable(providerId, options)];
  if (requestedId) {
    const requested = available.find(model => model.id === requestedId);
    if (!requested) throw new ModelAuthError('MODEL_NOT_AVAILABLE', `Requested model is not available for ${providerId}: ${requestedId}`);
    return requested;
  }
  const preference = providerId === CODEX_PROVIDER
    ? DEFAULT_CODEX_MODEL_PREFERENCE
    : (DEFAULT_API_MODEL_PREFERENCE[providerId] ?? []);
  for (const id of preference) {
    const candidate = available.find(model => model.id === id);
    if (candidate) return candidate;
  }
  const fallback = available.find(model => !/(?:deprecated|legacy|preview|experimental|(?:^|-)exp(?:-|$))/i.test(model.id)) ?? available[0];
  if (!fallback) throw new ModelAuthError('MODEL_NOT_AVAILABLE', `No authenticated model is available for ${providerId}`);
  return fallback;
}

/** Backward-compatible OpenAI Codex model selector. */
export function selectCodexModel(
  models: Pick<Models, 'getProvider' | 'getAvailable'>,
  requestedId?: string,
  options?: AuthOperationOptions
): Promise<Model<Api>> {
  return selectProviderModel(models, requestedId, options, CODEX_PROVIDER);
}

export interface ProductModelAuth {
  credentials: AtomicCredentialStore;
  models: MutableModels;
  login: OAuthLoginManager;
  listProviders(): ProviderInfo[];
  authStatus(options?: AuthOperationOptions, providerId?: string): Promise<{ providerId: string; loggedIn: boolean; type?: AuthType; loginMethod?: AuthType; source?: string }>;
  listModels(providerId?: string): PublicModelInfo[];
  selectModel(requestedId?: string, options?: AuthOperationOptions, providerId?: string): Promise<Model<Api>>;
  setApiKey(providerId: string, key: string): Promise<void>;
  close(): Promise<void>;
}
export interface ProductModelAuthOptions {
  dataDir: string;
  onChange?: () => void;
}

function tagProviderLoginMethods(models: MutableModels): void {
  for (const provider of models.getProviders()) {
    const apiKey = provider.auth.apiKey;
    if (apiKey?.login) {
      const login = apiKey.login;
      apiKey.login = async interaction => withLoginMethod(await login(interaction), 'api_key');
    }
    const oauth = provider.auth.oauth;
    if (oauth) {
      const login = oauth.login;
      oauth.login = async interaction => withLoginMethod(await login(interaction), 'oauth');
    }
  }
}
export function createProductModelAuth(input: ProductModelAuthOptions): ProductModelAuth {
  const credentials = new AtomicCredentialStore(input.dataDir);
  const models = builtinModels({
    credentials,
    authContext: {
      env: async () => undefined,
      fileExists: async () => false
    }
  });
  tagProviderLoginMethods(models);
  const login = createOAuthLoginManager({ models, onChange: input.onChange });
  return {
    credentials,
    models,
    login,
    listProviders: () => listProviderCapabilities(models),
    async authStatus(options, providerId = CODEX_PROVIDER) {
      registeredProvider(models, providerId);
      const [status, stored] = await Promise.all([
        models.checkAuth(providerId, options),
        credentials.read(providerId, options)
      ]);
      return {
        providerId,
        loggedIn: status !== undefined,
        ...(status ? {
          type: status.type,
          loginMethod: credentialLoginMethod(stored) ?? stored?.type ?? status.type,
          source: status.source
        } : {})
      };
    },
    listModels: providerId => listProviderModels(models, providerId),
    selectModel: (requestedId, options, providerId) => selectProviderModel(models, requestedId, options, providerId),
    async setApiKey(providerId, key) {
      const provider = registeredProvider(models, providerId);
      if (!provider.auth.apiKey?.login) {
        throw new ModelAuthError('API_KEY_NOT_SUPPORTED', `Provider has no interactive API credential flow: ${providerId}`);
      }
      const normalized = key.trim();
      if (!normalized || normalized.length > MAX_INPUT) {
        throw new ModelAuthError('INVALID_API_KEY', 'API key is empty or too long');
      }
      let answered = false;
      await models.login(providerId, 'api_key', {
        async prompt(prompt) {
          if (answered || prompt.type !== 'secret') {
            throw new ModelAuthError('API_KEY_FLOW_REQUIRES_INTERACTION', 'Provider API credential setup requires the interactive login flow');
          }
          answered = true;
          return normalized;
        },
        notify() { /* Legacy one-field route intentionally does not expose provider events. */ }
      });
      try { input.onChange?.(); } catch { /* Wake-up callbacks cannot invalidate persisted credentials. */ }
    },
    async close() {
      const phase = login.status().phase;
      if (phase === 'running' || phase === 'waiting_for_input') login.cancel();
      await login.drain();
      await credentials.drain();
    }
  };
}



