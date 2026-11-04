import {
  mkdtemp,
  open,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { Agent } from '../src';
import { loadInstructionFiles } from '../src/runtime/turn-receipt';

vi.mock('node:fs/promises', async (importOriginal) => {
  const fs = await importOriginal<typeof import('node:fs/promises')>();
  return { ...fs, open: vi.fn(fs.open), realpath: vi.fn(fs.realpath) };
});

it.for(['file', 'symlink'] as const)(
  'rejects a replacement %s before reading instructions',
  async (replacement, context) => {
    if (replacement === 'symlink' && process.platform === 'win32') {
      context.skip(
        'Creating symlinks can require special privileges on Windows',
      );
    }
    const fs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const directory = await mkdtemp(
      join(tmpdir(), 'agents-instructions-race-'),
    );
    const path = join(directory, 'selected.md');
    const other = join(directory, 'other.md');
    let opened: Awaited<ReturnType<typeof open>> | undefined;
    try {
      await writeFile(path, 'Selected instructions.');
      await writeFile(other, 'Different instructions.');
      vi.mocked(open).mockImplementationOnce(async (resolved, ...args) => {
        // Use real filesystem operations at the precise boundary before open.
        await rename(resolved, join(directory, 'original.md'));
        if (replacement === 'symlink') await symlink(other, resolved);
        else await rename(other, resolved);
        opened = await fs.open(resolved, ...args);
        vi.spyOn(opened, 'readFile');
        return opened;
      });

      await expect(loadInstructionFiles('', [path])).rejects.toThrow(
        /ELOOP|Instruction file changed/,
      );
      if (opened) {
        expect(opened.readFile).not.toHaveBeenCalled();
        expect(opened.fd).toBe(-1);
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.skipIf(process.platform === 'win32')(
  'loads a stable application-selected symlink and reports its resolved path',
  async () => {
    const directory = await mkdtemp(
      join(tmpdir(), 'agents-instructions-link-'),
    );
    const path = join(directory, 'selected.md');
    const link = join(directory, 'link.md');
    try {
      await writeFile(path, 'Selected instructions.');
      await symlink(path, link);
      const loaded = await loadInstructionFiles('Base instructions.', [link]);
      expect(loaded.instructions).toBe(
        'Base instructions.\n\nSelected instructions.',
      );
      expect(loaded.files).toEqual([
        {
          path: await realpath(path),
          source: 'application_file',
          sha256: expect.stringMatching(/^[a-f0-9]{64}$/),
        },
      ]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('cancels instruction-file loading without resolving any remaining paths', async () => {
  const fs =
    await vi.importActual<typeof import('node:fs/promises')>(
      'node:fs/promises',
    );
  const directory = await mkdtemp(join(tmpdir(), 'agents-instructions-abort-'));
  const first = join(await fs.realpath(directory), 'first.md');
  const remaining = join(directory, 'remaining.md');
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let opened: Awaited<ReturnType<typeof open>> | undefined;
  try {
    await writeFile(first, 'Read this instruction.');
    vi.mocked(open).mockImplementationOnce(async (...args) => {
      const file = await fs.open(...args);
      opened = file;
      const read = file.readFile.bind(file);
      vi.spyOn(file, 'readFile').mockImplementation(async (options) => {
        entered.resolve();
        await release.promise;
        return read(options);
      });
      return file;
    });
    const controller = new AbortController();
    const reason = new Error('Opening cancelled');
    const opening = new Agent({ instructions: 'Answer.' }).session({
      instructionFiles: [first, remaining],
      signal: controller.signal,
    });
    const outcome = opening.catch((error: unknown) => error);
    await entered.promise;
    controller.abort(reason);
    release.resolve();
    expect(await outcome).toBe(reason);
    expect(realpath).not.toHaveBeenCalledWith(remaining);
    expect(opened?.fd).toBe(-1);
  } finally {
    release.resolve();
    await rm(directory, { recursive: true, force: true });
  }
});

it.each(['read error', 'abort reason'] as const)(
  'preserves the %s when closing the instruction file also fails',
  async (kind) => {
    const fs =
      await vi.importActual<typeof import('node:fs/promises')>(
        'node:fs/promises',
      );
    const directory = await mkdtemp(
      join(tmpdir(), 'agents-instructions-close-'),
    );
    const path = join(directory, 'selected.md');
    const controller = new AbortController();
    const readError = new Error('Instruction read failed');
    const abortReason = new Error('Opening cancelled');
    const closeError = new Error('Instruction close failed');
    const primary = kind === 'abort reason' ? abortReason : readError;
    try {
      await writeFile(path, 'Selected instructions.');
      vi.mocked(open).mockImplementationOnce(async (...args) => {
        const file = await fs.open(...args);
        const close = file.close.bind(file);
        vi.spyOn(file, 'readFile').mockImplementationOnce(async () => {
          if (kind === 'abort reason') controller.abort(abortReason);
          throw readError;
        });
        vi.spyOn(file, 'close').mockImplementationOnce(async () => {
          await close();
          throw closeError;
        });
        return file;
      });
      await expect(
        new Agent({ instructions: 'Answer.' }).session({
          instructionFiles: [path],
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        name: 'AggregateError',
        cause: primary,
        errors: [primary, closeError],
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);
