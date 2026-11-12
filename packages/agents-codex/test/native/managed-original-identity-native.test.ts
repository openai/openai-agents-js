import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  localStorage,
  fileSessionStore,
  tool,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

function expectRetainedOriginals(
  original: { total: number; items: readonly unknown[] },
  restored: { items: readonly unknown[] },
) {
  expect(restored.items.slice(0, original.total)).toEqual(original.items);
  for (const receipt of restored.items.slice(original.total))
    expect(receipt).toMatchObject({
      type: 'message',
      role: 'developer',
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['sdk_application.accepted'],
      },
    });
}

it('preserves acknowledged originals across cache eviction, cold reopen and retirement', async () => {
  const home = await mkdtemp(join(tmpdir(), 'native-receipt-originals-'));
  const effects: string[] = [];
  const output = `untruncated-original-${'x'.repeat(131072)}`;
  const read = tool({
    name: 'read',
    parameters: z.object({}),
    execute: () => {
      effects.push('read');
      return output;
    },
  });
  const server = new ModelServer([
    [call('read', {}, { callId: 'original-read' })],
    [message('origin-complete')],
    [message('source-only-complete')],
  ]);
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-originals',
      supportsWebsockets: false,
    });
    const storage = localStorage(join(home, 'profile'));
    const agent = new Agent({
      instructions: 'Answer.',
      tools: [read],
      provider,
    });
    const source = await agent.session({ storage });
    const id = source.id;
    let original: Awaited<ReturnType<typeof source.historySnapshot>>;
    let branch: string;
    try {
      await (await source.submit('origin-marker')).wait();
      await (await source.submit('source-only-marker')).wait();
      const bounded = await source.historySnapshot({ limit: 1 });
      original = await source.historySnapshot();
      expect(original.revision).toBe(bounded.revision);
      expect(original.total).toBe(bounded.total);
      expect(JSON.stringify(original.items)).toContain(output);
      branch = await source.forkStored();
    } finally {
      await source.close();
    }
    {
      await using cold = await agent.session({ storage, resume: id });
      const restored = await cold.historySnapshot();
      expectRetainedOriginals(original!, restored);
      const bounded = await cold.historySnapshot({ limit: 1 });
      expect(bounded.revision).toBe(restored.revision);
      expect(bounded.total).toBe(restored.total);
      await cold.deleteStored({ preserveDescendants: true });
    }
    await expect(agent.session({ storage, resume: id })).rejects.toThrow();
    {
      await using child = await agent.session({ storage, resume: branch! });
      const restored = await child.historySnapshot();
      expectRetainedOriginals(original!, restored);
    }
    expect(effects).toEqual(['read']);
    expect(server.requests).toHaveLength(3);
  } finally {
    await ModelServer.closeAll();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);

it('preserves acknowledged CustomStore originals across cold reopen', async () => {
  const home = await mkdtemp(
    join(tmpdir(), 'native-custom-receipt-originals-'),
  );
  const effects: string[] = [];
  const output = `untruncated-custom-original-${'x'.repeat(131072)}`;
  const read = tool({
    name: 'read',
    parameters: z.object({}),
    execute: () => {
      effects.push('read');
      return output;
    },
  });
  const server = new ModelServer([
    [call('read', {}, { callId: 'custom-original-read' })],
    [message('complete')],
  ]);
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-custom-originals',
      supportsWebsockets: false,
    });
    const storage = fileSessionStore(join(home, 'store'));
    const agent = new Agent({
      instructions: 'Answer.',
      tools: [read],
      provider,
    });
    const source = await agent.session({ storage });
    const id = source.id;
    let original: Awaited<ReturnType<typeof source.historySnapshot>>;
    try {
      await (await source.submit('origin-marker')).wait();
      original = await source.historySnapshot();
      expect(JSON.stringify(original.items)).toContain(output);
    } finally {
      await source.close();
    }
    {
      await using cold = await agent.session({ storage, resume: id });
      const restored = await cold.historySnapshot();
      expectRetainedOriginals(original!, restored);
    }
    expect(effects).toEqual(['read']);
    expect(server.requests).toHaveLength(2);
  } finally {
    await ModelServer.closeAll();
    await rm(home, { recursive: true, force: true });
  }
}, 30_000);
