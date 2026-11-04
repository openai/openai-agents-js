import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  manualTool,
  parseSessionState,
  tool,
  type ActionRequested,
  type Session,
} from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const report = z.object({ label: z.string().min(2) });

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-repair-capture-key',
    supportsWebsockets: false,
  });
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

async function nextAction(session: Session<unknown>): Promise<ActionRequested> {
  for await (const event of session.events())
    if (event.type === 'action_requested') return event;
  throw new Error('Expected pending manual action');
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native prompted repair capture',
  () => {
    it('preserves settled repair receipts through a later manual transfer with matching nonzero budget and fresh replies', async () => {
      const repaired = 'EARLIER_REPAIR_ONLY';
      const effects: string[] = [];
      const server = new ModelServer([
        [call('record', {}, { callId: 'earlier-effect' })],
        [message('{"label":"x"}')],
        [message(JSON.stringify({ label: repaired }))],
        [call('decision', {}, { callId: 'later-decision' })],
        [message('{"label":"accepted"}')],
      ]);
      await using provider = await providerFor(server);
      const declaration = {
        instructions: 'Answer or ask for a decision.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'record',
            parameters: z.object({}),
            execute() {
              effects.push('once');
              return 'EARLIER_EFFECT_RECEIPT';
            },
          }),
          manualTool({
            name: 'decision',
            description: 'Ask for a decision.',
            parameters: z.object({}),
            result: z.string(),
          }),
        ],
        outputType: {
          mode: 'prompted' as const,
          schema: report,
          maxRetries: 1,
        },
      };
      const agent = new Agent(declaration);
      await using source = await agent.session();
      const earlier = await source.submit('EARLIER_ROOT');
      const earlierResult = await earlier.wait();
      expect(earlierResult.finalOutput).toEqual({ label: repaired });
      expect(earlierResult.repairAttempts).toHaveLength(1);
      const attempt = earlierResult.repairAttempts[0];
      expect(attempt).toMatchObject({
        parentSessionId: source.id,
        parentTurnId: earlier.turnId,
        status: 'completed',
      });
      expect(attempt.sessionId).not.toBe(source.id);
      const repairItems = (await collect(source.items())).filter(
        (item) => item.turnId === attempt.id,
      );
      expect(JSON.stringify(repairItems)).toContain(repaired);
      expect(effects).toEqual(['once']);
      expect(server.requests).toHaveLength(3);

      const later = await source.submit('LATER_MANUAL_ROOT');
      const oldAction = await nextAction(source);
      const staleReply = oldAction.reply('STALE_MANUAL_REPLY');
      const interrupted = later.wait().catch((error: unknown) => error);
      const state = parseSessionState(JSON.stringify(await source.suspend()));
      expect(await interrupted).toBeInstanceOf(InteractionRequired);
      if (state.kind !== 'manual')
        throw new Error('Expected output-aware manual state');
      expect(state.output_context).toMatchObject({
        mode: 'prompted',
        budget: 1,
      });
      expect(state.manual_continuation.turn_id).toBe(later.turnId);
      expect(state.repair_turns).toHaveLength(1);
      expect(state.repair_turns[0]).toMatchObject({
        id: attempt.id,
        sessionId: attempt.sessionId,
        parentTurnId: earlier.turnId,
      });
      // The earlier invalid output is native history; the correction is passive.
      expect(JSON.stringify(state.history)).toContain('EARLIER_ROOT');
      expect(JSON.stringify(state.history)).not.toContain(repaired);
      expect(JSON.stringify(state.repair_items)).toContain(repaired);
      expect(JSON.stringify(state)).not.toContain(
        'synthetic-repair-capture-key',
      );
      expect(server.requests).toHaveLength(4);
      await source.close();

      await expect(
        new Agent({
          ...declaration,
          outputType: { mode: 'prompted', schema: report, maxRetries: 2 },
        }).session({ state }),
      ).rejects.toThrow('matching current output contract');
      expect(server.requests).toHaveLength(4);
      await using restored = await agent.session({ state });
      const fresh = await nextAction(restored);
      expect(server.requests).toHaveLength(4);
      const restoredAttempts = (await collect(restored.turns())).filter(
        (row) => 'parentTurnId' in row && row.parentTurnId === earlier.turnId,
      );
      expect(restoredAttempts).toEqual([
        { ...attempt, parentSessionId: restored.id },
      ]);
      expect(
        (await collect(restored.items())).filter(
          (item) => item.turnId === attempt.id,
        ),
      ).toEqual(repairItems);
      await expect(restored.respond(staleReply)).rejects.toThrow();
      expect(server.requests).toHaveLength(4);
      await restored.respond(fresh.reply('FRESH_MANUAL_REPLY'));
      const resumed = await restored.wait();
      expect(resumed.turn.turnId).toBe(later.turnId);
      expect(resumed.finalOutput).toEqual({ label: 'accepted' });
      expect(resumed.repairAttempts).toEqual([]);
      expect(await restored.wait()).toBe(resumed);
      expect(server.requests).toHaveLength(5);
      expect(JSON.stringify(server.requests[4].input)).toContain(
        'FRESH_MANUAL_REPLY',
      );
      expect(JSON.stringify(server.requests[4].input)).not.toContain(
        'STALE_MANUAL_REPLY',
      );
      expect(JSON.stringify(server.requests[4].input)).not.toContain(repaired);
      const recaptured = await restored.saveState();
      if (recaptured.kind !== 'idle')
        throw new Error('Expected output-aware idle state');
      expect(recaptured.repair_turns).toHaveLength(1);
      expect(recaptured.repair_items).toEqual(
        state.repair_items.map((item) => ({
          ...item,
          parentSessionId: restored.id,
        })),
      );
      expect(effects).toEqual(['once']);
      expect(server.requests).toHaveLength(5);
      server.assertExhausted();
    }, 25000);

    it('keeps real repair receipts across supplied summaries and fork restore without placing repaired text in later input', async () => {
      const repaired = 'PASSIVE_CORRECTED_LABEL';
      const effects: string[] = [];
      const server = new ModelServer([
        [call('record', {}, { callId: 'summary-effect' })],
        [message('{"label":"x"}')],
        [message(JSON.stringify({ label: repaired }))],
        [message('later plain answer')],
      ]);
      await using provider = await providerFor(server);
      const agent = new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        tools: [
          tool({
            name: 'record',
            parameters: z.object({}),
            execute() {
              effects.push('once');
              return 'SUMMARY_EFFECT_RECEIPT';
            },
          }),
        ],
        outputType: { mode: 'prompted', schema: report, maxRetries: 1 },
      });
      await using source = await agent.session();
      const root = await source.submit('ORIGINAL_SUMMARY_TASK');
      const result = await root.wait();
      expect(result.finalOutput).toEqual({ label: repaired });
      expect(result.repairAttempts).toHaveLength(1);
      const attempt = result.repairAttempts[0];
      const before = await source.saveState();
      if (before.kind !== 'idle')
        throw new Error('Expected output-aware idle state');
      expect(before.repair_turns).toHaveLength(1);
      expect(before.repair_items.length).toBeGreaterThan(0);
      expect(JSON.stringify(before.history)).toContain('ORIGINAL_SUMMARY_TASK');
      expect(JSON.stringify(before.history)).not.toContain(repaired);
      expect(JSON.stringify(before.repair_items)).toContain(repaired);
      const repairItems = (await collect(source.items())).filter(
        (item) => item.turnId === attempt.id,
      );
      const restore = vi.spyOn(
        (await binding()).Engine.prototype,
        'restore_checkpoint',
      );
      await source.compact({ summary: 'Supplied summary before fork.' });
      const fork = parseSessionState(JSON.stringify(await source.fork()));
      if (fork.kind !== 'idle') throw new Error('Expected output-aware fork');
      expect(fork.repair_turns).toEqual(
        before.repair_turns.map((row) => ({
          ...row,
          parentSessionId: fork.source_session_id,
        })),
      );
      expect(fork.repair_items).toEqual(
        before.repair_items.map((row) => ({
          ...row,
          parentSessionId: fork.source_session_id,
        })),
      );
      expect(JSON.stringify(fork.history)).not.toContain(repaired);
      expect(server.requests).toHaveLength(3);
      expect(effects).toEqual(['once']);
      await source.close();

      await using branch = await agent.session({ state: fork });
      await branch.compact({ summary: 'Supplied summary after fork.' });
      const final = parseSessionState(JSON.stringify(await branch.saveState()));
      if (final.kind !== 'idle')
        throw new Error('Expected output-aware idle state');
      expect(final.repair_turns).toEqual(fork.repair_turns);
      expect(final.repair_items).toEqual(fork.repair_items);
      expect(
        (await collect(branch.items())).filter(
          (item) => item.turnId === attempt.id,
        ),
      ).toEqual(repairItems);
      expect(JSON.stringify(final.history)).not.toContain(repaired);
      expect(restore).toHaveBeenCalled();
      for (const [json] of restore.mock.calls) {
        expect(json).not.toContain(repaired);
        expect(json).not.toContain('repair_turns');
        expect(json).not.toContain('repair_items');
      }
      expect(server.requests).toHaveLength(3);
      expect(effects).toEqual(['once']);
      const later = await branch.submitWithOutput(
        'LATER_PLAIN_ROOT',
        z.string(),
      );
      const plain = await later.wait();
      expect(plain.finalOutput).toBe('later plain answer');
      expect(plain.repairAttempts).toEqual([]);
      expect(JSON.stringify(server.requests[3].input)).toContain(
        'Supplied summary after fork.',
      );
      expect(JSON.stringify(server.requests[3].input)).not.toContain(repaired);
      expect(server.requests).toHaveLength(4);
      expect(effects).toEqual(['once']);
      expect(await root.wait()).toBe(result);
      server.assertExhausted();
    }, 25000);
  },
);
