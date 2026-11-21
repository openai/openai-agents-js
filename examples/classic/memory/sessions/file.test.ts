import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import type { AgentInputItem } from '@openai/agents/classic';
import { FileSession } from './file';

const userItem = (content: string) =>
  ({ role: 'user', content }) as AgentInputItem;

async function withSessionFile<T>(
  items: unknown[],
  fn: (args: {
    dir: string;
    sessionId: string;
    session: FileSession;
    file: string;
  }) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'agents-file-session-'));
  const sessionId = 's1';
  const file = join(dir, `${sessionId}.json`);
  await writeFile(file, JSON.stringify(items), 'utf8');
  const session = new FileSession({ dir, sessionId });
  try {
    return await fn({ dir, sessionId, session, file });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('FileSession', () => {
  it('rejects session IDs that can select paths outside the session directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agents-file-session-'));
    const dir = join(root, 'sessions');
    const outsideFile = join(root, 'outside.json');
    const outsideData = JSON.stringify([userItem('outside')]);
    await writeFile(outsideFile, outsideData, 'utf8');

    try {
      for (const sessionId of [
        '../outside',
        '..\\outside',
        'outside:alternate',
        '.',
        '..',
      ]) {
        expect(() => new FileSession({ dir, sessionId })).toThrow(
          'Invalid session ID',
        );
      }

      expect(await readFile(outsideFile, 'utf8')).toBe(outsideData);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('creates and reopens a generated session ID', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agents-file-session-'));
    try {
      const session = new FileSession({ dir });
      const sessionId = await session.getSessionId();
      await session.addItems([userItem('saved')]);

      const reopened = new FileSession({ dir, sessionId });
      expect(
        (await reopened.getItems()).map((item) => (item as any).content),
      ).toEqual(['saved']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('skips corrupt records when reading items', async () => {
    await withSessionFile(
      [userItem('valid'), 'not valid json {{{'],
      async ({ session }) => {
        const items = await session.getItems();

        expect(items.map((item) => (item as any).content)).toEqual(['valid']);
      },
    );
  });

  it('skips corrupt most-recent records when popping items', async () => {
    await withSessionFile(
      [userItem('valid'), 'not valid json {{{'],
      async ({ session, file }) => {
        const popped = await session.popItem();

        expect((popped as any)?.content).toBe('valid');
        expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
      },
    );
  });

  it('drops every corrupt record before returning undefined', async () => {
    await withSessionFile(['garbage', 42], async ({ session, file }) => {
      await expect(session.popItem()).resolves.toBeUndefined();
      expect(JSON.parse(await readFile(file, 'utf8'))).toEqual([]);
    });
  });
});
