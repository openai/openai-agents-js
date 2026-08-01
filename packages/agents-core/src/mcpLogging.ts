const URL_DERIVED_NAME_PREFIXES = ['sse: ', 'streamable-http: '] as const;
const INVALID_URL_DERIVED_NAME = '<redacted endpoint>';
const MAX_PROTOTYPE_DEPTH = 8;
const DOM_EXCEPTION_PROTOTYPE =
  typeof DOMException === 'undefined' ? undefined : DOMException.prototype;
const DOM_EXCEPTION_NAME_GETTER = DOM_EXCEPTION_PROTOTYPE
  ? Object.getOwnPropertyDescriptor(DOM_EXCEPTION_PROTOTYPE, 'name')?.get
  : undefined;

type EndpointRedactionInfo =
  { kind: 'invalid' } | { kind: 'sensitive'; url: URL };

type CancellationName = 'AbortError' | 'CanceledError' | 'CancelledError';
type CancellationCode = 'ABORT_ERR' | 'ERR_ABORTED';

function parseHttpUrl(candidate: string): URL | undefined {
  try {
    const url = new URL(candidate);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url
      : undefined;
  } catch {
    return undefined;
  }
}

function getEndpointRedactionInfo(
  endpoint: string,
): EndpointRedactionInfo | undefined {
  const url = parseHttpUrl(endpoint);
  if (!url) {
    return { kind: 'invalid' };
  }
  return url.username || url.password || url.search || url.hash
    ? { kind: 'sensitive', url }
    : undefined;
}

function getIntrinsicString(
  value: unknown,
  getter: (() => unknown) | undefined,
): string | undefined {
  if (!getter) {
    return undefined;
  }
  try {
    const result = getter.call(value);
    return typeof result === 'string' ? result : undefined;
  } catch {
    return undefined;
  }
}

function getCancellationName(value: unknown): CancellationName | undefined {
  return value === 'AbortError' ||
    value === 'CanceledError' ||
    value === 'CancelledError'
    ? value
    : undefined;
}

function getCancellationCode(value: unknown): CancellationCode | undefined {
  return value === 'ABORT_ERR' || value === 'ERR_ABORTED' ? value : undefined;
}

function collectDescriptorCancellationValue<T>(
  value: object,
  propertyName: 'name' | 'code',
  getValue: (candidate: unknown) => T | undefined,
): T | undefined {
  try {
    let current: object | null = value;
    let depth = 0;
    while (current !== null && depth <= MAX_PROTOTYPE_DEPTH) {
      const descriptor = Object.getOwnPropertyDescriptor(current, propertyName);
      if (descriptor) {
        return 'value' in descriptor ? getValue(descriptor.value) : undefined;
      }
      current = Object.getPrototypeOf(current);
      depth += 1;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function collectCancellationName(value: object): CancellationName | undefined {
  const domExceptionName = getCancellationName(
    getIntrinsicString(value, DOM_EXCEPTION_NAME_GETTER),
  );
  if (domExceptionName) {
    return domExceptionName;
  }

  const descriptorName = collectDescriptorCancellationValue(
    value,
    'name',
    getCancellationName,
  );
  if (descriptorName) {
    return descriptorName;
  }

  const descriptorCode = collectDescriptorCancellationValue(
    value,
    'code',
    getCancellationCode,
  );
  return descriptorCode ? 'AbortError' : undefined;
}

// Some transports use their full endpoint URL as the default server name.
// Preserve ordinary names while removing URL credentials, query parameters,
// and fragments from external surfaces. Redacted logging must use a fixed
// label without reading the server name at all.
export function getMcpServerExternalName(name: string): string {
  const prefix = URL_DERIVED_NAME_PREFIXES.find((candidate) =>
    name.startsWith(candidate),
  );
  const candidate = prefix ? name.slice(prefix.length) : name;
  const redactionInfo = getEndpointRedactionInfo(candidate);
  if (!redactionInfo) {
    return name;
  }
  if (redactionInfo.kind === 'sensitive') {
    const url = redactionInfo.url;
    return `${prefix ?? ''}${url.protocol}//${url.host}${url.pathname}`;
  }
  if (prefix) {
    return `${prefix}${INVALID_URL_DERIVED_NAME}`;
  }
  if (/^https?:\/\//i.test(candidate.trimStart())) {
    return INVALID_URL_DERIVED_NAME;
  }
  return name;
}

export function sanitizeMcpTransportError(
  error: unknown,
  endpoint: string,
  operation: string,
): unknown {
  const redactionInfo = getEndpointRedactionInfo(endpoint);
  if (!redactionInfo) {
    return error;
  }

  const cancellationName =
    error !== null && typeof error === 'object'
      ? collectCancellationName(error)
      : undefined;

  const safeEndpoint =
    redactionInfo.kind === 'sensitive'
      ? ` for ${redactionInfo.url.protocol}//${redactionInfo.url.host}${redactionInfo.url.pathname}`
      : '';
  const redactionMessage =
    redactionInfo.kind === 'sensitive'
      ? 'configured endpoint credentials were redacted.'
      : 'configured endpoint was invalid and was redacted.';
  const sanitized = new Error(
    `MCP ${operation} failed${safeEndpoint}; ${redactionMessage}`,
  );
  sanitized.name = cancellationName ?? 'MCPTransportError';
  return sanitized;
}
