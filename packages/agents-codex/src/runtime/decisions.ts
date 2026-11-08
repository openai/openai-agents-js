import { z } from 'zod';
import {
  copyJsonValue,
  losslessJsonObjectSchema,
  type JsonObject,
} from './binding';
import { prepareOutput } from './output';
import { parseTokenCount, type TokenUsage } from './run-events';

/** Explicit model input; decision helpers never capture conversation history. */
export type DecisionInput = string | readonly JsonObject[];

export type DecisionChoice = string | number | boolean | null;

export interface DecisionRequest {
  readonly question: string;
  readonly input: DecisionInput;
  /** The complete native output schema, including any primitive wrapper. */
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
export interface DecisionOptions extends CallOptions {
  provider: DecisionProvider;
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

/** One typed decision, with an explicit provider and input. */
export function decide(
  question: string,
  options: PredicateOptions<DecisionOptions>,
): Promise<boolean>;
export function decide<Choice extends DecisionChoice>(
  question: string,
  options: ChoiceOptions<DecisionOptions, Choice>,
): Promise<Choice>;
export function decide<Output>(
  question: string,
  options: OutputOptions<DecisionOptions, Output>,
): Promise<Output>;
export async function decide(
  question: string,
  options: InternalOptions,
): Promise<unknown> {
  return performDecision(captureDecision(question, options));
}

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
  admit?(): void;
  /** Register and join even work the application starts without awaiting it. */
  own<T>(work: () => Promise<T>): Promise<T>;
  /** Record completed metadata before local validation, including after cancellation. */
  record(metadata: DecisionMetadata): Promise<void>;
  capture?(): Promise<(metadata: DecisionMetadata) => Promise<void>>;
}

/** @internal Bind only the capability and exact callback lifetime, never history. */
export function bindDecide(owner: DecisionOwner): BoundDecide {
  return ((question: string, options: InternalOptions) => {
    try {
      (owner.admit ?? owner.assertActive)();
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
      const result = owner.own(() => performDecision(captured, owner));
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
  const output = prepareOutput({ mode: 'native', schema });
  const input =
    typeof options.input === 'string'
      ? options.input
      : options.input.map((message) => losslessJsonObjectSchema.parse(message));
  const request: DecisionRequest = Object.freeze({
    question,
    input,
    outputSchema: output.schema!,
  });
  return {
    request,
    output,
    invoke: provider.getDecision.bind(provider),
    signal: options.signal,
  };
}

async function performDecision(
  { request, output, invoke, signal }: ReturnType<typeof captureDecision>,
  owner?: DecisionOwner,
): Promise<unknown> {
  signal?.throwIfAborted();
  owner?.assertActive();
  const record = owner?.capture ? await owner.capture() : owner?.record;
  signal?.throwIfAborted();
  owner?.assertActive();
  let response: DecisionResponse;
  try {
    response = await invoke(request, { signal });
  } catch (error) {
    if (error instanceof DecisionError) {
      try {
        await record?.(captureDecisionMetadata(error));
      } catch (accountingError) {
        throw new AggregateError(
          [error, accountingError],
          'Decision and accounting both failed',
          { cause: error },
        );
      }
    }
    throw error;
  }
  const metadata = captureDecisionMetadata(response ?? {});
  await record?.(metadata);
  signal?.throwIfAborted();
  owner?.assertActive();
  let text: string;
  try {
    text = JSON.stringify(copyJsonValue(response?.value));
  } catch {
    throw new DecisionError('invalid_response', metadata);
  }
  return output.parse!(text);
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
