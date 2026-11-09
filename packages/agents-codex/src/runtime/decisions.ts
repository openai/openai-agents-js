import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import {
  registerSchema,
  unregisterSchema,
  validate as compileSchema,
} from '@hyperjump/json-schema/draft-2020-12';
import {
  copyJsonValue,
  losslessJsonObjectSchema,
  type JsonObject,
} from './binding';
import { OutputValidationError, prepareOutput } from './output';
import { getCurrentSpan, withSpan } from './tracing-context';
import {
  parseTokenCount,
  tokenCountToWire,
  type TokenUsage,
} from './run-events';

/** Explicit model input; decision helpers never capture conversation history. */
export type DecisionInput = string | readonly JsonObject[];

export type DecisionChoice = string | number | boolean | null;

export interface DecisionRequest {
  readonly question: string;
  readonly input: DecisionInput;
  /** The application value schema, without a transport-specific envelope. */
  readonly outputSchema: JsonObject;
}

export interface DecisionMetadata {
  readonly usage?: TokenUsage;
  readonly requestId?: string;
  readonly model?: string;
}

export interface DecisionResponse extends DecisionMetadata {
  /** JSON matching DecisionRequest.outputSchema, before application parsing. */
  readonly value: unknown;
}

/** A replaceable capability; custom providers need no base class or facade. */
export interface DecisionProvider {
  getDecision(
    request: DecisionRequest,
    options: { signal?: AbortSignal },
  ): Promise<DecisionResponse>;
}

/** A completed provider response refused or could not be interpreted safely. */
export class DecisionError extends Error implements DecisionMetadata {
  readonly usage?: TokenUsage;
  readonly requestId?: string;
  readonly model?: string;

  constructor(
    readonly reason: 'refusal' | 'invalid_response',
    metadata: DecisionMetadata = {},
  ) {
    super(
      reason === 'refusal' ? 'Decision refused' : 'Invalid decision response',
    );
    this.name = 'DecisionError';
    const captured = captureDecisionMetadata(metadata);
    this.usage = captured.usage;
    this.requestId = captured.requestId;
    this.model = captured.model;
  }
}

interface CallOptions {
  input: DecisionInput;
  signal?: AbortSignal;
}
export interface BoundDecisionOptions extends CallOptions {
  provider?: DecisionProvider;
}

type PredicateOptions<T> = T & { choices?: never; outputType?: never };
type ChoiceOptions<T, Choice extends DecisionChoice> = T & {
  choices: readonly Choice[];
  outputType?: never;
};
type OutputOptions<T, Output> = T & {
  outputType: z.ZodType<Output>;
  choices?: never;
};

/** A live callback helper, or a convenience bound to an Agent's defaults. */
export interface BoundDecide {
  (
    question: string,
    options: PredicateOptions<BoundDecisionOptions>,
  ): Promise<boolean>;
  <Choice extends DecisionChoice>(
    question: string,
    options: ChoiceOptions<BoundDecisionOptions, Choice>,
  ): Promise<Choice>;
  <Output>(
    question: string,
    options: OutputOptions<BoundDecisionOptions, Output>,
  ): Promise<Output>;
}

interface InternalOptions extends CallOptions {
  provider?: DecisionProvider;
  choices?: readonly DecisionChoice[];
  outputType?: z.ZodType;
}

/** @internal Capture trusted metadata without retaining provider response content. */
export function captureDecisionMetadata(
  metadata: DecisionMetadata,
): DecisionMetadata {
  let usage: TokenUsage | undefined;
  if (metadata.usage !== undefined) {
    try {
      const captured = Object.fromEntries(
        [
          'inputTokens',
          'cachedInputTokens',
          'cacheWriteInputTokens',
          'outputTokens',
          'reasoningOutputTokens',
          'totalTokens',
        ].map((key) => {
          const value = parseTokenCount(
            metadata.usage![key as keyof TokenUsage],
          );
          if (value < 0 || BigInt(value) > 9223372036854775807n)
            throw new Error('Invalid token count');
          return [key, value];
        }),
      ) as unknown as TokenUsage;
      if (
        BigInt(captured.cachedInputTokens) > BigInt(captured.inputTokens) ||
        BigInt(captured.cacheWriteInputTokens) > BigInt(captured.inputTokens) ||
        BigInt(captured.reasoningOutputTokens) >
          BigInt(captured.outputTokens) ||
        BigInt(captured.totalTokens) !==
          BigInt(captured.inputTokens) + BigInt(captured.outputTokens)
      )
        throw new Error('Inconsistent token counts');
      usage = Object.freeze(captured);
    } catch {
      // Missing or invalid usage remains unknown.
    }
  }
  return Object.freeze({
    ...(usage ? { usage } : {}),
    ...(typeof metadata.requestId === 'string' && metadata.requestId.trim()
      ? { requestId: metadata.requestId }
      : {}),
    ...(typeof metadata.model === 'string' && metadata.model.trim()
      ? { model: metadata.model }
      : {}),
  });
}

/** @internal Validate a captured provider before starting external work. */
export function captureDecisionProvider(
  provider: DecisionProvider | undefined,
): DecisionProvider | undefined {
  if (
    provider !== undefined &&
    (provider === null || typeof provider.getDecision !== 'function')
  )
    throw new TypeError('decisions must implement getDecision');
  return provider;
}

interface DecisionOwner {
  readonly provider?: DecisionProvider;
  readonly signal?: AbortSignal;
  assertActive(): void;
}

/** @internal Bind only the capability and exact callback lifetime, never history. */
export function bindDecide(owner: DecisionOwner): BoundDecide {
  return ((question: string, options: InternalOptions) => {
    try {
      owner.assertActive();
      const provider =
        options?.provider === undefined ? owner.provider : options.provider;
      const signal =
        owner.signal && options?.signal
          ? AbortSignal.any([owner.signal, options.signal])
          : (owner.signal ?? options?.signal);
      const captured = captureDecision(question, {
        ...options,
        provider,
        signal,
      });
      const result = performDecision(captured, owner);
      void result.catch(() => {});
      return result;
    } catch (error) {
      const result = Promise.reject(error);
      void result.catch(() => {});
      return result;
    }
  }) as BoundDecide;
}

function captureDecision(question: string, options: InternalOptions) {
  if (typeof question !== 'string' || !question.trim())
    throw new TypeError('Decision question must be a non-empty string');
  const provider = captureDecisionProvider(options?.provider);
  if (!provider) throw new TypeError('A decision provider is required');
  if (
    options.input === undefined ||
    (typeof options.input !== 'string' && !Array.isArray(options.input))
  )
    throw new TypeError(
      'Decision input must be an explicit string or message array',
    );
  if (options.choices !== undefined && options.outputType !== undefined)
    throw new TypeError('choices and outputType are mutually exclusive');
  let schema: z.ZodType = options.outputType ?? z.boolean();
  if (options.choices !== undefined) {
    if (
      !Array.isArray(options.choices) ||
      !options.choices.length ||
      options.choices.some(
        (value) =>
          !(
            value === null ||
            typeof value === 'string' ||
            typeof value === 'boolean' ||
            (typeof value === 'number' && Number.isFinite(value))
          ),
      ) ||
      new Set(options.choices.map((value) => JSON.stringify(value))).size !==
        options.choices.length
    )
      throw new TypeError(
        'choices must contain distinct finite JSON scalar values',
      );
    schema =
      options.choices.length === 1
        ? z.literal(options.choices[0])
        : z.union(options.choices.map((value) => z.literal(value)));
  }
  const output = prepareOutput(
    { mode: 'native', schema },
    { applicationValue: true },
  );
  const input =
    typeof options.input === 'string'
      ? options.input
      : options.input.map((message) => losslessJsonObjectSchema.parse(message));
  const request: DecisionRequest = Object.freeze({
    question,
    input,
    outputSchema: copyJsonValue(output.schema!) as JsonObject,
  });
  return {
    request,
    output,
    invoke: provider.getDecision.bind(provider),
    signal: options.signal,
  };
}

async function applicationValidator(schema: JsonObject) {
  const id = `urn:uuid:${randomUUID()}`;
  try {
    registerSchema(schema, id);
    const validate = await compileSchema(id);
    return (value: ReturnType<typeof copyJsonValue>) =>
      validate(value, 'FLAG').valid;
  } catch {
    throw new TypeError('Unsupported decision output schema');
  } finally {
    unregisterSchema(id);
  }
}

async function recordDecisionUsage(
  metadata: DecisionMetadata,
  outcome: 'completed' | 'refusal' | 'invalid_response',
): Promise<void> {
  const parent = getCurrentSpan();
  if (!parent || parent.context.disabled) return;
  const data: JsonObject = {
    usage_known: metadata.usage !== undefined,
    outcome,
  };
  const usage = metadata.usage;
  if (usage) {
    for (const [key, count] of Object.entries({
      input_tokens: usage.inputTokens,
      cached_input_tokens: usage.cachedInputTokens,
      cache_write_input_tokens: usage.cacheWriteInputTokens,
      output_tokens: usage.outputTokens,
      reasoning_output_tokens: usage.reasoningOutputTokens,
      total_tokens: usage.totalTokens,
    }))
      data[key] = tokenCountToWire(count);
  }
  for (const [key, value] of Object.entries({
    request_id: metadata.requestId,
    model: metadata.model,
  }))
    // eslint-disable-next-line no-control-regex -- Trace identities must exclude controls.
    if (value !== undefined && !/[\u0000-\u001f\u007f]/.test(value))
      data[key] = Array.from(value).slice(0, 256).join('');
  await withSpan({ name: 'decision.usage', metadata: data }, () => {});
}

async function performDecision(
  { request, output, invoke, signal }: ReturnType<typeof captureDecision>,
  owner: DecisionOwner,
): Promise<unknown> {
  const work = async () => {
    signal?.throwIfAborted();
    owner.assertActive();
    const validate = await applicationValidator(output.schema!);
    signal?.throwIfAborted();
    owner.assertActive();
    let response: DecisionResponse;
    try {
      response = await invoke(request, { signal });
    } catch (error) {
      if (error instanceof DecisionError) {
        try {
          await recordDecisionUsage(
            captureDecisionMetadata(error),
            error.reason === 'refusal' ? 'refusal' : 'invalid_response',
          );
        } catch (tracingError) {
          throw new AggregateError(
            [error, tracingError],
            'Decision and usage tracing both failed',
            { cause: error },
          );
        }
      }
      throw error;
    }
    const metadata = captureDecisionMetadata(response ?? {});
    await recordDecisionUsage(metadata, 'completed');
    signal?.throwIfAborted();
    owner.assertActive();
    let value: ReturnType<typeof copyJsonValue>;
    try {
      value = copyJsonValue(response?.value);
    } catch {
      throw new DecisionError('invalid_response', metadata);
    }
    const text = JSON.stringify(value);
    let valid = false;
    try {
      valid = validate(value);
    } catch {
      // Dependency diagnostics must not expose provider data.
    }
    if (!valid) throw new OutputValidationError(text);
    return output.parse!(text);
  };
  const parent = getCurrentSpan();
  return parent && !parent.context.disabled
    ? withSpan({ name: 'decision' }, work)
    : work();
}

/** @internal Keep tool deadline signals on helpers when callback contexts are copied. */
export const decisionBinding = Symbol('decisionBinding');
export function withDecisionSignal<
  T extends {
    signal: AbortSignal;
    decide?: BoundDecide;
    /** @internal */
    [decisionBinding]?: (signal: AbortSignal) => BoundDecide;
  },
>(context: T, signal: AbortSignal): T {
  return {
    ...context,
    signal,
    ...(context[decisionBinding]
      ? { decide: context[decisionBinding](signal) }
      : {}),
  };
}
