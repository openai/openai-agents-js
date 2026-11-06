import {
  firstNativeBatchWire,
  replaceSingletonNativeBatchEvent,
} from '../fixtures/native-event-batches';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, NativeProvider, tool } from '../../src';
import {
  binding,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const report = z.object({ label: z.string().min(2) });

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-repair-scope-key',
    supportsWebsockets: false,
  });
}

function rootMessage(request: JsonObject, marker: string): string {
  const messages = (request.input as JsonObject[]).filter(
    (item) => item.role === 'user' && JSON.stringify(item).includes(marker),
  );
  expect(messages).toHaveLength(1);
  return JSON.stringify(messages[0]);
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native prompted-repair output ownership and scope',
  () => {
    it('captures a queued prompted declaration before mutation and restores the later plain default', async () => {
      const entered = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      const held = message('blocker complete');
      const server = new ModelServer(
        [
          [held],
          [message('{"label":"x"}')],
          [message('{"label":"fixed"}')],
          [message('later plain root')],
        ],
        [],
        async (item) => {
          if (item === held) {
            entered.resolve();
            await release.promise;
          }
        },
      );
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
      }).session();
      try {
        const first = await session.submit('BLOCKER_ROOT');
        await entered.promise;
        const output = {
          mode: 'prompted' as const,
          schema: report,
          maxRetries: 1,
        };
        const queued = await session.enqueue('QUEUED_PROMPTED_ROOT', output);
        expect(queued.turnId).toBeNull();
        output.maxRetries = 0;
        output.schema = z.object({ label: z.string().min(20) });
        expect(server.requests).toHaveLength(1);
        release.resolve();
        const completed = await queued.wait();
        expect(completed.turn).toBe(queued);
        expect(completed.finalOutput).toEqual({ label: 'fixed' });
        expect(completed.repairAttempts).toHaveLength(1);
        expect(completed.repairAttempts[0]).toMatchObject({
          parentSessionId: session.id,
          parentTurnId: queued.turnId,
        });
        expect((await first.wait()).finalOutput).toBe('blocker complete');
        expect(await queued.wait()).toBe(completed);
        const queuedGuidance = rootMessage(
          server.requests[1],
          'QUEUED_PROMPTED_ROOT',
        );
        expect(queuedGuidance).toContain('only for this request');
        expect(queuedGuidance).toContain(
          'automatic continuations and tool results',
        );
        expect(queuedGuidance).toContain('does not apply to later requests');
        expect(server.requests[2].tools ?? []).toEqual([]);
        expect(JSON.stringify(server.requests[2])).not.toContain(
          'BLOCKER_ROOT',
        );
        expect(JSON.stringify(server.requests[2])).not.toContain(
          'QUEUED_PROMPTED_ROOT',
        );
        const plain = await session.submit('LATER_PLAIN_ROOT');
        const result = await plain.wait();
        expect(result.finalOutput).toBe('later plain root');
        expect(result.repairAttempts).toEqual([]);
        expect(rootMessage(server.requests[3], 'QUEUED_PROMPTED_ROOT')).toBe(
          queuedGuidance,
        );
        expect(
          rootMessage(server.requests[3], 'LATER_PLAIN_ROOT'),
        ).not.toContain('Return only JSON');
        expect(JSON.stringify(server.requests[3].input)).not.toContain('fixed');
        for (const request of server.requests)
          expect(request).not.toHaveProperty('text.format');
        server.assertExhausted();
      } finally {
        release.resolve();
      }
    }, 35000);

    it('repairs the actual completing automatic successor under the captured operation override', async () => {
      const native = await binding();
      const nextEvent = native.NativeThread.prototype._next_session_events;
      const submit = native.NativeThread.prototype._submit;
      let originalThreadId: string | undefined;
      let originalId: string | undefined;
      let successorId: string | undefined;
      vi.spyOn(
        native.NativeThread.prototype,
        '_next_session_events',
      ).mockImplementation(async function (this: NativeThread) {
        const raw = await nextEvent.call(this);
        const event = JSON.parse(firstNativeBatchWire(raw));
        if (
          !event.subagent_id &&
          ['task_complete', 'turn_complete'].includes(event.msg.type)
        ) {
          if (!originalId) {
            originalThreadId = this.id;
            originalId = event.id;
            // Project only the hard-to-schedule tail admission boundary.
            event.sdk_unsampled_steering = true;
            return replaceSingletonNativeBatchEvent(raw, event);
          }
          if (
            this.id === originalThreadId &&
            !successorId &&
            event.id !== originalId
          )
            successorId = event.id;
        }
        return raw;
      });
      vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
        async function (this: NativeThread, raw) {
          const request = JSON.parse(raw);
          if (request.mode !== 'continue_if_idle')
            return submit.call(this, raw);
          expect(this.id).toBe(originalThreadId);
          expect(request.expected_previous_turn_id).toBe(originalId);
          expect(request.input).toEqual([]);
          expect(request).not.toHaveProperty('start');
          return submit.call(
            this,
            JSON.stringify({
              mode: 'start_if_idle',
              input: [
                { type: 'text', text: 'projected continuation admission' },
              ],
            }),
          );
        },
      );
      const server = new ModelServer([
        [call('record', {}, { callId: 'ORIGINAL_EFFECT' })],
        [message('{"label":"predecessor valid"}')],
        [message('{"label":"x"}')],
        [message('{"label":"successor repaired"}')],
        [message('later ordinary root')],
      ]);
      await using provider = await providerFor(server);
      const execute = vi.fn(() => 'ONE_ORIGINAL_EFFECT_RECEIPT');
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        tools: [tool({ name: 'record', parameters: z.object({}), execute })],
      }).session();
      const turn = await session.submitWithOutput('SCOPED_OVERRIDE_ROOT', {
        mode: 'prompted',
        schema: report,
        maxRetries: 1,
      });
      const completed = await turn.wait();
      expect(completed.turn).toBe(turn);
      expect(completed.finalOutput).toEqual({ label: 'successor repaired' });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(originalId).toBe(turn.turnId);
      expect(successorId).toBeDefined();
      expect(successorId).not.toBe(originalId);
      expect(completed.repairAttempts).toHaveLength(1);
      const attempt = completed.repairAttempts[0];
      expect(attempt).toMatchObject({
        parentSessionId: session.id,
        parentTurnId: successorId,
        status: 'completed',
      });
      expect(attempt.parentTurnId).not.toBe(turn.turnId);
      expect(attempt.sessionId).not.toBe(session.id);
      const turns = [];
      for await (const row of session.turns()) turns.push(row);
      expect(turns).toEqual([
        expect.objectContaining({ id: originalId, sessionId: session.id }),
        expect.objectContaining({ id: successorId, sessionId: session.id }),
        attempt,
      ]);
      expect(await turn.wait()).toBe(completed);
      await expect(session.wait()).rejects.toThrow('returned Turn');
      const events = [];
      for await (const event of session.events()) {
        events.push(event);
        if (
          event.type === 'turn_finished' &&
          event.sessionId === session.id &&
          event.turnId === successorId
        )
          break;
      }
      const parentStart = events.find(
        (event) =>
          event.type === 'turn_started' &&
          event.sessionId === session.id &&
          event.turnId === successorId,
      );
      if (parentStart?.type !== 'turn_started')
        throw new Error('Expected the actual successor start observation');
      const repairStart = events.find(
        (event) =>
          event.type === 'turn_started' &&
          event.sessionId === attempt.sessionId,
      );
      expect(repairStart).toMatchObject({
        turnId: attempt.id,
        parentSubmissionId: parentStart.submissionId,
      });
      expect(events.at(-1)).toMatchObject({
        type: 'turn_finished',
        sessionId: session.id,
        turnId: successorId,
        status: 'completed',
      });
      expect(events.slice(0, -1)).toContainEqual(
        expect.objectContaining({
          type: 'turn_finished',
          sessionId: attempt.sessionId,
          turnId: attempt.id,
        }),
      );
      const guidance = rootMessage(server.requests[0], 'SCOPED_OVERRIDE_ROOT');
      expect(guidance).toContain('only for this request');
      expect(guidance).toContain('automatic continuations and tool results');
      expect(rootMessage(server.requests[1], 'SCOPED_OVERRIDE_ROOT')).toBe(
        guidance,
      );
      expect(JSON.stringify(server.requests[1].input)).toContain(
        'ONE_ORIGINAL_EFFECT_RECEIPT',
      );
      expect(rootMessage(server.requests[2], 'SCOPED_OVERRIDE_ROOT')).toBe(
        guidance,
      );
      expect(JSON.stringify(server.requests[3])).not.toContain(
        'SCOPED_OVERRIDE_ROOT',
      );
      expect(JSON.stringify(server.requests[3])).not.toContain(
        'ONE_ORIGINAL_EFFECT_RECEIPT',
      );
      expect(server.requests[3].tools ?? []).toEqual([]);
      const later = await session.submit('LATER_ORDINARY_ROOT');
      const result = await later.wait();
      expect(result.finalOutput).toBe('later ordinary root');
      expect(result.repairAttempts).toEqual([]);
      expect(rootMessage(server.requests[4], 'SCOPED_OVERRIDE_ROOT')).toBe(
        guidance,
      );
      expect(
        rootMessage(server.requests[4], 'LATER_ORDINARY_ROOT'),
      ).not.toContain('Return only JSON');
      expect(JSON.stringify(server.requests[4].input)).not.toContain(
        'successor repaired',
      );
      expect(execute).toHaveBeenCalledTimes(1);
      for (const request of server.requests)
        expect(request).not.toHaveProperty('text.format');
      server.assertExhausted();
    }, 35000);
  },
);
