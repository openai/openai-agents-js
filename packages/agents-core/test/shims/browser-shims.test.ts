import { describe, expect, test, vi } from 'vitest';

import {
  AsyncLocalStorage,
  BrowserEventEmitter,
  randomUUID,
} from '../../src/shims/shims-browser';

describe('BrowserEventEmitter', () => {
  test('off removes previously registered listener', () => {
    const emitter = new BrowserEventEmitter<{ foo: [string] }>();
    const calls: string[] = [];

    const handler = (value: string) => {
      calls.push(value);
    };

    emitter.on('foo', handler);
    emitter.emit('foo', 'first');
    emitter.off('foo', handler);
    emitter.emit('foo', 'second');

    expect(calls).toEqual(['first']);
  });

  test('once triggers listener only once', () => {
    const emitter = new BrowserEventEmitter<{ foo: [string] }>();
    let callCount = 0;

    emitter.once('foo', () => {
      callCount += 1;
    });

    emitter.emit('foo', 'first');
    emitter.emit('foo', 'second');

    expect(callCount).toBe(1);
  });

  test('multiple identical listeners fire for each registration and are removed by off', () => {
    const emitter = new BrowserEventEmitter<{ foo: [string] }>();
    const calls: string[] = [];

    const handler = (value: string) => {
      calls.push(value);
    };

    emitter.on('foo', handler);
    emitter.on('foo', handler);

    emitter.emit('foo', 'first');
    expect(calls).toEqual(['first', 'first']);

    emitter.off('foo', handler);
    emitter.emit('foo', 'second');

    expect(calls).toEqual(['first', 'first']);
  });
});

describe('randomUUID', () => {
  test('uses native crypto.randomUUID when available', () => {
    const mockUUID = '12345678-1234-1234-1234-123456789abc';
    const originalCrypto = global.crypto;

    Object.defineProperty(global, 'crypto', {
      value: { randomUUID: vi.fn(() => mockUUID) },
      configurable: true,
    });

    const result = randomUUID();
    expect(result).toBe(mockUUID);
    expect(global.crypto.randomUUID).toHaveBeenCalled();

    Object.defineProperty(global, 'crypto', {
      value: originalCrypto,
      configurable: true,
    });
  });

  test('uses fallback when crypto.randomUUID is unavailable', () => {
    const originalCrypto = global.crypto;

    Object.defineProperty(global, 'crypto', {
      value: undefined,
      configurable: true,
    });

    const result = randomUUID();
    expect(result).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );

    Object.defineProperty(global, 'crypto', {
      value: originalCrypto,
      configurable: true,
    });
  });

  test('fallback generates valid UUID v4 format', () => {
    const originalCrypto = global.crypto;

    Object.defineProperty(global, 'crypto', {
      value: undefined,
      configurable: true,
    });

    const uuids = Array.from({ length: 10 }, () => randomUUID());

    uuids.forEach((uuid) => {
      expect(uuid).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
    });

    const uniqueUUIDs = new Set(uuids);
    expect(uniqueUUIDs.size).toBe(uuids.length);

    Object.defineProperty(global, 'crypto', {
      value: originalCrypto,
      configurable: true,
    });
  });
});

describe('AsyncLocalStorage browser shim', () => {
  test('restores the previous context after a synchronous run', () => {
    const storage = new AsyncLocalStorage<string>();

    storage.enterWith('outer');
    const result = storage.run('inner', () => {
      expect(storage.getStore()).toBe('inner');
      return 'done';
    });

    expect(result).toBe('done');
    expect(storage.getStore()).toBe('outer');
  });

  test('restores the previous context after an asynchronous run settles', async () => {
    const storage = new AsyncLocalStorage<string>();

    storage.enterWith('outer');
    const result = await storage.run('inner', async () => {
      expect(storage.getStore()).toBe('inner');
      await Promise.resolve();
      expect(storage.getStore()).toBe('inner');
      return 'done';
    });

    expect(result).toBe('done');
    expect(storage.getStore()).toBe('outer');
  });

  test('keeps the active context when overlapping runs settle out of order', async () => {
    const storage = new AsyncLocalStorage<string>();
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;

    const first = storage.run(
      'first',
      () => new Promise<void>((resolve) => (resolveFirst = resolve)),
    );
    const second = storage.run(
      'second',
      () => new Promise<void>((resolve) => (resolveSecond = resolve)),
    );

    expect(storage.getStore()).toBe('second');

    resolveFirst();
    await first;
    expect(storage.getStore()).toBe('second');

    resolveSecond();
    await second;
    expect(storage.getStore()).toBeUndefined();
  });

  test('keeps context until a streamed result loop settles', async () => {
    const storage = new AsyncLocalStorage<string>();
    let resolveStream!: () => void;
    const streamLoopPromise = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });
    const streamedResult = {
      _getStreamLoopPromise: () => streamLoopPromise,
    };

    storage.enterWith('outer');
    const result = await storage.run('inner', async () => streamedResult);

    expect(result).toBe(streamedResult);
    expect(storage.getStore()).toBe('inner');

    resolveStream();
    await streamLoopPromise;
    await Promise.resolve();

    expect(storage.getStore()).toBe('outer');
  });
});
