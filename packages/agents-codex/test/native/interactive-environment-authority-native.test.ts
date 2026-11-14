import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { Agent, Environment, NativeProvider } from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

function output(request: JsonObject, callId: string): string {
  const item = (request.input as JsonObject[]).find(
    (item) => item.type === 'function_call_output' && item.call_id === callId,
  );
  expect(item, `missing output for ${callId}`).toBeDefined();
  return typeof item!.output === 'string'
    ? item!.output
    : JSON.stringify(item!.output);
}

it.each([
  ['foreign-write', true, 'target-input\n'],
  ['foreign-poll', true, ''],
  ['inherited-environment', false, 'target-input\n'],
] as const)(
  'keeps an interactive handle within its current native environment: %s',
  async (_mode, distinct, chars) => {
    let collected = '';
    const executor = await startPublicExecutor({
      syntheticTerminal: true,
      onProcessOutput(notification) {
        const params = notification.params as JsonObject;
        if (typeof params.chunk === 'string') {
          collected += Buffer.from(params.chunk, 'base64').toString();
        }
      },
    });
    try {
      const other = join(executor.cwd, 'other');
      await mkdir(other);
      let processId = -1;
      const server = new ModelServer([
        [
          call(
            'exec_command',
            {
              cmd: 'held-command',
              tty: true,
              login: false,
              yield_time_ms: 1,
            },
            { callId: 'start' },
          ),
        ],
        [message('ready')],
        () => [
          call(
            'write_stdin',
            {
              session_id: processId,
              chars: 'source-input\n',
              yield_time_ms: 1,
            },
            { callId: 'source-write' },
          ),
        ],
        [call('transfer_to_target', {}, { callId: 'handoff' })],
        async () => {
          await executor.emitSyntheticOutput(
            executor.syntheticStarts[0],
            'LATE_SOURCE_OUTPUT',
          );
          return [
            call(
              'write_stdin',
              { session_id: processId, chars, yield_time_ms: 1 },
              { callId: 'target-use' },
            ),
            call(
              'write_stdin',
              { session_id: -1, chars, yield_time_ms: 1 },
              { callId: 'missing-use' },
            ),
          ];
        },
        [call('transfer_to_root', {}, { callId: 'return' })],
        () => [
          call(
            'write_stdin',
            { session_id: processId, chars: '', yield_time_ms: 1 },
            { callId: 'source-return' },
          ),
        ],
        [message('done')],
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-terminal-ownership',
        supportsWebsockets: false,
      });
      const environment = (cwd: string) =>
        new Environment({
          url: executor.url,
          headers: executor.headers,
          cwd,
          tools: ['exec_command', 'write_stdin'],
          writePolicy: 'legacy',
        });
      const target: Agent = new Agent({
        name: 'Target',
        instructions: 'Use the supplied terminal.',
        model: 'gpt-5.5',
        provider,
        environment: distinct ? environment(other) : undefined,
        handoffs: [() => root],
      });
      const root: Agent = new Agent({
        name: 'Root',
        instructions: 'Start a terminal then transfer.',
        model: 'gpt-5.5',
        provider,
        handoffs: [target],
      });
      await using session = await root.session({
        environment: environment(executor.cwd),
      });
      expect((await (await session.submit('Start.')).wait()).finalOutput).toBe(
        'ready',
      );
      const found = /session ID (\d+)/.exec(
        output(server.requests[1], 'start'),
      );
      expect(found, output(server.requests[1], 'start')).not.toBeNull();
      processId = Number(found![1]);
      expect(
        (await (await session.submit('Transfer, then return.')).wait())
          .finalOutput,
      ).toBe('done');
      expect(output(server.requests[3], 'source-write')).toContain(
        'Process running with session ID',
      );
      const targetOutput = output(server.requests[5], 'target-use');
      const missingOutput = output(server.requests[5], 'missing-use');
      const returned = output(server.requests[7], 'source-return');
      expect(collected).toContain('LATE_SOURCE_OUTPUT');
      if (distinct) {
        expect(targetOutput).not.toContain('LATE_SOURCE_OUTPUT');
        expect(returned).toContain('LATE_SOURCE_OUTPUT');
        expect(targetOutput.replaceAll(String(processId), '<id>')).toBe(
          missingOutput.replaceAll('-1', '<id>'),
        );
      } else {
        expect(targetOutput).toContain('LATE_SOURCE_OUTPUT');
        expect(returned).not.toContain('LATE_SOURCE_OUTPUT');
      }
      const writes = executor.requests
        .filter((request) => request.method === 'process/write')
        .map((request) =>
          Buffer.from(
            (request.params as JsonObject).chunk as string,
            'base64',
          ).toString(),
        );
      expect(writes).toEqual(
        distinct ? ['source-input\n'] : ['source-input\n', 'target-input\n'],
      );
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  45000,
);
