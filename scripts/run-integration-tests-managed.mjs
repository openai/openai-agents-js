import { constants as osConstants } from 'node:os';
import { createServer } from 'node:net';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { finished } from 'node:stream/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';

const repositoryRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
const require = createRequire(import.meta.url);
const verdaccioBinPath = require.resolve('verdaccio/bin/verdaccio');

export const VERDACCIO_PORT = 4873;
export const VERDACCIO_URL = `http://127.0.0.1:${VERDACCIO_PORT}/`;

export const INTEGRATION_PIPELINE_STEPS = [
  {
    name: 'install dependencies',
    command: 'pnpm',
    args: ['i'],
    environment: 'local',
  },
  {
    name: 'build packages',
    command: 'pnpm',
    args: ['build:ci'],
    environment: 'local',
  },
  {
    name: 'reset local registry storage',
    command: 'pnpm',
    args: ['local-npm:reset'],
    environment: 'local',
  },
  {
    name: 'publish packages to local registry',
    command: 'pnpm',
    args: ['local-npm:publish'],
    environment: 'local',
  },
  {
    name: 'run integration tests',
    command: 'pnpm',
    args: ['test:integration'],
    environment: 'validated',
  },
];

class ManagedIntegrationError extends Error {
  constructor(message, exitStatus = 1) {
    super(message);
    this.name = 'ManagedIntegrationError';
    this.exitStatus = exitStatus;
  }
}

export function validateServiceAccountEnvironment(environment) {
  if (environment.OPENAI_API_KEY_SOURCE !== 'service-account') {
    throw new ManagedIntegrationError(
      'Refusing to run integration tests without OPENAI_API_KEY_SOURCE=service-account.',
      78,
    );
  }

  if (!environment.OPENAI_API_KEY?.trim()) {
    throw new ManagedIntegrationError(
      'Refusing to run integration tests without OPENAI_API_KEY.',
      78,
    );
  }

  return { ...environment };
}

export function withoutOpenAIKey(environment) {
  const localEnvironment = { ...environment };
  delete localEnvironment.OPENAI_API_KEY;
  return localEnvironment;
}

function timestampForPath(date) {
  return date.toISOString().replace(/[-:.]/g, '');
}

function createLogSink(filePath) {
  const stream = createWriteStream(filePath, { flags: 'wx' });
  let closePromise;

  return {
    path: filePath,
    write(chunk) {
      stream.write(chunk);
    },
    close() {
      if (!closePromise) {
        stream.end();
        closePromise = finished(stream);
      }
      return closePromise;
    },
  };
}

async function createTimestampedLogs({ cwd, now }) {
  const timestamp = timestampForPath(now());
  const logsRoot = path.join(cwd, '.tmp', 'integration-tests-managed');
  await mkdir(logsRoot, { recursive: true });
  const logDirectory = await mkdtemp(path.join(logsRoot, `${timestamp}-`));

  return {
    pipeline: createLogSink(path.join(logDirectory, 'pipeline.log')),
    registry: createLogSink(path.join(logDirectory, 'verdaccio.log')),
    async close() {
      await Promise.all([this.pipeline.close(), this.registry.close()]);
    },
  };
}

async function isPortOccupied(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();

    server.once('error', (error) => {
      if (error?.code === 'EADDRINUSE') {
        resolve(true);
        return;
      }
      reject(error);
    });

    server.once('listening', () => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(false);
      });
    });

    server.listen({ host: '127.0.0.1', port, exclusive: true });
  });
}

function normalizeChildResult(resultOrError) {
  const signal = resultOrError?.signal ?? null;
  const signalNumber = signal ? osConstants.signals[signal] : undefined;
  const exitCode = Number.isInteger(resultOrError?.exitCode)
    ? resultOrError.exitCode
    : signalNumber
      ? 128 + signalNumber
      : resultOrError?.code === 'ENOENT'
        ? 127
        : 1;

  return { exitCode, signal };
}

export function spawnProductionChild(specification, output) {
  const subprocess = execa(specification.command, specification.args, {
    cwd: specification.cwd,
    env: specification.env,
    extendEnv: false,
    stdin: 'inherit',
    stdout: 'pipe',
    stderr: 'pipe',
    reject: false,
    cleanup: false,
    ipc: specification.ipc ?? false,
  });

  let observedOutput = '';
  const recordOutput = (chunk) => {
    observedOutput = `${observedOutput}${String(chunk)}`.slice(-131_072);
  };

  subprocess.stdout?.on('data', (chunk) => {
    recordOutput(chunk);
    output.stdout.write(chunk);
    specification.log.write(chunk);
  });
  subprocess.stderr?.on('data', (chunk) => {
    recordOutput(chunk);
    output.stderr.write(chunk);
    specification.log.write(chunk);
  });

  let settledResult;
  const resultPromise = subprocess
    .then((result) => normalizeChildResult(result))
    .catch((error) => normalizeChildResult(error))
    .then((result) => {
      settledResult = result;
      return result;
    });
  let terminationPromise;

  return {
    name: specification.name,
    isRunning() {
      return settledResult === undefined;
    },
    resultIfSettled() {
      return settledResult;
    },
    outputIncludes(text) {
      return observedOutput.includes(text);
    },
    waitForIpcMessage() {
      return subprocess.getOneMessage();
    },
    wait() {
      return resultPromise;
    },
    terminate() {
      if (!terminationPromise) {
        terminationPromise = (async () => {
          if (settledResult !== undefined) {
            return { forced: false, result: settledResult };
          }

          subprocess.kill('SIGTERM');
          const gracefulResult = await Promise.race([
            resultPromise,
            delay(5_000).then(() => null),
          ]);
          if (gracefulResult !== null) {
            return { forced: false, result: gracefulResult };
          }

          subprocess.kill('SIGKILL');
          return { forced: true, result: await resultPromise };
        })();
      }
      return terminationPromise;
    },
  };
}

function verdaccioExitError(result, timing) {
  const status = result.exitCode === 0 ? 1 : result.exitCode;
  return new ManagedIntegrationError(
    `Verdaccio exited ${timing} (exit ${result.exitCode}).`,
    status,
  );
}

export async function waitForVerdaccio(child, { timeoutMs = 30_000 } = {}) {
  const childExit = child.wait().then((result) => {
    throw verdaccioExitError(result, 'before readiness');
  });
  const ownershipMessage = child.waitForIpcMessage().catch(async () => {
    await childExit;
  });
  const message = await Promise.race([
    ownershipMessage,
    childExit,
    delay(timeoutMs).then(() => {
      throw new ManagedIntegrationError(
        `Verdaccio did not become ready at ${VERDACCIO_URL} within ${timeoutMs}ms.`,
        1,
      );
    }),
  ]);

  if (message?.verdaccio_started !== true || !child.isRunning()) {
    throw new ManagedIntegrationError(
      'Verdaccio did not provide an owned post-bind readiness signal.',
      1,
    );
  }
}

function subscribeToSignals(handler) {
  const handlers = new Map();
  for (const signal of ['SIGINT', 'SIGTERM']) {
    const listener = () => handler(signal);
    handlers.set(signal, listener);
    process.once(signal, listener);
  }

  return () => {
    for (const [signal, listener] of handlers) {
      process.removeListener(signal, listener);
    }
  };
}

export function createProductionRuntime(output = process) {
  return {
    createLogs: createTimestampedLogs,
    isPortOccupied,
    spawn(specification) {
      return spawnProductionChild(specification, output);
    },
    waitForVerdaccio,
    subscribeToSignals,
  };
}

function writeLine(stream, message) {
  stream.write(`${message}\n`);
}

function commandLabel(step) {
  return [step.command, ...step.args].join(' ');
}

function errorExitStatus(error) {
  return Number.isInteger(error?.exitStatus) ? error.exitStatus : 1;
}

export async function runManagedIntegrationTests({
  cwd = repositoryRoot,
  environment = process.env,
  now = () => new Date(),
  output = process,
  runtime = createProductionRuntime(output),
} = {}) {
  let validatedEnvironment;
  try {
    validatedEnvironment = validateServiceAccountEnvironment(environment);
  } catch (error) {
    writeLine(output.stderr, error.message);
    return errorExitStatus(error);
  }

  try {
    if (await runtime.isPortOccupied(VERDACCIO_PORT)) {
      writeLine(
        output.stderr,
        `Port ${VERDACCIO_PORT} is already in use. Refusing to reuse or terminate an unowned process; stop it manually before retrying.`,
      );
      return 1;
    }
  } catch (error) {
    writeLine(
      output.stderr,
      `Unable to verify that port ${VERDACCIO_PORT} is available: ${error.message}`,
    );
    return 1;
  }

  let logs;
  try {
    logs = await runtime.createLogs({ cwd, now });
  } catch (error) {
    writeLine(
      output.stderr,
      `Unable to create managed integration logs: ${error.message}`,
    );
    return 1;
  }

  const localEnvironment = withoutOpenAIKey(validatedEnvironment);
  const integrationEnvironment = {
    ...validatedEnvironment,
    OPENAI_AGENTS_RUN_STORAGE_MOUNT_INTEGRATION: '1',
  };
  let registryChild = null;
  let registryExitPromise = null;
  let registryExitResult;
  let activePipelineChild = null;
  let cleanupPromise;
  let receivedSignal = null;
  let exitStatus = 0;
  let currentOperation = 'initialize managed integration pipeline';

  const reportInfo = (message) => {
    writeLine(output.stdout, message);
    writeLine(logs.pipeline, message);
  };
  const reportError = (message) => {
    writeLine(output.stderr, message);
    writeLine(logs.pipeline, message);
  };

  const cleanup = () => {
    if (!cleanupPromise) {
      cleanupPromise = (async () => {
        const failures = [];
        const pipelineChild = activePipelineChild;
        const ownedRegistry = registryChild;
        activePipelineChild = null;
        registryChild = null;

        if (pipelineChild) {
          try {
            await pipelineChild.terminate();
          } catch (error) {
            failures.push(
              `failed to stop ${pipelineChild.name}: ${error.message}`,
            );
          }
        }

        if (ownedRegistry) {
          try {
            await ownedRegistry.terminate();
          } catch (error) {
            failures.push(`failed to stop Verdaccio: ${error.message}`);
          }
        }

        return { ok: failures.length === 0, failures };
      })();
    }
    return cleanupPromise;
  };

  const signalExitStatus = () =>
    receivedSignal === 'SIGINT'
      ? 130
      : receivedSignal === 'SIGTERM'
        ? 143
        : null;

  const unsubscribe = runtime.subscribeToSignals((signal) => {
    if (receivedSignal) {
      return;
    }
    receivedSignal = signal;
    reportError(`Received ${signal}; stopping the managed integration run.`);
    void cleanup();
  });

  try {
    reportInfo(`Pipeline log: ${path.relative(cwd, logs.pipeline.path)}`);
    reportInfo(`Verdaccio log: ${path.relative(cwd, logs.registry.path)}`);
    reportInfo('Starting owned Verdaccio process.');
    currentOperation = 'start Verdaccio';

    registryChild = runtime.spawn({
      name: 'Verdaccio',
      command: process.execPath,
      args: [
        verdaccioBinPath,
        '--config',
        path.join(cwd, 'verdaccio-config.yml'),
      ],
      cwd,
      env: localEnvironment,
      log: logs.registry,
      ipc: true,
    });

    currentOperation = 'wait for Verdaccio readiness';
    await runtime.waitForVerdaccio(registryChild);
    registryExitPromise = registryChild.wait().then((result) => {
      registryExitResult = result;
      return result;
    });

    const ensureRegistryIsRunning = async () => {
      await Promise.resolve();
      if (registryExitResult !== undefined) {
        throw verdaccioExitError(registryExitResult, 'after readiness');
      }
    };

    if (receivedSignal) {
      exitStatus = signalExitStatus();
    } else {
      reportInfo(`Verdaccio is ready at ${VERDACCIO_URL}.`);
    }

    for (const step of INTEGRATION_PIPELINE_STEPS) {
      if (receivedSignal || exitStatus !== 0) {
        break;
      }

      await ensureRegistryIsRunning();

      reportInfo(`Starting step: ${step.name}`);
      reportInfo(`$ ${commandLabel(step)}`);
      currentOperation = step.name;
      const child = runtime.spawn({
        name: step.name,
        command: step.command,
        args: step.args,
        cwd,
        env:
          step.environment === 'validated'
            ? integrationEnvironment
            : localEnvironment,
        log: logs.pipeline,
      });
      activePipelineChild = child;
      const outcome = await Promise.race([
        child.wait().then((result) => ({ kind: 'step', result })),
        registryExitPromise.then((result) => ({ kind: 'registry', result })),
      ]);

      if (receivedSignal) {
        exitStatus = signalExitStatus();
        break;
      }

      if (outcome.kind === 'registry') {
        throw verdaccioExitError(outcome.result, 'after readiness');
      }

      const { result } = outcome;
      if (activePipelineChild === child) {
        activePipelineChild = null;
      }

      if (result.exitCode !== 0) {
        exitStatus = result.exitCode;
        reportError(`Step failed: ${step.name} (exit ${result.exitCode}).`);
        break;
      }

      reportInfo(`Step completed: ${step.name}.`);
    }

    if (exitStatus === 0 && !receivedSignal) {
      await ensureRegistryIsRunning();
      reportInfo('All managed integration pipeline steps completed.');
    }
  } catch (error) {
    if (exitStatus === 0) {
      exitStatus = signalExitStatus() ?? errorExitStatus(error);
    }
    reportError(
      `Managed integration pipeline failed during ${currentOperation}: ${error.message}`,
    );
  } finally {
    const cleanupResult = await cleanup();
    if (cleanupResult.ok) {
      reportInfo('Cleanup completed successfully.');
    } else {
      reportError(`Cleanup failed: ${cleanupResult.failures.join('; ')}`);
      if (exitStatus === 0 && !receivedSignal) {
        exitStatus = 1;
      }
    }

    unsubscribe();
    try {
      await logs.close();
    } catch (error) {
      writeLine(
        output.stderr,
        `Unable to close managed integration logs: ${error.message}`,
      );
      if (exitStatus === 0 && !receivedSignal) {
        exitStatus = 1;
      }
    }
  }

  const finalStatus =
    exitStatus === 0 ? (signalExitStatus() ?? exitStatus) : exitStatus;
  if (finalStatus === 0) {
    writeLine(
      output.stdout,
      'Managed integration pipeline completed successfully.',
    );
  }
  return finalStatus;
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  runManagedIntegrationTests()
    .then((exitStatus) => {
      process.exitCode = exitStatus;
    })
    .catch((error) => {
      writeLine(
        process.stderr,
        `Managed integration runner crashed: ${error.message}`,
      );
      process.exitCode = 1;
    });
}
