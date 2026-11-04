import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  InteractionRequired,
  NativeProvider,
  manualTool,
  parseSessionState,
  tool,
  type ActionRequested,
  type ObservedEvent,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { isManualSessionState } from '../../src/runtime/state';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

async function action(
  events: AsyncIterator<ObservedEvent>,
): Promise<ActionRequested> {
  for (;;) {
    const next = await events.next();
    if (next.done) throw new Error('Expected a pending manual call');
    if (next.value.type === 'action_requested') return next.value;
  }
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-settled-recovery',
    supportsWebsockets: false,
  });
}
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'settled native recovery',
  () => {
    it('recovers the original typed manual turn after a committed effect and an accepted sibling reply', async () => {
      let effects = 0;
      const lookup = manualTool({
        name: 'lookup',
        description: 'Read an application-selected record.',
        parameters: z.strictObject({ key: z.string() }),
        result: z.string(),
      });
      const record = tool({
        name: 'record',
        parameters: z.strictObject({}),
        execute: () => {
          effects++;
          return 'committed-before-suspension';
        },
      });
      const output = {
        mode: 'native' as const,
        schema: z.strictObject({ answer: z.string() }),
      };
      const server = new ModelServer([
        [call('record', {}, { callId: 'original-effect' })],
        [
          call('lookup', { key: 'A' }, { callId: 'manual-A' }),
          call('lookup', { key: 'B' }, { callId: 'manual-B' }),
        ],
        [message('{"answer":"done"}')],
      ]);
      await using provider = await providerFor(server);
      const declaration = {
        instructions: 'Record once, then ask for both records.',
        model: 'gpt-5',
        provider,
        tools: [record, lookup],
      };
      const originalAgent = new Agent(declaration);
      await using original = await originalAgent.session();
      const events = original.events()[Symbol.asyncIterator]();
      const first = await original.submitWithOutput(
        'Read both records.',
        output,
      );
      const requests = [await action(events), await action(events)];
      const a = requests.find((request) => request.callId === 'manual-A')!;
      const b = requests.find((request) => request.callId === 'manual-B')!;
      expect(a).toBeDefined();
      expect(b).toBeDefined();
      const stale = b.reply('stale');
      await original.respond(a.reply('accepted-A'));
      const outcome = first.wait().catch((error: unknown) => error);
      const state = await original.suspend();
      expect(await outcome).toBeInstanceOf(InteractionRequired);
      expect(await original.suspend()).toEqual(state);
      await events.return?.();
      await original.close();
      expect(effects).toBe(1);
      expect(state.kind).toBe('manual');
      if (!isManualSessionState(state))
        throw new Error('Expected pending manual state');
      expect(state.manual_continuation.turn_id).toBe(first.turnId);
      expect(
        state.manual_continuation.pending_manual.map((item) => item.call_id),
      ).toEqual(['manual-B']);
      expect(
        Object.keys(state.manual_continuation.accepted_replies).sort(),
      ).toEqual(['manual-A', 'original-effect']);

      const acquire = vi.spyOn(provider, '_acquire');
      await expect(originalAgent.session({ state })).rejects.toThrow(
        'matching current output contract',
      );
      await expect(
        new Agent({
          ...declaration,
          outputType: {
            mode: 'native',
            schema: z.strictObject({ other: z.number() }),
          },
        }).session({ state }),
      ).rejects.toThrow('matching current output contract');
      expect(acquire).not.toHaveBeenCalled();
      const saved = parseSessionState(JSON.stringify(state));
      await using restored = await new Agent({
        ...declaration,
        outputType: output,
      }).session({ state: saved });
      const restoredEvents = restored.events()[Symbol.asyncIterator]();
      const current = await action(restoredEvents);
      expect(current.callId).toBe('manual-B');
      expect(current.turnId).toBe(first.turnId);
      await expect(restored.respond(stale)).rejects.toThrow();
      await restored.respond(current.reply('accepted-B'));
      expect((await restored.wait()).finalOutput).toEqual({ answer: 'done' });
      await restoredEvents.return?.();
      expect(effects).toBe(1);
      expect(server.requests).toHaveLength(3);
      const format = (server.requests[0].text as JsonObject).format;
      expect(format).toMatchObject({ type: 'json_schema', strict: true });
      for (const request of server.requests)
        expect((request.text as JsonObject).format).toEqual(format);
      const outputs = (server.requests[2].input as JsonObject[]).filter(
        (item) => item.type === 'function_call_output',
      );
      for (const id of ['original-effect', 'manual-A', 'manual-B'])
        expect(outputs.filter((item) => item.call_id === id)).toHaveLength(1);
      expect(JSON.stringify(outputs)).toContain('committed-before-suspension');
      expect(JSON.stringify(outputs)).toContain('accepted-A');
      expect(JSON.stringify(outputs)).toContain('accepted-B');
      server.assertExhausted();
    }, 25_000);

    it('cancels an unfinished child manual turn on portable restore without reviving its reply rights', async () => {
      const executor = await startPublicExecutor();
      let rootId: string | undefined;
      const counts = new Map<string, number>();
      const respond = (request: JsonObject) => {
        const metadata = request.client_metadata as Record<string, string>;
        const id = String(
          JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
        );
        rootId ??= id;
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        if (id !== rootId)
          return [call('decision', {}, { callId: 'child-decision' })];
        return count === 1
          ? [
              call(
                'spawn_agent',
                { task_name: 'child', message: 'Ask for a decision.' },
                { namespace: 'collaboration', callId: 'spawn-child' },
              ),
            ]
          : [message('root settled')];
      };
      const server = new ModelServer(Array.from({ length: 3 }, () => respond));
      try {
        await using provider = await providerFor(server);
        const agent = new Agent({
          instructions: 'Delegate the decision to a child.',
          model: 'gpt-5.5',
          provider,
          tools: [
            new NativeAgents(),
            manualTool({
              name: 'decision',
              description: 'Get an application decision.',
              parameters: z.strictObject({}),
              result: z.string(),
            }),
          ],
        });
        const environment = new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        });
        await using source = await agent.session({ environment });
        const events = source.events()[Symbol.asyncIterator]();
        const root = await source.submit('Start the child.');
        expect((await root.wait()).finalOutput).toBe('root settled');
        const request = await action(events);
        await events.return?.();
        const children = await Array.fromAsync(source.subagents());
        expect(children).toHaveLength(1);
        const child = children[0]!;
        if (!child.turn) throw new Error('Expected the real child turn');
        const originalTurn = child.turn;
        expect(request.subagentId).toBe(child.id);
        expect(request.turnId).toBe(originalTurn.turnId);
        const pending = await originalTurn.wait({ until: 'request' });
        if (!('requests' in pending))
          throw new Error('Expected an unfinished child manual request');
        expect(pending.requests).toHaveLength(1);
        expect(pending.requests[0]!.callId).toBe(request.callId);
        const prepared = request.reply('expired-prepared-child-reply');
        const originalOutcome = originalTurn
          .wait()
          .catch((error: unknown) => error);
        const saved = await source.saveState();
        expect(saved.source_session_id).toBe(source.id);
        expect(saved.interrupted_thread_ids).toContain(child.id);
        expect(saved.descendants).toHaveLength(1);
        expect(saved.descendants[0]).toMatchObject({
          thread_id: child.id,
          parent_thread_id: source.id,
        });
        await source.close();
        expect(await originalOutcome).toBeInstanceOf(Error);

        await using restored = await agent.session({
          environment,
          state: parseSessionState(JSON.stringify(saved)),
        });
        const restoredChildren = await Array.fromAsync(restored.subagents());
        expect(restoredChildren).toHaveLength(1);
        const restoredChild = restoredChildren[0]!;
        const retained = await Array.fromAsync(
          restored.turns({ subagentId: restoredChild.id }),
        );
        expect(retained).toContainEqual(
          expect.objectContaining({
            id: originalTurn.turnId,
            status: 'cancelled',
          }),
        );
        const before = await Array.fromAsync(
          restored.items({ subagentId: restoredChild.id }),
        );
        const rootBefore = await Array.fromAsync(restored.items());
        expect(await restored.pendingInteractions()).toEqual([]);
        await expect(restored.respond(prepared)).rejects.toThrow();
        await expect(restoredChild.submit(prepared)).rejects.toThrow();
        // A reply builder is data; dispatch must not revive its expired owner.
        const lateReply = request.reply('expired-action-child-reply');
        await expect(restored.respond(lateReply)).rejects.toThrow();
        await expect(restoredChild.submit(lateReply)).rejects.toThrow();
        expect(await restored.pendingInteractions()).toEqual([]);
        const after = await Array.fromAsync(
          restored.items({ subagentId: restoredChild.id }),
        );
        expect(after).toEqual(before);
        expect(await Array.fromAsync(restored.items())).toEqual(rootBefore);
        expect(JSON.stringify(after)).not.toContain(
          'expired-prepared-child-reply',
        );
        expect(JSON.stringify(after)).not.toContain(
          'expired-action-child-reply',
        );
        expect(
          await Array.fromAsync(
            restored.turns({ subagentId: restoredChild.id }),
          ),
        ).toEqual(retained);
        expect(server.requests).toHaveLength(3);
        server.assertExhausted();
      } finally {
        await executor.close();
      }
    }, 25_000);

    it('refuses a settled-root checkpoint while a child can still commit code, then restores matching child VM and history', async () => {
      const executor = await startPublicExecutor();
      const childEntered = Promise.withResolvers<void>();
      const releaseChild = Promise.withResolvers<void>();
      const committed = 'child-commit-4197';
      let restoring = false;
      let rootId: string | undefined;
      let childId: string | undefined;
      const counts = new Map<string, number>();
      const cell = (callId: string, input: string): JsonObject => ({
        type: 'custom_tool_call',
        name: 'exec',
        call_id: callId,
        input,
      });
      const respond = async (request: JsonObject): Promise<JsonObject[]> => {
        const metadata = request.client_metadata as Record<string, string>;
        const id = String(
          JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
        );
        rootId ??= id;
        const count = (counts.get(id) ?? 0) + 1;
        counts.set(id, count);
        if (id === rootId) {
          if (count === 1)
            return [
              restoring
                ? call(
                    'followup_task',
                    { target: childId!, message: 'Read the retained value.' },
                    { namespace: 'collaboration', callId: 'resume-child' },
                  )
                : call(
                    'spawn_agent',
                    { task_name: 'writer', message: 'Commit the child value.' },
                    { namespace: 'collaboration', callId: 'spawn-writer' },
                  ),
            ];
          return [message(restoring ? 'root resumed' : 'root settled')];
        }
        if (!restoring && count === 1)
          return [
            cell('child-seed', "store('child_value', 'seed'); text('seed');"),
          ];
        if (count === (restoring ? 1 : 2)) {
          if (!restoring) {
            childEntered.resolve();
            // Its first cell settled; the next model response can commit more.
            await releaseChild.promise;
            return [
              cell(
                'child-store',
                `store('child_value', '${committed}'); text(load('child_value'));`,
              ),
            ];
          }
          return [
            cell(
              'child-read',
              "text(load('child_value')); const current = await tools.read({}); store('child_binding', current); text(current);",
            ),
          ];
        }
        return [message(restoring ? 'child resumed' : 'child settled')];
      };
      const server = new ModelServer(Array.from({ length: 9 }, () => respond));
      try {
        await using provider = await providerFor(server);
        const read = (value: string) =>
          tool({
            name: 'read',
            description: 'Read the current application binding.',
            parameters: z.strictObject({}),
            execute: () => value,
          });
        const declaration = {
          instructions:
            'Delegate to the writer and retain its committed value.',
          model: 'gpt-5.5',
          provider,
          programmaticToolCalling: true,
        };
        const environment = new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        });
        await using source = await new Agent({
          ...declaration,
          tools: [new NativeAgents(), read('old-binding')],
        }).session({ environment });
        try {
          const root = await source.submit('Start the writer.');
          await childEntered.promise;
          expect(
            server.requests.some((request) =>
              (request.input as JsonObject[]).some(
                (item) =>
                  item.type === 'custom_tool_call_output' &&
                  item.call_id === 'child-seed',
              ),
            ),
          ).toBe(true);
          expect((await root.wait()).finalOutput).toBe('root settled');
          const children = await Array.fromAsync(source.subagents());
          expect(children).toHaveLength(1);
          const child = children[0]!;
          childId = child.id;
          if (!child.turn) throw new Error('Expected the real child turn');

          // No child cell is live now: VM-idleness alone cannot make this safe.
          await expect(source.saveState()).rejects.toThrow(/settled|busy/i);
          releaseChild.resolve();
          expect((await child.turn.wait()).finalOutput).toBe('child settled');
          const saved = await source.saveState();
          expect(saved.kind).toBe('idle');
          expect(saved.descendants).toHaveLength(1);
          const descendant = saved.descendants[0]!;
          expect(descendant.thread_id).toBe(childId);
          expect(descendant.code_mode?.stored_values.child_value).toBe(
            committed,
          );
          const history = descendant.history
            .filter((record) => record.type === 'response_item')
            .map((record) => record.payload as JsonObject);
          expect(
            history.filter(
              (item) =>
                item.type === 'custom_tool_call' &&
                item.call_id === 'child-store',
            ),
          ).toHaveLength(1);
          const outputs = history.filter(
            (item) =>
              item.type === 'custom_tool_call_output' &&
              item.call_id === 'child-store',
          );
          expect(outputs).toHaveLength(1);
          expect(JSON.stringify(outputs[0]!.output)).toContain(committed);
          await source.close();

          restoring = true;
          rootId = undefined;
          counts.clear();
          await using restored = await new Agent({
            ...declaration,
            tools: [new NativeAgents(), read('current-binding')],
          }).session({
            environment,
            state: parseSessionState(JSON.stringify(saved)),
          });
          expect(
            (await (await restored.submit('Continue the writer.')).wait())
              .finalOutput,
          ).toBe('root resumed');
          const resumedChildren = await Array.fromAsync(restored.subagents());
          const resumed = resumedChildren.find((item) => item.id === childId);
          if (!resumed?.turn)
            throw new Error('Expected the resumed child turn');
          expect((await resumed.turn.wait()).finalOutput).toBe('child resumed');
          const continued = await restored.saveState();
          const continuedChild = continued.descendants.find(
            (item) => item.thread_id === childId,
          )!;
          expect(continuedChild.code_mode?.stored_values).toMatchObject({
            child_value: committed,
            child_binding: 'current-binding',
          });
          const continuation = server.requests.find((request) =>
            (request.input as JsonObject[]).some(
              (item) =>
                item.type === 'custom_tool_call_output' &&
                item.call_id === 'child-read',
            ),
          );
          expect(continuation).toBeDefined();
          const result = (continuation!.input as JsonObject[]).find(
            (item) =>
              item.type === 'custom_tool_call_output' &&
              item.call_id === 'child-read',
          )!;
          expect(JSON.stringify(result.output)).toContain(committed);
          expect(JSON.stringify(result.output)).toContain('current-binding');
          expect(JSON.stringify(result.output)).not.toContain('old-binding');
          server.assertExhausted();
        } finally {
          releaseChild.resolve();
        }
      } finally {
        await executor.close();
      }
    }, 45_000);

    it('forks settled stored values into a fresh VM with current tool bindings without changing the source', async () => {
      let originalReads = 0;
      let currentReads = 0;
      const read = (execute: () => string) =>
        tool({
          name: 'read',
          description: 'Read the current application binding.',
          parameters: z.strictObject({}),
          execute,
        });
      const cell = (id: string, input: string) => ({
        type: 'custom_tool_call',
        name: 'exec',
        call_id: id,
        input,
      });
      const expectedSaved = JSON.parse(
        '{"label":"stored-data-4197","value":7,"__proto__":{"kept":true}}',
      );
      const server = new ModelServer([
        [
          cell(
            'stored-cell',
            'store(\'saved\', JSON.parse(\'{"label":"stored-data-4197","value":7,"__proto__":{"kept":true}}\')); store(\'__proto__\', [JSON.parse(\'{"__proto__":7}\')]);',
          ),
        ],
        [message('stored')],
        [
          cell(
            'current-cell',
            "const previous = await load('saved'); if (!Object.hasOwn(previous,'__proto__') || Object.getPrototypeOf(previous)!==Object.prototype || JSON.stringify(load('__proto__'))!=='[{\"__proto__\":7}]') throw new Error('Stored JSON keys changed'); text(previous.label); store('saved', {...previous,value:previous.value+1}); text(await tools.read({}));",
          ),
        ],
        [message('continued')],
      ]);
      await using provider = await providerFor(server);
      const declaration = {
        instructions: 'Use code to retain the selected JSON value.',
        model: 'gpt-5',
        provider,
        programmaticToolCalling: true,
      };
      await using source = await new Agent({
        ...declaration,
        tools: [
          read(() => {
            originalReads++;
            return 'old-binding';
          }),
        ],
      }).session();
      expect(
        (await (await source.submit('Store the value.')).wait()).finalOutput,
      ).toBe('stored');
      const saved = await source.saveState();
      const fork = await source.fork();
      expect(saved.kind).toBe('idle');
      expect(fork.kind).toBe('idle');
      expect(fork.source_session_id).not.toBe(saved.source_session_id);
      expect(fork.root_code_mode?.stored_values).toEqual(
        saved.root_code_mode?.stored_values,
      );
      expect(fork.root_code_mode?.stored_values.saved).toEqual(expectedSaved);
      expect(
        Object.hasOwn(fork.root_code_mode!.stored_values, '__proto__'),
      ).toBe(true);
      expect(Object.getPrototypeOf(fork.root_code_mode!.stored_values)).toBe(
        Object.prototype,
      );
      await using copy = await new Agent({
        ...declaration,
        tools: [
          read(() => {
            currentReads++;
            return 'current-binding';
          }),
        ],
      }).session({ state: parseSessionState(JSON.stringify(fork)) });
      expect(
        (
          await (
            await copy.submit('Read the saved value and current binding.')
          ).wait()
        ).finalOutput,
      ).toBe('continued');
      const changed = await copy.saveState();
      expect(changed.root_code_mode?.stored_values.saved).toEqual({
        ...expectedSaved,
        value: 8,
      });
      expect(BigInt(changed.root_code_mode!.next_cell_id)).toBeGreaterThan(
        BigInt(fork.root_code_mode!.next_cell_id),
      );
      expect(
        (await source.saveState()).root_code_mode?.stored_values.saved,
      ).toEqual(expectedSaved);
      expect(originalReads).toBe(0);
      expect(currentReads).toBe(1);
      expect(server.requests).toHaveLength(4);
      const result = (server.requests[3].input as JsonObject[]).find(
        (item) =>
          item.type === 'custom_tool_call_output' &&
          item.call_id === 'current-cell',
      );
      expect(result).toBeDefined();
      expect(JSON.stringify(result!.output)).toContain('stored-data-4197');
      expect(JSON.stringify(result!.output)).toContain('current-binding');
      expect(
        (server.requests[3].input as JsonObject[]).filter(
          (item) =>
            item.type === 'custom_tool_call' && item.call_id === 'stored-cell',
        ),
      ).toHaveLength(1);
      expect(JSON.stringify(fork)).not.toContain('synthetic-settled-recovery');
      server.assertExhausted();
    }, 25_000);
  },
);
