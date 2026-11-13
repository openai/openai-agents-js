import OpenAI from 'openai';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import {
  Agent,
  ChatCompletionsModel,
  Environment,
  NativeProvider,
} from '../../src';
import type { JsonObject } from '../../src/runtime/binding';
import { ModelServer, call, message } from './fixtures/model-server';
import { startPublicExecutor } from './fixtures/public-executor';

afterEach(() => ModelServer.closeAll());

const nativeIt = it.skipIf(process.platform === 'win32');

nativeIt.each(['responses', 'lite', 'chat'] as const)(
  'has been retaining explicit native tool authority across %s compaction settings',
  async (transport) => {
    const executor = await startPublicExecutor();
    try {
      for (const compact of [false, true]) {
        const before = executor.requests.filter(
          (row) => row.method === 'process/start',
        ).length;
        const server = new ModelServer([
          [
            call(
              'exec_command',
              { cmd: 'printf native-defaults', login: false },
              { callId: 'default-shell' },
            ),
          ],
          [message('done')],
        ]);
        const config = await server.config();
        let chatRequests = 0;
        const client = new OpenAI({
          apiKey: 'fixture',
          maxRetries: 0,
          fetch: async (_url, init) => {
            chatRequests++;
            if (chatRequests === 2) {
              const body = JSON.parse(String(init?.body)) as {
                messages: JsonObject[];
              };
              expect(
                JSON.stringify(
                  body.messages.filter((item) => item.role === 'tool'),
                ),
              ).toContain('native-defaults');
            }

            return Response.json({
              id: `chat_${chatRequests}`,
              choices: [
                {
                  finish_reason: chatRequests === 1 ? 'tool_calls' : 'stop',
                  message:
                    chatRequests === 1
                      ? {
                          role: 'assistant',
                          content: null,
                          tool_calls: [
                            {
                              id: 'default-shell',
                              type: 'function',
                              function: {
                                name: 'exec_command',
                                arguments: JSON.stringify({
                                  cmd: 'printf native-defaults',
                                  login: false,
                                }),
                              },
                            },
                          ],
                        }
                      : { role: 'assistant', content: 'done' },
                },
              ],
            });
          },
        });
        await using provider =
          transport === 'chat'
            ? new NativeProvider({
                modelBackend: new ChatCompletionsModel(
                  client,
                  'fixture-native-defaults',
                ),
                supportsWebsockets: false,
                responseMode: 'buffered',
              })
            : new NativeProvider({
                baseUrl: (config['model_providers.fixture'] as JsonObject)
                  .base_url as string,
                apiKey: 'fixture',
                supportsWebsockets: false,
              });
        const agent = new Agent({
          instructions: 'Run the command.',
          provider,
          model:
            transport === 'lite' ? 'gpt-5.6-sol' : 'fixture-native-defaults',
          modelSettings: compact
            ? { providerCompaction: { type: 'dynamic' } }
            : undefined,
        });
        const environment = new Environment({
          url: executor.url,
          headers: executor.headers,
          cwd: executor.cwd,
          tools: ['exec_command', 'write_stdin', 'apply_patch'],
        });
        const run = async () => {
          await using session = await agent.session({ environment });
          return (await (await session.submit('Run the command.')).wait())
            .finalOutput;
        };
        if (compact && transport !== 'responses') {
          await expect(run()).rejects.toThrow(
            transport === 'lite'
              ? /standard Responses|Responses Lite/
              : /Responses-only request controls/,
          );
          expect(
            executor.requests.filter((row) => row.method === 'process/start'),
          ).toHaveLength(before);
          expect(server.requests).toHaveLength(0);
          expect(chatRequests).toBe(0);
        } else {
          expect(await run()).toBe('done');
          expect(
            executor.requests.filter((row) => row.method === 'process/start'),
          ).toHaveLength(before + 1);
          if (transport === 'chat') expect(chatRequests).toBe(2);
          else {
            expect(server.requests).toHaveLength(2);
            const outputs = (server.requests[1].input as JsonObject[]).filter(
              (item) => item.type === 'function_call_output',
            );
            expect(JSON.stringify(outputs)).toContain('native-defaults');

            for (const request of server.requests) {
              if (compact)
                expect(request.context_management).toEqual([
                  { type: 'compaction', compact_threshold: 240000 },
                ]);
              else expect(request).not.toHaveProperty('context_management');
            }
            server.assertExhausted();
          }
        }
      }
    } finally {
      await executor.close();
    }
  },
  30000,
);

nativeIt.each(['responses', 'lite'] as const)(
  'has been composing native filesystem and terminal controls through existing owners: %s',
  async (transport) => {
    const executor = await startPublicExecutor();
    try {
      const path = join(executor.cwd, 'default-file.txt');
      const moved = join(executor.cwd, 'moved-file.txt');
      await writeFile(
        join(executor.cwd, 'pixel.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
          'base64',
        ),
      );
      const patch = (id: string, input: string): JsonObject => ({
        type: 'custom_tool_call',
        name: 'apply_patch',
        call_id: id,
        input: `*** Begin Patch\n${input}\n*** End Patch`,
      });
      const output = (request: JsonObject, id: string) => {
        const item = (request.input as JsonObject[]).find(
          (item) => item.type === 'function_call_output' && item.call_id === id,
        );
        expect(item).toBeDefined();
        return String(item!.output);
      };
      const server = new ModelServer([
        [patch('create-file', '*** Add File: default-file.txt\n+one')],
        async () => {
          expect(await readFile(path, 'utf8')).toBe('one\n');
          return [
            patch(
              'update-file',
              '*** Update File: default-file.txt\n@@\n-one\n+two',
            ),
          ];
        },
        async () => {
          expect(await readFile(path, 'utf8')).toBe('two\n');
          return [
            patch(
              'move-file',
              '*** Update File: default-file.txt\n*** Move to: moved-file.txt\n@@\n-two\n+three',
            ),
          ];
        },
        async () => {
          expect(await readFile(moved, 'utf8')).toBe('three\n');
          await expect(readFile(path)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          return [patch('delete-file', '*** Delete File: moved-file.txt')];
        },
        async () => {
          await expect(readFile(moved)).rejects.toMatchObject({
            code: 'ENOENT',
          });
          return [
            call(
              'view_image',
              { path: 'pixel.png' },
              { callId: 'native-image' },
            ),
          ];
        },
        (request) => {
          expect(JSON.stringify(request.input)).toContain(
            'data:image/png;base64,',
          );
          return [
            call(
              'exec_command',
              {
                cmd: 'printf terminal-ready; read -r answer; printf "terminal-done:%s" "$answer"',
                login: false,
                tty: true,
                yield_time_ms: 1,
              },
              { callId: 'open-terminal' },
            ),
          ];
        },
        (request) => {
          const value = output(request, 'open-terminal');
          const id = /session ID (\d+)/i.exec(value);
          expect(id).not.toBeNull();
          return [
            call(
              'write_stdin',
              {
                session_id: Number(id![1]),
                chars: 'answer\n',
                yield_time_ms: 10000,
              },
              { callId: 'finish-terminal' },
            ),
          ];
        },
        (request) => {
          expect(output(request, 'finish-terminal')).toContain(
            'terminal-done:answer',
          );
          return [message('native defaults done')];
        },
      ]);
      const config = await server.config();
      await using provider = new NativeProvider({
        baseUrl: (config['model_providers.fixture'] as JsonObject)
          .base_url as string,
        apiKey: 'fixture',
        supportsWebsockets: false,
      });
      const agent = new Agent({
        instructions: 'Use the selected native tools.',
        provider,
        model: transport === 'lite' ? 'gpt-5.6-sol' : 'gpt-5.5',
        modelSettings:
          transport === 'responses'
            ? { providerCompaction: { type: 'static', threshold: 240000 } }
            : undefined,
      });
      const environment = new Environment({
        url: executor.url,
        headers: executor.headers,
        cwd: executor.cwd,
        tools: ['exec_command', 'write_stdin', 'apply_patch'],
      });
      await using session = await agent.session({
        environment,
        projectGuidance: true,
      });
      expect(
        (
          await (
            await session.submit(
              'Apply the requested changes and inspect the workspace.',
            )
          ).wait()
        ).finalOutput,
      ).toBe('native defaults done');
      expect(server.requests).toHaveLength(8);
      for (const request of server.requests) {
        if (transport === 'responses')
          expect(request.context_management).toEqual([
            { type: 'compaction', compact_threshold: 240000 },
          ]);
        else expect(request).not.toHaveProperty('context_management');
      }
      server.assertExhausted();
    } finally {
      await executor.close();
    }
  },
  30000,
);
