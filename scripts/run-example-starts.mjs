import console from 'node:console';
import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

/**
 * Run all example start scripts in order.
 *
 * Usage:
 *   node scripts/run-example-starts.mjs --dry-run                # list only
 *   node scripts/run-example-starts.mjs --filter basic           # run only matches
 *   node scripts/run-example-starts.mjs --include-interactive    # include HITL/interactive scripts
 *   node scripts/run-example-starts.mjs --include-server         # include server-like scripts
 *   node scripts/run-example-starts.mjs --include-audio          # include realtime/voice scripts
 *   node scripts/run-example-starts.mjs --include-external       # include scripts needing extra services
 *   node scripts/run-example-starts.mjs --fail-fast              # stop after first failure
 *
 * Via package.json:
 *   pnpm examples:start-all --dry-run
 *   pnpm examples:start-all --filter basic
 *   pnpm examples:start-all --include-interactive
 */
const START_PATTERN = /^start(?::|$)/;
const SERVER_COMMAND_KEYWORDS = ['next', 'vite', 'serve', 'server', 'dev '];
const SERVER_PATH_KEYWORDS = ['realtime', 'nextjs'];
const INTERACTIVE_NAME_KEYWORDS = ['hitl', 'human'];
const AUDIO_PATH_KEYWORDS = ['realtime', 'voice', 'audio'];
const EXTERNAL_COMMAND_KEYWORDS = [
  'prisma',
  'redis',
  'twilio',
  'dapr',
  'playwright',
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const examplesDir = path.join(rootDir, 'examples');

const parseArgs = (args) => {
  let dryRun = false;
  let filter = null;
  let includeServer = false;
  let includeInteractive = false;
  let includeAudio = false;
  let includeExternal = false;
  let failFast = false;
  let verbose = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    if (arg === '--filter' || arg === '-f') {
      filter = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--include-server') {
      includeServer = true;
      continue;
    }

    if (arg === '--include-interactive') {
      includeInteractive = true;
      continue;
    }

    if (arg === '--include-audio') {
      includeAudio = true;
      continue;
    }

    if (arg === '--include-external') {
      includeExternal = true;
      continue;
    }

    if (arg === '--fail-fast') {
      failFast = true;
      continue;
    }

    if (arg === '--verbose') {
      verbose = true;
      continue;
    }

    console.warn(`Ignoring unknown argument: ${arg}`);
  }

  return {
    dryRun,
    filter,
    includeServer,
    includeInteractive,
    includeAudio,
    includeExternal,
    failFast,
    verbose,
  };
};

const matchesFilter = (start, filter) => {
  if (!filter) {
    return true;
  }

  const needle = filter.toLowerCase();

  return (
    start.packageName.toLowerCase().includes(needle) ||
    start.scriptName.toLowerCase().includes(needle)
  );
};

const detectTags = (start) => {
  const tags = new Set();
  const commandLower = start.command.toLowerCase();
  const dirLower = start.dir.toLowerCase();
  const nameLower = `${start.packageName}:${start.scriptName}`.toLowerCase();

  if (
    SERVER_COMMAND_KEYWORDS.some((keyword) => commandLower.includes(keyword)) ||
    SERVER_PATH_KEYWORDS.some((keyword) => dirLower.includes(keyword))
  ) {
    tags.add('server');
  }

  if (
    INTERACTIVE_NAME_KEYWORDS.some((keyword) => nameLower.includes(keyword))
  ) {
    tags.add('interactive');
  }

  if (
    AUDIO_PATH_KEYWORDS.some((keyword) => dirLower.includes(keyword)) ||
    AUDIO_PATH_KEYWORDS.some((keyword) => commandLower.includes(keyword))
  ) {
    tags.add('audio');
  }

  if (
    EXTERNAL_COMMAND_KEYWORDS.some((keyword) => commandLower.includes(keyword))
  ) {
    tags.add('external');
  }

  return tags;
};

const collectStartScripts = async (filter) => {
  const entries = await fs.readdir(examplesDir, { withFileTypes: true });
  const starts = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const packageJsonPath = path.join(examplesDir, entry.name, 'package.json');

    let packageJsonRaw;

    try {
      packageJsonRaw = await fs.readFile(packageJsonPath, 'utf-8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        continue;
      }

      throw new Error(
        `Failed to read ${packageJsonPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    let packageJson;
    try {
      packageJson = JSON.parse(packageJsonRaw);
    } catch (error) {
      throw new Error(
        `Failed to parse ${packageJsonPath}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const scripts = packageJson?.scripts ?? {};

    for (const [scriptName, command] of Object.entries(scripts)) {
      if (!START_PATTERN.test(scriptName)) {
        continue;
      }

      const start = {
        packageName:
          typeof packageJson?.name === 'string' ? packageJson.name : entry.name,
        scriptName,
        dir: path.dirname(packageJsonPath),
        command: String(command),
      };

      if (matchesFilter(start, filter)) {
        starts.push({ ...start, tags: detectTags(start) });
      }
    }
  }

  return starts.sort(
    (left, right) =>
      left.dir.localeCompare(right.dir) ||
      left.scriptName.localeCompare(right.scriptName),
  );
};

const shouldSkip = (tags, overrides) => {
  const blocked = new Set(['interactive', 'server', 'audio', 'external']);
  for (const override of overrides) {
    blocked.delete(override);
  }

  const reasons = new Set([...tags].filter((tag) => blocked.has(tag)));
  return { skip: reasons.size > 0, reasons };
};

const formatTags = (tags) =>
  tags.size ? `[tags: ${[...tags].sort().join(', ')}]` : '';

const runStarts = async (starts, dryRun, overrides, failFast, verbose) => {
  let executed = 0;
  let skipped = 0;
  let failed = 0;

  for (const start of starts) {
    const { skip, reasons } = shouldSkip(start.tags, overrides);
    const tagLabel =
      verbose && start.tags.size ? ` ${formatTags(start.tags)}` : '';

    if (skip) {
      const reasonLabel = reasons.size
        ? ` (skipped: ${[...reasons].sort().join(', ')})`
        : '';
      const relativeDir = path.relative(rootDir, start.dir) || '.';
      console.log(
        `\n↷ Skipping ${start.packageName}:${start.scriptName}${tagLabel}${reasonLabel}. pnpm -C ${relativeDir} run ${start.scriptName}`,
      );
      skipped += 1;
      continue;
    }

    const relativeDir = path.relative(rootDir, start.dir) || '.';
    console.log(
      `\n→ ${start.packageName}:${start.scriptName}${tagLabel}\n   pnpm -C ${relativeDir} run ${start.scriptName}\n   ${start.command}`,
    );

    if (dryRun) {
      continue;
    }

    try {
      await execa('pnpm', ['-C', start.dir, 'run', start.scriptName], {
        stdio: 'inherit',
      });
      executed += 1;
    } catch (error) {
      failed += 1;
      const exitCode =
        typeof error?.exitCode === 'number' ? error.exitCode : 'unknown';
      console.error(
        `   !! ${start.packageName}:${start.scriptName} exited with ${exitCode}`,
      );
      if (failFast) {
        break;
      }
    }
  }

  console.log(
    `\nDone. Ran ${executed} start script(s), skipped ${skipped}, failed ${failed}.`,
  );

  return failed === 0 ? 0 : 1;
};

const main = async () => {
  const {
    dryRun,
    filter,
    includeServer,
    includeInteractive,
    includeAudio,
    includeExternal,
    failFast,
    verbose,
  } = parseArgs(process.argv.slice(2));

  const starts = await collectStartScripts(filter);

  if (starts.length === 0) {
    console.log('No start scripts found under examples.');
    return 0;
  }

  console.log(
    `Found ${starts.length} start scripts under examples${
      filter ? ` (filtered by "${filter}")` : ''
    }.`,
  );

  const overrides = new Set();
  if (includeServer) {
    overrides.add('server');
  }
  if (includeInteractive) {
    overrides.add('interactive');
  }
  if (includeAudio) {
    overrides.add('audio');
  }
  if (includeExternal) {
    overrides.add('external');
  }

  return runStarts(starts, dryRun, overrides, failFast, verbose);
};

main()
  .then((exitCode) => {
    process.exitCode = exitCode ?? 0;
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
