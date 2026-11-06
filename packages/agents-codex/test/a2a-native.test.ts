import { createServer } from 'node:http';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, manualTool, tool } from '../src/index';
import { text, toolCall, withScriptedResponses } from '../src/testing/index';
import { AgentCard, Message, Part, Role, Task, TaskState } from '@a2a-js/sdk';
import {
  DefaultExecutionEventBus,
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import {
  NativeA2AExecutor,
  type NativeA2ABinding,
  type NativeA2AClaim,
} from '../src/a2a/executor';
import { connectA2A, type A2ALimits } from '../src/a2a/client';
import { inputProposal } from '../src/a2a/content';
import { FileA2AStore } from './a2a-store';
import { runA2AExample } from '../../../examples/codex/a2a/two-agents';
afterEach(() => vi.restoreAllMocks());

const user = { isAuthenticated: true, userName: 'user' };
const context = new ServerCallContext({ user, requestedVersion: '1.0' });

async function host(
  store: FileA2AStore,
  executor: AgentExecutor,
  limits?: A2ALimits,
) {
  const server = createServer(async (request, response) => {
    if (request.url === '/card') {
      response.end(JSON.stringify(AgentCard.toJSON(card)));
      return;
    }
    let body = '';
    for await (const chunk of request) body += chunk;
    const result = await rpc.handle(body, context);
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify(result));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error();
  const base = `http://127.0.0.1:${address.port}`;
  const card = AgentCard.fromJSON({
    name: 'native',
    version: '1',
    supportedInterfaces: [
      {
        url: `${base}/rpc`,
        protocolBinding: 'JSONRPC',
        protocolVersion: '1.0',
      },
    ],
  });
  const rpc = new JsonRpcTransportHandler(
    new DefaultRequestHandler(card, store, executor),
  );
  const client = await connectA2A(
    { name: 'native', cardUrl: `${base}/card`, rpcUrl: `${base}/rpc` },
    { authorization: async () => 'synthetic', limits },
  );
  return {
    client,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
async function settled(
  client: Awaited<ReturnType<typeof host>>['client'],
  task: Task,
): Promise<Task> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const current = await client.getTask({ tenant: '', id: task.id });
    if (current.status?.state !== TaskState.TASK_STATE_WORKING) return current;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('task did not settle');
}
const input = (parts: Part[], taskId = '', contextId = '') => ({
  tenant: '',
  metadata: undefined,
  configuration: undefined,
  message: {
    ...Message.fromJSON({}),
    messageId: crypto.randomUUID(),
    role: Role.ROLE_USER,
    taskId,
    contextId,
    parts,
  },
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'A2A with native Sessions and the official HTTP handler',
  () => {
    it.each([false, true])(
      'retires a fresh factory cancellation with commit failure=%s',
      async (commitFailure) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await withScriptedResponses([], async (model) => {
          const entered = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>();
          let owners = 0;
          class FreshStore extends FileA2AStore {
            override async own<T>(
              scope: NativeA2ABinding,
              run: (claim: NativeA2AClaim) => Promise<T>,
            ): Promise<T> {
              const owner = ++owners;
              return super.own(scope, (claim) =>
                run({
                  ...claim,
                  commit: async (expected, record) => {
                    if (owner === 2 && commitFailure)
                      throw new Error('retirement commit failed');
                    await claim.commit(expected, record);
                  },
                }),
              );
            }
          }
          const store = new FreshStore(),
            agent = new Agent({
              instructions: 'Answer.',
              model: 'gpt-5.5',
              provider: model.provider,
            });
          const sessions = vi.spyOn(agent, 'session');
          let cancel!: () => Promise<void>,
            taskId = '';
          const native = new NativeA2AExecutor({
            store,
            agentFactory: async (scope) => {
              taskId = scope.taskId;
              entered.resolve();
              await release.promise;
              return { agent, context: undefined };
            },
          });
          const remote = await host(store, {
            execute: async (request, bus) => {
              cancel = () => native.cancelTask(request.taskId, bus);
              await native.execute(request, bus);
            },
            cancelTask: native.cancelTask,
          });
          try {
            const sending = remote.client
              .sendMessage(input([Part.fromJSON({ text: 'fresh' })]))
              .then(
                (value) => ({ value }),
                (error) => ({ error }),
              );
            await entered.promise;
            // The host has the task ID from its factory before the official handler can expose a Task.
            expect(await store.load(taskId, context)).toBeUndefined();
            const cancellation = cancel().then(
              () => true,
              () => false,
            );
            release.resolve();
            expect(await cancellation).toBe(!commitFailure);
            const result = await sending;
            if (commitFailure) {
              expect('error' in result).toBe(true);
              expect(store.record(taskId, context)).toBeUndefined();
            } else {
              expect(
                'value' in result &&
                  'id' in result.value &&
                  result.value.status?.state,
              ).toBe(TaskState.TASK_STATE_CANCELED);
              const record = store.record(taskId, context)!;
              expect(record.state).toBe('canceled');
              expect(record.generation).toBe(1);
              expect(record.checkpoint).toBeUndefined();
              expect(record.desired.history[0].parts[0].content).toEqual({
                $case: 'text',
                value: 'fresh',
              });
              expect(await store.load(taskId, context)).toEqual(record.desired);
              await native.recover(record.binding, context);
              expect(store.record(taskId, context)).toEqual(record);
            }
            expect(sessions).not.toHaveBeenCalled();
            expect(model.requests).toHaveLength(0);
          } finally {
            release.resolve();
            await remote.close();
          }
        });
      },
      30000,
    );

    it.each(
      ['completion', 'execution failure', 'cancellation'].flatMap((phase) =>
        [false, true].map((closeFailure) => ({ phase, closeFailure })),
      ),
    )(
      'publishes the durable $phase outcome with close failure=$closeFailure',
      async ({ phase, closeFailure }) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await withScriptedResponses(
          phase === 'completion'
            ? [[text('done')]]
            : phase === 'execution failure'
              ? [
                  [
                    toolCall('decision', {}, { callId: 'one' }),
                    toolCall('decision', {}, { callId: 'two' }),
                  ],
                ]
              : [[toolCall('work', {}, { callId: 'work' })]],
          async (model) => {
            const entered = Promise.withResolvers<void>(),
              stopped = Promise.withResolvers<void>();
            const store = new FileA2AStore();
            const decision = manualTool({
              name: 'decision',
              description: 'Choose.',
              parameters: z.strictObject({}),
              result: z.boolean(),
            });
            const work = tool({
              name: 'work',
              description: 'Wait.',
              parameters: z.strictObject({}),
              execute: async (_args, ctx) => {
                entered.resolve();
                await new Promise<void>((resolve) => {
                  if (ctx.signal.aborted) resolve();
                  else
                    ctx.signal.addEventListener('abort', () => resolve(), {
                      once: true,
                    });
                });
                ctx.signal.throwIfAborted();
                return 'unexpected';
              },
            });
            const agent = new Agent({
              instructions: 'Work.',
              model: 'gpt-5.5',
              provider: model.provider,
              tools:
                phase === 'execution failure'
                  ? [decision]
                  : phase === 'cancellation'
                    ? [work]
                    : [],
            });
            const open = agent.session.bind(agent);
            const sessions = vi
              .spyOn(agent, 'session')
              .mockImplementation(async (options) => {
                const session = await open(options),
                  close = session.close.bind(session);
                if (closeFailure)
                  vi.spyOn(session, 'close').mockImplementation(async () => {
                    await close();
                    throw new Error('private retained close failure');
                  });
                return session;
              });
            const native = new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            });
            let ownerFailure: unknown;
            const remote = await host(store, {
              execute: async (request, bus) => {
                try {
                  await native.execute(request, bus);
                } catch (error) {
                  ownerFailure = error;
                  throw error;
                } finally {
                  stopped.resolve();
                }
              },
              cancelTask: native.cancelTask,
            });
            try {
              const created = await remote.client.sendMessage(
                input([Part.fromJSON({ text: 'begin' })]),
              );
              if (!('id' in created)) throw new Error('Expected Task');
              if (phase === 'cancellation') {
                await entered.promise;
                const cancellation = remote.client.cancelTask({
                  tenant: '',
                  id: created.id,
                  metadata: undefined,
                });
                if (closeFailure) await expect(cancellation).rejects.toThrow();
                else
                  expect((await cancellation).status?.state).toBe(
                    TaskState.TASK_STATE_CANCELED,
                  );
              }
              await stopped.promise;
              const record = store.record(created.id, context)!;
              expect(record.state).toBe(
                closeFailure
                  ? 'unknown'
                  : phase === 'completion'
                    ? 'completed'
                    : phase === 'cancellation'
                      ? 'canceled'
                      : 'failed',
              );
              expect(record.desired.status?.state).toBe(
                closeFailure || phase === 'execution failure'
                  ? TaskState.TASK_STATE_FAILED
                  : phase === 'completion'
                    ? TaskState.TASK_STATE_COMPLETED
                    : TaskState.TASK_STATE_CANCELED,
              );
              if (closeFailure) {
                expect(ownerFailure).toBeDefined();
                expect(record.desired.metadata?.['agents.a2a.outcome']).toBe(
                  'unknown',
                );
                expect(record.checkpoint).toBeUndefined();
                expect(
                  JSON.stringify(Task.toJSON(record.desired)),
                ).not.toContain('private retained close failure');
                await expect(
                  remote.client.cancelTask({
                    tenant: '',
                    id: created.id,
                    metadata: undefined,
                  }),
                ).rejects.toThrow();
                await expect(
                  native.cancelTask(created.id, new DefaultExecutionEventBus()),
                ).rejects.toThrow();
                await native.recover(record.binding, context);
                expect(store.record(created.id, context)).toEqual(record);
              }
              expect(await store.load(created.id, context)).toEqual(
                record.desired,
              );
              expect(sessions).toHaveBeenCalledTimes(1);
              expect(model.requests).toHaveLength(1);
            } finally {
              await remote.close();
            }
          },
        );
      },
      30000,
    );

    class FormattedValue {
      constructor(readonly localValue: number) {}

      toJSON() {
        return { value: this.localValue };
      }
    }

    const valueSchema = z.strictObject({ value: z.number().int() });
    it.each([
      { name: 'native object', outputType: valueSchema },
      {
        name: 'prompted object with a JSON serializer',
        outputType: {
          mode: 'prompted' as const,
          schema: valueSchema.transform(
            ({ value }) => new FormattedValue(value),
          ),
        },
      },
    ])(
      'publishes the JSON result of a $name over HTTP',
      async ({ outputType }) => {
        await withScriptedResponses([[text('{"value":7}')]], async (model) => {
          const store = new FileA2AStore();
          const agent = new Agent<undefined, unknown>({
            instructions: 'Return a value.',
            model: 'gpt-5.5',
            provider: model.provider,
            outputType,
          });
          const remote = await host(
            store,
            new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            }),
          );
          try {
            const created = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'begin' })]),
            );
            if (!('id' in created)) throw new Error();
            const completed = await settled(remote.client, created);
            expect(completed.artifacts[0].parts[0].content).toEqual({
              $case: 'data',
              value: { result: { value: 7 } },
            });
          } finally {
            await remote.close();
          }
        });
      },
      30_000,
    );

    it('exports each remote native dispatch beneath the original coordinator tool span across HTTP', async () => {
      type Span = {
        name: string;
        traceId: string;
        spanId: string;
        parentSpanId?: string;
        attributes: { key: string; value: Record<string, unknown> }[];
      };
      const spans: Span[] = [];
      const collector = createServer(async (request, response) => {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(Buffer.from(chunk));
        const payload = JSON.parse(Buffer.concat(chunks).toString());
        for (const resource of payload.resourceSpans ?? [])
          for (const scope of resource.scopeSpans ?? [])
            spans.push(...scope.spans);
        response
          .writeHead(200, { 'content-type': 'application/json' })
          .end('{}');
      });
      collector.listen(0, '127.0.0.1');
      await once(collector, 'listening');
      const address = collector.address();
      if (!address || typeof address === 'string') throw new Error();
      try {
        const child = spawn(
          process.execPath,
          [
            '--import',
            'tsx',
            fileURLToPath(new URL('./fixtures/a2a-trace.ts', import.meta.url)),
            `http://127.0.0.1:${address.port}/v1/traces`,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        );
        let output = '',
          error = '';
        child.stdout.on('data', (chunk) => {
          output += chunk;
        });
        child.stderr.on('data', (chunk) => {
          error += chunk;
        });
        const [code] = await once(child, 'close');
        expect(code, error).toBe(0);
        expect(JSON.parse(output).result).toBe('Both remote agents replied.');
        const attributes = (span: Span) =>
          Object.fromEntries(
            span.attributes.map((entry) => [
              entry.key,
              Object.values(entry.value)[0],
            ]),
          );
        const descendsFromCall = (span: Span, callId: string) => {
          const seen = new Set<string>();
          let current: Span | undefined = span;
          while (current && !seen.has(current.spanId)) {
            seen.add(current.spanId);
            if (attributes(current).call_id === callId) return true;
            current = spans.find(
              (candidate) =>
                candidate.spanId === current!.parentSpanId &&
                candidate.traceId === current!.traceId,
            );
          }
          return false;
        };
        const dispatches = spans.filter((span) =>
          span.name.startsWith('op.dispatch.'),
        );
        for (const callId of ['alpha-invocation', 'beta-invocation']) {
          const remote = dispatches.filter((span) =>
            descendsFromCall(span, callId),
          );
          expect(remote).toHaveLength(1);
          expect(remote[0].parentSpanId).toBeTruthy();
        }
      } finally {
        collector.closeAllConnections();
        await new Promise<void>((resolve) => collector.close(() => resolve()));
      }
    }, 30_000);

    it.each(
      (['before-save', 'after-save'] as const).flatMap((fault) =>
        (['completed', 'waiting'] as const).map((state) => ({ fault, state })),
      ),
    )(
      'reports $state publication failure and recovers after an official handler $fault fault',
      async ({ fault, state }) => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        await withScriptedResponses(
          state === 'completed'
            ? [[text('once')]]
            : [[toolCall('decision', {}, { callId: 'decision' })]],
          async (model) => {
            const directory = await mkdtemp(join(tmpdir(), 'a2a-publication-'));
            const path = join(directory, 'store.json');
            let injected = false;
            class FaultStore extends FileA2AStore {
              override async save(task: Task, callContext: ServerCallContext) {
                if (
                  task.status?.state ===
                    (state === 'completed'
                      ? TaskState.TASK_STATE_COMPLETED
                      : TaskState.TASK_STATE_INPUT_REQUIRED) &&
                  !injected
                ) {
                  injected = true;
                  this.fail = fault;
                }
                return super.save(task, callContext);
              }
            }
            const store = new FaultStore(path),
              stopped = Promise.withResolvers<void>();
            const agent = new Agent({
              instructions: 'Answer.',
              model: 'gpt-5.5',
              provider: model.provider,
              tools:
                state === 'waiting'
                  ? [
                      manualTool({
                        name: 'decision',
                        description: 'Choose.',
                        parameters: z.strictObject({}),
                        result: z.boolean(),
                      }),
                    ]
                  : [],
            });
            const native = new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            });
            let ownerFailure: unknown;
            const remote = await host(store, {
              execute: async (request, bus) => {
                try {
                  await native.execute(request, bus);
                } catch (error) {
                  ownerFailure = error;
                  throw error;
                } finally {
                  stopped.resolve();
                }
              },
              cancelTask: native.cancelTask,
            });
            try {
              const created = await remote.client.sendMessage(
                input([Part.fromJSON({ text: 'begin' })]),
              );
              if (!('id' in created)) throw new Error();
              await stopped.promise;
              expect(ownerFailure).toMatchObject({ reason: 'unavailable' });
              expect(injected).toBe(true);
              expect(errors).toHaveBeenCalled();
              const record = store.record(created.id, context)!;
              expect(record.state).toBe(state);
              expect(model.requests).toHaveLength(1);
              await remote.close();
              const child = spawnSync(
                process.execPath,
                [
                  '--import',
                  'tsx',
                  fileURLToPath(
                    new URL('./fixtures/a2a-recover.ts', import.meta.url),
                  ),
                  path,
                  created.id,
                  created.contextId,
                ],
                { encoding: 'utf8', timeout: 20_000 },
              );
              expect(child.status, child.stderr).toBe(0);
              const recovered = JSON.parse(child.stdout.trim());
              expect(recovered.executions).toBe(0);
              expect(recovered.task).toEqual(Task.toJSON(record.desired));
              expect(recovered.task.artifacts ?? []).toHaveLength(
                state === 'completed' ? 1 : 0,
              );
              expect(recovered.record.state).toBe(state);
              expect(model.requests).toHaveLength(1);
            } finally {
              await remote.close();
              await rm(directory, { recursive: true, force: true });
            }
          },
        );
      },
      30_000,
    );

    it.each(['completed', 'waiting'] as const)(
      'preserves a committed %s publication failure when cancellation races its save',
      async (state) => {
        vi.spyOn(console, 'error').mockImplementation(() => {});
        await withScriptedResponses(
          state === 'completed'
            ? [[text('once')]]
            : [[toolCall('decision', {}, { callId: 'decision' })]],
          async (model) => {
            const entering = Promise.withResolvers<void>(),
              release = Promise.withResolvers<void>(),
              cancelling = Promise.withResolvers<void>(),
              stopped = Promise.withResolvers<void>();
            let injected = false,
              ownerFailure: unknown;
            class HeldSaveStore extends FileA2AStore {
              override async save(task: Task, callContext: ServerCallContext) {
                if (
                  !injected &&
                  task.status?.state ===
                    (state === 'completed'
                      ? TaskState.TASK_STATE_COMPLETED
                      : TaskState.TASK_STATE_INPUT_REQUIRED)
                ) {
                  injected = true;
                  entering.resolve();
                  await release.promise;
                  this.fail = 'before-save';
                }
                return super.save(task, callContext);
              }
            }
            const store = new HeldSaveStore();
            const agent = new Agent({
              instructions: 'Answer.',
              model: 'gpt-5.5',
              provider: model.provider,
              tools:
                state === 'waiting'
                  ? [
                      manualTool({
                        name: 'decision',
                        description: 'Choose.',
                        parameters: z.strictObject({}),
                        result: z.boolean(),
                      }),
                    ]
                  : [],
            });
            const native = new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            });
            const remote = await host(store, {
              execute: async (request, bus) => {
                try {
                  await native.execute(request, bus);
                } catch (error) {
                  ownerFailure = error;
                  throw error;
                } finally {
                  stopped.resolve();
                }
              },
              cancelTask: (id, bus) => {
                const pending = native.cancelTask(id, bus);
                cancelling.resolve();
                return pending;
              },
            });
            try {
              const created = await remote.client.sendMessage(
                input([Part.fromJSON({ text: 'begin' })]),
              );
              if (!('id' in created)) throw new Error('Expected task');
              await entering.promise;
              const retained = store.record(created.id, context)!;
              expect(retained.state).toBe(state);
              const cancellation = remote.client
                .cancelTask({ tenant: '', id: created.id, metadata: undefined })
                .catch((error: unknown) => error);
              await cancelling.promise;
              release.resolve();
              await stopped.promise;
              expect(ownerFailure).toMatchObject({ reason: 'unavailable' });
              expect(await cancellation).toMatchObject({
                reason: 'unavailable',
              });
              expect(store.record(created.id, context)).toEqual(retained);
              expect(model.requests).toHaveLength(1);
            } finally {
              release.resolve();
              await remote.close();
            }
          },
        );
      },
      30000,
    );

    it.each(['completed', 'waiting'] as const)(
      'bounds the full %s wire Task before its journal commit',
      async (state) => {
        const large = 'r'.repeat(6000);
        await withScriptedResponses(
          state === 'completed'
            ? [[text(large)]]
            : [
                [
                  toolCall(
                    'decision',
                    { payload: large },
                    { callId: 'decision' },
                  ),
                ],
              ],
          async (model) => {
            const store = new FileA2AStore();
            const agent = new Agent({
              instructions: 'Answer.',
              model: 'gpt-5.5',
              provider: model.provider,
              tools:
                state === 'waiting'
                  ? [
                      manualTool({
                        name: 'decision',
                        description: 'Choose.',
                        parameters: z.strictObject({ payload: z.string() }),
                        result: z.boolean(),
                      }),
                    ]
                  : [],
            });
            const remote = await host(
              store,
              new NativeA2AExecutor({
                store,
                limits: { bodyBytes: 8192 },
                agentFactory: async () => ({ agent, context: undefined }),
              }),
              { bodyBytes: 8192 },
            );
            try {
              const created = await remote.client.sendMessage(
                input([Part.fromJSON({ text: 'i'.repeat(4096) })]),
              );
              if (!('id' in created)) throw new Error('Expected task');
              const failed = await settled(remote.client, created);
              expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED);
              expect(
                Buffer.byteLength(JSON.stringify(Task.toJSON(failed))),
              ).toBeLessThanOrEqual(8192);
              const record = store.record(created.id, context)!;
              expect(record.state).toBe('failed');
              expect(record.checkpoint).toBeUndefined();
              expect(record.desired.artifacts).toEqual([]);
              expect(model.requests).toHaveLength(1);
            } finally {
              await remote.close();
            }
          },
        );
      },
      30000,
    );

    it('converts a resumed manual answer once and preserves invalid-answer retry', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      await withScriptedResponses(
        [
          [toolCall('decision', {}, { callId: 'decision' })],
          [text('accepted')],
        ],
        async (model) => {
          let conversions = 0;
          const decision = manualTool({
            name: 'decision',
            description: 'Choose.',
            parameters: z.strictObject({}),
            result: z
              .number()
              .min(1)
              .transform(() => `admitted-result-${++conversions}`),
          });
          const store = new FileA2AStore();
          const agent = new Agent({
            instructions: 'Ask.',
            model: 'gpt-5.5',
            provider: model.provider,
            tools: [decision],
          });
          const remote = await host(
            store,
            new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            }),
          );
          try {
            const created = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'begin' })]),
            );
            if (!('id' in created)) throw new Error('Expected task');
            const waiting = await settled(remote.client, created);
            const proposal = inputProposal(waiting)!;
            const before = store.record(waiting.id, context)!;
            const answer = (result: number) =>
              remote.client.sendMessage(
                input(
                  [
                    Part.fromJSON({
                      data: {
                        challenge: proposal.challenge,
                        generation: proposal.generation,
                        result,
                      },
                    }),
                  ],
                  waiting.id,
                  waiting.contextId,
                ),
              );
            await expect(answer(0)).rejects.toThrow();
            expect(store.record(waiting.id, context)).toEqual(before);
            expect(conversions).toBe(0);
            expect(model.requests).toHaveLength(1);
            const updated = await answer(3);
            if (!('id' in updated)) throw new Error('Expected task');
            const done = await settled(remote.client, updated);
            expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
            expect(conversions).toBe(1);
            expect(model.requests).toHaveLength(2);
            const outputs = model.requests[1].input as {
              type?: string;
              call_id?: string;
              output?: unknown;
            }[];
            const delivered = outputs.find(
              (item) =>
                item.type === 'function_call_output' &&
                item.call_id === 'decision',
            );
            expect(delivered).toBeDefined();
            expect(JSON.stringify(delivered!.output)).toContain(
              'admitted-result-1',
            );
            expect(JSON.stringify(delivered!.output)).not.toContain(
              'admitted-result-2',
            );
          } finally {
            await remote.close();
          }
        },
      );
    }, 30000);

    it('rejects multiple pending manual requests without saving a resumable checkpoint', async () => {
      await withScriptedResponses(
        [
          [
            toolCall('decision', {}, { callId: 'first' }),
            toolCall('decision', {}, { callId: 'second' }),
          ],
        ],
        async (model) => {
          const decision = manualTool({
            name: 'decision',
            description: 'Choose.',
            parameters: z.strictObject({}),
            result: z.boolean(),
          });
          const store = new FileA2AStore(),
            agent = new Agent({
              instructions: 'Ask.',
              model: 'gpt-5.5',
              provider: model.provider,
              tools: [decision],
            });
          const remote = await host(
            store,
            new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            }),
          );
          try {
            const created = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'begin' })]),
            );
            if (!('id' in created)) throw new Error();
            const failed = await settled(remote.client, created);
            expect(failed.status?.state).toBe(TaskState.TASK_STATE_FAILED);
            expect(
              store.record(failed.id, context)?.checkpoint,
            ).toBeUndefined();
            expect(model.requests).toHaveLength(1);
          } finally {
            await remote.close();
          }
        },
      );
    }, 30_000);

    it('runs the native coordinator with two independently hosted targets selected from 500 entries', async () => {
      expect(await runA2AExample()).toBe('Both remote agents replied.');
    }, 30_000);
    it('resumes a persisted manual checkpoint in a fresh native worker process', async () => {
      await withScriptedResponses(
        [
          [toolCall('decision', {}, { callId: 'decision' })],
          [text('approved')],
        ],
        async (model) => {
          const directory = await mkdtemp(join(tmpdir(), 'a2a-fresh-worker-'));
          const path = join(directory, 'store.json'),
            store = new FileA2AStore(path);
          const decision = manualTool({
            name: 'decision',
            description: 'Choose.',
            parameters: z.strictObject({}),
            result: z.boolean(),
          });
          const agent = new Agent({
            instructions: 'Ask for a decision.',
            model: 'gpt-5.5',
            provider: model.provider,
            tools: [decision],
          });
          const remote = await host(
            store,
            new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            }),
          );
          try {
            const created = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'begin' })]),
            );
            if (!('id' in created)) throw new Error();
            const waiting = await settled(remote.client, created);
            const pending = inputProposal(waiting)!;
            await remote.close();
            const child = spawn(
              process.execPath,
              [
                '--import',
                'tsx',
                fileURLToPath(
                  new URL('./fixtures/a2a-resume.ts', import.meta.url),
                ),
                path,
                model.provider.baseUrl!,
                waiting.id,
                waiting.contextId,
                pending.challenge,
                String(pending.generation),
              ],
              { stdio: ['ignore', 'pipe', 'pipe'] },
            );
            let output = '',
              error = '';
            child.stdout.on('data', (chunk) => {
              output += chunk;
            });
            child.stderr.on('data', (chunk) => {
              error += chunk;
            });
            const [code] = await once(child, 'close');
            expect(code, error).toBe(0);
            expect(JSON.parse(output).state).toBe('completed');
            expect(model.requests).toHaveLength(2);
            expect(
              new FileA2AStore(path).record(waiting.id, context)?.checkpoint,
            ).toBeUndefined();
          } finally {
            await remote.close();
            await rm(directory, { recursive: true, force: true });
          }
        },
      );
    }, 30_000);
    it('cancels an ordinary callback and joins cleanup before the remote acknowledgment', async () => {
      await withScriptedResponses(
        [[toolCall('work', {}, { callId: 'work' })]],
        async (model) => {
          const entered = Promise.withResolvers<void>(),
            aborted = Promise.withResolvers<void>(),
            cleanup = Promise.withResolvers<void>();
          const work = tool({
            name: 'work',
            description: 'Wait for cancellation.',
            parameters: z.strictObject({}),
            execute: async (_args, toolContext) => {
              entered.resolve();
              if (toolContext.signal.aborted) aborted.resolve();
              else
                toolContext.signal.addEventListener(
                  'abort',
                  () => aborted.resolve(),
                  { once: true },
                );
              await aborted.promise;
              await cleanup.promise;
              return 'stopped';
            },
          });
          const store = new FileA2AStore(),
            agent = new Agent({
              instructions: 'Call work.',
              model: 'gpt-5.5',
              provider: model.provider,
              tools: [work],
            });
          const remote = await host(
            store,
            new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            }),
          );
          try {
            const created = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'begin' })]),
            );
            if (!('id' in created)) throw new Error();
            await entered.promise;
            let acknowledged = false;
            const cancellation = remote.client
              .cancelTask({ tenant: '', id: created.id, metadata: undefined })
              .then((result) => {
                acknowledged = true;
                return result;
              });
            await aborted.promise;
            expect(acknowledged).toBe(false);
            cleanup.resolve();
            expect((await cancellation).status?.state).toBe(
              TaskState.TASK_STATE_CANCELED,
            );
            expect(store.record(created.id, context)?.state).toBe('canceled');
          } finally {
            cleanup.resolve();
            await remote.close();
          }
        },
      );
    }, 30_000);

    it('cancels a settled manual request through the retained official bus', async () => {
      await withScriptedResponses(
        [[toolCall('decision', {}, { callId: 'decision' })]],
        async (model) => {
          const decision = manualTool({
            name: 'decision',
            description: 'Choose.',
            parameters: z.strictObject({}),
            result: z.boolean(),
          });
          const store = new FileA2AStore(),
            agent = new Agent({
              instructions: 'Ask.',
              model: 'gpt-5.5',
              provider: model.provider,
              tools: [decision],
            });
          const remote = await host(
            store,
            new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            }),
          );
          try {
            const created = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'begin' })]),
            );
            if (!('id' in created)) throw new Error();
            const waiting = await settled(remote.client, created);
            expect(waiting.status?.state).toBe(
              TaskState.TASK_STATE_INPUT_REQUIRED,
            );
            expect(
              (
                await remote.client.cancelTask({
                  tenant: '',
                  id: waiting.id,
                  metadata: undefined,
                })
              ).status?.state,
            ).toBe(TaskState.TASK_STATE_CANCELED);
            expect(
              store.record(waiting.id, context)?.checkpoint,
            ).toBeUndefined();
            expect(model.requests).toHaveLength(1);
          } finally {
            await remote.close();
          }
        },
      );
    }, 30_000);

    it.each([
      'retire',
      'recovered worker',
      'recovered load',
      'claim failure',
      'commit failure',
      'binding mismatch',
      'desired task mismatch',
      'desired context mismatch',
      'missing record',
      'nonwaiting record',
    ] as const)(
      'cancels a waiting follow-up before Session ownership: %s',
      async (mode) => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        const recovered =
          mode === 'recovered worker' || mode === 'recovered load';
        const continuationOwner = recovered ? 3 : 2;
        const retirementOwner = continuationOwner + 1;
        const succeeds = mode === 'retire' || recovered;
        await withScriptedResponses(
          [[toolCall('decision', {}, { callId: 'decision' })]],
          async (model) => {
            const entering = Promise.withResolvers<void>(),
              release = Promise.withResolvers<void>(),
              cancelling = Promise.withResolvers<void>();
            let factories = 0,
              owners = 0,
              retirementCommits = 0;
            let stale: NativeA2AClaim | undefined;
            class HeldStore extends FileA2AStore {
              override async own<T>(
                scope: NativeA2ABinding,
                run: (claim: NativeA2AClaim) => Promise<T>,
              ): Promise<T> {
                const owner = ++owners;
                if (owner === retirementOwner && mode === 'claim failure')
                  throw new Error('claim unavailable');
                return super.own(scope, async (claim) => {
                  if (owner === continuationOwner) stale = claim;
                  return run({
                    ...claim,
                    load: async () => {
                      const record = await claim.load();
                      if (
                        owner === continuationOwner &&
                        mode === 'recovered load'
                      ) {
                        entering.resolve();
                        await release.promise;
                      }
                      if (owner === retirementOwner) {
                        if (mode === 'missing record') return undefined;
                        if (
                          mode === 'binding mismatch' ||
                          mode === 'desired task mismatch' ||
                          mode === 'desired context mismatch' ||
                          mode === 'nonwaiting record'
                        ) {
                          if (!record)
                            throw new Error('Missing fixture record');
                          if (mode === 'binding mismatch')
                            return {
                              ...record,
                              binding: {
                                ...record.binding,
                                principal: 'foreign',
                              },
                            };
                          if (
                            mode === 'desired task mismatch' ||
                            mode === 'desired context mismatch'
                          )
                            return {
                              ...record,
                              desired: {
                                ...record.desired,
                                ...(mode === 'desired task mismatch'
                                  ? { id: 'foreign-task' }
                                  : { contextId: 'foreign-context' }),
                              },
                            };
                          return { ...record, state: 'claimed' };
                        }
                      }
                      return record;
                    },
                    commit: async (expected, record) => {
                      if (owner === retirementOwner) {
                        retirementCommits++;
                        if (mode === 'commit failure')
                          throw new Error('commit unavailable');
                      }
                      await claim.commit(expected, record);
                    },
                  });
                });
              }
            }
            const store = new HeldStore(),
              agent = new Agent({
                instructions: 'Ask.',
                model: 'gpt-5.5',
                provider: model.provider,
                tools: [
                  manualTool({
                    name: 'decision',
                    description: 'Choose.',
                    parameters: z.strictObject({}),
                    result: z.boolean(),
                  }),
                ],
              });
            const sessions = vi.spyOn(agent, 'session');
            const createExecutor = () =>
              new NativeA2AExecutor({
                store,
                agentFactory: async () => {
                  if (++factories === 2) {
                    entering.resolve();
                    await release.promise;
                  }
                  return { agent, context: undefined };
                },
              });
            let native = createExecutor();
            const openRemote = () =>
              host(store, {
                execute: native.execute,
                cancelTask: async (id, bus) => {
                  const result = native.cancelTask(id, bus);
                  cancelling.resolve();
                  await result;
                },
              });
            let remote = await openRemote();
            try {
              const created = await remote.client.sendMessage(
                input([Part.fromJSON({ text: 'begin' })]),
              );
              if (!('id' in created)) throw new Error('Missing Task');
              const waiting = await settled(remote.client, created);
              expect(waiting.status?.state).toBe(
                TaskState.TASK_STATE_INPUT_REQUIRED,
              );
              const proposal = inputProposal(waiting)!;
              if (recovered) {
                await remote.close();
                native = createExecutor();
                await native.recover(
                  store.record(waiting.id, context)!.binding,
                  context,
                );
                expect(factories).toBe(1);
                expect(sessions).toHaveBeenCalledTimes(1);
                remote = await openRemote();
              }
              const following = remote.client
                .sendMessage(
                  input(
                    [
                      Part.fromJSON({
                        data: {
                          challenge: proposal.challenge,
                          generation: proposal.generation,
                          result: true,
                        },
                      }),
                    ],
                    waiting.id,
                    waiting.contextId,
                  ),
                )
                .then(
                  () => true,
                  () => false,
                );
              await entering.promise;
              const before = store.record(waiting.id, context)!;
              const canceled = remote.client
                .cancelTask({ tenant: '', id: waiting.id, metadata: undefined })
                .then(
                  (value) => ({ value }),
                  (error) => ({ error: String(error) }),
                );
              await cancelling.promise;
              release.resolve();
              const cancellation = await canceled;
              expect(await following).toBe(false);
              expect(errors).toHaveBeenCalled();
              const logs = errors.mock.calls.map((args) => args.map(String));
              if (succeeds) {
                expect(JSON.stringify(logs)).toContain('stale snapshot');
                expect(JSON.stringify(logs)).not.toContain(
                  'Agent execution failed',
                );
              }
              expect(owners).toBe(retirementOwner);
              expect(factories).toBe(mode === 'recovered load' ? 1 : 2);
              expect(sessions).toHaveBeenCalledTimes(1);
              expect(model.requests).toHaveLength(1);
              expect(retirementCommits).toBe(
                succeeds || mode === 'commit failure' ? 1 : 0,
              );
              if (succeeds) {
                expect(
                  'value' in cancellation && cancellation.value.status?.state,
                ).toBe(TaskState.TASK_STATE_CANCELED);
                const retired = store.record(waiting.id, context)!;
                expect(retired.state).toBe('canceled');
                expect(retired.checkpoint).toBeUndefined();
                expect(retired.pending).toBeUndefined();
                await expect(stale!.current()).rejects.toThrow('stale owner');
                await expect(
                  stale!.commit(before.generation, {
                    ...before,
                    generation: before.generation + 1,
                  }),
                ).rejects.toThrow('stale owner');
                expect(store.record(waiting.id, context)).toEqual(retired);
              } else {
                expect('error' in cancellation).toBe(true);
                expect(store.record(waiting.id, context)).toEqual(before);
              }
            } finally {
              release.resolve();
              await remote.close();
            }
          },
        );
      },
      30_000,
    );

    it('cancels after a waiting checkpoint commits but before its public acknowledgment', async () => {
      await withScriptedResponses(
        [[toolCall('decision', {}, { callId: 'decision' })]],
        async (model) => {
          const saving = Promise.withResolvers<void>(),
            release = Promise.withResolvers<void>(),
            cancelling = Promise.withResolvers<void>();
          class HeldStore extends FileA2AStore {
            override async save(task: Task, callContext: ServerCallContext) {
              if (task.status?.state === TaskState.TASK_STATE_INPUT_REQUIRED) {
                saving.resolve();
                await release.promise;
              }
              return super.save(task, callContext);
            }
          }
          const store = new HeldStore();
          const decision = manualTool({
            name: 'decision',
            description: 'Choose.',
            parameters: z.strictObject({}),
            result: z.boolean(),
          });
          const agent = new Agent({
            instructions: 'Ask.',
            model: 'gpt-5.5',
            provider: model.provider,
            tools: [decision],
          });
          const native = new NativeA2AExecutor({
            store,
            agentFactory: async () => ({ agent, context: undefined }),
          });
          const remote = await host(store, {
            execute: native.execute,
            cancelTask: async (id, bus) => {
              const result = native.cancelTask(id, bus);
              cancelling.resolve();
              await result;
            },
          });
          try {
            const created = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'begin' })]),
            );
            if (!('id' in created)) throw new Error();
            await saving.promise;
            expect(store.record(created.id, context)?.state).toBe('waiting');
            const canceled = remote.client.cancelTask({
              tenant: '',
              id: created.id,
              metadata: undefined,
            });
            await cancelling.promise;
            release.resolve();
            expect((await canceled).status?.state).toBe(
              TaskState.TASK_STATE_CANCELED,
            );
            expect(
              store.record(created.id, context)?.checkpoint,
            ).toBeUndefined();
            expect(model.requests).toHaveLength(1);
          } finally {
            release.resolve();
            await remote.close();
          }
        },
      );
    }, 30_000);

    it('completes independent Sessions sharing one remote conversation context', async () => {
      await withScriptedResponses(
        [[text('one')], [text('two')]],
        async (model) => {
          const store = new FileA2AStore();
          const agent = new Agent({
            instructions: 'Answer.',
            model: 'gpt-5.5',
            provider: model.provider,
          });
          const executor = new NativeA2AExecutor({
            store,
            agentFactory: async () => ({ agent, context: undefined }),
          });
          const remote = await host(store, executor);
          try {
            const first = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'first' })], '', 'shared'),
            );
            if (!('id' in first)) throw new Error();
            const done = await settled(remote.client, first);
            expect(done.status?.state).toBe(TaskState.TASK_STATE_COMPLETED);
            const second = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'second' })], '', 'shared'),
            );
            if (!('id' in second)) throw new Error();
            const next = await settled(remote.client, second);
            expect(next.id).not.toBe(done.id);
            expect(next.contextId).toBe(done.contextId);
            expect(next.artifacts[0].parts[0].content?.value).toBe('two');
            expect(JSON.stringify(model.requests[1])).not.toContain('first');
          } finally {
            await remote.close();
          }
        },
      );
    }, 30_000);

    it('restores one typed request, preserves an invalid challenge, and rejects repeated replies', async () => {
      const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
      await withScriptedResponses(
        [
          [toolCall('decision', {}, { callId: 'decision' })],
          [text('approved')],
        ],
        async (model) => {
          const directory = await mkdtemp(join(tmpdir(), 'a2a-native-'));
          const path = join(directory, 'store.json');
          const decision = manualTool({
            name: 'decision',
            description: 'Choose.',
            parameters: z.strictObject({}),
            result: z.boolean(),
          });
          const agent = new Agent({
            instructions: 'Ask for a decision.',
            model: 'gpt-5.5',
            provider: model.provider,
            tools: [decision],
          });
          let store = new FileA2AStore(path);
          let remote = await host(
            store,
            new NativeA2AExecutor({
              store,
              agentFactory: async () => ({ agent, context: undefined }),
            }),
          );
          try {
            const created = await remote.client.sendMessage(
              input([Part.fromJSON({ text: 'begin' })]),
            );
            if (!('id' in created)) throw new Error();
            const waiting = await settled(remote.client, created);
            expect(waiting.status?.state).toBe(
              TaskState.TASK_STATE_INPUT_REQUIRED,
            );
            const challenge = inputProposal(waiting)!;
            await remote.close();
            // The old native Session and event consumer are gone; reopen only the persisted host state.
            store = new FileA2AStore(path);
            remote = await host(
              store,
              new NativeA2AExecutor({
                store,
                agentFactory: async () => ({ agent, context: undefined }),
              }),
            );
            const reply = {
              challenge: challenge.challenge,
              generation: challenge.generation,
              result: 'invalid',
            };
            await expect(
              remote.client.sendMessage(
                input(
                  [Part.fromJSON({ data: reply })],
                  waiting.id,
                  waiting.contextId,
                ),
              ),
            ).rejects.toThrow();
            expect(errors).toHaveBeenCalled();
            expect(
              JSON.stringify(errors.mock.calls.map((args) => args.map(String))),
            ).not.toContain('"result":"invalid"');
            expect(store.record(waiting.id, context)?.state).toBe('waiting');
            expect(model.requests).toHaveLength(1);
            const answered = await remote.client.sendMessage(
              input(
                [Part.fromJSON({ data: { ...reply, result: true } })],
                waiting.id,
                waiting.contextId,
              ),
            );
            if (!('id' in answered)) throw new Error();
            const completed = await settled(remote.client, answered);
            expect(completed.status?.state).toBe(
              TaskState.TASK_STATE_COMPLETED,
            );
            expect(model.toolOutput('decision')).toContain('true');
            expect(
              store.record(waiting.id, context)?.checkpoint,
            ).toBeUndefined();
            await expect(
              remote.client.sendMessage(
                input(
                  [Part.fromJSON({ data: { ...reply, result: true } })],
                  waiting.id,
                  waiting.contextId,
                ),
              ),
            ).rejects.toThrow();
          } finally {
            await remote.close();
            await rm(directory, { recursive: true, force: true });
          }
        },
      );
    }, 30_000);
  },
);
