import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';

// Prisma 7 does not generate this module during installation. File-backed
// sessions must remain usable before the Prisma example has been prepared.
vi.mock('@prisma/client', () => {
  throw new Error('Prisma client has not been generated');
});

it('uses FileSession through the shared exports without a generated Prisma client', async () => {
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
