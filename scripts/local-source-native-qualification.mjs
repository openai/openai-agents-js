import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval, setTimeout } from 'node:timers';

// Vitest's Rolldown dependency does not support Windows ia32. Run the real
// reader in that runtime without relying on the test runner's native binding.
const [modulePath, target, nativeCallPath] = process.argv.slice(2);
assert.equal(`${process.platform}/${process.arch}`, target);
assert.ok(modulePath, 'Provide the bundled source reader module');
assert.ok(nativeCallPath, 'Provide the bundled native call module');
assert.equal(
  typeof globalThis.gc,
  'function',
  'Run qualification with --expose-gc',
);
const require = createRequire(import.meta.url);
const reader = require(resolve(modulePath));
const { callLocalSourceNative } = require(resolve(nativeCallPath));
const koffi = require('koffi');
const root = await fs.mkdtemp(join(tmpdir(), 'agents-native-source-'));

try {
  const source = join(root, 'source');
  const saved = join(root, 'saved');
  const outside = join(root, 'outside');
  await fs.mkdir(join(source, 'nested'), { recursive: true });
  await fs.mkdir(outside);
  await fs.writeFile(join(source, 'input'), 'SAFE');
  await fs.writeFile(join(source, 'nested', 'deep'), 'DEEP');
  await fs.writeFile(join(outside, 'input'), 'OUTSIDE');
  await fs.writeFile(join(outside, 'outside-only'), 'SECRET');
  await fs.utimes(join(source, 'input'), 2_200_000_000, 2_200_000_000);
  assert.equal(
    Buffer.from(
      await reader.readLocalSourceFile(join(source, 'input')),
    ).toString(),
    'SAFE',
  );
  const ordinary = [];
  for await (const entry of reader.readLocalSourceDirectory(source)) {
    ordinary.push(
      entry.type === 'file'
        ? [entry.path, Buffer.from(entry.content).toString()]
        : [entry.path],
    );
  }
  assert.deepEqual(
    ordinary.sort((left, right) => left[0].localeCompare(right[0])),
    [[''], ['input', 'SAFE'], ['nested'], ['nested/deep', 'DEEP']],
  );

  const directory = await reader.openLocalSourceDirectory(source);
  try {
    // Windows permits moving the held directory itself before opening children.
    // An ordinary pathname read must see the replacement to prove the attack.
    await fs.rename(source, saved);
    await fs.symlink(
      outside,
      source,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    assert.equal(await fs.readFile(join(source, 'input'), 'utf8'), 'OUTSIDE');
    assert.equal(
      Buffer.from(await directory.readFile('input')).toString(),
      'SAFE',
    );
    assert.deepEqual(
      (await directory.entries()).map((entry) => entry.name).sort(),
      ['input', 'nested'],
    );
    const nested = await directory.openDirectory('nested');
    try {
      assert.equal(
        Buffer.from(await nested.readFile('deep')).toString(),
        'DEEP',
      );
    } finally {
      await nested.close();
    }
    await assert.rejects(
      reader.readLocalSourceFile(join(source, 'input')),
      /symbolic link ancestors/,
    );
    await assert.rejects(reader.openLocalSourceDirectory(source));
    await fs.symlink(join(outside, 'input'), join(saved, 'linked'), 'file');
    await assert.rejects(directory.readFile('linked'));
    await fs.symlink(
      outside,
      join(saved, 'dirlink'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await assert.rejects(directory.openDirectory('dirlink'));
    await assert.rejects(directory.readFile('nested'));
    for (const name of [
      '..',
      '.',
      '../input',
      '/input',
      'a/b',
      'a\\b',
      'x\0y',
    ]) {
      await assert.rejects(directory.readFile(name));
    }

    const bytes = Buffer.alloc(16 * 1024 * 1024, 0x61);
    await fs.writeFile(join(saved, 'large-a'), bytes);
    await fs.writeFile(join(saved, 'large-b'), bytes);
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    try {
      const pending = Promise.allSettled([
        directory.readFile('large-a'),
        directory.readFile('large-b'),
      ]);
      await directory.close();
      for (const result of await pending) {
        if (result.status === 'rejected') throw result.reason;
        assert.equal(Buffer.compare(Buffer.from(result.value), bytes), 0);
      }
      assert.ok(ticks > 0, 'Concurrent reads must yield to the event loop');
      await assert.rejects(directory.readFile('input'));
    } finally {
      clearInterval(timer);
    }
    console.log(
      JSON.stringify({
        target,
        node: process.versions.node,
        ordinary: 'SAFE',
        pathnameReplacement: 'OUTSIDE',
        retained: 'SAFE',
        nested: 'DEEP',
        symlinksRejected: true,
        namesValidated: true,
        closeJoined: true,
        eventLoopTicks: ticks,
      }),
    );
  } finally {
    await directory.close();
  }

  // A real blocked native call must not delay the app's timer. Throughput on a
  // fast filesystem alone cannot establish this property for slow storage.
  const windows = process.platform === 'win32';
  const library = koffi.load(
    windows
      ? 'kernel32.dll'
      : process.platform === 'darwin'
        ? '/usr/lib/libSystem.B.dylib'
        : null,
  );
  const delay = library.func(
    windows
      ? 'void __stdcall Sleep(uint32_t milliseconds)'
      : 'int usleep(unsigned int microseconds)',
  );
  let completed = false;
  const delayed = callLocalSourceNative(delay, [windows ? 500 : 500_000]).then(
    () => {
      completed = true;
    },
  );
  void delayed.catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, 50));
  const completedBeforeTimer = completed;
  await delayed;
  assert.equal(completedBeforeTimer, false);

  const size = 64 * 1024 * 1024;
  const large = join(root, 'known-size');
  const file = await fs.open(large, 'wx');
  await file.truncate(size);
  await file.close();
  globalThis.gc();
  globalThis.gc();
  const before = process.memoryUsage().arrayBuffers;
  const data = await reader.readLocalSourceFile(large);
  const allocated = process.memoryUsage().arrayBuffers - before;
  assert.equal(data.length, size);
  assert.equal(data[0], 0);
  assert.equal(data[size - 1], 0);
  assert.ok(
    allocated <= size + 4 * 1024 * 1024,
    `Static file allocated ${allocated} bytes`,
  );

  const deep = join(root, 'deep');
  await fs.mkdir(deep);
  let leaf = deep;
  for (let level = 0; level < 64; level++) {
    leaf = join(leaf, 'd');
    await fs.mkdir(leaf);
  }
  await fs.writeFile(join(leaf, 'leaf'), 'SAFE');
  let directories = 0;
  let files = 0;
  for await (const entry of reader.readLocalSourceDirectory(deep)) {
    if (entry.type === 'dir') directories++;
    else {
      assert.equal(Buffer.from(entry.content).toString(), 'SAFE');
      files++;
    }
  }
  assert.equal(directories, 65);
  assert.equal(files, 1);
  console.log(
    JSON.stringify({
      target,
      nativeDelayOffThread: true,
      knownSizeBytes: size,
      allocatedBytes: allocated,
      directoryDepth: 64,
    }),
  );
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
