import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { Agent, NativeProvider, fileSessionStore, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-original-history',
    supportsWebsockets: false,
  });
}

it('preserves original object records and their admission across a portable restore', async () => {
  const server = new ModelServer([[message('continued originals')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  });
  const originals = [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'admitted original prompt' }],
      application: { untouched: ['é😀\0', 0.125, 9007199254740991, null] },
    },
    {
      type: 'future_history_record',
      application: { text: 'audit-only future marker', enabled: true },
    },
    { application: { text: 'audit-only missing type marker' } },
    { type: 17, application: { text: 'audit-only nonstring type marker' } },
    JSON.parse(
      '{"$serde_json::private::Number":"123456789012345678901234567890"}',
    ) as Record<string, unknown>,
    {
      '$serde_json::private::RawValue': JSON.stringify({
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'audit-only raw marker promotion' },
        ],
      }),
    },
    JSON.parse(
      '{"__proto__":{"polluted":"audit-only prototype marker"},"constructor":{"prototype":{"kept":true}}}',
    ) as Record<string, unknown>,
    {
      type: { '$serde_json::private::RawValue': '"message"' },
      application: { text: 'audit-only nested nonstring tag' },
    },
  ];
  const session = await agent.session();
  let state;
  let retained;
  try {
    const before = await session.historySnapshot();
    const revision = await session.transactHistory({
      expectedRevision: before.revision,
      keep: 0,
      items: originals,
    });
    retained = await session.historySnapshot();
    expect(retained).toEqual({
      revision,
      total: originals.length,
      items: originals,
    });
    expect(await session.historySnapshot({ limit: 1 })).toEqual({
      revision,
      total: originals.length,
      items: [originals.at(-1)],
    });
    expect(await session.historySnapshot({ limit: 0 })).toEqual({
      revision,
      total: originals.length,
      items: [],
    });
    expect((await session.historySnapshot({ limit: 100 })).items).toEqual(
      originals,
    );
    expect(Object.hasOwn(retained.items[0]!, 'id')).toBe(false);
    expect(Object.hasOwn(retained.items.at(-2)!, '__proto__')).toBe(true);
    state = await session.saveState();
    expect(server.requests).toEqual([]);
  } finally {
    await session.close();
  }
  await using restored = await agent.session({ state });
  expect(await restored.historySnapshot()).toEqual(retained);
  expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
    'continued originals',
  );
  const input = JSON.stringify(server.requests[0]!.input);
  expect(input).toContain('admitted original prompt');
  expect(input).not.toContain('audit-only');
  expect(input).not.toContain('untouched');
  server.assertExhausted();
});

it('retains full native tool output while preserving its admitted model window on append', async () => {
  const output =
    'original-output-start:' + 'é😀 '.repeat(24_000) + ':original-output-end';
  let executions = 0;
  const server = new ModelServer([
    [call('large_output', {}, { callId: 'original-large-output' })],
    [message('large output accepted')],
  ]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Use large_output.',
    model: 'gpt-5',
    provider,
    tools: [
      tool({
        name: 'large_output',
        parameters: z.object({}),
        execute: () => {
          executions++;
          return output;
        },
      }),
    ],
  }).session();
  expect((await (await session.submit('begin')).wait()).finalOutput).toBe(
    'large output accepted',
  );
  const before = await session.historySnapshot();
  expect(
    before.items.find(
      (item) =>
        item.type === 'function_call_output' &&
        item.call_id === 'original-large-output',
    )?.output,
  ).toBe(output);
  const admitted = await session.modelContext();
  const modelOutput = JSON.stringify(
    admitted.items.filter(
      (item) =>
        item.type === 'function_call_output' &&
        item.call_id === 'original-large-output',
    ),
  );
  expect(modelOutput.length).toBeLessThan(output.length);
  const audit = { type: 'future_output_audit', text: 'audit-only append' };
  await session.transactHistory({
    expectedRevision: before.revision,
    keep: before.total,
    items: [audit],
  });
  expect((await session.modelContext()).items).toEqual(admitted.items);
  expect((await session.historySnapshot()).items).toEqual([
    ...before.items,
    audit,
  ]);
  expect(executions).toBe(1);
  expect(server.requests).toHaveLength(2);
  server.assertExhausted();
});

it('uses original-record offsets without splitting pairs around audit-only records', async () => {
  const server = new ModelServer([[message('paired originals continued')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  const originals = [
    { type: 'future_before', text: 'audit-only before' },
    {
      type: 'function_call',
      call_id: 'original-pair',
      name: 'lookup',
      arguments: '{}',
    },
    { text: 'audit-only middle' },
    {
      type: 'function_call_output',
      call_id: 'original-pair',
      output: 'already completed',
    },
    { type: 'future_after', text: 'audit-only after' },
  ];
  const initial = await session.historySnapshot();
  await session.transactHistory({
    expectedRevision: initial.revision,
    keep: 0,
    items: originals,
  });
  const before = await session.historySnapshot();
  await expect(
    session.transactHistory({ expectedRevision: before.revision, keep: 3 }),
  ).rejects.toThrow('complete tool call/result pairs');
  expect(await session.historySnapshot()).toEqual(before);
  const revision = await session.transactHistory({
    expectedRevision: before.revision,
    keep: 4,
  });
  expect(await session.historySnapshot()).toEqual({
    revision,
    total: 4,
    items: originals.slice(0, 4),
  });
  expect((await (await session.submit('continue')).wait()).finalOutput).toBe(
    'paired originals continued',
  );
  const wire = server.requests[0]!.input as Array<Record<string, unknown>>;
  expect(wire.filter((item) => item.call_id === 'original-pair')).toHaveLength(
    2,
  );
  expect(JSON.stringify(wire)).not.toContain('audit-only');
  server.assertExhausted();
});

it('rejects malformed known items and nonobject records without changing history or admission', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  const before = await session.historySnapshot();
  for (const item of [{ type: 'function_call' }, null]) {
    await expect(
      session.transactHistory({
        expectedRevision: before.revision,
        keep: 0,
        items: [item as never],
      }),
    ).rejects.toThrow(/canonical history item/i);
    expect(await session.historySnapshot()).toEqual(before);
  }
  const accepted = {
    text: 'accepted audit-only record after validation failure',
  };
  const revision = await session.transactHistory({
    expectedRevision: before.revision,
    keep: 0,
    items: [accepted],
  });
  expect(await session.historySnapshot()).toEqual({
    revision,
    total: 1,
    items: [accepted],
  });
  expect(server.requests).toEqual([]);
  server.assertExhausted();
});

it('restores raw originals through canonical storage without promoting audit records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'original-history-store-'));
  try {
    const server = new ModelServer([[message('durable originals continued')]]);
    await using provider = await providerFor(server);
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const storage = fileSessionStore(directory);
    const session = await agent.session({ storage });
    const identity = session.id;
    const originals = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'durable original prompt' }],
        unknown: { retained: ['nested', 19, null] },
      },
      { type: 'future_durable_record', text: 'audit-only durable marker' },
    ];
    let retained;
    try {
      const before = await session.historySnapshot();
      await session.transactHistory({
        expectedRevision: before.revision,
        keep: 0,
        items: originals,
      });
      retained = await session.historySnapshot();
      expect(retained.items).toEqual(originals);
    } finally {
      await session.close();
    }
    await using restored = await agent.session({ storage, resume: identity });
    const current = await restored.historySnapshot();
    expect(current.items.slice(0, retained.total)).toEqual(retained.items);
    expect(current.total).toBe(current.items.length);
    for (const item of current.items.slice(retained.total)) {
      expect(item).toMatchObject({ type: 'message', role: 'developer' });
      const metadata = item.internal_chat_message_metadata_passthrough as {
        content_item_kinds: unknown[];
      };
      expect(metadata.content_item_kinds.length).toBeGreaterThan(0);
      for (const kind of metadata.content_item_kinds) {
        expect([
          'collaboration_mode.instructions',
          'sdk_application.accepted',
        ]).toContain(kind);
      }
    }
    expect(await restored.historySnapshot({ limit: 1 })).toEqual({
      revision: current.revision,
      total: current.total,
      items: current.items.slice(-1),
    });
    expect((await (await restored.submit('continue')).wait()).finalOutput).toBe(
      'durable originals continued',
    );
    expect(JSON.stringify(server.requests[0]!.input)).toContain(
      'durable original prompt',
    );
    expect(JSON.stringify(server.requests[0]!.input)).not.toContain(
      'audit-only',
    );
    server.assertExhausted();
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('preserves supplied compaction on append and rejects ambiguous original-prefix shortening', async () => {
  const server = new ModelServer([]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    model: 'gpt-5',
    provider,
  }).session();
  const before = await session.historySnapshot();
  const originals = [
    ...['first original', 'second original', 'third original'].map((text) => ({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
    })),
    { type: 'future_before_compaction', text: 'audit-only retained marker' },
  ];
  await session.transactHistory({
    expectedRevision: before.revision,
    keep: 0,
    items: originals,
  });
  await session.compact({ summary: 'Supplied original-history summary.' });
  const compacted = await session.modelContext();
  const retained = await session.historySnapshot();
  expect(retained.items).toEqual(originals);
  expect(JSON.stringify(compacted.items)).not.toContain('audit-only');
  const audit = { type: 'future_after_compaction', text: 'audit-only marker' };
  await session.transactHistory({
    expectedRevision: retained.revision,
    keep: retained.total,
    items: [audit],
  });
  expect((await session.modelContext()).items).toEqual(compacted.items);
  const appended = await session.historySnapshot();
  await expect(
    session.transactHistory({ expectedRevision: appended.revision, keep: 1 }),
  ).rejects.toThrow('cannot shorten original history across model compaction');
  expect(await session.historySnapshot()).toEqual(appended);
  expect((await session.modelContext()).items).toEqual(compacted.items);
  const replacement = {
    type: 'message',
    role: 'user',
    content: [{ type: 'input_text', text: 'explicit model replacement' }],
  };
  await session.transactHistory({
    expectedRevision: appended.revision,
    keep: 0,
    items: [replacement],
  });
  expect((await session.historySnapshot()).items).toEqual([replacement]);
  const replaced = JSON.stringify((await session.modelContext()).items);
  expect(replaced).toContain('explicit model replacement');
  expect(replaced).not.toContain('Supplied original-history summary.');
  expect(replaced).not.toContain('first original');
  expect(server.requests).toEqual([]);
  server.assertExhausted();
});
