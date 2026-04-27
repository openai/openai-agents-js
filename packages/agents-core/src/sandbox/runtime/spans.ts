import { getCurrentTrace, withCustomSpan } from '../../tracing';
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

  const runWithEvents = async (): Promise<T> => {
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
      await emitSandboxEvent({
        type: 'sandbox_operation',
        name,
        phase: 'error',
        timestamp: new Date().toISOString(),
        data: { ...data },
        durationMs: Date.now() - startedAt,
        error: serializeSandboxEventError(error),
      });
      throw error;
    }
  };

  if (!getCurrentTrace()) {
    return await runWithEvents();
  }

  return await withCustomSpan(async () => await runWithEvents(), {
    data: {
      name,
      data,
    },
  });
}
