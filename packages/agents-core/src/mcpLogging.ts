const URL_DERIVED_NAME_PREFIXES = ['sse: ', 'streamable-http: '] as const;
const MAX_PROTOTYPE_DEPTH = 8;
const MIN_WEAK_SECRET_SUBSTRING_LENGTH = 8;
const NATIVE_ERROR_STACK_GETTER = Object.getOwnPropertyDescriptor(
  new Error(),
  'stack',
)?.get;
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
  includeWeak: boolean,
): boolean {
  for (const secret of secrets.strong) {
    if (value.includes(secret)) {
      return true;
    }
  }
  if (includeWeak) {
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

function getPrototypeChain(value: object): object[] | undefined {
  const prototypes: object[] = [];
  try {
    let prototype = Object.getPrototypeOf(value);
    while (prototype !== null) {
      if (prototypes.length >= MAX_PROTOTYPE_DEPTH) {
        return undefined;
      }
      prototypes.push(prototype);
      prototype = Object.getPrototypeOf(prototype);
    }
    return prototypes;
  } catch {
    return undefined;
  }
}

function getSafeDiagnostic(
  value: unknown,
  secrets: EndpointSecrets,
): string | number | undefined {
  return (typeof value === 'string' || typeof value === 'number') &&
    !stringContainsEndpointSecret(String(value), secrets, true)
    ? value
    : undefined;
}

function inspectErrorGraph(
  value: unknown,
  secrets: EndpointSecrets,
): ErrorGraphInspection {
  const diagnostics: SafeDiagnostics = {};
  if (typeof value === 'string') {
    return {
      kind: stringContainsEndpointSecret(value, secrets, true)
        ? 'secret'
        : 'safe',
      diagnostics,
    };
  }
  if (
    value === null ||
    (typeof value !== 'object' &&
      typeof value !== 'function' &&
      typeof value !== 'symbol')
  ) {
    return { kind: 'safe', diagnostics };
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    return { kind: 'opaque', diagnostics };
  }

  const domExceptionMessage = getIntrinsicPrimitive(
    value,
    DOM_EXCEPTION_MESSAGE_GETTER,
  );
  const isDomException = typeof domExceptionMessage === 'string';
  if (isDomException) {
    const name = getSafeDiagnostic(
      getIntrinsicPrimitive(value, DOM_EXCEPTION_NAME_GETTER),
      secrets,
    );
    const code = getSafeDiagnostic(
      getIntrinsicPrimitive(value, DOM_EXCEPTION_CODE_GETTER),
      secrets,
    );
    if (typeof name === 'string') {
      diagnostics.name = name;
    }
    if (code !== undefined) {
      diagnostics.code = code;
    }
    if (stringContainsEndpointSecret(domExceptionMessage, secrets, true)) {
      return { kind: 'secret', diagnostics };
    }
  }

  const prototypes = getPrototypeChain(value);
  if (!prototypes) {
    return { kind: 'opaque', diagnostics };
  }
  if (isDomException && prototypes[0] === DOM_EXCEPTION_PROTOTYPE) {
    // Native DOMException fields are read through captured intrinsic getters.
  } else if (prototypes.length === 0 || prototypes[0] === Object.prototype) {
    // Descriptor-only plain objects are safe to inspect below.
  } else {
    const errorPrototypeIndex = prototypes.indexOf(Error.prototype);
    if (errorPrototypeIndex < 0) {
      return { kind: 'opaque', diagnostics };
    }
    let hasCustomConstructor = false;
    for (const prototype of prototypes.slice(0, errorPrototypeIndex)) {
      let descriptors: PropertyDescriptorMap;
      try {
        descriptors = Object.getOwnPropertyDescriptors(prototype);
      } catch {
        return { kind: 'opaque', diagnostics };
      }
      for (const name of Reflect.ownKeys(descriptors)) {
        if (typeof name === 'symbol') {
          return { kind: 'opaque', diagnostics };
        }
        if (name === 'constructor') {
          hasCustomConstructor = true;
          continue;
        }
        const descriptor = descriptors[name];
        if (
          (name !== 'name' && name !== 'message') ||
          !('value' in descriptor) ||
          typeof descriptor.value !== 'string'
        ) {
          return { kind: 'opaque', diagnostics };
        }
        if (stringContainsEndpointSecret(descriptor.value, secrets, true)) {
          return { kind: 'secret', diagnostics };
        }
        if (name === 'name') {
          diagnostics.name = descriptor.value;
        }
      }
    }
    if (hasCustomConstructor) {
      return { kind: 'opaque', diagnostics };
    }
  }

  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(value);
  } catch {
    return { kind: 'opaque', diagnostics };
  }
  for (const propertyName of [
    'name',
    'code',
    'status',
    'statusCode',
  ] as const) {
    const descriptor = descriptors[propertyName];
    if (descriptor && 'value' in descriptor) {
      const diagnostic = getSafeDiagnostic(descriptor.value, secrets);
      if (diagnostic !== undefined) {
        if (propertyName === 'name') {
          if (typeof diagnostic === 'string') {
            diagnostics.name = diagnostic;
          }
        } else {
          diagnostics[propertyName] = diagnostic;
        }
      }
    }
  }
  for (const name of Reflect.ownKeys(descriptors)) {
    if (typeof name === 'symbol') {
      return { kind: 'opaque', diagnostics };
    }
    if (stringContainsEndpointSecret(name, secrets, true)) {
      return { kind: 'secret', diagnostics };
    }
    const descriptor = descriptors[name];
    if (!('value' in descriptor)) {
      if (name === 'stack' && descriptor.get === NATIVE_ERROR_STACK_GETTER) {
        continue;
      }
      return { kind: 'opaque', diagnostics };
    }
    if (
      descriptor.value !== null &&
      (typeof descriptor.value === 'object' ||
        typeof descriptor.value === 'function' ||
        typeof descriptor.value === 'symbol')
    ) {
      return { kind: 'opaque', diagnostics };
    }
    if (
      typeof descriptor.value === 'string' &&
      stringContainsEndpointSecret(descriptor.value, secrets, true)
    ) {
      return { kind: 'secret', diagnostics };
    }
  }
  return { kind: 'safe', diagnostics };
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
