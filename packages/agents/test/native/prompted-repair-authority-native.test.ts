import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Agent, NativeError, NativeProvider, StdioMCP, tool } from '../../src';
import { ModelServer, call, message } from './fixtures/model-server';

afterEach(() => ModelServer.closeAll());

describe.skipIf(
  process.env.OPENAI_AGENTS_NATIVE_TESTS !== '1' ||
    process.platform !== 'linux',
)('native prompted-repair authority', () => {
  it.each(['callback', 'mcp', 'shell', 'child'] as const)(
    'uses original MCP once and denies %s authority to the separate correction',
    async (capability) => {
      const directory = await mkdtemp(
        join(tmpdir(), 'agents-repair-authority-'),
      );
      try {
        const roster = join(directory, 'roster.json');
        const callsPath = join(directory, 'calls.jsonl');
        const callbackEffect = join(directory, 'callback-effect');
        const shellEffect = join(directory, 'shell-effect');
        await writeFile(callsPath, '');
        await writeFile(
          roster,
          JSON.stringify({
            tools: [
              {
                name: 'search',
                description: 'Read a record',
                inputSchema: {
                  type: 'object',
                  properties: { key: { type: 'string' } },
                  required: ['key'],
                  additionalProperties: false,
                },
              },
            ],
            result: {
              content: [{ type: 'text', text: 'PRIVATE_ORIGINAL_MCP_RESULT' }],
            },
          }),
        );
        const shellCommand = `touch '${shellEffect.replaceAll("'", "'\\''")}'`;
        const forbidden = {
          callback: call('record', {}, { callId: 'forbidden-callback' }),
          mcp: call(
            'search',
            { key: 'forbidden' },
            { callId: 'forbidden-mcp', namespace: 'mcp__local' },
          ),
          shell: call(
            'exec_command',
            { cmd: shellCommand },
            { callId: 'forbidden-shell' },
          ),
          child: call(
            'spawn_agent',
            { task_name: 'forbidden', message: 'forbidden' },
            { callId: 'forbidden-child', namespace: 'collaboration' },
          ),
        };
        const server = new ModelServer([
          [
            call(
              'search',
              { key: 'original' },
              { callId: 'original-mcp', namespace: 'mcp__local' },
            ),
          ],
          (request) => {
            // The real native tool continuation contains the actual peer result.
            expect(JSON.stringify(request.input)).toContain(
              'PRIVATE_ORIGINAL_MCP_RESULT',
            );
            return [message('{"label":"x"}')];
          },
          [forbidden[capability]],
          [message('{"label":"recovered"}')],
        ]);
        const config = await server.config();
        await using provider = new NativeProvider({
          baseUrl: (config['model_providers.fixture'] as { base_url: string })
            .base_url,
          apiKey: 'synthetic-repair-authority-key',
          supportsWebsockets: false,
        });
        let callbackCalls = 0;
        await using session = await new Agent({
          instructions: 'PRIVATE_ORIGINAL_MCP_TASK',
          model: 'gpt-5',
          provider,
          outputType: {
            mode: 'prompted',
            schema: z.object({ label: z.string().min(2) }),
            maxRetries: 3,
          },
          tools: [
            tool({
              name: 'record',
              parameters: z.object({}),
              async execute() {
                callbackCalls++;
                await writeFile(callbackEffect, 'forbidden');
                return 'forbidden';
              },
            }),
            new StdioMCP({
              name: 'local',
              tools: ['search'],
              approvalMode: 'approve',
              command: process.execPath,
              args: [
                resolve(import.meta.dirname, 'mcp-peer.mjs'),
                roster,
                callsPath,
              ],
              cwd: directory,
            }),
          ],
        }).session();
        const turn = await session.submit('Use the original local search');
        const outcome = await turn.wait().then(
          (result) => ({ ok: true as const, result }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        if (outcome.ok) {
          expect(outcome.result.finalOutput).toEqual({ label: 'recovered' });
          expect(outcome.result.repairAttempts).toHaveLength(1);
          expect(outcome.result.repairAttempts[0]).toMatchObject({
            parentSessionId: session.id,
            parentTurnId: turn.turnId,
            status: 'completed',
          });
          expect(outcome.result.repairAttempts[0].sessionId).not.toBe(
            session.id,
          );
          expect(await turn.wait()).toBe(outcome.result);
          expect(server.requests).toHaveLength(4);
          server.assertExhausted();
        } else {
          // A native refusal is terminal, even though more correction budget remains.
          expect(outcome.error).toBeInstanceOf(NativeError);
          await expect(turn.wait()).rejects.toBe(outcome.error);
          await expect(turn.wait()).rejects.toBe(outcome.error);
          // Native refusal deliberately leaves the alternative recovery reply unused.
          expect(server.requests).toHaveLength(3);
        }
        const calls = (await readFile(callsPath, 'utf8'))
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        expect(calls).toHaveLength(1);
        expect(calls[0]).toMatchObject({
          name: 'search',
          arguments: { key: 'original' },
        });
        expect(JSON.stringify(server.requests[0].tools)).toContain(
          'mcp__local',
        );
        expect(JSON.stringify(server.requests[0].tools)).toContain('search');
        expect(JSON.stringify(server.requests[0].tools)).toContain('record');
        for (const request of server.requests.slice(2)) {
          expect(request.tools ?? []).toEqual([]);
          expect(JSON.stringify(request)).not.toContain(
            'PRIVATE_ORIGINAL_MCP_TASK',
          );
          expect(JSON.stringify(request)).not.toContain(
            'PRIVATE_ORIGINAL_MCP_RESULT',
          );
        }
        expect(callbackCalls).toBe(0);
        await expect(access(callbackEffect)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        await expect(access(shellEffect)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        const children = [];
        for await (const child of session.subagents()) children.push(child);
        expect(children).toEqual([]);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    35000,
  );
});
