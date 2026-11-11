import { afterEach, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Agent,
  NativeProvider,
  localStorage,
  type SessionState,
} from '../../src';
import { ModelServer } from './fixtures/model-server';

const homes: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

it.each([false, true])(
  'keeps complete cold limited-history metadata and stale CAS with durable=%s',
  async (durable) => {
    const server = new ModelServer([]);
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-bounded-history',
      supportsWebsockets: false,
    });
    const agent = new Agent({
      instructions: 'Answer.',
      model: 'gpt-5',
      provider,
    });
    const originals = [
      { type: 'future_history_record', large: 'x'.repeat(256 * 1024) },
      ...Array.from({ length: 2048 }, (_, order) => ({
        type: 'future_history_record',
        order,
      })),
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'last admitted original' }],
      },
    ];
    const home = await mkdtemp(join(tmpdir(), 'native-bounded-history-'));
    homes.push(home);
    const storage = durable ? localStorage(join(home, 'profile')) : undefined;
    const session = await agent.session(storage ? { storage } : {});
    const identity = session.id;
    let state: SessionState | undefined;
    try {
      const before = await session.historySnapshot();
      await session.transactHistory({
        expectedRevision: before.revision,
        keep: 0,
        items: originals,
      });
      if (!durable) state = await session.saveState();
    } finally {
      await session.close();
    }
    await using restored = await agent.session(
      storage ? { storage, resume: identity } : { state: state! },
    );
    // Query the cold suffix before a full snapshot can hydrate any existing cache.
    const empty = await restored.historySnapshot({ limit: 0 });
    const tail = await restored.historySnapshot({ limit: 1 });
    const window = await restored.historySnapshot({ limit: 7 });
    const complete = await restored.historySnapshot();
    expect(complete.items.slice(0, originals.length)).toEqual(originals);
    for (const [limited, size] of [
      [empty, 0],
      [tail, 1],
      [window, 7],
    ] as const) {
      expect(limited.revision).toBe(complete.revision);
      expect(limited.total).toBe(complete.total);
      expect(limited.items).toEqual(size ? complete.items.slice(-size) : []);
    }
    const later = { type: 'future_history_record', order: 'appended' };
    const revision = await restored.transactHistory({
      expectedRevision: tail.revision,
      keep: tail.total,
      items: [later],
    });
    await expect(
      restored.transactHistory({
        expectedRevision: tail.revision,
        keep: tail.total,
        items: [],
      }),
    ).rejects.toThrow(/revision/i);
    expect(await restored.historySnapshot({ limit: 1 })).toEqual({
      revision,
      total: complete.total + 1,
      items: [later],
    });
    expect(server.requests).toEqual([]);
    server.assertExhausted();
  },
);
