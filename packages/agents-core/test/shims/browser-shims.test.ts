import { describe, expect, test, vi } from 'vitest';

import { BrowserEventEmitter, randomUUID } from '../../src/shims/shims-browser';

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
