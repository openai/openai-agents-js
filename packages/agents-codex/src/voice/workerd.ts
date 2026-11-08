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
    redirect: 'error',
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
