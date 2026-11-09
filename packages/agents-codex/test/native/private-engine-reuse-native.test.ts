import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Engine } from '../../native/index.js';
import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

async function providerFor(model: ModelServer) {
  const config = await model.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-private-engine',
    supportsWebsockets: false,
  });
}

async function starts() {
  const native = await binding();
  const ordinary = native.Engine.prototype.start_replaceable_thread;
  const reuse = native.Engine.prototype._private_start_thread;
  const rows: {
    kind: 'ordinary' | 'private';
    engine: unknown;
    root: string | null;
    source: unknown;
    runtime: unknown;
  }[] = [];
  vi.spyOn(
    native.Engine.prototype,
    'start_replaceable_thread',
  ).mockImplementation(async function (this: Engine, ...args) {
    const thread = await ordinary.apply(this, args);
    rows.push({
      kind: 'ordinary',
      engine: this,
      root: thread.id,
      source: JSON.parse(args[0]).config,
      runtime: JSON.parse(args[0]).runtime,
    });
    return thread;
  });
  vi.spyOn(native.Engine.prototype, '_private_start_thread').mockImplementation(
    async function (this: Engine, ...args) {
      const thread = await reuse.apply(this, args);
      rows.push({
        kind: 'private',
        engine: this,
        root: thread?.id ?? null,
        source: JSON.parse(args[0]),
        runtime: JSON.parse(args[1]),
      });
      return thread;
    },
  );
  return rows;
}

afterEach(async () => {
  try {
    await ModelServer.closeAll();
  } finally {
    vi.restoreAllMocks();
  }
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'private Engine fresh-root reuse',
  () => {
    it('uses one Engine for two distinct fresh roots and leaves a completed old Turn independent', async () => {
      const model = new ModelServer([
        [message('first answer')],
        [message('second answer')],
      ]);
      await using provider = await providerFor(model);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Answer.',
      });
      const rows = await starts();
      const first = await agent.run('first isolated marker');
      const second = await agent.run('second isolated marker');
      expect(first.finalOutput).toBe('first answer');
      expect(second.finalOutput).toBe('second answer');
      expect((await first.turn.wait()).finalOutput).toBe('first answer');
      expect(rows.map((row) => row.kind)).toEqual(['ordinary', 'private']);
      expect(rows[1].engine).toBe(rows[0].engine);
      expect(rows[1].root).not.toBeNull();
      expect(rows[1].root).not.toBe(rows[0].root);
      expect(JSON.stringify(model.requests[1].input)).toContain(
        'second isolated marker',
      );
      expect(JSON.stringify(model.requests[1].input)).not.toContain(
        'first isolated marker',
      );
      model.assertExhausted();
    }, 30_000);

    it('applies changed per-root instructions while retaining the Engine', async () => {
      const model = new ModelServer([[message('before')], [message('after')]]);
      await using provider = await providerFor(model);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Original instruction marker.',
      });
      const rows = await starts();
      expect((await agent.run('first')).finalOutput).toBe('before');
      agent.instructions = 'Changed instruction marker.';
      expect((await agent.run('second')).finalOutput).toBe('after');
      expect(rows.map((row) => [row.kind, row.root === null])).toEqual([
        ['ordinary', false],
        ['private', false],
      ]);
      expect(rows[1].engine).toBe(rows[0].engine);
      expect(rows[1].root).not.toBe(rows[0].root);
      expect(rows[1].source).toEqual(rows[0].source);
      expect(JSON.stringify(model.requests[1])).toContain(
        'Changed instruction marker.',
      );
      expect(JSON.stringify(model.requests[1])).not.toContain(
        'Original instruction marker.',
      );
      model.assertExhausted();
    }, 30_000);

    it('fresh-loads changed ambient SQLite configuration before deciding reuse', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'codex-private-input-'));
      try {
        vi.stubEnv('CODEX_SQLITE_HOME', join(directory, 'first'));
        const model = new ModelServer([
          [message('before')],
          [message('after')],
        ]);
        await using provider = await providerFor(model);
        const agent = new Agent({
          provider,
          model: 'gpt-5',
          instructions: 'Answer.',
        });
        const rows = await starts();
        expect((await agent.run('first')).finalOutput).toBe('before');
        vi.stubEnv('CODEX_SQLITE_HOME', join(directory, 'second'));
        expect((await agent.run('second')).finalOutput).toBe('after');
        expect(rows.map((row) => [row.kind, row.root === null])).toEqual([
          ['ordinary', false],
          ['private', true],
          ['ordinary', false],
        ]);
        expect(rows[1].source).toEqual(rows[0].source);
        expect(rows[1].runtime).toEqual(rows[0].runtime);
        expect(rows[1].engine).toBe(rows[0].engine);
        expect(rows[2].engine).not.toBe(rows[0].engine);
        expect(rows[2].root).not.toBe(rows[0].root);
        model.assertExhausted();
      } finally {
        vi.unstubAllEnvs();
        await rm(directory, { recursive: true, force: true });
      }
    }, 30_000);

    it.each(['null', 'explicit'])(
      'does not admit a caller System override %s as an owned origin',
      async (kind) => {
        const directory = await mkdtemp(join(tmpdir(), 'codex-origin-'));
        const path =
          kind === 'null' ? null : join(directory, 'user-system.toml');
        try {
          const native = await binding();
          const engine = await native.create_engine(
            JSON.stringify({
              model: 'gpt-5',
              approval_policy: 'never',
              sandbox_mode: 'danger-full-access',
              web_search: 'disabled',
              'analytics.enabled': false,
            }),
            JSON.stringify({ loader: { system_config_path: path } }),
            'synthetic-origin-key',
          );
          try {
            expect(engine._private_reuse_ready).toBe(false);
          } finally {
            await engine.close();
          }
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
      30_000,
    );

    it.each(['process', 'worker'])(
      'exits naturally after an abandoned private Provider in a %s',
      async (mode) => {
        const model = new ModelServer([[message('natural answer')]]);
        const config = await model.config();
        const url = (config['model_providers.fixture'] as { base_url: string })
          .base_url;
        const module = createRequire(import.meta.url).resolve(
          '../../dist/index.js',
        );
        const code = `
      const assert = require('node:assert/strict');
      const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
      const args = isMainThread ? { module: process.argv[1], url: process.argv[2], mode: process.argv[3] } : workerData;
      if (isMainThread && args.mode === 'worker') {
        const worker = new Worker(process.argv[4], { eval: true, workerData: args });
        let completed = false;
        worker.on('message', (value) => { assert.equal(value, 'completed'); completed = true; });
        worker.on('error', (error) => { console.error(error); process.exitCode = 1; });
        worker.on('exit', (status) => { assert.equal(status, 0); assert.equal(completed, true); process.stdout.write('natural exit'); });
      } else {
        const { Agent, NativeProvider } = require(args.module);
        (async () => {
          const provider = new NativeProvider({ baseUrl: args.url, apiKey: 'synthetic-natural-exit', supportsWebsockets: false });
          const agent = new Agent({ provider, model: 'gpt-5', instructions: 'Answer.' });
          assert.equal((await agent.run('natural exit marker')).finalOutput, 'natural answer');
          if (parentPort) parentPort.postMessage('completed'); else process.stdout.write('natural exit');
          // Deliberately abandon the still-open Provider; no forced exit or close.
        })().catch((error) => { console.error(error); process.exitCode = 1; });
      }
    `;
        const env = { ...process.env };
        for (const key of Object.keys(env))
          if (
            /^(OPENAI_|CODEX_|OTEL_|BENCH_)/.test(key) ||
            ['NODE_OPTIONS', 'NODE_PATH'].includes(key)
          )
            delete env[key];
        const { stdout } = await promisify(execFile)(
          process.execPath,
          ['-e', code, module, url, mode, code],
          { timeout: 20_000, env },
        );
        expect(stdout).toBe('natural exit');
        model.assertExhausted();
      },
      30_000,
    );
  },
);
