const unsupported = Symbol('use structuredClone');

/**
 * Capture each occurrence independently while the caller still owns its input.
 * Only the freshly cloned value is known to be private. Serializing a native
 * object on a later turn can invoke application code, so use the platform
 * clone for every subsequent read and for the first read of non-tree values.
 */
export function captureInputOccurrence<T>(input: T): () => T {
  const captured = structuredClone(input);
  let first = tryCopyTree(captured);
  return () => {
    if (first === unsupported) return structuredClone(captured);
    const result = first;
    first = unsupported;
    return result;
  };
}

function tryCopyTree<T>(input: T): T | typeof unsupported {
  const seen = new Set<object>();
  function copy(value: unknown, depth: number): unknown {
    if (typeof value === 'number') {
      return Number.isFinite(value) ? value : unsupported;
    }
    if (value === null || typeof value !== 'object') {
      return typeof value === 'function' || typeof value === 'symbol'
        ? unsupported
        : value;
    }
    if (depth > 64 || seen.has(value)) return unsupported;
    const array = Array.isArray(value);
    if (
      Object.getPrototypeOf(value) !==
      (array ? Array.prototype : Object.prototype)
    ) {
      return unsupported;
    }
    seen.add(value);
    const keys = Object.keys(value);
    if (array) {
      if (keys.length !== value.length) return unsupported;
      for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== String(i)) return unsupported;
      }
    }
    const output: Record<string, unknown> | unknown[] = array
      ? value.slice()
      : { ...value };
    for (let i = 0; i < keys.length; i++) {
      const key = keys[i];
      const child = copy((value as Record<string, unknown>)[key], depth + 1);
      if (child === unsupported) return unsupported;
      // Spread and slice create own data fields before these assignments,
      // preserving own __proto__ and bypassing inherited numeric setters.
      (output as Record<string, unknown>)[key] = child;
    }
    return output;
  }
  return copy(input, 0) as T | typeof unsupported;
}
