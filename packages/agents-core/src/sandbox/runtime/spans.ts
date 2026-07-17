import {
  getCurrentTrace,
  Trace,
  withCustomSpan,
  withTraceContext,
} from '../../tracing';
import type { Span } from '../../tracing';
import type { CustomSpanData } from '../../tracing/spans';
import { emitSandboxEvent, serializeSandboxEventError } from '../events';

export async function withSandboxSpan<T>(
  name: string,
  data: Record<string, unknown>,
  fn: (span?: Span<CustomSpanData>) => Promise<T>,
  parent?: Span<any> | Trace,
): Promise<T> {
  const startedAt = Date.now();
  await emitSandboxEvent({
    type: 'sandbox_operation',
    name,
    phase: 'start',
    timestamp: new Date(startedAt).toISOString(),
    data: { ...data },
  });

  const runWithEvents = async (span?: Span<CustomSpanData>): Promise<T> => {
    try {
      const result = await fn(span);
      await emitSandboxEvent({
        type: 'sandbox_operation',
        name,
        phase: 'end',
        timestamp: new Date().toISOString(),
        data: { ...data },
        durationMs: Date.now() - startedAt,
      });
      return result;
    } catch (error) {
      const serializedError = serializeSandboxEventError(error);
      recordSandboxSpanError(span, serializedError);
      await emitSandboxEvent({
        type: 'sandbox_operation',
        name,
        phase: 'error',
        timestamp: new Date().toISOString(),
        data: { ...data },
        durationMs: Date.now() - startedAt,
        error: serializedError,
      });
      throw error;
    }
  };

  if (!getCurrentTrace() && !parent) {
    return await runWithEvents();
  }

  const runWithSpan = async () =>
    await withCustomSpan(
      async (span) => await runWithEvents(span),
      {
        data: {
          name,
          data,
        },
      },
      parent,
    );

  if (!getCurrentTrace() && parent) {
    const trace =
      parent instanceof Trace
        ? parent
        : new Trace({
            traceId: parent.traceId,
            name: 'Agent workflow',
            metadata: parent.traceMetadata,
            tracingApiKey: parent.tracingApiKey,
          });
    return await withTraceContext(
      {
        trace,
        span: parent instanceof Trace ? undefined : parent,
      },
      runWithSpan,
    );
  }

  return await runWithSpan();
}

function recordSandboxSpanError(
  span: Span<CustomSpanData> | undefined,
  error: ReturnType<typeof serializeSandboxEventError>,
): void {
  if (!span) {
    return;
  }
  span.spanData.data = {
    ...span.spanData.data,
    error,
    error_retryable: error.retryable ?? null,
  };
}
