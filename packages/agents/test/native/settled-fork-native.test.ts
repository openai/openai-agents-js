import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeProvider,
  checklist,
  tool,
  type Session,
  type ToolContext,
} from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

async function setup(responses: ConstructorParameters<typeof ModelServer>[0]) {
  const server = new ModelServer(responses);
  const config = await server.config();
  const provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'source-synthetic-key',
    supportsWebsockets: false,
  });
  return { server, provider };
}
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe('settled root fork', () => {
  it('copies history once, uses current destination bindings and excludes later source work', async () => {
    const { server, provider } = await setup([
      [call('lookup', {}, { callId: 'old-call' })],
      [message('remembered')],
      [message('source future')],
      (request) => {
        const input = JSON.stringify(request.input);
        expect(input).toContain('recorded-effect');
        expect(input).not.toContain('source-only future');
        return [call('lookup', {}, { callId: 'new-call' })];
      },
      [message('destination finished')],
    ]);
    let effects = 0;
    const sourceTool = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => {
        effects++;
        return 'recorded-effect';
      },
    });
    const source = await new Agent({
      instructions: 'Use lookup.',
      model: 'gpt-5',
      provider,
      tools: [sourceTool],
    }).session();
    let destination: Session | undefined;
    try {
      await (await source.submit('Remember this.')).wait();
      const state = await source.fork();
      const another = await source.fork();
      expect(state.native.source_session_id).not.toBe(source.id);
      expect(another.native.source_session_id).not.toBe(
        state.native.source_session_id,
      );
      expect(effects).toBe(1);
      expect(server.requests).toHaveLength(2);
      expect(state.native.agent_options).toEqual({});
      await (await source.submit('source-only future')).wait();
      await source.close();
      const current = tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: (_args, ctx) => {
          expect(ctx.context).toEqual({ destination: true });
          effects++;
          return 'current-result';
        },
      });
      destination = await new Agent({
        instructions: 'Use lookup.',
        model: 'gpt-5',
        provider,
        tools: [current],
      }).session({ state, context: { destination: true } });
      expect(destination.id).toBe(state.native.source_session_id);
      expect(
        (await (await destination.submit('Continue.')).wait()).finalOutput,
      ).toBe('destination finished');
      expect(effects).toBe(2);
      server.assertExhausted();
    } finally {
      await destination?.close();
      await source.close();
      await provider.close();
    }
  });

  it('requires current tool declarations before destination model work', async () => {
    const { server, provider } = await setup([[message('saved')]]);
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({}),
      execute: () => 'current',
    });
    const source = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
      tools: [lookup],
    }).session();
    try {
      await (await source.submit('Remember.')).wait();
      const state = await source.fork();
      await expect(
        new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
        }).session({ state }),
      ).rejects.toThrow();
      expect(server.requests).toHaveLength(1);
    } finally {
      await source.close();
      await provider.close();
    }
  });

  it('preserves original export and cleanup errors and retries cleanup before another copy', async () => {
    const { provider } = await setup([]);
    const source = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    const addon = await binding();
    const primary = new Error('export failed');
    const cleanup = new Error('cleanup incomplete');
    const exports = vi
      .spyOn(addon.NativeThread.prototype, '_export_checkpoint')
      .mockRejectedValueOnce(primary);
    const discards = vi
      .spyOn(addon.NativeThread.prototype, '_discard_fork')
      .mockRejectedValueOnce(cleanup);
    const allocations = vi.spyOn(addon.NativeThread.prototype, '_fork_settled');
    try {
      const error = await source.fork().catch((error: unknown) => error);
      expect(error).toBeInstanceOf(AggregateError);
      expect((error as AggregateError).cause).toBe(primary);
      expect((error as AggregateError).errors).toEqual([primary, cleanup]);
      expect(allocations).toHaveBeenCalledTimes(1);
      exports.mockRestore();
      await source.fork();
      expect(discards).toHaveBeenCalledTimes(3);
      expect(allocations).toHaveBeenCalledTimes(2);
    } finally {
      vi.restoreAllMocks();
      await source.close();
      await provider.close();
    }
  });

  it('joins a native copy whose wrapper result is lost before JavaScript receives it', async () => {
    const { provider } = await setup([]);
    const source = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    const addon = await binding();
    const original = addon.NativeThread.prototype._fork_settled;
    const lost = new Error('result delivery lost');
    vi.spyOn(
      addon.NativeThread.prototype,
      '_fork_settled',
    ).mockImplementationOnce(async function (
      this: typeof addon.NativeThread.prototype,
    ) {
      await original.call(this);
      throw lost;
    });
    await expect(source.fork()).rejects.toBe(lost);
    await source.close();
    await provider.close();
  });

  it('revokes publication on source close while joining the admitted fork', async () => {
    const { provider } = await setup([]);
    const source = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    const addon = await binding();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const original = addon.NativeThread.prototype._export_checkpoint;
    vi.spyOn(
      addon.NativeThread.prototype,
      '_export_checkpoint',
    ).mockImplementationOnce(async function (
      this: typeof addon.NativeThread.prototype,
      ...args
    ) {
      entered.resolve();
      await release.promise;
      return original.apply(this, args);
    });
    const captured = source.fork();
    const rejected = expect(captured).rejects.toThrow('closed during fork');
    await entered.promise;
    const close = source.close();
    release.resolve();
    await rejected;
    await close;
    await provider.close();
  });

  it('keeps source work alive when the independently opened destination closes', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const { server, provider } = await setup([
      async () => {
        entered.resolve();
        await release.promise;
        return [message('source completed')];
      },
    ]);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const source = await agent.session();
    const destination = await agent.session({ state: await source.fork() });
    try {
      const running = await source.submit('Continue the source.');
      await entered.promise;
      await expect(source.fork()).rejects.toThrow('settled');
      await destination.close();
      release.resolve();
      expect((await running.wait()).finalOutput).toBe('source completed');
      server.assertExhausted();
    } finally {
      release.resolve();
      await destination.close();
      await source.close();
      await provider.close();
    }
  });

  it('refuses a live root terminal without terminating it, then forks after the source retires it', async () => {
    const executor = await startPublicExecutor();
    let processId = 0;
    const { server, provider } = await setup([
      [
        call(
          'exec_command',
          {
            cmd: 'read -r value; printf "finished:%s\\n" "$value"',
            tty: true,
            yield_time_ms: 1000,
          },
          { callId: 'start-process' },
        ),
      ],
      (request) => {
        const input = JSON.stringify(request.input);
        const match = /Process running with session ID (\d+)/.exec(input);
        expect(match).not.toBeNull();
        processId = Number(match![1]);
        return [message('settled with terminal')];
      },
      () => [
        call(
          'write_stdin',
          { session_id: processId, chars: 'done\n', yield_time_ms: 1000 },
          { callId: 'finish-process' },
        ),
      ],
      [message('process retired')],
    ]);
    let source: Session | undefined;
    try {
      source = await new Agent({
        instructions: 'Use the selected tools.',
        model: 'gpt-5',
        provider,
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin'],
        }),
      });
      await (await source.submit('Start a process.')).wait();
      const before = executor.requests.length;
      await expect(source.fork()).rejects.toThrow('background terminals');
      expect(executor.requests).toHaveLength(before);
      expect(
        executor.requests.some(
          (request) => request.method === 'process/terminate',
        ),
      ).toBe(false);
      await (await source.submit('Finish the process.')).wait();
      expect((await source.fork()).native.source_session_id).not.toBe(
        source.id,
      );
      server.assertExhausted();
    } finally {
      await source?.close();
      await provider.close();
      await executor.close();
    }
  });

  it.each(['paused', 'complete'] as const)(
    'forks retained %s goal and checklist data without grants or replay',
    async (status) => {
      let sourceEffects = 0;
      let destinationEffects = 0;
      const { server, provider } = await setup([
        [call('lookup', {}, { callId: 'recorded-effect' })],
        [message('saved')],
        (request) => {
          const tools = JSON.stringify(request.tools);
          for (const name of [
            'update_plan',
            'create_goal',
            'get_goal',
            'update_goal',
          ])
            expect(tools).not.toContain(`"name":"${name}"`);
          return [call('lookup', {}, { callId: 'current-effect' })];
        },
        (request) => {
          const input = JSON.stringify(request.input);
          expect(input.split('recorded source effect')).toHaveLength(2);
          expect(input).toContain('current destination context');
          return [message('independent continuation')];
        },
      ]);
      const config = await server.config();
      const destinationProvider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'current-destination-key',
        supportsWebsockets: false,
      });
      const lookup = tool({
        name: 'lookup',
        parameters: z.object({}),
        execute: () => {
          sourceEffects++;
          return 'recorded source effect';
        },
      });
      const agent = new Agent({
        instructions: 'Preserve recorded work.',
        model: 'gpt-5',
        provider,
        tools: [lookup],
      });
      const initial = await agent.session();
      let source: Session | undefined;
      let destination: Session | undefined;
      try {
        const turn = await initial.submit('Record the work.');
        await turn.wait();
        const saved = await initial.saveState();
        saved.native.root_goal = {
          thread_id: saved.native.source_session_id,
          objective: `Keep literal source ${saved.native.source_session_id}`,
          status,
          token_budget: 2100,
          tokens_used: 850,
          time_used_seconds: 72,
          created_at: 1700000000,
          updated_at: 1700000072,
        };
        saved.native.root_checklist = {
          thread_id: saved.native.source_session_id,
          turn_id: turn.turnId,
          explanation: 'Preserve recorded order',
          plan: [
            {
              step: `Literal source ${saved.native.source_session_id}`,
              status: 'completed',
            },
            { step: 'Next step', status: 'in_progress' },
            { step: 'Later step', status: 'pending' },
          ],
        };
        await initial.close();
        source = await agent.session({ state: saved });
        const before = await source.saveState();
        const forked = await source.fork();
        const another = await source.fork();
        expect(forked.native.source_session_id).not.toBe(source.id);
        expect(another.native.source_session_id).not.toBe(
          forked.native.source_session_id,
        );
        expect(forked.native.root_goal).toEqual({
          ...before.native.root_goal,
          thread_id: forked.native.source_session_id,
        });
        expect(forked.native.root_checklist).toEqual({
          ...before.native.root_checklist,
          thread_id: forked.native.source_session_id,
        });
        const after = await source.saveState();
        expect(after.native.root_goal).toEqual(before.native.root_goal);
        expect(after.native.root_checklist).toEqual(
          before.native.root_checklist,
        );
        expect(sourceEffects).toBe(1);
        expect(server.requests).toHaveLength(2);
        await expect(
          source.compact({
            summary: 'Goal-backed summaries remain unsupported.',
          }),
        ).rejects.toThrow(/goal/i);
        expect(server.requests).toHaveLength(2);
        await source.close();
        await provider.close();
        const current = tool({
          name: 'lookup',
          parameters: z.object({}),
          execute: (_args, ctx: ToolContext<{ value: string }>) => {
            destinationEffects++;
            return ctx.context.value;
          },
        });
        destination = await new Agent<{ value: string }>({
          instructions: 'Preserve recorded work.',
          model: 'gpt-5',
          provider: destinationProvider,
          tools: [current],
        }).session({
          state: forked,
          context: { value: 'current destination context' },
        });
        const restored = await destination.saveState();
        expect(restored.native.root_goal).toEqual(forked.native.root_goal);
        expect(restored.native.root_checklist).toEqual(
          forked.native.root_checklist,
        );
        expect(
          (
            await (
              await destination.submit('Continue from recorded work.')
            ).wait()
          ).finalOutput,
        ).toBe('independent continuation');
        expect(server.requestHeaders[2]?.authorization).toBe(
          'Bearer current-destination-key',
        );
        expect(sourceEffects).toBe(1);
        expect(destinationEffects).toBe(1);
        server.assertExhausted();
      } finally {
        await destination?.close();
        await source?.close();
        await initial.close();
        await provider.close();
        await destinationProvider.close();
      }
    },
  );

  it('preserves checklist data through supplied summary and successive native forks', async () => {
    const { server, provider } = await setup([
      [message('recorded')],
      (request) => {
        expect(JSON.stringify(request.tools)).not.toContain('update_plan');
        return [message('continued')];
      },
    ]);
    const agent = new Agent({
      instructions: 'Preserve the checklist.',
      model: 'gpt-5',
      provider,
    });
    const initial = await agent.session();
    let source: Session | undefined;
    let branch: Session | undefined;
    let destination: Session | undefined;
    try {
      const turn = await initial.submit('Record the work.');
      await turn.wait();
      const saved = await initial.saveState();
      saved.native.root_checklist = {
        thread_id: saved.native.source_session_id,
        turn_id: turn.turnId,
        explanation: 'Keep historical turn',
        plan: [
          {
            step: `Keep ${saved.native.source_session_id} literal`,
            status: 'pending',
          },
        ],
      };
      await initial.close();
      source = await agent.session({ state: saved });
      await source.compact({ summary: 'Supplied before fork.' });
      const first = await source.fork();
      expect(first.native.root_checklist).toEqual({
        ...saved.native.root_checklist,
        thread_id: first.native.source_session_id,
      });
      await source.close();
      branch = await agent.session({ state: first });
      await branch.compact({ summary: 'Supplied after fork.' });
      expect((await branch.saveState()).native.root_checklist).toEqual(
        first.native.root_checklist,
      );
      expect(branch.id).toBe(first.native.source_session_id);
      const second = await branch.fork();
      expect(second.native.source_session_id).not.toBe(
        first.native.source_session_id,
      );
      expect(second.native.root_checklist).toEqual({
        ...saved.native.root_checklist,
        thread_id: second.native.source_session_id,
      });
      expect(server.requests).toHaveLength(1);
      await branch.close();
      destination = await agent.session({ state: second });
      expect((await destination.saveState()).native.root_checklist).toEqual(
        second.native.root_checklist,
      );
      expect(
        (await (await destination.submit('Continue.')).wait()).finalOutput,
      ).toBe('continued');
      server.assertExhausted();
    } finally {
      await destination?.close();
      await branch?.close();
      await source?.close();
      await initial.close();
      await provider.close();
    }
  });
});

describe('fork and supplied summary with the current checklist owner', () => {
  it('preserves the accepted plan through summary and fork without granting destination tools', async () => {
    const plan = [{ step: 'Report the decision', status: 'completed' }];
    const summary = 'The application selected amber for the project.';
    const { server, provider } = await setup([
      [call('update_plan', { plan }, { callId: 'source-plan' })],
      [message('Decision recorded.')],
      (request) => {
        expect(JSON.stringify(request.input)).toContain(summary);
        expect(JSON.stringify(request.tools)).not.toContain(
          '"name":"update_plan"',
        );
        return [message('Independent answer.')];
      },
    ]);
    const source = await new Agent({
      instructions: 'Keep the application decision.',
      model: 'gpt-5',
      provider,
      tools: [checklist()],
    }).session();
    let destination: Session | undefined;
    try {
      const turn = await source.submit('Record the project decision.');
      await turn.wait();
      const accepted = await source.checklist();
      expect(accepted?.plan).toEqual(plan);
      await source.compact({ summary });
      expect(await source.checklist()).toEqual(accepted);
      expect(server.requests).toHaveLength(2);
      const state = await source.fork();
      expect(state.native.source_session_id).not.toBe(source.id);
      expect(state.native.root_checklist).toEqual({
        thread_id: state.native.source_session_id,
        turn_id: turn.turnId,
        explanation: null,
        plan,
      });
      expect((await source.saveState()).native.root_checklist?.thread_id).toBe(
        source.id,
      );
      expect(server.requests).toHaveLength(2);
      destination = await new Agent({
        instructions: 'Keep the application decision.',
        model: 'gpt-5',
        provider,
      }).session({ state });
      expect(await destination.checklist()).toEqual({
        ...accepted,
        threadId: destination.id,
      });
      const continued = await destination.submit('Explain the alternative.');
      expect((await continued.wait()).finalOutput).toBe('Independent answer.');
      expect(await source.checklist()).toEqual(accepted);
      server.assertExhausted();
    } finally {
      await destination?.close();
      await source.close();
      await provider.close();
    }
  });
});
