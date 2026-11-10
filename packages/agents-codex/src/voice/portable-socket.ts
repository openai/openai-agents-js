import {
  resolvePortableVoiceApiKey,
  type PortableVoiceApiKey,
} from './portable-credentials';
import {
  PortableVoiceSession,
  type PortableVoiceControl,
  type PortableVoiceOptions,
} from './portable-session';

/** The shared subset supplied by Node WebSocket implementations and Workers. */
export interface PortableVoiceSocket {
  readonly readyState: number;
  send(frame: string): void;
  close(): void;
  addEventListener(type: string, listener: (event: any) => void): void;
  removeEventListener(type: string, listener: (event: any) => void): void;
}

/** Direct execution with an explicit host socket; no file-backed Session is created. */
export async function connectPortableVoiceWebSocket(options: {
  control: PortableVoiceControl;
  apiKey: PortableVoiceApiKey;
  agent: PortableVoiceOptions;
  createWebSocket(
    url: string,
    headers: Readonly<Record<string, string>>,
    signal?: AbortSignal,
  ): PortableVoiceSocket | Promise<PortableVoiceSocket>;
  url?: string;
  signal?: AbortSignal;
}): Promise<PortableVoiceSession> {
  const apiKey = await resolvePortableVoiceApiKey(
    options.apiKey,
    options.signal,
  );
  if (options.signal?.aborted)
    throw options.signal.reason ?? new Error('Voice connection aborted.');
  const endpoint = new URL(options.url ?? 'wss://api.openai.com/v1/realtime');
  if (endpoint.protocol !== 'wss:')
    throw new TypeError('Provider WebSocket URL must use wss.');
  endpoint.searchParams.set('model', options.agent.model);
  const socket = await options.createWebSocket(
    endpoint.href,
    { Authorization: `Bearer ${apiKey}` },
    options.signal,
  );
  let session: PortableVoiceSession | undefined;
  let resolveOpen!: () => void;
  let rejectOpen!: (error: unknown) => void;
  const opened = new Promise<void>((resolve, reject) => {
    resolveOpen = resolve;
    rejectOpen = reject;
  });
  void opened.catch(() => {});
  const openingTimer = setTimeout(
    () => fail(new Error('Voice WebSocket opening timed out.')),
    10_000,
  );
  const onOpen = () => {
    clearTimeout(openingTimer);
    resolveOpen();
  };
  const fail = (error: unknown) => {
    rejectOpen(error);
    session?.fail(error);
  };
  const onError = () => fail(new Error('Provider voice WebSocket failed.'));
  const onClose = () => fail(new Error('Provider voice WebSocket closed.'));
  const onMessage = (event: { data: unknown }) => {
    try {
      if (typeof event.data !== 'string')
        throw new Error('Provider voice frames must be text.');
      session?.receive(JSON.parse(event.data));
    } catch (error) {
      fail(error);
    }
  };
  const onAbort = () =>
    fail(options.signal?.reason ?? new Error('Voice connection aborted.'));
  const cleanup = () => {
    clearTimeout(openingTimer);
    rejectOpen(new Error('Voice WebSocket closed.'));
    options.signal?.removeEventListener('abort', onAbort);
    for (const [type, listener] of [
      ['open', onOpen],
      ['message', onMessage],
      ['error', onError],
      ['close', onClose],
    ] as const)
      socket.removeEventListener(type, listener);
    socket.close();
  };
  try {
    session = new PortableVoiceSession(
      options.control,
      {
        async send(frame) {
          await opened;
          socket.send(frame);
        },
        close: cleanup,
      },
      options.agent,
    );
    socket.addEventListener('open', onOpen);
    socket.addEventListener('message', onMessage);
    socket.addEventListener('error', onError);
    socket.addEventListener('close', onClose);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    options.signal?.throwIfAborted();
    if (socket.readyState === 1) onOpen();
    await opened;
    await session.start();
    return session;
  } catch (error) {
    try {
      if (session) await session.close();
      else cleanup();
    } catch {
      /* Preserve the connection failure. */
    }
    throw error;
  }
}
