import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fork, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import type { NativeProviderOptions } from '@openai/agents';
import {
  runLocalConversation,
  useLocalStorage,
} from '../../../../examples/codex/local-storage';
import { ModelServer, call, message } from './fixtures/model-server';

const directories: string[] = [];
const children: ChildProcess[] = [];
afterEach(async () => {
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exit = new Promise<void>((resolve) =>
        child.once('exit', () => resolve()),
      );
      child.kill('SIGKILL');
      await exit;
    }),
  );
  await ModelServer.closeAll();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});

async function helperProcess(
  path: string,
  options: NativeProviderOptions,
  resume?: string,
) {
  const child = fork(
    fileURLToPath(
      new URL('./fixtures/local-storage-example-worker.ts', import.meta.url),
    ),
    [JSON.stringify({ path, options, resume })],
    {
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    },
  );
  children.push(child);
  let result:
    { type: string; pid: number; id: string; finalOutput: string } | undefined;
  let failure = '';
  child.stderr?.on('data', (data) => {
    failure += String(data);
  });
  child.on('message', (value) => {
    const message = value as {
      type: string;
      pid: number;
      id: string;
      finalOutput: string;
      message?: string;
    };
    if (message.type === 'result') result = message;
    else if (message.type === 'failure') failure += message.message;
  });
  await new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (code !== 0 || signal || !result)
        reject(
          new Error(`Example worker failed (${code}, ${signal}): ${failure}`),
        );
      else resolve();
    });
  });
  if (!result) throw new Error('Example worker returned no result');
  return result;
}
async function profile(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'local-storage-example-'));
  directories.push(path);
  return path;
}
async function providerOptions(
  server: ModelServer,
): Promise<NativeProviderOptions> {
  const config = await server.config();
  return {
    baseUrl: (config['model_providers.fixture'] as { base_url: string })
      .base_url,
    apiKey: 'synthetic-local-storage-example-key',
    supportsWebsockets: false,
  };
}

describe.skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')(
  'local storage example through the native runtime',
  () => {
    it('cold reopens the documented helper in a fresh process with current provider bindings', async () => {
      const first = new ModelServer([
        [
          call(
            'lookup',
            { key: 'original-record' },
            { callId: 'cold-source-lookup' },
          ),
        ],
        [message('Original lookup completed before process exit.')],
      ]);
      const second = new ModelServer([
        (request) => {
          const history = JSON.stringify(request.input);
          expect(history).toContain(
            'Original lookup completed before process exit.',
          );
          expect(history).toContain('cold-source-lookup');
          expect(history).toContain('original-record');
          expect(request.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'function_call_output',
                call_id: 'cold-source-lookup',
                output: JSON.stringify({
                  key: 'original-record',
                  value: 'current application value',
                }),
              }),
            ]),
          );
          return [
            call(
              'lookup',
              { key: 'current-record' },
              { callId: 'cold-current-lookup' },
            ),
          ];
        },
        (request) => {
          const input = JSON.stringify(request.input);
          expect(input).toContain('cold-current-lookup');
          expect(input).toContain('current-record');
          expect(input).toContain('current application value');
          expect(request.input).toEqual(
            expect.arrayContaining([
              expect.objectContaining({
                type: 'function_call_output',
                call_id: 'cold-current-lookup',
                output: JSON.stringify({
                  key: 'current-record',
                  value: 'current application value',
                }),
              }),
            ]),
          );
          return [message('Current helper completed in the new process.')];
        },
      ]);
      const path = await profile();
      const saved = await helperProcess(path, {
        ...(await providerOptions(first)),
        apiKey: 'synthetic-source-process-key',
      });
      const reopened = await helperProcess(
        path,
        {
          ...(await providerOptions(second)),
          apiKey: 'synthetic-current-process-key',
        },
        saved.id,
      );
      expect(saved.finalOutput).toBe(
        'Original lookup completed before process exit.',
      );
      expect(reopened.id).toBe(saved.id);
      expect(reopened.pid).not.toBe(saved.pid);
      expect(reopened.pid).not.toBe(process.pid);
      expect(reopened.finalOutput).toBe(
        'Current helper completed in the new process.',
      );
      expect(
        first.requestHeaders.map((headers) => headers.authorization),
      ).toEqual([
        'Bearer synthetic-source-process-key',
        'Bearer synthetic-source-process-key',
      ]);
      expect(
        second.requestHeaders.map((headers) => headers.authorization),
      ).toEqual([
        'Bearer synthetic-current-process-key',
        'Bearer synthetic-current-process-key',
      ]);
      first.assertExhausted();
      second.assertExhausted();
    }, 25000);

    it('closes and reopens the same conversation with its recorded preference', async () => {
      const server = new ModelServer([
        [message('I will remember your preference.')],
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'I prefer vegetarian meals.',
          );
          expect(JSON.stringify(request.input)).toContain(
            'What meal preference did I share?',
          );
          return [message('You prefer vegetarian meals.')];
        },
      ]);
      const result = await runLocalConversation(
        await profile(),
        await providerOptions(server),
      );
      expect(result.id).toBeTypeOf('string');
      expect(result.finalOutput).toBe('You prefer vegetarian meals.');
      expect(server.requests).toHaveLength(2);
      server.assertExhausted();
    }, 25000);

    it('keeps the record helper usable across closed providers with fresh credentials', async () => {
      const first = new ModelServer([
        [call('lookup', { key: 'example' }, { callId: 'first-lookup' })],
        [message('First lookup completed.')],
      ]);
      const second = new ModelServer([
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'First lookup completed.',
          );
          return [
            call('lookup', { key: 'example' }, { callId: 'second-lookup' }),
          ];
        },
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'current application value',
          );
          return [message('Current record read after reopen.')];
        },
      ]);
      const path = await profile();
      const saved = await useLocalStorage(
        path,
        undefined,
        await providerOptions(first),
      );
      const reopened = await useLocalStorage(path, saved.id, {
        ...(await providerOptions(second)),
        apiKey: 'synthetic-current-local-storage-key',
      });
      expect(reopened.id).toBe(saved.id);
      expect(reopened.finalOutput).toBe('Current record read after reopen.');
      expect(
        second.requestHeaders.map((headers) => headers.authorization),
      ).toEqual([
        'Bearer synthetic-current-local-storage-key',
        'Bearer synthetic-current-local-storage-key',
      ]);
      first.assertExhausted();
      second.assertExhausted();
    }, 25000);
  },
);
