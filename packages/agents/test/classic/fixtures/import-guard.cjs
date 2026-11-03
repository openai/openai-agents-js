/* global require */
/* oxlint-disable typescript/no-require-imports -- This fixture verifies CommonJS loading. */
const { registerHooks, syncBuiltinESMExports } = require('node:module');
const childProcess = require('node:child_process');

globalThis.classicPackageObservation = { resolved: [], processCalls: [] };
for (const name of [
  'spawn',
  'spawnSync',
  'exec',
  'execSync',
  'execFile',
  'execFileSync',
  'fork',
]) {
  childProcess[name] = (...args) => {
    globalThis.classicPackageObservation.processCalls.push({
      name,
      command: args[0],
    });
    throw new Error(
      'An import or offline classic call attempted to start a process.',
    );
  };
}
syncBuiltinESMExports();
registerHooks({
  resolve(specifier, context, nextResolve) {
    const result = nextResolve(specifier, context);
    globalThis.classicPackageObservation.resolved.push(result.url);
    if (
      result.url.includes('/native/') ||
      result.url.endsWith('.node') ||
      result.url.includes('codex-sdk-runtime')
    ) {
      throw new Error(
        'Offline import reached a native dependency: ' + result.url,
      );
    }
    return result;
  },
});
