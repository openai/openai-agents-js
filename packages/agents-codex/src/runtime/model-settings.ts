import { z } from 'zod';
import {
  captureModelRetrySettings,
  retrySettingsToNative,
  type ModelRetrySettings,
} from './model-retry';
import { copyJsonValue, type JsonObject } from './binding';
import type { ToolRef } from './tools';

const compactionTokenThreshold = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);
const providerCompactionPolicySchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('static'),
    threshold: compactionTokenThreshold,
  }),
  z.strictObject({
    type: z.literal('dynamic'),
    thresholdRatio: z.number().min(0).max(1).optional(),
    fallbackThreshold: compactionTokenThreshold.optional(),
  }),
]);

export type ProviderCompactionPolicy = z.input<
  typeof providerCompactionPolicySchema
>;

export type HostedToolChoice =
  | {
      readonly type:
        | 'web_search'
        | 'file_search'
        | 'code_interpreter'
        | 'image_generation'
        | 'computer'
        | 'computer_use_preview'
        | 'shell'
        | 'apply_patch'
        | 'tool_search'
        | 'programmatic_tool_calling';
    }
  | {
      readonly type: 'mcp';
      readonly serverLabel: string;
      readonly name?: string;
    };

function captureHostedToolChoice(value: unknown): HostedToolChoice {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Hosted tool choice must be a typed selector');
  const choice = value as Record<string, unknown>;
  const types = [
    'web_search',
    'file_search',
    'code_interpreter',
    'image_generation',
    'computer',
    'computer_use_preview',
    'shell',
    'apply_patch',
    'tool_search',
    'programmatic_tool_calling',
    'mcp',
  ];
  if (
    !Object.prototype.hasOwnProperty.call(choice, 'type') ||
    !types.includes(choice.type as string) ||
    Object.getOwnPropertyNames(choice).some(
      (key) =>
        !(
          choice.type === 'mcp' ? ['type', 'serverLabel', 'name'] : ['type']
        ).includes(key),
    )
  )
    throw new TypeError(
      'Hosted tool choice must identify a supported provider tool',
    );
  if (choice.type === 'mcp') {
    if (
      typeof choice.serverLabel !== 'string' ||
      !choice.serverLabel.trim() ||
      (choice.name !== undefined &&
        (typeof choice.name !== 'string' || !choice.name.trim()))
    )
      throw new TypeError(
        'Hosted MCP choice requires a captured server and tool identity',
      );
    return Object.freeze({
      type: 'mcp',
      serverLabel: choice.serverLabel,
      ...(choice.name === undefined ? {} : { name: choice.name }),
    });
  }
  return Object.freeze({ type: choice.type }) as HostedToolChoice;
}

export interface ModelSettings {
  /** Per logical attempt, excluding retry backoff; null restores the default. */
  attemptTimeoutMs?: number | null;
  /** Native generation retry settings; null clears, omission preserves. */
  retry?: ModelRetrySettings | null;
  /** One local model invocation deadline in positive uint32 milliseconds; null clears.
   * Includes internal request waits and retries. Cleanup can finish after expiry;
   * accepted terminal responses disarm the clock before result settlement.
   */
  invocationTimeoutMs?: number | null;
  reasoningEffort?: string;
  reasoningSummary?: string;
  /** null clears an existing service tier override. */
  serviceTier?: string | null;
  /** Outer mode, captured eager ToolRef, or explicit hosted selector. A named target only narrows
   * the current admitted catalog; null clears it to auto. */
  toolChoice?: 'auto' | 'none' | 'required' | ToolRef | HostedToolChoice | null;
  /** Nonnegative safe integer for ordinary sampling; null clears the SDK override. */
  /** Full input-capability declaration for the selected model; null restores its catalogue. */
  inputModalities?: readonly ('text' | 'image' | 'audio')[] | null;
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
  /** Request policy; null clears this override independently of TTL. */
  promptCacheMode?: 'explicit' | null;
  truncation?: 'auto' | 'disabled' | null;
  /** Additional response fields; native replay and hosted-tool includes remain enabled. */
  include?: readonly string[] | null;
  contextManagement?: readonly JsonObject[] | null;
  /** Standard Responses compaction threshold. Explicit contextManagement takes precedence. */
  providerCompaction?: ProviderCompactionPolicy | null;
  extraBody?: JsonObject | null;
  /** Request headers; a null value omits a provider default. Native auth stays provider-owned. */
  extraHeaders?: Readonly<Record<string, string | null>> | null;
  /** Request-local JSON query values; null clears the query override. */
  extraQuery?: Readonly<JsonObject> | null;
  /** Explicit websocket has been preventing HTTP fallback and uncertain automatic replay. */
  requestTransport?: 'auto' | 'http' | 'websocket' | null;
  /**
   * Ordinary text sampling only: opt-in release of required/named forcing after an
   * accepted tool batch on this profile.
   * Omitted/false/null: persistent forcing. New runs and incoming profiles: their own
   * declared first choice. No change to toolChoice: 'none'.
   */
  resetToolChoice?: boolean | null;
}

const protectedTransportHeaders = new Set([
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

/** @internal Shared with provider-level header capture. */
export function invalidTransportHeaderName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name) ||
    protectedTransportHeaders.has(lower) ||
    ['sec-websocket-', 'x-codex-', 'x-openai-'].some((prefix) =>
      lower.startsWith(prefix),
    )
  );
}

function captureRequestHeaders(
  value: unknown,
): Readonly<Record<string, string | null>> {
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    throw new TypeError('extraHeaders must be a header map or null');
  const captured: Record<string, string | null> = {};
  const seen = new Set<string>();
  for (const [name, header] of Object.entries(value)) {
    const lower = name.toLowerCase();
    if (
      invalidTransportHeaderName(name) ||
      lower === 'api-key' ||
      seen.has(lower)
    )
      throw new TypeError(
        'Request header name is invalid, duplicated, or owned by native transport/auth',
      );
    if (
      header !== null &&
      (typeof header !== 'string' || /[^\x20-\x7e]/.test(header))
    )
      throw new TypeError(
        'Request header values must contain printable ASCII or null',
      );
    seen.add(lower);
    Object.defineProperty(captured, lower, { value: header, enumerable: true });
  }
  return Object.freeze(captured);
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
    'attemptTimeoutMs',
    'retry',
    'resetToolChoice',
    'inputModalities',
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
    'promptCacheMode',
    'truncation',
    'include',
    'contextManagement',
    'providerCompaction',
    'extraBody',
    'extraHeaders',
    'extraQuery',
    'requestTransport',
  ]);
  for (const key of Object.getOwnPropertyNames(source)) {
    if (!allowed.has(key))
      throw new TypeError(`Unsupported model setting: ${key}`);
    let value = (source as unknown as Record<string, unknown>)[key];
    if (value === undefined) continue;
    if (value !== null) {
      if (key === 'invocationTimeoutMs' || key === 'attemptTimeoutMs') {
        if (
          typeof value !== 'number' ||
          !Number.isInteger(value) ||
          value < 1 ||
          value > 4294967295
        )
          throw new TypeError(
            `${key} must be an integer in the range 1..4294967295 or null`,
          );
      } else if (key === 'retry') {
        value = captureModelRetrySettings(value as ModelRetrySettings);
      } else if (key === 'inputModalities') {
        if (
          !Array.isArray(value) ||
          !value.length ||
          value.some((item) => !['text', 'image', 'audio'].includes(item)) ||
          new Set(value).size !== value.length
        )
          throw new TypeError(
            'inputModalities must be a nonempty array of distinct text/image/audio values',
          );
        value = Object.freeze([...value]);
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
      } else if (
        key === 'parallelToolCalls' ||
        key === 'store' ||
        key === 'resetToolChoice'
      ) {
        if (typeof value !== 'boolean')
          throw new TypeError(`${key} must be boolean or null`);
      } else if (key === 'promptCacheMode') {
        if (value !== 'explicit')
          throw new TypeError('promptCacheMode must be explicit or null');
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
      } else if (key === 'providerCompaction') {
        value = providerCompactionPolicySchema.parse(value);
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
              'input_modalities',
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
      } else if (key === 'requestTransport') {
        if (!['auto', 'http', 'websocket'].includes(value as string))
          throw new TypeError(
            'requestTransport must select auto, http, or websocket',
          );
      } else if (key === 'extraHeaders') {
        value = captureRequestHeaders(value);
      } else if (key === 'extraQuery') {
        if (
          typeof value !== 'object' ||
          Array.isArray(value) ||
          Object.keys(value).some((name) => !name)
        )
          throw new TypeError(
            'extraQuery must be a JSON object with nonempty keys',
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
        if (typeof value === 'object' && value !== null && 'type' in value) {
          value = captureHostedToolChoice(value);
        } else if (typeof value === 'object' && value !== null) {
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
        'inputModalities',
        'resetToolChoice',
        'reset_tool_choice',
        'toolChoice',
        'invocationTimeoutMs',
        'attemptTimeoutMs',
        'retry',
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
        'promptCacheMode',
        'truncation',
        'include',
        'contextManagement',
        'providerCompaction',
        'extraBody',
        'extraHeaders',
        'extraQuery',
        'requestTransport',
      ].includes(key)
    ) {
      throw new TypeError(`Invalid null model setting: ${key}`);
    }
    result[key] = value;
  }
  return result as ModelSettings;
}

/** @internal The same detached transport settings are used during startup and sampling. */
export function requestTransportWire(
  settings?: ModelSettings,
): JsonObject | undefined {
  const transport: JsonObject = {};
  if (settings?.requestTransport !== undefined)
    transport.mode = settings.requestTransport;
  if (settings?.extraHeaders !== undefined)
    transport.headers = copyJsonValue(settings.extraHeaders);
  if (settings?.extraQuery !== undefined) {
    transport.query = copyJsonValue(settings.extraQuery);
    transport.query_nulls_as_empty = true;
  }
  return Object.keys(transport).length ? transport : undefined;
}

/** @internal Shared projection for Session updates and captured Agent profiles. */
export function modelOverrides(
  model?: string,
  settings?: ModelSettings,
  hostedPrompt?: JsonObject | null,
): JsonObject {
  const selected = captureModelSettings(settings);
  const overrides: JsonObject = {};
  if (selected.invocationTimeoutMs !== undefined)
    overrides.invocation_timeout_ms = selected.invocationTimeoutMs;
  const controls: JsonObject = {};
  if (hostedPrompt !== undefined)
    controls.hosted_prompt = copyJsonValue(hostedPrompt);
  if (selected.attemptTimeoutMs !== undefined)
    controls.attempt_timeout_ms = selected.attemptTimeoutMs;
  if (selected.retry !== undefined)
    controls.retry =
      selected.retry === null ? null : retrySettingsToNative(selected.retry);
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
    inputModalities: 'input_modalities',
    resetToolChoice: 'reset_tool_choice',
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
    promptCacheMode: 'prompt_cache_mode',
    truncation: 'truncation',
    include: 'include',
    contextManagement: 'context_management',
    extraBody: 'extra_body',
  } as const;
  for (const [key, wire] of Object.entries(names)) {
    const value = selected[key as keyof typeof names];
    if (value !== undefined) controls[wire] = copyJsonValue(value);
  }
  const transport = requestTransportWire(selected);
  if (transport !== undefined) controls.request_transport = transport;
  if (selected.providerCompaction !== undefined) {
    const policy = selected.providerCompaction;
    controls.provider_compaction =
      policy?.type === 'dynamic'
        ? {
            type: 'dynamic',
            threshold_ratio: policy.thresholdRatio ?? 0.9,
            fallback_threshold: policy.fallbackThreshold ?? 240_000,
          }
        : policy;
  }
  if (selected.toolChoice !== undefined) {
    const choice = selected.toolChoice;
    if (typeof choice === 'object' && choice !== null && 'type' in choice) {
      overrides.tool_choice = 'required';
      controls.named_tool_choice = null;
      controls.hosted_tool_choice =
        choice.type === 'mcp'
          ? {
              type: choice.type,
              server_label: choice.serverLabel,
              ...(choice.name === undefined ? {} : { name: choice.name }),
            }
          : { type: choice.type };
    } else if (typeof choice === 'object' && choice !== null) {
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
