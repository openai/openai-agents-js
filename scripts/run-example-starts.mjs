import console from 'node:console';
import fs from 'node:fs/promises';
import { createWriteStream, readFileSync } from 'node:fs';
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
 *   node scripts/run-example-starts.mjs --print-auto-skip        # show the auto-skip list and exit
 *   node scripts/run-example-starts.mjs --collect <main_log> [--output <path>]  # generate rerun list from a main log
 *
 * Via package.json:
 *   pnpm examples:start-all --dry-run
 *   pnpm examples:start-all --filter basic
 *   pnpm examples:start-all --include-interactive
 */
export const START_PATTERN = /^start(?::|$)/;
export const SERVER_COMMAND_KEYWORDS = [
  'next',
  'vite',
  'serve',
  'server',
  'dev ',
];
export const SERVER_PATH_KEYWORDS = ['realtime', 'nextjs'];
export const AUDIO_PATH_KEYWORDS = ['realtime', 'voice', 'audio'];
export const EXTERNAL_COMMAND_KEYWORDS = [
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

export const DEFAULT_INTERACTIVE_INPUTS = new Map([
  ['agent-patterns:start:agents-as-tools', 'Hello to Spanish and French\n'],
  ['agent-patterns:start:agents-as-tools-conditional', '2\nHello\n'],
  ['agent-patterns:start:deterministic', 'A short sci-fi story\n'],
  ['agent-patterns:start:llm-as-a-judge', 'A detective story\n'],
  ['agent-patterns:start:parallelization', 'Good morning\n'],
  // routing loops; leave interactive by hand
  ['basic:start:chat', 'exit()\n'],
  ['basic:start:previous-response-id', 'n\n'],
  ['customer-service:start', 'What are your store hours?\nexit\n'],
  ['financial-research-agent:start', 'AAPL latest earnings summary\n'],
  ['research-bot:start', 'Impact of electric vehicles on the grid\n'],
  ['handoffs:start:is-enabled', '2\nHello\n'],
  ['memory:start:file', 'n\n'],
  ['memory:start:memory', 'n\n'],
  ['memory:start:oai', 'n\n'],
  ['mcp:start:tool-filter', 'n\n'],
]);

export const DEFAULT_AUTO_SKIP = [
  // Tends to loop multiple times and produce very long output; skip in auto runs.
  'agent-patterns:start:llm-as-a-judge',
  // Endless readline loop; not meaningful in auto mode.
  'agent-patterns:start:routing',
  // readline close issues / interactive loop
  'customer-service:start',
  // Requires external connector auth not available in auto runs.
  'connectors:start',
  // Approval-prompt examples that still need manual input.
  'mcp:start:hosted-mcp-on-approval',
  'mcp:start:hosted-mcp-human-in-the-loop',
];

const EXPECTED_FAILURE_PATTERNS = [
  {
    name: 'connectors:start',
    match: /must specify 'authorization' parameter with 'connector_id'/i,
    reason:
      'Connector sample requires external authorization not provided in auto run.',
  },
  {
    name: 'model-providers:start:custom-example-global',
    match: /please set example_base_url.*example_api_key.*example_model_name/i,
    reason: 'Custom provider sample needs EXAMPLE_* envs.',
  },
  {
    name: 'model-providers:start:custom-example-provider',
    match: /please set example_base_url.*example_api_key.*example_model_name/i,
    reason: 'Custom provider sample needs EXAMPLE_* envs.',
  },
];

const parseArgs = (args) => {
  let dryRun = false;
  let filter = null;
  // Environment overrides allow CI/automation to skip interactive/server/audio/external by default.
  // CLI flags still take precedence when explicitly provided.
  const defaultIncludeServer = envFlag('EXAMPLES_INCLUDE_SERVER') ?? false;
  const defaultIncludeInteractive =
    envFlag('EXAMPLES_INCLUDE_INTERACTIVE') ?? false;
  const defaultIncludeAudio = envFlag('EXAMPLES_INCLUDE_AUDIO') ?? false;
  const defaultIncludeExternal = envFlag('EXAMPLES_INCLUDE_EXTERNAL') ?? false;
  const envInteractiveModeRaw =
    process.env.EXAMPLES_INTERACTIVE_MODE?.toLowerCase();
  const envInteractiveMode =
    envInteractiveModeRaw === 'auto'
      ? 'auto'
      : envInteractiveModeRaw === 'prompt'
        ? 'prompt'
        : null;
  const defaultInteractiveMode = envInteractiveMode ?? 'auto';

  let printAutoSkip = false;
  let collectLog = null;
  let collectOutput = null;

  let includeServer = defaultIncludeServer;
  let includeInteractive = defaultIncludeInteractive;
  let includeAudio = defaultIncludeAudio;
  let includeExternal = defaultIncludeExternal;
  let failFast = false;
  let verbose = false;
  let interactiveMode = defaultInteractiveMode;

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

    if (arg === '--auto-input') {
      interactiveMode = 'auto';
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

    if (arg === '--print-auto-skip') {
      printAutoSkip = true;
      continue;
    }

    if (arg === '--collect') {
      collectLog = args[index + 1] ?? null;
      index += 1;
      continue;
    }

    if (arg === '--output') {
      collectOutput = args[index + 1] ?? null;
      index += 1;
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
    interactiveMode,
    failFast,
    verbose,
    printAutoSkip,
    collectLog,
    collectOutput,
  };
};

const envFlag = (name) => {
  const value = process.env[name];
  if (value === undefined) {
    return null;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
};

const INTERACTIVE_SOURCE_KEYWORDS = [
  'interruptions',
  'auto_approve_hitl',
  'auto_approve_mcp',
  'approve(',
  'reject(',
];

const interactiveSourceCache = new Map();

const resolveScriptPath = (start) => {
  const tokens = start.command.split(/\s+/);
  for (const rawToken of tokens) {
    const token = rawToken.replace(/^['"]|['"]$/g, '');
    if (token.startsWith('-')) {
      continue;
    }
    if (/\.(mjs|cjs|js|mts|cts|ts|tsx)$/i.test(token)) {
      return path.resolve(start.dir, token);
    }
  }
  return null;
};

const isLikelyInteractiveFromSource = (start) => {
  const scriptPath = resolveScriptPath(start);
  if (!scriptPath) {
    return false;
  }

  if (interactiveSourceCache.has(scriptPath)) {
    return interactiveSourceCache.get(scriptPath);
  }

  try {
    const source = readFileSync(scriptPath, 'utf-8').toLowerCase();
    const hasSignal = INTERACTIVE_SOURCE_KEYWORDS.some((keyword) =>
      source.includes(keyword),
    );
    interactiveSourceCache.set(scriptPath, hasSignal);
    return hasSignal;
  } catch (_error) {
    interactiveSourceCache.set(scriptPath, false);
    return false;
  }
};

const isInteractiveStart = (start) => {
  const name = `${start.packageName}:${start.scriptName}`;
  const keyWithDir = `${path.basename(start.dir)}:${start.scriptName}`;
  const nameLower = name.toLowerCase();
  const commandLower = start.command.toLowerCase();
  return (
    nameLower.includes('hitl') ||
    nameLower.includes('human-in-the-loop') ||
    nameLower.includes('human_in_the_loop') ||
    commandLower.includes('human-in-the-loop') ||
    commandLower.includes('readline') ||
    isLikelyInteractiveFromSource(start) ||
    DEFAULT_INTERACTIVE_INPUTS.has(name) ||
    DEFAULT_INTERACTIVE_INPUTS.has(keyWithDir)
  );
};

export const loadAutoSkip = () => {
  const envList = process.env.EXAMPLES_AUTO_SKIP;
  if (envList && envList.trim()) {
    return new Set(
      envList
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean),
    );
  }
  return new Set(DEFAULT_AUTO_SKIP);
};

const detectTagsFromName = (name) => {
  const lower = name.toLowerCase();
  const tags = new Set();
  if (
    SERVER_COMMAND_KEYWORDS.some((keyword) => lower.includes(keyword)) ||
    SERVER_PATH_KEYWORDS.some((keyword) => lower.includes(keyword))
  ) {
    tags.add('server');
  }
  if (AUDIO_PATH_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    tags.add('audio');
  }
  if (EXTERNAL_COMMAND_KEYWORDS.some((keyword) => lower.includes(keyword))) {
    tags.add('external');
  }
  return tags;
};

export const collectRerunFromLog = ({
  logPath,
  includeServer = false,
  includeAudio = false,
  includeExternal = false,
  autoSkipSet = loadAutoSkip(),
}) => {
  if (!logPath) {
    throw new Error('logPath is required for collectRerunFromLog');
  }
  const tableRow = /^(passed|failed|skipped|unknown)\s+([^\s]+)/;
  const entries = {};
  const lines = readFileSync(logPath, 'utf-8').split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const m = tableRow.exec(trimmed);
    if (m) {
      let [, status, name] = m;
      if (name.includes('…')) {
        const prefix = name.split('…', 1)[0];
        for (const existing of Object.keys(entries)) {
          if (existing.startsWith(prefix)) {
            name = existing;
            break;
          }
        }
      }
      entries[name] = status;
      continue;
    }
    const skip = /^↷ Skipping ([^ ]+)/.exec(trimmed);
    if (skip) {
      entries[skip[1]] = 'skipped';
      continue;
    }
    const fail = /!! ([^ ]+) exited with (\d+)/.exec(trimmed);
    if (fail) {
      entries[fail[1]] = `failed:${fail[2]}`;
    }
  }

  const allowedByFlags = (name) => {
    const tags = detectTagsFromName(name);
    if (tags.has('server') && !includeServer) return false;
    if (tags.has('audio') && !includeAudio) return false;
    if (tags.has('external') && !includeExternal) return false;
    return true;
  };

  return [...Object.entries(entries)]
    .filter(
      ([name, status]) =>
        status !== 'passed' &&
        status !== 'pending' &&
        !autoSkipSet.has(name) &&
        (!status.startsWith('skipped') || allowedByFlags(name)),
    )
    .map(([name]) => name)
    .sort((a, b) => a.localeCompare(b));
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

  if (
    SERVER_COMMAND_KEYWORDS.some((keyword) => commandLower.includes(keyword)) ||
    SERVER_PATH_KEYWORDS.some((keyword) => dirLower.includes(keyword))
  ) {
    tags.add('server');
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

  if (isInteractiveStart(start)) {
    tags.add('interactive');
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

const validateLog = async ({ start, logFile, exitCode }) => {
  if (!logFile) {
    return { status: 'unknown', reason: 'missing-log-path' };
  }
  let logText = '';
  try {
    logText = await fs.readFile(logFile, 'utf-8');
  } catch (_error) {
    return { status: 'unknown', reason: 'log-read-failed' };
  }

  if (!logText.trim()) {
    return { status: 'unexpected', reason: 'log-empty' };
  }

  if (exitCode === 0) {
    return { status: 'ok' };
  }

  const expected = EXPECTED_FAILURE_PATTERNS.find((pattern) => {
    const name = `${start.packageName}:${start.scriptName}`;
    return (
      (pattern.name === name || name.endsWith(pattern.name)) &&
      pattern.match.test(logText)
    );
  });

  if (expected) {
    return { status: 'expected-failure', reason: expected.reason };
  }

  return { status: 'unexpected', reason: 'exit-nonzero-no-match' };
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

const runStarts = async (
  starts,
  dryRun,
  overrides,
  interactiveMode,
  failFast,
  verbose,
  autoSkipSet,
) => {
  let executed = 0;
  let skipped = 0;
  let failed = 0;
  let unexpected = 0;
  let expectedFailures = 0;
  let validationUnknown = 0;
  const baseTimeoutMs =
    Number(process.env.EXAMPLES_EXECA_TIMEOUT_MS) || 300_000;
  const concurrency = Math.max(
    1,
    Number(process.env.EXAMPLES_CONCURRENCY) || 4,
  );
  const logsDir = path.join(rootDir, '.tmp', 'examples-start-logs');
  await fs.mkdir(logsDir, { recursive: true });
  const running = new Set();
  const results = [];
  let cancelled = false;
  const requestCancel = (reason) => {
    if (cancelled) {
      return;
    }
    cancelled = true;
    console.error(`\nCancellation requested: ${reason}. Stopping workers…`);
    for (const child of running) {
      try {
        child.kill('SIGTERM');
      } catch {
        // ignore
      }
    }
  };

  const sigHandler = (signal) => {
    requestCancel(`received ${signal}`);
  };
  process.on('SIGINT', sigHandler);
  process.on('SIGTERM', sigHandler);

  let index = 0;
  const next = () => {
    if (cancelled) return null;
    if (index >= starts.length) return null;
    const start = starts[index];
    index += 1;
    return start;
  };

  const worker = async () => {
    while (true) {
      const start = next();
      if (!start) {
        return;
      }
      const { skip, reasons } = shouldSkip(start.tags, overrides);
      const tagLabel =
        verbose && start.tags.size ? ` ${formatTags(start.tags)}` : '';

      const autoSkip =
        interactiveMode === 'auto' &&
        autoSkipSet.has(`${start.packageName}:${start.scriptName}`);

      if (skip) {
        const reasonLabel = reasons.size
          ? ` (skipped: ${[...reasons].sort().join(', ')})`
          : '';
        const relativeDir = path.relative(rootDir, start.dir) || '.';
        console.log(
          `\n↷ Skipping ${start.packageName}:${start.scriptName}${tagLabel}${reasonLabel}. pnpm -C ${relativeDir} run ${start.scriptName}`,
        );
        skipped += 1;
        results.push({ start, status: 'skipped', reason: 'tag' });
        continue;
      }

      if (autoSkip) {
        const relativeDir = path.relative(rootDir, start.dir) || '.';
        console.log(
          `\n↷ Skipping ${start.packageName}:${start.scriptName}${tagLabel} (auto-skip list). pnpm -C ${relativeDir} run ${start.scriptName}`,
        );
        skipped += 1;
        results.push({ start, status: 'skipped', reason: 'auto-skip' });
        continue;
      }

      const relativeDir = path.relative(rootDir, start.dir) || '.';
      console.log(
        `\n→ ${start.packageName}:${start.scriptName}${tagLabel}\n   pnpm -C ${relativeDir} run ${start.scriptName}\n   ${start.command}`,
      );

      if (dryRun) {
        results.push({ start, status: 'dry-run' });
        continue;
      }

      let logFile;
      let logStream;
      const flushLogStream = () =>
        new Promise((resolve) => {
          if (!logStream) {
            resolve();
            return;
          }
          if (logStream.closed) {
            resolve();
            return;
          }
          logStream.end(() => resolve());
        });
      try {
        const key = `${start.packageName}:${start.scriptName}`;
        const dirKey = `${path.basename(start.dir)}:${start.scriptName}`;
        const resolvedAutoInput =
          DEFAULT_INTERACTIVE_INPUTS.get(key) ??
          DEFAULT_INTERACTIVE_INPUTS.get(dirKey) ??
          process.env.EXAMPLES_INTERACTIVE_DEFAULT_INPUT;
        const autoInput =
          interactiveMode === 'auto' && resolvedAutoInput
            ? resolvedAutoInput
            : undefined;

        if (interactiveMode === 'auto') {
          const label =
            autoInput && start.tags.has('interactive')
              ? '[auto-input enabled]'
              : start.tags.has('interactive')
                ? '[interactive: no auto-input configured]'
                : autoInput
                  ? '[auto-input enabled]'
                  : '[auto-input not found for this script]';
          console.log(`   ${label}`);
        }

        const timeout =
          start.packageName === 'financial-research-agent'
            ? 600_000
            : start.scriptName.includes('computer-use')
              ? 600_000
              : baseTimeoutMs;

        const childEnv = { ...process.env };
        if (interactiveMode === 'auto' && start.tags.has('interactive')) {
          childEnv.AUTO_APPROVE_HITL =
            childEnv.AUTO_APPROVE_HITL ?? (autoInput ? '1' : '1');
        }
        if (start.scriptName.includes('apply-patch')) {
          childEnv.APPLY_PATCH_AUTO_APPROVE =
            childEnv.APPLY_PATCH_AUTO_APPROVE ?? '1';
        }
        if (start.scriptName.includes('shell')) {
          childEnv.SHELL_AUTO_APPROVE =
            childEnv.SHELL_AUTO_APPROVE ?? childEnv.AUTO_APPROVE_HITL ?? '1';
        }
        if (start.packageName === 'mcp') {
          childEnv.AUTO_APPROVE_MCP =
            childEnv.AUTO_APPROVE_MCP ?? childEnv.AUTO_APPROVE_HITL ?? '1';
        }

        logFile = path.join(
          logsDir,
          `${start.packageName.replace(/[^\w.-]/g, '_')}__${start.scriptName.replace(/[^\w.-]/g, '_')}.log`,
        );
        // Truncate per-script log on each run so only the latest execution remains.
        logStream = createWriteStream(logFile, { flags: 'w' });
        console.log(`   log: ${path.relative(rootDir, logFile)}`);

        const child = execa(
          'pnpm',
          ['-C', start.dir, 'run', start.scriptName],
          {
            stdio: 'pipe',
            input: autoInput,
            env: childEnv,
            timeout,
          },
        );
        if (child.stdout) {
          child.stdout.pipe(logStream);
        }
        if (child.stderr) {
          child.stderr.pipe(logStream);
        }
        running.add(child);
        try {
          await child;
          await flushLogStream();
          executed += 1;
          const validation = await validateLog({ start, logFile, exitCode: 0 });
          if (validation.status === 'unexpected') {
            unexpected += 1;
          } else if (validation.status === 'unknown') {
            validationUnknown += 1;
          }
          results.push({
            start,
            status: 'passed',
            logFile,
            usedAutoInput: Boolean(autoInput),
            validation,
          });
        } finally {
          running.delete(child);
          if (logStream && !logStream.closed) {
            logStream.end();
          }
        }
      } catch (error) {
        failed += 1;
        const exitCode =
          typeof error?.exitCode === 'number' ? error.exitCode : 'unknown';
        console.error(
          `   !! ${start.packageName}:${start.scriptName} exited with ${exitCode}`,
        );
        await flushLogStream();
        if (exitCode === 0) {
          const validation = await validateLog({ start, logFile, exitCode: 0 });
          if (validation.status === 'unexpected') {
            unexpected += 1;
          } else if (validation.status === 'unknown') {
            validationUnknown += 1;
          }
          results.push({
            start,
            status: 'passed',
            logFile,
            validation,
            usedAutoInput: Boolean(
              interactiveMode === 'auto' &&
              (start.tags.has('interactive') ||
                DEFAULT_INTERACTIVE_INPUTS.has(
                  `${start.packageName}:${start.scriptName}`,
                )),
            ),
          });
          continue;
        }

        const validation = await validateLog({ start, logFile, exitCode });
        if (validation.status === 'expected-failure') {
          expectedFailures += 1;
        } else if (validation.status === 'unexpected') {
          unexpected += 1;
        } else if (validation.status === 'unknown') {
          validationUnknown += 1;
        }
        results.push({
          start,
          status: 'failed',
          exitCode,
          logFile,
          validation,
          usedAutoInput: Boolean(
            interactiveMode === 'auto' &&
            (start.tags.has('interactive') ||
              DEFAULT_INTERACTIVE_INPUTS.has(
                `${start.packageName}:${start.scriptName}`,
              )),
          ),
        });
        if (failFast) {
          requestCancel('fail-fast');
          return;
        }
      }
      if (cancelled) {
        return;
      }
    }
  };

  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);

  console.log(
    `\nDone. Ran ${executed} start script(s), skipped ${skipped}, failed ${failed}.`,
  );

  const failedList = results.filter((r) => r.status === 'failed');
  if (failedList.length) {
    console.log('Failures:');
    for (const item of failedList) {
      const validationLabel =
        item.validation?.status === 'expected-failure'
          ? ` (expected: ${item.validation.reason})`
          : item.validation?.status === 'unexpected'
            ? ' (unexpected)'
            : item.validation?.status === 'unknown'
              ? ' (validation unavailable)'
              : '';
      console.log(
        ` - ${item.start.packageName}:${item.start.scriptName} (exit ${item.exitCode})${validationLabel}`,
      );
    }
  }

  console.log(
    `Validation summary: unexpected=${unexpected}, expected_failures=${expectedFailures}, unknown=${validationUnknown}.`,
  );

  const formatCell = (text, width) =>
    (text ?? '').length > width
      ? `${text.slice(0, width - 1)}…`
      : (text ?? '').padEnd(width, ' ');

  const rows = results.map((r) => {
    const name = `${r.start.packageName}:${r.start.scriptName}`;
    const status = r.status;
    let info = '';
    if (status === 'failed') {
      info =
        r.validation?.reason ??
        (typeof r.exitCode === 'number' ? `exit ${r.exitCode}` : 'failed');
    } else if (status === 'skipped') {
      info = r.reason ?? 'skipped';
    } else if (r.validation?.status === 'unexpected') {
      info = `unexpected: ${r.validation.reason ?? ''}`;
    } else if (status === 'passed') {
      info = r.usedAutoInput ? 'exit 0 (auto-input)' : 'exit 0';
    } else {
      info = 'ok';
    }
    const logPath = r.logFile ? path.relative(rootDir, r.logFile) : '-';
    return {
      status,
      name,
      info,
      logPath,
    };
  });

  const statusW = 10;
  const nameW = 42;
  const infoW = 50;
  console.log('\nAll start results:');
  console.log(
    `${formatCell('status', statusW)} ${formatCell('package:script', nameW)} ${formatCell('info', infoW)} log`,
  );
  console.log(
    `${'-'.repeat(statusW)} ${'-'.repeat(nameW)} ${'-'.repeat(infoW)} ---`,
  );
  for (const row of rows) {
    console.log(
      `${formatCell(row.status, statusW)} ${formatCell(row.name, nameW)} ${formatCell(row.info, infoW)} ${row.logPath}`,
    );
  }

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
    interactiveMode,
    failFast,
    verbose,
    printAutoSkip,
    collectLog,
    collectOutput,
  } = parseArgs(process.argv.slice(2));

  const starts = await collectStartScripts(filter);
  const autoSkipSet = loadAutoSkip();

  if (collectLog) {
    const resolvedLog = path.isAbsolute(collectLog)
      ? collectLog
      : path.resolve(process.cwd(), collectLog);
    const list = collectRerunFromLog({
      logPath: resolvedLog,
      includeServer,
      includeAudio,
      includeExternal,
      autoSkipSet,
    });
    if (collectOutput) {
      const outPath = path.isAbsolute(collectOutput)
        ? collectOutput
        : path.resolve(process.cwd(), collectOutput);
      await fs.writeFile(outPath, list.join('\n'), 'utf-8');
      console.log(`Wrote ${list.length} entries to ${outPath}`);
    } else {
      for (const item of list) console.log(item);
    }
    return 0;
  }

  if (printAutoSkip) {
    console.log('Auto-skip list (source: EXAMPLES_AUTO_SKIP or defaults):');
    for (const item of Array.from(autoSkipSet).sort()) {
      console.log(` - ${item}`);
    }
    return 0;
  }

  if (starts.length === 0) {
    console.log('No start scripts found under examples.');
    return 0;
  }

  console.log(`Interactive mode: ${interactiveMode}`);

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

  return runStarts(
    starts,
    dryRun,
    overrides,
    interactiveMode,
    failFast,
    verbose,
    autoSkipSet,
  );
};

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode ?? 0;
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
