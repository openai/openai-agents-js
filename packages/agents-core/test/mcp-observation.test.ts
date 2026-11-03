import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  RunContext,
  Usage,
  mcpToFunctionTool,
  run,
  setTracingDisabled,
  type MCPServer,
  type MCPToolEndObservation,
} from '../src';
import { ScriptedModel, modelResponse } from '../src/testing';
import { TEST_MODEL_FUNCTION_CALL, fakeModelMessage } from './stubs';
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
function peer(extra: Partial<MCPServer> = {}): MCPServer {
  return {
    name: 'peer',
    cacheToolsList: false,
    connect: async () => {},
    close: async () => {},
    invalidateToolsCache: async () => {},
    listTools: async () => [],
    callTool: vi.fn(async () => [{ type: 'text', text: 'original' }]),
    ...extra,
  };
}
const declaration: Parameters<typeof mcpToFunctionTool>[0] = {
  name: 'lookup',
  inputSchema: {
    type: 'object',
    properties: { value: { type: 'string' } },
    required: ['value'],
    additionalProperties: false,
  },
};
afterEach(() => vi.restoreAllMocks());

it('waits for real Runner approval and both observers, then projects the result', async () => {
  setTracingDisabled(true);
  const events: string[] = [];
  const start = gate(),
    end = gate(),
    enteredStart = gate(),
    enteredEnd = gate();
  const server = peer({
    onToolStart: async (event) => {
      events.push('start');
      (event.arguments as Record<string, unknown>).value = 'observer';
      enteredStart.release();
      await start.promise;
      return 'ignored';
    },
    onToolEnd: async (event) => {
      events.push('end');
      expect(event.result.content).toEqual([
        { type: 'text', text: 'transformed' },
      ]);
      event.result.content[0] = { type: 'text', text: 'observer' };
      enteredEnd.release();
      await end.promise;
      return 'ignored';
    },
  });
  const dispatch = vi.fn(async (args: unknown) => {
    expect(args).toEqual({ value: 'transformed' });
    events.push('invoke');
    return [{ type: 'text' as const, text: 'raw' }];
  });
  server.callTool = vi.fn(async (_name, args) => {
    events.push('argument-transform');
    const result = await dispatch({ ...args, value: 'transformed' });
    events.push('result-transform');
    return result.map((item) => ({ ...item, text: 'transformed' }));
  });
  const converted = mcpToFunctionTool(declaration, server, false);
  converted.needsApproval = async () => true;
  const model = new ScriptedModel([
    modelResponse({
      output: [
        {
          ...TEST_MODEL_FUNCTION_CALL,
          name: 'lookup',
          arguments: '{"value":"original"}',
        },
      ],
      usage: new Usage(),
    }),
    modelResponse({ output: [fakeModelMessage('done')], usage: new Usage() }),
  ]);
  const agent = new Agent({ name: 'observer', model, tools: [converted] });
  const classicListener = gate();
  const listener = vi.fn(() => classicListener.promise);
  agent.on('agent_tool_start', listener);
  const pending = await run(agent, 'run');
  expect(pending.interruptions).toHaveLength(1);
  expect(events).toEqual([]);
  pending.state.approve(pending.interruptions[0]);
  const completion = run(agent, pending.state);
  try {
    await enteredStart.promise;
    expect(listener).toHaveBeenCalledTimes(1);
    expect(dispatch).not.toHaveBeenCalled();
    start.release();
    await enteredEnd.promise;
    let settled = false;
    completion.finally(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    end.release();
    expect((await completion).finalOutput).toBe('done');
    expect(events).toEqual([
      'start',
      'argument-transform',
      'invoke',
      'result-transform',
      'end',
    ]);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    classicListener.release();
    start.release();
    end.release();
    await completion.catch(() => {});
  }
});

it.each(['start', 'end'] as const)(
  'propagates %s failure without ordinary error conversion or a repeated effect',
  async (phase) => {
    const failure = new Error('observer stopped');
    const fallback = vi.fn(() => 'converted');
    const observer = vi.fn(() => {
      throw failure;
    });
    const server = peer({
      errorFunction: fallback,
      ...(phase === 'start'
        ? { onToolStart: observer }
        : { onToolEnd: observer }),
    });
    const tool = mcpToFunctionTool(declaration, server, false);
    await expect(tool.invoke(new RunContext(), ' {"value":"ok"}')).rejects.toBe(
      failure,
    );
    expect(fallback).not.toHaveBeenCalled();
    expect(server.callTool).toHaveBeenCalledTimes(phase === 'start' ? 0 : 1);
    expect(observer).toHaveBeenCalledTimes(1);
  },
);

it.each(['start', 'end'] as const)(
  'checks cancellation after a held classic %s and joins the observer',
  async (phase) => {
    const entered = gate(),
      hold = gate();
    const controller = new AbortController();
    const reason = new Error('cancelled');
    const observer = vi.fn(async () => {
      entered.release();
      await hold.promise;
    });
    const server = peer(
      phase === 'start' ? { onToolStart: observer } : { onToolEnd: observer },
    );
    const tool = mcpToFunctionTool(declaration, server, false);
    let settled = false;
    const completion = tool
      .invoke(new RunContext(), '{"value":"ok"}', { signal: controller.signal })
      .finally(() => (settled = true));
    completion.catch(() => {});
    try {
      await entered.promise;
      controller.abort(reason);
      await Promise.resolve();
      expect(settled).toBe(false);
      hold.release();
      await expect(completion).rejects.toBe(reason);
      expect(server.callTool).toHaveBeenCalledTimes(phase === 'start' ? 0 : 1);
      expect(observer).toHaveBeenCalledTimes(1);
    } finally {
      hold.release();
      await completion.catch(() => {});
    }
  },
);

it.each([false, true])(
  'normalizes attached legacy metadata before end, before projection (full=%s)',
  async (full) => {
    const content = [{ type: 'text', text: 'original' }];
    Object.defineProperties(content, {
      structuredContent: { value: { projection: 'real' } },
      _meta: { value: { owner: 'legacy' } },
      isError: { value: false },
    });
    const events: string[] = [];
    const server = peer({
      useStructuredContent: true,
      callTool: vi.fn(async () => content),
      ...(full ? { callToolResult: vi.fn(async () => ({ content })) } : {}),
      onToolEnd: (event: MCPToolEndObservation) => {
        events.push('end');
        expect(event.result).toEqual({
          content: [{ type: 'text', text: 'original' }],
          structuredContent: { projection: 'real' },
          _meta: { owner: 'legacy' },
          isError: false,
        });
        event.result.structuredContent!.projection = 'observer';
        return { projection: 'replacement' };
      },
    });
    const stringify = JSON.stringify;
    vi.spyOn(JSON, 'stringify').mockImplementation((value: unknown) => {
      if (value && typeof value === 'object' && 'projection' in value)
        events.push('serialize');
      return stringify(value);
    });
    const tool = mcpToFunctionTool(declaration, server, false);
    expect(await tool.invoke(new RunContext(), '{"value":"ok"}')).toBe(
      '{"projection":"real"}',
    );
    expect(events).toEqual(['end', 'serialize']);
  },
);

it('retains existing transport-error conversion when observers are enabled', async () => {
  const fallback = vi.fn(() => 'transport failure');
  const end = vi.fn();
  const server = peer({
    onToolStart: () => 42,
    onToolEnd: end,
    errorFunction: fallback,
    callTool: vi.fn(async () => {
      throw new Error('transport');
    }),
  });
  const tool = mcpToFunctionTool(declaration, server, false);
  expect(await tool.invoke(new RunContext(), '{"value":"ok"}')).toBe(
    'transport failure',
  );
  expect(fallback).toHaveBeenCalledTimes(1);
  expect(end).not.toHaveBeenCalled();
});

it('does not enter observers when the outer Runner rejects MCP approval', async () => {
  const start = vi.fn(),
    end = vi.fn();
  const server = peer({ onToolStart: start, onToolEnd: end });
  const converted = mcpToFunctionTool(declaration, server, false);
  converted.needsApproval = async () => true;
  const model = new ScriptedModel([
    modelResponse({
      output: [
        {
          ...TEST_MODEL_FUNCTION_CALL,
          name: 'lookup',
          arguments: '{"value":"ok"}',
        },
      ],
      usage: new Usage(),
    }),
    modelResponse({ output: [fakeModelMessage('denied')], usage: new Usage() }),
  ]);
  const agent = new Agent({ name: 'approval', model, tools: [converted] });
  const pending = await run(agent, 'run');
  expect(pending.interruptions).toHaveLength(1);
  pending.state.reject(pending.interruptions[0]);
  expect((await run(agent, pending.state)).finalOutput).toBe('denied');
  expect(start).not.toHaveBeenCalled();
  expect(end).not.toHaveBeenCalled();
  expect(server.callTool).not.toHaveBeenCalled();
});
