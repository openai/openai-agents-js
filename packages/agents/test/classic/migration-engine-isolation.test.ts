import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

it('preserves classic and Realtime engines through migration import and refusal', () => {
  const fixture = fileURLToPath(
    new URL('./fixtures/migration-engine-isolation.mjs', import.meta.url),
  );
  const guard = fileURLToPath(
    new URL('./fixtures/import-guard.cjs', import.meta.url),
  );
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([name]) =>
        !/(KEY|SECRET|TOKEN|PASSWORD|CREDENTIALS)$/.test(name) &&
        !['NODE_OPTIONS', 'NODE_PATH'].includes(name),
    ),
  );
  // One process retains its module cache and pre-existing instances throughout.
  const output = execFileSync(process.execPath, ['--require', guard, fixture], {
    env,
    encoding: 'utf8',
    timeout: 20_000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  expect(JSON.parse(output)).toMatchObject({
    fixture: 'migration-engine-isolation',
    completed: true,
    classicModelCalls: 3,
    realtimeCalls: ['connect', 'sendMessage', 'sendAudio', 'close'],
    audioBytes: [4, 5, 6],
    refusedBeforeClassic: true,
    explicitClassicModelCalls: 1,
    processCalls: 0,
  });
}, 25_000);
