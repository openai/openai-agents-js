/** Optional native telemetry. Configure before opening sessions; close them before shutdown. */
import { isAbsolute, resolve } from 'node:path';
import { binding } from './binding';

/** Native HTTP or gRPC TLS paths. Supply client certificate and key together. */
export interface OtelTlsConfig {
  readonly caCertificate?: string;
  readonly clientCertificate?: string;
  readonly clientPrivateKey?: string;
}

/** An explicit native OTLP destination. Omitted signals stay disabled. */
export type Exporter =
  | {
      readonly kind: 'otlp-http';
      readonly endpoint: string;
      readonly protocol?: 'binary' | 'json';
      readonly headers?: Readonly<Record<string, string>>;
      readonly tls?: OtelTlsConfig;
    }
  | {
      readonly kind: 'otlp-grpc';
      readonly endpoint: string;
      readonly headers?: Readonly<Record<string, string>>;
      readonly tls?: OtelTlsConfig;
    };

export interface TelemetryOptions {
  readonly traces?: Exporter | null;
  readonly logs?: Exporter | null;
  readonly metrics?: Exporter | null;
  /** Exporter resource environment label. Defaults to 'dev'. */
  readonly environment?: string;
  readonly spanAttributes?: Readonly<Record<string, string>>;
  readonly logUserPrompt?: boolean;
  readonly logAgentResponses?: boolean;
  /** UTF-8 output prefix bound; full tool arguments can still appear. Defaults to zero. */
  readonly toolResultMaxBytes?: number;
}

function invalid(field: string): never {
  throw new TypeError(`Invalid telemetry ${field}`);
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    invalid(field);
  return value as Record<string, unknown>;
}

function stringMap(value: unknown, field: string): Record<string, string> {
  if (value === undefined) return {};
  const entries = Object.entries(object(value, field));
  if (entries.some(([, item]) => typeof item !== 'string')) invalid(field);
  return Object.fromEntries(entries) as Record<string, string>;
}

function exporter(value: unknown, signal: string): unknown {
  if (value === undefined || value === null) return 'none';
  const input = object(value, signal);
  if (input.kind !== 'otlp-http' && input.kind !== 'otlp-grpc')
    invalid(`${signal} kind`);
  if (typeof input.endpoint !== 'string' || input.endpoint.length === 0)
    invalid(`${signal} endpoint`);
  const wire: Record<string, unknown> = {
    endpoint: input.endpoint,
    headers: stringMap(input.headers, `${signal} headers`),
  };
  if (input.kind === 'otlp-http') {
    if (
      input.protocol !== undefined &&
      input.protocol !== 'binary' &&
      input.protocol !== 'json'
    )
      invalid(`${signal} protocol`);
    wire.protocol = input.protocol ?? 'binary';
  }
  if (input.tls !== undefined) {
    const tls = object(input.tls, `${signal} tls`);
    const paths: Record<string, string> = {};
    for (const [name, key] of [
      ['caCertificate', 'ca-certificate'],
      ['clientCertificate', 'client-certificate'],
      ['clientPrivateKey', 'client-private-key'],
    ] as const) {
      const path = tls[name];
      if (path === undefined) continue;
      if (typeof path !== 'string') invalid(`${signal} tls ${name}`);
      // Do not ask for cwd when the application already supplied an absolute path.
      paths[key] = isAbsolute(path) ? path : resolve(path);
    }
    wire.tls = paths;
  }
  return { [input.kind]: wire };
}

/**
 * Configure native exporters once per process before the first session attempt.
 * Text switches affect named native records, not all sensitive content. A failure
 * after native claims the subscriber requires a new process.
 */
export async function configure(options: TelemetryOptions = {}): Promise<void> {
  const input = object(options, 'options');
  for (const field of ['logUserPrompt', 'logAgentResponses'] as const) {
    if (input[field] !== undefined && typeof input[field] !== 'boolean')
      invalid(field);
  }
  if (input.environment !== undefined && typeof input.environment !== 'string')
    invalid('environment');
  const max = input.toolResultMaxBytes ?? 0;
  if (typeof max !== 'number' || !Number.isSafeInteger(max) || max < 0)
    invalid('toolResultMaxBytes');
  // Capture a fresh wire value before the first await. Never use the general
  // schema error formatter with endpoint, header, or private-key values.
  const encoded = JSON.stringify({
    'otel.exporter': exporter(input.logs, 'logs'),
    'otel.trace_exporter': exporter(input.traces, 'traces'),
    'otel.metrics_exporter': exporter(input.metrics, 'metrics'),
    'analytics.enabled': input.metrics !== undefined && input.metrics !== null,
    'otel.environment': input.environment ?? 'dev',
    'otel.span_attributes': stringMap(input.spanAttributes, 'spanAttributes'),
    'otel.log_user_prompt': input.logUserPrompt ?? false,
    'otel.log_agent_responses': input.logAgentResponses ?? false,
    'otel.tool_result': { max_bytes: max },
  });
  await (await binding()).configure_telemetry(encoded);
}

/** Request a native exporter flush after all sessions close, then retire this process owner. */
export async function shutdown(): Promise<void> {
  await (await binding()).shutdown_telemetry();
}
