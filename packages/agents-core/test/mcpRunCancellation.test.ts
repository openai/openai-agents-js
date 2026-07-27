import { describe, expect, it } from 'vitest';

import { Agent } from '../src/agent';
import type { MCPServer } from '../src/mcp';
import type { ModelResponse } from '../src/model';
import { run } from '../src/run';
import { setTracingDisabled } from '../src/tracing';
import { Usage } from '../src/usage';
import { FakeModel } from './stubs';

setTracingDisabled(true);

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('MCP run cancellation', () => {
  it('cancels an in-flight MCP request without a stale completion', async () => {
    const requestStarted = deferred();
    const releaseLateCompletion = deferred();
    const lateCompletionRan = deferred();
    let mcpCallEnded = false;
    let mcpCancelled = false;

    const server: MCPServer = {
      name: 'cancellation-server',
      cacheToolsList: false,
      connect: async () => {},
      close: async () => {},
      listTools: async () => [
        {
          name: 'slow_tool',
          description: 'Waits before returning.',
          inputSchema: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
        } as any,
      ],
      callTool: (_name, _args, _meta, options) => {
        requestStarted.resolve();
        return new Promise((resolve, reject) => {
          releaseLateCompletion.promise.then(() => {
            mcpCallEnded = true;
            resolve([{ type: 'text', text: 'late result' }] as any);
            lateCompletionRan.resolve();
          });
          options?.signal?.addEventListener(
            'abort',
            () => {
              mcpCancelled = true;
              reject(new DOMException('MCP request cancelled', 'AbortError'));
            },
            { once: true },
          );
        }) as any;
      },
      invalidateToolsCache: async () => {},
    };
    const responses: ModelResponse[] = [
      {
        output: [
          {
            type: 'function_call',
            callId: 'call-1',
            name: 'slow_tool',
            arguments: '{}',
            status: 'completed',
          } as any,
        ],
        usage: new Usage(),
      } as any,
      {
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'done' }],
          } as any,
        ],
        usage: new Usage(),
      } as any,
    ];
    const agent = new Agent({
      name: 'cancellation-agent',
      model: new FakeModel(responses),
      mcpServers: [server],
    });
    const controller = new AbortController();
    const outcomePromise = run(agent, 'go', {
      signal: controller.signal,
    }).then(
      () => ({ kind: 'resolved' as const, error: '' }),
      (error) => ({ kind: 'rejected' as const, error: String(error) }),
    );

    await requestStarted.promise;
    controller.abort(new Error('user aborted'));
    const outcome = await outcomePromise;

    expect(outcome).toEqual({
      kind: 'rejected',
      error: expect.stringContaining('user aborted'),
    });
    expect(mcpCancelled).toBe(true);
    expect(mcpCallEnded).toBe(false);

    releaseLateCompletion.resolve();
    await lateCompletionRan.promise;
    expect(mcpCallEnded).toBe(true);
  }, 5_000);
});
