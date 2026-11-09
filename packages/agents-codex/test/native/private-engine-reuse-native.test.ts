import { chmod, mkdtemp, rm, stat } from 'node:fs/promises';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
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
    vi.unstubAllEnvs();
  }
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'private Engine fresh-root reuse',
  () => {
    it('reuses a joined Engine after timer and socket I/O and closes its owned home', async () => {
      const model = new ModelServer([
        [message('before I/O')],
        [message('after I/O')],
      ]);
      await using provider = await providerFor(model);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Answer.',
      });
      const rows = await starts();
      expect((await agent.run('before I/O marker')).finalOutput).toBe(
        'before I/O',
      );
      const home = (rows[0].runtime as { codex_home: string }).codex_home;
      expect((await stat(home)).isDirectory()).toBe(true);
      await delay(25);
      const config = await model.config();
      const url = new URL(
        (config['model_providers.fixture'] as { base_url: string }).base_url,
      );
      const socket = createConnection({
        host: url.hostname,
        port: Number(url.port),
      });
      await once(socket, 'connect');
      socket.end();
      await once(socket, 'close');
      expect((await agent.run('after I/O marker')).finalOutput).toBe(
        'after I/O',
      );
      expect(rows.map((row) => row.kind)).toEqual(['ordinary', 'private']);
      expect(rows[1].engine).toBe(rows[0].engine);
      await provider.close();
      await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
      model.assertExhausted();
    }, 30_000);

    it('expires an abandoned idle Engine and removes its private home before opening fresh', async () => {
      const model = new ModelServer([
        [message('before expiry')],
        [message('after expiry')],
      ]);
      await using provider = await providerFor(model);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Answer.',
      });
      const rows = await starts();
      await agent.run('before expiry marker');
      const home = (rows[0].runtime as { codex_home: string }).codex_home;
      await expect
        .poll(
          async () =>
            stat(home).then(
              () => false,
              (error: NodeJS.ErrnoException) => {
                if (error.code !== 'ENOENT') throw error;
                return true;
              },
            ),
          { timeout: 8_000, interval: 25 },
        )
        .toBe(true);
      expect((await agent.run('after expiry marker')).finalOutput).toBe(
        'after expiry',
      );
      expect(rows.map((row) => row.kind)).toEqual(['ordinary', 'ordinary']);
      expect(rows[1].engine).not.toBe(rows[0].engine);
      model.assertExhausted();
    }, 30_000);

    it.skipIf(process.platform !== 'linux' || process.getuid?.() === 0)(
      'joins failed native closes and retries owned-home deletion without reporting early success',
      async () => {
        const model = new ModelServer([[message('home failure')]]);
        const provider = await providerFor(model);
        const agent = new Agent({
          provider,
          model: 'gpt-5',
          instructions: 'Answer.',
        });
        const rows = await starts();
        await agent.run('owned home retry marker');
        const home = (rows[0].runtime as { codex_home: string }).codex_home;
        const engine = rows[0].engine as Engine;
        await chmod(home, 0o500);
        try {
          const results = await Promise.allSettled([
            engine._close_report(),
            engine._close_report(),
          ]);
          expect(results.map((result) => result.status)).toEqual([
            'rejected',
            'rejected',
          ]);
          expect((await stat(home)).isDirectory()).toBe(true);
        } finally {
          await chmod(home, 0o700);
          await Promise.all([engine._close_report(), provider.close()]);
        }
        await expect(stat(home)).rejects.toMatchObject({ code: 'ENOENT' });
        model.assertExhausted();
      },
      30_000,
    );

    it.each([false, true])(
      'keeps explicit initial messages on fresh seeded roots (empty=%s)',
      async (empty) => {
        const model = new ModelServer([
          [message('warm answer')],
          [message('seeded answer')],
        ]);
        await using provider = await providerFor(model);
        const agent = new Agent({
          provider,
          model: 'gpt-5',
          instructions: 'Answer.',
        });
        const rows = await starts();
        await agent.run('warm isolated marker');
        const result = await agent.run('current isolated marker', {
          initialMessages: empty
            ? []
            : [{ role: 'assistant', content: 'seed isolation marker' }],
        });
        expect(result.finalOutput).toBe('seeded answer');
        expect(rows.map((row) => row.kind)).toEqual(['ordinary']);
        const input = JSON.stringify(model.requests[1].input);
        expect(input).toContain('current isolated marker');
        expect(input).not.toContain('warm isolated marker');
        if (!empty) expect(input).toContain('seed isolation marker');
      },
    );

    it.each([false, true])(
      'pins effective API keys and resets only for environment rotation (explicit=%s)',
      async (explicit) => {
        vi.stubEnv('OPENAI_API_KEY', 'synthetic-env-first');
        const model = new ModelServer([
          [message('first')],
          [message('same key')],
          [message('changed environment')],
        ]);
        const config = await model.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          ...(explicit ? { apiKey: 'synthetic-explicit' } : {}),
          supportsWebsockets: false,
        });
        const agent = new Agent({
          provider,
          model: 'gpt-5',
          instructions: 'Answer.',
        });
        const rows = await starts();
        expect((await agent.run('first')).finalOutput).toBe('first');
        expect((await agent.run('same')).finalOutput).toBe('same key');
        vi.stubEnv('OPENAI_API_KEY', 'synthetic-env-next');
        expect((await agent.run('rotated')).finalOutput).toBe(
          'changed environment',
        );
        expect(rows.map((row) => row.kind)).toEqual([
          'ordinary',
          'private',
          explicit ? 'private' : 'ordinary',
        ]);
        expect(rows[1].engine).toBe(rows[0].engine);
        if (explicit) expect(rows[2].engine).toBe(rows[0].engine);
        else expect(rows[2].engine).not.toBe(rows[0].engine);
        expect(
          model.requestHeaders.map((headers) => headers.authorization),
        ).toEqual(
          explicit
            ? Array(3).fill('Bearer synthetic-explicit')
            : [
                'Bearer synthetic-env-first',
                'Bearer synthetic-env-first',
                'Bearer synthetic-env-next',
              ],
        );
        model.assertExhausted();
      },
      30_000,
    );

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

    it('captures only current model callbacks on consecutive private roots', async () => {
      const model = new ModelServer([[message('before')], [message('after')]]);
      await using provider = await providerFor(model);
      const firstComplete = vi.fn();
      const nextComplete = vi.fn();
      const firstTransform = vi.fn(() => [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'first callback marker' }],
        },
      ]);
      const nextTransform = vi.fn(() => [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'next callback marker' }],
        },
      ]);
      const agent = new Agent({
        provider,
        model: 'gpt-5',
        instructions: 'Answer.',
        beforeComplete: firstComplete,
        transformContext: firstTransform,
      });
      const rows = await starts();
      expect((await agent.run('first')).finalOutput).toBe('before');
      agent.beforeComplete = nextComplete;
      agent.transformContext = nextTransform;
      expect((await agent.run('second')).finalOutput).toBe('after');
      expect(rows.map((row) => row.kind)).toEqual(['ordinary', 'private']);
      expect(rows[1].engine).toBe(rows[0].engine);
      expect(firstComplete).toHaveBeenCalledTimes(1);
      expect(nextComplete).toHaveBeenCalledTimes(1);
      expect(firstTransform).toHaveBeenCalledTimes(1);
      expect(nextTransform).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(model.requests[1].input)).toContain(
        'next callback marker',
      );
      expect(JSON.stringify(model.requests[1].input)).not.toContain(
        'first callback marker',
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

    it.each([
      'process',
      'worker',
      'terminated-worker',
      'sibling-worker',
      'active-process',
      'idle-socket',
    ])(
      'joins private idle cleanup promptly in a %s',
      async (mode) => {
        const requests =
          mode === 'sibling-worker' ? 3 : mode === 'active-process' ? 2 : 1;
        const model = new ModelServer(
          Array.from({ length: requests }, () => [message('natural answer')]),
          [],
          undefined,
          undefined,
          async () => {
            if (mode === 'active-process') await delay(100);
          },
        );
        const config = await model.config();
        const url = (config['model_providers.fixture'] as { base_url: string })
          .base_url;
        const require = createRequire(import.meta.url);
        const module = require.resolve('../../dist/index.js');
        const nativeModule = require.resolve('../../native/index.js');
        const code = `
      const assert = require('node:assert/strict');
      const { existsSync } = require('node:fs');
      const { once } = require('node:events');
      const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
      const args = isMainThread ? { module: process.argv[1], nativeModule: process.argv[2], url: process.argv[3], mode: process.argv[4] } : workerData;
      (async () => {
        if (isMainThread && ['worker', 'terminated-worker', 'sibling-worker'].includes(args.mode)) {
          const make = (role) => new Worker(process.argv[5], { eval: true, workerData: { ...args, role } });
          if (args.mode === 'sibling-worker') {
            const victim = make('victim');
            const survivor = make('survivor');
            const victimExit = once(victim, 'exit');
            const survivorExit = once(survivor, 'exit');
            const [[a], [b]] = await Promise.all([once(victim, 'message'), once(survivor, 'message')]);
            assert(existsSync(a.home)); assert(existsSync(b.home));
            await victim.terminate();
            assert.equal((await victimExit)[0], 1);
            assert(!existsSync(a.home));
            const resumed = once(survivor, 'message');
            survivor.postMessage('resume');
            assert.equal((await resumed)[0], 'second completed');
            assert.equal((await survivorExit)[0], 0);
            assert(!existsSync(b.home));
            process.stdout.write(JSON.stringify({ home: a.home, idleAt: a.idleAt }));
          } else {
            const worker = make(args.mode === 'terminated-worker' ? 'victim' : 'natural');
            const exited = once(worker, 'exit');
            const [idle] = await once(worker, 'message');
            if (args.mode === 'terminated-worker') {
              assert(existsSync(idle.home));
              await worker.terminate();
            }
            assert.equal((await exited)[0], args.mode === 'terminated-worker' ? 1 : 0);
            assert(!existsSync(idle.home));
            process.stdout.write(JSON.stringify(idle));
          }
          return;
        }
        const native = require(args.nativeModule);
        const start = native.Engine.prototype.start_replaceable_thread;
        let home;
        native.Engine.prototype.start_replaceable_thread = async function(...values) {
          home = JSON.parse(values[0]).runtime.codex_home;
          return start.apply(this, values);
        };
        const admit = native.Engine.prototype._private_start_thread;
        let reused = false;
        native.Engine.prototype._private_start_thread = function(...values) {
          assert(process.getActiveResourcesInfo().includes('TCPServerWrap'), 'active private listener must be referenced');
          reused = true;
          return admit.apply(this, values);
        };
        const bind = native.Engine.prototype._sentinel_bind;
        let origin;
        native.Engine.prototype._sentinel_bind = function(base, ...values) {
          origin = base;
          return bind.call(this, base, ...values);
        };
        const { Agent, NativeProvider } = require(args.module);
        const provider = new NativeProvider({ baseUrl: args.url, apiKey: 'synthetic-natural-exit', supportsWebsockets: false });
        const agent = new Agent({ provider, model: 'gpt-5', instructions: 'Answer.' });
        assert.equal((await agent.run('natural exit marker')).finalOutput, 'natural answer');
        globalThis.keptProvider = [provider, agent];
        if (args.mode === 'idle-socket') {
          const url = new URL(origin);
          const socket = require('node:net').createConnection({ host: url.hostname, port: Number(url.port) });
          await once(socket, 'connect');
          socket.unref();
          globalThis.keptIdleSocket = socket;
        }
        if (args.mode === 'active-process') {
          await new Promise(resolve => setTimeout(resolve, 25));
          assert.equal((await agent.run('active call marker')).finalOutput, 'natural answer');
          assert(reused, 'active call must exercise the retained Engine');
        }
        const idle = { home, idleAt: Date.now() };
        if (parentPort) {
          if (args.role === 'victim') parentPort.on('message', () => {});
          if (args.role === 'survivor') parentPort.once('message', async () => {
            try {
              assert.equal((await agent.run('sibling runtime marker')).finalOutput, 'natural answer');
              await provider.close();
              parentPort.postMessage('second completed');
              parentPort.close();
            } catch (error) { console.error(error); process.exitCode = 1; }
          });
          parentPort.postMessage(idle);
        } else process.stdout.write(JSON.stringify(idle));
        // Natural cases abandon the Provider. The timer must not keep it alive.
      })().catch((error) => { console.error(error); process.exitCode = 1; });
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
          ['-e', code, module, nativeModule, url, mode, code],
          { timeout: 20_000, killSignal: 'SIGKILL', env },
        );
        const result = JSON.parse(stdout) as { home: string; idleAt: number };
        // Less than half the5s idle TTL: waiting for expiry cannot pass.
        expect(Date.now() - result.idleAt).toBeLessThan(2_500);
        await expect(stat(result.home)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        model.assertExhausted();
      },
      30_000,
    );
  },
);
