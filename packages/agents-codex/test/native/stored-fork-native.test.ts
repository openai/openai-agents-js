import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  localStorage,
  type StoredForkOptions,
} from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, message } from './fixtures/model-server';

const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function fixture(server: ModelServer) {
  const home = await mkdtemp(join(tmpdir(), 'native-stored-fork-'));
  homes.push(home);
  const config = await server.config();
  return {
    storage: localStorage(join(home, 'profile')),
    provider: new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-stored-fork',
      supportsWebsockets: false,
    }),
  };
}

it('retains full original records through a cold referenced branch and source deletion exclusion', async () => {
  const server = new ModelServer([]);
  const { storage, provider } = await fixture(server);
  await using ownedProvider = provider;
  const agent = new Agent({ instructions: 'Answer.', provider: ownedProvider });
  const originals = [
    {
      type: 'application-audit',
      payload: { kept: '😀', '$serde_json::private::Number': '123' },
    },
    {
      type: 'function_call',
      id: 'call-original',
      call_id: 'long-result',
      name: 'read',
      arguments: '{}',
    },
    {
      type: 'function_call_output',
      id: 'output-original',
      call_id: 'long-result',
      output: `untruncated-${'x'.repeat(131072)}`,
    },
  ];
  const source = await agent.session({ storage });
  const identity = source.id;
  let forkId: string;
  try {
    const before = await source.historySnapshot();
    await source.transactHistory({
      expectedRevision: before.revision,
      keep: 0,
      items: originals,
    });
    const retained = await source.historySnapshot();
    forkId = await source.forkStored();
    expect(forkId).not.toBe(identity);
    expect(source.id).toBe(identity);
    expect(await source.historySnapshot()).toEqual(retained);
  } finally {
    await source.close();
  }
  {
    await using branch = await agent.session({ storage, resume: forkId });
    expect(
      (await branch.historySnapshot()).items.slice(0, originals.length),
    ).toEqual(originals);
  }
  {
    await using original = await agent.session({ storage, resume: identity });
    await expect(original.deleteStored()).rejects.toThrow();
  }
  {
    await using branch = await agent.session({ storage, resume: forkId });
    await branch.deleteStored();
  }
  {
    await using original = await agent.session({ storage, resume: identity });
    await original.deleteStored();
  }
  expect(server.requests).toHaveLength(0);
});

it.each(['beforeTurnId', 'throughTurnId'] as const)(
  'preserves exact %s boundary and source continuity',
  async (boundary) => {
    const server = new ModelServer(
      [0, 1, 2].map((index) => [message(`answer-${index}`)]),
    );
    const { storage, provider } = await fixture(server);
    await using ownedProvider = provider;
    const agent = new Agent({
      instructions: 'Answer.',
      provider: ownedProvider,
    });
    const source = await agent.session({ storage });
    let forkId: string;
    const turns: string[] = [];
    try {
      for (const text of ['first-prefix', 'second-prefix'])
        await (await source.submit(text)).wait();
      for await (const turn of source.turns()) turns.push(turn.id);
      forkId = await source.forkStored({
        [boundary]: turns[1]!,
      } satisfies StoredForkOptions);
      expect(
        (await (await source.submit('source-only')).wait()).finalOutput,
      ).toBe('answer-2');
      await expect(
        source.forkStored({
          beforeTurnId: turns[0]!,
          throughTurnId: turns[1]!,
        }),
      ).rejects.toThrow(/either/);
      await expect(
        source.forkStored({ beforeTurnId: 'nonexistent-native-turn' }),
      ).rejects.toThrow();
    } finally {
      await source.close();
    }
    await using branch = await agent.session({ storage, resume: forkId });
    const expected = turns.slice(0, boundary === 'beforeTurnId' ? 1 : 2);
    let cursor: string | undefined;
    for (const [index, expectedId] of expected.entries()) {
      const page = await branch.storedTurns({ limit: 1, cursor });
      expect(page.turns.map((turn) => turn.id)).toEqual([expectedId]);
      expect(page.nextCursor === null).toBe(index === expected.length - 1);
      cursor = page.nextCursor ?? undefined;
    }
    const details = await branch.storedItems({ turnId: turns[0]! });
    expect(details.items.length).toBeGreaterThan(0);
    expect(details.items.every((item) => item.turnId === turns[0])).toBe(true);
    expect(JSON.stringify(details)).toContain('first-prefix');
    cursor = undefined;
    for (const [index, expectedId] of expected.entries()) {
      const matches = await branch.searchHistory('prefix', {
        limit: 1,
        cursor,
      });
      expect(matches.items.map((match) => match.turnId)).toEqual([expectedId]);
      expect(matches.nextCursor === null).toBe(index === expected.length - 1);
      cursor = matches.nextCursor ?? undefined;
    }
    const raw = JSON.stringify((await branch.historySnapshot()).items);
    expect(raw).toContain('first-prefix');
    expect(raw.includes('second-prefix')).toBe(boundary === 'throughTurnId');
    expect(raw).not.toContain('source-only');
    expect(server.requests).toHaveLength(3);
  },
);

it('preserves a referenced prefix after source reversion and releases it only after branch deletion', async () => {
  const server = new ModelServer(
    [0, 1].map((index) => [message(`answer-${index}`)]),
  );
  const { storage, provider } = await fixture(server);
  await using ownedProvider = provider;
  const agent = new Agent({ instructions: 'Answer.', provider: ownedProvider });
  const source = await agent.session({ storage });
  const sourceId = source.id;
  const turns: string[] = [];
  let forkId: string;
  try {
    for (const text of ['first-prefix', 'second-prefix'])
      await (await source.submit(text)).wait();
    for await (const turn of source.turns()) turns.push(turn.id);
    forkId = await source.forkStored({ throughTurnId: turns[0]! });
    await source.revertStored({ beforeTurnId: turns[0]! });
  } finally {
    await source.close();
  }
  {
    await using restored = await agent.session({ storage, resume: sourceId });
    expect((await restored.storedTurns()).turns).toEqual([]);
    expect((await restored.searchHistory('prefix')).items).toEqual([]);
    expect(
      JSON.stringify((await restored.historySnapshot()).items),
    ).not.toContain('first-prefix');
    await expect(restored.deleteStored()).rejects.toThrow();
  }
  {
    await using branch = await agent.session({ storage, resume: forkId });
    expect((await branch.storedTurns()).turns.map((turn) => turn.id)).toEqual(
      turns.slice(0, 1),
    );
    expect(
      (await branch.searchHistory('prefix')).items.map((match) => match.turnId),
    ).toEqual(turns.slice(0, 1));
    const raw = JSON.stringify((await branch.historySnapshot()).items);
    expect(raw).toContain('first-prefix');
    expect(raw).not.toContain('second-prefix');
    await branch.deleteStored();
  }
  {
    await using restored = await agent.session({ storage, resume: sourceId });
    await restored.deleteStored();
  }
  expect(server.requests).toHaveLength(2);
});

it('joins an admitted stored fork before concurrent source close without revoking publication', async () => {
  const server = new ModelServer([]);
  const { storage, provider } = await fixture(server);
  await using ownedProvider = provider;
  const agent = new Agent({ instructions: 'Answer.', provider: ownedProvider });
  const source = await agent.session({ storage });
  const addon = await binding();
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const original = addon.NativeThread.prototype._publish_stored_fork;
  vi.spyOn(
    addon.NativeThread.prototype,
    '_publish_stored_fork',
  ).mockImplementationOnce(async function (
    this: typeof addon.NativeThread.prototype,
  ) {
    entered.resolve();
    await release.promise;
    return original.call(this);
  });
  const pending = source.forkStored();
  await entered.promise;
  let closed = false;
  const closing = source.close().then(() => {
    closed = true;
  });
  await Promise.resolve();
  expect(closed).toBe(false);
  release.resolve();
  const id = await pending;
  await closing;
  expect(id).not.toBe(source.id);
  await using branch = await agent.session({ storage, resume: id });
  expect(branch.id).toBe(id);
  expect(server.requests).toHaveLength(0);
});

it('rolls back a stored fork whose native wrapper delivery has failed', async () => {
  const server = new ModelServer([]);
  const { storage, provider } = await fixture(server);
  await using ownedProvider = provider;
  const agent = new Agent({ instructions: 'Answer.', provider: ownedProvider });
  await using source = await agent.session({ storage });
  const addon = await binding();
  const original = addon.NativeThread.prototype._fork_stored;
  const failure = new Error('synthetic stored fork wrapper lost');
  let created: string | undefined;
  vi.spyOn(addon.NativeThread.prototype, '_fork_stored').mockImplementationOnce(
    async function (this: typeof addon.NativeThread.prototype, request) {
      const copy = await original.call(this, request);
      created = copy.id;
      throw failure;
    },
  );
  await expect(source.forkStored()).rejects.toBe(failure);
  expect(created).toBeTypeOf('string');
  await expect(agent.session({ storage, resume: created! })).rejects.toThrow();
  await expect(source.historySnapshot()).resolves.toHaveProperty('revision');
  expect(server.requests).toHaveLength(0);
});

it('preserves a prepublication failure and retries its retained cleanup owner on close', async () => {
  const server = new ModelServer([]);
  const { storage, provider } = await fixture(server);
  await using ownedProvider = provider;
  const agent = new Agent({ instructions: 'Answer.', provider: ownedProvider });
  const source = await agent.session({ storage });
  const addon = await binding();
  const primary = new Error('synthetic publication failure');
  const cleanup = new Error('synthetic rollback failure');
  vi.spyOn(
    addon.NativeThread.prototype,
    '_publish_stored_fork',
  ).mockRejectedValueOnce(primary);
  vi.spyOn(addon.NativeThread.prototype, '_discard_fork').mockRejectedValueOnce(
    cleanup,
  );
  try {
    const failure: unknown = await source
      .forkStored()
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AggregateError);
    expect((failure as AggregateError).cause).toBe(primary);
    expect((failure as AggregateError).errors).toEqual([primary, cleanup]);
  } finally {
    vi.restoreAllMocks();
    await source.close();
  }
  await expect(provider.close()).resolves.toBeUndefined();
  expect(server.requests).toHaveLength(0);
});
