import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, RunState, Runner, tool, toolNamespace } from '../src';
import {
  getAllMcpTools,
  mcpToFunctionTool,
  type MCPServer,
  type MCPTool,
} from '../src/mcp';
import { ScriptedModel } from '../src/testing';
import type { FunctionTool } from '../src/tool';
import type * as protocol from '../src/types/protocol';

function definition(name = 'search'): MCPTool {
  return {
    name,
    inputSchema: {
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: false,
    },
  };
}

function server(name: string, tools = [definition()]): MCPServer {
  return {
    name,
    cacheToolsList: true,
    connect: async () => {},
    close: async () => {},
    listTools: vi.fn(async () => tools),
    callTool: vi.fn(async () => [{ type: 'text', text: 'found' }]),
    invalidateToolsCache: async () => {},
  };
}

function call(name = 'search', callId = 'lookup'): protocol.FunctionCallItem {
  return {
    type: 'function_call',
    name,
    callId,
    arguments: '{}',
    status: 'completed',
    providerData: {},
  };
}

function message(): protocol.AssistantMessageItem {
  return {
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'done', providerData: {} }],
    providerData: {},
  };
}

async function converted(s: MCPServer, strict = false): Promise<FunctionTool> {
  const [t] = await getAllMcpTools({
    mcpServers: [s],
    convertSchemasToStrict: strict,
  });
  if (t.type !== 'function') throw new Error('Expected function');
  t.needsApproval = async () => true;
  return t;
}

function agent(
  tools: Agent['tools'],
  outputs: protocol.ModelItem[][] = [[call()]],
) {
  return new Agent({
    name: 'LookupAgent',
    tools,
    model: new ScriptedModel(outputs),
    toolUseBehavior: 'stop_on_first_tool',
  });
}

async function execute(
  a: Agent,
  input: string | RunState<any, any>,
  stream: boolean,
) {
  if (stream) {
    const result = await new Runner({ tracingDisabled: true }).run(a, input, {
      stream: true,
    });
    await result.completed;
    return result;
  }
  return new Runner({ tracingDisabled: true }).run(a, input);
}

describe('local MCP approval recipient binding', () => {
  it.each([false, true])(
    'blocks same-name recipient replacement on restore (stream=%s)',
    async (stream) => {
      const original = server('A');
      const first = await execute(
        agent([await converted(original)]),
        'lookup',
        stream,
      );
      const replacement = server('B');
      const current = agent([await converted(replacement)]);
      const restored = await RunState.fromString(
        current,
        first.state.toString(),
      );
      restored.approve(restored.getInterruptions()[0]);
      await expect(execute(current, restored, stream)).rejects.toThrow(
        /recipient binding/,
      );
      expect(original.callTool).not.toHaveBeenCalled();
      expect(replacement.callTool).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'resumes a reconstructed matching recipient and retains strict=%s',
    async (strict) => {
      const first = await execute(
        agent([await converted(server('A'), strict)]),
        'lookup',
        false,
      );
      const currentServer = server('A');
      const current = agent([await converted(currentServer, strict)]);
      const restored = await RunState.fromString(
        current,
        first.state.toString(),
      );
      restored.approve(restored.getInterruptions()[0]);
      await execute(current, restored, strict);
      expect(currentServer.callTool).toHaveBeenCalledOnce();
      expect(
        vi.mocked(currentServer.callTool).mock.calls[0].slice(0, 2),
      ).toEqual(['search', {}]);
    },
  );

  it('keeps the original live invocation when the agent tool list is replaced', async () => {
    const original = server('A');
    const replacement = server('B');
    const current = agent([await converted(original)]);
    const first = await execute(current, 'lookup', false);
    current.tools = [await converted(replacement)];
    first.state.approve(first.interruptions[0]);
    await execute(current, first.state, false);
    expect(original.callTool).toHaveBeenCalledOnce();
    expect(replacement.callTool).not.toHaveBeenCalled();
  });

  it('binds a raw tool name independently of a public alias', async () => {
    const original = mcpToFunctionTool(definition('read'), server('A'), false, {
      toolNameOverride: 'search',
    });
    original.needsApproval = async () => true;
    const first = await execute(agent([original]), 'lookup', false);
    const replacementServer = server('A');
    const replacement = mcpToFunctionTool(
      definition('write'),
      replacementServer,
      false,
      { toolNameOverride: 'search' },
    );
    const current = agent([replacement]);
    const restored = await RunState.fromString(current, first.state.toString());
    restored.approve(restored.getInterruptions()[0]);
    await expect(execute(current, restored, false)).rejects.toThrow(
      /recipient binding/,
    );
    expect(replacementServer.callTool).not.toHaveBeenCalled();
  });

  it('checks a changed live invocation before replacement policy and handler callbacks', async () => {
    const t = await converted(server('A'));
    const current = agent([t]);
    const first = await execute(current, 'lookup', false);
    const policy = vi.fn(async () => false);
    const handler = vi.fn(async () => 'replacement');
    Object.assign(
      t,
      tool({
        name: 'search',
        description: 'Replacement',
        parameters: z.object({}),
        needsApproval: policy,
        execute: handler,
      }),
    );
    first.state.approve(first.interruptions[0]);
    await expect(execute(current, first.state, false)).rejects.toThrow(
      /recipient binding/,
    );
    expect(policy).not.toHaveBeenCalled();
    expect(handler).not.toHaveBeenCalled();
  });

  it('freezes the actual raw name used by direct conversion', async () => {
    const raw = definition();
    const currentServer = server('A');
    const t = mcpToFunctionTool(raw, currentServer, false);
    t.needsApproval = async () => true;
    const current = agent([t]);
    const first = await execute(current, 'lookup', false);
    raw.name = 'write';
    first.state.approve(first.interruptions[0]);
    await execute(current, first.state, false);
    expect(currentServer.callTool).toHaveBeenCalledExactlyOnceWith(
      'search',
      {},
    );
  });

  it.each([false, true])(
    'does not invoke local replacement callbacks after approve=%s',
    async (approve) => {
      const first = await execute(
        agent([await converted(server('A'))]),
        'lookup',
        false,
      );
      const parser = vi.fn((value: string) => value.length > 0);
      const policy = vi.fn(async () => false);
      const handler = vi.fn(async () => 'replacement');
      const fallback = vi.fn(async () => ({ result: 'replacement' }));
      const replacement = tool({
        name: 'search',
        description: 'Search',
        parameters: z.object({
          query: z.string().default('query').refine(parser),
        }),
        needsApproval: policy,
        outputSchema: z.object({ result: z.string() }),
        errorFunction: fallback,
        execute: async () => ({ result: await handler() }),
      });
      const current = agent([replacement]);
      const restored = await RunState.fromString(
        current,
        first.state.toString(),
      );
      if (approve) restored.approve(restored.getInterruptions()[0]);
      else
        restored.reject(restored.getInterruptions()[0], {
          message: 'declined by operator',
        });
      if (approve)
        await expect(execute(current, restored, false)).rejects.toThrow(
          /recipient binding/,
        );
      else {
        const result = await execute(current, restored, false);
        expect(JSON.stringify(result.newItems)).toContain(
          'declined by operator',
        );
      }
      expect(parser).not.toHaveBeenCalled();
      expect(policy).not.toHaveBeenCalled();
      expect(handler).not.toHaveBeenCalled();
      expect(fallback).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'retains missing recipient for rejection or later approval (approve=%s)',
    async (approve) => {
      const first = await execute(
        agent([await converted(server('A'))]),
        'lookup',
        false,
      );
      const missing = agent([]);
      const restored = await RunState.fromString(
        missing,
        first.state.toString(),
      );
      restored.reject(restored.getInterruptions()[0], { message: 'declined' });
      const replacement = server('B');
      const current = agent([await converted(replacement)]);
      const rewritten = await RunState.fromString(current, restored.toString());
      if (approve) rewritten.approve(rewritten.getInterruptions()[0]);
      if (approve)
        await expect(execute(current, rewritten, true)).rejects.toThrow(
          /recipient binding/,
        );
      else await execute(current, rewritten, true);
      expect(replacement.callTool).not.toHaveBeenCalled();
    },
  );

  it('does not replay or require a completed discovered MCP sibling', async () => {
    const original = server('A');
    const local = tool({
      name: 'local',
      description: 'Local operation',
      parameters: z.object({}),
      needsApproval: true,
      execute: vi.fn(async () => 'local done'),
    });
    const current = agent(
      [local],
      [[call(), call('local', 'local-call')], [message()]],
    );
    current.mcpServers = [original];
    current.toolUseBehavior = 'run_llm_again';
    const first = await execute(current, 'lookup', false);
    expect(original.callTool).toHaveBeenCalledOnce();
    current.mcpServers = [];
    const restored = await RunState.fromString(current, first.state.toString());
    restored.approve(restored.getInterruptions()[0]);
    const result = await execute(current, restored, false);
    expect(result.finalOutput).toBe('done');
    expect(original.callTool).toHaveBeenCalledOnce();
    expect(JSON.stringify(result.newItems)).toContain('local done');
  });

  it('preserves bindings through supported namespace wrappers', async () => {
    const original = await converted(server('A'));
    const namespacedCall = { ...call(), namespace: 'lookup' };
    const first = await execute(
      agent(
        toolNamespace({
          name: 'lookup',
          description: 'Lookup tools',
          tools: [original],
        }),
        [[namespacedCall]],
      ),
      'lookup',
      false,
    );
    const replacement = server('B');
    const current = agent(
      toolNamespace({
        name: 'lookup',
        description: 'Lookup tools',
        tools: [await converted(replacement)],
      }),
    );
    const restored = await RunState.fromString(current, first.state.toString());
    restored.approve(restored.getInterruptions()[0]);
    await expect(execute(current, restored, false)).rejects.toThrow(
      /recipient binding/,
    );
    expect(replacement.callTool).not.toHaveBeenCalled();
  });

  it('rejects changed server positions after collision-safe prefix allocation', async () => {
    const a = server('A');
    const b = server('B');
    const tools = await getAllMcpTools({
      mcpServers: [a, b],
      includeServerInToolNames: true,
    });
    for (const t of tools)
      if (t.type === 'function') t.needsApproval = async () => true;
    const first = await execute(
      agent(tools, [[call(tools[0].name)]]),
      'lookup',
      false,
    );
    const current = agent(
      await getAllMcpTools({
        mcpServers: [b, a],
        includeServerInToolNames: true,
      }),
    );
    const restored = await RunState.fromString(current, first.state.toString());
    restored.approve(restored.getInterruptions()[0]);
    await expect(execute(current, restored, false)).rejects.toThrow(
      /recipient binding/,
    );
    expect(a.callTool).not.toHaveBeenCalled();
    expect(b.callTool).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'does not infer missing historical provenance from a local replacement (approve=%s)',
    async (approve) => {
      const first = await execute(
        agent([await converted(server('A'))]),
        'lookup',
        false,
      );
      const snapshot = JSON.parse(first.state.toString());
      snapshot.$schemaVersion = '1.20';
      for (const f of snapshot.lastProcessedResponse.functions)
        delete f.mcpToolBinding;
      const handler = vi.fn(async () => 'local');
      const current = agent([
        tool({
          name: 'search',
          description: 'Search',
          parameters: z.object({}),
          execute: handler,
        }),
      ]);
      const restored = await RunState.fromString(
        current,
        JSON.stringify(snapshot),
      );
      const rewritten = await RunState.fromString(current, restored.toString());
      if (approve) rewritten.approve(rewritten.getInterruptions()[0]);
      else
        rewritten.reject(rewritten.getInterruptions()[0], {
          message: 'legacy declined',
        });
      if (approve)
        await expect(execute(current, rewritten, false)).rejects.toThrow(
          /recipient binding/,
        );
      else
        expect(
          JSON.stringify((await execute(current, rewritten, false)).newItems),
        ).toContain('legacy declined');
      expect(handler).not.toHaveBeenCalled();
    },
  );

  it('rejects malformed persisted bindings rather than converting them into local provenance', async () => {
    const current = agent([await converted(server('A'))]);
    const first = await execute(current, 'lookup', false);
    const snapshot = JSON.parse(first.state.toString());
    snapshot.lastProcessedResponse.functions[0].mcpToolBinding = {
      serverName: 'A',
    };
    await expect(
      RunState.fromString(current, JSON.stringify(snapshot)),
    ).rejects.toThrow();
  });
});
