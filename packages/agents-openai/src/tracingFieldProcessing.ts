import type { GenerationSpanData } from '@openai/agents-core';

type GenerationUsageData = NonNullable<GenerationSpanData['usage']>;
type JsonCompatibleValue =
  | null
  | string
  | number
  | boolean
  | JsonCompatibleValue[]
  | { [key: string]: JsonCompatibleValue };

const OPENAI_TRACING_MAX_FIELD_BYTES = 100_000;
// Limit repeated sizing work independently of the retained field size.
const OPENAI_TRACING_MAX_TRUNCATION_WORK_BYTES = 8_000_000;
type TruncationWork = { remainingBytes: number };
const TRUNCATION_WORK_EXHAUSTED = Symbol('truncationWorkExhausted');
const OPENAI_TRACING_MAX_RECURSION_DEPTH = 1_000;
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

function isFiniteJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function valueJsonSizeBytes(value: unknown, work?: TruncationWork): number {
  // Check before starting another traversal. The final traversal can exceed the
  // budget by one value's size, keeping total work linear in input plus budget.
  if (work && work.remainingBytes <= 0) {
    throw TRUNCATION_WORK_EXHAUSTED;
  }
  let size: number;
  try {
    const serialized = JSON.stringify(value);
    size =
      serialized === undefined
        ? 0
        : typeof serialized === 'string'
          ? textEncoder.encode(serialized).length
          : OPENAI_TRACING_MAX_FIELD_BYTES + 1;
  } catch {
    size = OPENAI_TRACING_MAX_FIELD_BYTES + 1;
  }
  if (work) {
    work.remainingBytes -= Math.max(1, size);
    if (work.remainingBytes < 0) {
      throw TRUNCATION_WORK_EXHAUSTED;
    }
  }
  return size;
}

function truncateStringForJsonLimit(
  value: string,
  maxBytes: number,
  work?: TruncationWork,
): string {
  const valueSize = valueJsonSizeBytes(value, work);
  if (valueSize <= maxBytes) {
    return value;
  }

  const suffixSize = valueJsonSizeBytes(
    OPENAI_TRACING_STRING_TRUNCATION_SUFFIX,
    work,
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
  let bestSize = valueJsonSizeBytes(best, work);
  while (bestSize > maxBytes && estimatedChars > 0) {
    const overflowRatio = (bestSize - maxBytes) / Math.max(bestSize, 1);
    const trimChars = Math.max(
      1,
      Math.floor(estimatedChars * overflowRatio) + 1,
    );
    estimatedChars = Math.max(0, estimatedChars - trimChars);
    best =
      value.slice(0, estimatedChars) + OPENAI_TRACING_STRING_TRUNCATION_SUFFIX;
    bestSize = valueJsonSizeBytes(best, work);
  }

  return best;
}

function sanitizeJsonCompatibleValue(
  value: unknown,
  seen: Set<object> = new Set(),
  depth: number = 0,
): JsonCompatibleValue | typeof UNSERIALIZABLE {
  if (depth >= OPENAI_TRACING_MAX_RECURSION_DEPTH) {
    return UNSERIALIZABLE;
  }

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
      return sanitizeJsonCompatibleValue(value.toJSON(), seen, depth + 1);
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
        const sanitizedNested = sanitizeJsonCompatibleValue(
          nestedValue,
          seen,
          depth + 1,
        );
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
        const sanitizedNested = sanitizeJsonCompatibleValue(
          nestedValue,
          seen,
          depth + 1,
        );
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

  let previewObject: Record<string, JsonCompatibleValue> = {
    truncated: true,
    original_type: typeName,
    preview,
  };

  if (valueJsonSizeBytes(previewObject) <= OPENAI_TRACING_MAX_FIELD_BYTES) {
    return previewObject;
  }

  const previewBudget = Math.max(
    0,
    OPENAI_TRACING_MAX_FIELD_BYTES -
      valueJsonSizeBytes({
        truncated: true,
        original_type: typeName,
        preview: '',
      }),
  );
  previewObject = {
    truncated: true,
    original_type: typeName,
    preview: truncateStringForJsonLimit(preview, previewBudget),
  };

  if (valueJsonSizeBytes(previewObject) <= OPENAI_TRACING_MAX_FIELD_BYTES) {
    return previewObject;
  }

  const typeBudget = Math.max(
    0,
    OPENAI_TRACING_MAX_FIELD_BYTES -
      valueJsonSizeBytes({
        truncated: true,
        original_type: '',
        preview: previewObject.preview,
      }),
  );
  previewObject = {
    truncated: true,
    original_type: truncateStringForJsonLimit(typeName, typeBudget),
    preview: previewObject.preview,
  };

  if (valueJsonSizeBytes(previewObject) <= OPENAI_TRACING_MAX_FIELD_BYTES) {
    return previewObject;
  }

  const finalPreviewBudget = Math.max(
    0,
    OPENAI_TRACING_MAX_FIELD_BYTES -
      valueJsonSizeBytes({
        truncated: true,
        original_type: previewObject.original_type,
        preview: '',
      }),
  );
  return {
    truncated: true,
    original_type: previewObject.original_type,
    preview: truncateStringForJsonLimit(
      previewObject.preview as string,
      finalPreviewBudget,
    ),
  };
}

function truncateJsonValueForLimit(
  value: JsonCompatibleValue,
  maxBytes: number,
  depth: number = 0,
  work: TruncationWork = {
    remainingBytes: OPENAI_TRACING_MAX_TRUNCATION_WORK_BYTES,
  },
): JsonCompatibleValue {
  if (depth >= OPENAI_TRACING_MAX_RECURSION_DEPTH) {
    return truncatedPreview(value);
  }

  if (valueJsonSizeBytes(value, work) <= maxBytes) {
    return value;
  }

  if (typeof value === 'string') {
    return truncateStringForJsonLimit(value, maxBytes, work);
  }

  if (Array.isArray(value)) {
    return truncateListForJsonLimit(value, maxBytes, depth + 1, work);
  }

  if (isPlainObject(value)) {
    return truncateMappingForJsonLimit(value, maxBytes, depth + 1, work);
  }

  return truncatedPreview(value);
}

function truncateMappingForJsonLimit(
  value: Record<string, JsonCompatibleValue>,
  maxBytes: number,
  depth: number = 0,
  work: TruncationWork = {
    remainingBytes: OPENAI_TRACING_MAX_TRUNCATION_WORK_BYTES,
  },
): Record<string, JsonCompatibleValue> {
  const truncated = { ...value };
  let currentSize = valueJsonSizeBytes(truncated, work);

  while (Object.keys(truncated).length > 0 && currentSize > maxBytes) {
    let largestKey: string | undefined;
    let largestChildSize = -1;

    for (const [key, child] of Object.entries(truncated)) {
      const childSize = valueJsonSizeBytes(child, work);
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
      currentSize = valueJsonSizeBytes(truncated, work);
      continue;
    }

    const truncatedChild = truncateJsonValueForLimit(
      child,
      childBudget,
      depth + 1,
      work,
    );
    const truncatedChildSize = valueJsonSizeBytes(truncatedChild, work);

    if (truncatedChild === child || truncatedChildSize >= largestChildSize) {
      delete truncated[largestKey];
    } else {
      truncated[largestKey] = truncatedChild;
    }

    currentSize = valueJsonSizeBytes(truncated, work);
  }

  return truncated;
}

function truncateListForJsonLimit(
  value: JsonCompatibleValue[],
  maxBytes: number,
  depth: number = 0,
  work: TruncationWork = {
    remainingBytes: OPENAI_TRACING_MAX_TRUNCATION_WORK_BYTES,
  },
): JsonCompatibleValue[] {
  const truncated = [...value];
  let currentSize = valueJsonSizeBytes(truncated, work);

  while (truncated.length > 0 && currentSize > maxBytes) {
    let largestIndex = 0;
    let largestChildSize = -1;

    for (let index = 0; index < truncated.length; index += 1) {
      const childSize = valueJsonSizeBytes(truncated[index], work);
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
      currentSize = valueJsonSizeBytes(truncated, work);
      continue;
    }

    const truncatedChild = truncateJsonValueForLimit(
      child,
      childBudget,
      depth + 1,
      work,
    );
    const truncatedChildSize = valueJsonSizeBytes(truncatedChild, work);

    if (truncatedChild === child || truncatedChildSize >= largestChildSize) {
      truncated.splice(largestIndex, 1);
    } else {
      truncated[largestIndex] = truncatedChild;
    }

    currentSize = valueJsonSizeBytes(truncated, work);
  }

  return truncated;
}

function exceedsNestingDepthLimit(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new Set<object>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) {
      break;
    }

    if (current.depth >= maxDepth) {
      return true;
    }

    if (!current.value || typeof current.value !== 'object') {
      continue;
    }

    if (seen.has(current.value)) {
      continue;
    }
    seen.add(current.value);

    try {
      if (hasToJSON(current.value)) {
        stack.push({
          value: current.value.toJSON(),
          depth: current.depth + 1,
        });
        continue;
      }

      const nestedValues = Array.isArray(current.value)
        ? current.value
        : Object.values(current.value);
      for (const nestedValue of nestedValues) {
        stack.push({
          value: nestedValue,
          depth: current.depth + 1,
        });
      }
    } catch {
      return true;
    }
  }

  return false;
}

/** Limit one export field without mutating the original span value. */
export function truncateSpanFieldValue(value: unknown): unknown {
  if (valueJsonSizeBytes(value) <= OPENAI_TRACING_MAX_FIELD_BYTES) {
    return value;
  }

  if (exceedsNestingDepthLimit(value, OPENAI_TRACING_MAX_RECURSION_DEPTH)) {
    return truncatedPreview(value);
  }

  try {
    const sanitizedValue = sanitizeJsonCompatibleValue(value);
    if (sanitizedValue === UNSERIALIZABLE) {
      return truncatedPreview(value);
    }

    return truncateJsonValueForLimit(
      sanitizedValue,
      OPENAI_TRACING_MAX_FIELD_BYTES,
    );
  } catch {
    // Excessive truncation work, deep nesting, or otherwise hostile values
    // should degrade to a preview
    // instead of failing the whole export batch.
    return truncatedPreview(value);
  }
}

export const _tracingFieldProcessingTestUtils = {
  valueJsonSizeBytes,
  truncateJsonValueForLimit,
  truncateMappingForJsonLimit,
  truncateListForJsonLimit,
};

/** Normalize usage details with the same JSON sanitization as trace fields. */
export function sanitizeGenerationUsageForTracesIngest(
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
