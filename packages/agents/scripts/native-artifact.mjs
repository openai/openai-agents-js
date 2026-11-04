import process from 'node:process';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyNativeArtifact, nativeInputIdentity } from './native-receipt.mjs';

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const [command, directory] = process.argv.slice(2);
const platform = `${process.platform}-${process.arch}`;
assert.equal(
  platform,
  process.env.EXPECTED_PLATFORM,
  'Unexpected native platform',
);
if (command === 'identity') {
  const recipe = process.env.NATIVE_WORKFLOW_BLOB;
  assert.match(recipe ?? '', /^[a-f0-9]{40}$/);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `name=native-v1-${platform}-${recipe}-${nativeInputIdentity(join(repository, 'packages/agents'))}\n`,
  );
} else if (command === 'stage') {
  assert.ok(directory, 'Missing native artifact directory');
  await copyNativeArtifact(repository, platform, directory);
} else if (command === 'restore') {
  assert.ok(directory, 'Missing native artifact directory');
  await copyNativeArtifact(
    repository,
    platform,
    join(repository, 'packages/agents'),
    directory,
  );
} else {
  throw new Error('Expected native artifact identity, stage, or restore');
}
