import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Handoff,
  NativeProvider,
  isFunctionApprovalRequest,
  parseSessionState,
  tool,
  type ToolContext,
} from '../../src';
import { isManualSessionState } from '../../src/runtime/state';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(async () => {
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'current function caller authority',
  () => {
    it.each(['function', 'custom'] as const)(
      'refuses a forged direct %s call to a code-only function before its hook',
      async (wire) => {
        const server = new ModelServer([
          [
            wire === 'function'
              ? call('guarded', {}, { callId: 'forged-direct' })
              : {
                  type: 'custom_tool_call',
                  name: 'guarded',
                  call_id: 'forged-direct',
                  input: '{}',
                },
          ],
          [message('done')],
        ]);
        const config = await server.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-caller-policy',
          supportsWebsockets: false,
        });
        const before = vi.fn(() => ({ action: 'allow' as const }));
        const execute = vi.fn(() => 'effect');
        const agent = new Agent({
          instructions: 'Run.',
          model: 'gpt-5',
          provider,
          programmaticToolCalling: false,
          tools: [
            tool({
              name: 'guarded',
              parameters: z.object({}),
              ...{ allowedCallers: ['code'] as const },
              before,
              execute,
            }),
          ],
        });
        await using session = await agent.session();
        await (await session.submit('Run.')).wait();
        expect(before).toHaveBeenCalledTimes(0);
        expect(execute).toHaveBeenCalledTimes(0);
      },
      20_000,
    );

    it.each([
      { routes: ['code'] as const, deferred: false },
      { routes: ['direct', 'code'] as const, deferred: false },
      { routes: ['code'] as const, deferred: true },
    ])(
      'permits a Code Mode call with $routes (deferred=$deferred)',
      async ({ routes, deferred }) => {
        const server = new ModelServer([
          [
            {
              type: 'custom_tool_call',
              name: 'exec',
              call_id: 'cell',
              input: 'text(await tools.guarded({}));',
            },
          ],
          [message('done')],
        ]);
        await using provider = await providerFor(server);
        const observed: string[] = [];
        await using session = await new Agent({
          instructions: 'Run.',
          model: 'gpt-5',
          provider,
          programmaticToolCalling: true,
          tools: [
            tool({
              name: 'guarded',
              parameters: z.object({}),
              allowedCallers: routes,
              deferLoading: deferred,
              execute: (_args, context: ToolContext) => {
                observed.push(context.call!.route);
                return 'value';
              },
            }),
          ],
        }).session();
        expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
          'done',
        );
        expect(observed).toEqual(['code']);
        server.assertExhausted();
      },
      20_000,
    );

    it('keeps direct-only tools out of the Code Mode callable catalog', async () => {
      const server = new ModelServer([
        [
          {
            type: 'custom_tool_call',
            name: 'exec',
            call_id: 'cell',
            input: 'text(await tools.guarded({}));',
          },
        ],
        [message('done')],
      ]);
      await using provider = await providerFor(server);
      const before = vi.fn(() => ({ action: 'allow' as const }));
      const execute = vi.fn(() => 'value');
      await using session = await new Agent({
        instructions: 'Run.',
        model: 'gpt-5',
        provider,
        programmaticToolCalling: true,
        tools: [
          tool({
            name: 'guarded',
            parameters: z.object({}),
            allowedCallers: ['direct'],
            before,
            execute,
          }),
        ],
      }).session();
      expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
        'done',
      );
      expect(before).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      server.assertExhausted();
    }, 20_000);

    it.each([
      { routes: undefined },
      { routes: ['direct'] as const },
      { routes: ['direct', 'code'] as const },
    ])(
      'preserves direct invocation with $routes',
      async ({ routes }) => {
        const server = new ModelServer([
          [call('guarded', {}, { callId: 'direct' })],
          [message('done')],
        ]);
        await using provider = await providerFor(server);
        const execute = vi.fn(() => 'value');
        await using session = await new Agent({
          instructions: 'Run.',
          model: 'gpt-5',
          provider,
          programmaticToolCalling: false,
          tools: [
            tool({
              name: 'guarded',
              parameters: z.object({}),
              allowedCallers: routes,
              execute,
            }),
          ],
        }).session();
        expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
          'done',
        );
        expect(execute).toHaveBeenCalledTimes(1);
        server.assertExhausted();
      },
      20_000,
    );

    it('advertises explicit direct and both declarations without exposing code-only schemas', async () => {
      const server = new ModelServer([[message('done')]]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Run.',
        model: 'gpt-5',
        provider,
        programmaticToolCalling: true,
        tools: [
          tool({
            name: 'direct_only',
            parameters: z.object({}),
            allowedCallers: ['direct'],
            execute: () => 'value',
          }),
          tool({
            name: 'code_only',
            parameters: z.object({}),
            allowedCallers: ['code'],
            execute: () => 'value',
          }),
          tool({
            name: 'both',
            parameters: z.object({}),
            allowedCallers: ['direct', 'code'],
            execute: () => 'value',
          }),
        ],
      }).session();
      await (await session.submit('Run.')).wait();
      const names = (
        server.requests[0].tools as { name: string; type: string }[]
      )
        .filter((entry) => entry.type === 'function')
        .map((entry) => entry.name);
      expect(names).toContain('direct_only');
      expect(names).toContain('both');
      expect(names).not.toContain('code_only');
      expect(JSON.stringify(server.requests[0].tools)).not.toContain(
        'allowedCallers',
      );
      server.assertExhausted();
    }, 20_000);

    it.each(['save', 'fork'] as const)(
      'uses current caller authority after portable %s',
      async (kind) => {
        const server = new ModelServer([
          [message('saved')],
          [call('guarded', {}, { callId: 'restored-forged' })],
          [message('done')],
        ]);
        await using provider = await providerFor(server);
        const declaration = {
          instructions: 'Run.',
          model: 'gpt-5',
          provider,
          programmaticToolCalling: false,
        };
        await using source = await new Agent({
          ...declaration,
          tools: [
            tool({
              name: 'guarded',
              parameters: z.object({}),
              allowedCallers: ['direct'],
              execute: () => 'old',
            }),
          ],
        }).session();
        await (await source.submit('Save.')).wait();
        const saved =
          kind === 'save' ? await source.saveState() : await source.fork();
        await source.close();
        const before = vi.fn(() => ({ action: 'allow' as const }));
        const execute = vi.fn(() => 'current');
        await using restored = await new Agent({
          ...declaration,
          tools: [
            tool({
              name: 'guarded',
              parameters: z.object({}),
              allowedCallers: ['code'],
              before,
              execute,
            }),
          ],
        }).session({ state: parseSessionState(JSON.stringify(saved)) });
        expect((await (await restored.submit('Run.')).wait()).finalOutput).toBe(
          'done',
        );
        expect(before).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
        server.assertExhausted();
      },
      20_000,
    );

    it.each([
      { routes: undefined, canRestore: true },
      { routes: ['direct'] as const, canRestore: true },
      { routes: ['code'] as const, canRestore: false },
    ])(
      'checks the current caller policy before reissuing a direct approval ($routes)',
      async ({ routes, canRestore }) => {
        const server = new ModelServer([
          [call('guarded', {}, { callId: 'pending-direct' })],
          ...(canRestore ? [[message('done')]] : []),
        ]);
        await using provider = await providerFor(server);
        const declaration = {
          instructions: 'Run.',
          model: 'gpt-5',
          provider,
        };
        const previous = new Agent({
          ...declaration,
          tools: [
            tool({
              name: 'guarded',
              parameters: z.object({}),
              allowedCallers: ['direct'],
              needsApproval: true,
              execute: () => 'previous',
            }),
          ],
        });
        let state;
        {
          await using source = await previous.session();
          await source.submit('Run.');
          for await (const event of source.interactions()) {
            if (isFunctionApprovalRequest(event)) break;
          }
          state = parseSessionState(JSON.stringify(await source.suspend()));
        }
        const execute = vi.fn(() => 'current');
        const current = new Agent({
          ...declaration,
          tools: [
            tool({
              name: 'guarded',
              parameters: z.object({}),
              allowedCallers: routes,
              needsApproval: true,
              execute,
            }),
          ],
        });
        if (canRestore) {
          await using restored = await current.session({ state });
          for await (const event of restored.interactions()) {
            if (isFunctionApprovalRequest(event)) {
              await restored.respond(event.approve());
              break;
            }
          }
          expect((await restored.restoredTurn!.wait()).finalOutput).toBe(
            'done',
          );
          expect(execute).toHaveBeenCalledTimes(1);
        } else {
          // Always dispose the session if this check regresses and opens it.
          await expect(
            (async () => {
              await using _restored = await current.session({ state });
            })(),
          ).rejects.toThrow('does not permit direct calls');
          expect(execute).not.toHaveBeenCalled();
        }
        server.assertExhausted();
      },
      20_000,
    );

    it('keeps a completed approval as history after its tool becomes code-only', async () => {
      const server = new ModelServer([
        [
          call('pending', {}, { callId: 'pending-first' }),
          call('completed', {}, { callId: 'completed-second' }),
        ],
        [message('done')],
      ]);
      await using provider = await providerFor(server);
      const declaration = {
        instructions: 'Run both.',
        model: 'gpt-5',
        provider,
      };
      const pending = tool({
        name: 'pending',
        parameters: z.object({}),
        needsApproval: true,
        execute: () => 'pending result',
      });
      const completed = Promise.withResolvers<void>();
      const previous = new Agent({
        ...declaration,
        tools: [
          pending,
          tool({
            name: 'completed',
            parameters: z.object({}),
            allowedCallers: ['direct'],
            needsApproval: true,
            execute: () => {
              completed.resolve();
              return 'original result';
            },
          }),
        ],
      });
      let state;
      {
        await using source = await previous.session();
        await source.submit('Run.');
        for await (const event of source.interactions()) {
          if (
            !isFunctionApprovalRequest(event) ||
            event.callId !== 'completed-second'
          )
            continue;
          await source.respond(event.approve());
          break;
        }
        await completed.promise;
        state = parseSessionState(JSON.stringify(await source.suspend()));
      }
      expect(
        isManualSessionState(state) &&
          state.manual_continuation.accepted_replies['completed-second'],
      ).toBeTruthy();
      const execute = vi.fn(() => 'must not execute again');
      await using restored = await new Agent({
        ...declaration,
        tools: [
          pending,
          tool({
            name: 'completed',
            parameters: z.object({}),
            allowedCallers: ['code'],
            needsApproval: true,
            execute,
          }),
        ],
      }).session({ state });
      for await (const event of restored.interactions()) {
        if (isFunctionApprovalRequest(event)) {
          expect(event.callId).toBe('pending-first');
          await restored.respond(event.approve());
          break;
        }
      }
      expect((await restored.restoredTurn!.wait()).finalOutput).toBe('done');
      expect(execute).not.toHaveBeenCalled();
      expect(JSON.stringify(server.requests[1].input)).toContain(
        'original result',
      );
      server.assertExhausted();
    }, 20_000);

    it('keeps the selected profile mask after an explicit-direct callback handoff', async () => {
      const server = new ModelServer([
        [call('transfer', {}, { callId: 'handoff' })],
        [call('guarded', {}, { callId: 'worker-forged' })],
        [message('done')],
      ]);
      await using provider = await providerFor(server);
      const execute = vi.fn(() => 'value');
      const transfer = vi.fn(() => 'accepted');
      const worker = new Agent({
        instructions: 'Worker.',
        tools: [
          tool({
            name: 'guarded',
            parameters: z.object({}),
            allowedCallers: ['code'],
            execute,
          }),
        ],
      });
      const callback = tool({
        name: 'transfer',
        parameters: z.object({}),
        allowedCallers: ['direct'],
        execute: transfer,
      });
      await using session = await new Agent({
        instructions: 'Run.',
        model: 'gpt-5.5',
        provider,
        programmaticToolCalling: false,
        handoffs: [new Handoff(worker, callback)],
      }).session();
      expect((await (await session.submit('Run.')).wait()).finalOutput).toBe(
        'done',
      );
      expect(transfer).toHaveBeenCalledTimes(1);
      expect(execute).not.toHaveBeenCalled();
      expect(await session.getActiveAgent()).toBe(worker);
      server.assertExhausted();
    }, 20_000);
  },
);

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-caller-policy',
    supportsWebsockets: false,
  });
}
