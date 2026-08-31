import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { execaSync } from 'execa';
import { afterEach, test } from 'vitest';
import {
  BOOTSTRAP_INSTALL_ARGS,
  bootstrapInstallTarget,
} from './pnpm-bootstrap.mjs';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

test('installs with plain pnpm off Windows', () => {
  const target = bootstrapInstallTarget('linux', {});
  assert.equal(target.command, 'pnpm');
  assert.deepEqual(target.args, BOOTSTRAP_INSTALL_ARGS);
  assert.deepEqual(target.options, {});
});

test('installs through cmd.exe on Windows because Node will not spawn a .cmd', () => {
  const target = bootstrapInstallTarget('win32', {});
  assert.equal(target.command, 'cmd.exe');
  assert.deepEqual(target.args, [
    '/d',
    '/s',
    '/c',
    '"pnpm.cmd i --frozen-lockfile"',
  ]);
  assert.equal(target.options.windowsVerbatimArguments, true);
});

test('honors ComSpec when the environment sets it', () => {
  const target = bootstrapInstallTarget('win32', {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  });
  assert.equal(target.command, 'C:\\Windows\\System32\\cmd.exe');
});

test('bootstrap command line carries no caller-supplied input', () => {
  // The whole point of the fixed line is that nothing needs quoting. If an argument ever
  // becomes dynamic, this fails and the step has to move to Execa instead.
  const [, , , commandLine] = bootstrapInstallTarget('win32', {}).args;
  assert.equal(commandLine, '"pnpm.cmd i --frozen-lockfile"');
  assert.deepEqual(BOOTSTRAP_INSTALL_ARGS, ['i', '--frozen-lockfile']);
});

// Everything after install goes through Execa. These names are legal on Windows and are
// the ones prettier-changed.mjs forwards from `git diff`, so they must survive intact.
test.skipIf(process.platform !== 'win32')(
  'Execa passes awkward file names through a .cmd shim unchanged',
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'pnpm-bootstrap-'));
    tempDirs.push(dir);
    const printer = join(dir, 'print-argv.mjs');
    await writeFile(
      printer,
      'console.log(JSON.stringify(process.argv.slice(2)));\n',
    );
    await writeFile(join(dir, 'shim.cmd'), `@node "${printer}" %*\n`);

    const names = [
      'packages/a/src/build%PATH%.ts',
      'packages/a/src/50%done.ts',
      'packages/a/src/my file.ts',
      'packages/a/src/a&b.ts',
      'pnpm -r -F "@openai/*" dist:check',
    ];
    const result = execaSync('shim.cmd', names, {
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
      extendEnv: false,
      reject: false,
    });

    assert.equal(result.exitCode, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), names);
  },
);
