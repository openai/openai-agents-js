import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { Agent } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { runConcurrentTools } from '../../examples/concurrency-effects/concurrent-tools';
import {
  FakeWriter,
  effectContext,
  runSafeEffects,
  writeRecord,
  type EffectContext,
} from '../../examples/concurrency-effects/safe-effects';

import {
  createFactStore,
  factTools,
  runMemoryLifecycle,
  type FactContext,
} from '../../examples/concurrency-effects/memory-lifecycle';

// A failed witness unwinds its enclosing Session and releases held cleanup.
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error('Witness deadline exceeded')),
          10_000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// Native fixture suites use finite deadlines; no live model requests are made.
const native = describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
native('concurrency and application effects recipes', () => {
  it('shares one quota across two overlapping Sessions', async () => {
    const result = await runConcurrentTools();
    expect(result.remaining).toBe(0);
    expect(result.ledger).toHaveLength(1);
    expect(result.denied).toBe(1);
    expect(result.outputs.toSorted()).toEqual(['full', 'reserved']);
  }, 30000);

  it('deduplicates repeated logical writes', async () => {
    const writer = await runSafeEffects();
    expect([...writer.ledger.get('synthetic-tenant')!]).toEqual([
      'synthetic-request',
    ]);
  }, 30000);

  it.each(['error', 'raise'] as const)(
    'retains the effect after %s and continues',
    async (mode) => {
      const writer = new FakeWriter();
      const context = effectContext(writer, 'alice', 'request');
      await withScriptedResponses(
        [
          [toolCall('write_record', { mode }, { callId: 'write' })],
          ...(mode === 'error' ? [[text('Tool reported an error.')]] : []),
          [text('Continued.')],
        ],
        async (peer) => {
          await using session = await new Agent<EffectContext>({
            instructions: 'Write.',
            tools: [writeRecord],
            provider: peer.provider,
          }).session({ context });
          const turn = await session.submit('Write.');
          if (mode === 'raise') {
            await expect(turn.wait()).rejects.toThrow('Synthetic exception');
            expect(peer.toolOutput('write')).toBeUndefined();
          } else {
            await turn.wait();
            expect(peer.toolOutput('write')).toBe(
              'Synthetic failure after write',
            );
          }
          expect([...writer.ledger.get('alice')!]).toEqual(['request']);
          expect(
            (await (await session.submit('Continue.')).wait()).finalOutput,
          ).toBe('Continued.');
          expect([...writer.ledger.get('alice')!]).toEqual(['request']);
        },
      );
    },
    30000,
  );

  it('cancels only an observer, then joins exact Turn cleanup before continuation', async () => {
    const writer = new FakeWriter();
    const context = effectContext(writer, 'alice', 'request');
    await withScriptedResponses(
      [
        [toolCall('write_record', { mode: 'wait' }, { callId: 'write' })],
        [text('Continued.')],
      ],
      async (peer) => {
        await using session = await new Agent<EffectContext>({
          instructions: 'Write.',
          tools: [writeRecord],
          provider: peer.provider,
        }).session({ context });
        const turn = await session.submit('Write.');
        try {
          await bounded(context.entered.promise);
          const observer = new AbortController();
          const reading = turn.wait({
            until: 'request',
            signal: observer.signal,
          });
          observer.abort(new Error('Reader stopped'));
          await expect(reading).rejects.toThrow('Reader stopped');
          expect(context.cleaned).toBe(false);
          expect(context.cleanupHasStarted).toBe(false);
          let stopped = false;
          const stopping = turn.cancel().then(() => {
            stopped = true;
          });
          await bounded(context.cleanupStarted.promise);
          expect(stopped).toBe(false);
          expect(context.cleaned).toBe(false);
          context.cleanupRelease.resolve();
          await bounded(stopping);
          expect(context.cleaned).toBe(true);
          await expect(turn.wait()).rejects.toThrow('Turn interrupted');
          expect(
            (await (await session.submit('Continue.')).wait()).finalOutput,
          ).toBe('Continued.');
          expect([...writer.ledger.get('alice')!]).toEqual(['request']);
          expect(peer.toolOutput('write')).toMatch(/aborted by user/i);
        } finally {
          context.cleanupRelease.resolve();
        }
      },
    );
  }, 30000);

  it('does not deduplicate one tenant against another', async () => {
    const writer = new FakeWriter();
    await withScriptedResponses(
      [
        [toolCall('write_record', { mode: 'ok' }, { callId: 'alice' })],
        [text('Done.')],
        [toolCall('write_record', { mode: 'ok' }, { callId: 'bob' })],
        [text('Done.')],
      ],
      async (peer) => {
        const agent = new Agent<EffectContext>({
          instructions: 'Write.',
          tools: [writeRecord],
          provider: peer.provider,
        });
        for (const tenant of ['alice', 'bob']) {
          await agent.run('Write.', {
            context: effectContext(writer, tenant, 'same-request'),
          });
        }
        expect([...writer.ledger.get('alice')!]).toEqual(['same-request']);
        expect([...writer.ledger.get('bob')!]).toEqual(['same-request']);
        const request = JSON.stringify(peer.requests[0]);
        expect(request).not.toContain('tenantId');
        expect(request).not.toContain('requestId');
      },
    );
  }, 30000);
});

native('bounded application memory lifecycle', () => {
  it('saves, recalls, replaces and deletes across fresh Sessions', async () => {
    const store = await runMemoryLifecycle();
    expect(await store.read('synthetic-alice')).toBeUndefined();
  }, 30000);

  it('isolates tenants and preserves the other tenant on repeated deletion', async () => {
    const store = createFactStore();
    const fact = 'x'.repeat(240);
    await store.save('bob', 'Private Bob fact');
    await withScriptedResponses(
      [
        [toolCall('save_fact', { fact }, { callId: 'save' })],
        [text('Saved')],
        [toolCall('forget_fact', {}, { callId: 'delete' })],
        [text('Deleted')],
        [toolCall('forget_fact', {}, { callId: 'again' })],
        [text('Deleted')],
      ],
      async (peer) => {
        const agent = new Agent<FactContext>({
          instructions: 'Use fact tools.',
          tools: factTools,
          provider: peer.provider,
        });
        const context = { tenantId: 'alice', store };
        await agent.run('Save my fact.', { context });
        expect(await store.read('alice')).toBe(fact);
        await agent.run('Delete my fact.', { context });
        await agent.run('Delete again.', { context });
        expect(JSON.stringify(peer.requests)).not.toContain('Private Bob fact');
        expect(JSON.stringify(peer.requests[0])).not.toContain('tenantId');
      },
    );
    expect(await store.read('alice')).toBeUndefined();
    expect(await store.read('bob')).toBe('Private Bob fact');
  }, 30000);

  it.each([' ', 'x'.repeat(241)])(
    'rejects invalid facts before storage: %s',
    async (fact) => {
      const store = createFactStore();
      await withScriptedResponses(
        [[toolCall('save_fact', { fact }, { callId: 'invalid' })]],
        async (peer) => {
          const agent = new Agent<FactContext>({
            instructions: 'Save.',
            tools: factTools,
            provider: peer.provider,
          });
          await expect(
            agent.run('Save.', { context: { tenantId: 'alice', store } }),
          ).rejects.toThrow();
          expect(await store.read('alice')).toBeUndefined();
        },
      );
    },
    30000,
  );
});

native('effects after final output failure', () => {
  it('retains a committed effect when final output validation fails', async () => {
    const writer = new FakeWriter();
    const context = effectContext(writer, 'alice', 'request');
    await withScriptedResponses(
      [
        [toolCall('write_record', { mode: 'ok' }, { callId: 'write' })],
        [text('invalid final JSON')],
      ],
      async (peer) => {
        await using session = await new Agent({
          instructions: 'Write, then return JSON.',
          tools: [writeRecord],
          provider: peer.provider,
          outputType: {
            mode: 'prompted',
            schema: z.strictObject({ ok: z.boolean() }),
          },
        }).session({ context });
        const turn = await session.submit('Write.');
        await expect(bounded(turn.wait())).rejects.toThrow();
        expect([...writer.ledger.get('alice')!]).toEqual(['request']);
        expect(peer.toolOutput('write')).toBe('written');
      },
    );
  }, 30000);
});
