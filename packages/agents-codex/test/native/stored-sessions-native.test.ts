import {
  mkdtemp,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  localStorage,
  tool,
  type FunctionApprovalRequest,
  type Session,
  type StoredSessionPage,
} from '../../src';
import { binding } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function fixture(server: ModelServer) {
  const home = await mkdtemp(join(tmpdir(), 'native-stored-sessions-'));
  homes.push(home);
  const config = await server.config();
  return {
    home,
    storage: localStorage(join(home, 'profile')),
    provider: new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-discovery',
      supportsWebsockets: false,
    }),
  };
}
async function* pages(session: Pick<Session, 'storedSessions'>) {
  let cursor: string | undefined;
  const seen = new Set<string>();
  for (;;) {
    const page = await session.storedSessions({ limit: 1, cursor });
    expect(page.sessions.length).toBeLessThanOrEqual(1);
    yield { cursor, page };
    if (!page.nextCursor) return;
    expect(seen.has(page.nextCursor)).toBe(false);
    seen.add(page.nextCursor);
    cursor = page.nextCursor;
  }
}
it('pages cold application identities and authoritative fork-parent links', async () => {
  const server = new ModelServer([]);
  const { storage, provider } = await fixture(server);
  await using owned = provider;
  const agent = new Agent({ instructions: 'Answer.', provider: owned });
  const source = await agent.session({ storage });
  const sourceId = source.id;
  let forkId: string;
  try {
    forkId = await source.forkStored();
  } finally {
    await source.close();
  }
  const other = await agent.session({ storage });
  const otherId = other.id;
  try {
    await other.storedSessions();
  } finally {
    await other.close();
  }
  await using reader = await agent.session({ storage });
  const records = [];
  for await (const { page } of pages(reader)) records.push(...page.sessions);
  expect(new Set(records.map((item) => item.id))).toEqual(
    new Set([sourceId, forkId, otherId, reader.id]),
  );
  expect(records.find((item) => item.id === forkId)?.forkedFromId).toBe(
    sourceId,
  );
  expect(records.find((item) => item.id === sourceId)?.forkedFromId).toBeNull();
  expect(records.every((item) => item.parentThreadId === null)).toBe(true);
  expect(
    records.every(
      (item) =>
        Number.isSafeInteger(item.createdAtMs) &&
        Number.isSafeInteger(item.updatedAtMs),
    ),
  ).toBe(true);
  const created = records.map((item) => item.createdAtMs);
  expect(created).toEqual([...created].sort((a, b) => a - b));
  expect((await reader.storedSessions({ archived: true })).sessions).toEqual(
    [],
  );
  const first = await reader.storedSessions({ limit: 1 });
  const originalId = first.sessions[0]!.id;
  (first.sessions[0] as { id: string }).id = 'application-change';
  expect((await reader.storedSessions({ limit: 1 })).sessions[0]!.id).toBe(
    originalId,
  );
  await expect(reader.storedSessions({ limit: 0 })).rejects.toThrow('limit');
  await expect(
    reader.storedSessions({ archived: 1 as unknown as boolean }),
  ).rejects.toThrow('archived');
  const invalid = reader.storedSessions({ cursor: 'SYNTHETIC_SECRET_CURSOR' });
  await expect(invalid).rejects.toThrow(/cursor/);
  await expect(invalid).rejects.not.toThrow('SYNTHETIC_SECRET_CURSOR');
  expect(server.requests).toHaveLength(0);
});
it.each([false, true])(
  'reads application metadata during callback/approval pause (%s)',
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
    const server = new ModelServer([
      [call('gate', {}, { callId: 'discovery-gate' })],
      [message('done')],
    ]);
    const { storage, provider } = await fixture(server);
    await using owned = provider;
    await using session = await new Agent({
      instructions: 'Use gate.',
      tools: [gate],
      provider: owned,
    }).session({ storage });
    const turn = await session.submit('hold');
    let request: FunctionApprovalRequest | undefined;
    try {
      if (approval) {
        for await (const event of session.interactions())
          if (isFunctionApprovalRequest(event)) {
            request = event;
            break;
          }
        expect(request).toBeDefined();
      } else await entered.promise;
      expect(
        (await session.storedSessions()).sessions.map((item) => item.id),
      ).toEqual([session.id]);
      expect(effects).toEqual([]);
    } finally {
      release.resolve();
      if (request) await session.respond(request.approve());
    }
    expect((await turn.wait()).finalOutput).toBe('done');
    expect(effects).toEqual(['completed']);
    expect(server.requests).toHaveLength(2);
  },
);
async function rollout(home: string, identity: string): Promise<string> {
  for (const entry of await readdir(home, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const path = join(entry.parentPath, entry.name);
    const header = JSON.parse((await readFile(path, 'utf8')).split('\n')[0]!);
    if (header.type === 'session_meta' && header.payload.id === identity)
      return path;
  }
  throw new Error('Native stored rollout missing');
}
it('rejects malformed headers and skips unavailable entries without refilling or guessing root links', async () => {
  const server = new ModelServer([]);
  const { home, storage, provider } = await fixture(server);
  await using owned = provider;
  const agent = new Agent({ instructions: 'Answer.', provider: owned });
  const source = await agent.session({ storage });
  const sourceId = source.id;
  let forkId: string;
  try {
    forkId = await source.forkStored();
  } finally {
    await source.close();
  }
  await using reader = await agent.session({ storage });
  let selected:
    { cursor: string | undefined; page: StoredSessionPage } | undefined;
  for await (const pair of pages(reader))
    if (pair.page.sessions.some((item) => item.id === forkId)) {
      selected = pair;
      break;
    }
  expect(selected).toBeDefined();
  const { cursor, page: original } = selected!;
  expect(original.sessions[0]!.forkedFromId).toBe(sourceId);
  const path = await rollout(home, forkId);
  const retained = await readFile(path);
  const split = retained.indexOf(10);
  const header = JSON.parse(retained.subarray(0, split).toString('utf8'));
  header.payload.id = 'SYNTHETIC_HEADER_SECRET';
  try {
    await writeFile(
      path,
      Buffer.concat([
        Buffer.from(JSON.stringify(header) + '\n'),
        retained.subarray(split + 1),
      ]),
    );
    const invalid = reader.storedSessions({ limit: 1, cursor });
    await expect(invalid).rejects.toThrow('metadata');
    await expect(invalid).rejects.not.toThrow('SYNTHETIC_HEADER_SECRET');
  } finally {
    await writeFile(path, retained);
  }
  expect(await reader.storedSessions({ limit: 1, cursor })).toEqual(original);
  const hidden = path + '.hidden';
  await rename(path, hidden);
  try {
    const missing = await reader.storedSessions({ limit: 1, cursor });
    expect(missing.sessions).toEqual([]);
    expect(missing.nextCursor).toEqual(original.nextCursor);
  } finally {
    await rename(hidden, path);
  }
  expect(await reader.storedSessions({ limit: 1, cursor })).toEqual(original);
  expect(server.requests).toHaveLength(0);
});
it('rejects an unsupported memory store while preserving ordinary execution', async () => {
  const server = new ModelServer([[message('usable')]]);
  const { provider } = await fixture(server);
  await using owned = provider;
  await using session = await new Agent({
    instructions: 'Answer.',
    provider: owned,
  }).session();
  await expect(session.storedSessions()).rejects.toThrow(
    /unsupported|LocalStorage/,
  );
  expect((await (await session.submit('answer')).wait()).finalOutput).toBe(
    'usable',
  );
  expect(server.requests).toHaveLength(1);
});

it('excludes an unpublished rolled-back fork from a fresh listing', async () => {
  const server = new ModelServer([]);
  const { storage, provider } = await fixture(server);
  await using owned = provider;
  await using source = await new Agent({
    instructions: 'Answer.',
    provider: owned,
  }).session({ storage });
  const addon = await binding();
  const original = addon.NativeThread.prototype._fork_stored;
  let unpublished: string | undefined;
  vi.spyOn(addon.NativeThread.prototype, '_fork_stored').mockImplementationOnce(
    async function (
      this: typeof addon.NativeThread.prototype,
      request: string,
    ) {
      const candidate = await original.call(this, request);
      unpublished = candidate.id;
      throw new Error('synthetic lost fork delivery');
    },
  );
  await expect(source.forkStored()).rejects.toThrow('lost fork delivery');
  expect(unpublished).toBeDefined();
  const ids = new Set<string>();
  for await (const { page } of pages(source))
    for (const item of page.sessions) ids.add(item.id);
  expect(ids.has(source.id)).toBe(true);
  expect(ids.has(unpublished!)).toBe(false);
  expect(server.requests).toHaveLength(0);
});
