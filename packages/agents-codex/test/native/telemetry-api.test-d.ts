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

const batchOnly: telemetry.TraceProcessorRegistration = {
  onEvents(events) {
    void events;
  },
};
void telemetry.configure({ traceProcessors: [batchOnly] });
void telemetry.addTraceProcessor(batchOnly);
void telemetry.setTraceProcessors([batchOnly]);
class PerEventProcessor implements telemetry.TraceProcessor {
  onEvent(event: telemetry.TraceEvent): void {
    void event;
  }
}
void new PerEventProcessor();

// @ts-expect-error A processor needs at least one callback.
void telemetry.configure({ traceProcessors: [{}] });
// @ts-expect-error A processor needs at least one callback.
void telemetry.addTraceProcessor({});
// @ts-expect-error A processor needs at least one callback.
void telemetry.setTraceProcessors([{}]);
const directProcessor: telemetry.TraceProcessor = new PerEventProcessor();
void directProcessor.onEvent({} as telemetry.TraceEvent);
void telemetry.addTraceProcessor({
  onEvent(event) {
    const typed: telemetry.TraceEvent = event;
    void typed;
  },
  onEvents(events) {
    const typed: readonly telemetry.TraceEvent[] = events;
    void typed;
  },
});
