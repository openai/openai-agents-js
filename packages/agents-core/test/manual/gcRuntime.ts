import v8 from 'node:v8';
import vm from 'node:vm';

let cachedGc: (() => void) | undefined;

export function getExposedGc(): () => void {
  if (cachedGc) {
    return cachedGc;
  }

  const maybeGc = (globalThis as { gc?: () => void }).gc;
  if (typeof maybeGc === 'function') {
    cachedGc = maybeGc;
    return maybeGc;
  }

  // Test workers are not always launched with --expose-gc, so enable it lazily.
  v8.setFlagsFromString('--expose_gc');
  const exposedGc = vm.runInNewContext('gc');
  if (typeof exposedGc !== 'function') {
    throw new Error('global.gc is not available. Run with --expose-gc.');
  }

  cachedGc = exposedGc;
  return exposedGc;
}
