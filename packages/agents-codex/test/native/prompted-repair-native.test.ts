import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  OutputValidationError,
  parseSessionState,
  tool,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';

const report = z.object({ label: z.string().min(2) });

async function providerFor(
  server: ModelServer,
  apiKey = 'synthetic-repair-key',
) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey,
    supportsWebsockets: false,
  });
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

function correctionPayload(request: JsonObject) {
  const input = request.input as Array<{
    role?: string;
    content?: Array<{ text?: string }>;
  }>;
  const text = input
    .filter((item) => item.role === 'user')
    .flatMap((item) => item.content ?? [])
    .map((content) => content.text)
    .find(
      (value) =>
        value?.trim().startsWith('{') && value.includes('invalid_output'),
    );
  expect(text).toBeDefined();
  return JSON.parse(text!);
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'bounded native prompted-output repair',
  () => {
    it.each([
      { name: 'omitted budget', maxRetries: undefined, label: 'valid' },
      { name: 'zero budget', maxRetries: 0, label: 'x' },
      { name: 'valid positive budget', maxRetries: 2, label: 'valid' },
    ])(
      'makes no correction for $name',
      async ({ maxRetries, label }) => {
        const raw = JSON.stringify({ label });
        const server = new ModelServer([[message(raw)]]);
        await using provider = await providerFor(server);
        await using session = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
          outputType: {
            mode: 'prompted',
            schema: report,
            ...(maxRetries === undefined ? {} : { maxRetries }),
          },
        }).session();
        const turn = await session.submit('one root');
        if (label === 'x') {
          const error = await turn.wait().catch((failure: unknown) => failure);
          expect(error).toBeInstanceOf(OutputValidationError);
          expect(error).toHaveProperty('rawOutput', raw);
          await expect(turn.wait()).rejects.toBe(error);
        } else {
          const result = await turn.wait();
          expect(result.finalOutput).toEqual({ label });
          expect(result.repairAttempts).toEqual([]);
          expect(await turn.wait()).toBe(result);
        }
        expect(await collect(session.turns())).toHaveLength(1);
        server.assertExhausted();
      },
      25000,
    );

    it('returns corrected output with a real separate attempt and separate usage', async () => {
      const originalUsage =
        '{"input_tokens":5,"output_tokens":2,"total_tokens":7}';
      const correctionUsage =
        '{"input_tokens":8,"output_tokens":3,"total_tokens":11}';
      const server = new ModelServer(
        [[message('{"label":"x"}')], [message('{"label":"corrected"}')]],
        [originalUsage, correctionUsage],
      );
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Answer.',
        model: 'gpt-5',
        provider,
        outputType: { mode: 'prompted', schema: report, maxRetries: 1 },
      }).session();
      const turn = await session.submit('original root');
      const result = await turn.wait();
      expect(result.turn).toBe(turn);
      expect(result.finalOutput).toEqual({ label: 'corrected' });
      expect(await turn.wait()).toBe(result);
      expect(result.threadUsage?.totalTokenUsage.totalTokens).toBe(7);
      expect(result.repairAttempts).toHaveLength(1);
      const attempt = result.repairAttempts[0];
      expect(attempt).toMatchObject({
        parentSessionId: session.id,
        parentTurnId: turn.turnId,
        subagentId: null,
        status: 'completed',
        usage: { inputTokens: 8, outputTokens: 3, totalTokens: 11 },
      });
      expect(attempt.sessionId).not.toBe(session.id);
      expect(attempt.id).not.toBe(turn.turnId);
      expect(await collect(session.turns())).toEqual([
        expect.objectContaining({ id: turn.turnId, sessionId: session.id }),
        attempt,
      ]);
      const items = await collect(session.items());
      expect(items.some((item) => item.turnId === attempt.id)).toBe(true);
      const exposed = await collect(session.turns());
      exposed[1].id = 'caller mutation';
      expect((await collect(session.turns()))[1]).toEqual(attempt);
      server.assertExhausted();
    }, 25000);

    it.each([0, 1, 2])(
      'limits exhaustion to %i extra attempts and never replays on wait',
      async (maxRetries) => {
        const invalid = ['{"label":"x"}', '{"label":"y"}', '{"label":"z"}'];
        const server = new ModelServer(
          invalid.slice(0, maxRetries + 1).map((raw) => [message(raw)]),
        );
        await using provider = await providerFor(server);
        await using session = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
          outputType: { mode: 'prompted', schema: report, maxRetries },
        }).session();
        const turn = await session.submit('original root');
        const error = await turn.wait().catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(OutputValidationError);
        expect(error).toHaveProperty('rawOutput', invalid[maxRetries]);
        await expect(turn.wait()).rejects.toBe(error);
        await expect(turn.wait()).rejects.toBe(error);
        const turns = await collect(session.turns());
        const attempts = turns.filter(
          (row) => 'parentTurnId' in row && row.parentTurnId === turn.turnId,
        );
        expect(attempts).toHaveLength(maxRetries);
        expect(turns).toHaveLength(maxRetries + 1);
        expect(
          new Set(turns.map((row) => `${row.sessionId}:${row.id}`)).size,
        ).toBe(maxRetries + 1);
        expect(server.requests).toHaveLength(maxRetries + 1);
        server.assertExhausted();
      },
      25000,
    );

    it('uses captured routing and auth with accepted updated settings', async () => {
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-captured-key');
      const server = new ModelServer([
        [message('{"label":"x"}')],
        [message('{"label":"corrected"}')],
      ]);
      const changed = new ModelServer([]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        supportsWebsockets: false,
      });
      await using changedProvider = await providerFor(
        changed,
        'synthetic-changed-key',
      );
      const agent = new Agent({
        instructions: 'ORIGINAL_PRIVATE_INSTRUCTIONS',
        model: 'gpt-5',
        modelSettings: { reasoningEffort: 'medium' },
        provider,
        outputType: { mode: 'prompted', schema: report, maxRetries: 1 },
      });
      await using session = await agent.session();
      vi.stubEnv('OPENAI_API_KEY', 'synthetic-later-key');
      agent.provider = changedProvider;
      agent.model = 'unwanted-agent-default';
      agent.modelSettings = { reasoningEffort: 'high' };
      agent.instructions = 'MUTATED_PRIVATE_INSTRUCTIONS';
      await session.update({
        model: 'gpt-5.1-codex',
        modelSettings: { reasoningEffort: 'low', serviceTier: null },
      });
      const result = await (await session.submit('PRIVATE_TASK')).wait();
      expect(result.finalOutput).toEqual({ label: 'corrected' });
      expect(result.repairAttempts).toHaveLength(1);
      for (const [index, request] of server.requests.entries()) {
        expect(request.model).toBe('gpt-5.1-codex');
        expect(request.reasoning).toMatchObject({ effort: 'low' });
        expect(request.service_tier ?? null).toBeNull();
        expect(server.requestHeaders[index].authorization).toBe(
          'Bearer synthetic-captured-key',
        );
      }
      for (const privateText of [
        'PRIVATE_TASK',
        'ORIGINAL_PRIVATE_INSTRUCTIONS',
        'MUTATED_PRIVATE_INSTRUCTIONS',
      ])
        expect(JSON.stringify(server.requests[1])).not.toContain(privateText);
      expect(changed.requests).toEqual([]);
      server.assertExhausted();
      changed.assertExhausted();
    }, 25000);

    it.each(['save', 'fork'] as const)(
      'keeps one original effect and isolated latest-text repair receipts through %s and JSON restore',
      async (boundary) => {
        const effects: string[] = [];
        const server = new ModelServer([
          [call('record', {}, { callId: 'PRIVATE_EFFECT_CALL' })],
          [message('{"label":"x"}')],
          [message('{"label":"y"}')],
          [message('{"label":"corrected"}')],
          [message('later plain root')],
        ]);
        await using provider = await providerFor(server);
        const agent = new Agent({
          instructions: 'PRIVATE_ORIGINAL_INSTRUCTIONS',
          model: 'gpt-5',
          provider,
          tools: [
            tool({
              name: 'record',
              parameters: z.object({}),
              execute() {
                effects.push('once');
                return 'PRIVATE_EFFECT_RECEIPT';
              },
            }),
          ],
          outputType: { mode: 'prompted', schema: report, maxRetries: 2 },
        });
        await using source = await agent.session();
        const root = await source.submit('PRIVATE_ORIGINAL_TASK');
        const result = await root.wait();
        expect(result.finalOutput).toEqual({ label: 'corrected' });
        expect(result.repairAttempts).toHaveLength(2);
        for (const attempt of result.repairAttempts) {
          expect(attempt.receipt).toMatchObject({
            threadId: attempt.sessionId,
            turnId: attempt.id,
            model: 'gpt-5',
            developerInstructionsSha256:
              expect.stringMatching(/^[0-9a-f]{64}$/),
            instructionFiles: [],
            executors: [],
          });
        }
        expect(
          (await collect(source.turns())).filter(
            (turn) =>
              'parentTurnId' in turn && turn.parentTurnId === root.turnId,
          ),
        ).toEqual(result.repairAttempts);
        expect(effects).toEqual(['once']);
        expect(await root.wait()).toBe(result);
        expect(server.requests).toHaveLength(4);
        expect(JSON.stringify(server.requests[0].tools)).toContain('record');
        expect(JSON.stringify(server.requests[1].input)).toContain(
          'PRIVATE_EFFECT_RECEIPT',
        );
        for (const [index, request] of server.requests.slice(2).entries()) {
          expect(request.tools ?? []).toEqual([]);
          expect(request).not.toHaveProperty('text.format');
          expect(correctionPayload(request)).toEqual({
            schema: expect.objectContaining({
              type: 'object',
              properties: {
                label: expect.objectContaining({
                  type: 'string',
                  minLength: 2,
                }),
              },
            }),
            invalid_output: index === 0 ? '{"label":"x"}' : '{"label":"y"}',
          });
          for (const privateText of [
            'PRIVATE_ORIGINAL_TASK',
            'PRIVATE_ORIGINAL_INSTRUCTIONS',
            'PRIVATE_EFFECT_CALL',
            'PRIVATE_EFFECT_RECEIPT',
          ])
            expect(JSON.stringify(request)).not.toContain(privateText);
        }
        const items = await collect(source.items());
        const attemptIds = new Set(
          result.repairAttempts.map((attempt) => attempt.id),
        );
        const repairItems = items.filter((item) => attemptIds.has(item.turnId));
        expect(repairItems.length).toBeGreaterThan(0);
        const state = parseSessionState(
          JSON.stringify(
            boundary === 'save'
              ? await source.saveState()
              : await source.fork(),
          ),
        );
        expect(server.requests).toHaveLength(4);
        expect(effects).toEqual(['once']);
        expect(JSON.stringify(state)).not.toContain('synthetic-repair-key');
        await source.close();
        await using restored = await agent.session({ state });
        const restoredAttempts = (await collect(restored.turns())).filter(
          (attempt) =>
            'parentTurnId' in attempt && attempt.parentTurnId === root.turnId,
        );
        expect(restoredAttempts).toEqual(
          result.repairAttempts.map((attempt) => ({
            ...attempt,
            parentSessionId: restored.id,
          })),
        );
        expect(
          (await collect(restored.items())).filter((item) =>
            attemptIds.has(item.turnId),
          ),
        ).toEqual(repairItems);
        const again = await restored.saveState();
        if (again.format_version !== 4)
          throw new Error('Expected output-aware idle state');
        expect(again.repair_turns).toHaveLength(2);
        expect(server.requests).toHaveLength(4);
        expect(effects).toEqual(['once']);
        const later = await restored.submit('LATER_PLAIN_ROOT', {
          outputType: z.string(),
        });
        const plain = await later.wait();
        expect(plain.finalOutput).toBe('later plain root');
        expect(plain.repairAttempts).toEqual([]);
        expect(JSON.stringify(server.requests[4].input)).not.toContain(
          'corrected',
        );
        expect(effects).toEqual(['once']);
        server.assertExhausted();
      },
      25000,
    );
  },
);
