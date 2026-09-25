import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import { openPtyWebSocket } from '../../src/sandbox/shared/pty';

// This transport controls error/close ordering, including Node ws cleanup errors.
class StartupWebSocket extends EventEmitter {
  static instances: StartupWebSocket[] = [];
  readyState = 0;
  binaryType = '';
  send = vi.fn();
  close = vi.fn(() => {
    this.readyState = 2;
  });

  constructor(_url: string) {
    super();
    StartupWebSocket.instances.push(this);
  }

  finishClose() {
    this.readyState = 3;
    this.emit('close');
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  StartupWebSocket.instances = [];
});

test.each(['configure', 'error', 'close', 'timeout'] as const)(
  'settles socket cleanup before reporting startup %s',
  async (mode) => {
    vi.stubGlobal('WebSocket', StartupWebSocket);
    const original = new Error('configuration failed');
    let settled = false;
    const result = openPtyWebSocket({
      url: 'wss://pty.example.test',
      providerName: 'Test',
      timeoutMs: mode === 'timeout' ? 100 : 30_000,
      configure:
        mode === 'configure'
          ? async () => {
              throw original;
            }
          : undefined,
    }).catch((error) => {
      settled = true;
      return error;
    });
    await vi.waitFor(() => expect(StartupWebSocket.instances).toHaveLength(1));
    const socket = StartupWebSocket.instances[0]!;
    if (mode === 'error' || mode === 'close') {
      await vi.waitFor(() => expect(socket.listenerCount('open')).toBe(1));
    }
    if (mode === 'error') socket.emit('error', new Error('open failed'));
    if (mode === 'close') socket.finishClose();
    if (mode !== 'close') {
      await vi.waitFor(() => expect(socket.close).toHaveBeenCalledOnce());
      expect(settled).toBe(false);
      // Closing a connecting Node ws socket emits error before close.
      socket.emit('error', new Error('closed before connection established'));
      expect(settled).toBe(false);
      socket.finishClose();
    }
    const error = await result;
    if (mode === 'configure') expect(error).toBe(original);
    else
      expect(error.message).toContain(
        {
          error: 'failed to connect',
          close: 'closed before opening',
          timeout: 'connection timed out',
        }[mode],
      );
    expect(socket.eventNames()).toEqual([]);
  },
);

test('preserves configuration failure if closing throws', async () => {
  vi.stubGlobal('WebSocket', StartupWebSocket);
  const original = new Error('configuration failed');
  await expect(
    openPtyWebSocket({
      url: 'wss://pty.example.test',
      providerName: 'Test',
      configure: () => {
        StartupWebSocket.instances[0]!.close.mockImplementation(() => {
          throw new Error('close failed');
        });
        throw original;
      },
    }),
  ).rejects.toBe(original);
  expect(StartupWebSocket.instances[0]!.eventNames()).toEqual([]);
});

test('leaves a successfully opened socket owned by its caller', async () => {
  vi.stubGlobal('WebSocket', StartupWebSocket);
  const pending = openPtyWebSocket({
    url: 'wss://pty.example.test',
    providerName: 'Test',
  });
  await vi.waitFor(() => expect(StartupWebSocket.instances).toHaveLength(1));
  const socket = StartupWebSocket.instances[0]!;
  socket.readyState = 1;
  socket.emit('open');
  expect(await pending).toBe(socket);
  expect(socket.close).not.toHaveBeenCalled();
  expect(socket.eventNames()).toEqual([]);
});

test.each(['close', 'throw'] as const)(
  'clears the cleanup deadline when cleanup completes through %s',
  async (mode) => {
    vi.useFakeTimers();
    vi.stubGlobal('WebSocket', StartupWebSocket);
    const original = new Error('configuration failed');
    const result = openPtyWebSocket({
      url: 'wss://pty.example.test',
      providerName: 'Test',
      configure: () => {
        const socket = StartupWebSocket.instances[0]!;
        socket.close.mockImplementation(() => {
          if (mode === 'throw') throw new Error('close failed');
          socket.finishClose();
        });
        throw original;
      },
    }).catch((error) => error);
    expect(await result).toBe(original);
    expect(vi.getTimerCount()).toBe(0);
    expect(StartupWebSocket.instances[0]!.eventNames()).toEqual([]);
  },
);
