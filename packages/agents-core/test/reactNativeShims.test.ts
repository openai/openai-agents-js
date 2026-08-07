import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  ReactNativeEventEmitter,
  timer,
} from '../src/shims/shims-react-native';

type TestEvents = {
  message: [value: string];
};

describe('React Native shims', () => {
  it('adds an explicit condition without changing the default shim', () => {
    const corePackage = readPackageJson(
      new URL('../package.json', import.meta.url),
    );
    const realtimePackage = readPackageJson(
      new URL('../../agents-realtime/package.json', import.meta.url),
    );

    expect(corePackage.exports['./_shims']['react-native'].import).toBe(
      './dist/shims/shims-react-native.mjs',
    );
    expect(corePackage.exports['./_shims'].import).toBe(
      './dist/shims/shims.mjs',
    );
    expect(realtimePackage.exports['./_shims']['react-native'].import).toBe(
      './dist/shims/shims-react-native.mjs',
    );
    expect(realtimePackage.exports['./_shims'].import).toBe(
      './dist/shims/shims.mjs',
    );
  });

  it('emits events without DOM event globals', () => {
    const emitter = new ReactNativeEventEmitter<TestEvents>();
    const listener = vi.fn();

    emitter.on('message', listener);
    emitter.on('message', listener);
    emitter.emit('message', 'hello');

    expect(listener).toHaveBeenCalledTimes(2);
    expect(listener).toHaveBeenLastCalledWith('hello');

    emitter.off('message', listener);
    emitter.emit('message', 'ignored');
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('removes once listeners before invoking them', () => {
    const emitter = new ReactNativeEventEmitter<TestEvents>();
    const listener = vi.fn(() => emitter.emit('message', 'nested'));

    emitter.once('message', listener);
    emitter.emit('message', 'first');

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith('first');
  });

  it('uses global timers without requiring window', () => {
    vi.useFakeTimers();
    const listener = vi.fn();

    const timeout = timer.setTimeout(listener, 10);
    vi.advanceTimersByTime(10);

    expect(listener).toHaveBeenCalledOnce();
    timer.clearTimeout(timeout);
    vi.useRealTimers();
  });
});

function readPackageJson(url: URL): {
  exports: Record<
    string,
    { import: string; 'react-native': { import: string } }
  >;
} {
  return JSON.parse(readFileSync(url, 'utf8'));
}
