import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  NativeProvider,
  manualTool,
  parseSessionState,
  type ActionRequested,
  type Session,
} from '../../src';
import {
  binding,
  type Engine,
  type JsonObject,
  type NativeThread,
} from '../../src/runtime/binding';
import { TurnNotSubmitted } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';

const report = z.object({ label: z.string().min(2) });

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-receipt-failure-key',
    supportsWebsockets: false,
  });
}

/** Keep transport retries on one actual provider rejection, not fixture 500s. */
async function invalidArgPeer(model: ModelServer, onCorrection: () => void) {
  const config = await model.config();
  const upstream = (config['model_providers.fixture'] as { base_url: string })
    .base_url;
  const failures: unknown[] = [];
  const corrections: JsonObject[] = [];
  let forwarded = 0;
  let requests = 0;
  const handlers = new Set<Promise<void>>();
  const server = createServer((request, response) => {
    const handling = (async () => {
      try {
        assert.ok(++requests <= 32, 'Provider fixture request limit exceeded');
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of request) {
          size += chunk.length;
          assert.ok(
            size <= 1024 * 1024,
            'Provider fixture body limit exceeded',
          );
          chunks.push(Buffer.from(chunk));
        }
        const body = Buffer.concat(chunks);
        const input = JSON.parse(body.toString()) as JsonObject;
        if (
          JSON.stringify(input.input).includes('ORIGINAL_PROVIDER_ERROR_ROOT')
        ) {
          assert.equal(++forwarded, 1, 'Original task was replayed');
          const result = await fetch(`${upstream}/responses`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body,
            signal: AbortSignal.timeout(3000),
          });
          response.writeHead(result.status, {
            'content-type': result.headers.get('content-type')!,
          });
          response.end(Buffer.from(await result.arrayBuffer()));
          return;
        }
        assert.ok(JSON.stringify(input.input).includes('invalid_output'));
        corrections.push(input);
        onCorrection();
        response.writeHead(403, {
          'content-type': 'application/json',
          'retry-after': '0',
          'x-request-id': 'synthetic-correction-invalidarg',
        });
        response.end(
          JSON.stringify({
            error: {
              message: 'Synthetic correction provider rejection',
              type: 'invalid_request_error',
              code: 'InvalidArg',
              param: null,
            },
          }),
        );
      } catch (error) {
        failures.push(error);
        response.destroy();
      }
    })();
    handlers.add(handling);
    void handling.finally(() => handlers.delete(handling));
  });
  server.requestTimeout = 3000;
  server.headersTimeout = 3000;
  server.setTimeout(3000, (socket) => socket.destroy());
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert(address && typeof address !== 'string');
  return {
    provider: new NativeProvider({
      baseUrl: `http://127.0.0.1:${address.port}/v1`,
      apiKey: 'synthetic-invalidarg-peer-key',
      supportsWebsockets: false,
    }),
    corrections,
    get forwarded() {
      return forwarded;
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await Promise.all(handlers);
      expect(failures).toEqual([]);
    },
  };
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

/** Preserve real native objects and receivers; replace only the named boundary. */
async function correctionFault(beforeAdmission: boolean) {
  const native = await binding();
  const start = native.Engine.prototype.start_replaceable_thread;
  const submit = native.NativeThread.prototype._submit;
  const history = native.NativeThread.prototype.read_thread_history;
  const missing = new Error('Correction receipt history is unavailable');
  const notSubmitted = new TurnNotSubmitted('injected before native dispatch');
  const threads: NativeThread[] = [];
  const evidence = {
    failHistory: beforeAdmission,
    correctionSubmissions: 0,
    correctionNativeSubmissions: 0,
    correctionAdmissions: [] as { sessionId: string; turnId: string }[],
    correctionHistoryReads: 0,
    correctionHistoryFailures: 0,
  };
  vi.spyOn(
    native.Engine.prototype,
    'start_replaceable_thread',
  ).mockImplementation(async function (
    this: Engine,
    ...args: Parameters<typeof start>
  ) {
    const thread = await Reflect.apply(start, this, args);
    threads.push(thread);
    return thread;
  });
  vi.spyOn(native.NativeThread.prototype, '_submit').mockImplementation(
    function (this: NativeThread, ...args: Parameters<typeof submit>) {
      const correction = threads.indexOf(this) > 0;
      if (correction) {
        evidence.correctionSubmissions++;
        // This injected refusal precedes calling the actual native admission
        // method. It does not claim to reproduce a spontaneous native failure.
        if (beforeAdmission) return Promise.reject(notSubmitted);
        evidence.correctionNativeSubmissions++;
      }
      const pending = Reflect.apply(submit, this, args);
      if (!correction) return pending;
      return pending.then((wire: string) => {
        const accepted = JSON.parse(wire);
        if (accepted.status === 'started')
          evidence.correctionAdmissions.push({
            sessionId: this.id,
            turnId: accepted.turn_id,
          });
        return wire;
      });
    },
  );
  vi.spyOn(
    native.NativeThread.prototype,
    'read_thread_history',
  ).mockImplementation(function (
    this: NativeThread,
    ...args: Parameters<typeof history>
  ) {
    if (threads.indexOf(this) > 0) {
      evidence.correctionHistoryReads++;
      if (evidence.failHistory) {
        evidence.correctionHistoryFailures++;
        return Promise.reject(missing);
      }
    }
    return Reflect.apply(history, this, args);
  });
  return { evidence, missing, notSubmitted };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native prompted repair receipt failure',
  () => {
    it.each([
      { history: 'available', failHistory: false },
      { history: 'unavailable', failHistory: true },
    ])(
      'preserves admitted provider InvalidArg accounting when history is $history',
      async ({ failHistory }) => {
        const fault = await correctionFault(false);
        const server = new ModelServer([[message('{"label":"x"}')]]);
        const peer = await invalidArgPeer(server, () => {
          fault.evidence.failHistory = failHistory;
        });
        try {
          await using provider = peer.provider;
          await using session = await new Agent({
            instructions: 'Answer.',
            model: 'gpt-5',
            provider,
            outputType: { mode: 'prompted', schema: report, maxRetries: 3 },
          }).session();
          const root = await session.submit('ORIGINAL_PROVIDER_ERROR_ROOT');
          const failure = await root.wait().catch((error: unknown) => error);
          // The actual HTTP provider body supplies the code. Native admission is
          // independently proved by the unmodified native submission receipt.
          expect(failure).toBeInstanceOf(NativeError);
          expect(failure).toMatchObject({
            code: 'InvalidArg',
            statusCode: 403,
          });
          expect(fault.evidence.correctionAdmissions).toHaveLength(1);
          const admission = fault.evidence.correctionAdmissions[0];
          expect(admission.turnId).toBeTruthy();
          expect(admission.turnId).not.toBe(root.turnId);
          expect(admission.sessionId).not.toBe(session.id);
          expect(fault.evidence.correctionSubmissions).toBe(1);
          expect(fault.evidence.correctionNativeSubmissions).toBe(1);
          expect(peer.forwarded).toBe(1);
          expect(server.requests).toHaveLength(1);
          expect(server.completedFrames).toHaveLength(1);
          expect(peer.corrections.length).toBeGreaterThan(0);
          for (const request of peer.corrections)
            expect(request.tools ?? []).toEqual([]);
          await expect(root.wait()).rejects.toBe(failure);

          if (failHistory) {
            for (let observation = 0; observation < 2; observation++) {
              expect(await collect(session.turns())).toEqual([
                expect.objectContaining({
                  id: root.turnId,
                  sessionId: session.id,
                }),
              ]);
              await expect(session.saveState()).rejects.toThrow(
                /receipts.*incomplete/i,
              );
              await expect(session.fork()).rejects.toThrow(
                /receipts.*incomplete/i,
              );
              await expect(root.wait()).rejects.toBe(failure);
            }
            expect(fault.evidence.correctionHistoryFailures).toBe(1);
          } else {
            const turns = await collect(session.turns());
            const attempts = turns.filter(
              (turn) =>
                'parentTurnId' in turn && turn.parentTurnId === root.turnId,
            );
            expect(attempts).toHaveLength(1);
            const attempt = attempts[0];
            expect(attempt).toMatchObject({
              id: admission.turnId,
              sessionId: admission.sessionId,
              parentSessionId: session.id,
              parentTurnId: root.turnId,
              subagentId: null,
              status: 'failed',
            });
            const saved = parseSessionState(
              JSON.stringify(await session.saveState()),
            );
            if (saved.kind !== 'idle')
              throw new Error('Expected output-aware idle state');
            expect(saved.repair_turns).toEqual([attempt]);
            const fork = parseSessionState(
              JSON.stringify(await session.fork()),
            );
            if (fork.kind !== 'idle')
              throw new Error('Expected output-aware fork');
            expect(fork.repair_turns).toEqual([
              {
                ...attempt,
                parentSessionId: fork.native.source_session_id,
              },
            ]);
            expect(fault.evidence.correctionHistoryFailures).toBe(0);
          }
          expect(fault.evidence.correctionHistoryReads).toBe(1);
          expect(fault.evidence.correctionAdmissions).toEqual([admission]);
          expect(fault.evidence.correctionNativeSubmissions).toBe(1);
          expect(peer.corrections.length).toBeLessThanOrEqual(32);
          expect(peer.forwarded).toBe(1);
          expect(server.requests).toHaveLength(1);
          server.assertExhausted();
        } finally {
          await peer.close();
        }
      },
      25000,
    );

    it('keeps capture unavailable after an admitted correction loses its history while the original Session remains usable', async () => {
      const fault = await correctionFault(false);
      const server = new ModelServer([
        [message('{"label":"x"}')],
        [message('{"label":"ACTUAL_CORRECTION_RESULT"}')],
        [call('decision', {}, { callId: 'later-live-decision' })],
        [message('{"label":"later accepted"}')],
      ]);
      server.onRecord = (phase, detail) => {
        if (
          phase === 'MODEL_COMPLETED_FRAME' &&
          (detail as { requestIndex: number }).requestIndex === 1
        )
          fault.evidence.failHistory = true;
      };
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Answer or ask for a decision.',
        model: 'gpt-5',
        provider,
        tools: [
          manualTool({
            name: 'decision',
            description: 'Ask for a decision.',
            parameters: z.object({}),
            result: z.string(),
          }),
        ],
        outputType: { mode: 'prompted', schema: report, maxRetries: 1 },
      }).session();
      const root = await session.submit('ORIGINAL_INVALID_ROOT');
      await expect(root.wait()).rejects.toBe(fault.missing);
      expect(fault.evidence).toMatchObject({
        failHistory: true,
        correctionSubmissions: 1,
        correctionNativeSubmissions: 1,
        correctionHistoryFailures: 1,
      });
      expect(server.requests).toHaveLength(2);
      expect(server.completedFrames).toHaveLength(2);
      expect(JSON.stringify(server.requests[1].input)).toContain(
        'invalid_output',
      );
      expect(JSON.stringify(server.requests[1].input)).not.toContain(
        'ORIGINAL_INVALID_ROOT',
      );

      for (let observation = 0; observation < 2; observation++) {
        await expect(root.wait()).rejects.toBe(fault.missing);
        const turns = await collect(session.turns());
        expect(turns).toHaveLength(1);
        expect(turns[0]).toMatchObject({
          id: root.turnId,
          sessionId: session.id,
        });
        const items = await collect(session.items());
        expect(JSON.stringify(items)).not.toContain('ACTUAL_CORRECTION_RESULT');
        await expect(session.saveState()).rejects.toThrow(
          /receipts.*incomplete/i,
        );
        await expect(session.fork()).rejects.toThrow(/receipts.*incomplete/i);
        await expect(
          session.compact({ summary: 'Must not hide the missing receipt.' }),
        ).rejects.toThrow(/receipts.*incomplete/i);
        expect(server.requests).toHaveLength(2);
      }

      // The root's reader remains healthy. A later manual wait cannot turn an
      // incomplete possibly-admitted receipt into a portable checkpoint.
      const later = await session.submit('LATER_MANUAL_ROOT');
      const action = await nextAction(session);
      expect(server.requests).toHaveLength(3);
      await expect(session.suspend()).rejects.toThrow(/receipts.*incomplete/i);
      expect(server.requests).toHaveLength(3);
      await session.respond(action.reply('LIVE_REPLY'));
      const completed = await later.wait();
      expect(completed.finalOutput).toEqual({ label: 'later accepted' });
      expect(completed.repairAttempts).toEqual([]);
      expect(await later.wait()).toBe(completed);
      await expect(session.saveState()).rejects.toThrow(
        /receipts.*incomplete/i,
      );
      await expect(session.fork()).rejects.toThrow(/receipts.*incomplete/i);
      expect(fault.evidence.correctionNativeSubmissions).toBe(1);
      expect(fault.evidence.correctionHistoryFailures).toBe(1);
      expect(server.requests).toHaveLength(4);
      server.assertExhausted();
    }, 25000);

    it('keeps capture available when an injected refusal provably precedes native correction admission', async () => {
      const fault = await correctionFault(true);
      const server = new ModelServer([
        [message('{"label":"x"}')],
        [message('later ordinary result')],
      ]);
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        outputType: { mode: 'prompted', schema: report, maxRetries: 1 },
      }).session();
      const root = await session.submit('ORIGINAL_PREADMISSION_ROOT');
      await expect(root.wait()).rejects.toBe(fault.notSubmitted);
      await expect(root.wait()).rejects.toBe(fault.notSubmitted);
      expect(fault.evidence).toMatchObject({
        correctionSubmissions: 1,
        correctionNativeSubmissions: 0,
        correctionHistoryFailures: 0,
      });
      expect(server.requests).toHaveLength(1);
      expect(server.completedFrames).toHaveLength(1);
      expect(await collect(session.turns())).toEqual([
        expect.objectContaining({ id: root.turnId, sessionId: session.id }),
      ]);
      const saved = await session.saveState();
      if (saved.kind !== 'idle')
        throw new Error('Expected output-aware idle state');
      expect(saved.native.source_session_id).toBe(session.id);
      expect(saved.repair_turns).toEqual([]);
      expect(saved.repair_items).toEqual([]);
      const fork = await session.fork();
      if (fork.kind !== 'idle') throw new Error('Expected output-aware fork');
      expect(fork.repair_turns).toEqual([]);
      expect(fork.repair_items).toEqual([]);
      await session.compact({ summary: 'The original output was invalid.' });
      expect(server.requests).toHaveLength(1);
      const later = await session.submitWithOutput(
        'LATER_PLAIN_ROOT',
        z.string(),
      );
      const completed = await later.wait();
      expect(completed.finalOutput).toBe('later ordinary result');
      expect(completed.repairAttempts).toEqual([]);
      expect(fault.evidence.correctionNativeSubmissions).toBe(0);
      expect(fault.evidence.correctionHistoryFailures).toBe(0);
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }, 25000);
  },
);
