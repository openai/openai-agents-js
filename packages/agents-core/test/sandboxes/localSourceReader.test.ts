import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

test('retains both directory names and file authority across ancestor replacement', async () => {
  const { root, parent, source, outside } = await fixture();
  const directory = await openLocalSourceDirectory(source);
  try {
    await rename(parent, join(root, 'saved'));
    await symlink(
      outside,
      parent,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
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
  'preserves search-only ancestor permissions',
  async () => {
    const { parent, source } = await fixture();
    await chmod(parent, 0o111);
    try {
      expect(
        Buffer.from(
          await readLocalSourceFile(join(source, 'input.txt')),
        ).toString(),
      ).toBe('SAFE');
      expect(await readFile(join(source, 'input.txt'), 'utf8')).toBe('SAFE');
    } finally {
      await chmod(parent, 0o700);
    }
  },
);
