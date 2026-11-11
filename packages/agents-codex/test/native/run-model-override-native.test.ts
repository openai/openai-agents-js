import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  type ModelRequest,
  type ModelResponse,
} from '../../src';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

function models(): [string, string, string] {
  const catalog = JSON.parse(
    readFileSync(
      new URL(
        '../../native/.upstream/reviewed-codex/codex-rs/models-manager/models.json',
        import.meta.url,
      ),
      'utf8',
    ),
  ) as { models: { slug: string; supported_in_api: boolean }[] };
  const names = catalog.models
    .filter((model) => model.supported_in_api)
    .map((model) => model.slug);
  if (names.length < 3) throw new Error('Expected three native catalog models');
  return names.slice(0, 3) as [string, string, string];
}
function completed(output: readonly JsonObject[]): ModelResponse {
  return { output, usage: { input_tokens: 1, output_tokens: 1 } };
}

nativeIt.each(['direct', 'provider'] as const)(
  'forces one run through handoff and return without changing defaults (%s)',
  async (kind) => {
    const [initial, forced, destination] = models();
    const seen: ModelRequest[] = [];
    const backend = {
      complete(request: ModelRequest) {
        seen.push(request);
        return completed(
          seen.length === 1
            ? [call('transfer_to_target', {}, { callId: 'to-target' })]
            : seen.length === 2
              ? [call('transfer_to_root', {}, { callId: 'to-root' })]
              : [message('done')],
        );
      },
    };
    const resolve = vi.fn((_modelName: string) => backend);
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      supportsWebsockets: false,
      modelBackend: kind === 'direct' ? backend : { getModel: resolve },
    });
    const root = new Agent({
      name: 'Root',
      model: initial,
      instructions: 'Handle the request.',
      provider,
    });
    const target = new Agent({
      name: 'Target',
      model: destination,
      instructions: 'Return to Root.',
      handoffs: [root],
    });
    root.handoffs = [target];
    await using session = await root.session();
    expect(
      (
        await (
          await session.submit('transfer and return', { modelOverride: forced })
        ).wait()
      ).finalOutput,
    ).toBe('done');
    expect(await session.getActiveAgent()).toBe(root);
    expect(seen.map((request) => request.body.model)).toEqual([
      forced,
      forced,
      forced,
    ]);
    expect(
      (await (await session.submit('another run')).wait()).finalOutput,
    ).toBe('done');
    expect(seen.map((request) => request.body.model)).toEqual([
      forced,
      forced,
      forced,
      initial,
    ]);
    if (kind === 'provider')
      expect(resolve.mock.calls.map((args) => args[0])).toEqual([
        forced,
        forced,
        forced,
        initial,
      ]);
  },
  30_000,
);

nativeIt(
  'captures queued model choices and rejects replacement on the active native turn',
  async () => {
    const [initial, forced, queued] = models();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const seen: unknown[] = [];
    const addon = await binding();
    const submit = addon.NativeThread.prototype._submit;
    const submitted: NativeThread[] = [];
    vi.spyOn(addon.NativeThread.prototype, '_submit').mockImplementation(
      function (this: NativeThread, ...args) {
        submitted.push(this);
        return Reflect.apply(submit, this, args);
      },
    );
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      supportsWebsockets: false,
      modelBackend: {
        async complete(request) {
          seen.push(request.body.model);
          if (seen.length === 1) {
            entered.resolve();
            await release.promise;
          }
          return completed([message('done')]);
        },
      },
    });
    await using session = await new Agent({
      model: initial,
      instructions: 'Answer.',
      provider,
    }).session();
    try {
      const first = await session.submit('first', { modelOverride: forced });
      await entered.promise;
      const native = submitted.at(-1);
      if (!native) throw new Error('Expected the admitted native owner');
      const rejected = JSON.parse(
        await native._submit(
          JSON.stringify({
            mode: 'steer',
            expected_turn_id: first.turnId,
            input: [{ type: 'text', text: 'replace' }],
            start: { model_override: queued },
          }),
        ),
      );
      expect(rejected).toMatchObject({
        status: 'not_submitted',
        reason: { type: 'active_turn_model_override_mismatch' },
      });
      const options = { modelOverride: queued };
      const second = session.enqueue('queued', options);
      options.modelOverride = initial;
      release.resolve();
      await first.wait();
      await (await second).wait();
      await (await session.submit('default')).wait();
      expect(seen).toEqual([forced, queued, initial]);
    } finally {
      release.resolve();
    }
  },
  30_000,
);

nativeIt(
  'retains the admitted model through a manual checkpoint and leaves later defaults intact',
  async () => {
    const [initial, forced] = models();
    const lookup = manualTool({
      name: 'lookup',
      description: 'Retrieve a record.',
      parameters: z.object({}),
      result: z.string(),
    });
    const seen: unknown[] = [];
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      supportsWebsockets: false,
      modelBackend: {
        complete(request) {
          seen.push(request.body.model);
          return completed(
            seen.length === 1
              ? [call('lookup', {}, { callId: 'lookup' })]
              : [message('done')],
          );
        },
      },
    });
    const agent = new Agent({
      model: initial,
      instructions: 'Use lookup.',
      tools: [lookup],
      provider,
    });
    await using original = await agent.session();
    const turn = await original.submit('lookup', { modelOverride: forced });
    const completion = turn.wait().catch((error: unknown) => error);
    await turn.wait({ until: 'manual_tool' });
    const state = JSON.parse(JSON.stringify(await original.suspend()));
    expect(await completion).toBeInstanceOf(InteractionRequired);
    await original.close();
    await expect(
      agent.run(null, { state, modelOverride: initial }),
    ).rejects.toThrow('cannot replace');
    await using restored = await agent.session({ state });
    for await (const event of restored.events()) {
      if (event.type !== 'action_requested') continue;
      await restored.respond(event.reply('accepted'));
      break;
    }
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe('done');
    await (await restored.submit('new default run')).wait();
    expect(seen).toEqual([forced, forced, initial]);
  },
  30_000,
);

nativeIt(
  'forces an explicitly configured native child role without replacing its defaults',
  async () => {
    const [initial, forced, childDefault] = models();
    const executor = await startPublicExecutor();
    let rootId: string | undefined;
    const childSeen = Promise.withResolvers<void>();
    const ids = new Set<string>();
    const server = new ModelServer(
      Array.from({ length: 3 }, () => async (request: JsonObject) => {
        expect(request.model).toBe(forced);
        const metadata = request.client_metadata as Record<string, string>;
        const id = String(
          JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
        );
        rootId ??= id;
        if (id !== rootId) {
          childSeen.resolve();
          return [message('child done')];
        }
        if (!ids.has(id)) {
          ids.add(id);
          return [
            call(
              'spawn_agent',
              {
                task_name: 'research',
                message: 'Answer.',
                agent_type: 'research',
              },
              { namespace: 'collaboration', callId: 'spawn' },
            ),
          ];
        }
        await childSeen.promise;
        return [message('root done')];
      }),
    );
    const config = await server.config();
    try {
      await promisify(execFile)(
        process.execPath,
        [
          '--stack-size=16384',
          '--import',
          'tsx',
          fileURLToPath(
            new URL('./fixtures/run-model-override-child.ts', import.meta.url),
          ),
          JSON.stringify({
            initial,
            forced,
            childDefault,
            baseUrl: (config['model_providers.fixture'] as { base_url: string })
              .base_url,
            executorUrl: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
          }),
        ],
        { env: process.env, timeout: 25_000 },
      );
      await childSeen.promise;
      expect(server.requests).toHaveLength(3);
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30_000,
);

nativeIt(
  'keeps the admitted model through an owned output-repair session',
  async () => {
    const [initial, forced] = models();
    const seen: unknown[] = [];
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      supportsWebsockets: false,
      modelBackend: {
        complete(request) {
          seen.push(request.body.model);
          return completed([
            message(seen.length === 1 ? 'invalid output' : '{"answer":"done"}'),
          ]);
        },
      },
    });
    const agent = new Agent({
      model: initial,
      instructions: 'Answer.',
      provider,
      outputType: {
        mode: 'prompted',
        schema: z.object({ answer: z.string() }),
        maxRetries: 1,
      },
    });
    expect(
      (await agent.run('answer', { modelOverride: forced })).finalOutput,
    ).toEqual({ answer: 'done' });
    expect(seen).toEqual([forced, forced]);
  },
);

nativeIt(
  'fails captured provider resolution before issuing an incompatible model request',
  async () => {
    const [initial, forced] = models();
    const resolve = vi.fn((modelName: string): never => {
      expect(modelName).toBe(forced);
      throw new Error('No backend for captured run model');
    });
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      supportsWebsockets: false,
      modelBackend: { getModel: resolve },
    });
    const agent = new Agent({
      model: initial,
      instructions: 'Answer.',
      provider,
    });
    await expect(
      agent.run('answer', { modelOverride: forced }),
    ).rejects.toThrow('No backend for captured run model');
    expect(resolve).toHaveBeenCalledExactlyOnceWith(forced);
  },
);

nativeIt(
  'accepts a fresh override on a new run from settled saved history',
  async () => {
    const [initial, firstModel, secondModel] = models();
    const seen: unknown[] = [];
    await using provider = new NativeProvider({
      baseUrl: 'https://example.invalid/v1',
      supportsWebsockets: false,
      modelBackend: {
        complete(request) {
          seen.push(request.body.model);
          return completed([message('done')]);
        },
      },
    });
    const agent = new Agent({
      model: initial,
      instructions: 'Answer.',
      provider,
    });
    const first = await agent.run('first', {
      modelOverride: firstModel,
      returnState: true,
    });
    expect(first.state).toBeDefined();
    await agent.run('second', {
      state: JSON.parse(JSON.stringify(first.state)),
      modelOverride: secondModel,
    });
    await agent.run('default');
    expect(seen).toEqual([firstModel, secondModel, initial]);
  },
);
