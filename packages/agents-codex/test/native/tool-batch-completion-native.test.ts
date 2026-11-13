import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { ToolBatchCompletionContext } from '../../src/runtime/model-callbacks';
import { tool } from '../../src/runtime/tools';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function fixture(steps: ConstructorParameters<typeof ModelServer>[0]) {
  const { NativeProvider } = await import('../../src');
  const server = new ModelServer(steps);
  const config = await server.config();
  return {
    server,
    provider: new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'fixture-batch',
      supportsWebsockets: false,
    }),
  };
}

const native = process.env.OPENAI_AGENTS_NATIVE_TESTS === '1';

describe.skipIf(!native)('native direct tool batch completion', () => {
  it.each([false, true])(
    'retains model order after reverse settlement (failed sibling: %s)',
    async (failed) => {
      const { Agent, ToolOutput } = await import('../../src');
      const gate = Promise.withResolvers<void>();
      const second = Promise.withResolvers<void>();
      const settled: string[] = [];
      const { server, provider: resource } = await fixture([
        [
          call('first', { value: 1 }, { callId: 'batch-first' }),
          call('second', { value: 2 }, { callId: 'batch-second' }),
        ],
      ]);
      await using provider = resource;
      const reducer = vi.fn(({ results }: ToolBatchCompletionContext) => {
        expect(settled).toEqual(['second', 'first']);
        expect(results.map((item) => item.call.callId)).toEqual([
          'batch-first',
          'batch-second',
        ]);
        expect(results.map((item) => item.arguments)).toEqual([
          '{"value":1}',
          '{"value":2}',
        ]);
        expect(results.map((item) => item.output.success)).toEqual([
          true,
          !failed,
        ]);
        expect(Object.isFrozen(results)).toBe(true);
        return {
          action: 'finish' as const,
          output: {
            answer: results.map((item) => item.call.tool.name).join('+'),
          },
        };
      });
      const agent = new Agent({
        instructions: 'Run both functions.',
        model: 'gpt-5',
        provider,
        outputType: {
          mode: 'prompted',
          schema: z.object({ answer: z.string() }),
        },
        tools: [
          tool({
            name: 'first',
            parameters: z.object({ value: z.number() }),
            execute: async () => {
              await gate.promise;
              settled.push('first');
              return 'FIRST';
            },
          }),
          tool({
            name: 'second',
            parameters: z.object({ value: z.number() }),
            execute: () => {
              settled.push('second');
              second.resolve();
              return new ToolOutput(
                [{ type: 'inputText', text: 'SECOND' }],
                !failed,
              );
            },
          }),
        ],
        toolBatchCompletion: reducer,
      });
      await using session = await agent.session({ maxFunctionConcurrency: 2 });
      const turn = await session.submit('Run.');
      const result = turn.wait();
      await second.promise;
      expect(reducer).not.toHaveBeenCalled();
      gate.resolve();
      const completed = await result;
      expect(completed.finalOutput).toEqual({ answer: 'first+second' });
      expect(completed.toolCall).toBeUndefined();
      expect(completed.toolBatchCallIds).toEqual([
        'batch-first',
        'batch-second',
      ]);
      expect(reducer).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(1);
    },
  );

  it('keeps per-tool terminal completion ahead of the batch reducer', async () => {
    const { Agent } = await import('../../src');
    const { server, provider: resource } = await fixture([
      [call('finish', {}, { callId: 'per-tool' })],
    ]);
    await using provider = resource;
    const reducer = vi.fn(() => ({
      action: 'finish' as const,
      output: 'WRONG',
    }));
    const agent = new Agent({
      instructions: 'Finish.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'finish',
          parameters: z.object({}),
          finishTurn: true,
          execute: () => 'PER TOOL',
        }),
      ],
      toolBatchCompletion: reducer,
    });
    await using session = await agent.session();
    const result = await (await session.submit('Run.')).wait();
    expect(result.finalOutput).toBe('PER TOOL');
    expect(result.toolCall?.callId).toBe('per-tool');
    expect(result.toolBatchCallIds).toBeUndefined();
    expect(reducer).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
  });

  it('continues normally when the reducer returns undefined', async () => {
    const { Agent } = await import('../../src');
    const { server, provider: resource } = await fixture([
      [call('lookup', {}, { callId: 'ordinary' })],
      [message('MODEL')],
    ]);
    await using provider = resource;
    const reducer = vi.fn(() => undefined);
    const agent = new Agent({
      instructions: 'Run.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'TOOL',
        }),
      ],
      toolBatchCompletion: reducer,
    });
    await using session = await agent.session();
    const result = await (await session.submit('Run.')).wait();
    expect(result.finalOutput).toBe('MODEL');
    expect(result.toolBatchCallIds).toBeUndefined();
    expect(reducer).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(2);
  });

  it.each(['reducer', 'beforeComplete'] as const)(
    'shares the continuation counter for %s feedback',
    async (source) => {
      const { Agent } = await import('../../src');
      const { server, provider: resource } = await fixture([
        [call('lookup', {}, { callId: 'first-batch' })],
        [call('lookup', {}, { callId: 'second-batch' })],
      ]);
      await using provider = resource;
      const counts: number[] = [];
      const checked: number[] = [];
      const guarded: string[][] = [];
      const agent = new Agent({
        instructions: 'Run.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => 'TOOL',
          }),
        ],
        toolBatchCompletion(context) {
          counts.push(context.continuationCount);
          if (source === 'reducer' && context.continuationCount === 0)
            return { action: 'continue', instructions: 'RETRY_THE_BATCH' };
          return { action: 'finish', output: 'REDUCED' };
        },
        beforeComplete(context) {
          expect(context.toolCall).toBeUndefined();
          expect(context.toolBatchCallIds).toEqual([
            context.continuationCount === 0 ? 'first-batch' : 'second-batch',
          ]);
          expect(context.finalOutput).toBe('REDUCED');
          checked.push(context.continuationCount);
          if (context.continuationCount === 0)
            return { action: 'continue', instructions: 'RETRY_THE_BATCH' };
        },
        outputGuardrails: [
          {
            name: 'batch',
            callback(context) {
              expect(context.toolCall).toBeUndefined();
              guarded.push([...context.toolBatchCallIds!]);
              return { tripwireTriggered: false };
            },
          },
        ],
      });
      await using session = await agent.session();
      const result = await (await session.submit('Run.')).wait();
      expect(result.finalOutput).toBe('REDUCED');
      expect(result.toolBatchCallIds).toEqual(['second-batch']);
      expect(result.guardrailResults[0].toolBatchCallIds).toEqual([
        'second-batch',
      ]);
      expect(counts).toEqual([0, 1]);
      expect(checked).toEqual(source === 'reducer' ? [1] : [0, 1]);
      expect(guarded).toEqual([['second-batch']]);
      expect(JSON.stringify(server.requests[1])).toContain('RETRY_THE_BATCH');
      expect(server.requests).toHaveLength(2);
    },
  );

  it.each([false, true])(
    'uses the selected Worker callback without inheriting Root (Worker enabled: %s)',
    async (enabled) => {
      const { Agent } = await import('../../src');
      const { server, provider: resource } = await fixture([
        [call('transfer_to_worker', {}, { callId: 'handoff' })],
        [call('lookup', {}, { callId: 'worker-result' })],
        ...(!enabled ? [[message('WORKER MODEL')]] : []),
      ]);
      await using provider = resource;
      const rootReducer = vi.fn(() => ({
        action: 'finish' as const,
        output: 'WRONG ROOT',
      }));
      const workerReducer = vi.fn(() => ({
        action: 'finish' as const,
        output: 'WORKER REDUCED',
      }));
      const worker = new Agent({
        name: 'Worker',
        instructions: 'Look up.',
        model: 'gpt-5.5',
        provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => 'TOOL',
          }),
        ],
        ...(enabled ? { toolBatchCompletion: workerReducer } : {}),
      });
      await using session = await new Agent({
        name: 'Root',
        instructions: 'Hand off.',
        model: 'gpt-5.5',
        provider,
        handoffs: [worker],
        toolBatchCompletion: rootReducer,
      }).session();
      const result = await (await session.submit('Run.')).wait();
      expect(result.finalOutput).toBe(
        enabled ? 'WORKER REDUCED' : 'WORKER MODEL',
      );
      expect(rootReducer).not.toHaveBeenCalled();
      expect(workerReducer).toHaveBeenCalledTimes(enabled ? 1 : 0);
      expect(server.requests).toHaveLength(enabled ? 2 : 3);
    },
  );

  it.each([false, true])(
    'reduces live manual results and skips checkpoint outcomes (restored: %s)',
    async (restored) => {
      const { Agent, manualTool, InteractionRequired } =
        await import('../../src');
      const { server, provider: resource } = await fixture([
        [
          call('record', {}, { callId: 'recorded' }),
          call('approve', {}, { callId: 'manual' }),
        ],
        ...(restored ? [[call('record', {}, { callId: 'new-call' })]] : []),
      ]);
      await using provider = resource;
      const effect = vi.fn(() => 'RECORDED');
      const tools = [
        tool({ name: 'record', parameters: z.object({}), execute: effect }),
        manualTool({
          name: 'approve',
          description: 'Ask.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ];
      const options = {
        name: 'Root',
        instructions: 'Run both.',
        model: 'gpt-5',
        provider,
        tools,
      };
      const reducer = vi.fn(({ results }: ToolBatchCompletionContext) => {
        expect(results.map((item) => item.call.callId)).toEqual(
          restored ? ['new-call'] : ['recorded', 'manual'],
        );
        expect(results.every((item) => item.output.success)).toBe(true);
        return { action: 'finish' as const, output: 'LIVE REDUCED' };
      });
      const agent = new Agent({ ...options, toolBatchCompletion: reducer });
      await using original = await agent.session();
      const turn = await original.submit('Run.');
      for await (const event of original.events()) {
        if (event.type !== 'action_requested') continue;
        if (!restored) await original.respond(event.reply('APPROVED'));
        break;
      }
      if (!restored) {
        expect((await turn.wait()).finalOutput).toBe('LIVE REDUCED');
        expect(effect).toHaveBeenCalledTimes(1);
        expect(reducer).toHaveBeenCalledTimes(1);
        expect(server.requests).toHaveLength(1);
        return;
      }
      const pending = turn.wait().catch((error: unknown) => error);
      const state = await original.suspend();
      expect(await pending).toBeInstanceOf(InteractionRequired);
      await original.close();
      const checkpoint = JSON.stringify(state);
      expect(checkpoint).toContain('"RECORDED"');
      await using resumed = await agent.session({
        state: JSON.parse(checkpoint.replaceAll('"RECORDED"', '"CHANGED"')),
      });
      for await (const event of resumed.events()) {
        if (event.type !== 'action_requested') continue;
        await resumed.respond(event.reply('APPROVED'));
        break;
      }
      expect((await resumed.restoredTurn!.wait()).finalOutput).toBe(
        'LIVE REDUCED',
      );
      expect(effect).toHaveBeenCalledTimes(2);
      expect(reducer).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(2);
    },
  );

  it('preserves a callback failure without repairing or accepting its proposal', async () => {
    const { Agent } = await import('../../src');
    const { server, provider: resource } = await fixture([
      [call('lookup', {}, { callId: 'failed' })],
    ]);
    await using provider = resource;
    const original = new Error('SYNTHETIC_BATCH_FAILURE');
    await using session = await new Agent({
      instructions: 'Run.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'TOOL',
        }),
      ],
      toolBatchCompletion() {
        throw original;
      },
    }).session();
    await expect((await session.submit('Run.')).wait()).rejects.toBe(original);
    expect(server.requests).toHaveLength(1);
  });

  it('validates raw JSON finish input once before exposing transformed output', async () => {
    const { Agent } = await import('../../src');
    const { server, provider: resource } = await fixture([
      [call('lookup', {}, { callId: 'transformed' })],
    ]);
    await using provider = resource;
    const transform = vi.fn((value: number) => ({ answer: value + 1 }));
    const before = vi.fn();
    await using session = await new Agent({
      instructions: 'Run.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'TOOL',
        }),
      ],
      outputType: { mode: 'prompted', schema: z.number().transform(transform) },
      toolBatchCompletion: () => ({ action: 'finish', output: 7 }),
      beforeComplete(context) {
        before(context.finalOutput);
      },
    }).session();
    expect((await (await session.submit('Run.')).wait()).finalOutput).toEqual({
      answer: 8,
    });
    expect(transform).toHaveBeenCalledTimes(1);
    expect(before).toHaveBeenCalledExactlyOnceWith({ answer: 8 });
    expect(server.requests).toHaveLength(1);
  });

  it('refuses reducer entry after cancellation during input guard admission', async () => {
    const { Agent, NativeError } = await import('../../src');
    const { server, provider: resource } = await fixture([
      [call('lookup', {}, { callId: 'cancelled-before-reducer' })],
      [message('NEXT TURN')],
    ]);
    await using provider = resource;
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const reducer = vi.fn(() => ({
      action: 'finish' as const,
      output: 'STALE FINISH',
    }));
    await using session = await new Agent({
      instructions: 'Run.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'TOOL',
        }),
      ],
      toolBatchCompletion: reducer,
    }).session();
    const boundary = session as unknown as {
      awaitInputGuardrails(owner: {
        controller: AbortController;
      }): Promise<void>;
    };
    const awaitGuards = boundary.awaitInputGuardrails.bind(session);
    const admission = vi
      .spyOn(boundary, 'awaitInputGuardrails')
      .mockImplementationOnce(async (owner) => {
        await awaitGuards(owner);
        owner.controller.signal.addEventListener(
          'abort',
          () => aborted.resolve(),
          {
            once: true,
          },
        );
        entered.resolve();
        await release.promise;
      });
    try {
      const turn = await session.submit('Run.');
      const result = turn.wait().catch((error: unknown) => error);
      await entered.promise;
      const cancelled = turn.cancel();
      await aborted.promise;
      release.resolve();
      await cancelled;
      expect(await result).toBeInstanceOf(NativeError);
      expect(reducer).not.toHaveBeenCalled();
      expect((await (await session.submit('Next.')).wait()).finalOutput).toBe(
        'NEXT TURN',
      );
      expect(server.requests).toHaveLength(2);
    } finally {
      release.resolve();
      admission.mockRestore();
    }
  });

  it('joins cancellation of the reducer and refuses its stale finish', async () => {
    const { Agent, NativeError } = await import('../../src');
    const { server, provider: resource } = await fixture([
      [call('lookup', {}, { callId: 'cancelled-batch' })],
      [message('NEXT TURN')],
    ]);
    await using provider = resource;
    const entered = Promise.withResolvers<void>();
    const aborted = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    await using session = await new Agent({
      instructions: 'Run.',
      model: 'gpt-5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'TOOL',
        }),
      ],
      async toolBatchCompletion(context) {
        context.signal.addEventListener('abort', () => aborted.resolve(), {
          once: true,
        });
        entered.resolve();
        await release.promise;
        return { action: 'finish', output: 'STALE FINISH' };
      },
    }).session();
    const turn = await session.submit('Run.');
    const result = turn.wait().catch((error: unknown) => error);
    await entered.promise;
    let cancelled = false;
    const stop = turn.cancel().then(() => {
      cancelled = true;
    });
    await aborted.promise;
    await Promise.resolve();
    expect(cancelled).toBe(false);
    release.resolve();
    await stop;
    expect(await result).toBeInstanceOf(NativeError);
    expect((await (await session.submit('Next.')).wait()).finalOutput).toBe(
      'NEXT TURN',
    );
    expect(server.requests).toHaveLength(2);
  });

  it.each(['invalid', 'guardrail'] as const)(
    'refuses %s final output without model repair',
    async (failure) => {
      const { Agent, OutputValidationError, GuardrailTripwire } =
        await import('../../src');
      const { server, provider: resource } = await fixture([
        [call('lookup', {}, { callId: 'refused-batch' })],
      ]);
      await using provider = resource;
      const guard = vi.fn((context) => {
        expect(context.toolCall).toBeUndefined();
        expect(context.toolBatchCallIds).toEqual(['refused-batch']);
        return { tripwireTriggered: true };
      });
      await using session = await new Agent({
        instructions: 'Run.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => 'TOOL',
          }),
        ],
        outputType: {
          mode: 'prompted',
          schema: z.object({ answer: z.number() }),
          maxRetries: 2,
        },
        toolBatchCompletion: () => ({
          action: 'finish',
          output: { answer: failure === 'invalid' ? 'WRONG' : 7 },
        }),
        outputGuardrails: [{ name: 'reject', callback: guard }],
      }).session();
      await expect(
        (await session.submit('Run.')).wait(),
      ).rejects.toBeInstanceOf(
        failure === 'invalid' ? OutputValidationError : GuardrailTripwire,
      );
      expect(guard).toHaveBeenCalledTimes(failure === 'guardrail' ? 1 : 0);
      expect(server.requests).toHaveLength(1);
    },
  );

  it('leaves code-mode invocations on their ordinary model path', async () => {
    const { Agent } = await import('../../src');
    const { server, provider: resource } = await fixture([
      [
        {
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'cell',
          input: 'text(await tools.lookup({}));',
        },
      ],
      [message('MODEL AFTER CELL')],
    ]);
    await using provider = resource;
    const reducer = vi.fn(() => ({
      action: 'finish' as const,
      output: 'WRONG',
    }));
    const effect = vi.fn(() => 'TOOL');
    await using session = await new Agent({
      instructions: 'Use code.',
      model: 'gpt-5',
      provider,
      programmaticToolCalling: true,
      tools: [
        tool({ name: 'lookup', parameters: z.object({}), execute: effect }),
      ],
      toolBatchCompletion: reducer,
    }).session();
    const result = await (await session.submit('Run.')).wait();
    expect(result.finalOutput).toBe('MODEL AFTER CELL');
    expect(result.toolBatchCallIds).toBeUndefined();
    expect(effect).toHaveBeenCalledTimes(1);
    expect(reducer).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(2);
  });

  it('retains the native child owner and its batch completion metadata', async () => {
    const { Agent, Environment, NativeAgents } = await import('../../src');
    const { startPublicExecutor } = await import('./fixtures/public-executor');
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
              { task_name: 'child', message: 'Look up.' },
              { namespace: 'collaboration', callId: 'spawn-child' },
            ),
          ];
        return [message('ROOT MODEL')];
      }
      childRequests++;
      return [call('lookup', {}, { callId: 'child-lookup' })];
    };
    const { server, provider: resource } = await fixture(
      Array.from({ length: 3 }, () => respond),
    );
    await using provider = resource;
    const owners: string[] = [];
    try {
      await using session = await new Agent({
        instructions: 'Delegate.',
        model: 'gpt-5.6-terra',
        provider,
        tools: [
          new NativeAgents(),
          tool({
            name: 'lookup',
            parameters: z.object({}),
            execute: () => 'TOOL',
          }),
        ],
        toolBatchCompletion(context) {
          if (!context.subagentId) return;
          owners.push(context.subagentId);
          return { action: 'finish', output: 'CHILD REDUCED' };
        },
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      expect(
        (await (await session.submit('Delegate.')).wait()).finalOutput,
      ).toBe('ROOT MODEL');
      const children = await vi.waitUntil(async () => {
        const current = await Array.fromAsync(session.subagents());
        return current.length === 1 && current[0].turn ? current : false;
      });
      const child = children[0];
      const result = await child.turn!.wait();
      expect(result.finalOutput).toBe('CHILD REDUCED');
      expect(result.toolCall).toBeUndefined();
      expect(result.toolBatchCallIds).toEqual(['child-lookup']);
      expect(owners).toEqual([child.id]);
      expect(rootRequests).toBe(2);
      expect(childRequests).toBe(1);
      expect(server.requests).toHaveLength(3);
    } finally {
      await executor.close();
    }
  });

  it('strict dispatch keeps known reduction and resets the next root default', async () => {
    const { Agent } = await import('../../src');
    const { server, provider: resource } = await fixture([
      [call('lookup', {}, { callId: 'known-strict' })],
      [call('missing_function', {}, { callId: 'unknown-default' })],
      [message('RECOVERED DEFAULT')],
    ]);
    await using provider = resource;
    const reducer = vi.fn(({ results }: ToolBatchCompletionContext) => {
      if (results.some((item) => !item.output.success)) {
        expect(results.map((item) => item.call.callId)).toEqual([
          'unknown-default',
        ]);
        return undefined;
      }
      return { action: 'finish' as const, output: 'STRICT REDUCED' };
    });
    await using session = await new Agent({
      instructions: 'Run.',
      model: 'gpt-5.5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'TOOL',
        }),
      ],
      toolBatchCompletion: reducer,
    }).session();
    expect(
      (
        await (
          await session.submit('Known.', {
            toolNotFoundBehavior: 'raise_error',
          })
        ).wait()
      ).finalOutput,
    ).toBe('STRICT REDUCED');
    expect((await (await session.submit('Unknown.')).wait()).finalOutput).toBe(
      'RECOVERED DEFAULT',
    );
    expect(reducer).toHaveBeenCalledTimes(2);
    expect(server.requests).toHaveLength(3);
  });

  it('strict dispatch refuses an unknown batch member before reduction', async () => {
    const { Agent } = await import('../../src');
    const { server, provider: resource } = await fixture([
      [
        call('lookup', {}, { callId: 'known' }),
        call('missing_function', {}, { callId: 'missing' }),
      ],
    ]);
    await using provider = resource;
    const reducer = vi.fn(() => ({
      action: 'finish' as const,
      output: 'WRONG',
    }));
    await using session = await new Agent({
      instructions: 'Run.',
      model: 'gpt-5.5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'TOOL',
        }),
      ],
      toolBatchCompletion: reducer,
    }).session();
    await expect(
      (
        await session.submit('Run.', { toolNotFoundBehavior: 'raise_error' })
      ).wait(),
    ).rejects.toThrow('unsupported call');
    expect(reducer).not.toHaveBeenCalled();
    expect(server.requests).toHaveLength(1);
  });

  it('uses a later agent catalog after a fresh restored batch continues', async () => {
    const { Agent, manualTool, InteractionRequired } =
      await import('../../src');
    const { server, provider: resource } = await fixture([
      [call('approve', {}, { callId: 'manual-before-handoff' })],
      [call('transfer_to_worker', {}, { callId: 'handoff-after-restore' })],
      [call('lookup', {}, { callId: 'worker-after-restore' })],
    ]);
    await using provider = resource;
    const rootReducer = vi.fn(({ results }: ToolBatchCompletionContext) => {
      expect(results.map(({ call }) => call.callId)).toEqual([
        'manual-before-handoff',
      ]);
      return undefined;
    });
    const workerReducer = vi.fn(({ results }: ToolBatchCompletionContext) => {
      expect(results.map(({ call }) => call.callId)).toEqual([
        'worker-after-restore',
      ]);
      return { action: 'finish' as const, output: 'WORKER REDUCED' };
    });
    const worker = new Agent({
      name: 'Worker',
      instructions: 'Look up the result.',
      model: 'gpt-5.5',
      provider,
      tools: [
        tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: () => 'WORKER TOOL',
        }),
      ],
      toolBatchCompletion: workerReducer,
    });
    const agent = new Agent({
      name: 'Root',
      instructions: 'Ask and then transfer.',
      model: 'gpt-5.5',
      provider,
      tools: [
        manualTool({
          name: 'approve',
          description: 'Ask.',
          parameters: z.object({}),
          result: z.string(),
        }),
      ],
      handoffs: [worker],
      toolBatchCompletion: rootReducer,
    });
    await using initial = await agent.session();
    const original = await initial.submit('Run.');
    const pending = original.wait().catch((error: unknown) => error);
    for await (const event of initial.events()) {
      if (event.type === 'action_requested') break;
    }
    const state = await initial.suspend();
    expect(await pending).toBeInstanceOf(InteractionRequired);
    await initial.close();
    await using restored = await agent.session({
      state: JSON.parse(JSON.stringify(state)),
    });
    for await (const event of restored.events()) {
      if (event.type !== 'action_requested') continue;
      await restored.respond(event.reply('APPROVED'));
      break;
    }
    expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
      'WORKER REDUCED',
    );
    expect(rootReducer).toHaveBeenCalledTimes(1);
    expect(workerReducer).toHaveBeenCalledTimes(1);
    expect(server.requests).toHaveLength(3);
  });

  it.each([true, false])(
    'reduces a fresh manual reply and preserves strict dispatch after restore (success: %s)',
    async (succeeded) => {
      const { Agent, manualTool, InteractionRequired, ToolOutput } =
        await import('../../src');
      const { server, provider: resource } = await fixture([
        [call('approve', {}, { callId: 'manual-strict' })],
        [call('missing_function', {}, { callId: 'restored-missing' })],
      ]);
      await using provider = resource;
      const tools = [
        manualTool({
          name: 'approve',
          description: 'Ask.',
          parameters: z.object({}),
          result: z
            .string()
            .transform(
              (value) =>
                new ToolOutput([{ type: 'inputText', text: value }], succeeded),
            ),
        }),
      ];
      const options = {
        name: 'Root',
        instructions: 'Run.',
        model: 'gpt-5.5',
        provider,
        tools,
        modelSettings: { resetToolChoice: true },
      };
      const oldReducer = vi.fn(() => undefined);
      const initial = await new Agent({
        ...options,
        toolBatchCompletion: oldReducer,
      }).session();
      const original = await initial.submit('Run.', {
        toolNotFoundBehavior: 'raise_error',
      });
      const pending = original.wait().catch((error: unknown) => error);
      for await (const event of initial.events())
        if (event.type === 'action_requested') break;
      const state = await initial.suspend();
      expect(await pending).toBeInstanceOf(InteractionRequired);
      await initial.close();
      const fresh = vi.fn(({ results }: ToolBatchCompletionContext) => {
        expect(results.map((item) => item.call.callId)).toEqual([
          'manual-strict',
        ]);
        expect(results[0]?.output.success).toBe(succeeded);
        return undefined;
      });
      await using restored = await new Agent({
        ...options,
        toolBatchCompletion: fresh,
      }).session({ state: JSON.parse(JSON.stringify(state)) });
      const result = restored.restoredTurn!.wait();
      const rejected = expect(result).rejects.toThrow('unsupported call');
      for await (const event of restored.events()) {
        if (event.type !== 'action_requested') continue;
        await restored.respond(event.reply('APPROVED'));
        break;
      }
      await rejected;
      expect(fresh).toHaveBeenCalledTimes(1);
      expect(oldReducer).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(2);
    },
  );
});
