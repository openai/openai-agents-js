import koffi from 'koffi';
import { expect, test } from 'vitest';
import { callLocalSourceNative } from '../../src/sandbox/shared/localSourceNativeCall';

test('releases every submission slot after synchronous failures', async () => {
  const failure = new Error('submission failed');
  const fn = {
    async() {
      throw failure;
    },
  };
  const results = await Promise.allSettled(
    Array.from({ length: 600 }, () => callLocalSourceNative(fn, [])),
  );
  expect(results).toEqual(
    Array.from({ length: 600 }, () => ({
      status: 'rejected',
      reason: failure,
    })),
  );
});

test('keeps timers responsive while a real native call is blocked', async () => {
  const windows = process.platform === 'win32';
  const library = koffi.load(
    windows
      ? 'kernel32.dll'
      : process.platform === 'darwin'
        ? '/usr/lib/libSystem.B.dylib'
        : null,
  );
  const delay = library.func(
    windows
      ? 'void __stdcall Sleep(uint32_t milliseconds)'
      : 'int usleep(unsigned int microseconds)',
  );
  let completed = false;
  const work = callLocalSourceNative(delay, [windows ? 500 : 500_000]).then(
    () => {
      completed = true;
    },
  );
  await new Promise((resolve) => setTimeout(resolve, 50));
  const completedBeforeTimer = completed;
  await work;
  expect(completedBeforeTimer).toBe(false);
});

test.skipIf(process.platform === 'win32')(
  'captures errno from the native worker before other calls',
  async () => {
    const library = koffi.load(
      process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : null,
    );
    const close = library.func('int close(int fd)');
    const result = await callLocalSourceNative<number>(close, [-1]);
    expect(result).toEqual({ value: -1, errno: koffi.os.errno.EBADF });
  },
);
