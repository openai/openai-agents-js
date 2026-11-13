import { readFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
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
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';
const executors: Awaited<ReturnType<typeof startPublicExecutor>>[] = [];
afterEach(async () => {
  for (const executor of executors.splice(0)) await executor.close();
});

afterEach(() => ModelServer.closeAll());
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

it.each([true, false])(
  'recovers after a settled native child with history=%s',
  async (includeInHistory) => {
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
    let owned: Session<{ answer: string }>;
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
      expect((await Array.fromAsync(owned!.subagents())).length).toBe(1);
      const revision = await owned!.historySnapshot({ limit: 0 });
      await expect(
        owned!.transactHistory({
          expectedRevision: revision.revision,
          keep: revision.total,
          items: [],
        }),
      ).rejects.toThrow(/native children|child graphs/);
    } finally {
      release.resolve();
    }
    const result = await pending;
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
