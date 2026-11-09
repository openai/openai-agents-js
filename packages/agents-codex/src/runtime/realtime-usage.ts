/** Nonnegative provider-reported counters. Nested counters are subsets, not additions. */
export interface NativeRealtimeUsageCounters {
  readonly [name: string]: number | NativeRealtimeUsageCounters;
}
/**
 * Speech-model usage, separate from backend thread usage. Missing fields stay unknown.
 * Counts are nonnegative safe integers; invalid counts or cumulative overflow end
 * the owner with an error. Unknown vendor fields remain raw-only.
 */
export interface NativeRealtimeUsage {
  readonly input_tokens?: number;
  readonly output_tokens?: number;
  readonly total_tokens?: number;
  readonly input_token_details?: NativeRealtimeUsageCounters;
  readonly output_token_details?: NativeRealtimeUsageCounters;
}

/** @internal Add measured counters without filling absent values with invented zeros. */
export function addRealtimeUsage(
  total: NativeRealtimeUsageCounters,
  current: NativeRealtimeUsageCounters,
): NativeRealtimeUsageCounters {
  const result: Record<string, number | NativeRealtimeUsageCounters> =
    structuredClone(total);
  for (const [key, value] of Object.entries(current)) {
    const previous = result[key];
    if (typeof value === 'object') {
      result[key] = addRealtimeUsage(
        typeof previous === 'object' ? previous : {},
        value,
      );
    } else {
      const combined = (typeof previous === 'number' ? previous : 0) + value;
      if (!Number.isSafeInteger(combined))
        throw new RangeError(
          'Realtime cumulative usage exceeds safe integer range',
        );
      result[key] = combined;
    }
  }
  return result;
}

/** @internal Select the bounded provider counter schema; vendor fields stay raw-only. */
export function reportedRealtimeUsage(
  value: unknown,
): NativeRealtimeUsageCounters {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('Realtime usage must be a counter object');
  function counters(
    source: Record<string, unknown>,
    names: readonly string[],
  ): Record<string, number | NativeRealtimeUsageCounters> {
    const result: Record<string, number | NativeRealtimeUsageCounters> = {};
    for (const key of names) {
      const count = Object.hasOwn(source, key) ? source[key] : undefined;
      if (count === null || count === undefined) continue;
      if (
        typeof count !== 'number' ||
        !Number.isSafeInteger(count) ||
        count < 0
      )
        throw new TypeError(
          'Realtime usage counters must be nonnegative safe integers',
        );
      result[key] = count;
    }
    return result;
  }
  const source = value as Record<string, unknown>;
  const result = counters(source, [
    'input_tokens',
    'output_tokens',
    'total_tokens',
  ]);
  for (const field of ['input_token_details', 'output_token_details']) {
    const details = Object.hasOwn(source, field) ? source[field] : undefined;
    if (details === null || details === undefined) continue;
    if (typeof details !== 'object' || Array.isArray(details))
      throw new TypeError('Realtime usage details must be counter objects');
    const row = details as Record<string, unknown>;
    const selected = counters(row, [
      'text_tokens',
      'audio_tokens',
      'image_tokens',
      'cached_tokens',
    ]);
    const cached = Object.hasOwn(row, 'cached_tokens_details')
      ? row.cached_tokens_details
      : undefined;
    if (cached !== null && cached !== undefined) {
      if (typeof cached !== 'object' || Array.isArray(cached))
        throw new TypeError(
          'Realtime cached usage details must be a counter object',
        );
      selected.cached_tokens_details = counters(
        cached as Record<string, unknown>,
        ['text_tokens', 'audio_tokens', 'image_tokens'],
      );
    }
    result[field] = selected;
  }
  return result;
}
