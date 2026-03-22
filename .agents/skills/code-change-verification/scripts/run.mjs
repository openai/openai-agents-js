#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const { console, process, setTimeout } = globalThis;

const SIGNAL_EXIT_CODES = {
  SIGINT: 2,
  SIGKILL: 9,
  SIGTERM: 15,
};

const TERMINATION_GRACE_PERIOD_MS = 5_000;
const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = path.dirname(scriptPath);

function printUsage() {
  console.log(`code-change-verification

Usage:
  node .agents/skills/code-change-verification/scripts/run.mjs
`);
}

function getRepoRoot() {
  try {
    return execFileSync(
      'git',
      ['-C', scriptDir, 'rev-parse', '--show-toplevel'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      },
    ).trim();
  } catch {
    return path.resolve(scriptDir, '../../../..');
  }
}

function getPnpmCommand() {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}

function createPnpmStep(label, args) {
  return {
    label,
    command: getPnpmCommand(),
    args,
    commandText: `pnpm ${args.join(' ')}`,
  };
}

export function createDefaultPlan() {
  return {
    sequentialSteps: [
      createPnpmStep('install', ['i']),
      createPnpmStep('build', ['build']),
    ],
    parallelSteps: [
      createPnpmStep('build-check', ['-r', 'build-check']),
      createPnpmStep('dist-check', ['-r', '-F', '@openai/*', 'dist:check']),
      createPnpmStep('lint', ['lint']),
      createPnpmStep('test', ['test']),
    ],
  };
}

function splitBufferedLines(buffer) {
  return buffer.split(/\r\n|[\n\r]/);
}

function forwardPrefixedOutput(stream, target, label) {
  return new Promise((resolve, reject) => {
    let buffer = '';

    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      buffer += chunk;
      const lines = splitBufferedLines(buffer);
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        target.write(`[${label}] ${line}\n`);
      }
    });
    stream.on('error', reject);
    stream.on('end', () => {
      if (buffer) {
        target.write(`[${label}] ${buffer}\n`);
      }
      resolve();
    });
  });
}

function normalizeExitCode(code, signal) {
  if (typeof code === 'number') {
    return code;
  }
  if (signal && SIGNAL_EXIT_CODES[signal]) {
    return 128 + SIGNAL_EXIT_CODES[signal];
  }
  return 1;
}

function startStep(step, repoRoot) {
  console.log(`Running ${step.commandText}...`);

  const child = spawn(step.command, step.args, {
    cwd: repoRoot,
    detached: process.platform !== 'win32',
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const stdoutDone = forwardPrefixedOutput(
    child.stdout,
    process.stdout,
    step.label,
  );
  const stderrDone = forwardPrefixedOutput(
    child.stderr,
    process.stderr,
    step.label,
  );

  const result = new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(payload);
    };

    child.on('error', (error) => {
      finish({ code: 1, error, signal: null, step });
    });
    child.on('exit', (code, signal) => {
      finish({ code, error: null, signal, step });
    });
  }).then(async (payload) => {
    await Promise.allSettled([stdoutDone, stderrDone]);
    return {
      ...payload,
      exitCode: normalizeExitCode(payload.code, payload.signal),
    };
  });

  return { child, result, step };
}

async function killWindowsProcessTree(pid) {
  await new Promise((resolve) => {
    const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore',
    });
    killer.on('error', () => resolve());
    killer.on('exit', () => resolve());
  });
}

async function terminateRun(run, force = false) {
  const { child } = run;

  if (!child.pid) {
    return;
  }

  if (process.platform === 'win32') {
    await killWindowsProcessTree(child.pid);
    return;
  }

  const signal = force ? 'SIGKILL' : 'SIGTERM';
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      // Ignore termination races.
    }
  }
}

async function stopRemainingRuns(runs, failedLabel) {
  const survivors = runs.filter((run) => run.step.label !== failedLabel);
  await Promise.allSettled(survivors.map((run) => terminateRun(run)));
  await Promise.race([
    Promise.allSettled(survivors.map((run) => run.result)),
    new Promise((resolve) => setTimeout(resolve, TERMINATION_GRACE_PERIOD_MS)),
  ]);
  await Promise.allSettled(survivors.map((run) => terminateRun(run, true)));
}

async function runStep(step, repoRoot, activeRuns) {
  const run = startStep(step, repoRoot);
  activeRuns.add(run);
  const result = await run.result;
  activeRuns.delete(run);
  return result;
}

async function runParallelSteps(steps, repoRoot, activeRuns) {
  const runs = steps.map((step) => startStep(step, repoRoot));
  for (const run of runs) {
    activeRuns.add(run);
  }

  const allDone = Promise.all(runs.map((run) => run.result));
  const firstFailure = new Promise((resolve) => {
    for (const run of runs) {
      run.result.then((result) => {
        if (result.exitCode !== 0) {
          resolve(result);
        }
      });
    }
  });

  const outcome = await Promise.race([
    allDone.then((results) => ({ results, type: 'done' })),
    firstFailure.then((result) => ({ result, type: 'failed' })),
  ]);

  if (outcome.type === 'done') {
    const failedResult = outcome.results.find(
      (result) => result.exitCode !== 0,
    );
    for (const run of runs) {
      activeRuns.delete(run);
    }
    if (failedResult) {
      return {
        exitCode: failedResult.exitCode,
        failedStep: failedResult.step,
        results: outcome.results,
      };
    }
    return { exitCode: 0, failedStep: null, results: outcome.results };
  }

  console.error(
    `code-change-verification: ${outcome.result.step.commandText} failed with exit code ${outcome.result.exitCode}. Stopping remaining verification steps.`,
  );
  await stopRemainingRuns(runs, outcome.result.step.label);
  const results = await allDone;
  for (const run of runs) {
    activeRuns.delete(run);
  }
  return {
    exitCode: outcome.result.exitCode,
    failedStep: outcome.result.step,
    results,
  };
}

export async function runVerification(options = {}) {
  const defaultPlan = createDefaultPlan();
  const repoRoot = options.repoRoot ?? getRepoRoot();
  const sequentialSteps =
    options.sequentialSteps ?? defaultPlan.sequentialSteps;
  const parallelSteps = options.parallelSteps ?? defaultPlan.parallelSteps;
  const activeRuns = new Set();
  let interrupted = false;

  const handleSignal = async (signal) => {
    if (interrupted) {
      return;
    }
    interrupted = true;
    console.error(
      `code-change-verification: received ${signal}. Stopping running steps.`,
    );
    await Promise.allSettled(
      [...activeRuns].map((run) =>
        terminateRun(run, process.platform === 'win32'),
      ),
    );
    process.exit(128 + (SIGNAL_EXIT_CODES[signal] ?? 1));
  };

  process.once('SIGINT', handleSignal);
  process.once('SIGTERM', handleSignal);

  try {
    // Keep install and build as barriers before validations that can run independently.
    for (const step of sequentialSteps) {
      const result = await runStep(step, repoRoot, activeRuns);
      if (result.exitCode !== 0) {
        console.error(
          `code-change-verification: ${step.commandText} failed with exit code ${result.exitCode}.`,
        );
        return result.exitCode;
      }
    }

    const parallelResult = await runParallelSteps(
      parallelSteps,
      repoRoot,
      activeRuns,
    );
    if (parallelResult.exitCode !== 0) {
      return parallelResult.exitCode;
    }

    console.log('code-change-verification: all commands passed.');
    return 0;
  } finally {
    process.removeListener('SIGINT', handleSignal);
    process.removeListener('SIGTERM', handleSignal);
  }
}

function isDirectRun() {
  return path.resolve(process.argv[1] || '') === scriptPath;
}

if (isDirectRun()) {
  if (process.argv.includes('--help')) {
    printUsage();
    process.exit(0);
  }

  const exitCode = await runVerification();
  process.exit(exitCode);
}
