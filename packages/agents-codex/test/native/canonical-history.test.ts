import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import {
  Agent,
  NativeError,
  NativeProvider,
  fileSessionStore,
  tool,
  type SessionStore,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

it('forwards provider item references after native history restore', async () => {
  const references = [
    { type: 'item_reference', id: 'msg_remote_first' },
    { type: 'item_reference', id: 'msg_remote_second' },
    { type: 'item_reference', id: 'msg_remote_first' },
  ];
  const directory = await mkdtemp(join(tmpdir(), 'provider-references-'));
  try {
    const storage = fileSessionStore(directory);
    const server = new ModelServer([[message('continued')]]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-history',
    });
    const agent = new Agent({
      instructions: 'Answer briefly.',
      model: 'gpt-5',
      provider,
    });
    let sessionId: string;
    {
      await using session = await agent.session({ storage });
      sessionId = session.id;
      const snapshot = await session.historySnapshot();
      for (const invalid of [
        { type: 'item_reference' },
        { type: 'item_reference', id: 17 },
      ]) {
        await expect(
          session.transactHistory({
            expectedRevision: snapshot.revision,
            keep: 0,
            items: [invalid],
          }),
        ).rejects.toThrow('Invalid canonical history item');
        expect((await session.historySnapshot()).revision).toBe(
          snapshot.revision,
        );
      }
      await session.transactHistory({
        expectedRevision: snapshot.revision,
        keep: 0,
        items: references,
      });
      expect((await session.historySnapshot()).items).toEqual(references);
    }
    await using restored = await agent.session({ storage, resume: sessionId });
    expect((await restored.historySnapshot()).items).toEqual(references);
    expect(server.requests).toHaveLength(0);
    expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
      'continued',
    );
    expect(server.requests).toHaveLength(1);
    const wire = server.requests[0]!.input as Array<{ type: string }>;
    expect(wire.filter((item) => item.type === 'item_reference')).toEqual(
      references,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('rejects oversized one-shot history after the run completes', async () => {
  const server = new ModelServer([[message('completed')]]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-history',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Answer.',
    provider,
  });
  const initialMessages = Array.from({ length: 4097 }, (_, index) => ({
    role: 'user' as const,
    content: `Earlier turn ${index}`,
  }));
  await expect(
    agent.run('finish', { initialMessages, returnHistory: true }),
  ).rejects.toThrow(/completed.*history exceeds the result size limit/);
  expect(server.requests).toHaveLength(1);
});

it('rejects oversized original tool output after native completion', async () => {
  const effects: string[] = [];
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute() {
      effects.push('completed');
      return 'x'.repeat(8 * 1024 * 1024 + 1);
    },
  });
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'oversized-original' })],
    [message('large tool result settled')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-history-budget',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Use lookup.',
    provider,
    tools: [lookup],
  });
  await expect(
    agent.run('read the document', { returnHistory: true }),
  ).rejects.toThrow(/completed.*history exceeds the result size limit/);
  expect(effects).toEqual(['completed']);
  expect(server.requests).toHaveLength(2);
});

it('ignores oversized tool output discarded by a history replacement', async () => {
  const effects: string[] = [];
  const lookup = tool({
    name: 'lookup',
    parameters: z.object({}),
    execute() {
      effects.push('completed');
      return 'x'.repeat(8 * 1024 * 1024 + 1);
    },
  });
  const server = new ModelServer([
    [call('lookup', {}, { callId: 'discarded-original' })],
    [message('large tool result settled')],
    [message('small history continued')],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-history-budget',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Use lookup.',
    provider,
    tools: [lookup],
  });
  const retained = {
    type: 'application_note',
    value: 'kept'.repeat(20 * 1024),
  };
  const state = await (async () => {
    await using session = await agent.session();
    expect(
      (await (await session.submit('read the document')).wait()).finalOutput,
    ).toBe('large tool result settled');
    const before = await session.historySnapshot({ limit: 0 });
    await session.transactHistory({
      expectedRevision: before.revision,
      keep: 0,
      items: [retained],
    });
    return session.saveState();
  })();
  const result = await agent.run('continue', { state, returnHistory: true });
  expect(result.finalOutput).toBe('small history continued');
  expect(result.history?.[0]).toEqual(retained);
  expect(
    result.history?.some((item) => item.call_id === 'discarded-original'),
  ).toBe(false);
  expect(effects).toEqual(['completed']);
  expect(server.requests).toHaveLength(3);
});

it.each([false, true])(
  'continues one-shot history in another session with returnState=%s',
  async (returnState) => {
    const calls: string[] = [];
    const lookup = tool({
      name: 'lookup',
      parameters: z.object({ key: z.string() }),
      execute({ key }) {
        calls.push(key);
        return `record:${key}`;
      },
    });
    const server = new ModelServer([
      [call('lookup', { key: 'first' }, { callId: 'detached-lookup' })],
      [message('record loaded')],
      [message('continued with the record')],
    ]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-history',
      supportsWebsockets: false,
    });
    const producer = new Agent({
      instructions: 'Look up the record.',
      tools: [lookup],
      model: 'gpt-5',
      provider,
    });
    const result = await producer.run('load my record', {
      initialMessages: [{ role: 'user', content: 'my prior request' }],
      returnHistory: true,
      returnState,
    });
    expect(result.finalOutput).toBe('record loaded');
    expect(result.state !== undefined).toBe(returnState);
    expect(result.history).toBeDefined();
    const consumer = new Agent({
      instructions: 'Use the previous record.',
      model: 'gpt-5',
      provider,
    });
    await using session = await consumer.session();
    const before = await session.historySnapshot();
    await session.transactHistory({
      expectedRevision: before.revision,
      keep: 0,
      items: result.history!,
    });
    const continued = await (await session.submit('continue')).wait();
    expect(continued.finalOutput).toBe('continued with the record');
    expect(continued.history).toBeUndefined();
    expect(calls).toEqual(['first']);
    expect(server.requests).toHaveLength(3);
    const input = server.requests[2].input as Record<string, unknown>[];
    const replayed = input.filter((item) => item.call_id === 'detached-lookup');
    expect(replayed.map((item) => item.type)).toEqual([
      'function_call',
      'function_call_output',
    ]);
    expect(JSON.stringify(replayed[1])).toContain('record:first');
    const messages = JSON.stringify(
      input.filter((item) => item.type === 'message'),
    );
    expect(messages).not.toContain('Look up the record.');
    expect(messages).toContain('Use the previous record.');
    expect(messages.indexOf('my prior request')).toBeGreaterThanOrEqual(0);
    expect(messages.indexOf('load my record')).toBeGreaterThanOrEqual(0);
    expect(messages.indexOf('load my record')).toBeGreaterThan(
      messages.indexOf('my prior request'),
    );
    expect(messages.indexOf('record loaded')).toBeGreaterThan(
      messages.indexOf('load my record'),
    );
    expect(messages.indexOf('continue')).toBeGreaterThan(
      messages.indexOf('record loaded'),
    );
  },
);

it('captures one-shot text history only on request', async () => {
  const capturedOutput = 'captured output' + 'x'.repeat(128 * 1024);
  const server = new ModelServer([
    [message('ordinary output')],
    [message(capturedOutput)],
  ]);
  const config = await server.config();
  await using provider = new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-history',
    supportsWebsockets: false,
  });
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  });
  const ordinary = await agent.run('ordinary input');
  const captured = await agent.run('captured input', { returnHistory: true });
  expect(ordinary.history).toBeUndefined();
  const items = JSON.stringify(captured.history);
  expect(items).toContain('captured input');
  expect(items).toContain(capturedOutput);
});

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
        items: [{ type: 'function_call' }],
      }),
    ).rejects.toThrow('Invalid canonical history item');
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

it.each(['function', 'custom', 'search', 'computer'])(
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
          : family === 'computer'
            ? {
                type: 'computer_call',
                actions: [{ type: 'wait' }],
                pending_safety_checks: [],
              }
            : { type: 'tool_search_call', execution: 'client', arguments: {} }),
    };
    const output: import('../../src/runtime/binding').JsonObject = {
      id: 'result-item',
      call_id: 'history-pair',
      ...(family === 'function'
        ? { type: 'function_call_output', output: 'retained result' }
        : family === 'custom'
          ? { type: 'custom_tool_call_output', output: 'retained result' }
          : family === 'computer'
            ? {
                type: 'computer_call_output',
                output: {
                  type: 'computer_screenshot',
                  image_url: 'data:image/png;base64,AA==',
                },
                acknowledged_safety_checks: [],
              }
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
