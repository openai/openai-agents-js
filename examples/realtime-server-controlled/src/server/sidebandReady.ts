import { voiceAgentConfiguration } from './agent';

export type SidebandSession = {
  connect(options: { apiKey: string; callId: string }): Promise<void>;
  on(event: 'transport_event', listener: (event: unknown) => void): unknown;
  off(event: 'transport_event', listener: (event: unknown) => void): unknown;
};

export async function connectSidebandAndWaitForReady(
  session: SidebandSession,
  options: { apiKey: string; callId: string; timeoutMs?: number },
): Promise<void> {
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const handleTransportEvent = (event: unknown) => {
    if (
      typeof event === 'object' &&
      event !== null &&
      'type' in event &&
      event.type === 'session.updated' &&
      'session' in event &&
      typeof event.session === 'object' &&
      event.session !== null &&
      'instructions' in event.session &&
      event.session.instructions === voiceAgentConfiguration.instructions &&
      'tools' in event.session &&
      Array.isArray(event.session.tools)
    ) {
      const tools = event.session.tools;
      // This example uses one static agent. A tracing-only acknowledgement
      // cannot confirm the update containing its instructions and tools.
      if (
        voiceAgentConfiguration.tools.every((expected) =>
          tools.some(
            (tool) => tool?.type === 'function' && tool.name === expected.name,
          ),
        )
      ) {
        resolveReady();
      }
    }
  };
  session.on('transport_event', handleTransportEvent);

  const timeout = setTimeout(() => {
    rejectReady(
      new Error('Timed out waiting for the initial session configuration.'),
    );
  }, options.timeoutMs ?? 10_000);

  try {
    await Promise.all([
      session.connect({ apiKey: options.apiKey, callId: options.callId }),
      ready,
    ]);
  } finally {
    clearTimeout(timeout);
    session.off('transport_event', handleTransportEvent);
  }
}
