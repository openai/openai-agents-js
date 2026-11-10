import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeError,
  NativeProvider,
  tool,
  toolRef,
  type DecisionProvider,
} from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { nativeDescendantModel } from './fixtures/native-descendant-model';
import { startPublicExecutor } from './fixtures/public-executor';

const nativeIt = it.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1');
afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-step-stop',
    supportsWebsockets: false,
  });
}

nativeIt(
  'uses a decision to stop a root before its first request and keeps the Session usable',
  async () => {
    const server = new ModelServer([[message('healthy later run')]]);
    await using provider = await providerFor(server);
    const decisions: DecisionProvider = {
      getDecision: vi.fn(async () => ({ value: false })),
    };
    const agent = new Agent({ instructions: 'Answer.', provider, decisions });
    await using session = await agent.session();

    const turn = await session.submit('Stop before sampling.', {
      budget: { maxRequests: 1 },
      async beforeStep(context) {
        return (await context.decide('May this request proceed?', {
          input: 'Explicit policy input.',
        }))
          ? undefined
          : { action: 'stop' };
      },
    });
    await expect(turn.wait()).rejects.toBeInstanceOf(NativeError);
    expect(server.requests).toHaveLength(0);
    expect(decisions.getDecision).toHaveBeenCalledTimes(1);
    expect(
      (await (await session.submit('Continue independently.')).wait())
        .finalOutput,
    ).toBe('healthy later run');
    server.assertExhausted();
  },
);

nativeIt(
  'stops after permission changes without undoing the earlier tool effect',
  async () => {
    const policy = { allowed: true };
    const effects: string[] = [];
    const update = tool({
      name: 'update_record',
      parameters: z.object({}),
      execute: () => {
        effects.push('record updated');
        policy.allowed = false;
        return 'Updated.';
      },
    });
    const server = new ModelServer([
      [call(update.name, {}, { callId: 'update-once' })],
      [message('independent turn')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent<typeof policy>({
      instructions: 'Update the record.',
      provider,
      tools: [update],
    }).session({ context: policy });
    const turn = await session.submit('Update and summarize.', {
      async beforeStep({ context }) {
        return context.allowed ? undefined : { action: 'stop' };
      },
    });

    await expect(turn.wait()).rejects.toBeInstanceOf(NativeError);
    expect(effects).toEqual(['record updated']);
    expect(server.requests).toHaveLength(1);
    expect((await (await session.submit('New task.')).wait()).finalOutput).toBe(
      'independent turn',
    );
    server.assertExhausted();
  },
);

nativeIt(
  'joins a cancelled callback and ignores its late stop decision',
  async () => {
    const entered = Promise.withResolvers<AbortSignal>();
    const release = Promise.withResolvers<void>();
    const server = new ModelServer([[message('successor completed')]]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Answer.',
      provider,
    }).session();
    let cancellation: Promise<void> | undefined;
    try {
      const turn = await session.submit('Hold the preparation.', {
        async beforeStep({ signal }) {
          entered.resolve(signal);
          await release.promise;
          return { action: 'stop' };
        },
      });
      const stopped = turn.wait().catch((error) => error);
      const signal = await entered.promise;
      let joined = false;
      cancellation = turn.cancel().then(() => {
        joined = true;
      });
      cancellation.catch(() => {});
      await vi.waitFor(() => expect(signal.aborted).toBe(true));
      expect(joined).toBe(false);
      release.resolve();
      await cancellation;
      expect(await stopped).toBeInstanceOf(NativeError);
      expect(server.requests).toHaveLength(0);

      expect(
        (await (await session.submit('Run the successor.')).wait()).finalOutput,
      ).toBe('successor completed');
      server.assertExhausted();
    } finally {
      release.resolve();
      await cancellation?.catch(() => {});
    }
  },
);

nativeIt(
  'uses child decisions to stop only the selected child while its sibling finishes',
  async () => {
    const release = Promise.withResolvers<void>();
    const entered = new Set<string>();
    let stoppedId: string | undefined;
    const childDecisions: DecisionProvider = {
      getDecision: vi.fn(async (request) => ({
        value: request.input !== stoppedId,
      })),
    };
    let rootId: string | undefined;
    let rootRequests = 0;
    const requestThreads: string[] = [];
    const reply = (request: JsonObject) => {
      const metadata = request.client_metadata as Record<string, string>;
      const id = String(
        JSON.parse(metadata['x-codex-turn-metadata']).thread_id,
      );
      rootId ??= id;
      requestThreads.push(id);
      if (id !== rootId) return [message('sibling completed')];
      if (++rootRequests === 1)
        return ['first', 'second'].map((name) =>
          call(
            'spawn_agent',
            { task_name: name, message: 'Complete your task.' },
            { namespace: 'collaboration', callId: `spawn-${name}` },
          ),
        );
      return [
        message(rootRequests === 2 ? 'root completed' : 'later root completed'),
      ];
    };
    const server = new ModelServer(Array.from({ length: 4 }, () => reply));
    const executor = await startPublicExecutor();
    try {
      await using provider = await providerFor(server);
      await using session = await new Agent({
        instructions: 'Delegate two independent tasks.',
        decisions: childDecisions,
        model: nativeDescendantModel,
        provider,
        tools: [
          new NativeAgents({
            maxChildren: 2,
            async beforeStep({ child, decide }) {
              stoppedId ??= child.childId;
              entered.add(child.childId);
              await release.promise;
              return (await decide('May this child sample?', {
                input: child.childId,
              }))
                ? []
                : { action: 'stop' };
            },
          }),
        ],
      }).session({
        environment: new Environment({
          url: executor.url,
          cwd: executor.cwd,
          headers: executor.headers,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        }),
      });
      try {
        const root = await session.submit('Start both tasks.', {
          beforeStep: ({ stepIndex }) =>
            stepIndex === 0 ? [toolRef('spawn_agent', 'collaboration')] : [],
        });
        await vi.waitFor(() => expect(entered.size).toBe(2), {
          timeout: 10_000,
        });
        expect((await root.wait()).finalOutput).toBe('root completed');
        expect(requestThreads).toEqual([rootId, rootId]);
        const children = await vi.waitUntil(async () => {
          const entries = await Array.fromAsync(session.subagents());
          return entries.length === 2 && entries.every((child) => child.turn)
            ? entries
            : false;
        });
        const stopped = children.find((child) => child.id === stoppedId)!;
        const sibling = children.find((child) => child.id !== stoppedId)!;
        release.resolve();
        await expect(stopped.turn!.wait()).rejects.toBeInstanceOf(NativeError);
        expect((await sibling.turn!.wait()).finalOutput).toBe(
          'sibling completed',
        );
        expect(requestThreads).toEqual([rootId, rootId, sibling.id]);
        expect(
          new Set(
            vi
              .mocked(childDecisions.getDecision)
              .mock.calls.map(([request]) => request.input),
          ),
        ).toEqual(new Set([stopped.id, sibling.id]));
        expect((await root.wait()).finalOutput).toBe('root completed');
        expect(
          (await (await session.submit('Another root.', { tools: [] })).wait())
            .finalOutput,
        ).toBe('later root completed');
        server.assertExhausted();
      } finally {
        release.resolve();
      }
    } finally {
      release.resolve();
      await executor.close();
    }
  },
);
