import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  Environment,
  NativeError,
  NativeProvider,
  type ExecutorContext,
} from '@openai/agents';
import type { JsonObject, JsonValue } from '../../src/runtime/binding';
import { TurnAborted } from '../../src/runtime/session';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

it
  .skipIf(process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1')
  .each(['allow', 'deny', 'cancel'] as const)(
  'nonempty terminal input retains its original action and policy: %s',
  async (choice) => {
    const executor = await startPublicExecutor();
    const release = Promise.withResolvers<boolean>();
    try {
      const input = 'synthetic-terminal-input\n';
      const entered = Promise.withResolvers<void>();
      let processId: number | undefined;
      const output = (request: JsonObject, callId: string) => {
        const item = (request.input as JsonObject[]).find(
          (item) =>
            item.type === 'function_call_output' && item.call_id === callId,
        );
        expect(item).toBeDefined();
        return String(item!.output);
      };
      const responses: ConstructorParameters<typeof ModelServer>[0] = [
        [
          call(
            'exec_command',
            {
              cmd: 'IFS= read -r line; printf \'%s\\n\' "$line" > terminal-input; printf \'received:%s\\n\' "$line"',
              workdir: executor.cwd,
              tty: true,
              yield_time_ms: 1000,
            },
            { callId: 'start-terminal' },
          ),
        ],
        (request) => {
          const match = output(request, 'start-terminal').match(
            /Process running with session ID (\d+)/,
          );
          expect(match).not.toBeNull();
          processId = Number(match![1]);
          expect(Number.isSafeInteger(processId)).toBe(true);
          return [
            call(
              'write_stdin',
              { session_id: processId, chars: input, yield_time_ms: 1000 },
              { callId: 'original-terminal-input' },
            ),
          ];
        },
        ...(choice === 'allow'
          ? [
              (request: JsonObject) => {
                expect(output(request, 'original-terminal-input')).toContain(
                  'received:synthetic-terminal-input',
                );
                return [message('input consumed')];
              },
            ]
          : []),
      ];
      const model = new ModelServer(responses);
      const config = await model.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as { base_url: string })
          .base_url,
        apiKey: 'synthetic-terminal-policy',
        supportsWebsockets: false,
      });
      const context = { owner: 'synthetic-terminal' };
      const approvals: Array<{
        info: ExecutorContext<typeof context>;
        args: JsonValue;
      }> = [];
      const environment = new Environment({
        url: executor.url,
        cwd: executor.cwd,
        headers: executor.headers,
        tools: ['exec_command', 'write_stdin'],
        approval(info: ExecutorContext<typeof context>, args) {
          approvals.push({ info, args });
          if (info.toolName === 'exec_command') return true;
          expect(info.toolName).toBe('write_stdin');
          entered.resolve();
          return choice === 'cancel' ? release.promise : choice === 'allow';
        },
      });
      const agent = new Agent<typeof context>({
        instructions: 'Read one line using the selected terminal.',
        model: 'gpt-5.5',
        provider,
      });
      await using session = await agent.session({ context, environment });
      const turn = await session.submit('Send the original line.');
      try {
        const completion = turn.wait({ until: 'interaction' });
        completion.catch(() => {});
        let settled = false;
        void completion.then(
          () => {
            settled = true;
          },
          () => {
            settled = true;
          },
        );
        await Promise.race([
          entered.promise,
          completion.then(() => {
            throw new Error('Turn settled before the terminal input policy');
          }),
        ]);
        const selected = approvals.filter(
          ({ info }) => info.toolName === 'write_stdin',
        );
        expect(selected).toHaveLength(1);
        const { info, args } = selected[0]!;
        expect(info.agent).toBe(agent);
        expect(info.session).toBe(session);
        expect(info.submission).toBe(turn);
        expect(info.context).toBe(context);
        expect(info.call).toMatchObject({
          sessionId: session.id,
          turnId: turn.turnId,
          childId: null,
          callId: 'original-terminal-input',
          route: 'direct',
        });
        expect(args).toEqual({
          session_id: processId,
          chars: input,
          yield_time_ms: 1000,
        });
        const effect = join(executor.cwd, 'terminal-input');
        if (choice === 'cancel') {
          // Leave the entered approval unanswered while other work can run.
          await new Promise<void>((resolve) => setImmediate(resolve));
          expect(settled).toBe(false);
          expect(model.requests).toHaveLength(2);
          expect(
            executor.requests.some(
              (request) =>
                request.method === 'process/write' &&
                (request.params as JsonObject)?.chunk ===
                  Buffer.from(input).toString('base64'),
            ),
          ).toBe(false);
          await expect(readFile(effect, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
          });
          const stopping = turn.cancel({ mode: 'force' });
          stopping.catch(() => {});
          // A true result delivered after the public force fence is not permission.
          release.resolve(true);
          await stopping;
          await expect(completion).rejects.toBeInstanceOf(TurnAborted);
        } else if (choice === 'deny') {
          await expect(completion).rejects.toBeInstanceOf(NativeError);
        } else {
          const result = await completion;
          if ('requests' in result)
            throw new Error(
              'Ordinary terminal input requested extra authority',
            );
          expect(result.finalOutput).toBe('input consumed');
          expect(await readFile(effect, 'utf8')).toBe(input);
        }
        const chunk = Buffer.from(input).toString('base64');
        const writes = executor.requests.filter(
          (request) =>
            request.method === 'process/write' &&
            (request.params as JsonObject)?.chunk === chunk,
        );
        if (choice === 'allow') {
          const starts = executor.requests.filter(
            (request) =>
              request.method === 'process/start' &&
              JSON.stringify(request.params).includes('terminal-input'),
          );
          expect(starts).toHaveLength(1);
          const remoteProcessId = (starts[0]!.params as JsonObject).processId;
          expect(remoteProcessId).toBeTypeOf('string');
          expect(writes).toHaveLength(1);
          expect(writes[0]?.params).toMatchObject({
            processId: remoteProcessId,
            chunk,
          });
        } else {
          expect(writes).toEqual([]);
          await expect(readFile(effect, 'utf8')).rejects.toMatchObject({
            code: 'ENOENT',
          });
        }
        model.assertExhausted();
      } finally {
        // Release before Session disposal, which joins any entered callback.
        release.resolve(true);
      }
    } finally {
      release.resolve(true);
      await executor.close();
    }
  },
  30_000,
);
