import { existsSync } from 'node:fs';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { TurnAborted } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 10_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Compaction barrier timed out');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

it.skipIf(process.platform === 'win32').each(['cancel', 'close'] as const)(
  'fences provider admission when %s starts during automatic compaction setup',
  async (operation) => {
    const directory = await mkdtemp(join(tmpdir(), 'late-compaction-'));
    const entered = join(directory, 'entered');
    const release = join(directory, 'release');
    const released = join(directory, 'released');
    const hook = join(directory, 'hold.cjs');
    await writeFile(
      hook,
      `const fs = require('node:fs');
fs.writeFileSync(${JSON.stringify(entered)}, 'entered');
const timer = setInterval(() => {
  if (fs.existsSync(${JSON.stringify(release)})) {
    fs.writeFileSync(${JSON.stringify(released)}, "released");
    clearInterval(timer);
  }
}, 10);
`,
    );
    const native = await binding();
    const create = native.create_engine;
    const createSpy = vi
      .spyOn(native, 'create_engine')
      .mockImplementation(async (config, runtime, key, apps) => {
        const options = JSON.parse(runtime);
        // Install a test-only barrier on the real native setup path.
        options.bypass_hook_trust = true;
        await writeFile(
          join(options.codex_home, 'hooks.json'),
          JSON.stringify({
            hooks: {
              PreCompact: [
                {
                  matcher: 'auto',
                  hooks: [
                    {
                      type: 'command',
                      command: [process.execPath, hook]
                        .map((arg) => `'${arg.replaceAll("'", "'\\''")}'`)
                        .join(' '),
                    },
                  ],
                },
              ],
            },
          }),
        );
        return create(config, JSON.stringify(options), key, apps);
      });
    const reserved = Promise.withResolvers<void>();
    const releaseStop = Promise.withResolvers<void>();
    const Thread = native.NativeThread;
    const requestStop = Thread.prototype._request_graph_stop;
    const closeReport = Thread.prototype._close_report;
    const stopSpy =
      operation === 'cancel'
        ? vi
            .spyOn(Thread.prototype, '_request_graph_stop')
            .mockImplementation(function (this: NativeThread, scope, mode) {
              const receipt = requestStop.call(this, scope, mode);
              const settle = receipt.settle.bind(receipt);
              vi.spyOn(receipt, 'settle').mockImplementation(async () => {
                reserved.resolve();
                await releaseStop.promise;
                await settle();
              });
              return receipt;
            })
        : vi
            .spyOn(Thread.prototype, '_close_report')
            .mockImplementation(async function (this: NativeThread) {
              reserved.resolve();
              await releaseStop.promise;
              return closeReport.call(this);
            });
    let session: Awaited<ReturnType<Agent['session']>> | undefined;
    let provider: NativeProvider | undefined;
    try {
      const model = new ModelServer(
        [
          [call('lookup', {}, { callId: 'settled' })],
          [message('compacted history')],
          [message('successor')],
        ],
        [
          JSON.stringify({
            input_tokens: 260000,
            output_tokens: 1000,
            total_tokens: 261000,
          }),
          () => undefined,
          () => undefined,
        ],
      );
      const followup = Promise.withResolvers<void>();
      model.onRecord = (phase) => {
        if (phase === 'MODEL_REQUEST' && model.requests.length > 1)
          followup.resolve();
      };
      const config = await model.config();
      provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-compaction-stop',
        supportsWebsockets: false,
      });
      session = await new Agent({
        model: 'gpt-5.5',
        instructions: 'Use lookup.',
        provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => 'settled-tool-output',
          }),
        ],
      }).session();
      const turn = await session.submit('Lookup now.');
      const result = turn.wait().then(
        (value) => ({ ok: true as const, value }),
        (error: unknown) => ({ ok: false as const, error }),
      );
      await waitFor(() => existsSync(entered));
      expect(model.requests).toHaveLength(1);
      const stopping = operation === 'cancel' ? turn.cancel() : session.close();
      try {
        await reserved.promise;
        await writeFile(release, 'release');
        await waitFor(() => existsSync(released));
        const sent = await Promise.race([
          followup.promise.then(() => true),
          new Promise<false>((resolve) =>
            setTimeout(() => resolve(false), 1500),
          ),
        ]);
        expect(sent).toBe(false);
        expect(model.requests).toHaveLength(1);
      } finally {
        await writeFile(release, 'release');
        releaseStop.resolve();
        await stopping;
      }
      const outcome = await result;
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error('Stopped turn completed');
      expect(outcome.error).toBeInstanceOf(TurnAborted);
      if (operation === 'cancel') {
        const next = await session.submit('Continue without tools.');
        expect((await next.wait()).finalOutput).toBe('successor');
        expect(model.requests).toHaveLength(3);
      }
    } finally {
      await writeFile(release, 'release');
      releaseStop.resolve();
      await session?.close();
      await provider?.close();
      stopSpy.mockRestore();
      createSpy.mockRestore();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);
