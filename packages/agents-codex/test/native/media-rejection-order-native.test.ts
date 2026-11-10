import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  ToolOutput,
  tool,
  type Session,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

const image =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

it.each([
  [
    'keeps rejected media parked before host failure (child=false)',
    false,
    false,
  ],
  ['keeps rejected media parked before host failure (child=true)', true, false],
  [
    'preserves accepted steering after child media validation fails',
    true,
    true,
  ],
] as const)(
  '%s',
  async (_name, child, queuedSteering) => {
    const queuedInput = 'Continue with the accepted steering.';
    let validationError: unknown;
    const release = Promise.withResolvers<void>();
    const addon = await binding();
    const respond = addon.NativeThread.prototype._respond_python_tool;
    const spy = vi
      .spyOn(addon.NativeThread.prototype, '_respond_python_tool')
      .mockImplementation(async function (this: NativeThread, raw) {
        try {
          return await respond.call(this, raw);
        } catch (error) {
          validationError = error;
          await release.promise;
          throw error;
        }
      });
    let executor: Awaited<ReturnType<typeof startPublicExecutor>> | undefined;
    let provider: NativeProvider | undefined;
    let session: Session | undefined;
    let effects = 0,
      rootRequests = 0,
      childRequests = 0;
    let rootId: string | undefined;
    let acceptSteering: (() => Promise<void>) | undefined;
    try {
      if (child) executor = await startPublicExecutor();
      const responses = child
        ? Array.from({ length: 4 }, () => (request: Record<string, any>) => {
            const id = JSON.parse(
              request.client_metadata['x-codex-turn-metadata'],
            ).thread_id as string;
            rootId ??= id;
            if (id === rootId)
              return ++rootRequests === 1
                ? [
                    call(
                      'spawn_agent',
                      { task_name: 'media', message: 'Use reference.' },
                      {
                        namespace: 'collaboration',
                        callId: 'spawn-media-rejection',
                      },
                    ),
                  ]
                : [message('root done')];
            childRequests += 1;
            return childRequests === 1
              ? [call('reference', {}, { callId: 'child-low' })]
              : [
                  message(
                    queuedSteering
                      ? 'processed queued input'
                      : 'must not continue',
                  ),
                ];
          })
        : [
            [call('reference', {}, { callId: 'root-low' })],
            [message('must not continue')],
          ];
      const model = new ModelServer(responses);
      const config = await model.config();
      provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-media-rejection-key',
        supportsWebsockets: false,
      });
      const reference = tool({
        name: 'reference',
        parameters: z.object({}),
        execute: () => {
          effects += 1;
          return ToolOutput.image({ imageUrl: image, detail: 'low' });
        },
      });
      const agent = new Agent({
        instructions: 'Use reference once.',
        model: child ? 'gpt-5.6-terra' : 'gpt-5',
        provider,
        tools: child ? [new NativeAgents(), reference] : [reference],
      });
      session = await agent.session(
        executor
          ? {
              environment: new Environment({
                url: executor.url,
                cwd: executor.cwd,
                headers: executor.headers,
                tools: ['exec_command', 'write_stdin', 'apply_patch'],
              }),
            }
          : {},
      );
      const root = await session.submit('Read.');
      let result: Promise<unknown>;
      if (child) {
        expect((await root.wait()).finalOutput).toBe('root done');
        const children = await vi.waitUntil(async () => {
          const values = await Array.fromAsync(session!.subagents());
          return values[0]?.turn ? values : false;
        });
        const childHandle = children[0];
        const turn = childHandle.turn!;
        if (queuedSteering) {
          acceptSteering = async () => {
            expect(await childHandle.submit(queuedInput)).toBe(turn);
          };
        }
        result = turn.wait().catch((error) => error);
      } else result = root.wait().catch((error) => error);
      await vi.waitFor(() => expect(validationError).toBeInstanceOf(Error), {
        timeout: 10000,
      });
      const error = validationError;
      expect(error).toBeInstanceOf(Error);
      expect((error as Error).message).toMatch(/detail 'low' is not supported/);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      // Hold the real NAPI validation rejection before JavaScript can stop the turn.
      await delay(150);
      expect(settled).toBe(false);
      expect(effects).toBe(1);
      expect(model.requests).toHaveLength(child ? 3 : 1);
      if (child) {
        expect(rootRequests).toBe(2);
        expect(childRequests).toBe(1);
      }
      if (acceptSteering) await acceptSteering();
      release.resolve();
      expect(await result).toMatchObject({
        message: expect.stringMatching(/detail 'low' is not supported/),
      });
      if (queuedSteering) {
        expect(model.requests).toHaveLength(4);
        expect(childRequests).toBe(2);
        expect(JSON.stringify(model.requests[3].input)).toContain(queuedInput);
      } else {
        expect(model.requests).toHaveLength(child ? 3 : 1);
      }
      expect(effects).toBe(1);
    } finally {
      release.resolve();
      try {
        await session?.close();
      } finally {
        try {
          await provider?.[Symbol.asyncDispose]();
        } finally {
          await executor?.close();
          spy.mockRestore();
        }
      }
    }
  },
  30000,
);

it('quietly rejects consumed media replies before inspecting their new media', async () => {
  const addon = await binding();
  const respond = addon.NativeThread.prototype._respond_python_tool;
  let captured: { native: NativeThread; raw: string } | undefined;
  const spy = vi
    .spyOn(addon.NativeThread.prototype, '_respond_python_tool')
    .mockImplementation(async function (this: NativeThread, raw) {
      captured = { native: this, raw };
      return await respond.call(this, raw);
    });
  const model = new ModelServer([
    [call('reference', {}, { callId: 'consumed-media' })],
    [message('done')],
  ]);
  const config = await model.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-media-rejection-key',
    supportsWebsockets: false,
  });
  let effects = 0;
  const agent = new Agent({
    instructions: 'Use reference once.',
    model: 'gpt-5',
    provider,
    tools: [
      tool({
        name: 'reference',
        parameters: z.object({}),
        execute: () => {
          effects += 1;
          return ToolOutput.file({ file_id: 'accepted-file' });
        },
      }),
    ],
  });
  await using session = await agent.session();
  expect((await (await session.submit('Read.')).wait()).finalOutput).toBe(
    'done',
  );
  expect(captured).toBeDefined();
  const wire = JSON.parse(captured!.raw);
  expect(wire.response.contentItems).toEqual([
    { type: 'inputFile', file_id: 'accepted-file' },
  ]);
  wire.response.contentItems = [
    { type: 'inputImage', imageUrl: image, detail: 'low' },
  ];
  await expect(
    respond.call(captured!.native, JSON.stringify(wire)),
  ).resolves.toBe(false);
  expect(effects).toBe(1);
  expect(model.requests).toHaveLength(2);
  model.assertExhausted();
  spy.mockRestore();
}, 30000);
