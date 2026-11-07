import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  InteractionRequired,
  NativeProvider,
  localStorage,
  manualTool,
  parseSessionState,
  type ActionRequested,
  type Session,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const report = z.object({ label: z.string().min(2) });

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-repair-contract-key',
    supportsWebsockets: false,
  });
}

async function nextAction(session: Session<unknown>): Promise<ActionRequested> {
  for await (const event of session.events())
    if (event.type === 'action_requested') return event;
  throw new Error('Expected pending manual action');
}

async function collect<T>(values: AsyncIterable<T>): Promise<T[]> {
  const result: T[] = [];
  for await (const value of values) result.push(value);
  return result;
}

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await ModelServer.closeAll();
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'native prompted-repair contract boundaries',
  () => {
    it('restores a pending manual root only with its captured budget and fresh reply authority', async () => {
      const server = new ModelServer([
        [call('lookup', { key: 'A' }, { callId: 'manual-A' })],
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'CURRENT_OWNER_REPLY',
          );
          return [message('{"label":"x"}')];
        },
        (request) => {
          expect(JSON.stringify(request.input)).not.toContain(
            'CURRENT_OWNER_REPLY',
          );
          expect(request.tools ?? []).toEqual([]);
          return [message('{"label":"fixed"}')];
        },
      ]);
      await using provider = await providerFor(server);
      const lookup = () =>
        manualTool({
          name: 'lookup',
          description: 'Read a record',
          parameters: z.object({ key: z.string() }),
          result: z.string(),
        });
      const declaration = { instructions: 'Read.', model: 'gpt-5', provider };
      const outputType = {
        mode: 'prompted' as const,
        schema: report,
        maxRetries: 2,
      };
      const agent = new Agent({
        ...declaration,
        tools: [lookup()],
        outputType,
      });
      await using original = await agent.session();
      const root = await original.submit('Read A once');
      const oldAction = await nextAction(original);
      const staleReply = oldAction.reply('STALE_REPLY');
      const originalResult = root.wait().catch((error: unknown) => error);
      const state = parseSessionState(JSON.stringify(await original.suspend()));
      expect(await originalResult).toBeInstanceOf(InteractionRequired);
      expect(state.format_version).toBe(5);
      if (state.format_version !== 5)
        throw new Error('Expected output-aware manual state');
      expect(state.manual_continuation.turn_id).toBe(root.turnId);
      expect(state.output_context.budget).toBe(2);
      await original.close();
      const acquire = vi.spyOn(provider, '_acquire');
      await expect(
        new Agent({
          ...declaration,
          tools: [lookup()],
          outputType: { ...outputType, maxRetries: 1 },
        }).session({ state }),
      ).rejects.toThrow('matching current output contract');
      expect(acquire).not.toHaveBeenCalled();
      expect(server.requests).toHaveLength(1);
      await using restored = await new Agent({
        ...declaration,
        tools: [lookup()],
        outputType,
      }).session({ state });
      const fresh = await nextAction(restored);
      await expect(restored.respond(staleReply)).rejects.toThrow();
      expect(server.requests).toHaveLength(1);
      const resumed = restored.restoredTurn!;
      await restored.respond(fresh.reply('CURRENT_OWNER_REPLY'));
      expect(resumed.turnId).toBe(root.turnId);
      const completed = await resumed.wait();
      expect(completed.finalOutput).toEqual({ label: 'fixed' });
      expect(completed.repairAttempts).toHaveLength(1);
      expect(completed.repairAttempts[0]).toMatchObject({
        parentSessionId: restored.id,
        parentTurnId: root.turnId,
        status: 'completed',
      });
      expect(completed.repairAttempts[0].sessionId).not.toBe(restored.id);
      expect(await resumed.wait()).toBe(completed);
      server.assertExhausted();
    }, 35000);

    it.each(['items', 'turns'] as const)(
      'keeps an in-progress %s iterator attached to its original history snapshot',
      async (iterator) => {
        const server = new ModelServer([
          [message('{"label":"x"}')],
          [message('{"label":"first repaired"}')],
          [message('{"label":"y"}')],
          [message('{"label":"second repaired"}')],
        ]);
        await using provider = await providerFor(server);
        await using session = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
          outputType: { mode: 'prompted', schema: report, maxRetries: 1 },
        }).session();
        async function* records() {
          if (iterator === 'items') {
            for await (const row of session.items())
              yield { turnId: row.turnId, row };
          } else {
            for await (const row of session.turns())
              yield { turnId: row.id, row };
          }
        }
        const first = await session.submit('first root');
        const firstResult = await first.wait();
        expect(firstResult.repairAttempts).toHaveLength(1);
        const firstAttempt = firstResult.repairAttempts[0];
        const old = records();
        const leading = await old.next();
        if (leading.done) throw new Error('Expected the first original record');
        const second = await session.submit('second root');
        const secondResult = await second.wait();
        expect(secondResult.repairAttempts).toHaveLength(1);
        const secondAttempt = secondResult.repairAttempts[0];
        expect(secondAttempt.id).not.toBe(firstAttempt.id);
        const oldSnapshot = [leading.value, ...(await collect(old))];
        const freshSnapshot = await collect(records());
        const groups = (snapshot: typeof oldSnapshot) =>
          snapshot
            .map((entry) => entry.turnId)
            .filter((id, index, ids) => index === 0 || ids[index - 1] !== id);
        expect(groups(oldSnapshot)).toEqual([first.turnId, firstAttempt.id]);
        expect(groups(freshSnapshot)).toEqual([
          first.turnId,
          firstAttempt.id,
          second.turnId,
          secondAttempt.id,
        ]);
        expect(firstAttempt.parentTurnId).toBe(first.turnId);
        expect(secondAttempt.parentTurnId).toBe(second.turnId);
        for (const entry of freshSnapshot) entry.row.id = 'caller mutation';
        expect(
          (await collect(records())).some(
            (entry) => entry.row.id === 'caller mutation',
          ),
        ).toBe(false);
        expect(await first.wait()).toBe(firstResult);
        expect(await second.wait()).toBe(secondResult);
        server.assertExhausted();
      },
      35000,
    );

    it('rejects a positive LocalStorage default before opening and positive operation budgets before model work', async () => {
      const directory = await mkdtemp(join(tmpdir(), 'repair-local-storage-'));
      try {
        const server = new ModelServer([
          [message('{"label":"explicit zero"}')],
          [message('{"label":"omitted zero"}')],
        ]);
        await using provider = await providerFor(server);
        const storage = localStorage(join(directory, 'profile'));
        const acquire = vi.spyOn(provider, '_acquire');
        await expect(
          new Agent({
            instructions: 'Answer.',
            model: 'gpt-5',
            provider,
            outputType: { mode: 'prompted', schema: report, maxRetries: 1 },
          }).session({ storage }),
        ).rejects.toThrow('Local storage');
        expect(acquire).not.toHaveBeenCalled();
        expect(server.requests).toHaveLength(0);
        await using session = await new Agent({
          instructions: 'Answer.',
          model: 'gpt-5',
          provider,
          outputType: { mode: 'prompted', schema: report, maxRetries: 0 },
        }).session({ storage });
        const support = session.capabilities.get('promptedOutput');
        expect(support.status).toBe('limited');
        expect(() => session.capabilities.require('promptedOutput')).toThrow();
        session.capabilities.require('promptedOutput', { allowLimited: true });
        const positive = {
          mode: 'prompted' as const,
          schema: report,
          maxRetries: 2,
        };
        await expect(
          session.submit('positive override', { outputType: positive }),
        ).rejects.toThrow('Local storage');
        await expect(
          session.enqueue('positive queued override', { outputType: positive }),
        ).rejects.toThrow('Local storage');
        expect(server.requests).toHaveLength(0);
        const zero = await session.submit('explicit zero', {
          outputType: {
            mode: 'prompted',
            schema: report,
            maxRetries: 0,
          },
        });
        const zeroResult = await zero.wait();
        expect(zeroResult.finalOutput).toEqual({ label: 'explicit zero' });
        expect(zeroResult.repairAttempts).toEqual([]);
        const omitted = await session.enqueue('omitted zero', {
          outputType: {
            mode: 'prompted',
            schema: report,
          },
        });
        const omittedResult = await omitted.wait();
        expect(omittedResult.finalOutput).toEqual({ label: 'omitted zero' });
        expect(omittedResult.repairAttempts).toEqual([]);
        expect(await collect(session.turns())).toHaveLength(2);
        server.assertExhausted();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }, 35000);
  },
);

// NativeProvider's native route requires auth; test captured absence before opening resources.
it('keeps captured API-key absence while an uncaptured lease reads later ambient credentials', async () => {
  vi.stubEnv('OPENAI_API_KEY', undefined);
  await using provider = new NativeProvider();
  const original = provider._acquire();
  const leases = [original];
  try {
    expect(original.apiKey).toBeUndefined();
    vi.stubEnv('OPENAI_API_KEY', 'synthetic-key-that-must-not-be-used');
    const correction = provider._acquire({ apiKey: original.apiKey });
    leases.push(correction);
    const uncaptured = provider._acquire();
    leases.push(uncaptured);
    expect(correction.apiKey).toBeUndefined();
    expect(uncaptured.apiKey).toBe('synthetic-key-that-must-not-be-used');
  } finally {
    await Promise.all(leases.map((lease) => lease.release()));
  }
});
