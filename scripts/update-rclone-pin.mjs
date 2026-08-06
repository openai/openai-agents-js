#!/usr/bin/env node

import console from 'node:console';
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL, URL } from 'node:url';

const RCLONE_RELEASES_API =
  'https://api.github.com/repos/rclone/rclone/releases';
const DEFAULT_COOLDOWN_DAYS = 7;
const RUNTIME_PIN_PATH =
  'packages/agents-extensions/src/sandbox/shared/inContainerMounts.ts';
const PIN_BEGIN = '// BEGIN RCLONE RELEASE PIN';
const PIN_END = '// END RCLONE RELEASE PIN';
const RCLONE_ARCHES = ['386', 'amd64', 'arm', 'arm-v6', 'arm-v7', 'arm64'];
const SHA256_LINE = /^([0-9a-f]{64})\s+\*?(\S+)$/iu;

export function requestHeaders(url, env = process.env) {
  const headers = {
    Accept: 'application/vnd.github+json',
    'User-Agent': 'openai-agents-js-rclone-pin-updater',
  };
  if (env.GITHUB_TOKEN && new URL(url).hostname === 'api.github.com') {
    headers.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  }
  return headers;
}

async function fetchText(url) {
  const response = await globalThis.fetch(url, {
    headers: requestHeaders(url),
  });
  if (!response.ok) {
    throw new Error(`Failed to fetch ${url}: HTTP ${response.status}.`);
  }
  return response.text();
}

async function fetchJson(url) {
  return JSON.parse(await fetchText(url));
}

export function normalizeVersion(value) {
  const version = value.replace(/^v/u, '');
  if (!/^\d+\.\d+\.\d+$/u.test(version)) {
    throw new Error(`Invalid rclone version: ${value}.`);
  }
  return version;
}

function releaseUrl(version) {
  if (version === undefined) {
    return `${RCLONE_RELEASES_API}?per_page=100`;
  }
  return `${RCLONE_RELEASES_API}/tags/${encodeURIComponent(
    `v${normalizeVersion(version)}`,
  )}`;
}

function releaseVersion(release) {
  if (typeof release?.tag_name !== 'string') {
    throw new Error('rclone release metadata is missing tag_name.');
  }
  return normalizeVersion(release.tag_name);
}

function releasePublishedAt(release) {
  if (typeof release?.published_at !== 'string') {
    throw new Error('rclone release metadata is missing published_at.');
  }
  const publishedAt = new Date(release.published_at);
  if (Number.isNaN(publishedAt.getTime())) {
    throw new Error(
      `rclone release has invalid published_at: ${release.published_at}.`,
    );
  }
  return publishedAt;
}

function releaseAssetNames(version) {
  return [
    'SHA256SUMS',
    ...RCLONE_ARCHES.map((arch) => `rclone-v${version}-linux-${arch}.zip`),
  ];
}

function releaseAssetCreatedAt(release, name) {
  const asset = releaseAsset(release, name);
  if (typeof asset.created_at !== 'string') {
    throw new Error(`rclone release asset ${name} is missing created_at.`);
  }
  const createdAt = new Date(asset.created_at);
  if (Number.isNaN(createdAt.getTime())) {
    throw new Error(
      `rclone release asset ${name} has invalid created_at: ${asset.created_at}.`,
    );
  }
  return createdAt;
}

export function validateRequiredAssetCooldown(
  release,
  version,
  { cooldownDays = DEFAULT_COOLDOWN_DAYS, now = new Date() } = {},
) {
  for (const name of releaseAssetNames(version)) {
    const eligibleAt = new Date(
      releaseAssetCreatedAt(release, name).getTime() +
        cooldownDays * 86_400_000,
    );
    if (eligibleAt > now) {
      throw new Error(
        `rclone v${version} asset ${name} is still in its ${cooldownDays}-day cooldown.`,
      );
    }
  }
}

export function validateStableRelease(
  release,
  { cooldownDays = DEFAULT_COOLDOWN_DAYS, now = new Date() } = {},
) {
  const version = releaseVersion(release);
  if (release.draft !== false || release.prerelease !== false) {
    throw new Error(`rclone v${version} is not a stable published release.`);
  }
  const eligibleAt = new Date(
    releasePublishedAt(release).getTime() + cooldownDays * 86_400_000,
  );
  if (eligibleAt > now) {
    throw new Error(
      `rclone v${version} is still in its ${cooldownDays}-day cooldown.`,
    );
  }
  validateRequiredAssetCooldown(release, version, { cooldownDays, now });
}

export function latestStableRelease(
  releases,
  { cooldownDays = DEFAULT_COOLDOWN_DAYS, now = new Date() } = {},
) {
  const eligible = releases
    .filter((release) => {
      try {
        validateStableRelease(release, { cooldownDays, now });
        return true;
      } catch {
        return false;
      }
    })
    .sort(
      (left, right) =>
        releasePublishedAt(right).getTime() -
        releasePublishedAt(left).getTime(),
    );
  if (!eligible[0]) {
    throw new Error(
      `No stable rclone release has completed the ${cooldownDays}-day cooldown.`,
    );
  }
  return eligible[0];
}

function releaseAsset(release, name) {
  const asset = release?.assets?.find((candidate) => candidate?.name === name);
  if (!asset) {
    throw new Error(`rclone release is missing ${name}.`);
  }
  return asset;
}

function releaseAssetUrl(release, name) {
  const asset = releaseAsset(release, name);
  if (typeof asset.browser_download_url !== 'string') {
    throw new Error(
      `rclone release asset ${name} is missing its download URL.`,
    );
  }
  return asset.browser_download_url;
}

function releaseAssetSha256(release, name) {
  const digest = releaseAsset(release, name).digest;
  if (typeof digest !== 'string' || !/^sha256:[0-9a-f]{64}$/iu.test(digest)) {
    throw new Error(
      `rclone release asset ${name} is missing its SHA256 digest.`,
    );
  }
  return digest.slice('sha256:'.length).toLowerCase();
}

export function parseSha256s(text, version) {
  const filenames = new Map(
    RCLONE_ARCHES.map((arch) => [`rclone-v${version}-linux-${arch}.zip`, arch]),
  );
  const sha256ByArch = {};
  for (const line of text.split(/\r?\n/u)) {
    const match = SHA256_LINE.exec(line.trim());
    if (!match) {
      continue;
    }
    const [, digest, filename] = match;
    const arch = filenames.get(filename);
    if (arch) {
      sha256ByArch[arch] = digest.toLowerCase();
    }
  }
  const missing = RCLONE_ARCHES.filter((arch) => !sha256ByArch[arch]);
  if (missing.length > 0) {
    throw new Error(
      `rclone v${version} SHA256SUMS is missing Linux archives for: ${missing.join(
        ', ',
      )}.`,
    );
  }
  return sha256ByArch;
}

export function validateAssetSha256s(release, version, sha256ByArch) {
  for (const arch of RCLONE_ARCHES) {
    const name = `rclone-v${version}-linux-${arch}.zip`;
    if (releaseAssetSha256(release, name) !== sha256ByArch[arch]) {
      throw new Error(
        `rclone v${version} SHA256SUMS does not match GitHub's digest for ${name}.`,
      );
    }
  }
}

export async function fetchPin(
  version,
  { cooldownDays = DEFAULT_COOLDOWN_DAYS, now = new Date() } = {},
) {
  if (!Number.isInteger(cooldownDays) || cooldownDays < 0) {
    throw new Error('Cooldown days must be a non-negative integer.');
  }
  const payload = await fetchJson(releaseUrl(version));
  const release =
    version === undefined
      ? latestStableRelease(payload, { cooldownDays, now })
      : payload;
  validateStableRelease(release, { cooldownDays, now });
  const resolvedVersion = releaseVersion(release);
  if (version !== undefined && resolvedVersion !== normalizeVersion(version)) {
    throw new Error(
      `Requested rclone v${normalizeVersion(
        version,
      )}, got v${resolvedVersion}.`,
    );
  }
  const checksums = await fetchText(releaseAssetUrl(release, 'SHA256SUMS'));
  const sha256ByArch = parseSha256s(checksums, resolvedVersion);
  validateAssetSha256s(release, resolvedVersion, sha256ByArch);
  return { version: resolvedVersion, sha256ByArch };
}

function quoteProperty(property) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(property)
    ? property
    : `'${property}'`;
}

export function renderPinBlock(pin) {
  const lines = [
    PIN_BEGIN,
    `const RCLONE_VERSION = '${pin.version}';`,
    'const RCLONE_SHA256_BY_ARCH = {',
  ];
  for (const arch of RCLONE_ARCHES) {
    const property = quoteProperty(arch);
    const digest = `'${pin.sha256ByArch[arch]}'`;
    const line = `  ${property}: ${digest},`;
    if (line.length <= 79) {
      lines.push(line);
    } else {
      lines.push(`  ${property}:`, `    ${digest},`);
    }
  }
  lines.push('} as const;', PIN_END);
  return lines.join('\n');
}

export function replaceMarkedBlock(text, replacement) {
  if (text.split(PIN_BEGIN).length !== 2 || text.split(PIN_END).length !== 2) {
    throw new Error(
      `Expected exactly one pin block delimited by ${PIN_BEGIN}.`,
    );
  }
  const start = text.indexOf(PIN_BEGIN);
  const end = text.indexOf(PIN_END, start) + PIN_END.length;
  return `${text.slice(0, start)}${replacement}${text.slice(end)}`;
}

export async function applyPin(repoRoot, pin, { check = false } = {}) {
  const path = resolve(repoRoot, RUNTIME_PIN_PATH);
  const current = await readFile(path, 'utf8');
  const updated = replaceMarkedBlock(current, renderPinBlock(pin));
  if (updated === current) {
    return [];
  }
  if (!check) {
    await writeFile(path, updated);
  }
  return [path];
}

function parseArgs(args) {
  const parsed = {
    check: false,
    cooldownDays: DEFAULT_COOLDOWN_DAYS,
    version: undefined,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--check') {
      parsed.check = true;
    } else if (arg === '--version') {
      parsed.version = args[++index];
      if (!parsed.version) {
        throw new Error('--version requires a value.');
      }
    } else if (arg === '--cooldown-days') {
      const value = args[++index];
      parsed.cooldownDays = Number(value);
      if (!Number.isInteger(parsed.cooldownDays)) {
        throw new Error('--cooldown-days requires an integer.');
      }
    } else {
      throw new Error(`Unknown argument: ${arg}.`);
    }
  }
  return parsed;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const pin = await fetchPin(options.version, {
    cooldownDays: options.cooldownDays,
  });
  const changed = await applyPin(repoRoot, pin, { check: options.check });
  if (changed.length === 0) {
    console.log(`rclone v${pin.version} pin is current.`);
    return 0;
  }
  const relativePaths = changed.map((path) => path.slice(repoRoot.length + 1));
  if (options.check) {
    console.error(
      `rclone v${pin.version} differs in ${relativePaths.join(', ')}.`,
    );
    console.error(`Run: pnpm update:rclone-pin --version ${pin.version}`);
    return 1;
  }
  console.log(
    `Updated rclone v${pin.version} pin in ${relativePaths.join(', ')}.`,
  );
  return 0;
}

const isMain =
  process.argv[1] !== undefined &&
  pathToFileURL(resolve(process.argv[1])).href === import.meta.url;
if (isMain) {
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(`Error: ${error instanceof Error ? error.message : error}`);
      process.exitCode = 2;
    });
}
