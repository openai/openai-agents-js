import {
  NativeVoiceControl,
  PortableVoiceSession,
  type PortableVoiceOptions,
} from './portable';

export interface VoiceWebSocketOptions {
  /** Application-hosted native voice relay, using ws or wss. */
  url: string;
  /** Application authentication headers; no provider credentials are required. */
  headers?: HeadersInit;
  signal?: AbortSignal;
}

/** Open and accept a workerd relay socket without loading the native runtime. */
export async function openVoiceWebSocket({
  url,
  headers,
  signal,
}: VoiceWebSocketOptions): Promise<WebSocket> {
  signal?.throwIfAborted();
  const endpoint = new URL(url);
  if (endpoint.protocol !== 'ws:' && endpoint.protocol !== 'wss:')
    throw new TypeError('Voice relay URL must use ws or wss.');
  endpoint.protocol = endpoint.protocol === 'ws:' ? 'http:' : 'https:';
  const requestHeaders = new Headers(headers);
  requestHeaders.set('Connection', 'Upgrade');
  requestHeaders.set('Upgrade', 'websocket');
  const response = await fetch(endpoint, {
    method: 'GET',
    headers: requestHeaders,
    signal,
    redirect: 'manual',
  });
  const socket = (
    response as Response & { webSocket?: WebSocket & { accept(): void } }
  ).webSocket;
  if (!socket) {
    try {
      await response.body?.cancel();
    } catch {
      /* Preserve the upgrade status when discarding its response fails. */
    }
    throw new Error(
      `Voice relay WebSocket upgrade failed (${response.status}).`,
    );
  }
  try {
    signal?.throwIfAborted();
    socket.accept();
    signal?.throwIfAborted();
    const abort = () => socket.close();
    const closed = () => signal?.removeEventListener('abort', abort);
    socket.addEventListener('close', closed, { once: true });
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    return socket;
  } catch (error) {
    try {
      socket.close();
    } catch {
      /* Preserve the opening error. */
    }
    throw error;
  }
}

/** Provider-connected Worker control. The Rust module executes inside the Worker. */
export async function connectPortableVoiceWorker(options: {
  control: NativeVoiceControl;
  apiKey: string;
  agent: PortableVoiceOptions;
  url?: string;
  signal?: AbortSignal;
}): Promise<PortableVoiceSession> {
  options.signal?.throwIfAborted();
  const endpoint = new URL(options.url ?? 'https://api.openai.com/v1/realtime');
  if (endpoint.protocol !== 'https:')
    throw new TypeError('Provider WebSocket URL must use https.');
  endpoint.searchParams.set('model', options.agent.model);
  const response = await fetch(endpoint, {
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      Upgrade: 'websocket',
    },
    signal: options.signal,
    redirect: 'manual',
  });
  const socket = (
    response as Response & { webSocket?: WebSocket & { accept(): void } }
  ).webSocket;
  if (!socket) {
    await response.body?.cancel();
    throw new Error(`Provider WebSocket upgrade failed (${response.status}).`);
  }
  let session: PortableVoiceSession | undefined;
  const abort = () =>
    session?.fail(
      options.signal?.reason ?? new Error('Voice connection aborted.'),
    );
  try {
    session = new PortableVoiceSession(
      options.control,
      {
        send(frame) {
          socket.send(frame);
        },
        close() {
          options.signal?.removeEventListener('abort', abort);
          socket.close();
        },
      },
      options.agent,
    );
    const owner = session;
    socket.addEventListener('message', ({ data }: MessageEvent) => {
      try {
        if (typeof data !== 'string')
          throw new Error('Provider voice frames must be text.');
        owner.receive(JSON.parse(data));
      } catch (error) {
        owner.fail(error);
      }
    });
    socket.addEventListener('error', () =>
      owner.fail(new Error('Provider voice WebSocket failed.')),
    );
    socket.addEventListener('close', () =>
      owner.fail(new Error('Provider voice WebSocket closed.')),
    );
    options.signal?.addEventListener('abort', abort, { once: true });
    options.signal?.throwIfAborted();
    socket.accept();
    await session.start();
    return session;
  } catch (error) {
    try {
      if (session) await session.close();
      else socket.close();
    } catch {
      // Preserve the opening error while releasing the acquired socket.
    }
    throw error;
  }
}
