import { useLocalStorage } from '../../../../../examples/codex/local-storage';
import type { NativeProviderOptions } from '../../../src';

const input = JSON.parse(process.argv[2]!) as {
  path: string;
  resume?: string;
  options: NativeProviderOptions;
};

async function main() {
  try {
    const result = await useLocalStorage(
      input.path,
      input.resume,
      input.options,
    );
    process.send?.({ type: 'result', pid: process.pid, ...result });
  } catch (error) {
    process.send?.({ type: 'failure', message: String(error) });
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
}

void main();
