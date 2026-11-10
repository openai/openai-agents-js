import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  NativeError,
  NativeProvider,
  fileSessionStore,
  type SessionStore,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('retires after a durable history checkpoint is accepted but its flush fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'history-uncertain-'));
  const durable = fileSessionStore(directory);
  let armed = false;
  let acceptedCheckpoint = false;
  const storage: SessionStore = {
    acquire: (...args) => durable.acquire(...args),
    read: (...args) => durable.read(...args),
    release: (...args) => durable.release(...args),
    commit: async (...args) => {
      await durable.commit(...args);
      if (
        armed &&
        JSON.parse(args[4]).mutations.some(
          (mutation: {
            operation: string;
            items?: Record<string, unknown>[];
          }) =>
            mutation.operation === 'append' &&
            mutation.items?.some(
              (item) =>
                item.type === 'compacted' &&
                JSON.stringify(item).includes('committed replacement'),
            ),
        )
      )
        acceptedCheckpoint = true;
    },
    flush: async (...args) => {
      if (armed && acceptedCheckpoint) {
        armed = false;
        throw new Error('synthetic flush failure after committed checkpoint');
      }
      await durable.flush?.(...args);
    },
  };
  try {
    const server = new ModelServer([[message('restored replacement')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-uncertain',
    });
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const session = await agent.session({
      storage,
      initialMessages: [{ role: 'user', content: 'original history' }],
    });
    const identity = session.id;
    let stale;
    let before;
    try {
      before = await session.historySnapshot();
      armed = true;
      await expect(
        session.transactHistory({
          expectedRevision: before.revision,
          keep: 0,
          items: [
            {
              type: 'message',
              id: 'replacement',
              role: 'user',
              content: [{ type: 'input_text', text: 'committed replacement' }],
            },
          ],
        }),
      ).rejects.toThrow(/flush|persistence|commit/i);
      expect(acceptedCheckpoint).toBe(true);
      try {
        stale = await session.historySnapshot();
      } catch {
        stale = undefined;
      }
      if (stale === undefined)
        await expect(session.submit('must not execute')).rejects.toThrow();
      expect(server.requests).toHaveLength(0);
    } finally {
      // The failed backend barrier remains a reported close error even after
      // its writer is released. Restore below must acquire a fresh owner.
      await session.close().catch((error) => {
        expect(error).toBeInstanceOf(NativeError);
        expect(error.message).toContain('canonical storage');
      });
    }
    const restored = await agent.session({ storage, resume: identity });
    try {
      const current = await restored.historySnapshot();
      expect(JSON.stringify(current.items)).toContain('committed replacement');
      expect(JSON.stringify(current.items)).not.toContain('original history');
      expect(current.revision).not.toBe(before!.revision);
      expect(
        (await (await restored.submit('continue')).wait()).finalOutput,
      ).toBe('restored replacement');
    } finally {
      await restored.close();
    }
    expect(
      stale,
      'durable replacement failed but old live history remained usable',
    ).toBeUndefined();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

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

it('captures the admitted prefix, revision and items before scheduling a history transaction', async () => {
  const server = new ModelServer([]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-history-key',
  });
  const session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session({
    initialMessages: [{ role: 'user', content: 'retained prefix' }],
  });
  try {
    const before = await session.historySnapshot();
    const options = {
      expectedRevision: before.revision,
      keep: before.total,
      items: [
        {
          type: 'message',
          id: 'msg_admitted_append',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'admitted append' }],
        },
      ],
    };
    const pending = session.transactHistory(options);
    options.keep = 0;
    options.expectedRevision = 'changed after admission';
    options.items[0]!.content[0]!.text = 'changed after admission';
    const revision = await pending;
    const after = await session.historySnapshot();
    expect(after.revision).toBe(revision);
    expect(after.total).toBe(before.total + 1);
    expect(after.items.slice(0, before.total)).toEqual(before.items);
    expect(after.items.at(-1)).toMatchObject({
      id: 'msg_admitted_append',
      content: [{ type: 'output_text', text: 'admitted append' }],
    });
    expect(server.requests).toEqual([]);
  } finally {
    await session.close();
  }
  server.assertExhausted();
});

it.each(['function', 'custom', 'search'])(
  'rejects split or unpaired %s client-tool history before changing state',
  async (family) => {
    const server = new ModelServer([[message('pairs preserved')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-history-pairs',
    });
    const session = await new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    }).session();
    const call: import('../../src/runtime/binding').JsonObject = {
      id: 'call-item',
      call_id: 'history-pair',
      ...(family === 'function'
        ? { type: 'function_call', name: 'lookup', arguments: '{}' }
        : family === 'custom'
          ? { type: 'custom_tool_call', name: 'lookup', input: 'raw input' }
          : { type: 'tool_search_call', execution: 'client', arguments: {} }),
    };
    const output: import('../../src/runtime/binding').JsonObject = {
      id: 'result-item',
      call_id: 'history-pair',
      ...(family === 'function'
        ? { type: 'function_call_output', output: 'retained result' }
        : family === 'custom'
          ? { type: 'custom_tool_call_output', output: 'retained result' }
          : {
              type: 'tool_search_output',
              execution: 'client',
              status: 'completed',
              tools: [],
            }),
    };
    try {
      const initial = await session.historySnapshot();
      await session.transactHistory({
        expectedRevision: initial.revision,
        keep: 0,
        items: [call, output],
      });
      const retained = await session.historySnapshot();
      for (const change of [
        { keep: 1, items: [] },
        { keep: 1, items: [output] },
        { keep: 0, items: [call] },
        { keep: 0, items: [output] },
        { keep: 0, items: [output, call] },
      ]) {
        await expect(
          session.transactHistory({
            expectedRevision: retained.revision,
            ...change,
          }),
        ).rejects.toThrow('complete tool call/result pairs');
        expect(await session.historySnapshot()).toEqual(retained);
        expect(server.requests).toEqual([]);
      }
      expect(
        (await (await session.submit('continue')).wait()).finalOutput,
      ).toBe('pairs preserved');
    } finally {
      await session.close();
    }
    const wire = server.requests[0]!.input as Array<{ call_id?: string }>;
    expect(wire.filter((item) => item.call_id === 'history-pair')).toHaveLength(
      2,
    );
    server.assertExhausted();
  },
);

it('preserves self-contained provider-hosted history and unpaired server search output', async () => {
  const server = new ModelServer([[message('hosted preserved')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-hosted-history',
  });
  const session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  try {
    const before = await session.historySnapshot();
    await session.transactHistory({
      expectedRevision: before.revision,
      keep: 0,
      items: [
        {
          type: 'web_search_call',
          id: 'hosted-search',
          status: 'completed',
          action: { type: 'search', query: 'synthetic query' },
        },
        {
          type: 'tool_search_output',
          id: 'server-search-output',
          call_id: null,
          execution: 'server',
          status: 'completed',
          tools: [],
        },
      ],
    });
    const retained = await session.historySnapshot();
    expect(
      retained.items.map((item) => (item as { type: string }).type),
    ).toEqual(['web_search_call', 'tool_search_output']);
    expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
      'hosted preserved',
    );
  } finally {
    await session.close();
  }
  const wire = server.requests[0]!.input as Array<{
    type: string;
    execution?: string;
  }>;
  expect(wire.some((item) => item.type === 'web_search_call')).toBe(true);
  expect(
    wire.some(
      (item) =>
        item.type === 'tool_search_output' && item.execution === 'server',
    ),
  ).toBe(true);
  server.assertExhausted();
});
