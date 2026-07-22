import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, test } from 'node:test';
import {
  applyPin,
  latestStableRelease,
  parseSha256s,
  renderPinBlock,
  requestHeaders,
  validateAssetSha256s,
  validateRequiredAssetCooldown,
  validateStableRelease,
} from './update-rclone-pin.mjs';

const tempDirs = [];
const arches = ['386', 'amd64', 'arm', 'arm-v6', 'arm-v7', 'arm64'];

afterEach(async () => {
  await Promise.all(
    tempDirs
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

function release(
  version,
  publishedAt,
  { assetCreatedAtByName = {}, draft = false, prerelease = false } = {},
) {
  return {
    tag_name: `v${version}`,
    published_at: publishedAt,
    draft,
    prerelease,
    assets: [
      'SHA256SUMS',
      ...arches.map((arch) => `rclone-v${version}-linux-${arch}.zip`),
    ].map((name) => ({
      name,
      created_at: assetCreatedAtByName[name] ?? publishedAt,
    })),
  };
}

function checksums(version) {
  return arches
    .map(
      (arch, index) =>
        `${String(index + 1).padStart(64, '0')}  rclone-v${version}-linux-${arch}.zip`,
    )
    .join('\n');
}

test('selects the latest stable release after the cooldown', () => {
  const now = new Date('2026-07-22T00:00:00Z');
  const selected = latestStableRelease(
    [
      release('1.75.0', '2026-07-20T00:00:00Z'),
      release('1.74.5', '2026-07-10T00:00:00Z', { prerelease: true }),
      release('1.74.4', '2026-07-08T00:00:00Z'),
      release('1.74.3', '2026-07-01T00:00:00Z'),
    ],
    { cooldownDays: 7, now },
  );

  assert.equal(selected.tag_name, 'v1.74.4');
});

test('rejects releases that have not completed the cooldown', () => {
  assert.throws(
    () =>
      validateStableRelease(release('1.75.0', '2026-07-20T00:00:00Z'), {
        cooldownDays: 7,
        now: new Date('2026-07-22T00:00:00Z'),
      }),
    /7-day cooldown/u,
  );
});

test('enforces the cooldown on every required release asset', () => {
  const version = '1.74.4';
  const publishedAt = '2026-07-01T00:00:00Z';
  const now = new Date('2026-07-22T00:00:00Z');
  const requiredAssets = [
    'SHA256SUMS',
    ...arches.map((arch) => `rclone-v${version}-linux-${arch}.zip`),
  ];

  for (const name of requiredAssets) {
    const candidate = release(version, publishedAt, {
      assetCreatedAtByName: {
        [name]: '2026-07-20T00:00:00Z',
      },
    });

    assert.throws(
      () =>
        validateRequiredAssetCooldown(candidate, version, {
          cooldownDays: 7,
          now,
        }),
      (error) =>
        error instanceof Error &&
        error.message.includes(`asset ${name}`) &&
        error.message.includes('7-day cooldown'),
    );
  }
});

test('skips releases with recently re-uploaded required assets', () => {
  const selected = latestStableRelease(
    [
      release('1.74.4', '2026-07-01T00:00:00Z', {
        assetCreatedAtByName: {
          SHA256SUMS: '2026-07-20T00:00:00Z',
        },
      }),
      release('1.74.3', '2026-06-20T00:00:00Z'),
    ],
    {
      cooldownDays: 7,
      now: new Date('2026-07-22T00:00:00Z'),
    },
  );

  assert.equal(selected.tag_name, 'v1.74.3');
});

test('fails closed when required asset creation metadata is missing', () => {
  const candidate = release('1.74.4', '2026-07-01T00:00:00Z');
  delete candidate.assets[0].created_at;

  assert.throws(
    () =>
      validateStableRelease(candidate, {
        cooldownDays: 7,
        now: new Date('2026-07-22T00:00:00Z'),
      }),
    /SHA256SUMS is missing created_at/u,
  );
});

test('sends GitHub tokens only to the GitHub API host', () => {
  const env = { GITHUB_TOKEN: 'secret' };

  assert.equal(
    requestHeaders('https://api.github.com/repos/rclone/rclone/releases', env)
      .Authorization,
    'Bearer secret',
  );
  assert.equal(
    requestHeaders(
      'https://github.com/rclone/rclone/releases/download/v1.2.3/SHA256SUMS',
      env,
    ).Authorization,
    undefined,
  );
});

test('parses every supported Linux archive checksum', () => {
  const parsed = parseSha256s(checksums('1.2.3'), '1.2.3');

  assert.deepEqual(Object.keys(parsed), arches);
  assert.equal(parsed.amd64, '2'.padStart(64, '0'));
});

test('requires GitHub asset digests to match upstream checksums', () => {
  const version = '1.2.3';
  const sha256ByArch = parseSha256s(checksums(version), version);
  const candidate = {
    assets: arches.map((arch) => ({
      name: `rclone-v${version}-linux-${arch}.zip`,
      digest: `sha256:${sha256ByArch[arch]}`,
    })),
  };

  validateAssetSha256s(candidate, version, sha256ByArch);
  candidate.assets[0].digest = `sha256:${'f'.repeat(64)}`;
  assert.throws(
    () => validateAssetSha256s(candidate, version, sha256ByArch),
    /does not match GitHub/u,
  );
});

test('updates and checks the runtime pin block', async () => {
  const repoRoot = await mkdtemp(
    join(tmpdir(), 'openai-agents-js-rclone-pin-'),
  );
  tempDirs.push(repoRoot);
  const path = join(
    repoRoot,
    'packages/agents-extensions/src/sandbox/shared/inContainerMounts.ts',
  );
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    [
      'before',
      '// BEGIN RCLONE RELEASE PIN',
      'old',
      '// END RCLONE RELEASE PIN',
      'after',
      '',
    ].join('\n'),
  );
  const pin = {
    version: '1.2.3',
    sha256ByArch: parseSha256s(checksums('1.2.3'), '1.2.3'),
  };

  assert.deepEqual(await applyPin(repoRoot, pin, { check: true }), [path]);
  assert.match(await readFile(path, 'utf8'), /\nold\n/u);
  assert.deepEqual(await applyPin(repoRoot, pin), [path]);
  assert.deepEqual(await applyPin(repoRoot, pin, { check: true }), []);
  assert.match(await readFile(path, 'utf8'), /RCLONE_VERSION = '1\.2\.3'/u);
  assert.match(renderPinBlock(pin), /RCLONE_SHA256_BY_ARCH/u);
});
