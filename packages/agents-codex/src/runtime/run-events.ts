import { z } from 'zod';
import type { JsonObject } from './binding';

/** Native counters preserve exact large integers when the bridge supplies decimal text. */
export type TokenCount = number | bigint;
export interface TokenUsage {
  readonly inputTokens: TokenCount;
  readonly cachedInputTokens: TokenCount;
  readonly cacheWriteInputTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly reasoningOutputTokens: TokenCount;
  readonly totalTokens: TokenCount;
}

/** Cumulative thread snapshot; last usage may describe only its latest response. */
export interface TokenUsageInfo {
  readonly totalTokenUsage: TokenUsage;
  readonly lastTokenUsage: TokenUsage;
  readonly modelContextWindow: TokenCount | null;
}

const normalizeCount = (value: bigint): TokenCount => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
};

const tokenCount = z.union([
  z
    .number()
    .int()
    .refine(Number.isSafeInteger, 'Expected an exact integer counter'),
  z.bigint().transform(normalizeCount),
  z
    .string()
    .regex(/^-?(?:0|[1-9]\d*)$/)
    .transform((value): TokenCount => normalizeCount(BigInt(value))),
]);
const tokenUsageSchema = z
  .object({
    input_tokens: tokenCount,
    cached_input_tokens: tokenCount,
    cache_write_input_tokens: tokenCount,
    output_tokens: tokenCount,
    reasoning_output_tokens: tokenCount,
    total_tokens: tokenCount,
  })
  .transform((value): TokenUsage =>
    Object.freeze({
      inputTokens: value.input_tokens,
      cachedInputTokens: value.cached_input_tokens,
      cacheWriteInputTokens: value.cache_write_input_tokens,
      outputTokens: value.output_tokens,
      reasoningOutputTokens: value.reasoning_output_tokens,
      totalTokens: value.total_tokens,
    }),
  );
const tokenUsageInfoSchema = z
  .object({
    total_token_usage: tokenUsageSchema,
    last_token_usage: tokenUsageSchema,
    model_context_window: tokenCount.nullable(),
  })
  .transform((value): TokenUsageInfo =>
    Object.freeze({
      totalTokenUsage: value.total_token_usage,
      lastTokenUsage: value.last_token_usage,
      modelContextWindow: value.model_context_window,
    }),
  );

export function tokenUsageInfo(value: unknown): TokenUsageInfo | null {
  return value == null ? null : tokenUsageInfoSchema.parse(value);
}

/** Parse exact decimal wire text or a public counter; unsafe numbers are unrecoverable. */
export function parseTokenCount(value: unknown): TokenCount {
  return tokenCount.parse(value);
}

export function addTokenCounts(
  left: TokenCount,
  right: TokenCount,
): TokenCount {
  return normalizeCount(
    BigInt(parseTokenCount(left)) + BigInt(parseTokenCount(right)),
  );
}

export type TokenCountWire = number | string;

/** Only typed usage fields use this codec; arbitrary JSON values stay untouched. */
export function tokenCountToWire(value: TokenCount): TokenCountWire {
  const count = parseTokenCount(value);
  return typeof count === 'bigint' ? count.toString() : count;
}

/** Provider-reported tokens accumulated for one root run. */
export interface RunUsage {
  readonly inputTokens: TokenCount;
  readonly cachedInputTokens: TokenCount;
  readonly cacheWriteInputTokens: TokenCount;
  readonly outputTokens: TokenCount;
  readonly reasoningOutputTokens: TokenCount;
  readonly totalTokens: TokenCount;
}

export function addRunUsage(prior: RunUsage | null, raw: JsonObject): RunUsage {
  const count = (name: string): TokenCount =>
    parseTokenCount(raw[name] === undefined ? 0 : raw[name]);
  return Object.freeze({
    inputTokens: addTokenCounts(prior?.inputTokens ?? 0, count('input_tokens')),
    cachedInputTokens: addTokenCounts(
      prior?.cachedInputTokens ?? 0,
      count('cached_input_tokens'),
    ),
    cacheWriteInputTokens: addTokenCounts(
      prior?.cacheWriteInputTokens ?? 0,
      count('cache_write_input_tokens'),
    ),
    outputTokens: addTokenCounts(
      prior?.outputTokens ?? 0,
      count('output_tokens'),
    ),
    reasoningOutputTokens: addTokenCounts(
      prior?.reasoningOutputTokens ?? 0,
      count('reasoning_output_tokens'),
    ),
    totalTokens: addTokenCounts(prior?.totalTokens ?? 0, count('total_tokens')),
  });
}

/** Existing manual receipts keep nonnegative JSON-safe counters, never bigint values. */
export const nonnegativeTokenCountWireSchema = z.union([
  z
    .number()
    .int()
    .nonnegative()
    .refine(Number.isSafeInteger, 'Expected an exact integer counter'),
  z.string().regex(/^(?:0|[1-9]\d*)$/),
]);

export function runUsageToWire(usage: RunUsage) {
  const counter = (value: TokenCount): TokenCountWire =>
    nonnegativeTokenCountWireSchema.parse(tokenCountToWire(value));
  return {
    inputTokens: counter(usage.inputTokens),
    cachedInputTokens: counter(usage.cachedInputTokens),
    cacheWriteInputTokens: counter(usage.cacheWriteInputTokens),
    outputTokens: counter(usage.outputTokens),
    reasoningOutputTokens: counter(usage.reasoningOutputTokens),
    totalTokens: counter(usage.totalTokens),
  };
}
