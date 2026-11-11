import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  NativeProvider,
  isFunctionApprovalRequest,
  localStorage,
  fileSessionStore,
  type SessionStore,
  tool,
  type Session,
} from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';
const homes: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await ModelServer.closeAll();
  await Promise.all(
    homes.splice(0).map((home) => rm(home, { recursive: true, force: true })),
  );
});
async function setup(server: ModelServer) {
  const home = await mkdtemp(join(tmpdir(), 'native-stored-labels-'));
  homes.push(home);
  const config = await server.config();
  return {
    storage: localStorage(join(home, 'profile')),
    provider: new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-labels',
      supportsWebsockets: false,
    }),
  };
}
async function names(session: Pick<Session, 'storedSessions'>) {
  const result = new Map<string, string | null>();
  let cursor: string | undefined;
  do {
    const page = await session.storedSessions({ limit: 1, cursor });
    for (const item of page.sessions) result.set(item.id, item.name);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return result;
}
it('persists fresh labels and clearing with immutable identities and independent siblings', async () => {
  const server = new ModelServer([]);
  const f = await setup(server);
  await using provider = f.provider;
  const agent = new Agent({ instructions: 'Answer.', provider });
  let sourceId: string;
  let branchId: string;
  {
    await using source = await agent.session({ storage: f.storage });
    sourceId = source.id;
    expect(await source.setStoredName('  Alpha 😀  ')).toBe('Alpha 😀');
    expect(source.id).toBe(sourceId);
    expect((await names(source)).get(sourceId)).toBe('Alpha 😀');
    await expect(source.setStoredName(' \n ')).rejects.toThrow('empty');
    await expect(source.setStoredName(undefined as never)).rejects.toThrow(
      TypeError,
    );
    expect((await names(source)).get(sourceId)).toBe('Alpha 😀');
    branchId = await source.forkStored();
  }
  {
    await using branch = await agent.session({
      storage: f.storage,
      resume: branchId,
    });
    expect(await branch.setStoredName('Beta')).toBe('Beta');
    expect(branch.id).toBe(branchId);
    const labels = await names(branch);
    expect(labels.get(sourceId)).toBe('Alpha 😀');
    expect(labels.get(branchId)).toBe('Beta');
  }
  {
    await using source = await agent.session({
      storage: f.storage,
      resume: sourceId,
    });
    expect((await names(source)).get(sourceId)).toBe('Alpha 😀');
    expect(await source.setStoredName(null)).toBeNull();
    expect(source.id).toBe(sourceId);
  }
  {
    await using source = await agent.session({
      storage: f.storage,
      resume: sourceId,
    });
    const labels = await names(source);
    expect(labels.get(sourceId)).toBeNull();
    expect(labels.get(branchId)).toBe('Beta');
  }
  expect(server.requests).toHaveLength(0);
});
for (const approval of [false, true])
  it(`names an active owner without releasing its held tool (approval=${approval})`, async () => {
    let entered = false;
    let effects = 0;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const gate = tool({
      name: 'gate',
      description: 'Held synthetic label control.',
      parameters: z.object({}),
      needsApproval: approval,
      execute: async () => {
        entered = true;
        await held;
        effects++;
        return 'done';
      },
    });
    const server = new ModelServer([
      [call('gate', {}, { callId: 'label-gate' })],
      [message('done')],
    ]);
    const f = await setup(server);
    await using provider = f.provider;
    const agent = new Agent({
      instructions: 'Use gate.',
      tools: [gate],
      provider,
    });
    await using session = await agent.session({ storage: f.storage });
    const turn = await session.submit('hold');
    let pending:
      Awaited<ReturnType<Session['pendingInteractions']>>[number] | undefined;
    try {
      if (approval) {
        await vi.waitFor(async () => {
          pending = (await session.pendingInteractions()).find((item) =>
            isFunctionApprovalRequest(item),
          );
          expect(pending).toBeDefined();
        });
      } else await vi.waitFor(() => expect(entered).toBe(true));
      expect(await session.setStoredName('During hold')).toBe('During hold');
      expect((await names(session)).get(session.id)).toBe('During hold');
      expect(effects).toBe(0);
      expect(entered).toBe(!approval);
    } finally {
      release();
      if (pending && isFunctionApprovalRequest(pending))
        await session.respond(pending.approve());
    }
    await turn.wait();
    expect(effects).toBe(1);
    expect(server.requests).toHaveLength(2);
  });
it('rejects unsupported storage while preserving ordinary execution', async () => {
  const server = new ModelServer([[message('still usable')]]);
  const f = await setup(server);
  await using provider = f.provider;
  const agent = new Agent({ instructions: 'Answer.', provider });
  await using session = await agent.session();
  const id = session.id;
  await expect(session.setStoredName('Rejected')).rejects.toThrow(
    'LocalStorage',
  );
  expect(session.id).toBe(id);
  expect((await (await session.submit('hello')).wait()).finalOutput).toBe(
    'still usable',
  );
  expect(server.requests).toHaveLength(1);
});

it('rejects a CustomStorage name without calling the selected backend', async () => {
  const server = new ModelServer([[message('custom store usable')]]);
  const f = await setup(server);
  await using provider = f.provider;
  const home = await mkdtemp(join(tmpdir(), 'native-custom-label-'));
  homes.push(home);
  const backend = fileSessionStore(home) as Required<SessionStore>;
  const callbacks = [
    vi.spyOn(backend, 'acquire'),
    vi.spyOn(backend, 'read'),
    vi.spyOn(backend, 'commit'),
    vi.spyOn(backend, 'flush'),
    vi.spyOn(backend, 'release'),
  ];
  const agent = new Agent({ instructions: 'Answer.', provider });
  await using session = await agent.session({ storage: backend });
  const identity = session.id;
  const before = await session.historySnapshot();
  const counts = callbacks.map((callback) => callback.mock.calls.length);
  await expect(session.setStoredName('Rejected')).rejects.toThrow(
    'LocalStorage',
  );
  expect(callbacks.map((callback) => callback.mock.calls.length)).toEqual(
    counts,
  );
  expect(server.requests).toHaveLength(0);
  expect(session.id).toBe(identity);
  expect(await session.historySnapshot()).toEqual(before);
  expect((await (await session.submit('hello')).wait()).finalOutput).toBe(
    'custom store usable',
  );
  expect(server.requests).toHaveLength(1);
});
