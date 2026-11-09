import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import console from 'node:console';
import * as fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import process from 'node:process';
import { clearInterval, setInterval } from 'node:timers';

// Vitest's Rolldown dependency does not support Windows ia32. Run the real
// reader in that runtime without relying on the test runner's native binding.
const [modulePath, target] = process.argv.slice(2);
assert.equal(`${process.platform}/${process.arch}`, target);
assert.ok(modulePath, 'Provide the bundled source reader module');
const reader = createRequire(import.meta.url)(resolve(modulePath));
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
} finally {
  await fs.rm(root, { recursive: true, force: true });
}
