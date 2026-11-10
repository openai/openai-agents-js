import koffi from 'koffi';
import { setImmediate } from 'node:timers';

// Koffi limits running and queued calls together. Leave room for other users
// of the shared native module without changing its process-wide configuration.
const nativeCallLimit = Math.max(
  1,
  Math.floor((koffi.config().max_async_calls ?? 256) / 2),
);
let activeCalls = 0;
const waitingCalls: (() => void)[] = [];

function releaseNativeSlot() {
  activeCalls--;
  waitingCalls.shift()?.();
}

/** Execute blocking native I/O in Koffi's worker, retaining its output arguments. */
export function callLocalSourceNative<T>(
  fn: { async(...args: unknown[]): void },
  args: unknown[],
): Promise<{ value: T; errno: number }> {
  return new Promise((resolve, reject) => {
    const job = { fn, args, resolve, reject };
    const start = () => {
      activeCalls++;
      let settled = false;
      const complete = () => {
        if (settled) return;
        settled = true;
        // Wait for Koffi's callback and native queue accounting to unwind.
        setImmediate(releaseNativeSlot);
      };
      try {
        job.fn.async(...job.args, (error: Error | null, value: T) => {
          // Koffi restores the worker's errno only for this callback. Windows
          // calls use returned NTSTATUS instead of thread-local GetLastError.
          const errno = koffi.errno();
          complete();
          if (error) job.reject(error);
          else job.resolve({ value, errno });
        });
      } catch (error) {
        complete();
        job.reject(error);
      }
    };
    if (activeCalls < nativeCallLimit) start();
    else waitingCalls.push(start);
  });
}
