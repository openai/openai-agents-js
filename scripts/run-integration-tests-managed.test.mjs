import { describe, expect, it, vi } from 'vitest';
import { setImmediate as waitForImmediate } from 'node:timers/promises';
import process from 'node:process';
import {
  INTEGRATION_PIPELINE_STEPS,
  runManagedIntegrationTests,
  spawnProductionChild,
  waitForVerdaccio,
  withoutOpenAIKey,
} from './run-integration-tests-managed.mjs';

function memoryStream() {
  const chunks = [];
  return {
    chunks,
    write(chunk) {
      chunks.push(String(chunk));
    },
  };
}

function createOutput() {
  return { stdout: memoryStream(), stderr: memoryStream() };
}

function createLogs({ closeError } = {}) {
  return {
    pipeline: {
      ...memoryStream(),
      path: '/repo/.tmp/integration-tests-managed/test/pipeline.log',
    },
    registry: {
      ...memoryStream(),
      path: '/repo/.tmp/integration-tests-managed/test/verdaccio.log',
    },
    close: vi.fn(async () => {
      if (closeError) {
        throw closeError;
      }
    }),
  };
}

function createChild(name, { exitCode = 0, pending = false, stopError } = {}) {
  let resolveResult;
  let settled = !pending;
  const resultPromise = pending
    ? new Promise((resolve) => {
        resolveResult = resolve;
      })
    : Promise.resolve({ exitCode, signal: null });

  const child = {
    name,
    wait: vi.fn(() => resultPromise),
    settle(result = { exitCode, signal: null }) {
      if (!settled) {
        settled = true;
        resolveResult(result);
      }
    },
    terminate: vi.fn(async () => {
      if (stopError) {
        throw stopError;
      }
      if (!settled) {
        child.settle({ exitCode: 143, signal: 'SIGTERM' });
      }
      return { forced: false, result: await resultPromise };
    }),
  };

  return child;
}

function createRuntime({
  occupied = false,
  readinessError,
  failedStep,
  failedExitCode = 41,
  pendingStep,
  registryStopError,
  logsCloseError,
} = {}) {
  const logs = createLogs({ closeError: logsCloseError });
  const registry = createChild('Verdaccio', {
    pending: true,
    stopError: registryStopError,
  });
  const specifications = [];
  const children = new Map([['Verdaccio', registry]]);
  let signalHandler;

  const runtime = {
    logs,
    registry,
    specifications,
    children,
    isPortOccupied: vi.fn(async () => occupied),
    createLogs: vi.fn(async () => logs),
    spawn: vi.fn((specification) => {
      specifications.push(specification);
      if (specification.name === 'Verdaccio') {
        return registry;
      }
      const child = createChild(specification.name, {
        exitCode:
          specification.name === failedStep ? failedExitCode : undefined,
        pending: specification.name === pendingStep,
      });
      children.set(specification.name, child);
      return child;
    }),
    waitForVerdaccio: vi.fn(async () => {
      if (readinessError) {
        throw readinessError;
      }
    }),
    subscribeToSignals: vi.fn((handler) => {
      signalHandler = handler;
      return vi.fn();
    }),
    emitSignal(signal) {
      signalHandler(signal);
    },
  };

  return runtime;
}

const validEnvironment = {
  PATH: '/test/bin',
  OPENAI_API_KEY_SOURCE: 'service-account',
  OPENAI_API_KEY: 'service-account-key',
};

async function waitUntil(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) {
      return;
    }
    await waitForImmediate();
  }
  throw new Error('Condition was not reached.');
}

describe('runManagedIntegrationTests', () => {
  it.each([
    ['missing marker', { OPENAI_API_KEY: 'some-key' }],
    [
      'untrusted marker',
      {
        OPENAI_API_KEY: 'some-key',
        OPENAI_API_KEY_SOURCE: 'employee',
      },
    ],
    [
      'missing key',
      {
        OPENAI_API_KEY_SOURCE: 'service-account',
      },
    ],
  ])('starts no child when provenance is invalid: %s', async (_name, env) => {
    const runtime = createRuntime();

    const exitStatus = await runManagedIntegrationTests({
      cwd: '/repo',
      environment: env,
      output: createOutput(),
      runtime,
    });

    expect(exitStatus).toBe(78);
    expect(runtime.isPortOccupied).not.toHaveBeenCalled();
    expect(runtime.createLogs).not.toHaveBeenCalled();
    expect(runtime.spawn).not.toHaveBeenCalled();
  });

  it('refuses an occupied Verdaccio port without reusing or stopping it', async () => {
    const runtime = createRuntime({ occupied: true });
    const output = createOutput();

    const exitStatus = await runManagedIntegrationTests({
      cwd: '/repo',
      environment: validEnvironment,
      output,
      runtime,
    });

    expect(exitStatus).toBe(1);
    expect(runtime.spawn).not.toHaveBeenCalled();
    expect(output.stderr.chunks.join('')).toContain(
      'Refusing to reuse or terminate an unowned process',
    );
  });

  it('removes the API key from local children and gives only the validated environment to tests', async () => {
    const runtime = createRuntime();

    const exitStatus = await runManagedIntegrationTests({
      cwd: '/repo',
      environment: validEnvironment,
      output: createOutput(),
      runtime,
    });

    expect(exitStatus).toBe(0);
    expect(runtime.specifications.map(({ name }) => name)).toEqual([
      'Verdaccio',
      ...INTEGRATION_PIPELINE_STEPS.map(({ name }) => name),
    ]);
    expect(
      runtime.specifications.map(({ command, args }) => [command, args]),
    ).toEqual([
      [
        process.execPath,
        [
          expect.stringMatching(/node_modules\/verdaccio\/bin\/verdaccio$/),
          '--config',
          '/repo/verdaccio-config.yml',
        ],
      ],
      ['pnpm', ['i']],
      ['pnpm', ['build:ci']],
      ['pnpm', ['local-npm:reset']],
      ['pnpm', ['local-npm:publish']],
      ['pnpm', ['test:integration']],
    ]);

    const localChildren = runtime.specifications.filter(
      ({ name }) => name !== 'run integration tests',
    );
    for (const specification of localChildren) {
      expect(specification.env).not.toHaveProperty('OPENAI_API_KEY');
    }
    expect(runtime.specifications[0]).toMatchObject({ ipc: true });

    const integrationStep = runtime.specifications.find(
      ({ name }) => name === 'run integration tests',
    );
    expect(integrationStep.env).toMatchObject({
      OPENAI_API_KEY_SOURCE: 'service-account',
      OPENAI_API_KEY: 'service-account-key',
      OPENAI_AGENTS_RUN_STORAGE_MOUNT_INTEGRATION: '1',
    });
    expect(runtime.registry.terminate).toHaveBeenCalledTimes(1);
    expect(runtime.logs.close).toHaveBeenCalledTimes(1);
  });

  it('removes an inherited API key at the production child boundary', async () => {
    const previousKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = 'parent-only-test-key';
    const output = createOutput();
    const log = memoryStream();

    try {
      const child = spawnProductionChild(
        {
          name: 'local-only environment probe',
          command: process.execPath,
          args: [
            '--eval',
            'process.stdout.write(process.env.OPENAI_API_KEY ?? "missing")',
          ],
          cwd: process.cwd(),
          env: withoutOpenAIKey(process.env),
          log,
        },
        output,
      );

      await expect(child.wait()).resolves.toMatchObject({ exitCode: 0 });
      expect(output.stdout.chunks.join('')).toBe('missing');
      expect(log.chunks.join('')).toBe('missing');
    } finally {
      if (previousKey === undefined) {
        delete process.env.OPENAI_API_KEY;
      } else {
        process.env.OPENAI_API_KEY = previousKey;
      }
    }
  });

  it('rejects a racing Verdaccio bind failure before pipeline steps start', async () => {
    const runtime = createRuntime({
      readinessError: Object.assign(
        new Error('listen EADDRINUSE 127.0.0.1:4873'),
        {
          exitStatus: 2,
        },
      ),
    });
    const output = createOutput();

    const exitStatus = await runManagedIntegrationTests({
      cwd: '/repo',
      environment: validEnvironment,
      output,
      runtime,
    });

    expect(exitStatus).toBe(2);
    expect(runtime.specifications).toHaveLength(1);
    expect(runtime.registry.terminate).toHaveBeenCalledTimes(1);
    expect(output.stderr.chunks.join('')).toContain('EADDRINUSE');
  });

  it('does not accept another listener when the owned Verdaccio child loses the bind race', async () => {
    const never = new Promise(() => {});
    const child = {
      waitForIpcMessage: vi.fn(() => never),
      wait: vi.fn(async () => ({ exitCode: 2, signal: null })),
      isRunning: vi.fn(() => false),
    };

    await expect(
      waitForVerdaccio(child, { timeoutMs: 100 }),
    ).rejects.toMatchObject({
      message: 'Verdaccio exited before readiness (exit 2).',
      exitStatus: 2,
    });
    expect(child.waitForIpcMessage).toHaveBeenCalledTimes(1);
  });

  it('maps an owned Verdaccio exit 0 before readiness to failure', async () => {
    const never = new Promise(() => {});
    const child = {
      waitForIpcMessage: vi.fn(() => never),
      wait: vi.fn(async () => ({ exitCode: 0, signal: null })),
      isRunning: vi.fn(() => false),
    };

    await expect(
      waitForVerdaccio(child, { timeoutMs: 100 }),
    ).rejects.toMatchObject({
      message: 'Verdaccio exited before readiness (exit 0).',
      exitStatus: 1,
    });
  });

  it.each([
    [
      'Verdaccio readiness',
      {
        readinessError: Object.assign(new Error('registry not ready'), {
          exitStatus: 69,
        }),
      },
      69,
    ],
    ...INTEGRATION_PIPELINE_STEPS.map((step, index) => [
      step.name,
      { failedStep: step.name, failedExitCode: 40 + index },
      40 + index,
    ]),
  ])(
    'runs cleanup once and retains the original status when %s fails',
    async (_name, runtimeOptions, expectedStatus) => {
      const runtime = createRuntime(runtimeOptions);
      const output = createOutput();

      const exitStatus = await runManagedIntegrationTests({
        cwd: '/repo',
        environment: validEnvironment,
        output,
        runtime,
      });

      expect(exitStatus).toBe(expectedStatus);
      expect(runtime.registry.terminate).toHaveBeenCalledTimes(1);
      expect(runtime.logs.close).toHaveBeenCalledTimes(1);
      if (_name === 'Verdaccio readiness') {
        expect(output.stderr.chunks.join('')).toContain(
          'failed during wait for Verdaccio readiness',
        );
      } else {
        expect(output.stderr.chunks.join('')).toContain(
          `Step failed: ${_name} (exit ${expectedStatus}).`,
        );
      }
    },
  );

  it.each([
    [55, 55],
    [0, 1],
  ])(
    'stops an active step when Verdaccio exits %i after readiness',
    async (registryStatus, expectedStatus) => {
      const runtime = createRuntime({ pendingStep: 'install dependencies' });
      const output = createOutput();
      const runPromise = runManagedIntegrationTests({
        cwd: '/repo',
        environment: validEnvironment,
        output,
        runtime,
      });

      await waitUntil(() => runtime.specifications.length === 2);
      runtime.registry.settle({ exitCode: registryStatus, signal: null });

      await expect(runPromise).resolves.toBe(expectedStatus);
      expect(
        runtime.children.get('install dependencies').terminate,
      ).toHaveBeenCalledTimes(1);
      expect(runtime.registry.terminate).toHaveBeenCalledTimes(1);
      expect(runtime.logs.close).toHaveBeenCalledTimes(1);
      expect(output.stderr.chunks.join('')).toContain(
        `failed during install dependencies: Verdaccio exited after readiness (exit ${registryStatus}).`,
      );
    },
  );

  it('does not start the next step when Verdaccio exits between steps', async () => {
    const runtime = createRuntime();
    const output = createOutput();
    const originalWrite = output.stdout.write;
    output.stdout.write = (chunk) => {
      originalWrite.call(output.stdout, chunk);
      if (String(chunk).includes('Step completed: install dependencies.')) {
        runtime.registry.settle({ exitCode: 56, signal: null });
      }
    };

    const exitStatus = await runManagedIntegrationTests({
      cwd: '/repo',
      environment: validEnvironment,
      output,
      runtime,
    });

    expect(exitStatus).toBe(56);
    expect(runtime.specifications.map(({ name }) => name)).toEqual([
      'Verdaccio',
      'install dependencies',
    ]);
    expect(runtime.registry.terminate).toHaveBeenCalledTimes(1);
    expect(runtime.logs.close).toHaveBeenCalledTimes(1);
    expect(output.stderr.chunks.join('')).toContain(
      'Verdaccio exited after readiness (exit 56).',
    );
  });

  it('retains the pipeline failure when cleanup also fails', async () => {
    const runtime = createRuntime({
      failedStep: 'build packages',
      failedExitCode: 52,
      registryStopError: new Error('registry would not stop'),
    });
    const output = createOutput();

    const exitStatus = await runManagedIntegrationTests({
      cwd: '/repo',
      environment: validEnvironment,
      output,
      runtime,
    });

    expect(exitStatus).toBe(52);
    expect(runtime.registry.terminate).toHaveBeenCalledTimes(1);
    expect(output.stderr.chunks.join('')).toContain(
      'Cleanup failed: failed to stop Verdaccio',
    );
  });

  it('fails an otherwise successful run when owned cleanup fails', async () => {
    const runtime = createRuntime({
      registryStopError: new Error('registry would not stop'),
    });
    const output = createOutput();

    const exitStatus = await runManagedIntegrationTests({
      cwd: '/repo',
      environment: validEnvironment,
      output,
      runtime,
    });

    expect(exitStatus).toBe(1);
    expect(runtime.registry.terminate).toHaveBeenCalledTimes(1);
    expect(runtime.logs.close).toHaveBeenCalledTimes(1);
    expect(output.stderr.chunks.join('')).toContain(
      'Cleanup failed: failed to stop Verdaccio',
    );
    expect(output.stdout.chunks.join('')).not.toContain(
      'Managed integration pipeline completed successfully.',
    );
  });

  it('fails an otherwise successful run when managed logs cannot close', async () => {
    const runtime = createRuntime({
      logsCloseError: new Error('log flush failed'),
    });
    const output = createOutput();

    const exitStatus = await runManagedIntegrationTests({
      cwd: '/repo',
      environment: validEnvironment,
      output,
      runtime,
    });

    expect(exitStatus).toBe(1);
    expect(runtime.registry.terminate).toHaveBeenCalledTimes(1);
    expect(runtime.logs.close).toHaveBeenCalledTimes(1);
    expect(output.stderr.chunks.join('')).toContain(
      'Unable to close managed integration logs: log flush failed',
    );
    expect(output.stdout.chunks.join('')).not.toContain(
      'Managed integration pipeline completed successfully.',
    );
  });

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ])('cleans up exactly once for %s and returns %i', async (signal, status) => {
    const runtime = createRuntime({ pendingStep: 'install dependencies' });
    const runPromise = runManagedIntegrationTests({
      cwd: '/repo',
      environment: validEnvironment,
      output: createOutput(),
      runtime,
    });

    await waitUntil(() => runtime.specifications.length === 2);
    runtime.emitSignal(signal);

    await expect(runPromise).resolves.toBe(status);
    expect(
      runtime.children.get('install dependencies').terminate,
    ).toHaveBeenCalledTimes(1);
    expect(runtime.registry.terminate).toHaveBeenCalledTimes(1);
    expect(runtime.logs.close).toHaveBeenCalledTimes(1);
  });
});
