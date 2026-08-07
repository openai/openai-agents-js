const INVALID_JSON_VALUE = Symbol('invalidJsonValue');

type JsonClone =
  null | boolean | number | string | JsonClone[] | { [key: string]: JsonClone };

/**
 * Creates a detached JSON-compatible snapshot of a provider usage object.
 */
export function snapshotRawUsage(
  rawUsage: unknown,
): Record<string, unknown> | undefined {
  if (
    typeof rawUsage !== 'object' ||
    rawUsage === null ||
    Array.isArray(rawUsage)
  ) {
    return undefined;
  }

  try {
    const snapshot = cloneJsonValue(rawUsage, new Set<object>());
    return snapshot === INVALID_JSON_VALUE ||
      snapshot === null ||
      typeof snapshot !== 'object' ||
      Array.isArray(snapshot)
      ? undefined
      : snapshot;
  } catch {
    return undefined;
  }
}

function cloneJsonValue(
  value: unknown,
  ancestors: Set<object>,
): JsonClone | typeof INVALID_JSON_VALUE {
  if (value === null) {
    return null;
  }
  if (
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  ) {
    return value;
  }
  if (typeof value === 'undefined') {
    return INVALID_JSON_VALUE;
  }
  if (typeof value !== 'object' || ancestors.has(value)) {
    return INVALID_JSON_VALUE;
  }

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const result: JsonClone[] = [];
      for (const entry of value) {
        const cloned = cloneJsonValue(entry, ancestors);
        if (cloned === INVALID_JSON_VALUE) {
          return INVALID_JSON_VALUE;
        }
        result.push(cloned);
      }
      return result;
    }

    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      return INVALID_JSON_VALUE;
    }

    const entries: Array<[string, JsonClone]> = [];
    for (const [key, entry] of Object.entries(value)) {
      if (typeof entry === 'undefined') {
        continue;
      }
      const cloned = cloneJsonValue(entry, ancestors);
      if (cloned === INVALID_JSON_VALUE) {
        return INVALID_JSON_VALUE;
      }
      entries.push([key, cloned]);
    }
    return Object.fromEntries(entries);
  } finally {
    ancestors.delete(value);
  }
}
