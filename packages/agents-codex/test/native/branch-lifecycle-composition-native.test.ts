import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import {
  Agent,
  NativeProvider,
  localStorage,
  type Session,
  type StoredSession,
} from '../../src';
import { ModelServer, message } from './fixtures/model-server';

async function records(session: Pick<Session, 'storedSessions'>) {
  let cursor: string | undefined;
  const result = new Map<string, StoredSession>();
  do {
    const page = await session.storedSessions({ limit: 1, cursor });
    for (const item of page.sessions) result.set(item.id, item);
    cursor = page.nextCursor ?? undefined;
  } while (cursor !== undefined);
  return result;
}
function family(items: Map<string, StoredSession>, rootId: string) {
  const ids = new Set([rootId]);
  for (;;) {
    const before = ids.size;
    for (const item of items.values())
      if (item.forkedFromId && ids.has(item.forkedFromId)) ids.add(item.id);
    if (ids.size === before) return ids;
  }
}
it('composes branch identity selection, family discovery and leaf deletion', async () => {
  const server = new ModelServer(
    ['root-answer', 'source-only-answer', 'branch-only-answer'].map((text) => [
      message(text),
    ]),
  );
  const home = await mkdtemp(join(tmpdir(), 'native-branch-lifecycle-'));
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-branches',
      supportsWebsockets: false,
    });
    const storage = localStorage(join(home, 'profile'));
    const agent = new Agent({ instructions: 'Answer.', provider });
    let sourceId: string;
    let branchId: string;
    let nestedId: string;
    {
      await using source = await agent.session({ storage });
      sourceId = source.id;
      await (await source.submit('root-prefix-marker')).wait();
      await (await source.submit('source-only-marker')).wait();
      const turns: string[] = [];
      for await (const turn of source.turns()) turns.push(turn.id);
      branchId = await source.forkStored({ beforeTurnId: turns[1]! });
    }
    {
      await using branch = await agent.session({ storage, resume: branchId });
      expect(branch.id).toBe(branchId);
      await (await branch.submit('branch-only-marker')).wait();
      nestedId = await branch.forkStored();
    }
    expect(new Set([sourceId, branchId, nestedId]).size).toBe(3);
    {
      await using reader = await agent.session({ storage });
      const items = await records(reader);
      expect(family(items, sourceId)).toEqual(
        new Set([sourceId, branchId, nestedId]),
      );
      expect(items.get(branchId)?.forkedFromId).toBe(sourceId);
      expect(items.get(nestedId)?.forkedFromId).toBe(branchId);
      expect(family(items, sourceId).has(reader.id)).toBe(false);
    }
    {
      await using source = await agent.session({ storage, resume: sourceId });
      expect(source.id).toBe(sourceId);
      const raw = JSON.stringify((await source.historySnapshot()).items);
      expect(raw).toContain('source-only-marker');
      expect(raw).not.toContain('branch-only-marker');
    }
    for (const identity of [branchId, nestedId]) {
      await using branch = await agent.session({ storage, resume: identity });
      expect(branch.id).toBe(identity);
      const raw = JSON.stringify((await branch.historySnapshot()).items);
      expect(raw).toContain('root-prefix-marker');
      expect(raw).toContain('branch-only-marker');
      expect(raw).not.toContain('source-only-marker');
    }
    {
      await using nested = await agent.session({ storage, resume: nestedId });
      await nested.deleteStored();
    }
    {
      await using reader = await agent.session({ storage });
      const items = await records(reader);
      expect(items.has(nestedId)).toBe(false);
      expect(family(items, sourceId)).toEqual(new Set([sourceId, branchId]));
    }
    await expect(
      agent.session({ storage, resume: nestedId }),
    ).rejects.toThrow();
    {
      await using branch = await agent.session({ storage, resume: branchId });
      await branch.deleteStored();
    }
    {
      await using source = await agent.session({ storage, resume: sourceId });
      const items = await records(source);
      expect(items.has(branchId)).toBe(false);
      expect(items.has(nestedId)).toBe(false);
      expect(items.has(sourceId)).toBe(true);
      const replacementId = await source.forkStored();
      expect(new Set([sourceId, branchId, nestedId]).has(replacementId)).toBe(
        false,
      );
    }
    expect(server.requests).toHaveLength(3);
  } finally {
    await ModelServer.closeAll();
    await rm(home, { recursive: true, force: true });
  }
});
