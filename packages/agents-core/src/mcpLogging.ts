const URL_DERIVED_NAME_PREFIXES = ['sse: ', 'streamable-http: '] as const;
const MAX_PROTOTYPE_DEPTH = 8;
const DOM_EXCEPTION_PROTOTYPE =
  typeof DOMException === 'undefined' ? undefined : DOMException.prototype;
const DOM_EXCEPTION_NAME_GETTER = DOM_EXCEPTION_PROTOTYPE
  ? Object.getOwnPropertyDescriptor(DOM_EXCEPTION_PROTOTYPE, 'name')?.get
  : undefined;

type EndpointRedactionInfo = {
  url?: URL;
};

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

function hasMalformedEndpointSecrets(endpoint: string): boolean {
  if (endpoint.includes('?') || endpoint.includes('#')) {
    return true;
  }
  const schemeIndex = endpoint.indexOf('://');
  if (schemeIndex < 0) {
    return false;
  }
  const authorityStart = schemeIndex + 3;
  const authorityEndCandidates = [
    endpoint.indexOf('/', authorityStart),
    endpoint.indexOf('?', authorityStart),
    endpoint.indexOf('#', authorityStart),
  ].filter((index) => index >= 0);
  const authorityEnd =
    authorityEndCandidates.length > 0
      ? Math.min(...authorityEndCandidates)
      : endpoint.length;
  const atIndex = endpoint.lastIndexOf('@', authorityEnd);
  return atIndex >= authorityStart && atIndex < authorityEnd;
}

function getEndpointRedactionInfo(
  endpoint: string,
): EndpointRedactionInfo | undefined {
  const url = parseHttpUrl(endpoint);
  if (url) {
    return url.username || url.password || url.search || url.hash
      ? { url }
      : undefined;
  }
  if (!hasMalformedEndpointSecrets(endpoint)) {
    return undefined;
  }
  return {};
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
// In diagnostic mode, preserve ordinary names while removing URL credentials,
// query parameters, and fragments. Redacted logging must use a fixed label
// without reading the server name at all.
export function getMcpServerDiagnosticName(name: string): string {
  const prefix = URL_DERIVED_NAME_PREFIXES.find((candidate) =>
    name.startsWith(candidate),
  );
  const candidate = prefix ? name.slice(prefix.length) : name;
  const url = parseHttpUrl(candidate);
  if (url) {
    return `${prefix ?? ''}${url.protocol}//${url.host}${url.pathname}`;
  }
  if (
    (prefix || candidate.includes('://')) &&
    hasMalformedEndpointSecrets(candidate)
  ) {
    return `${prefix ?? ''}<redacted endpoint>`;
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

  const safeEndpoint = redactionInfo.url
    ? ` for ${redactionInfo.url.protocol}//${redactionInfo.url.host}${redactionInfo.url.pathname}`
    : '';
  const sanitized = new Error(
    `MCP ${operation} failed${safeEndpoint}; configured endpoint credentials were redacted.`,
  );
  sanitized.name = cancellationName ?? 'MCPTransportError';
  return sanitized;
}
