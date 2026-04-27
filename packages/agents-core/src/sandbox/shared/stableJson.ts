type StableJsonFunction = {
  readonly name?: string;
};

export type StableJsonValueOptions = {
  encodeBytes?: (value: Uint8Array) => unknown;
  encodeFunction?: (value: StableJsonFunction) => unknown;
  encodeNonPlainObject?: (value: object) => unknown;
};

export function stableJsonStringify(
  value: unknown,
  options: StableJsonValueOptions = {},
): string {
  return JSON.stringify(stableJsonValue(value, options));
}

export function stableJsonPrettyStringify(
  value: unknown,
  options: StableJsonValueOptions = {},
): string {
  return JSON.stringify(stableJsonValue(value, options), null, 2).replace(
    /": /g,
    '":',
  );
}

export function stableJsonValue(
  value: unknown,
  options: StableJsonValueOptions = {},
): unknown {
  if (value instanceof Uint8Array) {
    return options.encodeBytes
      ? options.encodeBytes(value)
      : { type: 'Uint8Array', data: Array.from(value) };
  }
  if (Array.isArray(value)) {
    return value.map((entry) => stableJsonValue(entry, options));
  }
  if (typeof value === 'function') {
    return options.encodeFunction
      ? options.encodeFunction(value as StableJsonFunction)
      : value;
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  if (options.encodeNonPlainObject && !isPlainRecord(value)) {
    return options.encodeNonPlainObject(value);
  }
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableJsonValue(entry, options)]),
  );
}

function isPlainRecord(value: object): boolean {
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
