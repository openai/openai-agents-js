import type OpenAI from 'openai';
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
  /** Current native sessions have been supplying input windows. Auto has been
   * selecting input; previous-response mode has been requiring a native
   * acknowledged-window receipt before client effects. */
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
    Object.freeze(this);
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
        items: value.output,
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
