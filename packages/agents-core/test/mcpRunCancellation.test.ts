import { describe, expect, it } from 'vitest';

import { Agent } from '../src/agent';
import type { MCPServer } from '../src/mcp';
import type { ModelResponse } from '../src/model';
import { run } from '../src/run';
import { setTracingDisabled } from '../src/tracing';
import { Usage } from '../src/usage';
import { FakeModel } from './stubs';

setTracingDisabled(true);

describe('MCP run cancellation', () => {
  it('cancels an in-flight MCP request without a stale completion', async () => {
    let mcpCallStarted = false;
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
        mcpCallStarted = true;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => {
            mcpCallEnded = true;
            resolve([{ type: 'text', text: 'late result' }] as any);
          }, 800);
          options?.signal?.addEventListener(
            'abort',
            () => {
              mcpCancelled = true;
              clearTimeout(timer);
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
    const started = Date.now();
    const outcomePromise = run(agent, 'go', {
      signal: controller.signal,
    }).then(
      () => ({ kind: 'resolved' as const, error: '' }),
      (error) => ({ kind: 'rejected' as const, error: String(error) }),
    );

    await new Promise((resolve) => setTimeout(resolve, 25));
    controller.abort(new Error('user aborted'));
    const outcome = await outcomePromise;
    const elapsed = Date.now() - started;
    await new Promise((resolve) => setTimeout(resolve, 75));

    expect(outcome).toEqual({
      kind: 'rejected',
      error: expect.stringContaining('user aborted'),
    });
    expect(mcpCallStarted).toBe(true);
    expect(mcpCancelled).toBe(true);
    expect(mcpCallEnded).toBe(false);
    expect(elapsed).toBeLessThan(500);
  }, 5_000);
});
