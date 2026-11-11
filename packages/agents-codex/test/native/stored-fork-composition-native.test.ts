import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { Agent, NativeProvider, localStorage, type Session } from '../../src';
import { ModelServer, message } from './fixtures/model-server';

async function earliestUserTurn(
  session: Pick<Session, 'searchHistory' | 'storedItems'>,
  text: string,
): Promise<string> {
  let cursor: string | undefined;
  for (;;) {
    const matches = await session.searchHistory(text, { limit: 1, cursor });
    for (const match of matches.items) {
      let itemCursor: string | undefined;
      for (;;) {
        const details = await session.storedItems({
          turnId: match.turnId,
          limit: 1,
          cursor: itemCursor,
        });
        const selected = details.items.find((item) => item.id === match.itemId);
        if (selected) {
          if (selected.data.type === 'userMessage') return match.turnId;
          break;
        }
        if (!details.nextCursor)
          throw new Error('Indexed match no longer has its selected item');
        itemCursor = details.nextCursor;
      }
    }
    if (!matches.nextCursor) throw new Error('No matching user turn');
    cursor = matches.nextCursor;
  }
}

it('composes earliest user-only content selection with source-bound native fork validation', async () => {
  const server = new ModelServer(
    ['needle assistant-only', 'reply-two', 'reply-three'].map((text) => [
      message(text),
    ]),
  );
  const home = await mkdtemp(join(tmpdir(), 'native-fork-composition-'));
  try {
    const config = await server.config();
    await using provider = new NativeProvider({
      baseUrl: (config['model_providers.fixture'] as { base_url: string })
        .base_url,
      apiKey: 'synthetic-content',
      supportsWebsockets: false,
    });
    const storage = localStorage(join(home, 'profile'));
    const agent = new Agent({ instructions: 'Answer.', provider });
    const source = await agent.session({ storage });
    const turns: string[] = [];
    let forkId: string;
    try {
      for (const text of [
        'unrelated-first',
        'needle earliest-user',
        'needle repeated-user',
      ])
        await (await source.submit(text)).wait();
      for await (const turn of source.turns()) turns.push(turn.id);
      const before = await source.historySnapshot();
      for (const text of ['assistant-only', 'never-present']) {
        await expect(earliestUserTurn(source, text)).rejects.toThrow(
          'No matching user',
        );
        expect(await source.historySnapshot()).toEqual(before);
      }
      const selected = await earliestUserTurn(source, 'needle');
      expect(selected).toBe(turns[1]);
      {
        await using other = await agent.session({ storage });
        await expect(
          other.forkStored({ beforeTurnId: selected }),
        ).rejects.toThrow();
      }
      forkId = await source.forkStored({ beforeTurnId: selected });
      expect(await source.historySnapshot()).toEqual(before);
    } finally {
      await source.close();
    }
    await using branch = await agent.session({ storage, resume: forkId });
    expect((await branch.storedTurns()).turns.map((turn) => turn.id)).toEqual(
      turns.slice(0, 1),
    );
    const raw = JSON.stringify((await branch.historySnapshot()).items);
    expect(raw).toContain('unrelated-first');
    expect(raw).toContain('needle assistant-only');
    expect(raw).not.toContain('earliest-user');
    expect(raw).not.toContain('repeated-user');
    expect(server.requests).toHaveLength(3);
  } finally {
    await ModelServer.closeAll();
    await rm(home, { recursive: true, force: true });
  }
});
