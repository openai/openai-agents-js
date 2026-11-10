import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  localStorage,
  tool,
  type FunctionApprovalRequest,
  type StoredMatch,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

const homes: string[] = [];
afterEach(async () => {
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});

async function storageFor() {
  const home = await mkdtemp(join(tmpdir(), 'native-indexed-history-'));
  homes.push(home);
  return localStorage(join(home, 'profile'));
}

async function providerFor(server: ModelServer) {
  const config = await server.config();
  return new NativeProvider({
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-indexed-history',
    supportsWebsockets: false,
  });
}

async function nextApproval(session: {
  interactions(): AsyncIterable<unknown>;
}): Promise<FunctionApprovalRequest> {
  for await (const event of session.interactions())
    if (isFunctionApprovalRequest(event)) return event;
  throw new Error('Approval boundary missing');
}

it('pages indexed turns/items and literal matches after a cold reopen', async () => {
  const storage = await storageFor();
  const server = new ModelServer(
    [0, 1, 2].map((index) => [message(`reply-${index}`)]),
  );
  await using provider = await providerFor(server);
  const agent = new Agent({ instructions: 'Answer.', provider });
  const source = await agent.session({ storage });
  const identity = source.id;
  const expected: string[] = [];
  let nextCursor: string;
  try {
    for (let index = 0; index < 3; index++) {
      const turn = await source.submit(`😀 needle-${index}`);
      expect((await turn.wait()).finalOutput).toBe(`reply-${index}`);
    }
    for await (const turn of source.turns()) expected.push(turn.id);
    expect(expected).toHaveLength(3);
    const first = await source.storedTurns({ limit: 1 });
    expect(first.turns.map((turn) => turn.id)).toEqual(expected.slice(0, 1));
    expect(first.turns[0]!.summaryItems).toEqual([]);
    expect(first).not.toHaveProperty('revision');
    expect(first).not.toHaveProperty('total');
    expect(first.nextCursor).toBeTypeOf('string');
    nextCursor = first.nextCursor!;
    await expect(source.storedTurns({ limit: 0 })).rejects.toThrow(/limit/);
    const invalid: unknown = await source
      .storedItems({ cursor: 'SYNTHETIC_SECRET_CURSOR' })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(invalid).toBeInstanceOf(Error);
    expect(String(invalid)).toMatch(/cursor/);
    expect(String(invalid)).not.toContain('SYNTHETIC_SECRET_CURSOR');
    await using other = await agent.session({ storage });
    await expect(other.storedTurns({ cursor: nextCursor })).rejects.toThrow(
      /cursor/,
    );
  } finally {
    await source.close();
  }

  // First cold read through the owning index, before an original snapshot.
  await using restored = await agent.session({ storage, resume: identity });
  const page = await restored.storedTurns({ limit: 1, cursor: nextCursor });
  expect(page.turns.map((turn) => turn.id)).toEqual(expected.slice(1, 2));
  expect(page.nextCursor).toBeTypeOf('string');
  const last = await restored.storedTurns({
    limit: 1,
    cursor: page.nextCursor!,
  });
  expect(last.turns.map((turn) => turn.id)).toEqual(expected.slice(2));
  expect(last.nextCursor).toBeNull();
  const reverse = await restored.storedTurns({
    direction: 'desc',
    includeSummary: true,
  });
  expect(reverse.turns.map((turn) => turn.id)).toEqual([...expected].reverse());
  expect(reverse.turns.every((turn) => turn.summaryItems.length > 0)).toBe(
    true,
  );

  const details = await restored.storedItems({ turnId: expected[1] });
  expect(details.items.length).toBeGreaterThan(0);
  expect(details.items.every((item) => item.turnId === expected[1])).toBe(true);
  expect(JSON.stringify(details)).toContain('needle-1');
  expect(JSON.stringify(details)).not.toContain('needle-0');
  expect(
    details.items.every((item) => /^\d+$/.test(item.updatedAtOrdinal)),
  ).toBe(true);
  const original: unknown = JSON.parse(JSON.stringify(details));
  details.items[0]!.data.applicationMutation = true;
  expect(await restored.storedItems({ turnId: expected[1] })).toEqual(original);

  const matches: StoredMatch[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;
  for (;;) {
    const found = await restored.searchHistory('NeEdLe', { limit: 1, cursor });
    matches.push(...found.items);
    if (!found.nextCursor) break;
    expect(seen.has(found.nextCursor)).toBe(false);
    seen.add(found.nextCursor);
    cursor = found.nextCursor;
  }
  expect(matches).toHaveLength(3);
  expect(new Set(matches.map((match) => match.turnId))).toEqual(
    new Set(expected),
  );
  for (const match of matches) {
    const { start, end } = match.snippetMatchRange;
    expect(match.snippet.slice(start, end).toLowerCase()).toBe('needle');
    const located = await restored.storedTurns({
      limit: 1,
      cursor: match.turnCursor,
    });
    expect(located.turns[0]!.id).toBe(match.turnId);
  }
  expect(server.requests).toHaveLength(3);
});

it.each([false, true])(
  'reads committed rows during callback/approval pause (approval=%s)',
  async (approval) => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const effects: string[] = [];
    const gate = tool({
      name: 'gate',
      parameters: z.object({}),
      needsApproval: approval,
      execute: async () => {
        entered.resolve();
        await release.promise;
        effects.push('completed');
        return 'finished';
      },
    });
    const storage = await storageFor();
    const server = new ModelServer([
      [call('gate', {}, { callId: 'indexed-gate' })],
      [message('done')],
    ]);
    await using provider = await providerFor(server);
    await using session = await new Agent({
      instructions: 'Use gate.',
      tools: [gate],
      provider,
    }).session({ storage });
    const turn = await session.submit('pending needle');
    let request: FunctionApprovalRequest | undefined;
    try {
      if (approval) request = await nextApproval(session);
      else await entered.promise;
      const page = await session.storedTurns({ includeSummary: true });
      expect(page.turns).toHaveLength(1);
      const current = page.turns[0]!;
      expect(current.status).toBe('in_progress');
      expect(current.summaryItems.length).toBeGreaterThan(0);
      expect(
        (await session.storedItems({ turnId: current.id })).items.length,
      ).toBeGreaterThan(0);
      expect(
        (await session.searchHistory('pending needle')).items.length,
      ).toBeGreaterThan(0);
      expect(effects).toEqual([]);
    } finally {
      release.resolve();
      if (request) await session.respond(request.approve());
    }
    expect((await turn.wait()).finalOutput).toBe('done');
    expect((await session.storedTurns()).turns[0]!.status).toBe('completed');
    expect(effects).toEqual(['completed']);
    expect(server.requests).toHaveLength(2);
  },
);

it('rejects an unsupported index without retiring the ordinary Session', async () => {
  const server = new ModelServer([[message('still usable')]]);
  await using provider = await providerFor(server);
  await using session = await new Agent({
    instructions: 'Answer.',
    provider,
  }).session();
  for (const read of [
    () => session.storedTurns(),
    () => session.storedItems(),
    () => session.searchHistory('x'),
  ])
    await expect(read()).rejects.toThrow(/support/);
  expect(server.requests).toHaveLength(0);
  const turn = await session.submit('continue');
  expect((await turn.wait()).finalOutput).toBe('still usable');
});

it.each([false, true])(
  'joins close before stored revert/delete (delete=%s)',
  async (remove) => {
    const storage = await storageFor();
    const server = new ModelServer(
      [0, 1, 2].map((index) => [message(`stored-${index}`)]),
    );
    await using provider = await providerFor(server);
    const agent = new Agent({ instructions: 'Answer.', provider });
    const session = await agent.session({ storage });
    const identity = session.id;
    let firstId: string;
    try {
      for (let index = 0; index < 3; index++) {
        const turn = await session.submit(`turn-${index}`);
        expect((await turn.wait()).finalOutput).toBe(`stored-${index}`);
      }
      const before = await session.storedTurns();
      expect(before.turns).toHaveLength(3);
      firstId = before.turns[0]!.id;
      if (remove) await session.deleteStored();
      else await session.revertStored({ beforeTurnId: before.turns[1]!.id });
      expect(session.id).toBe(identity);
      await expect(session.deleteStored()).rejects.toThrow(
        /closed|open|settled/i,
      );
    } finally {
      await session.close();
    }
    if (remove) {
      await expect(
        agent.session({ storage, resume: identity }),
      ).rejects.toThrow(/not found|not exist/i);
    } else {
      await using restored = await agent.session({ storage, resume: identity });
      const remaining = await restored.storedTurns();
      expect(remaining.turns.map((turn) => turn.id)).toEqual([firstId]);
      const details = JSON.stringify(await restored.storedItems());
      expect(details).toContain('stored-0');
      expect(details).not.toContain('stored-1');
      expect(details).not.toContain('stored-2');
    }
    expect(server.requests).toHaveLength(3);
  },
);

it('rejects a stored mutation after a concurrent normal close has claimed ownership', async () => {
  const storage = await storageFor();
  const server = new ModelServer([[message('retained')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({ instructions: 'Answer.', provider });
  await using session = await agent.session({ storage });
  const identity = session.id;
  const turn = await session.submit('retain this');
  expect((await turn.wait()).finalOutput).toBe('retained');
  const closing = session.close();
  await expect(session.deleteStored()).rejects.toThrow(/closed|open|settled/i);
  await closing;
  await using restored = await agent.session({ storage, resume: identity });
  expect((await restored.storedTurns()).turns).toHaveLength(1);
  expect(server.requests).toHaveLength(1);
});

it('releases the provider lease after a failed stored revert without another Session close', async () => {
  const storage = await storageFor();
  const server = new ModelServer([[message('retained after rejection')]]);
  await using provider = await providerFor(server);
  const agent = new Agent({ instructions: 'Answer.', provider });
  await using session = await agent.session({ storage });
  const identity = session.id;
  const turn = await session.submit('retain this');
  expect((await turn.wait()).finalOutput).toBe('retained after rejection');
  await expect(
    session.revertStored({ beforeTurnId: 'missing-stored-turn' }),
  ).rejects.toThrow(/turn|bound|not found/i);
  // Provider closure rejects while any Session lease remains. No second close
  // has been intervening between the failed mutation and this cleanup proof.
  await expect(provider.close()).resolves.toBeUndefined();
  await using reopenedProvider = await providerFor(server);
  await using reopened = await new Agent({
    instructions: 'Answer.',
    provider: reopenedProvider,
  }).session({ storage, resume: identity });
  expect((await reopened.storedTurns()).turns).toHaveLength(1);
  expect(server.requests).toHaveLength(1);
});
