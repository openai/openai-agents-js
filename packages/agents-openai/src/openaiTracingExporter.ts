import {
  TracingExporter,
  BatchTraceProcessor,
  setTraceProcessors,
  type Span,
  type GenerationSpanData,
  type Trace,
} from '@openai/agents-core';
import { getTracingExportApiKey, HEADERS } from './defaults';
import logger from './logger';

/**
 * Options for OpenAITracingExporter.
 */
export type OpenAITracingExporterOptions = {
  apiKey?: string;
  organization: string;
  project: string;
  endpoint: string;
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
};

type GenerationUsageData = NonNullable<GenerationSpanData['usage']>;
type JsonCompatibleValue =
  | null
  | string
  | number
  | boolean
  | JsonCompatibleValue[]
  | { [key: string]: JsonCompatibleValue };

const OPENAI_TRACING_MAX_FIELD_BYTES = 100_000;
const OPENAI_TRACING_STRING_TRUNCATION_SUFFIX = '... [truncated]';
const UNSERIALIZABLE = Symbol('openaiTracingExporter.unserializable');
const textEncoder = new TextEncoder();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasToJSON(value: object): value is object & { toJSON: () => unknown } {
  try {
    return typeof (value as { toJSON?: unknown }).toJSON === 'function';
  } catch {
    return false;
  }
}

function isGenerationSpanData(
  spanData: Record<string, unknown>,
): spanData is GenerationSpanData {
  return spanData.type === 'generation';
}

function isGenerationUsageData(usage: unknown): usage is GenerationUsageData {
  return isRecord(usage);
}

function isFiniteJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function valueJsonSizeBytes(value: unknown): number {
  try {
    const serialized = JSON.stringify(value);
    if (typeof serialized !== 'string') {
      return OPENAI_TRACING_MAX_FIELD_BYTES + 1;
    }
    return textEncoder.encode(serialized).length;
  } catch {
    return OPENAI_TRACING_MAX_FIELD_BYTES + 1;
  }
}

function truncateStringForJsonLimit(value: string, maxBytes: number): string {
  const valueSize = valueJsonSizeBytes(value);
  if (valueSize <= maxBytes) {
    return value;
  }

  const suffixSize = valueJsonSizeBytes(
    OPENAI_TRACING_STRING_TRUNCATION_SUFFIX,
  );
  if (suffixSize > maxBytes) {
    return '';
  }
  if (suffixSize === maxBytes) {
    return OPENAI_TRACING_STRING_TRUNCATION_SUFFIX;
  }

  const budgetWithoutSuffix = maxBytes - suffixSize;
  let estimatedChars = Math.floor(
    (value.length * budgetWithoutSuffix) / Math.max(valueSize, 1),
  );
  estimatedChars = Math.max(0, Math.min(value.length, estimatedChars));

  let best =
    value.slice(0, estimatedChars) + OPENAI_TRACING_STRING_TRUNCATION_SUFFIX;
  let bestSize = valueJsonSizeBytes(best);
  while (bestSize > maxBytes && estimatedChars > 0) {
    const overflowRatio = (bestSize - maxBytes) / Math.max(bestSize, 1);
    const trimChars = Math.max(
      1,
      Math.floor(estimatedChars * overflowRatio) + 1,
    );
    estimatedChars = Math.max(0, estimatedChars - trimChars);
    best =
      value.slice(0, estimatedChars) + OPENAI_TRACING_STRING_TRUNCATION_SUFFIX;
    bestSize = valueJsonSizeBytes(best);
  }

  return best;
}

function sanitizeJsonCompatibleValue(
  value: unknown,
  seen: Set<object> = new Set(),
): JsonCompatibleValue | typeof UNSERIALIZABLE {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean'
  ) {
    return value;
  }

  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : UNSERIALIZABLE;
  }

  if (value && typeof value === 'object' && hasToJSON(value)) {
    if (seen.has(value)) {
      return UNSERIALIZABLE;
    }

    seen.add(value);
    try {
      return sanitizeJsonCompatibleValue(value.toJSON(), seen);
    } catch {
      return UNSERIALIZABLE;
    } finally {
      seen.delete(value);
    }
  }

  if (Array.isArray(value)) {
    if (seen.has(value)) {
      return UNSERIALIZABLE;
    }

    seen.add(value);
    const sanitized: JsonCompatibleValue[] = [];
    try {
      for (const nestedValue of value) {
        const sanitizedNested = sanitizeJsonCompatibleValue(nestedValue, seen);
        sanitized.push(
          sanitizedNested === UNSERIALIZABLE ? null : sanitizedNested,
        );
      }
    } finally {
      seen.delete(value);
    }

    return sanitized;
  }

  if (value && typeof value === 'object') {
    if (seen.has(value)) {
      return UNSERIALIZABLE;
    }

    seen.add(value);
    const sanitized: Record<string, JsonCompatibleValue> = {};
    try {
      for (const [key, nestedValue] of Object.entries(value)) {
        const sanitizedNested = sanitizeJsonCompatibleValue(nestedValue, seen);
        if (sanitizedNested !== UNSERIALIZABLE) {
          sanitized[key] = sanitizedNested;
        }
      }
    } catch {
      return UNSERIALIZABLE;
    } finally {
      seen.delete(value);
    }

    return sanitized;
  }

  return UNSERIALIZABLE;
}

function getValueTypeName(value: unknown): string {
  if (value === null) {
    return 'null';
  }

  if (typeof value !== 'object') {
    return typeof value;
  }

  try {
    return value.constructor?.name ?? 'Object';
  } catch {
    return 'Object';
  }
}

function truncatedPreview(value: unknown): Record<string, JsonCompatibleValue> {
  const typeName = getValueTypeName(value);
  let preview = `<${typeName} truncated>`;

  if (Array.isArray(value)) {
    preview = `<${typeName} len=${value.length} truncated>`;
  } else if (ArrayBuffer.isView(value)) {
    preview = `<${typeName} bytes=${value.byteLength} truncated>`;
  } else if (value instanceof ArrayBuffer) {
    preview = `<${typeName} bytes=${value.byteLength} truncated>`;
  } else if (value instanceof Map || value instanceof Set) {
    preview = `<${typeName} len=${value.size} truncated>`;
  } else if (isPlainObject(value)) {
    preview = `<${typeName} len=${Object.keys(value).length} truncated>`;
  }

  return {
    truncated: true,
    original_type: typeName,
    preview,
  };
}

function truncateJsonValueForLimit(
  value: JsonCompatibleValue,
  maxBytes: number,
): JsonCompatibleValue {
  if (valueJsonSizeBytes(value) <= maxBytes) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateStringForJsonLimit(value, maxBytes);
  }

  if (Array.isArray(value)) {
    return truncateListForJsonLimit(value, maxBytes);
  }

  if (isPlainObject(value)) {
    return truncateMappingForJsonLimit(value, maxBytes);
  }

  return truncatedPreview(value);
}

function truncateMappingForJsonLimit(
  value: Record<string, JsonCompatibleValue>,
  maxBytes: number,
): Record<string, JsonCompatibleValue> {
  const truncated = { ...value };
  let currentSize = valueJsonSizeBytes(truncated);

  while (Object.keys(truncated).length > 0 && currentSize > maxBytes) {
    let largestKey: string | undefined;
    let largestChildSize = -1;

    for (const [key, child] of Object.entries(truncated)) {
      const childSize = valueJsonSizeBytes(child);
      if (childSize > largestChildSize) {
        largestKey = key;
        largestChildSize = childSize;
      }
    }

    if (largestKey === undefined) {
      break;
    }

    const child = truncated[largestKey];
    const childBudget = Math.max(
      0,
      maxBytes - (currentSize - largestChildSize),
    );
    if (childBudget === 0) {
      delete truncated[largestKey];
      currentSize = valueJsonSizeBytes(truncated);
      continue;
    }

    const truncatedChild = truncateJsonValueForLimit(child, childBudget);
    const truncatedChildSize = valueJsonSizeBytes(truncatedChild);

    if (truncatedChild === child || truncatedChildSize >= largestChildSize) {
      delete truncated[largestKey];
    } else {
      truncated[largestKey] = truncatedChild;
    }

    currentSize = valueJsonSizeBytes(truncated);
  }

  return truncated;
}

function truncateListForJsonLimit(
  value: JsonCompatibleValue[],
  maxBytes: number,
): JsonCompatibleValue[] {
  const truncated = [...value];
  let currentSize = valueJsonSizeBytes(truncated);

  while (truncated.length > 0 && currentSize > maxBytes) {
    let largestIndex = 0;
    let largestChildSize = -1;

    for (let index = 0; index < truncated.length; index += 1) {
      const childSize = valueJsonSizeBytes(truncated[index]);
      if (childSize > largestChildSize) {
        largestIndex = index;
        largestChildSize = childSize;
      }
    }

    const child = truncated[largestIndex];
    const childBudget = Math.max(
      0,
      maxBytes - (currentSize - largestChildSize),
    );
    if (childBudget === 0) {
      truncated.splice(largestIndex, 1);
      currentSize = valueJsonSizeBytes(truncated);
      continue;
    }

    const truncatedChild = truncateJsonValueForLimit(child, childBudget);
    const truncatedChildSize = valueJsonSizeBytes(truncatedChild);

    if (truncatedChild === child || truncatedChildSize >= largestChildSize) {
      truncated.splice(largestIndex, 1);
    } else {
      truncated[largestIndex] = truncatedChild;
    }

    currentSize = valueJsonSizeBytes(truncated);
  }

  return truncated;
}

function truncateSpanFieldValue(value: unknown): unknown {
  if (valueJsonSizeBytes(value) <= OPENAI_TRACING_MAX_FIELD_BYTES) {
    return value;
  }

  const sanitizedValue = sanitizeJsonCompatibleValue(value);
  if (sanitizedValue === UNSERIALIZABLE) {
    return truncatedPreview(value);
  }

  return truncateJsonValueForLimit(
    sanitizedValue,
    OPENAI_TRACING_MAX_FIELD_BYTES,
  );
}

export const _openAITracingExporterTestUtils = {
  valueJsonSizeBytes,
  truncateJsonValueForLimit,
  truncateMappingForJsonLimit,
  truncateListForJsonLimit,
};

function sanitizeGenerationUsageForTracesIngest(
  usage: GenerationUsageData,
): GenerationUsageData | undefined {
  const inputTokens = usage.input_tokens;
  const outputTokens = usage.output_tokens;

  if (!isFiniteJsonNumber(inputTokens) || !isFiniteJsonNumber(outputTokens)) {
    return undefined;
  }

  const details: Record<string, JsonCompatibleValue> = {};
  if (isPlainObject(usage.details)) {
    for (const [key, value] of Object.entries(usage.details)) {
      const sanitizedValue = sanitizeJsonCompatibleValue(value);
      if (sanitizedValue !== UNSERIALIZABLE) {
        details[key] = sanitizedValue;
      }
    }
  }

  for (const [key, value] of Object.entries(usage)) {
    if (
      key === 'input_tokens' ||
      key === 'output_tokens' ||
      key === 'details' ||
      value === undefined
    ) {
      continue;
    }
    const sanitizedValue = sanitizeJsonCompatibleValue(value);
    if (sanitizedValue !== UNSERIALIZABLE) {
      details[key] = sanitizedValue;
    }
  }

  return {
    input_tokens: inputTokens,
    output_tokens: outputTokens,
    ...(Object.keys(details).length > 0 ? { details } : {}),
  };
}

/**
 * OpenAI traces ingest currently accepts only input/output token counts at the top-level
 * generation usage object. Keep those fields and move other usage data under `usage.details`
 * to avoid non-fatal 400 client errors.
 */
function sanitizeSpanDataForTracesIngest(
  spanData: Record<string, unknown>,
): Record<string, unknown> {
  let sanitizedSpanData = spanData;
  let didMutate = false;

  for (const fieldName of ['input', 'output']) {
    if (!(fieldName in spanData)) {
      continue;
    }

    const sanitizedField = truncateSpanFieldValue(spanData[fieldName]);
    if (sanitizedField === spanData[fieldName]) {
      continue;
    }

    if (!didMutate) {
      sanitizedSpanData = { ...spanData };
      didMutate = true;
    }
    sanitizedSpanData[fieldName] = sanitizedField;
  }

  if (
    !isGenerationSpanData(spanData) ||
    !isGenerationUsageData(spanData.usage)
  ) {
    return didMutate ? sanitizedSpanData : spanData;
  }

  const sanitizedUsage = sanitizeGenerationUsageForTracesIngest(spanData.usage);
  if (!sanitizedUsage) {
    if (!didMutate) {
      sanitizedSpanData = { ...spanData };
      didMutate = true;
    }

    delete sanitizedSpanData.usage;
    return sanitizedSpanData;
  }

  if (sanitizedUsage === spanData.usage) {
    return didMutate ? sanitizedSpanData : spanData;
  }

  if (!didMutate) {
    sanitizedSpanData = { ...spanData };
  }
  sanitizedSpanData.usage = sanitizedUsage;
  return sanitizedSpanData;
}

function sanitizePayloadItemForTracesIngest(
  payloadItem: Record<string, unknown>,
): Record<string, unknown> {
  if (payloadItem.object !== 'trace.span' || !isRecord(payloadItem.span_data)) {
    return payloadItem;
  }

  return {
    ...payloadItem,
    span_data: sanitizeSpanDataForTracesIngest(payloadItem.span_data),
  };
}

/**
 * A tracing exporter that exports traces to OpenAI's tracing API.
 */
export class OpenAITracingExporter implements TracingExporter {
  #options: OpenAITracingExporterOptions;

  constructor(options: Partial<OpenAITracingExporterOptions> = {}) {
    this.#options = {
      apiKey: options.apiKey ?? undefined,
      organization: options.organization ?? '',
      project: options.project ?? '',
      endpoint: options.endpoint ?? 'https://api.openai.com/v1/traces/ingest',
      maxRetries: options.maxRetries ?? 3,
      baseDelay: options.baseDelay ?? 1000,
      maxDelay: options.maxDelay ?? 30000,
    };
  }

  async export(
    items: (Trace | Span<any>)[],
    signal?: AbortSignal,
  ): Promise<void> {
    const defaultApiKey = this.#options.apiKey ?? getTracingExportApiKey();
    const itemsByKey = new Map<string | undefined, (Trace | Span<any>)[]>();

    for (const item of items) {
      const mapKey = (item as Trace & { tracingApiKey?: string }).tracingApiKey;
      const list = itemsByKey.get(mapKey) ?? [];
      list.push(item);
      itemsByKey.set(mapKey, list);
    }

    for (const [key, groupedItems] of itemsByKey.entries()) {
      // Item-level key wins; fall back to exporter config or environment.
      const apiKey = key ?? defaultApiKey;
      if (!apiKey) {
        logger.error(
          'No API key provided for OpenAI tracing exporter. Exports will be skipped',
        );
        continue;
      }

      const payloadItems = groupedItems
        .map((entry) => entry.toJSON())
        .filter((item) => !!item)
        .map((item) =>
          isRecord(item) ? sanitizePayloadItemForTracesIngest(item) : item,
        );
      const payload = { data: payloadItems };

      let attempts = 0;
      let delay = this.#options.baseDelay;

      while (attempts < this.#options.maxRetries) {
        try {
          const response = await fetch(this.#options.endpoint, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${apiKey}`,
              'OpenAI-Beta': 'traces=v1',
              ...HEADERS,
            },
            body: JSON.stringify(payload),
            signal,
          });

          if (response.ok) {
            logger.debug(`Exported ${payload.data.length} items`);
            break;
          }

          if (response.status >= 400 && response.status < 500) {
            logger.error(
              `[non-fatal] Tracing client error ${
                response.status
              }: ${await response.text()}`,
            );
            break;
          }

          logger.warn(
            `[non-fatal] Tracing: server error ${response.status}, retrying.`,
          );
        } catch (error: any) {
          logger.error('[non-fatal] Tracing: request failed: ', error);
        }

        if (signal?.aborted) {
          logger.error('Tracing: request aborted');
          break;
        }

        const sleepTime = delay + Math.random() * 0.1 * delay; // 10% jitter
        await new Promise((resolve) => setTimeout(resolve, sleepTime));
        delay = Math.min(delay * 2, this.#options.maxDelay);
        attempts++;
      }

      if (attempts >= this.#options.maxRetries) {
        logger.error(
          `Tracing: failed to export traces after ${
            this.#options.maxRetries
          } attempts`,
        );
      }
    }
  }
}

/**
 * Sets the OpenAI Tracing exporter as the default exporter with a BatchTraceProcessor handling the
 * traces
 */
export function setDefaultOpenAITracingExporter() {
  const exporter = new OpenAITracingExporter();
  const processor = new BatchTraceProcessor(exporter);
  setTraceProcessors([processor]);
}
