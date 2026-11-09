import { afterEach, expect, it } from 'vitest';
import { Agent, NativeProvider } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('atomically replaces canonical history and restores it into the next native request', async () => {
  const server = new ModelServer([[message('continued')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-history-key',
  });
  const agent = new Agent({
    instructions: 'Answer briefly.',
    model: 'gpt-5',
    provider,
  });
  const session = await agent.session({
    initialMessages: [{ role: 'user', content: 'old input' }],
  });
  let state;
  let revision: string;
  let retained;
  try {
    const before = await session.historySnapshot();
    expect(before.total).toBe(before.items.length);
    expect(await session.historySnapshot({ limit: 1 })).toEqual({
      revision: before.revision,
      total: before.total,
      items: before.items.slice(-1),
    });
    expect((await session.historySnapshot({ limit: 0 })).items).toEqual([]);
    revision = await session.transactHistory({
      expectedRevision: before.revision,
      keep: 0,
      items: [
        {
          type: 'function_call',
          id: 'fc-history',
          call_id: 'call-history',
          name: 'lookup',
          arguments: '{}',
        },
        {
          type: 'function_call_output',
          id: 'out-history',
          call_id: 'call-history',
          output: 'imported result',
        },
      ],
    });
    retained = await session.historySnapshot();
    expect(retained).toMatchObject({ revision, total: 2 });
    await expect(
      session.transactHistory({ expectedRevision: before.revision, keep: 0 }),
    ).rejects.toThrow('revision conflict');
    await expect(
      session.transactHistory({
        expectedRevision: revision,
        keep: 0,
        items: [{ type: 'unsupported-item' }],
      }),
    ).rejects.toThrow('unsupported canonical');
    expect((await session.historySnapshot()).revision).toBe(revision);
    state = await session.saveState();
  } finally {
    await session.close();
  }
  const restored = await agent.session({ state });
  try {
    expect(await restored.historySnapshot()).toEqual(retained);
    expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
      'continued',
    );
  } finally {
    await restored.close();
  }
  const input = JSON.stringify(server.requests[0]?.input);
  expect(input).not.toContain('old input');
  expect(input).toContain('imported result');
  expect(input).toContain('call-history');
  server.assertExhausted();
});
