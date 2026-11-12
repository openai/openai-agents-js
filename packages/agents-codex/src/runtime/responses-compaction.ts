import { isDeepStrictEqual } from 'node:util';
import OpenAI from 'openai';
import OpenAICommonJS from 'openai/index.js';
import { loadOpenAIEntrypoint } from '../../node/openai-entrypoint.js';
import { losslessJsonObjectSchema } from './binding';
import type { TokenUsage } from './run-events';
import type { CompactionContext } from './model-callbacks';

export interface ResponsesCompactionContext<
  Context = unknown,
> extends CompactionContext<Context> {
  readonly candidates: CompactionContext<Context>['items'];
  readonly mode: 'input' | 'previous_response_id';
}

export interface ResponsesCompactionOptions<Context = unknown> {
  /** Borrowed application client; the Session never closes it. */
  client: OpenAI;
  /** Defaults to the captured native compaction source model. */
  model?: string;
  /** Auto has been selecting previous-response mode for an acknowledged,
   * unchanged native provider window for a matching plain SDK client and account,
   * without a context transform, and otherwise
   * supplying input. Explicit
   * previous-response mode has been requiring that receipt and matching client scope
   * before client effects. Custom routing/transports have been using input. */
  mode?: 'auto' | 'input' | 'previous_response_id';
  /** Controls optional post-turn compaction, excluding manual/required work. */
  shouldCompact?: (
    context: ResponsesCompactionContext<Context>,
  ) => boolean | Promise<boolean>;
}

/** Captured current-application configuration, excluded from saved state. */
export class ResponsesCompaction<Context = unknown> {
  readonly model?: string;
  readonly mode: 'auto' | 'input' | 'previous_response_id';
  readonly shouldCompact?: ResponsesCompactionOptions<Context>['shouldCompact'];
  readonly #compact: OpenAI['responses']['compact'];
  readonly #client: OpenAI;
  readonly #clientScope: ClientScope | undefined;

  constructor(options: ResponsesCompactionOptions<Context>) {
    for (const key of Object.keys(options))
      if (!['client', 'model', 'mode', 'shouldCompact'].includes(key))
        throw new TypeError('Unknown compaction option');
    const { client, model, mode = 'auto', shouldCompact } = options;
    const responses = client?.responses;
    const compact = responses?.compact;
    if (model !== undefined && (typeof model !== 'string' || !model.trim()))
      throw new TypeError('Compaction model must be a nonempty string');
    if (!['auto', 'input', 'previous_response_id'].includes(mode))
      throw new TypeError('Invalid compaction mode');
    if (shouldCompact !== undefined && typeof shouldCompact !== 'function')
      throw new TypeError('shouldCompact must be a function');
    if (typeof compact !== 'function')
      throw new TypeError('Compaction client must provide responses.compact');
    this.model = model;
    this.mode = mode;
    this.shouldCompact = shouldCompact;
    this.#compact = compact.bind(responses);
    this.#client = client;
    const scope = responsesClientScope(client);
    this.#clientScope =
      scope?.responses === responses && scope.compact === compact
        ? scope
        : undefined;
    Object.freeze(this);
  }

  /** @internal Resolve an alternate built-in client before checking its scope. */
  loadClientEntrypoint(): Promise<void> | undefined {
    const scope = this.#clientScope;
    if (
      scope === undefined ||
      openAIEntrypoints.some((entry) => entry.prototype === scope.prototype)
    )
      return;
    return (alternateEntrypoint ??= loadOpenAIEntrypoint().then(
      ({ default: OpenAIESM }) => {
        openAIEntrypoints.push(OpenAIESM);
      },
      () => {},
    ));
  }

  /** @internal Borrowed-client matching against the captured native response store. */
  matchesProvider(
    apiKey: string | undefined,
    config: Readonly<Record<string, unknown>> | undefined,
  ): boolean {
    const scope = this.#clientScope;
    if (scope === undefined) return false;
    const sdk = openAIEntrypoints.find(
      (entry) => entry.prototype === scope.prototype,
    );
    if (
      sdk === undefined ||
      scope.responsesPrototype !== sdk.Responses.prototype ||
      scope.compact !== sdk.Responses.prototype.compact
    )
      return false;
    const current = responsesClientScope(this.#client);
    if (
      current?.prototype !== scope.prototype ||
      current.responses !== scope.responses ||
      current.responsesPrototype !== scope.responsesPrototype ||
      current.compact !== scope.compact ||
      !isDeepStrictEqual(current.account, scope.account)
    )
      throw new TypeError(
        'Compaction client provider scope changed after capture',
      );
    const provider =
      config?.['model_providers.' + String(config.model_provider)];
    if (!provider || typeof provider !== 'object' || Array.isArray(provider))
      return false;
    const value = provider as Record<string, unknown>;
    if (value.query_params && Object.keys(value.query_params).length)
      return false;
    const headers = Object.fromEntries(
      Object.entries(value.http_headers ?? {}).map(([name, value]) => [
        name.toLowerCase(),
        value,
      ]),
    );
    if (
      Object.keys(headers).some(
        (name) => !['openai-organization', 'openai-project'].includes(name),
      )
    )
      return false;
    return isDeepStrictEqual(scope.account, [
      String(value.base_url ?? '').replace(/\/+$/, ''),
      apiKey,
      headers['openai-organization'] ?? null,
      headers['openai-project'] ?? null,
    ]);
  }

  /** @internal Resolve the captured native request before predicate/client effects. */
  prepareContext(
    context: CompactionContext<Context>,
    indexes: readonly number[],
    providerResponse: { response_id: string; model?: string } | undefined,
    modelOmitted: boolean,
  ): ResponsesCompactionContext<Context> {
    if (this.mode === 'previous_response_id' && providerResponse === undefined)
      throw new TypeError(
        'Compaction requires an acknowledged current provider window',
      );
    const model =
      this.model ??
      providerResponse?.model ??
      (modelOmitted ? undefined : context.model);
    if (typeof model !== 'string' || !model.trim())
      throw new TypeError(
        'Compaction needs an explicit model when the provider model is unknown',
      );
    const candidates = indexes.map((index) => {
      const item = context.items[index];
      if (item === undefined)
        throw new TypeError('Invalid native compaction candidate index');
      return item;
    });
    return Object.freeze({
      ...context,
      model,
      candidates: Object.freeze(candidates),
      mode:
        this.mode !== 'input' && providerResponse !== undefined
          ? 'previous_response_id'
          : 'input',
    });
  }

  /** @internal Capture one completed call through the existing borrowed client. */
  async requestWindow(
    context: ResponsesCompactionContext<Context>,
    providerResponse: { response_id: string; model?: string } | undefined,
    observe: (usage: TokenUsage | null) => void,
    canonicalItems?: CompactionContext<Context>['items'],
    onDispatch?: () => void,
  ): Promise<{ items: unknown[]; response_id?: string; model: string }> {
    const model = context.model;
    const body: Parameters<OpenAI['responses']['compact']>[0] = { model };
    if (context.mode === 'previous_response_id') {
      if (providerResponse === undefined)
        throw new TypeError(
          'Compaction requires an acknowledged current provider window',
        );
      body.previous_response_id = providerResponse.response_id;
    } else body.input = JSON.parse(JSON.stringify(context.items));
    const aliases =
      context.mode === 'input' && canonicalItems !== undefined
        ? controlAliases(canonicalItems, body.input as unknown[])
        : undefined;
    onDispatch?.();
    const response = await this.#compact(body, { signal: context.signal });
    let reported = false;
    try {
      const value = losslessJsonObjectSchema.parse(response);
      const usage = compactUsage(value.usage);
      reported = true;
      observe(usage);
      if (!Array.isArray(value.output))
        throw new TypeError('Compaction must return a complete output window');
      const responseId = value.id;
      if (
        responseId !== undefined &&
        (typeof responseId !== 'string' || !responseId.trim())
      )
        throw new TypeError('Compaction response ID must be a nonempty string');
      return {
        items:
          aliases === undefined
            ? value.output
            : canonicalControls(value.output, aliases),
        ...(responseId !== undefined ? { response_id: responseId } : {}),
        model,
      };
    } finally {
      if (!reported) observe(null);
    }
  }
}

/** Use a borrowed Responses client while native Core retains compaction ownership. */
export function responsesCompaction<Context = unknown>(
  options: ResponsesCompactionOptions<Context>,
): ResponsesCompaction<Context> {
  return new ResponsesCompaction(options);
}

interface ClientScope {
  readonly prototype: object;
  readonly responses: OpenAI['responses'];
  readonly responsesPrototype: object;
  readonly compact: OpenAI['responses']['compact'];
  readonly account: readonly [string, string, string | null, string | null];
}

const openAIEntrypoints: {
  readonly prototype: object;
  readonly Responses: { readonly prototype: { readonly compact: unknown } };
}[] = [OpenAI, OpenAICommonJS];
let alternateEntrypoint: Promise<void> | undefined;

function responsesClientScope(client: OpenAI): ClientScope | undefined {
  try {
    const prototype: object = Object.getPrototypeOf(client);
    const responses = client.responses;
    // Capture the original identities before loading any alternate entrypoint.
    if (
      Object.getOwnPropertyNames(prototype).some((name) =>
        Object.hasOwn(client, name),
      ) ||
      Reflect.get(responses, '_client') !== client
    )
      return;
    const options = Reflect.get(client, '_options') as Record<string, unknown>;
    if (
      Reflect.get(client, 'fetch') !== globalThis.fetch ||
      client.fetchOptions !== undefined ||
      options.defaultHeaders != null ||
      options.defaultQuery != null ||
      options.workloadIdentity != null ||
      typeof options.apiKey !== 'string' ||
      typeof client.apiKey !== 'string' ||
      !client.apiKey
    )
      return;
    return {
      prototype,
      responses,
      responsesPrototype: Object.getPrototypeOf(responses),
      compact: responses.compact,
      account: [
        client.baseURL.replace(/\/+$/, ''),
        client.apiKey,
        client.organization ?? null,
        client.project ?? null,
      ],
    };
  } catch {
    return undefined;
  }
}

function compactUsage(value: unknown): TokenUsage | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const input = raw.input_tokens_details;
  const output = raw.output_tokens_details;
  if (
    (input != null && (typeof input !== 'object' || Array.isArray(input))) ||
    (output != null && (typeof output !== 'object' || Array.isArray(output)))
  )
    return null;
  const counts = {
    inputTokens: raw.input_tokens,
    cachedInputTokens:
      (input as Record<string, unknown> | null)?.cached_tokens ?? 0,
    cacheWriteInputTokens: 0,
    outputTokens: raw.output_tokens,
    reasoningOutputTokens:
      (output as Record<string, unknown> | null)?.reasoning_tokens ?? 0,
    totalTokens: raw.total_tokens,
  };
  if (
    !Object.values(counts).every(
      (count) =>
        typeof count === 'number' && Number.isSafeInteger(count) && count >= 0,
    )
  )
    return null;
  return counts as TokenUsage;
}

function instruction(item: unknown): item is Record<string, unknown> {
  return (
    typeof item === 'object' &&
    item !== null &&
    !Array.isArray(item) &&
    (item as Record<string, unknown>).type === 'message' &&
    ['system', 'developer'].includes(
      String((item as Record<string, unknown>).role),
    )
  );
}

function controlAliases(
  canonical: readonly unknown[],
  outbound: readonly unknown[],
) {
  const originals = canonical.filter(instruction);
  const controls = outbound.filter(instruction);
  const identity = (items: Record<string, unknown>[]) =>
    items.map((item) => [item.role, item.id ?? null]);
  if (!isDeepStrictEqual(identity(originals), identity(controls)))
    return undefined;
  return controls.map((item, index) => ({
    outbound: JSON.parse(JSON.stringify(item)) as unknown,
    canonical: JSON.parse(JSON.stringify(originals[index])) as unknown,
  }));
}

function canonicalControls(
  output: unknown[],
  aliases: NonNullable<ReturnType<typeof controlAliases>>,
): unknown[] {
  let cursor = 0;
  return output.map((item) => {
    if (!instruction(item)) return item;
    for (let index = cursor; index < aliases.length; index++) {
      const alias = aliases[index]!;
      if (isDeepStrictEqual(item, alias.outbound)) {
        cursor = index + 1;
        return alias.canonical;
      }
    }
    // Native Core remains the authority for unmatched or duplicated controls.
    return item;
  });
}
