import { describe, expect, test } from 'vitest';

import { BrowserEventEmitter } from '../../src/shims/shims-browser';

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
});
