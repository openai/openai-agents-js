import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import type { SessionState } from '@openai/agents';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

type WorkerResult = {
  pid: number;
} & (
  | {
      ok: true;
      before: unknown[];
      after: unknown[];
      output: unknown;
      state: SessionState;
    }
  | { ok: false; details: string }
);

async function worker(
  model: ModelServer,
  executor: { url: string; cwd: string },
  authorization: string,
  state?: SessionState,
): Promise<WorkerResult> {
  const config = await model.config();
  return new Promise((resolve, reject) => {
    const child = fork(
      fileURLToPath(
        new URL('./fixtures/retained-executor-worker.ts', import.meta.url),
      ),
      [
        JSON.stringify({
          modelUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          executorUrl: executor.url,
          cwd: executor.cwd,
          authorization,
          state,
        }),
      ],
      {
        execArgv: ['--stack-size=16384', '--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    let result: WorkerResult | undefined;
    let stderr = '';
    let spawnError: Error | undefined;
    let timedOut = false;
    const deadline = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, 25_000);
    child.stdout?.resume();
    child.stderr?.on('data', (data) => {
      stderr += String(data);
    });
    child.on('message', (value) => {
      result = value as WorkerResult;
    });
    child.once('error', (error) => {
      spawnError = error;
    });
    // close joins the process and its stdio, including on timeout or failure.
    child.once('close', (code, signal) => {
      clearTimeout(deadline);
      if (
        spawnError ||
        timedOut ||
        signal ||
        !result ||
        code !== (result.ok ? 0 : 1)
      ) {
        reject(
          spawnError ??
            new Error(
              `Executor worker did not finish: ${code}/${signal}; timeout=${timedOut}; ${stderr}`,
            ),
        );
      } else resolve(result);
    });
  });
}

function commandOutput(request: JsonObject, callId: string) {
  return JSON.stringify(
    (request.input as JsonObject[]).filter(
      (item) => item.type === 'function_call_output' && item.call_id === callId,
    ),
  );
}

it.skipIf(
  process.env.GITHUB_ACTIONS !== 'true' &&
    process.env.OPENAI_AGENTS_TEST_IN_CODEX_SANDBOX === '1' &&
    process.env.OPENAI_AGENTS_REQUIRE_LOCAL_SANDBOX !== '1',
)('reconnects fresh clients to one retained executor with current credentials', async () => {
  const executor = await startPublicExecutor();
  const oldAuthorization = executor.headers.Authorization;
  const currentAuthorization = 'Bearer synthetic-reconnected-executor-token';
  const marker = join(executor.cwd, 'reconnect-marker.txt');
  const starts = () =>
    executor.requests.filter((request) => request.method === 'process/start');
  const command = 'cat reconnect-marker.txt';
  try {
    // The application retains this fixture and its files; state does not recreate them.
    await writeFile(marker, 'resource-before-reconnect');
    const source = new ModelServer([
      [call('exec_command', { cmd: command }, { callId: 'source-read' })],
      (request) => {
        expect(commandOutput(request, 'source-read')).toContain(
          'resource-before-reconnect',
        );
        return [message('source complete')];
      },
    ]);
    const first = await worker(source, executor, oldAuthorization);
    if (!first.ok) throw new Error(first.details);
    expect(first.output).toBe('source complete');
    expect(starts()).toHaveLength(1);
    source.assertExhausted();

    await writeFile(marker, 'resource-after-reconnect');
    executor.headers.Authorization = currentAuthorization;
    const destination = new ModelServer([
      (request) => {
        expect(JSON.stringify(request.input)).toContain('source complete');
        return [
          call(
            'exec_command',
            { cmd: command },
            { callId: 'destination-read' },
          ),
        ];
      },
      (request) => {
        const output = commandOutput(request, 'destination-read');
        expect(output).toContain('resource-after-reconnect');
        expect(output).not.toContain('resource-before-reconnect');
        return [message('destination complete')];
      },
    ]);
    const second = await worker(
      destination,
      executor,
      currentAuthorization,
      first.state,
    );
    if (!second.ok) throw new Error(second.details);
    expect(second.pid).not.toBe(first.pid);
    expect(second.before).toEqual(first.after);
    expect(second.output).toBe('destination complete');
    expect(starts()).toHaveLength(2);
    expect(executor.rejectedUpgrades).toHaveLength(0);
    expect(await readFile(marker, 'utf8')).toBe('resource-after-reconnect');
    destination.assertExhausted();

    const requestsBeforeDenial = executor.requests.length;
    const deniedMarker = join(
      executor.cwd,
      `rejected-write-${randomUUID()}.txt`,
    );
    const quotedMarker = `'${deniedMarker.replaceAll("'", "'\\''")}'`;
    const deniedCommand = `printf %s 'unexpected-host-fallback' > ${quotedMarker} && ${command}`;
    await expect(access(deniedMarker)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const rejected = new ModelServer([
      [
        call(
          'exec_command',
          { cmd: deniedCommand },
          { callId: 'rejected-write' },
        ),
      ],
      (request) => {
        const outputs = (request.input as JsonObject[]).filter(
          (item) =>
            item.type === 'function_call_output' &&
            item.call_id === 'rejected-write',
        );
        expect(outputs).toHaveLength(1);
        const output = JSON.stringify(outputs[0]!.output);
        expect(output).toMatch(/error|failed|failure|unauthorized|401/i);
        expect(output).not.toContain('resource-after-reconnect');
        return [message('access denied')];
      },
    ]);
    const denied = await worker(
      rejected,
      executor,
      oldAuthorization,
      second.state,
    );
    // A tool failure may end the turn or be returned to the scripted model.
    if (denied.ok) expect(denied.output).toBe('access denied');
    else expect(denied.details.length).toBeGreaterThan(0);
    expect(executor.rejectedUpgrades.length).toBeGreaterThan(0);
    expect(new Set(executor.rejectedUpgrades)).toEqual(new Set([401]));
    expect(executor.requests).toHaveLength(requestsBeforeDenial);
    expect(starts()).toHaveLength(2);
    await expect(access(deniedMarker)).rejects.toMatchObject({
      code: 'ENOENT',
    });
    for (const token of [oldAuthorization, currentAuthorization]) {
      expect(JSON.stringify([first, second, denied])).not.toContain(
        token.replace(/^Bearer /, ''),
      );
    }
  } finally {
    await executor.close();
  }
  await expect(access(marker)).rejects.toMatchObject({ code: 'ENOENT' });
}, 100_000);
