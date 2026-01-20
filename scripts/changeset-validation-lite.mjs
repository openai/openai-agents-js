#!/usr/bin/env node

import fs from 'fs';
import { execSync, spawnSync } from 'child_process';

const { console, process } = globalThis;

const EXEC_MAX_BUFFER = Number(
  process.env.CHANGESET_MAX_BUFFER_BYTES || 50 * 1024 * 1024,
);

function printUsage() {
  console.log(`changeset-validation-lite

Usage:
  pnpm changeset:validate-lite -- [--base <ref>] [--head <ref>]

Options:
  --base <ref>           Base ref or SHA (default: origin/main if available, else main).
  --head <ref>           Head ref or SHA (default: HEAD).
  --help                 Show this help text.
`);
}

function run(cmd, options = {}) {
  return execSync(cmd, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: EXEC_MAX_BUFFER,
    ...options,
  }).trim();
}

function runOptional(cmd) {
  try {
    return run(cmd);
  } catch (_error) {
    return '';
  }
}

function parseArgs(argv) {
  const options = {
    base: null,
    head: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help') {
      options.help = true;
      continue;
    }
    if (arg === '--base') {
      options.base = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === '--head') {
      options.head = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return options;
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return null;
  }
}

function readFileFromGit(ref, filePath) {
  const result = spawnSync('git', ['show', `${ref}:${filePath}`], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  return result.stdout;
}

function readEventPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  const contents = readFileSafe(eventPath);
  if (!contents) return null;
  try {
    return JSON.parse(contents);
  } catch (_error) {
    return null;
  }
}

function listChangedFiles(baseSha, headSha) {
  const diff = runOptional(`git diff --name-only ${baseSha} ${headSha}`);
  return diff ? diff.split(/\r?\n/).filter(Boolean) : [];
}

function listChangesetFiles(baseSha, headSha) {
  const diff = runOptional(
    `git diff --name-only ${baseSha} ${headSha} -- .changeset`,
  );
  const files = diff ? diff.split(/\r?\n/).filter(Boolean) : [];
  return files.filter(
    (file) => file.endsWith('.md') && !file.endsWith('README.md'),
  );
}

function parseChangesetPackages(content) {
  const parts = content.split('---');
  if (parts.length < 3) return null;
  const frontmatter = parts[1];
  const packages = new Set();
  for (const line of frontmatter.split(/\r?\n/)) {
    const match = line.match(/^\s*["']?([^"':]+)["']?\s*:/);
    if (!match) continue;
    const name = match[1]?.trim();
    if (name) packages.add(name);
  }
  return [...packages];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printUsage();
    process.exit(0);
  }

  const repoRoot = run('git rev-parse --show-toplevel');
  process.chdir(repoRoot);

  const eventPayload = readEventPayload();
  const eventBaseSha = eventPayload?.pull_request?.base?.sha;
  const eventHeadSha = eventPayload?.pull_request?.head?.sha;

  const baseRef =
    options.base ||
    eventBaseSha ||
    (runOptional('git rev-parse --verify origin/main')
      ? 'origin/main'
      : 'main');
  const headRef = options.head || eventHeadSha || 'HEAD';

  let baseSha;
  let headSha;
  try {
    headSha = run(`git rev-parse ${headRef}`);
    baseSha = run(`git merge-base ${baseRef} ${headRef}`);
  } catch (error) {
    console.error(`Failed to resolve git refs: ${error.message}`);
    process.exit(1);
  }

  const changedFiles = listChangedFiles(baseSha, headSha);
  const packageChanges = changedFiles.filter((file) =>
    file.startsWith('packages/'),
  );

  if (packageChanges.length === 0) {
    console.log('No package changes detected; changeset is not required.');
    return;
  }

  const packageDirEntries = fs
    .readdirSync('packages', { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);
  const packageDirs = new Set(packageDirEntries);
  const packageNameByDir = new Map();
  const allowedPackageNames = new Set();
  for (const dir of packageDirEntries) {
    const packageJsonPath = `packages/${dir}/package.json`;
    const contents = readFileSafe(packageJsonPath);
    if (!contents) continue;
    try {
      const parsed = JSON.parse(contents);
      if (parsed?.name) {
        allowedPackageNames.add(parsed.name);
        packageNameByDir.set(dir, parsed.name);
      }
    } catch (_error) {
      console.error(`Failed to parse ${packageJsonPath}.`);
      process.exit(1);
    }
  }

  const unknownPackageDirs = new Set();
  for (const filePath of packageChanges) {
    const parts = filePath.split('/');
    const dir = parts[1];
    if (dir && !packageDirs.has(dir)) {
      unknownPackageDirs.add(dir);
    }
  }

  if (unknownPackageDirs.size > 0) {
    const list = [...unknownPackageDirs].sort().join(', ');
    console.error(
      `Unknown package directories in diff: ${list}. Add a changeset and update package metadata if needed.`,
    );
    process.exit(1);
  }

  const changedPackageNames = new Set();
  for (const filePath of packageChanges) {
    const dir = filePath.split('/')[1];
    const packageName = dir ? packageNameByDir.get(dir) : null;
    if (packageName) {
      changedPackageNames.add(packageName);
    }
  }

  const changesetFiles = listChangesetFiles(baseSha, headSha);
  if (changesetFiles.length === 0) {
    console.error(
      'Package changes detected without a changeset. Add a .changeset/*.md file or run manual changeset validation.',
    );
    process.exit(1);
  }

  const invalidPackages = new Set();
  const changesetPackages = new Set();
  let parsedAnyPackage = false;
  for (const filePath of changesetFiles) {
    const content = readFileFromGit(headSha, filePath);
    if (!content) {
      console.error(
        `Failed to read changeset file ${filePath} from ${headSha}.`,
      );
      process.exit(1);
    }
    const packages = parseChangesetPackages(content);
    if (!packages) {
      console.error(`Changeset file ${filePath} is missing frontmatter.`);
      process.exit(1);
    }
    for (const pkg of packages) {
      parsedAnyPackage = true;
      changesetPackages.add(pkg);
      if (!allowedPackageNames.has(pkg)) {
        invalidPackages.add(pkg);
      }
    }
  }

  if (!parsedAnyPackage) {
    console.error('Changeset frontmatter has no package entries.');
    process.exit(1);
  }

  if (invalidPackages.size > 0) {
    const list = [...invalidPackages].sort().join(', ');
    console.error(`Changeset includes unknown package names: ${list}.`);
    process.exit(1);
  }

  const missingPackages = [...changedPackageNames].filter(
    (pkg) => !changesetPackages.has(pkg),
  );
  if (missingPackages.length > 0) {
    const list = missingPackages.sort().join(', ');
    console.error(`Changeset is missing changed packages: ${list}.`);
    process.exit(1);
  }

  console.log(
    `Package changes detected with ${changesetFiles.length} changeset file(s).`,
  );
}

main().catch((error) => {
  console.error(`changeset-validation-lite failed: ${error.message}`);
  process.exit(1);
});
