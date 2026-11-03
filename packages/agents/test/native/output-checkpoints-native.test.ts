import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  parseSessionState,
  webSearch,
  type ActionRequested,
  type Session,
} from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

async function nextAction(session: Session<unknown>): Promise<ActionRequested> {
  for await (const event of session.events())
    if (event.type === 'action_requested') return event;
  throw new Error('Expected pending manual action');
}
async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture-output-checkpoints',
  });
}
const decision = () =>
  manualTool({
    name: 'decision',
    description: 'Ask.',
    parameters: z.object({}),
    result: z.string(),
  });

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'output-aware native checkpoints',
  () => {
    it('seals prompted output once and restores with fresh reply authority after persistence failure and close', async () => {
      const server = new ModelServer([
        [call('decision', {}, { callId: 'prompted-decision' })],
        (request) => {
          expect(request).not.toHaveProperty('text.format');
          expect(JSON.stringify(request.input).split('ASK-ONCE')).toHaveLength(
            2,
          );
          return [message('{"answer":"accepted"}')];
        },
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Ask.',
        model: 'gpt-5',
        provider,
        tools: [decision(), webSearch()],
        outputType: {
          mode: 'prompted',
          schema: z.object({ answer: z.string() }),
        },
      });
      await using original = await agent.session();
      const turn = await original.submit('ASK-ONCE');
      const oldAction = await nextAction(original);
      const staleReply = oldAction.reply('stale');
      const failure = turn.wait().catch((error: unknown) => error);
      const seal = vi.spyOn(
        (await binding()).NativeThread.prototype,
        '_seal_manual_checkpoint',
      );
      const state = await original.suspend();
      const exact = JSON.stringify(state);
      const error = await failure;
      expect(error).toBeInstanceOf(InteractionRequired);
      if (!(error instanceof InteractionRequired) || !error.state)
        throw new Error('Expected retained seal receipt');
      expect(JSON.stringify(error.state)).toBe(exact);
      expect(error.state).not.toBe(state);
      error.state.native.root_metadata.caller = 'mutated error copy';
      const persist = async () => {
        state.native.root_metadata.caller = 'failed write';
        throw new Error('application persistence failed');
      };
      await expect(persist()).rejects.toThrow('application persistence failed');
      await original.close();
      const recovered = await original.suspend();
      expect(JSON.stringify(recovered)).toBe(exact);
      expect(await original.suspend()).not.toBe(recovered);
      expect(seal).toHaveBeenCalledTimes(1);
      expect(server.requests).toHaveLength(1);
      expect(server.requests[0]).not.toHaveProperty('text.format');
      expect(recovered.kind).toBe('manual');
      const native = await binding();
      const create = vi.spyOn(native, 'create_checkpoint_engine');
      const restore = vi.spyOn(native.Engine.prototype, 'restore_checkpoint');
      await using restored = await agent.session({
        state: parseSessionState(exact),
      });
      const checkpoint = create.mock.lastCall?.[3];
      expect(checkpoint).toBe(restore.mock.lastCall?.[0]);
      expect(create.mock.lastCall?.[5]).toBe(true);
      expect(restore.mock.lastCall?.[3]).toBe(true);
      expect(JSON.parse(checkpoint!)).toMatchObject({ format_version: 2 });
      expect(checkpoint).not.toContain('output_context');
      expect(checkpoint).not.toContain('repair_turns');
      const fresh = await nextAction(restored);
      await expect(restored.respond(staleReply)).rejects.toThrow();
      await restored.respond(fresh.reply('accepted'));
      expect((await restored.wait()).finalOutput).toEqual({
        answer: 'accepted',
      });
      server.assertExhausted();
    }, 25000);

    it('uses the active prompted override for a pending seal and the opening default for idle save', async () => {
      const server = new ModelServer([
        [call('decision', {}, { callId: 'override' })],
        [message('7')],
      ]);
      await using provider = await providerFor(server);
      const declaration = {
        instructions: 'Ask.',
        model: 'gpt-5',
        provider,
        tools: [decision()],
      };
      await using original = await new Agent(declaration).session();
      const turn = await original.submitWithOutput('ASK', {
        mode: 'prompted',
        schema: z.number(),
      });
      await nextAction(original);
      const failure = turn.wait().catch((error: unknown) => error);
      const state = await original.suspend();
      expect(await failure).toBeInstanceOf(InteractionRequired);
      await original.close();
      await expect(new Agent(declaration).session({ state })).rejects.toThrow(
        'matching current output contract',
      );
      const agent = new Agent({
        ...declaration,
        outputType: { mode: 'prompted' as const, schema: z.number() },
      });
      await using restored = await agent.session({ state });
      const action = await nextAction(restored);
      await restored.respond(action.reply('accepted'));
      expect((await restored.wait()).finalOutput).toBe(7);
      const idle = await restored.saveState();
      expect(idle.kind).toBe('idle');
      if (idle.kind !== 'idle')
        throw new Error('Expected output-aware idle state');
      expect(idle.output_context.mode).toBe('prompted');
      server.assertExhausted();
    }, 25000);

    it('retains automatic plain seal receipts for post-close recovery', async () => {
      const server = new ModelServer([
        [call('decision', {}, { callId: 'plain' })],
        [message('done')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Ask.',
        model: 'gpt-5',
        provider,
        tools: [decision()],
      });
      const failure = await agent.run('ASK').catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(InteractionRequired);
      if (!(failure instanceof InteractionRequired) || !failure.state)
        throw new Error('Expected automatic receipt');
      expect(failure.state.kind).toBe('manual');
      await using restored = await agent.session({
        state: parseSessionState(JSON.stringify(failure.state)),
      });
      const action = await nextAction(restored);
      await restored.respond(action.reply('accepted'));
      expect((await restored.wait()).finalOutput).toBe('done');
      server.assertExhausted();
    }, 25000);
    it('preserves passive attempt identities across supplied summaries and forks without sending them to Core', async () => {
      const marker = 'PRIVATE-REPAIR-MARKER';
      const server = new ModelServer([
        [message('initial')],
        (request) => {
          expect(JSON.stringify(request)).not.toContain(marker);
          return [message('next')];
        },
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      });
      await using initial = await agent.session();
      const originalTurn = await (await initial.submit('START')).wait();
      const state = await initial.saveState();
      if (state.kind !== 'idle')
        throw new Error('Expected output-aware idle state');
      state.repair_turns.push({
        id: 'attempt-turn',
        object: 'agent.session.turn',
        sessionId: 'attempt-session',
        subagentId: null,
        status: 'completed',
        createdAt: null,
        startedAt: null,
        completedAt: null,
        error: null,
        usage: null,
        parentSessionId: state.native.source_session_id,
        parentTurnId: originalTurn.turn.turnId,
      });
      state.repair_items.push({
        sessionId: 'attempt-session',
        parentSessionId: state.native.source_session_id,
        parentTurnId: originalTurn.turn.turnId,
        item: {
          id: 'attempt-item',
          turnId: 'attempt-turn',
          type: 'message',
          text: marker,
        },
      });
      await initial.close();
      const restore = vi.spyOn(
        (await binding()).Engine.prototype,
        'restore_checkpoint',
      );
      await using source = await agent.session({
        state: parseSessionState(JSON.stringify(state)),
      });
      await source.compact({ summary: 'Supplied before fork.' });
      const forked = await source.fork();
      if (forked.kind !== 'idle') throw new Error('Expected output-aware fork');
      expect(forked.repair_turns[0]).toMatchObject({
        sessionId: 'attempt-session',
        id: 'attempt-turn',
        parentSessionId: forked.native.source_session_id,
        parentTurnId: originalTurn.turn.turnId,
      });
      expect(forked.repair_items[0].item.id).toBe('attempt-item');
      await source.close();
      await using branch = await agent.session({ state: forked });
      await branch.compact({ summary: 'Supplied after fork.' });
      const final = await branch.saveState();
      if (final.kind !== 'idle')
        throw new Error('Expected output-aware idle state');
      expect(final.repair_turns).toEqual(forked.repair_turns);
      expect(final.repair_items).toEqual(forked.repair_items);
      for (const [json] of restore.mock.calls) {
        expect(json).not.toContain(marker);
        expect(json).not.toContain('repair_turns');
        expect(json).not.toContain('output_context');
      }
      expect((await (await branch.submit('NEXT')).wait()).finalOutput).toBe(
        'next',
      );
      server.assertExhausted();
    }, 25000);
  },
);
