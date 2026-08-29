import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import process from 'node:process';
import { afterEach, test } from 'vitest';
import {
  buildWindowsCommandLine,
  pnpmSpawnTarget,
  quoteWindowsArgument,
} from './pnpm-spawn.mjs';

const tempDirs = [];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

// The argument that made the obvious `shell: true` fix unusable: it carries spaces and
// quotes, so an unquoted join splits it into five arguments.
const NESTED_COMMAND = 'pnpm -r -F "@openai/*" dist:check';

// A file name shaped to close the quoted region and run a second command. pnpm.cmd is a
// batch shim that forwards %*, so one layer of caret escaping is consumed before the
// shim re-parses and this executes.
const INJECTION = 'evil".ts"&whoami&"';

test('leaves the invocation alone off Windows', () => {
  const target = pnpmSpawnTarget(['i', '--frozen-lockfile'], 'linux', {});
  assert.equal(target.command, 'pnpm');
  assert.deepEqual(target.args, ['i', '--frozen-lockfile']);
  assert.deepEqual(target.options, {});
});

test('routes through cmd.exe verbatim on Windows', () => {
  const target = pnpmSpawnTarget(['i', '--frozen-lockfile'], 'win32', {});
  assert.equal(target.command, 'cmd.exe');
  assert.deepEqual(target.args.slice(0, 3), ['/d', '/s', '/c']);
  assert.equal(target.options.windowsVerbatimArguments, true);
});

test('honors ComSpec when the environment sets it', () => {
  const target = pnpmSpawnTarget(['build'], 'win32', {
    ComSpec: 'C:\\Windows\\System32\\cmd.exe',
  });
  assert.equal(target.command, 'C:\\Windows\\System32\\cmd.exe');
});

test('never spawns the .cmd shim directly on Windows', () => {
  // Node has refused to spawn .cmd without a shell since 20.12.2, so handing the shim
  // to spawnSync as the command is exactly the defect being fixed.
  const target = pnpmSpawnTarget(['i'], 'win32', {});
  assert.ok(!target.command.toLowerCase().endsWith('pnpm.cmd'));
});

test('leaves the command token unquoted so %~dp0 resolves in the shim', () => {
  // cmd.exe sets %0 from the token it is given. Quoting a bare name makes %~dp0 inside
  // the pnpm shim point at the current directory, and the shim then looks for its
  // corepack entrypoint on the wrong drive.
  const line = buildWindowsCommandLine('pnpm.cmd', ['build']);
  assert.ok(line.startsWith('"pnpm.cmd '));
});

// Runs on every platform, which is what makes it useful: CI runs the general suite on
// Linux only, so a Windows-gated assertion would never guard this.
test('caret-escapes every cmd.exe metacharacter it emits', () => {
  for (const value of [
    NESTED_COMMAND,
    INJECTION,
    'a&b|c<d>e(f)g;h,i*j?k',
    'plain',
  ]) {
    const quoted = quoteWindowsArgument(value);
    // The caret is left out of the scanned set because it is the escape character here,
    // so its own occurrences are the escaping rather than something needing escape.
    let scanned = 0;
    for (let index = 0; index < quoted.length; index += 1) {
      if (!'()[]!"`<>&|;, *?'.includes(quoted[index])) {
        continue;
      }
      scanned += 1;
      assert.equal(
        quoted[index - 1],
        '^',
        `unescaped ${quoted[index]} at ${index} in ${quoted}`,
      );
    }
    // Without this the loop body could never run and the test would pass on nothing.
    assert.ok(scanned >= 2, `scanned ${scanned} metacharacters in ${quoted}`);
  }
});

test('escapes metacharacters twice for the batch shim', () => {
  // One layer is consumed by the first cmd.exe parse, the second by the shim's own %*.
  assert.equal(quoteWindowsArgument('plain'), '^^^"plain^^^"');
  assert.equal(quoteWindowsArgument('a b'), '^^^"a^^^ b^^^"');
});

test('doubles backslashes only where CommandLineToArgvW requires it', () => {
  // Backslashes are literal unless they precede a quote.
  assert.equal(quoteWindowsArgument('C:\\src\\app'), '^^^"C:\\src\\app^^^"');
  // A trailing backslash would otherwise escape the closing quote.
  assert.equal(quoteWindowsArgument('C:\\src\\'), '^^^"C:\\src\\\\^^^"');
});

test('refuses arguments cmd.exe would expand rather than corrupting them', () => {
  assert.throws(
    () => quoteWindowsArgument('%PATH%'),
    /cannot be quoted safely/,
  );
  assert.throws(
    () => quoteWindowsArgument('one\ntwo'),
    /cannot be quoted safely/,
  );
});

async function shimDir() {
  const dir = await mkdtemp(join(tmpdir(), 'pnpm-spawn-'));
  tempDirs.push(dir);
  const printer = join(dir, 'print-argv.mjs');
  await writeFile(
    printer,
    'console.log(JSON.stringify(process.argv.slice(2)));\n',
  );
  // Forwarding %* mirrors how pnpm.cmd and other npm-style shims relay arguments.
  await writeFile(join(dir, 'shim.cmd'), `@node "${printer}" %*\n`);
  return dir;
}

function runThroughShim(dir, args) {
  return spawnSync(
    process.env.ComSpec || 'cmd.exe',
    ['/d', '/s', '/c', buildWindowsCommandLine('shim.cmd', args)],
    {
      encoding: 'utf8',
      windowsVerbatimArguments: true,
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}` },
    },
  );
}

test.skipIf(process.platform !== 'win32')(
  'round-trips arguments through a real .cmd shim',
  async () => {
    const dir = await shimDir();
    const args = ['exec', NESTED_COMMAND, 'trailing arg', 'C:\\src\\'];
    const result = runThroughShim(dir, args);

    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.deepEqual(JSON.parse(result.stdout.trim()), args);
  },
);

test.skipIf(process.platform !== 'win32')(
  'does not let a crafted file name run a second command',
  async () => {
    const dir = await shimDir();
    const marker = join(dir, 'INJECTED.txt');
    // Verified to execute when the caret escaping is removed: the embedded quote closes
    // the quoted region and the following & becomes a command separator.
    const args = ['exec', 'prettier', '--check', `x"&echo>${marker}&"`];
    const result = runThroughShim(dir, args);

    assert.equal(existsSync(marker), false);
    assert.deepEqual(JSON.parse(result.stdout.trim()), args);
  },
);
