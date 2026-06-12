import { getCurrentTrace, withCustomSpan } from '../../tracing';
import type { Span } from '../../tracing';
import type { CustomSpanData } from '../../tracing/spans';
import { emitSandboxEvent, serializeSandboxEventError } from '../events';

export async function withSandboxSpan<T>(
  name: string,
  data: Record<string, unknown>,
  fn: () => Promise<T>,
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
      const result = await fn();
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

  if (!getCurrentTrace()) {
    return await runWithEvents();
  }

  return await withCustomSpan(async (span) => await runWithEvents(span), {
    data: {
      name,
      data,
    },
  });
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
