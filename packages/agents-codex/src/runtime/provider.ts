import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { NativeConfig } from './config';
import type { NativeModel, ModelProvider } from './models';
import { copyJsonValue, type JsonObject } from './binding';
import type { ToolRef } from './tools';
import type { Engine, _ProviderHttpTransports } from '../../native/index.js';
import { captureChatGPTAuth, type ChatGPTAuth } from './chatgpt-auth';

export interface NativeProviderOptions {
  modelBackend?: NativeModel | ModelProvider;
  /** Native retry budgets; Core caps each at 100. Zero disables retries. */
  requestMaxRetries?: number;
  streamMaxRetries?: number;
  /** Native phase timeouts in integer milliseconds; zero expires immediately. */
  streamIdleTimeoutMs?: number;
  websocketConnectTimeoutMs?: number;
  baseUrl?: string;
  apiKey?: string;
  supportsWebsockets?: boolean;
  /** Read one complete Responses JSON body over API-key HTTP. */
  responseMode?: 'streaming' | 'buffered';
  queryParams?: Readonly<Record<string, string>>;
  headers?: Readonly<Record<string, string>>;
  /** Resolve once when this descriptor is constructed; missing/empty values stay omitted. */
  envHeaders?: Readonly<Record<string, string>>;
  organization?: string;
  project?: string;
  /** Explicit personal Apps credentials; never used for Model requests or refreshed. */
  chatGPT?: ChatGPTAuth;
}

interface LeaseToken {
  failed: boolean;
  cleanup?: () => Promise<void>;
  pending?: Promise<void>;
}

function cleanFailedOpening(token: LeaseToken): Promise<void> {
  if (token.pending) return token.pending;
  const cleanup = token.cleanup!;
  token.pending = Promise.resolve()
    .then(cleanup)
    .finally(() => {
      token.pending = undefined;
    });
  return token.pending;
}

/**
 * A lazy native Responses connection. Close sessions before closing their provider.
 * Routing maps and envHeaders values are captured at construction; missing/empty
 * env values stay omitted. Routing options reject same/cross-origin redirects.
 * Native auth/protocol/private-hop headers remain reserved. A new provider
 * refreshes the captured routing values.
 * Ordinary API-key HTTP clients may retain default/custom trust and ambient proxy
 * state until close. Construct a new provider to force fresh physical clients.
 */
export class NativeProvider {
  #options: Readonly<NativeProviderOptions>;
  #leases = new Set<LeaseToken>();
  #closed = false;
  #httpTransports?: _ProviderHttpTransports;
  #routing: Readonly<{
    query_params?: Readonly<Record<string, string>>;
    http_headers?: Readonly<Record<string, string>>;
  }>;

  constructor(options: NativeProviderOptions = {}) {
    if (options.modelBackend !== undefined) {
      if (
        !options.modelBackend ||
        ((!('complete' in options.modelBackend) ||
          typeof options.modelBackend.complete !== 'function') &&
          (!('getModel' in options.modelBackend) ||
            typeof options.modelBackend.getModel !== 'function'))
      )
        throw new TypeError(
          'modelBackend must implement complete(request) or getModel(modelName)',
        );
      if (options.supportsWebsockets === true || options.chatGPT !== undefined)
        throw new TypeError(
          'modelBackend requires HTTP mode without ChatGPT authentication',
        );
    }
    for (const key of [
      'requestMaxRetries',
      'streamMaxRetries',
      'streamIdleTimeoutMs',
      'websocketConnectTimeoutMs',
    ] as const) {
      const value = options[key];
      if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
        throw new TypeError(`${key} must be a nonnegative safe integer`);
    }
    for (const key of ['baseUrl', 'apiKey'] as const) {
      if (
        options[key] !== undefined &&
        (typeof options[key] !== 'string' || !options[key])
      )
        throw new TypeError(`${key} must be a non-empty string`);
    }
    if (
      options.supportsWebsockets !== undefined &&
      typeof options.supportsWebsockets !== 'boolean'
    )
      throw new TypeError('supportsWebsockets must be a boolean');
    if (
      options.responseMode !== undefined &&
      !['streaming', 'buffered'].includes(options.responseMode)
    )
      throw new TypeError('responseMode must be streaming or buffered');
    if (
      options.responseMode === 'buffered' &&
      options.supportsWebsockets === true
    )
      throw new TypeError(
        'buffered Responses requires HTTP without WebSockets',
      );
    const routing = captureProviderRouting(options);
    this.#routing = routing.config;
    const captured = { ...options, ...routing.options };
    this.#options = Object.freeze({
      ...captured,
      chatGPT: captureChatGPTAuth(captured.chatGPT),
    });
  }

  get modelBackend(): NativeModel | ModelProvider | undefined {
    return this.#options.modelBackend;
  }
  get baseUrl(): string | undefined {
    return this.#options.baseUrl;
  }
  get responseMode(): 'streaming' | 'buffered' {
    return this.#options.responseMode ?? 'streaming';
  }
  get apiKey(): string | undefined {
    return this.#options.apiKey;
  }
  get supportsWebsockets(): boolean | undefined {
    return this.#options.supportsWebsockets;
  }

  /** @internal Reserve synchronously after declaration validation, before opening resources. */
  _acquire(captured?: { readonly apiKey: string | undefined }): ProviderLease {
    if (this.#closed) throw new Error('NativeProvider is closed');
    const token: LeaseToken = { failed: false };
    this.#leases.add(token);
    const options = this.#options;
    const websocketsAllowed =
      options.modelBackend === undefined &&
      options.responseMode !== 'buffered' &&
      (options.supportsWebsockets ?? options.baseUrl === undefined);
    let home: string | undefined;
    let released = false;
    const release = async () => {
      if (released) return;
      if (home) await rm(home, { recursive: true, force: true });
      released = true;
      this.#leases.delete(token);
      token.cleanup = undefined;
    };
    token.cleanup = release;
    return {
      get failedOpeningCleanup() {
        return token.failed && token.cleanup
          ? () => cleanFailedOpening(token)
          : undefined;
      },
      websocketsAllowed,
      httpTransports: (create, engine) => {
        if (options.chatGPT) return undefined;
        if (released || this.#closed)
          throw new Error('NativeProvider lease is closed');
        // Synchronous empty allocation: no first-opening signal or pending task.
        return (this.#httpTransports ??= create(engine));
      },
      chatGPT: options.chatGPT,
      apiKey:
        options.modelBackend !== undefined
          ? 'native-model-producer'
          : captured
            ? captured.apiKey
            : (options.apiKey ?? process.env.OPENAI_API_KEY),
      config: {
        model_provider: 'native_agent',
        'model_providers.native_agent': {
          name: 'Native agent provider',
          base_url: options.baseUrl ?? 'https://api.openai.com/v1',
          wire_api: 'responses',
          requires_openai_auth: true,
          supports_websockets: websocketsAllowed,
          ...this.#routing,
          ...Object.fromEntries(
            Object.entries({
              request_max_retries: options.requestMaxRetries,
              stream_max_retries: options.streamMaxRetries,
              stream_idle_timeout_ms: options.streamIdleTimeoutMs,
              websocket_connect_timeout_ms: options.websocketConnectTimeoutMs,
            }).filter(([, value]) => value !== undefined),
          ),
        },
      },
      async open() {
        home = await mkdtemp(join(tmpdir(), 'agents-session-'));
        const cwd = join(home, 'workspace');
        await mkdir(cwd);
        return { codex_home: home, cwd };
      },
      release,
      retainOpeningCleanup(cleanup) {
        const previous = token.cleanup;
        token.cleanup = cleanup;
        return previous;
      },
      openingSucceeded() {
        token.cleanup = undefined;
      },
      async failOpening(error, cleanup = true) {
        token.failed = true;
        if (!cleanup) throw error;
        try {
          await cleanFailedOpening(token);
        } catch (cleanupError) {
          throw new AggregateError(
            [error, cleanupError],
            released
              ? 'Session opening and cleanup failed'
              : 'Session opening failed; close active sessions, then call the captured provider.close() to retry cleanup',
            { cause: error },
          );
        }
        throw error;
      },
    };
  }

  async close(): Promise<void> {
    if ([...this.#leases].some((token) => !token.failed))
      throw new Error('NativeProvider has open or opening sessions');
    this.#closed = true;
    const results = await Promise.allSettled(
      [...this.#leases].map(cleanFailedOpening),
    );
    const failures = results.flatMap((result) =>
      result.status === 'rejected' ? [result.reason] : [],
    );
    if (failures.length)
      throw new AggregateError(failures, 'NativeProvider cleanup failed', {
        cause: failures[0],
      });
    this.#httpTransports?.close();
    this.#httpTransports = undefined;
  }

  [Symbol.asyncDispose](): Promise<void> {
    return this.close();
  }
}

/** @internal */
export interface ProviderLease {
  readonly chatGPT?: Readonly<ChatGPTAuth>;
  readonly failedOpeningCleanup: (() => Promise<void>) | undefined;
  readonly websocketsAllowed: boolean;
  httpTransports(
    create: (engine: Engine) => _ProviderHttpTransports,
    engine: Engine,
  ): _ProviderHttpTransports | undefined;
  apiKey: string | undefined;
  config: NativeConfig;
  open(): Promise<{ codex_home: string; cwd: string }>;
  release(): Promise<void>;
  retainOpeningCleanup(
    cleanup: () => Promise<void>,
  ): (() => Promise<void>) | undefined;
  openingSucceeded(): void;
  failOpening(error: unknown, cleanup?: boolean): Promise<never>;
}

export interface ModelSettings {
  /** One local model invocation deadline in positive uint32 milliseconds; null clears.
   * Includes internal request waits and retries. Cleanup can finish after expiry;
   * accepted terminal responses disarm the clock before result settlement.
   */
  invocationTimeoutMs?: number | null;
  reasoningEffort?: string;
  reasoningSummary?: string;
  /** null clears an existing service tier override. */
  serviceTier?: string | null;
  /** Outer choice, or a captured eager ToolRef. A named target only narrows
   * the current admitted catalog; null clears it to auto. */
  toolChoice?: 'auto' | 'none' | 'required' | ToolRef | null;
  /** Nonnegative safe integer for ordinary sampling; null clears the SDK override. */
  maxOutputTokens?: number | null;
  temperature?: number | null;
  topP?: number | null;
  /** Request probabilities and zero to 255 alternatives per chosen token. */
  topLogprobs?: number | null;
  parallelToolCalls?: boolean | null;
  verbosity?: 'low' | 'medium' | 'high' | null;
  metadata?: Readonly<Record<string, string>> | null;
  store?: boolean | null;
  promptCacheRetention?: 'in_memory' | '24h' | null;
  /** Distinct from retention; omission leaves the provider default omitted. */
  promptCacheTtl?: '30m' | '12h' | null;
  truncation?: 'auto' | 'disabled' | null;
  /** Additional response fields; native replay and hosted-tool includes remain enabled. */
  include?: readonly string[] | null;
  contextManagement?: readonly JsonObject[] | null;
  extraBody?: JsonObject | null;
}

/** @internal Capture nested settings before opening can await. */
export function captureModelSettings(source?: ModelSettings): ModelSettings {
  if (source === undefined) return {};
  if (source === null || typeof source !== 'object' || Array.isArray(source))
    throw new TypeError('modelSettings must be an object');
  const result: Record<string, unknown> = {};
  const allowed = new Set([
    'reasoningEffort',
    'reasoningSummary',
    'serviceTier',
    'toolChoice',
    'invocationTimeoutMs',
    'maxOutputTokens',
    'temperature',
    'topP',
    'topLogprobs',
    'parallelToolCalls',
    'verbosity',
    'metadata',
    'store',
    'promptCacheRetention',
    'promptCacheTtl',
    'truncation',
    'include',
    'contextManagement',
    'extraBody',
  ]);
  for (const key of Object.getOwnPropertyNames(source)) {
    if (!allowed.has(key))
      throw new TypeError(`Unsupported model setting: ${key}`);
    let value = (source as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (value !== null) {
      if (key === 'invocationTimeoutMs') {
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 1 ||
          value > 4294967295
        )
          throw new TypeError(
            'invocationTimeoutMs must be an integer in the range 1..4294967295 or null',
          );
      } else if (key === 'maxOutputTokens') {
        if (!Number.isSafeInteger(value) || (value as number) < 0)
          throw new TypeError(
            'maxOutputTokens must be a nonnegative safe integer',
          );
      } else if (key === 'topLogprobs') {
        if (
          !Number.isInteger(value) ||
          (value as number) < 0 ||
          (value as number) > 255
        )
          throw new TypeError(
            'topLogprobs must be an integer between zero and 255',
          );
      } else if (key === 'temperature' || key === 'topP') {
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new TypeError(`${key} must be a finite number or null`);
      } else if (key === 'parallelToolCalls' || key === 'store') {
        if (typeof value !== 'boolean')
          throw new TypeError(`${key} must be boolean or null`);
      } else if (key === 'truncation') {
        if (value !== 'auto' && value !== 'disabled')
          throw new TypeError('truncation must be auto or disabled');
      } else if (key === 'include') {
        if (
          !Array.isArray(value) ||
          value.some((item) => typeof item !== 'string')
        )
          throw new TypeError('include must be an array of strings');
        value = [...value];
      } else if (key === 'contextManagement' || key === 'extraBody') {
        if (key === 'contextManagement') {
          if (
            !Array.isArray(value) ||
            value.some(
              (item) =>
                item === null ||
                typeof item !== 'object' ||
                Array.isArray(item),
            )
          )
            throw new TypeError(
              'contextManagement must be an array of JSON objects',
            );
        } else if (typeof value !== 'object' || Array.isArray(value))
          throw new TypeError('extraBody must be a JSON object');
        if (
          key === 'extraBody' &&
          Object.keys(value).some((field) =>
            [
              'type',
              'generate',
              'model',
              'stream',
              'input',
              'instructions',
              'tools',
              'tool_choice',
              'parallel_tool_calls',
              'reasoning',
              'store',
              'stream_options',
              'include',
              'prompt_cache_key',
              'text',
              'client_metadata',
              'access_programs',
              'previous_response_id',
              'conversation',
              'service_tier',
              'max_output_tokens',
              'temperature',
              'top_p',
              'top_logprobs',
              'metadata',
              'prompt_cache_retention',
              'prompt_cache_options',
              'truncation',
              'context_management',
            ].includes(field),
          )
        )
          throw new TypeError(
            'extraBody cannot replace native request fields; use the corresponding model setting',
          );
        value = copyJsonValue(value);
      } else if (key === 'metadata') {
        if (typeof value !== 'object' || Array.isArray(value))
          throw new TypeError('metadata must be a string map');
        const pairs = Object.entries(value);
        if (pairs.some(([, v]) => typeof v !== 'string'))
          throw new TypeError('metadata must be a string map');
        value = Object.freeze(Object.fromEntries(pairs));
      } else if (key === 'toolChoice') {
        if (typeof value === 'object' && value !== null) {
          const target = value as Partial<ToolRef>;
          if (
            Object.getOwnPropertyNames(target).some(
              (name) => !['kind', 'name', 'namespace'].includes(name),
            ) ||
            target.kind !== 'tool_ref' ||
            typeof target.name !== 'string' ||
            !target.name.trim() ||
            (target.namespace != null &&
              (typeof target.namespace !== 'string' ||
                !target.namespace.trim()))
          )
            throw new TypeError('toolChoice must identify a captured tool');
          value = Object.freeze({
            kind: 'tool_ref',
            name: target.name,
            namespace: target.namespace,
          });
        } else if (!['auto', 'none', 'required'].includes(value as string))
          throw new TypeError('toolChoice must be an outer mode or ToolRef');
      } else if (typeof value !== 'string') {
        throw new TypeError(`Invalid model setting: ${key}`);
      }
    } else if (
      ![
        'serviceTier',
        'toolChoice',
        'invocationTimeoutMs',
        'maxOutputTokens',
        'temperature',
        'topP',
        'topLogprobs',
        'parallelToolCalls',
        'verbosity',
        'metadata',
        'store',
        'promptCacheRetention',
        'promptCacheTtl',
        'truncation',
        'include',
        'contextManagement',
        'extraBody',
      ].includes(key)
    ) {
      throw new TypeError(`Invalid null model setting: ${key}`);
    }
    result[key] = value;
  }
  return result as ModelSettings;
}

/** Capture routing values, never environment names, into the native descriptor. */
function captureProviderRouting(options: NativeProviderOptions) {
  const configured = [
    'queryParams',
    'headers',
    'envHeaders',
    'organization',
    'project',
  ].some((name) => options[name as keyof NativeProviderOptions] !== undefined);
  if (configured) {
    let base: URL;
    try {
      base = new URL(options.baseUrl ?? 'https://api.openai.com/v1');
    } catch {
      throw new TypeError(
        'Custom provider routing requires an absolute HTTP(S) base URL',
      );
    }
    if (
      !['http:', 'https:'].includes(base.protocol) ||
      !base.hostname ||
      base.username ||
      base.password ||
      base.hash
    )
      throw new TypeError(
        'Custom provider routing requires an HTTP(S) URL without userinfo or fragment',
      );
  }
  const copied: Partial<NativeProviderOptions> = {};
  for (const name of ['queryParams', 'headers', 'envHeaders'] as const) {
    const value = options[name];
    if (value !== undefined) {
      if (
        value === null ||
        typeof value !== 'object' ||
        Array.isArray(value) ||
        Object.entries(value).some(
          ([key, item]) => !key || typeof item !== 'string',
        )
      )
        throw new TypeError(`${name} must be a string map with nonempty keys`);
      copied[name] = Object.freeze(Object.fromEntries(Object.entries(value)));
    }
  }
  const protectedNames = new Set([
    'authorization',
    'proxy-authorization',
    'cookie',
    'host',
    'connection',
    'upgrade',
    'content-length',
    'transfer-encoding',
    'te',
    'trailer',
    'keep-alive',
    'proxy-connection',
    'content-type',
    'accept',
    'accept-encoding',
    'user-agent',
    'openai-beta',
    'originator',
    'session_id',
    'x-client-request-id',
    'x-request-id',
    'chatgpt-account-id',
    'openai-organization',
    'openai-project',
    'x-responsesapi-include-timing-metrics',
    'x-sdk-sentinel-grant',
  ]);
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const name of ['headers', 'envHeaders'] as const) {
    for (const [key, original] of Object.entries(copied[name] ?? {})) {
      const lower = key.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(key) ||
        protectedNames.has(lower) ||
        ['sec-websocket-', 'x-codex-', 'x-openai-'].some((prefix) =>
          lower.startsWith(prefix),
        )
      )
        throw new TypeError(
          'Provider header name is invalid or belongs to native transport/auth',
        );
      if (seen.has(lower))
        throw new TypeError(
          'Provider header names must be unique ignoring case',
        );
      seen.add(lower);
      let value = original;
      if (name === 'envHeaders') {
        if (!value || value.includes('=') || value.includes('\u0000'))
          throw new TypeError(
            'envHeaders values must name environment variables',
          );
        const selected = process.env[value];
        if (selected === undefined || !selected.trim()) continue;
        value = selected;
      }
      if (/[^\x20-\x7e]/.test(value))
        throw new TypeError(
          'Provider header values must contain printable ASCII',
        );
      Object.defineProperty(headers, lower, { value, enumerable: true });
    }
  }
  for (const [name, header] of [
    ['organization', 'openai-organization'],
    ['project', 'openai-project'],
  ] as const) {
    const value = options[name];
    if (value !== undefined) {
      if (
        typeof value !== 'string' ||
        !value.trim() ||
        /[^\x20-\x7e]/.test(value)
      )
        throw new TypeError(
          `${name} must be a nonempty printable ASCII string`,
        );
      Object.defineProperty(headers, header, { value, enumerable: true });
    }
  }
  const config: {
    query_params?: Readonly<Record<string, string>>;
    http_headers?: Readonly<Record<string, string>>;
  } = {};
  if (options.queryParams !== undefined)
    config.query_params = copied.queryParams;
  if (
    ['headers', 'envHeaders', 'organization', 'project'].some(
      (name) => options[name as keyof NativeProviderOptions] !== undefined,
    )
  )
    config.http_headers = Object.freeze(headers);
  return { options: copied, config: Object.freeze(config) };
}

/** @internal Shared projection for Session updates and captured Agent profiles. */
export function modelOverrides(
  model?: string,
  settings?: ModelSettings,
): JsonObject {
  const selected = captureModelSettings(settings);
  const overrides: JsonObject = {};
  if (selected.invocationTimeoutMs !== undefined)
    overrides.invocation_timeout_ms = selected.invocationTimeoutMs;
  const controls: JsonObject = {};
  if (model !== undefined) {
    if (typeof model !== 'string' || !model.trim())
      throw new TypeError('model must be a nonempty string');
    overrides.model = model;
  }
  if (selected.reasoningEffort !== undefined)
    overrides.effort = selected.reasoningEffort;
  if (selected.reasoningSummary !== undefined)
    overrides.summary = selected.reasoningSummary;
  if (selected.serviceTier !== undefined)
    overrides.service_tier = selected.serviceTier;
  const names = {
    maxOutputTokens: 'max_output_tokens',
    temperature: 'temperature',
    topP: 'top_p',
    topLogprobs: 'top_logprobs',
    parallelToolCalls: 'parallel_tool_calls',
    verbosity: 'verbosity',
    metadata: 'metadata',
    store: 'store',
    promptCacheRetention: 'prompt_cache_retention',
    promptCacheTtl: 'prompt_cache_ttl',
    truncation: 'truncation',
    include: 'include',
    contextManagement: 'context_management',
    extraBody: 'extra_body',
  } as const;
  for (const [key, wire] of Object.entries(names)) {
    const value = selected[key as keyof typeof names];
    if (value !== undefined) controls[wire] = copyJsonValue(value);
  }
  if (selected.toolChoice !== undefined) {
    const choice = selected.toolChoice;
    if (typeof choice === 'object' && choice !== null) {
      overrides.tool_choice = 'required';
      controls.named_tool_choice = {
        name: choice.name,
        namespace: choice.namespace ?? null,
      };
    } else {
      overrides.tool_choice = choice ?? 'auto';
      controls.named_tool_choice = null;
    }
  }
  if (Object.keys(controls).length) overrides.request_controls = controls;
  return overrides;
}
