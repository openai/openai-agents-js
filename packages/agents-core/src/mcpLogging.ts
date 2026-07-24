const URL_DERIVED_NAME_PREFIXES = ['sse: ', 'streamable-http: '] as const;

// Some transports use their full endpoint URL as the default server name.
// Preserve ordinary names while removing URL credentials, query parameters,
// and fragments before a server name is written to logs.
export function getMcpServerLogName(name: string): string {
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
