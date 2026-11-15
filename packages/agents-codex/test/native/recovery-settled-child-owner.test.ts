import { readFileSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeProvider,
  NativeRole,
  RecoverRun,
  type Session,
} from '../../src';
import { binding, type NativeThread } from '../../src/runtime/binding';
import { Session as RuntimeSession } from '../../src/runtime/session';
import { ChildCallbacks } from '../../src/runtime/child-callbacks';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
const executors: Awaited<ReturnType<typeof startPublicExecutor>>[] = [];
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.close();
});

afterEach(() => {
  vi.restoreAllMocks();
  return ModelServer.closeAll();
});
const catalog = JSON.parse(
  readFileSync(
    process.env.OPENAI_AGENTS_NATIVE_TEST_MODELS_CATALOG ??
      new URL(
        '../../native/.upstream/reviewed-codex/codex-rs/models-manager/models.json',
        import.meta.url,
      ),
    'utf8',
  ),
).models as {
  slug: string;
  supported_in_api?: boolean;
  multi_agent_version?: string;
}[];
const model = catalog.find(
  (entry) => entry.supported_in_api && entry.multi_agent_version === 'v2',
)!.slug;

it.each([
  {
    includeInHistory: true,
    holdSettlement: false,
    abortRecovery: false,
    lateSettlement: false,
    failAppend: false,
  },
  {
    includeInHistory: false,
    holdSettlement: false,
    abortRecovery: false,
    lateSettlement: false,
    failAppend: false,
  },
  {
    includeInHistory: true,
    holdSettlement: true,
    abortRecovery: false,
    lateSettlement: false,
    failAppend: false,
  },
  {
    includeInHistory: true,
    holdSettlement: true,
    abortRecovery: true,
    lateSettlement: false,
    failAppend: false,
  },
  {
    includeInHistory: true,
    holdSettlement: false,
    abortRecovery: false,
    lateSettlement: true,
    failAppend: false,
  },
  {
    includeInHistory: true,
    holdSettlement: false,
    abortRecovery: false,
    lateSettlement: true,
    failAppend: true,
  },
])(
  'recovers after a settled native child with $includeInHistory, held=$holdSettlement, aborted=$abortRecovery, late=$lateSettlement, failed=$failAppend',
  async ({
    includeInHistory,
    holdSettlement,
    abortRecovery,
    lateSettlement,
    failAppend,
  }) => {
    const childHeld = Promise.withResolvers<void>();
    const childRelease = Promise.withResolvers<void>();
    const joining = Promise.withResolvers<void>();
    const appending = Promise.withResolvers<void>();
    let deliverLate: (() => void) | undefined;
    let appendingHistory = false;
    let appendFailure: unknown;
    if (lateSettlement) {
      const prototype = RuntimeSession.prototype as unknown as {
        processChild: (...args: unknown[]) => void;
      };
      const processChild = prototype.processChild;
      vi.spyOn(prototype, 'processChild').mockImplementation(function (
        this: RuntimeSession,
        ...args
      ) {
        const event = args[0] as {
          subagent_id?: string;
          msg: { type: string };
        };
        if (
          !deliverLate &&
          event.subagent_id &&
          ['turn_complete', 'task_complete', 'turn_aborted'].includes(
            event.msg.type,
          )
        ) {
          deliverLate = () => {
            Reflect.apply(processChild, this, args);
          };
          childHeld.resolve();
          return;
        }
        Reflect.apply(processChild, this, args);
      });
    }
    if (holdSettlement || lateSettlement) {
      const prototype = (await binding()).NativeThread.prototype;
      const childTurn = prototype._child_turn;
      vi.spyOn(prototype, '_child_turn').mockImplementation(async function (
        this: NativeThread,
        ...args
      ) {
        if (lateSettlement && appendingHistory)
          throw new Error('Native history mutation is still in progress');
        if (holdSettlement) {
          childHeld.resolve();
          await childRelease.promise;
        }
        return childTurn.apply(this, args);
      });
      const drain = ChildCallbacks.prototype.drainSettlements;
      vi.spyOn(ChildCallbacks.prototype, 'drainSettlements').mockImplementation(
        function (this: ChildCallbacks) {
          joining.resolve();
          return drain.call(this);
        },
      );
      const append = prototype._append_recovered_output;
      vi.spyOn(prototype, '_append_recovered_output').mockImplementation(
        async function (this: NativeThread, ...args) {
          appending.resolve();
          if (lateSettlement) {
            appendingHistory = true;
            deliverLate!();
            // Keep the real Session mutation open through terminal event dispatch.
            await new Promise<void>((resolve) => setImmediate(resolve));
            try {
              return await (failAppend
                ? append.call(this, 'stale-revision', args[1], args[2])
                : append.apply(this, args));
            } catch (error) {
              appendFailure = error;
              throw error;
            } finally {
              appendingHistory = false;
            }
          }
          await childRelease.promise;
          return append.apply(this, args);
        },
      );
    }
    const controller = new AbortController();
    const executor = await startPublicExecutor();
    executors.push(executor);
    const environment = new Environment({
      url: executor.url,
      cwd: executor.cwd,
      headers: executor.headers,
      tools: ['exec_command', 'write_stdin', 'apply_patch'],
    });
    const server = new ModelServer([
      [
        call(
          'delegate',
          { input: 'work' },
          { namespace: 'collaboration', callId: 'delegate-call' },
        ),
      ],
      [message('{"answer":"child settled"}')],
      [message('{"answer":42}')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-child-recovery',
      supportsWebsockets: false,
    });
    let owned: Session<{ answer: string }, undefined>;
    class CapturedAgent extends Agent<undefined, { answer: string }> {
      override async session(
        ...args: Parameters<Agent<undefined, { answer: string }>['session']>
      ) {
        return (owned = await super.session(...args));
      }
    }
    const parent = new CapturedAgent({
      instructions: 'Delegate then answer.',
      model,
      provider,
      outputType: z.object({ answer: z.string() }),
      tools: [
        new NativeAgents({
          additionalRoles: [
            new NativeRole({
              name: 'recovery_worker',
              description: 'Finish work.',
              instructions: 'Return the answer.',
            }),
          ],
          managedTools: [
            {
              name: 'delegate',
              role: 'recovery_worker',
              description: 'Delegate work.',
            },
          ],
        }),
      ],
    });
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const pending = parent.run('Start.', {
      environment,
      signal: controller.signal,
      returnHistory: true,
      returnItems: true,
      errorHandler: async (failure) => {
        expect(failure.kind).toBe('invalid_output');
        entered.resolve();
        await release.promise;
        return new RecoverRun(
          { answer: 'recovered after child' },
          includeInHistory,
        );
      },
    });
    await Promise.race([
      entered.promise,
      pending.then(() => {
        throw new Error('Expected recovery policy');
      }),
    ]);
    try {
      if (holdSettlement || lateSettlement) await childHeld.promise;
      expect((await Array.fromAsync(owned!.subagents())).length).toBe(1);
      const revision = await owned!.historySnapshot({ limit: 0 });
      const rejection = await vi.waitFor(
        async () => {
          const result = await owned!
            .transactHistory({
              expectedRevision: revision.revision,
              keep: revision.total,
              items: [],
            })
            .then(
              () => undefined,
              (error: unknown) => error,
            );
          // A child continuation can still hold the native operation gate.
          if (
            result instanceof Error &&
            result.message === 'native operations are in progress'
          ) {
            throw result;
          }
          return result;
        },
        { timeout: 5_000 },
      );
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toMatch(
        /native children|child graphs/,
      );
    } finally {
      release.resolve();
    }
    let first: string | undefined;
    if (holdSettlement) {
      first = await Promise.race([
        joining.promise.then(() => 'joining'),
        appending.promise.then(() => 'appending'),
      ]);
      if (abortRecovery) {
        const aborted = pending.catch((error: unknown) => error);
        const reason = new Error(
          'Stop recovery while child settlement is held',
        );
        controller.abort(reason);
        // Native close joins the held reader; allow that cleanup to finish.
        childRelease.resolve();
        expect(await aborted).toBe(reason);
        expect(first).toBe('joining');
        expect(
          vi.mocked(
            (await binding()).NativeThread.prototype._append_recovered_output,
          ),
        ).not.toHaveBeenCalled();
        return;
      }
      childRelease.resolve();
    }
    if (failAppend) {
      const failure = await pending.catch((error: unknown) => error);
      expect(failure).toBe(appendFailure);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('revision conflict');
      server.assertExhausted();
      return;
    }
    const result = await pending;
    if (holdSettlement) expect(first).toBe('joining');
    expect(result.finalOutput).toEqual({ answer: 'recovered after child' });
    expect(server.requests.length).toBe(3);
    expect((await result.turn.wait()).finalOutput).toEqual({
      answer: 'recovered after child',
    });
    const recovered =
      result.items?.filter(
        ({ item }) =>
          item.type === 'message' &&
          item.content.some(
            (part) =>
              part.type === 'output_text' &&
              part.text.includes('recovered after child'),
          ),
      ) ?? [];
    expect(recovered.length).toBe(includeInHistory ? 1 : 0);
    if (includeInHistory)
      expect(
        result.history?.some((item) => item.id === recovered[0]!.item.id),
      ).toBe(true);
    server.assertExhausted();
  },
  20_000,
);
