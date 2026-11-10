import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as facade from '@openai/agents';
import * as owner from '@openai/agents-codex';

const require = createRequire(import.meta.url);
const modules = {
  'ESM facade': facade,
  'CommonJS facade': require('@openai/agents'),
  'ESM owner': owner,
  'CommonJS owner': require('@openai/agents-codex'),
};

test('installed v1 entrypoints share classes without loading the native addon', () => {
  for (const sdk of Object.values(modules)) {
    for (const name of [
      'NativeRuntime',
      'NativeProvider',
      'Agent',
      'Environment',
    ]) {
      assert.equal(sdk[name], owner[name], name);
    }
  }
  assert.equal(
    Object.keys(require.cache).some((file) =>
      /[/\\]agents-codex[/\\]native[/\\](?:index\.js|codex\.node)$/.test(file),
    ),
    false,
  );
});

for (const [producerName, producer] of Object.entries(modules)) {
  for (const [consumerName, consumer] of Object.entries(modules)) {
    test(`${producerName} objects compose with ${consumerName} and close cleanly`, async () => {
      const runtime = new producer.NativeRuntime();
      const provider = new consumer.NativeProvider({
        runtime,
        apiKey: 'synthetic',
      });
      try {
        const target = new producer.Agent({
          instructions: 'Handle the handoff.',
        });
        const coordinator = new consumer.Agent({
          instructions: 'Delegate to the target.',
          handoffs: [target],
        });
        assert.equal(coordinator.handoffs[0], target);

        const environment = producer.Environment.local({ cwd: process.cwd() });
        let disposals = 0;
        const lease = consumer.Environment.lease(environment, () => {
          disposals++;
        });
        assert.equal(lease.environment, environment);
        await lease.close();
        await lease.close();
        assert.equal(disposals, 1);
      } finally {
        await provider.close();
        await runtime.close();
      }
      await runtime.close();
      assert.throws(
        () => new consumer.NativeProvider({ runtime, apiKey: 'synthetic' }),
        /closed or closing/,
      );
    });
  }
}

// Node disables module-sync alongside require(esm); preserve the ESM fallback.
test('ESM imports work when require(esm) is disabled', () => {
  execFileSync(
    process.execPath,
    [
      '--no-experimental-require-module',
      '--input-type=module',
      '-e',
      `import assert from 'node:assert/strict';
       import * as facade from '@openai/agents';
       import * as owner from '@openai/agents-codex';
       assert.match(import.meta.resolve('@openai/agents-codex'), /\\.mjs$/);
       assert.equal(facade.NativeRuntime, owner.NativeRuntime);
       const runtime = new owner.NativeRuntime();
       const provider = new facade.NativeProvider({ runtime, apiKey: 'synthetic' });
       const agent = new facade.Agent({
         instructions: 'Delegate.',
         handoffs: [new owner.Agent({ instructions: 'Handle the handoff.' })],
       });
       assert.equal(agent.handoffs.length, 1);
       const lease = facade.Environment.lease(
         owner.Environment.local({ cwd: process.cwd() }), () => {},
       );
       await lease.close();
       await provider.close();
       await runtime.close();`,
    ],
    { cwd: fileURLToPath(new URL('.', import.meta.url)), stdio: 'pipe' },
  );
});
