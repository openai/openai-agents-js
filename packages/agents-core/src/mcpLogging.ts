const URL_DERIVED_NAME_PREFIXES = ['sse: ', 'streamable-http: '] as const;
const MAX_PROTOTYPE_DEPTH = 8;
const MIN_WEAK_SECRET_SUBSTRING_LENGTH = 8;
const DOM_EXCEPTION_PROTOTYPE =
  typeof DOMException === 'undefined' ? undefined : DOMException.prototype;
const DOM_EXCEPTION_NAME_GETTER = DOM_EXCEPTION_PROTOTYPE
  ? Object.getOwnPropertyDescriptor(DOM_EXCEPTION_PROTOTYPE, 'name')?.get
  : undefined;
const DOM_EXCEPTION_MESSAGE_GETTER = DOM_EXCEPTION_PROTOTYPE
  ? Object.getOwnPropertyDescriptor(DOM_EXCEPTION_PROTOTYPE, 'message')?.get
  : undefined;
const DOM_EXCEPTION_CODE_GETTER = DOM_EXCEPTION_PROTOTYPE
  ? Object.getOwnPropertyDescriptor(DOM_EXCEPTION_PROTOTYPE, 'code')?.get
  : undefined;

type EndpointSecrets = {
  strong: Set<string>;
  weak: Set<string>;
};

type EndpointRedactionInfo = {
  secrets: EndpointSecrets;
  url?: URL;
};

type SafeDiagnostics = {
  name?: string;
  message?: string;
  code?: string | number;
  status?: string | number;
  statusCode?: string | number;
};

type ErrorGraphInspection = {
  kind: 'safe' | 'secret' | 'opaque';
  diagnostics: SafeDiagnostics;
};

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

function addStringVariants(target: Set<string>, value: string): void {
  if (!value) {
    return;
  }
  target.add(value);
  try {
    target.add(decodeURIComponent(value));
  } catch {
    // Keep the original encoded value.
  }
}

function getEndpointSecrets(url: URL): EndpointSecrets | undefined {
  if (!url.username && !url.password && !url.search && !url.hash) {
    return undefined;
  }

  const strong = new Set<string>();
  const weak = new Set<string>();
  addStringVariants(strong, url.href);
  addStringVariants(strong, url.search);
  addStringVariants(strong, url.hash);
  if (url.username || url.password) {
    addStringVariants(strong, `${url.username}:${url.password}@`);
  }
  addStringVariants(weak, url.username);
  addStringVariants(weak, url.password);
  addStringVariants(weak, url.search.slice(1));
  addStringVariants(weak, url.hash.slice(1));
  for (const [key, value] of url.searchParams) {
    addStringVariants(weak, value || key);
  }
  return { strong, weak };
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
    const secrets = getEndpointSecrets(url);
    return secrets ? { secrets, url } : undefined;
  }
  if (!hasMalformedEndpointSecrets(endpoint)) {
    return undefined;
  }
  const strong = new Set<string>();
  addStringVariants(strong, endpoint);
  return { secrets: { strong, weak: new Set() } };
}

function stringContainsEndpointSecret(
  value: string,
  secrets: EndpointSecrets,
): boolean {
  for (const secret of secrets.strong) {
    if (value.includes(secret)) {
      return true;
    }
  }
  for (const secret of secrets.weak) {
    if (
      value === secret ||
      (secret.length >= MIN_WEAK_SECRET_SUBSTRING_LENGTH &&
        value.includes(secret)) ||
      stringContainsDelimitedSecret(value, secret)
    ) {
      return true;
    }
  }
  return false;
}

function stringContainsDelimitedSecret(value: string, secret: string): boolean {
  let index = value.indexOf(secret);
  while (index >= 0) {
    const before = index === 0 ? undefined : value[index - 1];
    const afterIndex = index + secret.length;
    const after = afterIndex === value.length ? undefined : value[afterIndex];
    if (
      (!isIdentifierCharacter(secret[0]) || !isIdentifierCharacter(before)) &&
      (!isIdentifierCharacter(secret[secret.length - 1]) ||
        !isIdentifierCharacter(after))
    ) {
      return true;
    }
    index = value.indexOf(secret, index + 1);
  }
  return false;
}

function isIdentifierCharacter(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function getIntrinsicPrimitive(
  value: unknown,
  getter: (() => unknown) | undefined,
): string | number | undefined {
  if (!getter) {
    return undefined;
  }
  try {
    const result = getter.call(value);
    return typeof result === 'string' || typeof result === 'number'
      ? result
      : undefined;
  } catch {
    return undefined;
  }
}

function getSafeDiagnostic(
  value: unknown,
  secrets: EndpointSecrets,
): string | number | undefined {
  return (typeof value === 'string' || typeof value === 'number') &&
    !stringContainsEndpointSecret(String(value), secrets)
    ? value
    : undefined;
}

function collectPrototypeName(
  value: object,
  secrets: EndpointSecrets,
): string | undefined {
  try {
    let prototype = Object.getPrototypeOf(value);
    let depth = 0;
    while (prototype !== null && depth < MAX_PROTOTYPE_DEPTH) {
      const descriptor = Object.getOwnPropertyDescriptor(prototype, 'name');
      if (descriptor) {
        if ('value' in descriptor) {
          const name = getSafeDiagnostic(descriptor.value, secrets);
          return typeof name === 'string' ? name : undefined;
        }
        return undefined;
      }
      prototype = Object.getPrototypeOf(prototype);
      depth += 1;
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function collectSafeDiagnostics(
  value: object,
  secrets: EndpointSecrets,
): SafeDiagnostics {
  const diagnostics: SafeDiagnostics = {};
  const domExceptionMessage = getIntrinsicPrimitive(
    value,
    DOM_EXCEPTION_MESSAGE_GETTER,
  );
  if (typeof domExceptionMessage === 'string') {
    const message = getSafeDiagnostic(domExceptionMessage, secrets);
    const name = getSafeDiagnostic(
      getIntrinsicPrimitive(value, DOM_EXCEPTION_NAME_GETTER),
      secrets,
    );
    const code = getSafeDiagnostic(
      getIntrinsicPrimitive(value, DOM_EXCEPTION_CODE_GETTER),
      secrets,
    );
    if (typeof message === 'string') {
      diagnostics.message = message;
    }
    if (typeof name === 'string') {
      diagnostics.name = name;
    }
    if (code !== undefined) {
      diagnostics.code = code;
    }
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return diagnostics;
  }
  for (const propertyName of [
    'name',
    'message',
    'code',
    'status',
    'statusCode',
  ] as const) {
    const descriptor = descriptors[propertyName];
    if (!descriptor || !('value' in descriptor)) {
      continue;
    }
    const diagnostic = getSafeDiagnostic(descriptor.value, secrets);
    if (diagnostic === undefined) {
      continue;
    }
    if (propertyName === 'name' || propertyName === 'message') {
      if (typeof diagnostic === 'string') {
        diagnostics[propertyName] = diagnostic;
      }
    } else {
      diagnostics[propertyName] = diagnostic;
    }
  }
  diagnostics.name ??= collectPrototypeName(value, secrets);
  return diagnostics;
}

function inspectErrorGraph(
  value: unknown,
  secrets: EndpointSecrets,
): ErrorGraphInspection {
  if (typeof value === 'string') {
    return {
      kind: stringContainsEndpointSecret(value, secrets) ? 'secret' : 'safe',
      diagnostics: {},
    };
  }
  if (
    value === null ||
    (typeof value !== 'object' &&
      typeof value !== 'function' &&
      typeof value !== 'symbol')
  ) {
    return { kind: 'safe', diagnostics: {} };
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { kind: 'opaque', diagnostics: {} };
  }
  return {
    kind: 'opaque',
    diagnostics: collectSafeDiagnostics(value, secrets),
  };
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
  const inspection = inspectErrorGraph(error, redactionInfo.secrets);
  if (inspection.kind === 'safe') {
    return error;
  }

  const safeEndpoint = redactionInfo.url
    ? ` for ${redactionInfo.url.protocol}//${redactionInfo.url.host}${redactionInfo.url.pathname}`
    : '';
  const sanitized = new Error(
    inspection.diagnostics.message ??
      `MCP ${operation} failed${safeEndpoint}; configured endpoint credentials were redacted.`,
  );
  sanitized.name =
    inspection.diagnostics.name === 'AbortError' ||
    inspection.diagnostics.name === 'CanceledError' ||
    inspection.diagnostics.name === 'CancelledError'
      ? inspection.diagnostics.name
      : 'MCPTransportError';

  for (const propertyName of ['code', 'status', 'statusCode'] as const) {
    const value = inspection.diagnostics[propertyName];
    if (value !== undefined) {
      Object.defineProperty(sanitized, propertyName, {
        value,
        configurable: true,
        enumerable: true,
        writable: true,
      });
    }
  }
  return sanitized;
}
