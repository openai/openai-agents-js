import { EventEmitter } from 'node:events';
import { afterEach, expect, test, vi } from 'vitest';
import {
  createPtyProcessEntry,
  openPtyWebSocket,
  PtyProcessRegistry,
  writePtyStdin,
} from '../../src/sandbox/shared/pty';

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
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  StartupWebSocket.instances = [];
});

test('allocates numeric PTY IDs while rejecting biased samples and collisions', () => {
  const samples = [0xffff_ffff, 0, 0, 98_999];
  const random = vi
    .spyOn(globalThis.crypto, 'getRandomValues')
    .mockImplementation((array) => {
      const sample = samples.shift();
      if (!(array instanceof Uint32Array) || sample === undefined) {
        throw new Error('Unexpected randomness request');
      }
      array[0] = sample;
      return array;
    });
  const registry = new PtyProcessRegistry();
  const first = createPtyProcessEntry({});
  const second = createPtyProcessEntry({});

  expect(registry.register(first).sessionId).toBe(1_000);
  expect(registry.register(second).sessionId).toBe(99_999);
  expect(registry.get(1_000)).toBe(first);
  expect(registry.get(99_999)).toBe(second);
  expect(random).toHaveBeenCalledTimes(4);
});

test('keeps PTY output scoped to its registry even when IDs match', async () => {
  vi.spyOn(globalThis.crypto, 'getRandomValues').mockImplementation((array) => {
    if (array instanceof Uint32Array) array[0] = 0;
    return array;
  });
  const first = new PtyProcessRegistry();
  const second = new PtyProcessRegistry();
  for (const [registry, output] of [
    [first, 'first sandbox'],
    [second, 'second sandbox'],
  ] as const) {
    registry.register({
      ...createPtyProcessEntry({}),
      output,
      outputClosed: true,
      exitCode: 0,
    });
  }

  const output = await writePtyStdin({
    providerName: 'Test',
    registry: second,
    sessionId: 1_000,
  });
  expect(output).toContain('second sandbox');
  expect(output).not.toContain('first sandbox');
  expect(first.get(1_000)?.output).toBe('first sandbox');
});

test('preserves a full PTY registry if randomness fails', () => {
  let sample = 0;
  const random = vi
    .spyOn(globalThis.crypto, 'getRandomValues')
    .mockImplementation((array) => {
      if (array instanceof Uint32Array) array[0] = sample++;
      return array;
    });
  const registry = new PtyProcessRegistry();
  const entries = Array.from({ length: 64 }, () => {
    const entry = createPtyProcessEntry({});
    return { entry, ...registry.register(entry) };
  });
  const failure = new Error('Randomness unavailable');
  random.mockImplementation(() => {
    throw failure;
  });

  expect(() => registry.register(createPtyProcessEntry({}))).toThrow(failure);
  for (const { sessionId, entry } of entries) {
    expect(registry.get(sessionId)).toBe(entry);
  }
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
