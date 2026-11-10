import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { release, tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, test } from 'vitest';
import {
  openLocalSourceDirectory,
  readLocalSourceDirectory,
  readLocalSourceFile,
} from '../../src/sandbox/shared/localSourceReader';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0))
    await rm(root, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'agents-source-reader-'));
  roots.push(root);
  const parent = join(root, 'parent');
  const source = join(parent, 'source');
  const outside = join(root, 'outside');
  await mkdir(source, { recursive: true });
  await mkdir(join(outside, 'source'), { recursive: true });
  await writeFile(join(source, 'input.txt'), 'SAFE');
  await writeFile(join(outside, 'source', 'input.txt'), 'OUTSIDE');
  await writeFile(join(outside, 'source', 'outside-only.txt'), 'SECRET');
  return { root, parent, source, outside };
}

test('enumerates every name across multiple native directory pages', async () => {
  const { source } = await fixture();
  const names = Array.from(
    { length: 600 },
    (_, index) => `${String(index).padStart(4, '0')}-${'x'.repeat(123)}`,
  );
  for (let offset = 0; offset < names.length; offset += 16) {
    await Promise.all(
      names
        .slice(offset, offset + 16)
        .map((name) => writeFile(join(source, name), '')),
    );
  }
  const directory = await openLocalSourceDirectory(source);
  try {
    expect(
      (await directory.entries()).map((entry) => entry.name).sort(),
    ).toEqual([...names, 'input.txt'].sort());
    expect(
      (await directory.entries()).map((entry) => entry.name).sort(),
    ).toEqual([...names, 'input.txt'].sort());
  } finally {
    await directory.close();
  }
}, 30_000);

test.skipIf(process.platform !== 'linux')(
  'reads a regular pseudo-file that rejects SEEK_END',
  async () => {
    expect(
      Buffer.from(await readLocalSourceFile('/proc/cpuinfo')).toString(),
    ).toContain('processor');
  },
);

test('reads ordinary files and nested directories through the host tmpdir', async () => {
  const { source } = await fixture();
  await mkdir(join(source, 'nested'));
  await writeFile(join(source, 'nested', 'deep.txt'), 'DEEP');
  expect(
    Buffer.from(
      await readLocalSourceFile(join(source, 'input.txt')),
    ).toString(),
  ).toBe('SAFE');
  const contents = [];
  for await (const item of readLocalSourceDirectory(source)) {
    contents.push(
      item.type === 'file'
        ? [item.path, Buffer.from(item.content).toString()]
        : [item.path],
    );
  }
  expect(contents).toEqual(
    expect.arrayContaining([
      [''],
      ['input.txt', 'SAFE'],
      ['nested'],
      ['nested/deep.txt', 'DEEP'],
    ]),
  );
});

// Some 32-bit Node builds cannot create this timestamp with fs.utimes. The
// cross-CPU qualification supplies a precreated future-timestamp file instead.
test.skipIf(
  process.platform === 'linux' &&
    (process.arch === 'arm' || process.arch === 'ia32'),
)('reads regular files with timestamps beyond 2038', async () => {
  const { source } = await fixture();
  const file = join(source, 'input.txt');
  await utimes(file, 2_200_000_000, 2_200_000_000);
  expect(Buffer.from(await readLocalSourceFile(file)).toString()).toBe('SAFE');
});

test('retains both directory names and file authority across ancestor replacement', async () => {
  const { root, parent, source, outside } = await fixture();
  const directory = await openLocalSourceDirectory(source);
  try {
    // Windows blocks renaming an ancestor with an open descendant. Move the
    // held directory itself, which is still the ancestor of every source file.
    const replaced = process.platform === 'win32' ? source : parent;
    await rename(replaced, join(root, 'saved'));
    await symlink(
      process.platform === 'win32' ? join(outside, 'source') : outside,
      replaced,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    expect(await readFile(join(source, 'input.txt'), 'utf8')).toBe('OUTSIDE');
    expect((await directory.entries()).map((entry) => entry.name)).toEqual([
      'input.txt',
    ]);
    expect(Buffer.from(await directory.readFile('input.txt')).toString()).toBe(
      'SAFE',
    );
    await expect(
      readLocalSourceFile(join(source, 'input.txt')),
    ).rejects.toThrow(/symbolic link ancestors/);
  } finally {
    await directory.close();
  }
});

test('rejects multi-component child names before filesystem access', async () => {
  const { source } = await fixture();
  const directory = await openLocalSourceDirectory(source);
  try {
    for (const name of [
      '..',
      '.',
      '../outside/source/input.txt',
      '/input.txt',
      'x\0y',
    ]) {
      await expect(
        Promise.resolve().then(() => directory.readFile(name)),
      ).rejects.toThrow();
    }
  } finally {
    await directory.close();
  }
});

test.skipIf(process.platform === 'win32')(
  'rejects final file symlinks through both source reader entry points',
  async () => {
    const { source, outside } = await fixture();
    const path = join(source, 'input.txt');
    await rm(path);
    await symlink(join(outside, 'source', 'input.txt'), path);
    await expect(readLocalSourceFile(path)).rejects.toThrow(/symbolic link/);
    const directory = await openLocalSourceDirectory(source);
    try {
      await expect(directory.readFile('input.txt')).rejects.toThrow(
        /symbolic link/,
      );
    } finally {
      await directory.close();
    }
  },
);

test('rejects final directory symlinks or junctions', async () => {
  const { parent, outside } = await fixture();
  const path = join(parent, 'linked');
  await symlink(
    join(outside, 'source'),
    path,
    process.platform === 'win32' ? 'junction' : 'dir',
  );
  await expect(openLocalSourceDirectory(path)).rejects.toThrow(/symbolic link/);
});

test('closing a directory preserves already-started concurrent file reads', async () => {
  const { source } = await fixture();
  const body = Buffer.alloc(4 * 1024 * 1024, 0x61);
  await writeFile(join(source, 'a.bin'), body);
  await writeFile(join(source, 'b.bin'), body);
  const directory = await openLocalSourceDirectory(source);
  let ticks = 0;
  const timer = setInterval(() => ticks++, 0);
  try {
    const first = directory.readFile('a.bin');
    const second = directory.readFile('b.bin');
    await directory.close();
    const contents = await Promise.all([first, second]);
    expect(
      contents.map((content) => Buffer.compare(Buffer.from(content), body)),
    ).toEqual([0, 0]);
    expect(ticks).toBeGreaterThan(0);
    await expect(directory.readFile('a.bin')).rejects.toThrow();
  } finally {
    clearInterval(timer);
    await directory.close();
  }
});

test.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
  'preserves search-only traversal where the kernel supports retaining it',
  async () => {
    const { parent, source } = await fixture();
    await chmod(parent, 0o111);
    try {
      if (
        process.platform === 'darwin' &&
        Number(release().split('.')[0]) < 22
      ) {
        // macOS 11/12 lack O_SEARCH and need readable source ancestors.
        await expect(
          readLocalSourceFile(join(source, 'input.txt')),
        ).rejects.toMatchObject({ code: 'EACCES' });
      } else {
        expect(
          Buffer.from(
            await readLocalSourceFile(join(source, 'input.txt')),
          ).toString(),
        ).toBe('SAFE');
      }
      expect(await readFile(join(source, 'input.txt'), 'utf8')).toBe('SAFE');
    } finally {
      await chmod(parent, 0o700);
    }
  },
);
