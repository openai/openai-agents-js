/* global console, process */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [packagePath, mode] = process.argv.slice(2);
assert.equal(process.platform, 'darwin');
assert(
  packagePath && isAbsolute(packagePath),
  'Pass the absolute installed package root',
);
assert(
  ['clean', 'unsupported', 'late'].includes(mode),
  'Select a fresh-child mode',
);

const packageRoot = await realpath(packagePath);
const require = createRequire(join(packageRoot, 'package.json'));
const entrypoint = require.resolve('@openai/agents-codex');
assert.equal(await realpath(entrypoint), join(packageRoot, 'dist', 'index.js'));
const native = require('./native/index.js');
const { telemetry } = require(entrypoint);
const addon = await realpath(join(packageRoot, 'native', 'codex.node'));
assert(require.cache[addon], 'The matching installed addon must be loaded');

const fixture = await mkdtemp(join(tmpdir(), 'sdk-darwin-telemetry-'));
try {
  const home = join(fixture, 'home');
  const cwd = join(fixture, 'workspace');
  await Promise.all([mkdir(home), mkdir(cwd)]);
  const runtime = {
    ...native._packaged_runtime(),
    codex_home: home,
    cwd,
    loader: { ignore_user_config: true, ignore_project_config: true },
  };
  // The existing late-config control uses this invalid config. It also
  // keeps a missed policy guard from continuing to executor startup.
  const invalidConfig = '{"not_a_native_option":true}';
  if (mode === 'unsupported') {
    await assert.rejects(
      native.create_engine(
        invalidConfig,
        JSON.stringify({
          ...runtime,
          environment: {
            local: false,
            cwd: pathToFileURL(cwd).href,
            write_policy: 'trusted_workspace_write',
          },
        }),
        'synthetic-darwin-admission',
      ),
      /Trusted workspace writes require a local Environment/,
    );
  }
  if (mode === 'late') {
    await assert.rejects(
      native.create_engine(invalidConfig, JSON.stringify(runtime), null),
    );
    await assert.rejects(telemetry.configure(), {
      message: 'Configure telemetry before creating any Codex clients',
    });
  } else {
    await telemetry.configure();
    await telemetry.shutdown();
  }
  console.log('PASS ' + mode);
} finally {
  await rm(fixture, { recursive: true, force: true });
}
