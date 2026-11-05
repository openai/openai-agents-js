import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import test from 'node:test';
import {
  hashes,
  sdkNames,
  verifyArtifactDirectory,
} from './verify-alpha-package.mjs';

test('accepts a matching archive set and rejects tampering and receipt substitution', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'alpha-artifact-hashes-'));
  const platform = `${process.platform}-${process.arch}`;
  const receiptFile = join(directory, `build-${platform}.json`);
  const makeArchive = async (archive, content) => {
    await writeFile(join(directory, archive), content);
    return { archive, ...(await hashes(join(directory, archive))) };
  };
  try {
    const packages = {};
    for (const [index, name] of sdkNames.entries()) {
      packages[name] = {
        ...(await makeArchive(`package-${index}.tgz`, name)),
        version: '0.22.0-alpha.1',
      };
    }
    const receipt = {
      sourceCommit: 'a'.repeat(40),
      codexRevision: 'b'.repeat(40),
      platform,
      version: '0.22.0-alpha.1',
      packages,
      starter: await makeArchive('starter.tar.gz', 'starter'),
    };
    const save = () => writeFile(receiptFile, JSON.stringify(receipt));
    const checksumFile = join(directory, `SHA256SUMS-${platform}`);
    const checksumText =
      [receipt.starter, ...Object.values(packages)]
        .map((record) => `${record.sha256}  ${record.archive}`)
        .reverse()
        .join('\n') + '\n';
    await writeFile(checksumFile, checksumText);
    await save();
    assert.deepEqual(await verifyArtifactDirectory(directory), receipt);
    const runtime = receipt.packages['@openai/agents-codex'];
    delete receipt.packages['@openai/agents-codex'];
    await save();
    await assert.rejects(verifyArtifactDirectory(directory));
    receipt.packages['@openai/agents-codex'] = runtime;
    await save();
    await writeFile(
      checksumFile,
      checksumText.replace(receipt.starter.sha256, '0'.repeat(64)),
    );
    await assert.rejects(
      verifyArtifactDirectory(directory),
      /checksum list mismatch/,
    );
    await writeFile(
      checksumFile,
      checksumText + checksumText.split('\n')[0] + '\n',
    );
    await assert.rejects(
      verifyArtifactDirectory(directory),
      /checksum list mismatch/,
    );
    await writeFile(checksumFile, checksumText);
    const file = join(directory, packages[sdkNames[0]].archive);
    const original = await readFile(file);
    await writeFile(file, 'tampered');
    await assert.rejects(verifyArtifactDirectory(directory), /SHA256 mismatch/);
    await writeFile(file, original);
    receipt.packages[sdkNames[0]].integrity = 'sha512-substituted';
    await save();
    await assert.rejects(
      verifyArtifactDirectory(directory),
      /integrity mismatch/,
    );
    receipt.packages[sdkNames[0]].integrity = (await hashes(file)).integrity;
    receipt.packages[sdkNames[0]].version = '0.22.0-alpha.2';
    await save();
    await assert.rejects(
      verifyArtifactDirectory(directory),
      /version mismatch/,
    );
    receipt.packages[sdkNames[0]].version = receipt.version;
    receipt.starter.archive = '../starter.tar.gz';
    await save();
    await assert.rejects(verifyArtifactDirectory(directory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
