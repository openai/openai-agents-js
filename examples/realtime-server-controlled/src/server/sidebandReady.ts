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
      event.type === 'session.updated'
    ) {
      resolveReady();
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
