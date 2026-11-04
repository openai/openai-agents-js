import process from 'node:process';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyNativeArtifact, nativeInputIdentity } from './native-receipt.mjs';
import {
  compatibleNativeScope,
  readNativeScope,
  scopeFile,
  validateNativeScope,
} from './native-scope.mjs';

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
  assert.match(recipe ?? '', /^[a-f0-9]{64}$/);
  appendFileSync(
    process.env.GITHUB_OUTPUT,
    `name=native-v3-${platform}-${recipe}-${nativeInputIdentity(join(repository, 'packages/agents'))}\n`,
  );
} else if (command === 'stage') {
  assert.ok(directory, 'Missing native artifact directory');
  const scope = validateNativeScope(JSON.parse(process.env.NATIVE_PROVENANCE));
  await copyNativeArtifact(repository, platform, directory);
  writeFileSync(join(directory, scopeFile), JSON.stringify(scope) + '\n');
} else if (command === 'restore' || command === 'donor') {
  assert.ok(directory, 'Missing native artifact directory');
  const scope = readNativeScope(directory);
  const expected = JSON.parse(process.env.NATIVE_EXPECTED_PROVENANCE);
  let usable = true;
  if (command === 'restore')
    assert.deepEqual(scope, expected, 'Captured snapshot provenance changed');
  else usable = compatibleNativeScope(scope, expected);
  if (usable)
    await copyNativeArtifact(
      repository,
      platform,
      join(repository, 'packages/agents'),
      directory,
    );
  if (command === 'donor')
    appendFileSync(process.env.GITHUB_OUTPUT, `usable=${usable}\n`);
} else
  throw new Error(
    'Expected native artifact identity, stage, restore, or donor',
  );
