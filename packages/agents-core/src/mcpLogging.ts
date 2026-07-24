const URL_DERIVED_NAME_PREFIXES = ['sse: ', 'streamable-http: '] as const;

// Some transports use their full endpoint URL as the default server name.
// In diagnostic mode, preserve ordinary names while removing URL credentials,
// query parameters, and fragments. Redacted logging must use a fixed label
// without reading the server name at all.
export function getMcpServerDiagnosticName(name: string): string {
  const prefix = URL_DERIVED_NAME_PREFIXES.find((candidate) =>
    name.startsWith(candidate),
  );
  const candidate = prefix ? name.slice(prefix.length) : name;

  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return name;
    }
    return `${prefix ?? ''}${url.protocol}//${url.host}${url.pathname}`;
  } catch {
    return name;
  }
}
