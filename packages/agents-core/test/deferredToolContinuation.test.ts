import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MaxTurnsExceededError,
  MemorySession,
  ModelBehaviorError,
  Runner,
  RunState,
  attachClientToolSearchExecutor,
  handoff,
  hostedMcpTool,
  tool,
  toolNamespace,
} from '../src';
import { ScriptedModel } from '../src/testing';
import type * as protocol from '../src/types/protocol';
import type { ModelRequest } from '../src/model';

const searchTool = {
  type: 'hosted_tool',
  name: 'tool_search',
  providerData: { type: 'tool_search' },
} as const;
const search = (): protocol.ToolSearchOutputItem => ({
  type: 'tool_search_output',
  id: 'search-output',
  execution: 'server',
  status: 'completed',
  tools: [
    {
      type: 'namespace',
      name: 'syntax',
      tools: [{ type: 'function', name: 'lookup', defer_loading: true }],
    },
  ],
});
const call = (callId = 'lookup-call'): protocol.FunctionCallItem => ({
  type: 'function_call',
  name: 'lookup',
  namespace: 'syntax',
  callId,
  arguments: '{}',
});
const load = (paths = ['syntax']): protocol.ToolSearchCallItem => ({
  type: 'tool_search_call',
  execution: 'client',
  callId: 'reload',
  arguments: { paths },
});
const done = (): protocol.AssistantMessageItem => ({
  type: 'message',
  role: 'assistant',
  content: [{ type: 'output_text', text: 'DONE' }],
  status: 'completed',
});
function makeAgent(
  model: ScriptedModel,
  execute = vi.fn(async () => 'found'),
  name = 'LookupAgent',
) {
  return new Agent({
    name,
    model,
    tools: [
      ...toolNamespace({
        name: 'syntax',
        description: 'Syntax lookups.',
        tools: [
          tool({
            name: 'lookup',
            description: 'Look up syntax.',
            parameters: z.object({}),
            deferLoading: true,
            execute,
          }),
        ],
      }),
      searchTool,
    ],
  });
}
const recoveryMessage =
  'Error: Tool syntax.lookup is not loaded for the current agent. The requested function was not executed. Call tool_search to load it, then retry the original function call with the same arguments.';

async function finish(
  runner: Runner,
  agent: Agent,
  input: string,
  stream: boolean,
  options: { previousResponseId?: string; maxTurns?: number } = {},
) {
  if (stream) {
    const result = await runner.run(agent, input, { ...options, stream: true });
    await result.completed;
    return result;
  }
  return runner.run(agent, input, options);
}

describe('deferred tool continuation recovery', () => {
  it.each([false, true])(
    'keeps deferred MCP credentials out of automatic recovery output (stream: %s)',
    async (stream) => {
      const authorization = 'synthetic-mcp-authorization';
      const header = 'synthetic-mcp-header';
      const execute = vi.fn(async () => 'found');
      const session = new MemorySession();
      const model = new ScriptedModel([
        [call('unloaded')],
        {
          type: 'responder',
          respond: ({ request }) => {
            // Exercise the model-controlled path exposed by client execution.
            const clientSearch = request.tools.some(
              (tool) =>
                tool.type === 'hosted_tool' &&
                tool.providerData?.type === 'tool_search' &&
                tool.providerData.execution === 'client',
            );
            return clientSearch
              ? [load(['private_server'])]
              : [search(), call('loaded')];
          },
        },
        [done()],
      ]);
      const agent = makeAgent(model, execute);
      agent.tools.push(
        hostedMcpTool({
          serverLabel: 'private_server',
          serverUrl: 'https://mcp.example.test',
          authorization,
          headers: { 'X-Api-Key': header },
          deferLoading: true,
        }),
      );
      const runner = new Runner({
        tracingDisabled: true,
        toolNotFoundBehavior: 'return_error_to_model',
      });
      const result = stream
        ? await runner.run(agent, 'look up syntax', { session, stream: true })
        : await runner.run(agent, 'look up syntax', { session });
      if ('completed' in result) {
        await result.completed;
      }

      const sinks = {
        modelInput: JSON.stringify(
          model.calls.map((call) => call.request.input),
        ),
        history: JSON.stringify(result.history),
        session: JSON.stringify(await session.getItems()),
        state: result.state.toString(),
      };
      for (const [name, value] of Object.entries(sinks)) {
        expect.soft(value, name).not.toContain(authorization);
        expect.soft(value, name).not.toContain(header);
      }
      expect(model.calls[1].request.tools).toContainEqual(searchTool);
      expect(execute).toHaveBeenCalledOnce();
      expect(result.finalOutput).toBe('DONE');
    },
  );

  it.each([false, true])(
    'recovers a fresh response-ID continuation only after new discovery (stream: %s)',
    async (stream) => {
      const execute = vi.fn(async () => 'found');
      const first = await new Runner({ tracingDisabled: true }).run(
        makeAgent(
          new ScriptedModel([[search(), call('first')], [done()]]),
          execute,
        ),
        'first',
      );
      expect(execute).toHaveBeenCalledTimes(1);
      const formatter = vi.fn(() => undefined);
      const model = new ScriptedModel([
        [call('unloaded')],
        {
          type: 'responder',
          respond: ({ request }) => {
            expect(execute).toHaveBeenCalledTimes(1);
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                providerData: expect.objectContaining({
                  type: 'tool_search',
                  execution: 'client',
                }),
              }),
            );
            expect(request.input).toEqual([
              expect.objectContaining({
                type: 'function_call_result',
                callId: 'unloaded',
                output: { type: 'text', text: recoveryMessage },
              }),
            ]);
            return [load()];
          },
        },
        {
          type: 'responder',
          respond: ({ request }) => {
            expect(request.tools).toContainEqual(searchTool);
            expect(request.input).toContainEqual(
              expect.objectContaining({ type: 'tool_search_output' }),
            );
            return [call('loaded')];
          },
        },
        [done()],
      ]);
      const result = await finish(
        new Runner({
          tracingDisabled: true,
          toolNotFoundBehavior: 'return_error_to_model',
          toolErrorFormatter: formatter,
        }),
        makeAgent(model, execute),
        'second',
        stream,
        { previousResponseId: first.lastResponseId },
      );
      expect(model.firstCall?.request.previousResponseId).toBe(
        first.lastResponseId,
      );
      expect(model.firstCall?.request.input).toEqual([
        expect.objectContaining({ role: 'user', content: 'second' }),
      ]);
      expect(result.finalOutput).toBe('DONE');
      expect(execute).toHaveBeenCalledTimes(2);
      expect(formatter).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: 'tool_not_found',
          toolName: 'syntax.lookup',
          callId: 'unloaded',
          defaultMessage: recoveryMessage,
        }),
      );
      expect(
        result.history.filter((item) => item.type === 'function_call_result'),
      ).toHaveLength(2);
    },
  );

  it.each([false, true])(
    'keeps default rejection before execution (stream: %s)',
    async (stream) => {
      const execute = vi.fn(async () => 'found');
      await expect(
        finish(
          new Runner({ tracingDisabled: true }),
          makeAgent(new ScriptedModel([[call()]]), execute),
          'again',
          stream,
          { previousResponseId: 'previous' },
        ),
      ).rejects.toThrow(ModelBehaviorError);
      expect(execute).not.toHaveBeenCalled();
    },
  );

  it('does not transfer discovery through a handoff when recovery is enabled', async () => {
    const execute = vi.fn(async () => 'found');
    const model = new ScriptedModel([
      [call('unloaded')],
      {
        type: 'responder',
        respond: ({ request }) => {
          expect(execute).not.toHaveBeenCalled();
          expect(JSON.stringify(request.input)).toContain(recoveryMessage);
          return [load()];
        },
      },
      [call('loaded')],
      [done()],
    ]);
    const b = makeAgent(model, execute, 'B');
    const a = makeAgent(
      new ScriptedModel([
        [
          search(),
          {
            type: 'function_call',
            name: handoff(b).toolName,
            callId: 'handoff',
            arguments: '{}',
          },
        ],
      ]),
      undefined,
      'A',
    );
    a.handoffs = [b];
    const result = await new Runner({ tracingDisabled: true }).run(a, 'start', {
      toolNotFoundBehavior: 'return_error_to_model',
    });
    expect(result.finalOutput).toBe('DONE');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it.each([false, true])(
    'keeps target search configuration after a mixed unloaded call and handoff (stream: %s)',
    async (stream) => {
      const sourceExecute = vi.fn(async () => 'source');
      const targetExecute = vi.fn(async () => 'target');
      const target = makeAgent(
        new ScriptedModel([
          {
            type: 'responder',
            respond: ({ request }) => {
              expect(request.tools).toContainEqual(searchTool);
              expect(sourceExecute).not.toHaveBeenCalled();
              return [search(), call('target')];
            },
          },
          [done()],
        ]),
        targetExecute,
        'SameName',
      );
      const source = makeAgent(
        new ScriptedModel([
          [
            call('source-unloaded'),
            {
              type: 'function_call',
              name: handoff(target).toolName,
              callId: 'transfer',
              arguments: '{}',
            },
          ],
        ]),
        sourceExecute,
        'SameName',
      );
      source.handoffs = [target];
      const result = await finish(
        new Runner({
          tracingDisabled: true,
          toolNotFoundBehavior: 'return_error_to_model',
        }),
        source,
        'start',
        stream,
      );
      expect(result.finalOutput).toBe('DONE');
      expect(sourceExecute).not.toHaveBeenCalled();
      expect(targetExecute).toHaveBeenCalledTimes(1);
    },
  );

  it('does not use a serialized recovery reason to change search execution', async () => {
    const model = new ScriptedModel([
      [
        {
          type: 'function_call',
          name: 'missing',
          callId: 'missing',
          arguments: '{}',
        },
        {
          type: 'function_call',
          name: 'approve_me',
          callId: 'approval',
          arguments: '{}',
        },
      ],
      {
        type: 'responder',
        respond: ({ request }) => {
          expect(request.tools).toContainEqual(searchTool);
          return [done()];
        },
      },
    ]);
    const agent = makeAgent(model);
    agent.tools.push(
      tool({
        name: 'approve_me',
        description: 'Request approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'approved',
      }),
    );
    const runner = new Runner({
      tracingDisabled: true,
      toolNotFoundBehavior: 'return_error_to_model',
    });
    const paused = await runner.run(agent, 'start');
    const serialized = JSON.parse(paused.state.toString());
    serialized.lastProcessedResponse.functionToolsNotFound[0].reason =
      'not_loaded';
    const restored = await RunState.fromString(
      agent,
      JSON.stringify(serialized),
    );
    restored.approve(restored.getInterruptions()[0]);
    const result = await runner.run(agent, restored);
    expect(result.finalOutput).toBe('DONE');
  });

  it('does not convert caller restrictions into recoverable loading errors', async () => {
    const execute = vi.fn(async () => 'found');
    const agent = new Agent({
      name: 'ProgramOnly',
      model: new ScriptedModel([
        [
          {
            type: 'function_call',
            name: 'lookup',
            namespace: 'lookup',
            callId: 'direct',
            arguments: '{}',
          },
        ],
      ]),
      tools: [
        tool({
          name: 'lookup',
          description: 'Programmatic lookup.',
          parameters: z.object({}),
          deferLoading: true,
          allowedCallers: ['programmatic'],
          execute,
        }),
        searchTool,
      ],
    });
    await expect(
      new Runner({
        tracingDisabled: true,
        toolNotFoundBehavior: 'return_error_to_model',
      }).run(agent, 'start'),
    ).rejects.toThrow(/caller direct/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('recovers self-namespaced top-level deferred calls without changing call identity', async () => {
    const execute = vi.fn(async () => 'found');
    const topLevelCall = { ...call(), namespace: 'lookup' };
    const model = new ScriptedModel([
      [topLevelCall],
      {
        type: 'responder',
        respond: ({ request }) => {
          expect(execute).not.toHaveBeenCalled();
          expect(request.input).toContainEqual(
            expect.objectContaining({
              type: 'function_call_result',
              callId: 'lookup-call',
              name: 'lookup',
              namespace: 'lookup',
            }),
          );
          return [load(['lookup'])];
        },
      },
      [{ ...topLevelCall, callId: 'loaded' }],
      [done()],
    ]);
    const agent = new Agent({
      name: 'TopLevel',
      model,
      tools: [
        tool({
          name: 'lookup',
          description: 'Look up a record.',
          parameters: z.object({}),
          deferLoading: true,
          execute,
        }),
        searchTool,
      ],
    });
    const result = await new Runner({
      tracingDisabled: true,
      toolNotFoundBehavior: 'return_error_to_model',
    }).run(agent, 'start');
    expect(result.finalOutput).toBe('DONE');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('bounds repeated unloaded calls with maxTurns', async () => {
    const execute = vi.fn(async () => 'found');
    await expect(
      new Runner({
        tracingDisabled: true,
        toolNotFoundBehavior: 'return_error_to_model',
      }).run(
        makeAgent(new ScriptedModel([[call('one')], [call('two')]]), execute),
        'start',
        { maxTurns: 2 },
      ),
    ).rejects.toThrow(MaxTurnsExceededError);
    expect(execute).not.toHaveBeenCalled();
  });

  it('uses recovery in custom client-search processing without loading an unrelated tool', async () => {
    const execute = vi.fn(async () => 'found');
    const searchExecute = vi.fn(async () => []);
    const model = new ScriptedModel([
      [
        {
          type: 'tool_search_call',
          execution: 'client',
          callId: 'client-search',
          arguments: { paths: ['other'] },
        },
        call('unloaded'),
      ],
      [done()],
    ]);
    const agent = makeAgent(model, execute);
    agent.tools[1] = attachClientToolSearchExecutor(
      {
        ...searchTool,
        providerData: { type: 'tool_search', execution: 'client' },
      },
      searchExecute,
    );
    const result = await new Runner({
      tracingDisabled: true,
      toolNotFoundBehavior: 'return_error_to_model',
    }).run(agent, 'start');
    expect(result.finalOutput).toBe('DONE');
    expect(execute).not.toHaveBeenCalled();
    expect(searchExecute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(model.calls[1].request.input)).toContain(
      recoveryMessage,
    );
  });

  it.each([false, true])(
    'preserves approval recovery without trusting restored metadata (serialized: %s)',
    async (serialized) => {
      const execute = vi.fn(async () => 'found');
      const approvedExecute = vi.fn(async () => 'approved');
      const model = new ScriptedModel([
        [
          call('unloaded'),
          {
            type: 'function_call',
            name: 'approve_me',
            callId: 'approval',
            arguments: '{}',
          },
        ],
        ...(serialized
          ? [
              {
                type: 'responder' as const,
                respond: ({ request }: { request: ModelRequest }) => {
                  expect(request.tools).toContainEqual(searchTool);
                  return [call('fresh-unloaded')];
                },
              },
            ]
          : []),
        {
          type: 'responder',
          respond: ({ request }) => {
            expect(request.tools).toContainEqual(
              expect.objectContaining({
                providerData: expect.objectContaining({ execution: 'client' }),
              }),
            );
            return [load()];
          },
        },
        [call('loaded')],
        [done()],
      ]);
      const agent = makeAgent(model, execute);
      agent.tools.push(
        tool({
          name: 'approve_me',
          description: 'An approval tool.',
          parameters: z.object({}),
          needsApproval: true,
          execute: approvedExecute,
        }),
      );
      const runner = new Runner({
        tracingDisabled: true,
        toolNotFoundBehavior: 'return_error_to_model',
      });
      const paused = await runner.run(agent, 'start');
      expect(execute).not.toHaveBeenCalled();
      expect(paused.interruptions).toHaveLength(1);
      const json = JSON.parse(paused.state.toString());
      expect(JSON.stringify(json)).toContain('not_loaded');
      const restored = serialized
        ? await RunState.fromString<undefined, typeof agent>(
            agent,
            JSON.stringify(json),
          )
        : paused.state;
      expect(JSON.stringify(JSON.parse(restored.toString()))).toContain(
        'not_loaded',
      );
      restored.approve(restored.getInterruptions()[0]);
      const result = await runner.run(agent, restored);
      expect(result.finalOutput).toBe('DONE');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(approvedExecute).toHaveBeenCalledTimes(1);
      expect(
        result.history.filter(
          (item) =>
            item.type === 'function_call_result' && item.callId === 'unloaded',
        ),
      ).toHaveLength(1);
    },
  );
});
