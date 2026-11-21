import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
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
  await writeFile(file, JSON.stringify(items), {
    encoding: 'utf8',
    mode: 0o600,
  });
  const session = new FileSession({ dir, sessionId });
  try {
    return await fn({ dir, sessionId, session, file });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe('FileSession', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps a new directory and session file private under a 022 umask',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agents-file-session-'));
      const previousUmask = process.umask(0o022);
      try {
        await chmod(root, 0o755);
        const dir = join(root, 'sessions');
        const session = new FileSession({ dir });
        const sessionId = await session.getSessionId();
        const file = join(dir, `${sessionId}.json`);

        expect((await stat(dir)).mode & 0o777).toBe(0o700);
        expect((await stat(file)).mode & 0o777).toBe(0o600);
        await session.addItems([userItem('private history')]);
        expect((await stat(file)).mode & 0o777).toBe(0o600);

        const reopened = new FileSession({ dir, sessionId });
        expect(await reopened.getItems()).toEqual([
          userItem('private history'),
        ]);
      } finally {
        process.umask(previousUmask);
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'reads and clears existing owner-only read-only history',
    async () => {
      const dir = await mkdtemp(join(tmpdir(), 'agents-file-session-'));
      const file = join(dir, 'readonly.json');
      try {
        await writeFile(file, JSON.stringify([userItem('saved')]), {
          mode: 0o600,
        });
        await chmod(file, 0o400);
        const session = new FileSession({ dir, sessionId: 'readonly' });
        expect(await session.getSessionId()).toBe('readonly');
        expect(await session.getItems()).toEqual([userItem('saved')]);
        await session.clearSession();
        await expect(stat(file)).rejects.toMatchObject({ code: 'ENOENT' });
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a permissive or symlinked storage directory',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agents-file-session-'));
      try {
        const dir = join(root, 'sessions');
        await mkdir(dir, { mode: 0o755 });
        await chmod(dir, 0o755);
        await expect(new FileSession({ dir }).getSessionId()).rejects.toThrow(
          /owner-only/,
        );

        await chmod(dir, 0o700);
        const link = join(root, 'linked-sessions');
        await symlink(dir, link, 'dir');
        await expect(
          new FileSession({ dir: link }).getSessionId(),
        ).rejects.toThrow(/owner-only/);
        await expect(
          new FileSession({ dir: `${link}/` }).getSessionId(),
        ).rejects.toThrow(/owner-only/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects an existing symlink or permissive session file',
    async () => {
      const root = await mkdtemp(join(tmpdir(), 'agents-file-session-'));
      try {
        const dir = join(root, 'sessions');
        await mkdir(dir, { mode: 0o700 });
        const outside = join(root, 'outside.json');
        const file = join(dir, 's1.json');
        await writeFile(outside, '[]', { mode: 0o600 });
        await symlink(outside, file);
        await expect(
          new FileSession({ dir, sessionId: 's1' }).getSessionId(),
        ).rejects.toThrow();
        expect(await readFile(outside, 'utf8')).toBe('[]');

        await rm(file);
        await writeFile(file, '[]', { mode: 0o644 });
        await chmod(file, 0o644);
        await expect(
          new FileSession({ dir, sessionId: 's1' }).getSessionId(),
        ).rejects.toThrow(/owner-only/);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    },
  );

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
