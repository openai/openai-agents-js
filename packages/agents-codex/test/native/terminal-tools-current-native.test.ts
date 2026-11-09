import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { NativeThread } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

async function fixture(steps: ConstructorParameters<typeof ModelServer>[0]) {
  const { NativeProvider } = await import('../../src');
  const server = new ModelServer(steps);
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-terminal-current',
    supportsWebsockets: false,
  });
  return { server, provider };
}
afterEach(async () => {
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'current-base terminal ownership',
  () => {
    it('T02 binds equal short names and repeated call IDs to the current captured generation', async () => {
      const { Agent, tool } = await import('../../src');
      const { server, provider: resource } = await fixture([
        [
          call('finish', {}, { callId: 'other', namespace: 'other' }),
          call('finish', {}, { callId: 'repeat', namespace: 'audit' }),
        ],
        [call('finish', {}, { callId: 'repeat', namespace: 'audit' })],
        [message('ordinary second result')],
      ]);
      await using provider = resource;
      const firstEffect = vi.fn(() => 'first terminal');
      const otherEffect = vi.fn(() => 'ordinary sibling');
      const nextEffect = vi.fn(() => 'second ordinary');
      const agent = new Agent({
        instructions: 'Run.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'finish',
            namespace: 'other',
            parameters: z.object({}),
            execute: otherEffect,
          }),
          tool({
            name: 'finish',
            namespace: 'audit',
            parameters: z.object({}),
            finishTurn: true,
            execute: firstEffect,
          }),
        ],
      });
      await using session = await agent.session();
      const first = await (await session.submit('First.')).wait();
      expect(first.finalOutput).toBe('first terminal');
      expect(first.toolCall).toMatchObject({
        callId: 'repeat',
        tool: { namespace: 'audit', name: 'finish' },
      });
      await session.update({
        tools: [
          tool({
            name: 'finish',
            namespace: 'audit',
            parameters: z.object({}),
            execute: nextEffect,
          }),
        ],
      });
      const second = await (await session.submit('Second.')).wait();
      expect(second.finalOutput).toBe('ordinary second result');
      expect(second.toolCall).toBeUndefined();
      expect(second.turn.turnId).not.toBe(first.turn.turnId);
      expect(firstEffect).toHaveBeenCalledTimes(1);
      expect(otherEffect).toHaveBeenCalledTimes(1);
      expect(nextEffect).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(3);
    });

    it('T04 keeps a successful terminal sibling pending until the current manual reply settles', async () => {
      const { Agent, tool, manualTool } = await import('../../src');
      const { server, provider: resource } = await fixture([
        [
          call('finish', {}, { callId: 'terminal' }),
          call('approve', {}, { callId: 'manual' }),
        ],
      ]);
      await using provider = resource;
      const effect = vi.fn(() => 'terminal value');
      const agent = new Agent({
        instructions: 'Run both.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: effect,
          }),
          manualTool({
            name: 'approve',
            description: 'Ask.',
            parameters: z.object({}),
            result: z.string(),
          }),
        ],
      });
      await using session = await agent.session();
      const turn = await session.submit('Run.');
      let settled = false;
      const result = turn.wait().finally(() => {
        settled = true;
      });
      for await (const event of session.events()) {
        if (event.type !== 'action_requested') continue;
        await vi.waitFor(() => expect(effect).toHaveBeenCalledTimes(1));
        expect(settled).toBe(false);
        await session.respond(event.reply('approved'));
        break;
      }
      expect((await result).finalOutput).toBe('terminal value');
      expect((await result).toolCall?.callId).toBe('terminal');
      expect(server.requests).toHaveLength(1);
    });

    it('T05 does not grant terminal authority to a function invoked inside a code cell', async () => {
      const { Agent, tool } = await import('../../src');
      const { server, provider: resource } = await fixture([
        [
          {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'cell',
            input: 'text(await tools.finish({}));',
          },
        ],
        [message('assistant after cell')],
      ]);
      await using provider = resource;
      const routes: unknown[] = [];
      const effect = vi.fn(
        (_args: unknown, context: { call?: { route: string } }) => {
          routes.push(context.call?.route);
          return 'cell value';
        },
      );
      const agent = new Agent({
        instructions: 'Use code.',
        model: 'gpt-5',
        provider,
        programmaticToolCalling: true,
        tools: [
          tool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: effect,
          }),
        ],
      });
      await using session = await agent.session();
      const result = await (await session.submit('Run.')).wait();
      expect(result.finalOutput).toBe('assistant after cell');
      expect(result.toolCall).toBeUndefined();
      expect(routes, JSON.stringify(server.requests[1]?.input)).toEqual([
        'code',
      ]);
      expect(effect).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(2);
    });

    it('T08 lets accepted steering discard a held direct candidate before reservation', async () => {
      const { Agent, tool } = await import('../../src');
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { server, provider: resource } = await fixture([
        [call('finish', {}, { callId: 'steered' })],
        [message('steered answer')],
      ]);
      await using provider = resource;
      const effect = vi.fn(() => 'obsolete candidate');
      const agent = new Agent({
        instructions: 'Run.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: effect,
            after: async (output) => {
              entered.resolve();
              await release.promise;
              return output;
            },
          }),
        ],
      });
      await using session = await agent.session();
      try {
        const turn = await session.submit('Run.');
        const result = turn.wait();
        await entered.promise;
        await turn.steer('Use the new instruction.');
        release.resolve();
        expect((await result).finalOutput).toBe('steered answer');
        expect((await result).toolCall).toBeUndefined();
        expect(effect).toHaveBeenCalledTimes(1);
        expect(server.requests).toHaveLength(2);
      } finally {
        release.resolve();
      }
    });

    it('T08 refuses a catalog replacement while its captured terminal callback is active', async () => {
      const { Agent, tool } = await import('../../src');
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const { server, provider: resource } = await fixture([
        [call('finish', {}, { callId: 'captured' })],
      ]);
      await using provider = resource;
      const effect = vi.fn(async () => {
        entered.resolve();
        await release.promise;
        return 'captured value';
      });
      const replacement = vi.fn(() => 'replacement');
      const agent = new Agent({
        instructions: 'Run.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: effect,
          }),
        ],
      });
      await using session = await agent.session();
      try {
        const turn = await session.submit('Run.');
        await entered.promise;
        await expect(
          session.update({
            tools: [
              tool({
                name: 'finish',
                parameters: z.object({}),
                finishTurn: true,
                execute: replacement,
              }),
            ],
          }),
        ).rejects.toThrow();
        release.resolve();
        expect((await turn.wait()).finalOutput).toBe('captured value');
        expect(effect).toHaveBeenCalledTimes(1);
        expect(replacement).not.toHaveBeenCalled();
        expect(server.requests).toHaveLength(1);
      } finally {
        release.resolve();
      }
    });

    it.each(['commit', 'flush'] as const)(
      'T08/T13 joins held terminal %s after forced cancellation without publishing SDK success',
      async (point) => {
        const { Agent, tool, fileSessionStore, TurnAborted } =
          await import('../../src');
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const directory = await mkdtemp(join(tmpdir(), 'terminal-cancel-'));
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const durable = fileSessionStore(directory);
        let terminal = false;
        const storage = {
          ...durable,
          commit: async (...args: Parameters<typeof durable.commit>) => {
            if (args[4].includes('"tool_completion":{')) {
              terminal = true;
              if (point === 'commit') {
                entered.resolve();
                await release.promise;
              }
            }
            await durable.commit(...args);
          },
          flush: async () => {
            if (terminal && point === 'flush') {
              entered.resolve();
              await release.promise;
            }
          },
        };
        const { server, provider: resource } = await fixture([
          [call('finish', {}, { callId: 'held-terminal' })],
        ]);
        await using provider = resource;
        const effect = vi.fn(() => 'accepted before cancellation');
        try {
          const agent = new Agent({
            instructions: 'Run.',
            model: 'gpt-5',
            provider,
            tools: [
              tool({
                name: 'finish',
                parameters: z.object({}),
                finishTurn: true,
                execute: effect,
              }),
            ],
          });
          await using session = await agent.session({ storage });
          const turn = await session.submit('Run.');
          let resultSettled = false;
          const result = turn
            .wait()
            .catch((error: unknown) => error)
            .finally(() => {
              resultSettled = true;
            });
          let successes = 0;
          let observationSettled = false;
          const observation = (async () => {
            for await (const event of turn.events())
              if (
                event.type === 'turn_finished' &&
                event.status === 'completed'
              )
                successes++;
          })()
            .catch(() => {})
            .finally(() => {
              observationSettled = true;
            });
          const restores: Array<{ mockRestore(): void }> = [];
          try {
            await entered.promise;
            const { binding } = await import('../../src/runtime/binding');
            const { NativeThread: Thread } = await binding();
            const requestStop = Thread.prototype._request_graph_stop;
            const reserved = Promise.withResolvers<void>();
            const settlementEntered = Promise.withResolvers<void>();
            let nativeSettled = false;
            const requestedStops: Array<{ scope: string; mode: string }> = [];
            restores.push(
              vi
                .spyOn(Thread.prototype, '_request_graph_stop')
                .mockImplementation(function (this: NativeThread, scope, mode) {
                  const receipt = requestStop.call(this, scope, mode);
                  const settle = receipt.settle.bind(receipt);
                  restores.push(
                    vi.spyOn(receipt, 'settle').mockImplementation(() => {
                      // Delegate first: admission means the real native settle returned its actual promise.
                      const pending = settle();
                      settlementEntered.resolve();
                      return pending.finally(() => {
                        nativeSettled = true;
                      });
                    }),
                  );
                  requestedStops.push({ scope, mode });
                  reserved.resolve();
                  return receipt;
                }),
            );
            let cancelled = false;
            const stop = turn.cancel().finally(() => {
              cancelled = true;
            });
            stop.catch(() => {});
            await reserved.promise;
            await settlementEntered.promise;
            expect(requestedStops).toEqual([{ scope: 'root', mode: 'force' }]);
            // Keep actual persistence held through an event-loop turn after native stop admission.
            await new Promise<void>((resolve) => setImmediate(resolve));
            expect(nativeSettled).toBe(false);
            expect(cancelled).toBe(false);
            expect(resultSettled).toBe(false);
            expect(observationSettled).toBe(false);
            expect(successes).toBe(0);
            release.resolve();
            await stop;
            expect(nativeSettled).toBe(true);
            expect(await result).toBeInstanceOf(TurnAborted);
            await observation;
            expect(successes).toBe(0);
            expect(effect).toHaveBeenCalledTimes(1);
            expect(server.requests).toHaveLength(1);
          } finally {
            release.resolve();
            for (const restore of restores.reverse()) restore.mockRestore();
          }
        } finally {
          release.resolve();
          await rm(directory, { recursive: true, force: true });
        }
      },
    );

    it.each([false, true])(
      'keeps a settled child terminal result valid after an admitted root profile change (beforeStep=%s)',
      async (withBeforeStep) => {
        const { Agent, NativeAgents, Environment, tool } =
          await import('../../src');
        const { startPublicExecutor } =
          await import('./fixtures/public-executor');
        const executor = await startPublicExecutor();
        const release = Promise.withResolvers<void>();
        try {
          let rootId: string | undefined;
          let rootRequests = 0;
          let childRequests = 0;
          const respond = (request: Record<string, any>) => {
            const id = JSON.parse(
              request.client_metadata['x-codex-turn-metadata'],
            ).thread_id as string;
            rootId ??= id;
            if (id !== rootId) {
              childRequests++;
              return [call('finish', {}, { callId: 'delayed-child-call' })];
            }
            rootRequests++;
            if (rootRequests === 1)
              return [
                call(
                  'spawn_agent',
                  { task_name: 'delayed_terminal_child', message: 'Finish.' },
                  { namespace: 'collaboration', callId: 'spawn' },
                ),
              ];
            return [message('root done')];
          };
          const { server, provider: resource } = await fixture(
            Array.from({ length: 5 }, () => respond),
          );
          await using provider = resource;
          const effect = vi.fn(async () => {
            await release.promise;
            return 'settled child';
          });
          const replacement = vi.fn(() => 'replacement must not replay');
          const nativeAgents = new NativeAgents(
            withBeforeStep ? { beforeStep: () => undefined } : {},
          );
          const finish = tool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: effect,
          });
          const destination = new Agent({
            name: 'Replacement',
            instructions: 'Use the replacement root catalog.',
            provider,
            model: 'gpt-5.6-terra',
            tools: [
              nativeAgents,
              tool({
                name: 'finish',
                parameters: z.object({}),
                execute: replacement,
              }),
            ],
          });
          const agent = new Agent({
            name: 'Original',
            instructions: 'Delegate.',
            model: 'gpt-5.6-terra',
            provider,
            tools: [nativeAgents, finish],
            handoffs: [destination],
          });
          const environment = new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
          });
          await using session = await agent.session({ environment });
          try {
            const rootResult = (await session.submit('Delegate.')).wait();
            let rootFailure: unknown;
            void rootResult.catch((error) => {
              rootFailure = error;
            });
            await vi.waitUntil(
              () => {
                if (rootFailure) throw rootFailure;
                return effect.mock.calls.length === 1;
              },
              { timeout: 10_000 },
            );
            const child = await vi.waitUntil(async () => {
              const members = await Array.fromAsync(session.subagents());
              return members.length === 1 && members[0].turn
                ? members[0]
                : false;
            });
            const childId = child.id;
            const captured = child.turn!;
            const terminal = (async () => {
              for await (const event of captured.events())
                if (event.type === 'turn_finished') return event;
              throw new Error('Expected child terminal observation');
            })();
            release.resolve();
            expect(await terminal).toMatchObject({ status: 'completed' });
            expect((await rootResult).finalOutput).toBe('root done');
            // Activate a separately admitted catalog; do not mutate the live child's catalog.
            await session.update({ agent: destination });
            expect(await session.getActiveAgent()).toBe(destination);
            // Passive terminal observation does not consume the first result wait.
            const result = await captured.wait();
            expect(result.finalOutput).toBe('settled child');
            expect(result.toolCall).toMatchObject({
              callId: 'delayed-child-call',
              childId,
              turnId: captured.turnId,
            });
            expect(await captured.wait()).toBe(result);
            expect(effect).toHaveBeenCalledTimes(1);
            expect(effect).toHaveBeenCalledWith(
              {},
              expect.objectContaining({
                call: expect.objectContaining({
                  sessionId: session.id,
                  callId: 'delayed-child-call',
                  childId,
                  turnId: captured.turnId,
                  childIncarnation: result.toolCall!.childIncarnation,
                }),
              }),
            );
            expect(replacement).not.toHaveBeenCalled();
            expect(rootRequests).toBe(2);
            expect(childRequests).toBe(1);
            expect(server.requests).toHaveLength(3);
          } finally {
            release.resolve();
          }
        } finally {
          release.resolve();
          await executor.close();
        }
      },
      30_000,
    );

    it('T02/T10/T12/T14 isolates failed and saved child proposals from current owners', async () => {
      const { Agent, NativeAgents, Environment, ToolOutput, tool } =
        await import('../../src');
      const { OutputValidationError } =
        await import('../../src/runtime/output');
      const { startPublicExecutor } =
        await import('./fixtures/public-executor');
      const executor = await startPublicExecutor();
      // Enter cleanup ownership before model/provider/session setup can reject.
      try {
        let rootId: string | undefined;
        let rootRequests = 0;
        let childRequests = 0;
        let restoring = false;
        const respond = (request: Record<string, any>) => {
          const id = JSON.parse(
            request.client_metadata['x-codex-turn-metadata'],
          ).thread_id as string;
          rootId ??= id;
          if (id === rootId) {
            rootRequests++;
            return rootRequests === 1
              ? [
                  restoring
                    ? call(
                        'followup_task',
                        { target: childId!, message: 'Finish this new turn.' },
                        { namespace: 'collaboration', callId: 'resume-child' },
                      )
                    : call(
                        'spawn_agent',
                        { task_name: 'terminal_child', message: 'Finish.' },
                        { namespace: 'collaboration', callId: 'spawn' },
                      ),
                ]
              : [message('root done')];
          }
          childRequests++;
          return [call('finish', {}, { callId: 'repeated-child-call' })];
        };
        const { server, provider: resource } = await fixture(
          Array.from({ length: 7 }, () => respond),
        );
        await using provider = resource;
        const calls: unknown[] = [];
        const firstEntered = Promise.withResolvers<void>();
        const firstRelease = Promise.withResolvers<void>();
        const effect = vi.fn(
          async (_args: unknown, context: { call?: unknown }) => {
            calls.push(context.call);
            if (calls.length === 1) {
              firstEntered.resolve();
              await firstRelease.promise;
              return new ToolOutput([
                { type: 'inputText', text: 'one' },
                { type: 'inputText', text: 'two' },
              ]);
            }
            return 'replacement child result';
          },
        );
        const agent = new Agent({
          instructions: 'Delegate.',
          model: 'gpt-5.6-terra',
          provider,
          tools: [
            new NativeAgents(),
            tool({
              name: 'finish',
              parameters: z.object({}),
              finishTurn: true,
              execute: effect,
            }),
          ],
        });
        const environment = new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        });
        await using session = await agent.session({ environment });
        const rootResult = (await session.submit('Delegate.')).wait();
        const children = await (async () => {
          try {
            await firstEntered.promise;
            const captured = await vi.waitUntil(async () => {
              const children = await Array.fromAsync(session.subagents());
              return children.length === 1 && children[0].turn
                ? children
                : false;
            });
            // Capture the live owner before its failed reply retires the native turn.
            void captured[0].turn!.wait().catch(() => {});
            return captured;
          } finally {
            firstRelease.resolve();
          }
        })();
        expect((await rootResult).finalOutput).toBe('root done');
        const child = children[0];
        const childId = child.id;
        const first = child.turn!;
        await expect(first.wait()).rejects.toBeInstanceOf(
          OutputValidationError,
        );
        let firstSuccesses = 0;
        try {
          for await (const event of first.events())
            if (event.type === 'turn_finished' && event.status === 'completed')
              firstSuccesses++;
        } catch (error) {
          expect(error).toBeInstanceOf(OutputValidationError);
        }
        expect(firstSuccesses).toBe(0);
        const second = await child.submit('Finish this new turn.');
        expect(second.turnId).not.toBe(first.turnId);
        const result = await second.wait();
        expect(result.finalOutput).toBe('replacement child result');
        expect(result.toolCall).toMatchObject({
          callId: 'repeated-child-call',
          childId: child.id,
          turnId: second.turnId,
        });
        expect(calls[0]).toMatchObject({
          callId: 'repeated-child-call',
          childId: child.id,
          turnId: first.turnId,
        });
        expect(calls[1]).toMatchObject({
          callId: 'repeated-child-call',
          childId: child.id,
          turnId: second.turnId,
        });
        expect(effect).toHaveBeenCalledTimes(2);
        expect(rootRequests).toBe(2);
        expect(childRequests).toBe(2);
        expect(server.requests).toHaveLength(4);
        const state = await session.saveState();
        await session.close();
        await expect(child.submit('Stale captured owner.')).rejects.toThrow();
        expect(server.requests).toHaveLength(4);
        restoring = true;
        rootId = undefined;
        rootRequests = 0;
        await using restored = await agent.session({ environment, state });
        expect(restored.restoredTurn).toBeNull();
        expect(effect).toHaveBeenCalledTimes(2);
        expect(
          (await (await restored.submit('Resume the child.')).wait())
            .finalOutput,
        ).toBe('root done');
        const current = await vi.waitUntil(async () => {
          const members = await Array.fromAsync(restored.subagents());
          const member = members.find((item) => item.id === childId);
          return member?.turn && member.turn.turnId !== second.turnId
            ? member
            : false;
        });
        const resumed = await current.turn!.wait();
        expect(resumed.finalOutput).toBe('replacement child result');
        expect(resumed.toolCall).toMatchObject({
          callId: 'repeated-child-call',
          childId: current.id,
          turnId: current.turn!.turnId,
        });
        expect(resumed.toolCall?.childIncarnation).toBeTruthy();
        expect(resumed.toolCall?.childIncarnation).not.toBe(
          result.toolCall?.childIncarnation,
        );
        expect(effect).toHaveBeenCalledTimes(3);
        expect(rootRequests).toBe(2);
        expect(childRequests).toBe(3);
        expect(server.requests).toHaveLength(7);
      } finally {
        await executor.close();
      }
    }, 30_000);
    it.each([true, false])(
      'T02/T07 retains FunctionTool ownership across an application approval hook (allow=%s)',
      async (allow) => {
        const { Agent, tool } = await import('../../src');
        const entered = Promise.withResolvers<void>();
        const approval = Promise.withResolvers<void>();
        const { server, provider: resource } = await fixture(
          allow
            ? [[call('finish', {}, { callId: 'approved-function' })]]
            : [
                [call('finish', {}, { callId: 'denied-function' })],
                [message('denial handled normally')],
              ],
        );
        await using provider = resource;
        const effect = vi.fn(() => 'approved result');
        const agent = new Agent({
          instructions: 'Run.',
          model: 'gpt-5',
          provider,
          tools: [
            tool({
              name: 'finish',
              parameters: z.object({}),
              finishTurn: true,
              before: async () => {
                entered.resolve();
                await approval.promise;
                return allow
                  ? { action: 'allow' as const }
                  : { action: 'deny' as const, reason: 'application denied' };
              },
              execute: effect,
            }),
          ],
        });
        await using session = await agent.session();
        try {
          const turn = await session.submit('Run.');
          let settled = false;
          const result = turn.wait().finally(() => {
            settled = true;
          });
          await entered.promise;
          expect(effect).not.toHaveBeenCalled();
          expect(settled).toBe(false);
          approval.resolve();
          const completed = await result;
          expect(completed.finalOutput).toBe(
            allow ? 'approved result' : 'denial handled normally',
          );
          if (allow)
            expect(completed.toolCall?.callId).toBe('approved-function');
          else expect(completed.toolCall).toBeUndefined();
          expect(effect).toHaveBeenCalledTimes(allow ? 1 : 0);
          expect(server.requests).toHaveLength(allow ? 1 : 2);
        } finally {
          approval.resolve();
        }
      },
    );
  },
);
