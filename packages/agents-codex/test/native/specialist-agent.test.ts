import { afterEach, describe, expect, it, vi } from 'vitest';
import { Agent, tool, type Session, type ToolContext } from '@openai/agents';
import { text, toolCall, withScriptedResponses } from '@openai/agents/testing';
import { z } from 'zod';
import {
  consult,
  consultSpecialist,
  readCatalog,
  runSpecialistExample,
  summarySchema,
  type Catalog,
  type Summary,
} from '../../../../examples/codex/specialist-agent';

afterEach(() => vi.restoreAllMocks());

// Control delivery at the public example boundary; these tests do not run Core.
function ownedSpecialist() {
  const specialist = new Agent<Catalog, Summary>({
    instructions: 'Summarize.',
    outputType: summarySchema,
  });
  const opening = Promise.withResolvers<Session<Summary, Catalog>>();
  const admitted = Promise.withResolvers<void>();
  const answer = Promise.withResolvers<{ finalOutput: Summary }>();
  const cleanup = Promise.withResolvers<void>();
  const closing = Promise.withResolvers<void>();
  const session = {
    submit: vi.fn(async () => {
      admitted.resolve();
      return { wait: () => answer.promise };
    }),
    close: vi.fn(() => {
      closing.resolve();
      return cleanup.promise;
    }),
  };
  const open = vi.spyOn(specialist, 'session').mockReturnValue(opening.promise);
  return {
    specialist,
    opening,
    admitted,
    answer,
    cleanup,
    closing,
    session,
    open,
    context: { specialist, catalog: Object.freeze({ title: 'Selected' }) },
    resolveOpening() {
      opening.resolve(session as unknown as Session<Summary, Catalog>);
    },
  };
}

describe('independent specialist example lifecycle without native execution', () => {
  it('does not open for an already aborted outer callback', async () => {
    const owned = ownedSpecialist();
    const abort = new AbortController();
    const failure = new Error('Stopped before opening');
    abort.abort(failure);
    await expect(consultSpecialist(owned.context, abort.signal)).rejects.toBe(
      failure,
    );
    expect(owned.open).not.toHaveBeenCalled();
  });

  it('awaits opening, skips submission after abort, and joins cleanup', async () => {
    const owned = ownedSpecialist();
    const abort = new AbortController();
    const failure = new Error('Stopped during opening');
    let settled = false;
    const outcome = consultSpecialist(owned.context, abort.signal).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    abort.abort(failure);
    expect(settled).toBe(false);
    owned.resolveOpening();
    await owned.closing.promise;
    expect(owned.session.submit).not.toHaveBeenCalled();
    expect(settled).toBe(false);
    owned.cleanup.resolve();
    expect(await outcome).toBe(failure);
    expect(owned.session.close).toHaveBeenCalledTimes(1);
    expect(owned.open).toHaveBeenCalledWith({ context: owned.context.catalog });
  });

  it('closes pending admission and preserves admission and cleanup failures', async () => {
    const owned = ownedSpecialist();
    const admission = Promise.withResolvers<never>();
    owned.session.submit.mockImplementationOnce(() => admission.promise);
    const abort = new AbortController();
    const taskFailure = new Error('Admission cancelled');
    const closeFailure = new Error('Cleanup failed');
    const outcome = consultSpecialist(owned.context, abort.signal).catch(
      (error: unknown) => error,
    );
    owned.resolveOpening();
    await vi.waitFor(() => expect(owned.session.submit).toHaveBeenCalledOnce());
    abort.abort();
    await owned.closing.promise;
    // Reject close before admission settles: the listener must observe rejection.
    owned.cleanup.reject(closeFailure);
    await new Promise<void>((resolve) => setImmediate(resolve));
    admission.reject(taskFailure);
    const failure = await outcome;
    expect(failure).toMatchObject({
      name: 'SuppressedError',
      error: closeFailure,
      suppressed: taskFailure,
    });
    expect(owned.session.close).toHaveBeenCalledTimes(1);
  });

  it('rejects a late result after abort and waits for the same cleanup', async () => {
    const owned = ownedSpecialist();
    const abort = new AbortController();
    const failure = new Error('Stopped during work');
    let settled = false;
    const outcome = consultSpecialist(owned.context, abort.signal).catch(
      (error: unknown) => {
        settled = true;
        return error;
      },
    );
    owned.resolveOpening();
    await owned.admitted.promise;
    abort.abort(failure);
    await owned.closing.promise;
    owned.answer.resolve({ finalOutput: { title: 'Late title' } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(settled).toBe(false);
    owned.cleanup.resolve();
    expect(await outcome).toBe(failure);
    expect(owned.session.close).toHaveBeenCalledTimes(1);
  });

  it('returns a result only after joined disposal and removes its listener', async () => {
    const owned = ownedSpecialist();
    const abort = new AbortController();
    const remove = vi.spyOn(abort.signal, 'removeEventListener');
    const outcome = consultSpecialist(owned.context, abort.signal);
    owned.resolveOpening();
    await owned.admitted.promise;
    owned.answer.resolve({ finalOutput: { title: 'Selected' } });
    await owned.closing.promise;
    expect(remove).toHaveBeenCalledWith('abort', expect.any(Function));
    owned.cleanup.resolve();
    expect(await outcome).toEqual({ title: 'Selected' });
    abort.abort();
    expect(owned.session.close).toHaveBeenCalledTimes(1);
  });
});

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'independent specialist example with the native runtime',
  () => {
    it('runs its no-key command scenario with both actual tool receipts', async () => {
      expect(await runSpecialistExample()).toEqual({
        answer: 'Violet catalog.',
        summary: { title: 'Violet catalog' },
      });
    }, 25000);

    it('selects specialist context and tools before returning a validated receipt', async () => {
      await withScriptedResponses(
        [
          [toolCall('consult', {}, { callId: 'consult' })],
          [text('Outer answer')],
        ],
        async (outerPeer) =>
          withScriptedResponses(
            [
              [toolCall('read_catalog', {}, { callId: 'catalog' })],
              [text('{"title":"Selected"}')],
            ],
            async (innerPeer) => {
              const outerOnly = tool({
                name: 'outer_private',
                description: 'Read private application data.',
                parameters: z.strictObject({}),
                execute: () => 'synthetic-private-tool-secret',
              });
              const specialist = new Agent<Catalog, Summary>({
                instructions: 'Read the catalog.',
                model: 'gpt-5.5',
                provider: innerPeer.provider,
                tools: [readCatalog],
                outputType: summarySchema,
              });
              const outer = new Agent({
                instructions: 'Consult.',
                model: 'gpt-5.5',
                provider: outerPeer.provider,
                tools: [consult, outerOnly],
              });
              const context = {
                specialist,
                catalog: Object.freeze({ title: 'Selected' }),
                privateCatalog: 'synthetic-private-catalog-secret',
              };
              await outer.run('Outer-only input marker', { context });
              expect(innerPeer.toolOutput('catalog')).toBe('Selected');
              expect(JSON.parse(outerPeer.toolOutput('consult')!)).toEqual({
                title: 'Selected',
              });
              const input = JSON.stringify(innerPeer.requests);
              for (const value of [
                'outer_private',
                'synthetic-private-tool-secret',
                context.privateCatalog,
                'Outer-only input marker',
              ]) {
                expect(input).not.toContain(value);
              }
              const names = (
                innerPeer.requests[0].tools as Array<{ name: string }>
              ).map((entry) => entry.name);
              expect(names).toEqual(['read_catalog']);
              expect(JSON.stringify(outerPeer.requests[0].tools)).toContain(
                'outer_private',
              );
            },
          ),
      );
    }, 25000);

    it('joins a held specialist callback before the cancelled outer Turn settles', async () => {
      const entered = Promise.withResolvers<void>();
      const aborted = Promise.withResolvers<void>();
      const release = Promise.withResolvers<void>();
      await withScriptedResponses(
        [[toolCall('consult', {}, { callId: 'consult' })]],
        async (outerPeer) =>
          withScriptedResponses(
            [[toolCall('read_catalog', {}, { callId: 'catalog' })]],
            async (innerPeer) => {
              const held = tool({
                name: 'read_catalog',
                description: 'Read selected title.',
                parameters: z.strictObject({}),
                execute: async (_args, context: ToolContext<Catalog>) => {
                  context.signal.addEventListener(
                    'abort',
                    () => aborted.resolve(),
                    { once: true },
                  );
                  entered.resolve();
                  await release.promise;
                  return context.context.title;
                },
              });
              const specialist = new Agent<Catalog, Summary>({
                instructions: 'Read.',
                model: 'gpt-5.5',
                provider: innerPeer.provider,
                tools: [held],
                outputType: summarySchema,
              });
              const session = await new Agent({
                instructions: 'Consult.',
                model: 'gpt-5.5',
                provider: outerPeer.provider,
                tools: [consult],
              }).session({
                context: { specialist, catalog: { title: 'Selected' } },
              });
              try {
                const turn = await session.submit('Consult.');
                let settled = false;
                const outcome = turn
                  .wait()
                  .then(
                    () => ({ ok: true as const }),
                    (error: unknown) => ({ ok: false as const, error }),
                  )
                  .finally(() => {
                    settled = true;
                  });
                await entered.promise;
                let cancelled = false;
                const stopping = turn.cancel().then(
                  () => {
                    cancelled = true;
                    return undefined;
                  },
                  (error: unknown) => {
                    cancelled = true;
                    return error;
                  },
                );
                await aborted.promise;
                expect(settled).toBe(false);
                expect(cancelled).toBe(false);
                release.resolve();
                const cancellationFailure = await stopping;
                // Independent Session cancellation has its own error identity.
                // The outer loop retains it as callback cleanup failure.
                expect(cancellationFailure).toBeInstanceOf(AggregateError);
                const result = await outcome;
                expect(result.ok).toBe(false);
                const repeated = await turn
                  .wait()
                  .catch((error: unknown) => error);
                if (!result.ok) expect(repeated).toBe(result.error);
                expect(innerPeer.toolOutput('catalog')).toBeUndefined();
                expect(outerPeer.toolOutput('consult')).toBeUndefined();
                innerPeer.assertExhausted();
                outerPeer.assertExhausted();
              } finally {
                release.resolve();
                // Observe the retained callback failure during owned close.
                await expect(session.close()).rejects.toBeInstanceOf(
                  AggregateError,
                );
              }
            },
          ),
      );
    }, 25000);

    it.each(['callback', 'output'] as const)(
      'propagates specialist %s failure through outer cleanup',
      async (mode) => {
        await withScriptedResponses(
          [[toolCall('consult', {}, { callId: 'consult' })]],
          async (outerPeer) =>
            withScriptedResponses(
              mode === 'callback'
                ? [[toolCall('read_catalog', {}, { callId: 'catalog' })]]
                : [[text('{"title":7,"extra":"invalid"}')]],
              async (innerPeer) => {
                const failingRead = tool({
                  name: 'read_catalog',
                  description: 'Read.',
                  parameters: z.strictObject({}),
                  execute: () => {
                    throw new Error('Synthetic specialist callback failed');
                  },
                });
                const specialist = new Agent<Catalog, Summary>({
                  instructions: 'Summarize.',
                  model: 'gpt-5.5',
                  provider: innerPeer.provider,
                  tools: [failingRead],
                  outputType: summarySchema,
                });
                const outer = new Agent({
                  instructions: 'Consult.',
                  model: 'gpt-5.5',
                  provider: outerPeer.provider,
                  tools: [consult],
                });
                await expect(
                  outer.run('Consult.', {
                    context: { specialist, catalog: { title: 'Selected' } },
                  }),
                ).rejects.toThrow(
                  mode === 'callback'
                    ? 'Synthetic specialist callback failed'
                    : 'Final output did not match the requested output type',
                );
                expect(outerPeer.toolOutput('consult')).toBeUndefined();
                innerPeer.assertExhausted();
                outerPeer.assertExhausted();
              },
            ),
        );
      },
      25000,
    );
  },
);
