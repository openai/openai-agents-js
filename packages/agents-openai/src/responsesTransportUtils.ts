import { UserError } from '@openai/agents-core';

export type ResponsesTransportOverrides = {
  extraHeaders?: Record<string, unknown>;
  extraQuery?: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
};

export type HeaderAccumulator = {
  blockedLowercaseNames: Set<string>;
  valuesByLowercaseName: Map<string, { key: string; value: string }>;
};

export type NullableHeadersLike = {
  values: Headers;
  nulls: Set<string>;
};

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isPlainTransportOverrideMapping(
  value: unknown,
): value is Record<string, unknown> {
  if (!isRecordLike(value) || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function normalizeTransportOverrideMapping(
  value: unknown,
  fieldName: string,
): Record<string, unknown> | undefined {
  if (typeof value === 'undefined') {
    return undefined;
  }

  if (!isPlainTransportOverrideMapping(value)) {
    throw new UserError(`Responses websocket ${fieldName} must be a mapping.`);
  }

  return { ...value };
}

export function splitResponsesTransportOverrides(providerData: unknown): {
  providerData: Record<string, any>;
  overrides: ResponsesTransportOverrides;
} {
  if (!isRecordLike(providerData) || Array.isArray(providerData)) {
    return {
      providerData: {},
      overrides: {},
    };
  }

  const {
    extra_headers,
    extraHeaders,
    extra_query,
    extraQuery,
    extra_body,
    extraBody,
    ...remainingProviderData
  } = providerData;

  return {
    providerData: { ...remainingProviderData },
    overrides: {
      extraHeaders: normalizeTransportOverrideMapping(
        typeof extra_headers !== 'undefined' ? extra_headers : extraHeaders,
        'extra headers',
      ),
      extraQuery: normalizeTransportOverrideMapping(
        typeof extra_query !== 'undefined' ? extra_query : extraQuery,
        'extra query',
      ),
      extraBody: normalizeTransportOverrideMapping(
        typeof extra_body !== 'undefined' ? extra_body : extraBody,
        'extra_body',
      ),
    },
  };
}

type ParsedHeaderInput = {
  entries: Array<[key: string, value: string]>;
  unsetLowercaseNames: string[];
};

function parseHeaderInput(headers: unknown): ParsedHeaderInput {
  const parsed: ParsedHeaderInput = {
    entries: [],
    unsetLowercaseNames: [],
  };

  if (!headers) {
    return parsed;
  }

  if (typeof Headers !== 'undefined' && headers instanceof Headers) {
    headers.forEach((value, key) => {
      parsed.entries.push([key, value]);
    });
    return parsed;
  }

  if (isRecordLike(headers) && typeof Headers !== 'undefined') {
    const values = (headers as { values?: unknown }).values;
    const nulls = (headers as { nulls?: unknown }).nulls;
    if (values instanceof Headers) {
      values.forEach((value, key) => {
        parsed.entries.push([key, value]);
      });
      if (nulls instanceof Set) {
        for (const maybeHeaderName of nulls) {
          if (typeof maybeHeaderName === 'string') {
            parsed.unsetLowercaseNames.push(maybeHeaderName.toLowerCase());
          }
        }
      }
      return parsed;
    }
  }

  if (Array.isArray(headers)) {
    for (const entry of headers) {
      if (!Array.isArray(entry) || entry.length < 2) {
        continue;
      }
      const [key, value] = entry;
      if (typeof key === 'undefined' || value == null) {
        continue;
      }
      parsed.entries.push([String(key), String(value)]);
    }
    return parsed;
  }

  if (!isRecordLike(headers)) {
    return parsed;
  }

  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === 'undefined') {
      continue;
    }
    if (value === null) {
      parsed.unsetLowercaseNames.push(key.toLowerCase());
      continue;
    }
    parsed.entries.push([key, String(value)]);
  }

  return parsed;
}

export function mergeHeadersIntoRecord(
  target: Record<string, string>,
  headers: unknown,
): void {
  const parsed = parseHeaderInput(headers);
  for (const lowercaseName of parsed.unsetLowercaseNames) {
    for (const existingKey of Object.keys(target)) {
      if (existingKey.toLowerCase() === lowercaseName) {
        delete target[existingKey];
      }
    }
  }
  for (const [key, value] of parsed.entries) {
    target[key] = value;
  }
}

export function createHeaderAccumulator(): HeaderAccumulator {
  return {
    blockedLowercaseNames: new Set<string>(),
    valuesByLowercaseName: new Map<string, { key: string; value: string }>(),
  };
}

export function applyHeadersToAccumulator(
  accumulator: HeaderAccumulator,
  headers: unknown,
  options?: { allowBlockedOverride?: boolean },
): void {
  const allowBlockedOverride = options?.allowBlockedOverride ?? false;
  const parsed = parseHeaderInput(headers);

  for (const lowercaseName of parsed.unsetLowercaseNames) {
    accumulator.valuesByLowercaseName.delete(lowercaseName);
    accumulator.blockedLowercaseNames.add(lowercaseName);
  }

  for (const [key, value] of parsed.entries) {
    const lowercaseKey = key.toLowerCase();
    if (
      accumulator.blockedLowercaseNames.has(lowercaseKey) &&
      !allowBlockedOverride
    ) {
      continue;
    }

    accumulator.valuesByLowercaseName.set(lowercaseKey, { key, value });
    if (allowBlockedOverride) {
      accumulator.blockedLowercaseNames.delete(lowercaseKey);
    }
  }
}

export function headerAccumulatorToRecord(
  accumulator: HeaderAccumulator,
): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const { key, value } of accumulator.valuesByLowercaseName.values()) {
    headers[key] = value;
  }
  return headers;
}

export function headerAccumulatorToSDKHeaders(
  accumulator: HeaderAccumulator,
): Record<string, string | null> {
  const headers: Record<string, string | null> =
    headerAccumulatorToRecord(accumulator);
  for (const lowercaseName of accumulator.blockedLowercaseNames) {
    headers[lowercaseName] = null;
  }
  return headers;
}

function appendQueryParamValue(url: URL, key: string, rawValue: unknown): void {
  if (typeof rawValue === 'undefined' || rawValue === null) {
    return;
  }

  if (Array.isArray(rawValue)) {
    for (const value of rawValue) {
      appendQueryParamValue(url, `${key}[]`, value);
    }
    return;
  }

  if (isPlainTransportOverrideMapping(rawValue)) {
    for (const [nestedKey, nestedValue] of Object.entries(rawValue)) {
      appendQueryParamValue(url, `${key}[${nestedKey}]`, nestedValue);
    }
    return;
  }

  if (rawValue instanceof Date) {
    url.searchParams.append(key, rawValue.toISOString());
    return;
  }

  url.searchParams.append(key, String(rawValue));
}

export function mergeQueryParamsIntoURL(
  url: URL,
  query: Record<string, unknown> | undefined,
): void {
  if (!query) {
    return;
  }

  for (const [key, rawValue] of Object.entries(query)) {
    if (typeof rawValue === 'undefined') {
      continue;
    }

    for (const existingKey of Array.from(url.searchParams.keys())) {
      if (existingKey === key || existingKey.startsWith(`${key}[`)) {
        url.searchParams.delete(existingKey);
      }
    }
    if (rawValue === null) {
      continue;
    }

    appendQueryParamValue(url, key, rawValue);
  }
}

export function ensureResponsesWebSocketPath(pathname: string): string {
  const normalizedPath = pathname.replace(/\/+$/, '');
  if (
    normalizedPath === '/responses' ||
    normalizedPath.endsWith('/responses')
  ) {
    return normalizedPath;
  }
  return `${normalizedPath}/responses`;
}
