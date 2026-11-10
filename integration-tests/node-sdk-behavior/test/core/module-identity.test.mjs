import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import * as facade from '@openai/agents';
import * as owner from '@openai/agents-codex';
import { APIUserAbortError } from 'openai';

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

for (const [format, load] of [
  ['ESM', (specifier) => import(specifier)],
  ['CommonJS', (specifier) => require(specifier)],
]) {
  test(`${format} sandbox authority composes with canonical v1 environment leases`, async () => {
    const sandbox = await load('@openai/agents/sandbox');
    const directSandbox = await load('@openai/agents-core/sandbox');
    assert.equal(sandbox.Manifest, directSandbox.Manifest);
    const manifest = new sandbox.Manifest({ root: '/workspace' });
    assert.equal(
      JSON.parse(sandbox.renderStorageLayout(manifest)).workspace,
      '/workspace',
    );
    assert.throws(
      () => sandbox.renderStorageLayout({ root: '/untrusted' }),
      /trusted Manifest/,
    );
    const events = [];
    const environment = owner.Environment.local({ cwd: process.cwd() });
    const source = sandbox.sandboxEnvironment({
      manifest,
      client: {
        backendId: 'identity-fixture',
        async create(options) {
          assert.ok(options.manifest instanceof sandbox.Manifest);
          events.push('create');
          return {
            state: { manifest: options.manifest },
            async close() {
              events.push('close');
            },
          };
        },
        async delete() {
          events.push('delete');
        },
      },
      async connect() {
        events.push('connect');
        return owner.Environment.lease(environment, () => {
          events.push('gateway');
        });
      },
    });
    const lease = await source({ signal: new AbortController().signal });
    assert.equal(lease.environment, environment);
    await lease.close();
    await lease.close();
    assert.deepEqual(events, [
      'create',
      'connect',
      'gateway',
      'close',
      'delete',
    ]);
  });
}

test('the Hermes factory shares the portable binding across Node module formats', async () => {
  const portable = await import('@openai/agents/voice/portable');
  const hermes = await import('@openai/agents/voice/control.hermes');
  const directPortable = require('@openai/agents-codex/voice/portable');
  const directHermes = require('@openai/agents-codex/voice/control.hermes');
  assert.equal(
    portable.PortableVoiceControlBinding,
    directPortable.PortableVoiceControlBinding,
  );
  assert.equal(
    hermes.createHermesVoiceControl,
    directHermes.createHermesVoiceControl,
  );
  assert.ok(
    hermes.createHermesVoiceControl() instanceof
      portable.PortableVoiceControlBinding,
  );
  assert.ok(
    directHermes.createHermesVoiceControl() instanceof
      directPortable.PortableVoiceControlBinding,
  );
});

test('v1 model cancellation preserves the signal reason across OpenAI module formats', async () => {
  const CommonJSAbortError = require('openai').APIUserAbortError;
  assert.notEqual(APIUserAbortError, CommonJSAbortError);

  for (const AbortError of [APIUserAbortError, CommonJSAbortError]) {
    const failure = new AbortError({ message: 'custom abort message' });
    const model = new facade.ResponsesModel({
      responses: {
        async create() {
          throw failure;
        },
      },
    });
    const request = {
      body: { model: 'synthetic', input: [] },
      context: undefined,
      sessionId: 'session',
      turnId: 'turn',
    };
    const reason = new Error('application cancellation');
    await assert.rejects(
      model.complete({ ...request, signal: AbortSignal.abort(reason) }),
      (error) => error === reason,
    );
    await assert.rejects(
      model.complete({ ...request, signal: new AbortController().signal }),
      (error) => error === failure,
    );
  }
});
