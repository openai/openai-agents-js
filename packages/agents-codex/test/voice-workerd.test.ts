import { afterEach, describe, expect, it, vi } from 'vitest';
import { openVoiceWebSocket } from '@openai/agents/voice/workerd';

function upgradedSocket() {
  return Object.assign(new EventTarget(), { accept: vi.fn(), close: vi.fn() });
}

describe('workerd native voice relay socket', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('forwards app authentication through fetch Upgrade and accepts once', async () => {
    const socket = upgradedSocket();
    const fetchMock = vi.fn(async () => ({ status: 101, webSocket: socket }));
    vi.stubGlobal('fetch', fetchMock);
    const controller = new AbortController();
    const result = await openVoiceWebSocket({
      url: 'wss://voice.example/relay',
      headers: {
        Authorization: 'Bearer synthetic-app-token',
        'X-App-Session': 'session',
      },
      signal: controller.signal,
    });
    expect(result).toBe(socket);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [
      URL,
      RequestInit,
    ];
    expect(url.href).toBe('https://voice.example/relay');
    expect(init.method).toBe('GET');
    expect(init.redirect).toBe('manual');
    expect(init.signal).toBe(controller.signal);
    const headers = new Headers(init.headers);
    expect(headers.get('Authorization')).toBe('Bearer synthetic-app-token');
    expect(headers.get('X-App-Session')).toBe('session');
    expect(headers.get('Upgrade')).toBe('websocket');
    expect(socket.accept).toHaveBeenCalledOnce();
    controller.abort();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('reports a missing upgraded socket without retaining the response body', async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }), {
      status: 403,
    });
    const body = vi.spyOn(response, 'text');
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response),
    );
    await expect(
      openVoiceWebSocket({ url: 'ws://voice.example/relay' }),
    ).rejects.toThrow('upgrade failed (403)');
    expect(body).not.toHaveBeenCalled();
    expect(cancelled).toHaveBeenCalledOnce();
  });

  it('closes a socket returned after cancellation without accepting it', async () => {
    const socket = upgradedSocket();
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        controller.abort(new Error('cancelled'));
        return { status: 101, webSocket: socket };
      }),
    );
    await expect(
      openVoiceWebSocket({
        url: 'wss://voice.example/relay',
        signal: controller.signal,
      }),
    ).rejects.toThrow('cancelled');
    expect(socket.accept).not.toHaveBeenCalled();
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it('removes abort ownership when the accepted socket closes', async () => {
    const socket = upgradedSocket();
    const controller = new AbortController();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({ status: 101, webSocket: socket })),
    );
    await openVoiceWebSocket({
      url: 'wss://voice.example/relay',
      signal: controller.signal,
    });
    socket.dispatchEvent(new Event('close'));
    controller.abort();
    expect(socket.close).not.toHaveBeenCalled();
  });
});
