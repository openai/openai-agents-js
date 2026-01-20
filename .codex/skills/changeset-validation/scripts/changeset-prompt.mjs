#!/usr/bin/env node

import fs from 'fs';
import path from 'path';
import { execSync, spawnSync } from 'child_process';

const { console, process } = globalThis;

const EXEC_MAX_BUFFER = Number(
  process.env.CHANGESET_MAX_BUFFER_BYTES || 50 * 1024 * 1024,
);
const ALLOWED_PACKAGES = [
  '@openai/agents',
  '@openai/agents-core',
  '@openai/agents-extensions',
  '@openai/agents-openai',
  '@openai/agents-realtime',
];

const MAX_DIFF_CHARS = Number(process.env.CHANGESET_MAX_DIFF_CHARS || 12000);
const PROMPT_PATH = path.join(
  '.codex',
  'skills',
  'changeset-validation',
  'references',
  'validation-prompt.md',
);

function printUsage() {
  console.log(`changeset-prompt

Usage:
  pnpm changeset:validate-prompt -- [--base <ref>] [--head <ref>] [--ci] [--output <path>]

Options:
  --base <ref>           Base ref or SHA (default: origin/main if available, else main).
  --head <ref>           Head ref or SHA (default: HEAD).
  --ci                   Use CI context (PR body, no working tree diffs).
  --output <path>        Write the generated prompt to a file instead of stdout.
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
    ci: process.env.GITHUB_ACTIONS === 'true',
    output: null,
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
    if (arg === '--ci') {
      options.ci = true;
      continue;
    }
    if (arg === '--output') {
      options.output = argv[i + 1];
      i += 1;
      continue;
    }
  }

  return options;
}

function parseNameStatus(text) {
  if (!text) return [];
  const lines = text.split(/\r?\n/).filter(Boolean);
  const entries = [];
  for (const line of lines) {
    const parts = line.split('\t');
    const status = parts[0];
    if (!status) continue;
    if (status.startsWith('R') || status.startsWith('C')) {
      if (parts[1]) entries.push({ path: parts[1], status });
      if (parts[2]) entries.push({ path: parts[2], status });
    } else if (parts[1]) {
      entries.push({ path: parts[1], status });
    }
  }
  return entries;
}

function isChangesetFile(filePath) {
  if (!filePath.startsWith('.changeset/')) return false;
  if (!filePath.endsWith('.md')) return false;
  return path.basename(filePath) !== 'README.md';
}

function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch (_error) {
    return null;
  }
}

function truncateText(text, maxChars) {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n... (truncated ${text.length - maxChars} chars)`;
}

function getDiffNoIndex(filePath) {
  const result = spawnSync(
    'git',
    ['diff', '--no-index', '--', '/dev/null', filePath],
    {
      encoding: 'utf8',
    },
  );
  return result.stdout.trim();
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

function renderPrompt(template, data) {
  return template
    .replaceAll('{{ALLOWED_PACKAGES}}', data.allowedPackages)
    .replaceAll('{{CHANGED_PACKAGES}}', data.changedPackages)
    .replaceAll('{{CHANGED_FILES}}', data.changedFiles)
    .replaceAll('{{CHANGESET_FILES}}', data.changesetFiles)
    .replaceAll('{{PR_BODY}}', data.prBody)
    .replaceAll('{{PACKAGE_DIFF}}', data.packageDiff)
    .replaceAll('{{UNKNOWN_PACKAGE_DIRS}}', data.unknownPackageDirs);
}

function formatChangesetFiles(entries) {
  if (entries.length === 0) return '(none)';
  return entries
    .map((entry) => {
      const header = `File: ${entry.path} (${entry.status || 'unknown'})`;
      const content = entry.content ? entry.content.trimEnd() : '(missing)';
      return `${header}\n${content}`;
    })
    .join('\n\n');
}

function writeOutputFile(outputPath, prompt) {
  const dir = path.dirname(outputPath);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(outputPath, `${prompt.trim()}\n`, 'utf8');
  console.log(`Wrote prompt to ${outputPath}.`);
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

  const includeWorkingTree = !options.ci;
  const changes = new Map();
  const committedDiff = runOptional(
    `git diff --name-status ${baseSha} ${headSha}`,
  );
  for (const entry of parseNameStatus(committedDiff)) {
    changes.set(entry.path, entry.status);
  }

  if (includeWorkingTree) {
    const staged = runOptional('git diff --name-status --cached');
    const unstaged = runOptional('git diff --name-status');
    for (const entry of parseNameStatus(staged)) {
      changes.set(entry.path, entry.status);
    }
    for (const entry of parseNameStatus(unstaged)) {
      changes.set(entry.path, entry.status);
    }
    const untracked = runOptional('git ls-files --others --exclude-standard');
    for (const line of untracked.split(/\r?\n/).filter(Boolean)) {
      changes.set(line, 'A');
    }
  }

  const packageDirs = fs
    .readdirSync('packages', { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory())
    .map((dirent) => dirent.name);

  const packageNameByDir = new Map();
  for (const dir of packageDirs) {
    const packageJsonPath = path.join('packages', dir, 'package.json');
    const contents = readFileSafe(packageJsonPath);
    if (!contents) continue;
    try {
      const parsed = JSON.parse(contents);
      if (parsed?.name) {
        packageNameByDir.set(dir, parsed.name);
      }
    } catch (_error) {
      console.error(`Failed to parse ${packageJsonPath}.`);
      process.exit(1);
    }
  }

  const changedPackages = new Set();
  const unknownPackageDirs = new Set();
  for (const filePath of changes.keys()) {
    if (!filePath.startsWith('packages/')) continue;
    const parts = filePath.split('/');
    const dir = parts[1];
    if (!dir) continue;
    const packageName = packageNameByDir.get(dir);
    if (packageName) {
      changedPackages.add(packageName);
    } else {
      unknownPackageDirs.add(dir);
    }
  }

  const changesetPaths = [...changes.keys()].filter((filePath) =>
    isChangesetFile(filePath),
  );
  const changesetEntries = changesetPaths
    .map((filePath) => {
      const status = changes.get(filePath) || 'unknown';
      const content =
        readFileSafe(filePath) || readFileFromGit(headSha, filePath);
      if (!content) {
        if (status.startsWith('D')) return null;
        if (status.startsWith('R') || status.startsWith('C')) return null;
      }
      return { path: filePath, status, content };
    })
    .filter(Boolean);

  const diffSections = [];
  const committedPackageDiff = runOptional(
    `git diff ${baseSha} ${headSha} -- packages`,
  );
  if (committedPackageDiff) {
    diffSections.push(`Committed diff (packages):\n${committedPackageDiff}`);
  }

  if (includeWorkingTree) {
    const stagedPackageDiff = runOptional('git diff --cached -- packages');
    if (stagedPackageDiff) {
      diffSections.push(`Staged diff (packages):\n${stagedPackageDiff}`);
    }
    const unstagedPackageDiff = runOptional('git diff -- packages');
    if (unstagedPackageDiff) {
      diffSections.push(`Unstaged diff (packages):\n${unstagedPackageDiff}`);
    }

    const untrackedPackageDiffs = [];
    for (const filePath of changes.keys()) {
      if (!filePath.startsWith('packages/')) continue;
      if (!fs.existsSync(filePath)) continue;
      if (
        !runOptional(`git ls-files --others --exclude-standard -- ${filePath}`)
      )
        continue;
      const diff = getDiffNoIndex(filePath);
      if (diff) untrackedPackageDiffs.push(diff);
    }
    if (untrackedPackageDiffs.length > 0) {
      diffSections.push(
        `Untracked diff (packages):\n${untrackedPackageDiffs.join('\n')}`,
      );
    }
  }

  const packageDiff = truncateText(
    diffSections.join('\n\n') || '(no package diff provided)',
    MAX_DIFF_CHARS,
  );
  const prBody = options.ci
    ? eventPayload?.pull_request?.body || '(none)'
    : '(not provided)';

  const promptTemplate = readFileSafe(PROMPT_PATH);
  if (!promptTemplate) {
    console.error(`Prompt template not found at ${PROMPT_PATH}.`);
    process.exit(1);
  }

  const prompt = renderPrompt(promptTemplate, {
    allowedPackages: ALLOWED_PACKAGES.join(', '),
    changedPackages: [...changedPackages].sort().join(', ') || '(none)',
    changedFiles: [...changes.keys()].sort().join('\n') || '(none)',
    changesetFiles: formatChangesetFiles(changesetEntries),
    prBody,
    packageDiff,
    unknownPackageDirs: [...unknownPackageDirs].sort().join(', ') || '(none)',
  });

  if (options.output) {
    writeOutputFile(options.output, prompt);
    return;
  }

  console.log(prompt.trim());
}

main().catch((error) => {
  console.error(`changeset-prompt failed: ${error.message}`);
  process.exit(1);
});
