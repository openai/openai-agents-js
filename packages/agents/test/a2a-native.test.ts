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
  DefaultRequestHandler,
  JsonRpcTransportHandler,
  ServerCallContext,
  type AgentExecutor,
} from '@a2a-js/sdk/server';
import { NativeA2AExecutor } from '../src/a2a/executor';
import { connectA2A } from '../src/a2a/client';
import { inputProposal } from '../src/a2a/content';
import { FileA2AStore } from './a2a-store';
import { runA2AExample } from '../examples/a2a/two-agents';
afterEach(() => vi.restoreAllMocks());

const user = { isAuthenticated: true, userName: 'user' };
const context = new ServerCallContext({ user, requestedVersion: '1.0' });

async function host(store: FileA2AStore, executor: AgentExecutor) {
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
    { authorization: async () => 'synthetic' },
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
    it('publishes validated structured output with the shared result wrapper', async () => {
      await withScriptedResponses([[text('{"value":7}')]], async (model) => {
        const store = new FileA2AStore();
        const agent = new Agent({
          instructions: 'Return a value.',
          model: 'gpt-5.5',
          provider: model.provider,
          outputType: z.strictObject({ value: z.number().int() }),
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
    }, 30_000);

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

    it.each(['before-save', 'after-save'] as const)(
      'recovers a native terminal result in a fresh process after an official handler %s fault',
      async (fault) => {
        const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
        await withScriptedResponses([[text('once')]], async (model) => {
          const directory = await mkdtemp(join(tmpdir(), 'a2a-publication-'));
          const path = join(directory, 'store.json');
          let injected = false;
          class FaultStore extends FileA2AStore {
            override async save(task: Task, callContext: ServerCallContext) {
              if (
                task.status?.state === TaskState.TASK_STATE_COMPLETED &&
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
          });
          const native = new NativeA2AExecutor({
            store,
            agentFactory: async () => ({ agent, context: undefined }),
          });
          const remote = await host(store, {
            execute: async (request, bus) => {
              try {
                await native.execute(request, bus);
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
            expect(injected).toBe(true);
            expect(errors).toHaveBeenCalled();
            const record = store.record(created.id, context)!;
            expect(record.state).toBe('completed');
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
            expect(recovered.task.artifacts).toHaveLength(1);
            expect(model.requests).toHaveLength(1);
          } finally {
            await remote.close();
            await rm(directory, { recursive: true, force: true });
          }
        });
      },
      30_000,
    );

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
            expect(JSON.stringify(errors.mock.calls)).not.toContain(
              '"result":"invalid"',
            );
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
