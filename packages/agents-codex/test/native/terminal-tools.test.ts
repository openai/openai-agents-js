import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { captureTools, tool } from '../../src/runtime/tools';
import {
  parseToolCompletion,
  prepareOutput,
  OutputValidationError,
} from '../../src/runtime/output';
import {
  terminalCallInfo,
  toolCompletionSchema,
} from '../../src/runtime/call-metadata';
import { ModelServer, call, message } from './fixtures/model-server';
const text = (value: string) => [{ type: 'input_text', text: value }];

describe('terminal function capture and conversion', () => {
  it('T01 captures default-off immutable authority outside model schemas', () => {
    const options = {
      name: 'finish',
      parameters: z.object({}),
      finishTurn: true,
      execute: () => 'done',
    };
    const declaration = tool(options);
    const catalog = captureTools([declaration]);
    options.finishTurn = false;
    expect(catalog.tools[0].finishTurn).toBe(true);
    expect(Object.isFrozen(catalog.tools[0])).toBe(true);
    expect(catalog.specsJson).not.toContain('finishTurn');
    expect(
      captureTools([
        tool({
          name: 'ordinary',
          parameters: z.object({}),
          execute: () => 'ok',
        }),
      ]).tools[0].finishTurn,
    ).toBe(false);
    expect(() =>
      captureTools([{ ...declaration, finishTurn: 'yes' as never }]),
    ).toThrow('finishTurn must be a boolean');
  });
  it('T06 validates settled text once and keeps the converted in-memory value', () => {
    const validate = vi.fn((value: { answer: number }) => ({
      answer: value.answer + 1,
    }));
    const prepared = prepareOutput({
      mode: 'prompted',
      schema: z.object({ answer: z.number() }).transform(validate),
    });
    const converted = parseToolCompletion(prepared, text('{"answer":7}'));
    expect(converted.value).toEqual({ answer: 8 });
    expect(converted.json).toEqual({ answer: 8 });
    expect(validate).toHaveBeenCalledTimes(1);
  });
  it('T06 adapts native primitive wrappers without requiring the tool to return one', () => {
    expect(parseToolCompletion(prepareOutput(z.number()), text('7'))).toEqual({
      value: 7,
      json: 7,
    });
    expect(parseToolCompletion(prepareOutput(z.null()), 'null')).toEqual({
      value: null,
      json: null,
    });
    expect(
      parseToolCompletion(prepareOutput(undefined), text('{"answer":7}')),
    ).toEqual({ value: '{"answer":7}', json: '{"answer":7}' });
  });
  it('T06 rejects media and multiple items without discarding content', () => {
    const prepared = prepareOutput(undefined);
    for (const body of [
      [],
      [...text('one'), ...text('two')],
      [{ type: 'input_image', image_url: 'data:image/png;base64,AA==' }],
    ])
      expect(() => parseToolCompletion(prepared, body)).toThrow(
        OutputValidationError,
      );
  });
  it('T07 retains the owning output error and never invokes prompted repair', () => {
    const prepared = prepareOutput({
      mode: 'prompted',
      schema: z.object({ answer: z.number() }),
      maxRetries: 3,
    });
    expect(() => parseToolCompletion(prepared, text('invalid'))).toThrow(
      OutputValidationError,
    );
    const owned = new OutputValidationError('private');
    expect(() =>
      parseToolCompletion(
        {
          ...prepared,
          parse: () => {
            throw owned;
          },
        },
        text('{}'),
      ),
    ).toThrow(owned);
  });
  it('T06 fails unsupported validated values before native acceptance', () => {
    const prepared = prepareOutput({
      mode: 'prompted',
      schema: z.string().transform(() => undefined),
    });
    expect(() => parseToolCompletion(prepared, text('"value"'))).toThrow(
      OutputValidationError,
    );
  });
  it('T09 preserves exact observed identity without fabricating role or model', () => {
    const fact = toolCompletionSchema.parse({
      name: 'finish',
      call_id: 'same',
      final_output: null,
    });
    const info = terminalCallInfo(
      {
        sessionId: 'root',
        turnId: 'turn',
        childId: null,
        childIncarnation: null,
      },
      fact,
      null,
    );
    expect(info).toMatchObject({
      tool: { name: 'finish', namespace: null },
      turnId: 'turn',
      callId: 'same',
      route: 'direct',
      role: null,
      model: null,
    });
  });
});
afterEach(async () => {
  await ModelServer.closeAll();
});

// These cases require the addon rebuilt from the complete Core + bridge patch.
describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'terminal functions in native turns',
  () => {
    it('T14 restores a pending manual owner, then validates a fresh terminal function once', async () => {
      const { Agent, NativeProvider, manualTool, InteractionRequired } =
        await import('../../src');
      const server = new ModelServer([
        [
          call(
            'record',
            {},
            { namespace: 'audit', callId: 'record-before-manual' },
          ),
          call('lookup', {}, { callId: 'manual-before-terminal' }),
        ],
        [call('finish', {}, { callId: 'fresh-after-restore' })],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const record = vi.fn(() => 'recorded');
      const effect = vi.fn(() => ({ answer: 7 }));
      const validate = vi.fn((value: { answer: number }) => value);
      const agent = new Agent({
        instructions: 'Ask, then finish.',
        model: 'gpt-5',
        provider,
        outputType: {
          mode: 'prompted',
          schema: z.object({ answer: z.number() }).transform(validate),
        },
        tools: [
          tool({
            name: 'record',
            namespace: 'audit',
            parameters: z.object({}),
            execute: record,
          }),
          manualTool({
            name: 'lookup',
            description: 'Ask.',
            parameters: z.object({}),
            result: z.string(),
          }),
          tool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: effect,
          }),
        ],
      });
      const initial = await agent.session();
      const original = await initial.submit('Run.');
      const failure = original.wait().catch((error: unknown) => error);
      for await (const event of initial.events())
        if (event.type === 'action_requested') break;
      const state = await initial.suspend();
      expect(await failure).toBeInstanceOf(InteractionRequired);
      await initial.close();
      await using restored = await agent.session({ state });
      expect(validate).not.toHaveBeenCalled();
      expect(effect).not.toHaveBeenCalled();
      for await (const event of restored.events()) {
        if (event.type !== 'action_requested') continue;
        await restored.respond(event.reply('accepted'));
        break;
      }
      const result = await restored.restoredTurn!.wait();
      expect(result.turn.turnId).toBe(original.turnId);
      expect(result.finalOutput).toEqual({ answer: 7 });
      expect(result.toolCall?.callId).toBe('fresh-after-restore');
      expect(validate).toHaveBeenCalledTimes(1);
      expect(effect).toHaveBeenCalledTimes(1);
      expect(record).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(2);
    });

    it('T09 completes a structured root after one effect and one request', async () => {
      const { Agent, NativeProvider } = await import('../../src');
      const server = new ModelServer([
        [call('finish', {}, { callId: 'terminal-1', namespace: 'reports' })],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const effect = vi.fn(() => ({ answer: 7 }));
      const validate = vi.fn((value: { answer: number }) => value);
      const agent = new Agent({
        instructions: 'Finish.',
        model: 'gpt-5',
        provider,
        outputType: {
          mode: 'prompted',
          schema: z.object({ answer: z.number() }).transform(validate),
        },
        tools: [
          tool({
            name: 'finish',
            namespace: 'reports',
            parameters: z.object({}),
            finishTurn: true,
            execute: effect,
          }),
        ],
      });
      await using session = await agent.session();
      const result = await (await session.submit('Finish.')).wait();
      expect(result.finalOutput).toEqual({ answer: 7 });
      expect(result.toolCall).toMatchObject({
        tool: { name: 'finish', namespace: 'reports' },
        callId: 'terminal-1',
        route: 'direct',
      });
      expect(effect).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(1);
    });
    it('T01 keeps unflagged calls on the ordinary assistant path', async () => {
      const { Agent, NativeProvider } = await import('../../src');
      const server = new ModelServer([
        [call('ordinary', {}, { callId: 'ordinary-1' })],
        [message('assistant result')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const effect = vi.fn(() => 'tool result');
      const agent = new Agent({
        instructions: 'Run.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({ name: 'ordinary', parameters: z.object({}), execute: effect }),
        ],
      });
      await using session = await agent.session();
      const result = await (await session.submit('Run.')).wait();
      expect(result.finalOutput).toBe('assistant result');
      expect(result.toolCall).toBeUndefined();
      expect(effect).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(2);
    });
    it('T03 waits for every sibling and selects original model order after reverse callback completion', async () => {
      const { Agent, NativeProvider } = await import('../../src');
      const gate = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      const order: string[] = [];
      const server = new ModelServer([
        [
          call('first', {}, { callId: 'first-call' }),
          call('second', {}, { callId: 'second-call' }),
        ],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const agent = new Agent({
        instructions: 'Finish.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'first',
            parameters: z.object({}),
            finishTurn: true,
            execute: async () => {
              await gate.promise;
              order.push('first');
              return 'FIRST';
            },
          }),
          tool({
            name: 'second',
            parameters: z.object({}),
            finishTurn: true,
            execute: () => {
              order.push('second');
              second.resolve();
              return 'SECOND';
            },
          }),
        ],
      });
      await using session = await agent.session({ maxFunctionConcurrency: 2 });
      const turn = await session.submit('Finish.');
      let settled = false;
      const result = turn.wait().finally(() => {
        settled = true;
      });
      await second.promise;
      expect(settled).toBe(false);
      gate.resolve();
      expect((await result).finalOutput).toBe('FIRST');
      expect((await result).toolCall?.callId).toBe('first-call');
      expect(order).toEqual(['second', 'first']);
      expect(server.requests).toHaveLength(1);
    });

    it('T06 validates final after-hook content rather than callback output', async () => {
      const { Agent, NativeProvider, ToolOutput } = await import('../../src');
      const server = new ModelServer([
        [call('finish', {}, { callId: 'after-call' })],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const agent = new Agent({
        instructions: 'Finish.',
        model: 'gpt-5',
        provider,
        outputType: z.number(),
        tools: [
          tool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: () => 'invalid callback text',
            after: () => new ToolOutput([{ type: 'inputText', text: '7' }]),
          }),
        ],
      });
      await using session = await agent.session();
      expect((await (await session.submit('Finish.')).wait()).finalOutput).toBe(
        7,
      );
      expect(server.requests).toHaveLength(1);
    });

    it('T07 fails output validation without prompted repair or another request', async () => {
      const { Agent, NativeProvider } = await import('../../src');
      const server = new ModelServer([
        [call('finish', {}, { callId: 'invalid-call' })],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const effect = vi.fn(() => 'invalid JSON');
      const agent = new Agent({
        instructions: 'Finish.',
        model: 'gpt-5',
        provider,
        outputType: { mode: 'prompted', schema: z.number(), maxRetries: 3 },
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
      await expect(
        (await session.submit('Finish.')).wait(),
      ).rejects.toBeInstanceOf(OutputValidationError);
      expect(effect).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(1);
    });

    it('T14 preserves confirmed JSON terminal facts on idle restore without replay or conversion', async () => {
      const { Agent, NativeProvider } = await import('../../src');
      const server = new ModelServer([
        [call('finish', {}, { callId: 'restore-call' })],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const effect = vi.fn(() => ({ answer: 7 }));
      const validate = vi.fn((value: { answer: number }) => value);
      const agent = new Agent({
        instructions: 'Finish.',
        model: 'gpt-5',
        provider,
        outputType: {
          mode: 'prompted',
          schema: z.object({ answer: z.number() }).transform(validate),
        },
        tools: [
          tool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: effect,
          }),
        ],
      });
      const initial = await agent.session();
      await (await initial.submit('Finish.')).wait();
      const state = await initial.saveState();
      const terminalFacts = (history: typeof state.history) =>
        history.filter((record) =>
          JSON.stringify(record).includes('"tool_completion"'),
        );
      const before = terminalFacts(state.history);
      expect(before).not.toHaveLength(0);
      await initial.close();
      await using restored = await agent.session({ state });
      expect(restored.restoredTurn).toBeNull();
      expect(terminalFacts((await restored.saveState()).history)).toEqual(
        before,
      );
      expect(effect).toHaveBeenCalledTimes(1);
      expect(validate).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(1);
    });

    it('T04 waits for an ordinary sibling and follows the ordinary loop after sibling failure', async () => {
      const { Agent, NativeProvider, ToolOutput } = await import('../../src');
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const effects = vi.fn(() => 'candidate');
      const server = new ModelServer([
        [
          call('finish', {}, { callId: 'finish-sibling' }),
          call('ordinary', {}, { callId: 'failed-sibling' }),
        ],
        [message('ordinary recovery')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const agent = new Agent({
        instructions: 'Run.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'finish',
            parameters: z.object({}),
            finishTurn: true,
            execute: effects,
          }),
          tool({
            name: 'ordinary',
            parameters: z.object({}),
            execute: async () => {
              entered.resolve();
              await gate.promise;
              return new ToolOutput(
                [{ type: 'inputText', text: 'failed' }],
                false,
              );
            },
          }),
        ],
      });
      await using session = await agent.session({ maxFunctionConcurrency: 2 });
      const turn = await session.submit('Run.');
      let settled = false;
      const completion = turn.wait().finally(() => {
        settled = true;
      });
      await entered.promise;
      expect(settled).toBe(false);
      gate.resolve();
      const result = await completion;
      expect(result.finalOutput).toBe('ordinary recovery');
      expect(result.toolCall).toBeUndefined();
      expect(effects).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(2);
    });

    it('T06 rejects terminal media through the owning output error without another request', async () => {
      const { Agent, NativeProvider, ToolOutput } = await import('../../src');
      const server = new ModelServer([
        [call('finish', {}, { callId: 'media-call' })],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const effect = vi.fn(() =>
        ToolOutput.image('data:image/png;base64,AA=='),
      );
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
      await expect(
        (await session.submit('Run.')).wait(),
      ).rejects.toBeInstanceOf(OutputValidationError);
      expect(effect).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(1);
    });

    it('T08 cancels and joins a held result hook without publishing its terminal candidate', async () => {
      const { Agent, NativeProvider } = await import('../../src');
      const gate = Promise.withResolvers<void>();
      const entered = Promise.withResolvers<void>();
      const server = new ModelServer([
        [call('finish', {}, { callId: 'cancel-call' })],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const effect = vi.fn(() => 'candidate');
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
              await gate.promise;
              return output;
            },
          }),
        ],
      });
      await using session = await agent.session();
      const turn = await session.submit('Run.');
      const result = turn.wait();
      const rejected = expect(result).rejects.toThrow();
      await entered.promise;
      let stopped = false;
      const stop = turn.cancel().finally(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      gate.resolve();
      await stop;
      await rejected;
      expect(effect).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(1);
    });

    it('T10 keeps a child JSON-looking result as text under a structured root contract', async () => {
      const { Agent, Environment, NativeAgents, NativeProvider } =
        await import('../../src');
      const { startPublicExecutor } =
        await import('./fixtures/public-executor');
      const executor = await startPublicExecutor();
      let rootId: string | undefined;
      let rootRequests = 0;
      let childRequests = 0;
      const respond = (request: Record<string, any>) => {
        const id = JSON.parse(request.client_metadata['x-codex-turn-metadata'])
          .thread_id as string;
        rootId ??= id;
        if (id === rootId) {
          if (++rootRequests === 1)
            return [
              call(
                'spawn_agent',
                { task_name: 'child', message: 'Finish.' },
                { namespace: 'collaboration', callId: 'spawn-child' },
              ),
            ];
          return [message('{"root":1}')];
        }
        childRequests++;
        return [call('finish', {}, { callId: 'child-finish' })];
      };
      const server = new ModelServer(Array.from({ length: 3 }, () => respond));
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'fixture-terminal',
      });
      const effect = vi.fn(() => ({ answer: 7 }));
      const validate = vi.fn((value: { root: number }) => value);
      try {
        const agent = new Agent({
          instructions: 'Delegate.',
          model: 'gpt-5.6-terra',
          provider,
          outputType: {
            mode: 'prompted',
            schema: z.object({ root: z.number() }).transform(validate),
          },
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
        await using session = await agent.session({
          environment: new Environment({
            url: executor.url,
            cwd: executor.cwd,
            headers: executor.headers,
            tools: ['exec_command', 'write_stdin', 'apply_patch'],
          }),
        });
        expect(
          (await (await session.submit('Delegate.')).wait()).finalOutput,
        ).toEqual({ root: 1 });
        const children = await vi.waitUntil(async () => {
          const children = await Array.fromAsync(session.subagents());
          return children.length === 1 && children[0].turn ? children : false;
        });
        const child = children[0];
        const result = await child.turn!.wait();
        expect(result.finalOutput).toBe('{"answer":7}');
        expect(result.toolCall).toMatchObject({
          callId: 'child-finish',
          childId: child.id,
          route: 'direct',
          tool: { name: 'finish', namespace: null },
        });
        expect(effect).toHaveBeenCalledTimes(1);
        expect(validate).toHaveBeenCalledTimes(1);
        expect(rootRequests).toBe(2);
        expect(childRequests).toBe(1);
      } finally {
        await executor.close();
      }
    });

    it.each(['commit', 'flush'] as const)(
      'T11 holds every success observer until terminal %s completes',
      async (point) => {
        const { Agent, NativeProvider, fileSessionStore } =
          await import('../../src');
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const path = await mkdtemp(join(tmpdir(), 'terminal-durability-'));
        const entered = Promise.withResolvers<void>();
        const release = Promise.withResolvers<void>();
        const durable = fileSessionStore(path);
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
        const server = new ModelServer([
          [call('finish', {}, { callId: 'durable-finish' })],
        ]);
        const config = await server.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'fixture-terminal',
        });
        const effect = vi.fn(() => 'durable');
        try {
          const agent = new Agent({
            instructions: 'Finish.',
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
          const turn = await session.submit('Finish.');
          let settled = false;
          let successObserved = false;
          const result = turn.wait().finally(() => {
            settled = true;
          });
          const events = (async () => {
            for await (const event of turn.events())
              if (
                event.type === 'turn_finished' &&
                event.status === 'completed'
              )
                successObserved = true;
          })();
          await entered.promise;
          expect(effect).toHaveBeenCalledTimes(1);
          expect(settled).toBe(false);
          expect(successObserved).toBe(false);
          release.resolve();
          expect((await result).finalOutput).toBe('durable');
          await events;
          expect(successObserved).toBe(true);
          expect(server.requests).toHaveLength(1);
        } finally {
          release.resolve();
          await rm(path, { recursive: true, force: true });
        }
      },
    );

    it.each(['commit', 'flush'] as const)(
      'T12 settles failure after terminal %s fails without resampling',
      async (point) => {
        const { Agent, NativeProvider, fileSessionStore } =
          await import('../../src');
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const path = await mkdtemp(join(tmpdir(), 'terminal-failure-'));
        const durable = fileSessionStore(path);
        let terminal = false;
        const storage = {
          ...durable,
          commit: async (...args: Parameters<typeof durable.commit>) => {
            if (args[4].includes('"tool_completion":{')) {
              terminal = true;
              if (point === 'commit')
                throw new Error('Terminal commit unavailable');
            }
            await durable.commit(...args);
          },
          flush: async () => {
            if (terminal && point === 'flush')
              throw new Error('Terminal flush unavailable');
          },
        };
        const server = new ModelServer([
          [call('finish', {}, { callId: 'failed-terminal' })],
        ]);
        const config = await server.config();
        const provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'fixture-terminal',
        });
        const effect = vi.fn(() => 'candidate');
        try {
          const agent = new Agent({
            instructions: 'Finish.',
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
          const session = await agent.session({ storage });
          const turn = await session.submit('Finish.');
          let successes = 0;
          const events = (async () => {
            for await (const event of turn.events())
              if (
                event.type === 'turn_finished' &&
                event.status === 'completed'
              )
                successes++;
          })().catch(() => {});
          await expect(turn.wait()).rejects.toThrow();
          await events;
          await session.close().catch(() => {});
          expect(terminal).toBe(true);
          expect(successes).toBe(0);
          expect(effect).toHaveBeenCalledTimes(1);
          expect(server.requests).toHaveLength(1);
        } finally {
          await provider.close();
          await rm(path, { recursive: true, force: true });
        }
      },
    );

    it.each([true, false])(
      'T13/T15 handles terminal lost acknowledgment (confirmable=%s) without replaying effects',
      async (confirmable) => {
        const { Agent, NativeProvider, fileSessionStore } =
          await import('../../src');
        const { mkdtemp, rm } = await import('node:fs/promises');
        const { tmpdir } = await import('node:os');
        const { join } = await import('node:path');
        const path = await mkdtemp(join(tmpdir(), 'terminal-ack-'));
        const durable = fileSessionStore(path);
        let attempts = 0;
        let exactWrite: Parameters<typeof durable.commit> | undefined;
        const storage = {
          ...durable,
          commit: async (...args: Parameters<typeof durable.commit>) => {
            if (
              !args[4].includes('"tool_completion":{') ||
              (exactWrite && args[2] !== exactWrite[2])
            )
              return durable.commit(...args);
            attempts++;
            if (!exactWrite) {
              exactWrite = args;
              await durable.commit(...args);
            } else expect(args).toEqual(exactWrite);
            if (!confirmable || attempts === 1)
              throw new Error('Terminal acknowledgment lost');
            await durable.commit(...args);
          },
        };
        const server = new ModelServer([
          [call('finish', {}, { callId: 'lost-ack' })],
        ]);
        const config = await server.config();
        const provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'fixture-terminal',
        });
        const effect = vi.fn(() => 'accepted once');
        const agent = new Agent({
          instructions: 'Finish.',
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
        try {
          const session = await agent.session({ storage });
          const turn = await session.submit('Finish.');
          if (confirmable) {
            const result = await turn.wait();
            expect(result.finalOutput).toBe('accepted once');
            expect(result.toolCall?.callId).toBe('lost-ack');
          } else await expect(turn.wait()).rejects.toThrow();
          await session.close().catch(() => {});
          expect(attempts).toBeGreaterThan(1);
          expect(effect).toHaveBeenCalledTimes(1);
          expect(server.requests).toHaveLength(1);
        } finally {
          await provider.close();
          await rm(path, { recursive: true, force: true });
        }
      },
    );
  },
);
