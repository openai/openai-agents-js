import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

vi.mock('node:sqlite', () => {
  throw new Error('FileSession should not load node:sqlite');
});

it('uses FileSession through the shared exports without loading SQLite', async () => {
  const { FileSession } = await import('./index');
  const directory = await mkdtemp(join(tmpdir(), 'agents-file-import-'));
  try {
    const session = new FileSession({ dir: directory, sessionId: 'file' });
    const items = [{ role: 'user' as const, content: 'File-backed history' }];
    await session.addItems(items);
    expect(await session.getItems()).toEqual(items);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
