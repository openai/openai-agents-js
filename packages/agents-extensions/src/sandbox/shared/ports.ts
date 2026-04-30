import {
  SandboxConfigurationError,
  SandboxProviderError,
  type ExposedPortEndpoint,
  getRecordedExposedPortEndpoint,
  normalizeExposedPort,
  recordExposedPortEndpoint,
  type SandboxSessionState,
} from '@openai/agents-core/sandbox';

export function assertConfiguredExposedPort(args: {
  providerName: string;
  port: number;
  configuredPorts?: number[];
  allowOnDemand?: boolean;
}): number {
  const port = normalizeExposedPort(args.port);
  if (args.allowOnDemand) {
    return port;
  }

  const configuredPorts = args.configuredPorts?.map((entry) =>
    normalizeExposedPort(entry),
  );
  if (!configuredPorts?.includes(port)) {
    throw new SandboxConfigurationError(
      `${args.providerName} exposed port ${port} was not configured. Configure exposedPorts with ${port} before resolving it.`,
      {
        provider: args.providerName,
        port,
        configuredPorts: configuredPorts ?? [],
      },
    );
  }
  return port;
}

export function getCachedExposedPortEndpoint(
  state: SandboxSessionState,
  port: number,
): ExposedPortEndpoint | undefined {
  return getRecordedExposedPortEndpoint(state, port);
}

export function recordResolvedExposedPortEndpoint(
  state: SandboxSessionState,
  requestedPort: number,
  endpoint: ExposedPortEndpoint,
): ExposedPortEndpoint {
  return recordExposedPortEndpoint(state, endpoint, requestedPort);
}

export function parseExposedPortEndpoint(
  value: string,
  args: {
    providerName: string;
    source: string;
    query?: string;
  },
): ExposedPortEndpoint {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new SandboxProviderError(
      `${args.providerName} returned an empty exposed port ${args.source}.`,
      {
        provider: args.providerName,
        source: args.source,
      },
    );
  }

  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed);
  let parsed: URL;
  try {
    parsed = new URL(hasScheme ? trimmed : `http://${trimmed}`);
  } catch (error) {
    throw new SandboxProviderError(
      `${args.providerName} returned an invalid exposed port ${args.source}: ${trimmed}`,
      {
        provider: args.providerName,
        source: args.source,
        value: trimmed,
        cause: error instanceof Error ? error.message : String(error),
      },
    );
  }

  const host = parsed.hostname;
  if (!host) {
    throw new SandboxProviderError(
      `${args.providerName} returned an exposed port ${args.source} without a host: ${trimmed}`,
      {
        provider: args.providerName,
        source: args.source,
        value: trimmed,
      },
    );
  }

  const explicitPort =
    parsed.port.length > 0 ? Number.parseInt(parsed.port, 10) : undefined;
  const tls = hasScheme
    ? parsed.protocol === 'https:' || parsed.protocol === 'wss:'
    : explicitPort === undefined;
  const port = normalizeExposedPort(explicitPort ?? (tls ? 443 : 80));
  const query = [parsed.search.replace(/^\?/u, ''), args.query]
    .filter((entry): entry is string => typeof entry === 'string')
    .filter((entry) => entry.length > 0)
    .join('&');

  return {
    host,
    port,
    tls,
    query,
    url: hasScheme ? trimmed : undefined,
  };
}
