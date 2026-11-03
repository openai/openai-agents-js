import { telemetry, type Exporter, type TelemetryOptions } from '../../src';

const exporter: Exporter = {
  kind: 'otlp-http',
  endpoint: 'http://127.0.0.1:4318/v1/logs',
  protocol: 'json',
  headers: { 'x-collector': 'fixture' },
};
const options: TelemetryOptions = {
  logs: exporter,
  traces: { kind: 'otlp-grpc', endpoint: 'http://127.0.0.1:4317' },
  metrics: null,
};
const configured: Promise<void> = telemetry.configure(options);
const closed: Promise<void> = telemetry.shutdown();
void [configured, closed];
// @ts-expect-error Public options are readonly.
options.logUserPrompt = true;
// @ts-expect-error Exporter discriminants are readonly.
exporter.kind = 'otlp-grpc';
const grpc: Exporter = {
  kind: 'otlp-grpc',
  endpoint: 'http://127.0.0.1:4317',
  // @ts-expect-error Protocol belongs only to HTTP exporters.
  protocol: 'json',
};
void grpc;
