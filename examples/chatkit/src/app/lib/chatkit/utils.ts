import { StreamedRunResult } from '@openai/agents';

export function createId(prefix: string): string {
  const randomUUID =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : undefined;
  if (randomUUID) {
    return `${prefix}_${randomUUID}`;
  }
  return `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

export function attachPreviousResponseIdPersistence(
  stream: StreamedRunResult<any, any>,
  onLastResponseId: (id: string) => void,
): void {
  void (async () => {
    try {
      await stream.completed;
    } catch {
      // Ignore stream errors while updating the stored response id.
    }
    if (stream.lastResponseId) {
      onLastResponseId(stream.lastResponseId);
    }
  })();
}
