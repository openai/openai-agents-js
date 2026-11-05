import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeAgents,
  NativeRole,
  NativeProvider,
  parseSessionState,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

import { startPublicExecutor } from './fixtures/public-executor';
import type { JsonObject } from '../../src/runtime/binding';

const UNKNOWN_MODEL = 'fixture-model-without-context-metadata';
const USAGE = '{"input_tokens":17,"output_tokens":7,"total_tokens":24}';

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'fixture',
  });
}

afterEach(() => ModelServer.closeAll());

it('reports an unknown limit as null in results and usage events', async () => {
  const server = new ModelServer([[message('finished')]], [USAGE]);
  const provider = await providerFor(server);
  try {
    const session = await new Agent({
      model: UNKNOWN_MODEL,
      instructions: 'Answer.',
      provider,
    }).session();
    try {
      const turn = await session.submit('one');
      const result = await turn.wait();
      expect(result.finalOutput).toBe('finished');
      expect(result.usage?.modelContextWindow).toBeNull();
      expect(result.usage?.totalTokenUsage.totalTokens).toBe(24);
      const observed = [];
      for await (const event of turn.events()) {
        if (event.type !== 'usage_updated') continue;
        observed.push(event.usage);
        if (event.usage !== null) {
          expect(event.usage.modelContextWindow).toBeNull();
        }
      }
      expect(observed.length).toBeGreaterThan(0);
      expect(observed.at(-1)).toEqual(result.usage);
      expect(server.requests[0]?.model).toBe(UNKNOWN_MODEL);
      server.assertExhausted();
    } finally {
      await session.close();
    }
  } finally {
    await provider.close();
  }
});

it('clears a prior limit only on new usage and preserves null through restore and fork', async () => {
  const server = new ModelServer(
    ['known', 'no usage', 'unknown', 'restored', 'forked'].map((text) => [
      message(text),
    ]),
    [USAGE, () => undefined, USAGE, () => undefined, () => undefined],
  );
  const provider = await providerFor(server);
  try {
    const agent = new Agent({
      model: 'gpt-5.5',
      instructions: 'Answer.',
      provider,
    });
    const session = await agent.session();
    try {
      const known = await (await session.submit('known model')).wait();
      expect(known.usage?.modelContextWindow).toBeGreaterThan(0);
      await session.update({ model: UNKNOWN_MODEL });
      const unchanged = await (
        await session.submit('unknown without new usage')
      ).wait();
      expect(unchanged.usage).toEqual(known.usage);

      const unknown = await (
        await session.submit('unknown with new usage')
      ).wait();
      expect(unknown.usage?.modelContextWindow).toBeNull();
      expect(unknown.usage?.totalTokenUsage.totalTokens).toBe(48);
      expect(unknown.usage?.lastTokenUsage.totalTokens).toBe(24);
      expect(known.usage?.modelContextWindow).toBeGreaterThan(0);
      const saved = parseSessionState(
        JSON.stringify(await session.saveState()),
      );
      const forked = parseSessionState(JSON.stringify(await session.fork()));

      for (const state of [saved, forked]) {
        const restored = await agent.session({ state });
        try {
          const turn = await restored.submit('keep the observed snapshot');
          expect((await turn.wait()).usage).toEqual(unknown.usage);
          let observed = 0;
          for await (const event of turn.events()) {
            if (event.type !== 'usage_updated') continue;
            observed++;
            expect(event.usage).toEqual(unknown.usage);
          }
          expect(observed).toBeGreaterThan(0);
        } finally {
          await restored.close();
        }
      }
      expect(server.requests.map((request) => request.model)).toEqual([
        'gpt-5.5',
        ...Array<string>(4).fill(UNKNOWN_MODEL),
      ]);
      server.assertExhausted();
    } finally {
      await session.close();
    }
  } finally {
    await provider.close();
  }
});

it('reports the model context used for child compaction and sampling', async () => {
  const childEntered = Promise.withResolvers<void>();
  const releaseChild = Promise.withResolvers<void>();
  let rootId: string | undefined;
  let rootRequests = 0;
  const turnMetadata = (request: JsonObject) => {
    const metadata = request.client_metadata as Record<string, string>;
    return JSON.parse(metadata['x-codex-turn-metadata']) as {
      thread_id: string;
      request_kind: string;
    };
  };
  const respond = async (request: JsonObject) => {
    const turn = turnMetadata(request);
    if (turn.request_kind === 'compaction') {
      return [message('Summarized inherited context')];
    }
    const id = turn.thread_id;
    rootId ??= id;
    if (id === rootId) {
      if (++rootRequests === 1)
        return [
          call(
            'spawn_agent',
            {
              task_name: 'child',
              message: 'Read the record.',
              agent_type: 'research',
            },
            { namespace: 'collaboration', callId: 'spawn' },
          ),
        ];
      return [message('root finished')];
    }
    childEntered.resolve();
    await releaseChild.promise;
    return [message('child finished')];
  };
  const server = new ModelServer(
    Array.from({ length: 4 }, () => respond),
    Array.from(
      { length: 4 },
      () => (request: JsonObject) =>
        turnMetadata(request).request_kind === 'compaction'
          ? '{"input_tokens":2,"output_tokens":1,"total_tokens":3}'
          : USAGE,
    ),
  );
  const executor = await startPublicExecutor();
  try {
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Delegate.',
      model: 'gpt-5.5',
      provider,
      tools: [
        new NativeAgents({
          additionalRoles: [
            new NativeRole({
              name: 'research',
              description: 'Read the record.',
              instructions: 'Answer.',
              model: 'gpt-daybreak-red-latest',
            }),
          ],
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
      const root = await session.submit('Start the research child');
      await childEntered.promise;
      const parent = await root.wait();
      expect(parent.usage?.modelContextWindow).toBe(258_400);
      const children = await Array.fromAsync(session.subagents());
      expect(children).toHaveLength(1);
      const child = children[0]!.turn!;
      releaseChild.resolve();
      const result = await child.wait();
      expect(result.finalOutput).toBe('child finished');
      expect(result.usage?.modelContextWindow).toBe(353_400);
      expect(result.usage?.lastTokenUsage.totalTokens).toBe(24);
      const childUsage = [];
      for await (const event of child.events()) {
        if (event.type === 'usage_updated' && event.usage !== null) {
          childUsage.push(event.usage);
        }
      }
      // Inherited history is compacted with the parent model before the child samples.
      expect(childUsage[0]).toMatchObject({
        modelContextWindow: 258_400,
        lastTokenUsage: { totalTokens: 3 },
      });
      for (const usage of childUsage.slice(1)) {
        expect(usage.modelContextWindow).toBe(353_400);
      }
      expect(childUsage.at(-1)).toEqual(result.usage);
      const parentUsage = [];
      for await (const event of root.events()) {
        if (event.type !== 'usage_updated') continue;
        parentUsage.push(event.usage);
        if (event.usage !== null)
          expect(event.usage.modelContextWindow).toBe(258_400);
      }
      expect(parentUsage.length).toBeGreaterThan(0);
      expect(parentUsage.at(-1)).toEqual(parent.usage);
      // The settled parent snapshot keeps its own limit after child completion.
      expect(parent.usage?.modelContextWindow).toBe(258_400);
      expect(
        server.requests.filter(
          (request) => request.model === 'gpt-daybreak-red-latest',
        ),
      ).toHaveLength(1);
      server.assertExhausted();
    } finally {
      releaseChild.resolve();
    }
  } finally {
    await executor.close();
  }
});

it('reports the compactor model after terminal compaction overflow', async () => {
  const overflow = {
    status: 200,
    body: `data: ${JSON.stringify({
      type: 'response.failed',
      response: {
        id: 'overflow',
        error: {
          code: 'context_length_exceeded',
          message: 'context limit fixture',
        },
      },
    })}\n\n`,
  };
  const server = new ModelServer(
    [[message('known')], ...Array.from({ length: 16 }, () => overflow)],
    [USAGE],
  );
  await using provider = await providerFor(server);
  await using session = await new Agent({
    model: 'gpt-5.5',
    instructions: 'Answer.',
    provider,
  }).session();
  await (await session.submit('one')).wait();
  await session.update({ model: 'gpt-daybreak-red-latest' });
  const turn = await session.submit('two');
  await expect(turn.wait()).rejects.toThrow(/context window/);
  const observed = [];
  for await (const event of turn.events()) {
    if (event.type === 'usage_updated' && event.usage !== null)
      observed.push(event.usage);
  }
  expect(observed.length).toBeGreaterThan(0);
  expect(server.requests.length).toBeGreaterThan(1);
  expect(server.requests.every((request) => request.model === 'gpt-5.5')).toBe(
    true,
  );
  expect(observed.at(-1)?.totalTokenUsage.totalTokens).toBe(258_400);
  expect(observed.at(-1)?.modelContextWindow).toBe(258_400);
});
