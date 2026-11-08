import { expect, it, vi } from 'vitest';
import {
  NativeRealtimeAdapterDriver,
  type NativeRealtimeAdapterHandle,
  type NativeRealtimeConnection,
} from '../src/runtime/realtime-adapter';

class Queue<T> {
  private values: T[] = [];
  private waiting?: (value: IteratorResult<T>) => void;
  private done = false;
  push(value: T) {
    if (this.waiting) {
      const waiting = this.waiting;
      this.waiting = undefined;
      waiting({ value, done: false });
    } else this.values.push(value);
  }
  next(): Promise<IteratorResult<T>> {
    if (this.values.length)
      return Promise.resolve({ value: this.values.shift()!, done: false });
    if (this.done) return Promise.resolve({ value: undefined, done: true });
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
  async return(): Promise<IteratorResult<T>> {
    this.done = true;
    this.waiting?.({ value: undefined, done: true });
    this.waiting = undefined;
    return { value: undefined, done: true };
  }
  [Symbol.asyncIterator]() {
    return this;
  }
}

type Request = NonNullable<
  Awaited<ReturnType<NativeRealtimeAdapterHandle['next']>>
>;
class Handle implements NativeRealtimeAdapterHandle {
  readonly incoming: string[] = [];
  readonly events: unknown[] = [];
  readonly end = vi.fn();
  private readonly requests = new Queue<Request>();
  private finished = false;
  async next() {
    return (await this.requests.next()).value ?? null;
  }
  async receive(frame: string) {
    this.incoming.push(frame);
  }
  finish() {
    this.finished = true;
    void this.requests.return();
  }
  request(event: unknown): Promise<boolean> {
    this.events.push(event);
    const result = Promise.withResolvers<boolean>();
    let replied = false;
    this.requests.push({
      event_json: JSON.stringify(event),
      complete: (success) => {
        if (replied) return false;
        replied = true;
        result.resolve(success && !this.finished);
        return !this.finished;
      },
    });
    return result.promise;
  }
}
const invoke = async <T>(callback: () => T | Promise<T>): Promise<T> =>
  callback();

const connect = {
  type: 'connect',
  url: 'wss://example.invalid/realtime',
  headers: { Authorization: 'synthetic-only' },
  model: 'fixture',
};
function connection() {
  const incoming = new Queue<string>();
  const close = vi.fn(async () => {
    await incoming.return();
  });
  return { incoming, send: vi.fn(async (_frame: string) => {}), close };
}

it('keeps cancellation and close available during a pending physical send', async () => {
  const handle = new Handle();
  const io = connection();
  const sending = Promise.withResolvers<void>();
  io.send.mockImplementation(() => sending.promise);
  io.close.mockImplementation(async () => {
    sending.resolve();
    await io.incoming.return();
  });
  let signal: AbortSignal | undefined;
  const driver = new NativeRealtimeAdapterDriver(
    {
      connect: async (context) => {
        signal = context.signal;
        return io;
      },
    },
    handle,
    invoke,
  );
  expect(await handle.request(connect)).toBe(true);
  const sent = handle.request({
    type: 'send',
    frame: '{"type":"session.update"}',
  });
  await vi.waitFor(() => expect(io.send).toHaveBeenCalledOnce());
  expect(await handle.request({ type: 'cancel' })).toBe(true);
  expect(signal?.aborted).toBe(true);
  expect(await handle.request({ type: 'close' })).toBe(true);
  expect(await sent).toBe(false);
  await driver.finish();
  expect(io.close).toHaveBeenCalledOnce();
});

it('joins a late successful factory and closes its connection before finishing', async () => {
  const handle = new Handle();
  const pending = Promise.withResolvers<NativeRealtimeConnection>();
  const io = connection();
  const factory = vi.fn(() => pending.promise);
  const driver = new NativeRealtimeAdapterDriver(
    { connect: factory },
    handle,
    invoke,
  );
  const connected = handle.request(connect);
  await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
  let finished = false;
  const finishing = driver.finish().then(() => {
    finished = true;
  });
  await Promise.resolve();
  expect(finished).toBe(false);
  pending.resolve(io);
  await finishing;
  expect(await connected).toBe(false);
  expect(io.close).toHaveBeenCalledOnce();
  expect(io.send).not.toHaveBeenCalled();
});

it('retains failed cleanup for the next serialized native close attempt', async () => {
  const handle = new Handle();
  const io = connection();
  const failure = new Error('private close failure');
  io.close.mockRejectedValueOnce(failure);
  const driver = new NativeRealtimeAdapterDriver(
    { connect: async () => io },
    handle,
    invoke,
  );
  expect(await handle.request(connect)).toBe(true);
  expect(await handle.request({ type: 'close' })).toBe(false);
  expect(driver.cleanupFailure?.error).toBe(failure);
  expect(await handle.request({ type: 'close' })).toBe(true);
  expect(driver.cleanupFailure).toBeUndefined();
  await driver.finish();
  expect(io.close).toHaveBeenCalledTimes(2);
});

it('retries local cleanup after native retirement without losing the late connection', async () => {
  const handle = new Handle();
  const io = connection();
  io.close.mockRejectedValueOnce(new Error('late connection close failed'));
  const driver = new NativeRealtimeAdapterDriver(
    { connect: async () => io },
    handle,
    invoke,
  );
  expect(await handle.request(connect)).toBe(true);
  await expect(driver.finish()).rejects.toThrow('late connection close failed');
  await driver.finish();
  expect(io.close).toHaveBeenCalledTimes(2);
});

it('retains a factory exception locally and sends only failure status to native', async () => {
  const handle = new Handle();
  const failure = new Error('private application exception');
  const driver = new NativeRealtimeAdapterDriver(
    {
      connect: async () => {
        throw failure;
      },
    },
    handle,
    invoke,
  );
  expect(await handle.request(connect)).toBe(false);
  expect(driver.failure?.error).toBe(failure);
  expect(JSON.stringify(handle.events)).not.toContain(failure.message);
  await driver.finish();
});

it.each([42, 'x'.repeat(8 * 1024 * 1024 + 1)])(
  'rejects invalid or oversized incoming frames before native admission',
  async (frame) => {
    const handle = new Handle();
    const io = connection();
    const driver = new NativeRealtimeAdapterDriver(
      { connect: async () => io },
      handle,
      invoke,
    );
    expect(await handle.request(connect)).toBe(true);
    io.incoming.push(frame as string);
    await vi.waitFor(() => expect(handle.end).toHaveBeenCalledWith(false));
    expect(handle.incoming).toEqual([]);
    expect(driver.failure?.error).toBeInstanceOf(Error);
    expect(await handle.request({ type: 'close' })).toBe(true);
    await driver.finish();
  },
);
