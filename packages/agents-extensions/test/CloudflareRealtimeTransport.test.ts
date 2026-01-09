import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CloudflareRealtimeTransportLayer } from '../src/CloudflareRealtimeTransport';

class FakeWorkersWebSocket {
  url: string;
  listeners: Record<string, ((ev: any) => void)[]> = {};
  accepted = false;
  constructor(url: string) {
    this.url = url;
  }
  addEventListener(type: string, listener: (ev: any) => void) {
    this.listeners[type] = this.listeners[type] || [];
    this.listeners[type].push(listener);
  }
  accept() {
    this.accepted = true;
  }
  send(_data: any) {}
  close() {
    this.emit('close', {});
  }
  emit(type: string, ev: any) {
    (this.listeners[type] || []).forEach((fn) => fn(ev));
  }
}

describe('CloudflareRealtimeTransportLayer', () => {
  let savedFetch: any;

  beforeEach(() => {
    savedFetch = (globalThis as any).fetch;
  });

  afterEach(() => {
    (globalThis as any).fetch = savedFetch;
  });

  it('connects via fetch upgrade and emits connection changes', async () => {
    const fakeSocket = new FakeWorkersWebSocket('ws://example');
    const fetchSpy = vi.fn().mockResolvedValue({
      webSocket: fakeSocket,
      status: 101,
      text: vi.fn().mockResolvedValue(''),
    });
    (globalThis as any).fetch = fetchSpy;

    const transport = new CloudflareRealtimeTransportLayer({
      url: 'wss://api.openai.com/v1/realtime?model=foo',
    });

    const statuses: string[] = [];
    transport.on('connection_change', (s) => statuses.push(s));

    await transport.connect({ apiKey: 'ek_test', model: 'foo' });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // wss -> https
    expect(fetchSpy.mock.calls[0][0]).toBe(
      'https://api.openai.com/v1/realtime?model=foo',
    );
    const init = fetchSpy.mock.calls[0][1];
    expect(init.method).toBe('GET');
    expect(init.headers['Authorization']).toBe('Bearer ek_test');
    expect(init.headers['Upgrade']).toBe('websocket');
    expect(init.headers['Connection']).toBe('Upgrade');
    expect(init.headers['Sec-WebSocket-Protocol']).toBe('realtime');

    // connected without relying on 'open' listener.
    expect(statuses).toEqual(['connecting', 'connected']);
  });

  it('propagates fetch-upgrade failures with detailed error', async () => {
    const fetchSpy = vi.fn().mockResolvedValue({
      status: 400,
      text: vi.fn().mockResolvedValue('No upgrade'),
    });
    (globalThis as any).fetch = fetchSpy;

    const transport = new CloudflareRealtimeTransportLayer({
      url: 'wss://api.openai.com/v1/realtime?model=bar',
    });

    await expect(
      transport.connect({ apiKey: 'ek_x', model: 'bar' }),
    ).rejects.toThrow('Failed to upgrade websocket: 400 No upgrade');
  });

  it('attaches headers and surfaces accept errors', async () => {
    const fakeSocket = new FakeWorkersWebSocket('ws://example');
    const acceptError = new Error('accept failed');
    fakeSocket.accept = vi.fn(() => {
      throw acceptError;
    });
    const fetchSpy = vi.fn().mockResolvedValue({
      webSocket: fakeSocket,
      status: 101,
      text: vi.fn().mockResolvedValue(''),
    });
    (globalThis as any).fetch = fetchSpy;

    const transport = new CloudflareRealtimeTransportLayer({
      url: 'wss://api.openai.com/v1/realtime?model=foo',
    });

    await expect(
      transport.connect({ apiKey: 'ek_hdr', model: 'foo' }),
    ).rejects.toThrow('accept failed');

    const init = fetchSpy.mock.calls[0][1];
    expect(init.headers['User-Agent']).toBeDefined();
    expect(init.headers['Sec-WebSocket-Protocol']).toBe('realtime');
  });
});
