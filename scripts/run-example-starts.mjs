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
 *   node scripts/run-example-starts.mjs --dry-run           # list only
 *   node scripts/run-example-starts.mjs --filter basic      # run only matches
 *   node scripts/run-example-starts.mjs --include-server    # include server-like scripts
 *
 * Via package.json:
 *   pnpm examples:start-all --dry-run
 *   pnpm examples:start-all --filter basic
 *   pnpm examples:start-all --include-server
 */
const START_PATTERN = /^start(?::|$)/;
const SERVER_COMMAND_KEYWORDS = ['next', 'vite', 'serve', 'server', 'dev '];
const SERVER_PATH_KEYWORDS = ['realtime', 'nextjs'];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const examplesDir = path.join(rootDir, 'examples');

const parseArgs = (args) => {
  let dryRun = false;
  let filter = null;
  let includeServer = false;

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

    console.warn(`Ignoring unknown argument: ${arg}`);
  }

  return { dryRun, filter, includeServer };
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

const isServerLike = (start, includeServer) => {
  if (includeServer) {
    return false;
  }

  const commandLower = start.command.toLowerCase();
  if (
    SERVER_COMMAND_KEYWORDS.some((keyword) => commandLower.includes(keyword))
  ) {
    return true;
  }

  const dirLower = start.dir.toLowerCase();
  if (SERVER_PATH_KEYWORDS.some((keyword) => dirLower.includes(keyword))) {
    return true;
  }

  return false;
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
        `Failed to read ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    let packageJson;
    try {
      packageJson = JSON.parse(packageJsonRaw);
    } catch (error) {
      throw new Error(
        `Failed to parse ${packageJsonPath}: ${error instanceof Error ? error.message : String(error)}`,
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
        starts.push(start);
      }
    }
  }

  return starts.sort(
    (left, right) =>
      left.dir.localeCompare(right.dir) ||
      left.scriptName.localeCompare(right.scriptName),
  );
};

const runStarts = async (starts, dryRun, includeServer) => {
  for (const start of starts) {
    if (isServerLike(start, includeServer)) {
      const relativeDir = path.relative(rootDir, start.dir) || '.';
      console.log(
        `\n↷ Skipping server-like script ${start.packageName}:${start.scriptName} (pnpm -C ${relativeDir} run ${start.scriptName}). Use --include-server to run.`,
      );
      continue;
    }

    const relativeDir = path.relative(rootDir, start.dir) || '.';
    console.log(
      `\n→ ${start.packageName}:${start.scriptName}\n   pnpm -C ${relativeDir} run ${start.scriptName}\n   ${start.command}`,
    );

    if (dryRun) {
      continue;
    }

    await execa('pnpm', ['-C', start.dir, 'run', start.scriptName], {
      stdio: 'inherit',
    });
  }
};

const main = async () => {
  const { dryRun, filter, includeServer } = parseArgs(process.argv.slice(2));

  const starts = await collectStartScripts(filter);

  if (starts.length === 0) {
    console.log('No start scripts found under examples.');
    return;
  }

  console.log(
    `Found ${starts.length} start scripts under examples${filter ? ` (filtered by "${filter}")` : ''}.`,
  );

  await runStarts(starts, dryRun, includeServer);
};

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
