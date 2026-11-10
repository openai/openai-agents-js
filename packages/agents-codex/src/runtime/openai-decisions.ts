import OpenAI from 'openai';
import type { DecisionCreateParams } from 'openai/resources/decisions';
import { binding, type JsonObject } from './binding';
import { parseTokenCount, type TokenUsage } from './run-events';
import {
  DecisionError,
  captureDecisionMetadata,
  type DecisionProvider,
  type DecisionRequest,
  type DecisionResponse,
} from './decisions';

type CreateDecision = OpenAI['decisions']['create'];

/** OpenAI transport settings live on the ordinary OpenAI client. */
export interface OpenAIDecisionsOptions {
  // The public generated method shape accepts both module graphs and compatible
  // SDK versions without requiring the OpenAI class's private identity.
  client?: {
    decisions: {
      create(
        body: Parameters<CreateDecision>[0],
        options?: Pick<NonNullable<Parameters<CreateDecision>[1]>, 'signal'>,
      ): Pick<ReturnType<CreateDecision>, 'asResponse'>;
    };
  };
}

/** One explicit bounded Decisions request through the generated client. */
export class OpenAIDecisions implements DecisionProvider {
  private client: OpenAIDecisionsOptions['client'];

  constructor(options: OpenAIDecisionsOptions = {}) {
    this.client = options.client;
  }

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
      questions: DecisionCreateParams['questions'];
    };
    if (!compiled.supported)
      throw new TypeError('Unsupported Decisions output schema');
    if (compiled.questions.length === 0) {
      return {
        value: JSON.parse(
          native._decision_result(schema, request.question, '[]'),
        ),
        usage: zeroUsage,
      };
    }
    const client = (this.client ??= new OpenAI());
    const response = await client.decisions
      .create(
        {
          model: 'gpt-6-luna',
          input: request.input as DecisionCreateParams['input'],
          questions: compiled.questions,
        },
        { signal },
      )
      .asResponse();
    const requestId = response.headers.get('x-request-id') ?? undefined;
    let metadata = captureDecisionMetadata({ requestId });
    try {
      const raw: unknown = await response.json();
      signal?.throwIfAborted();
      if (raw === null || typeof raw !== 'object' || Array.isArray(raw))
        throw new DecisionError('invalid_response');
      const body = raw as JsonObject;
      metadata = captureDecisionMetadata({
        usage: providerUsage(body.usage),
        requestId,
        model: typeof body.model === 'string' ? body.model : undefined,
      });
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
      signal?.throwIfAborted();
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
