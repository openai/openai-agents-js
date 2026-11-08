import OpenAI from 'openai';
import { binding, type JsonObject } from './binding';
import { parseTokenCount, type TokenUsage } from './run-events';
import {
  decide,
  DecisionError,
  captureDecisionMetadata,
  type BoundDecide,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
} from './decisions';

/** OpenAI transport settings live on the ordinary OpenAI client. */
export interface OpenAIDecisionsOptions {
  client?: OpenAI;
  /** Used only when the requested schema cannot be expressed as bounded questions. */
  fallbackModel?: string;
}

/** One explicit Decisions request, or one preselected Responses schema fallback. */
export class OpenAIDecisions implements DecisionProvider {
  private client: OpenAI | undefined;
  readonly fallbackModel: string | undefined;

  constructor(options: OpenAIDecisionsOptions = {}) {
    if (
      options.fallbackModel !== undefined &&
      (typeof options.fallbackModel !== 'string' ||
        !options.fallbackModel.trim())
    )
      throw new TypeError('fallbackModel must be a non-empty string');
    this.client = options.client;
    this.fallbackModel = options.fallbackModel;
  }

  /** The same typed implementation as the standalone decide function. */
  readonly decide: BoundDecide = ((
    question: string,
    options: Parameters<BoundDecide>[1],
  ) =>
    decide(question, {
      ...options,
      provider: options.provider ?? this,
    } as Parameters<typeof decide>[1])) as BoundDecide;

  async getDecision(
    request: DecisionRequest,
    { signal }: { signal?: AbortSignal },
  ): Promise<DecisionResponse> {
    const native = await binding();
    signal?.throwIfAborted();
    const schema = JSON.stringify(request.outputSchema);
    const compiled = JSON.parse(
      native._decision_questions(schema, request.question),
    ) as {
      supported: boolean;
      questions: JsonObject[];
    };
    if (!compiled.supported && this.fallbackModel === undefined)
      throw new TypeError(
        'Unsupported Decisions output schema; configure fallbackModel explicitly',
      );
    if (compiled.supported && compiled.questions.length === 0) {
      return {
        value: JSON.parse(
          native._decision_result(schema, request.question, '[]'),
        ),
        usage: zeroUsage,
      };
    }
    const fallback = !compiled.supported;
    const client = (this.client ??= new OpenAI());
    const { data, response } = await client
      .post<JsonObject>(fallback ? '/responses' : '/decisions', {
        signal,
        body: fallback
          ? {
              model: this.fallbackModel,
              instructions: request.question,
              input: request.input,
              stream: false,
              store: false,
              text: {
                format: {
                  type: 'json_schema',
                  name: 'decision',
                  strict: true,
                  schema: request.outputSchema,
                },
              },
            }
          : {
              model: 'gpt-6-luna',
              input: request.input,
              questions: compiled.questions,
            },
      })
      .withResponse();
    const body =
      data !== null && typeof data === 'object' && !Array.isArray(data)
        ? data
        : {};
    const metadata = captureDecisionMetadata({
      usage: providerUsage(body.usage),
      requestId: response.headers.get('x-request-id') ?? undefined,
      model: typeof body.model === 'string' ? body.model : undefined,
    });
    try {
      if (fallback) return { value: responseValue(body), ...metadata };
      return {
        value: JSON.parse(
          native._decision_result(
            schema,
            request.question,
            JSON.stringify(body.answers ?? null),
          ),
        ),
        ...metadata,
      };
    } catch (error) {
      const refusal =
        error instanceof DecisionError
          ? error.reason === 'refusal'
          : error instanceof Error &&
            error.message === 'Decisions refused a question';
      throw new DecisionError(
        refusal ? 'refusal' : 'invalid_response',
        metadata,
      );
    }
  }
}

const zeroUsage: TokenUsage = Object.freeze({
  inputTokens: 0,
  cachedInputTokens: 0,
  cacheWriteInputTokens: 0,
  outputTokens: 0,
  reasoningOutputTokens: 0,
  totalTokens: 0,
});

function providerUsage(raw: unknown): TokenUsage | undefined {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return;
  const usage = raw as Record<string, unknown>;
  for (const details of [
    usage.input_tokens_details,
    usage.output_tokens_details,
  ])
    if (
      details !== undefined &&
      details !== null &&
      (typeof details !== 'object' || Array.isArray(details))
    )
      return;
  const input = usage.input_tokens_details as
    Record<string, unknown> | null | undefined;
  const output = usage.output_tokens_details as
    Record<string, unknown> | null | undefined;
  try {
    return captureDecisionMetadata({
      usage: {
        inputTokens: parseTokenCount(usage.input_tokens),
        cachedInputTokens: parseTokenCount(
          input?.cached_tokens === undefined ? 0 : input.cached_tokens,
        ),
        cacheWriteInputTokens: parseTokenCount(
          input?.cache_write_tokens === undefined
            ? 0
            : input.cache_write_tokens,
        ),
        outputTokens: parseTokenCount(usage.output_tokens),
        reasoningOutputTokens: parseTokenCount(
          output?.reasoning_tokens === undefined ? 0 : output.reasoning_tokens,
        ),
        totalTokens: parseTokenCount(usage.total_tokens),
      },
    }).usage;
  } catch {
    return;
  }
}

function responseValue(data: JsonObject): unknown {
  if (data.status !== 'completed' || !Array.isArray(data.output))
    throw new Error('Invalid response');
  let text = '';
  for (const item of data.output) {
    if (item === null || typeof item !== 'object' || Array.isArray(item))
      continue;
    if (item.type !== 'message' || !Array.isArray(item.content)) continue;
    for (const part of item.content) {
      if (part === null || typeof part !== 'object' || Array.isArray(part))
        continue;
      if (part.type === 'refusal') throw new DecisionError('refusal');
      if (part.type === 'output_text' && typeof part.text === 'string')
        text += part.text;
    }
  }
  return JSON.parse(text);
}
