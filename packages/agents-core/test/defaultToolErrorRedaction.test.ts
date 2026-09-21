import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent';
import { ToolCallError } from '../src/errors';
import logger from '../src/logger';
import { mcpToFunctionTool, type MCPServer } from '../src/mcp';
import { Runner } from '../src/run';
import { RunContext } from '../src/runContext';
import { tool, type FunctionTool } from '../src/tool';
import { ScriptedModel, assistantMessage, functionCall } from '../src/testing';
import { setTraceProcessors, setTracingDisabled } from '../src/tracing';
import { defaultProcessor } from '../src/tracing/processor';
import type { Span } from '../src/tracing/spans';
import { TEST_TOOL } from './stubs';

const SECRET = 'synthetic-private-tool-failure';
const GENERIC_ERROR =
  'An error occurred while running the tool. Please try again.';
const REDACTED_ERROR = 'Tool execution failed. Error details are redacted.';
let spans: Span<any>[];

beforeEach(() => {
  spans = [];
  setTracingDisabled(false);
  setTraceProcessors([
    {
      async onTraceStart() {},
      async onTraceEnd() {},
      async onSpanStart() {},
      async onSpanEnd(span) {
        spans.push(span);
      },
      async shutdown() {},
      async forceFlush() {},
    },
  ]);
});

afterEach(() => {
  setTraceProcessors([defaultProcessor()]);
  setTracingDisabled(true);
  vi.restoreAllMocks();
});

async function runTool(
  failingTool: FunctionTool<any, any, any>,
  stream: boolean,
  traceIncludeSensitiveData: boolean,
  input = '{}',
  context: unknown = undefined,
) {
  const model = new ScriptedModel([
    [functionCall(failingTool.name, input, { callId: 'failure-call' })],
    [assistantMessage('recovered')],
  ]);
  const agent = new Agent({ name: 'Test', model, tools: [failingTool] });
  const runner = new Runner({ traceIncludeSensitiveData });
  const result = stream
    ? await runner.run(agent, 'start', { stream: true, context })
    : await runner.run(agent, 'start', { context });
  if ('completed' in result) {
    for await (const _event of result) {
      // Drain the stream to observe the final history and ended spans.
    }
    await result.completed;
  }
  expect(result.finalOutput).toBe('recovered');
  const nextInput = model.calls[1].request.input;
  expect(Array.isArray(nextInput)).toBe(true);
  const output = Array.isArray(nextInput)
    ? nextInput.find((item) => item.type === 'function_call_result')
    : undefined;
  expect(output).toBeDefined();
  return { result, nextInput, output };
}

describe('default function-tool failures', () => {
  it.each([
    { stream: false, sensitive: false, mcp: false },
    { stream: false, sensitive: true, mcp: false },
    { stream: true, sensitive: false, mcp: false },
    { stream: true, sensitive: true, mcp: false },
    { stream: false, sensitive: false, mcp: true },
    { stream: false, sensitive: true, mcp: true },
    { stream: true, sensitive: false, mcp: true },
    { stream: true, sensitive: true, mcp: true },
  ])(
    'redacts model history and spans: %j',
    async ({ stream, sensitive, mcp }) => {
      // Local diagnostic logging does not authorize model or trace disclosure.
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
      const execute = async () => {
        throw Object.assign(new Error(SECRET), {
          cause: new Error(`cause-${SECRET}`),
        });
      };
      const server: MCPServer = {
        name: 'test-server',
        cacheToolsList: false,
        connect: async () => {},
        close: async () => {},
        listTools: async () => [],
        invalidateToolsCache: async () => {},
        callTool: execute,
      };
      const failingTool = mcp
        ? mcpToFunctionTool(
            {
              name: 'fail',
              inputSchema: {
                type: 'object',
                properties: {},
                required: [],
                additionalProperties: false,
              },
            },
            server,
            !stream,
          )
        : tool({
            name: 'fail',
            description: '',
            parameters: z.object({}),
            execute,
          });
      const { output, nextInput, result } = await runTool(
        failingTool,
        stream,
        sensitive,
      );
      expect(output).toMatchObject({
        output: { type: 'text', text: GENERIC_ERROR },
      });
      expect(JSON.stringify(nextInput)).not.toContain(SECRET);
      expect(JSON.stringify(result.history)).not.toContain(SECRET);
      expect(spans.some((span) => span.spanData.type === 'function')).toBe(
        true,
      );
      expect(JSON.stringify(spans.map((span) => span.toJSON()))).not.toContain(
        SECRET,
      );
      expect(
        spans.find((span) => span.spanData.type === 'function')?.error,
      ).toMatchObject({
        data: { error: REDACTED_ERROR },
      });
    },
  );

  it.each([false, true])(
    'does not inspect a thrown exception (stream=%s)',
    async (stream) => {
      const exception = new Proxy(
        {},
        {
          get() {
            throw new Error('Exception properties must not be read.');
          },
          getPrototypeOf() {
            throw new Error('Exception prototypes must not be read.');
          },
        },
      );
      const failingTool = tool({
        name: 'uninspectable',
        description: '',
        parameters: z.object({}),
        execute: () => {
          throw exception;
        },
      });
      const { output } = await runTool(failingTool, stream, true);
      expect(output).toMatchObject({
        output: { type: 'text', text: GENERIC_ERROR },
      });
    },
  );

  it.each([null, undefined, SECRET, 7])(
    'handles an arbitrary thrown value: %s',
    async (error) => {
      const failingTool = tool({
        name: 'primitive',
        description: '',
        parameters: z.object({}),
        execute: () => {
          throw error;
        },
      });
      expect(await failingTool.invoke(new RunContext(), '{}')).toBe(
        GENERIC_ERROR,
      );
    },
  );

  it.each([false, true])(
    'keeps custom feedback with sensitive tracing=%s',
    async (sensitive) => {
      const error = new Error(SECRET);
      const handler = vi.fn(() => 'Application-approved feedback');
      const failingTool = tool({
        name: 'custom',
        description: '',
        parameters: z.object({}),
        // Exercise the timeout wrapper's call-details cloning without timing out.
        timeoutMs: 10_000,
        execute: async () => {
          throw error;
        },
        errorFunction: handler,
      });
      const { output } = await runTool(failingTool, true, sensitive);
      expect(handler).toHaveBeenCalledWith(
        expect.any(RunContext),
        error,
        expect.any(Object),
      );
      expect(output).toMatchObject({
        output: { type: 'text', text: 'Application-approved feedback' },
      });
      const functionSpan = spans.find(
        (span) => span.spanData.type === 'function',
      );
      expect(functionSpan?.error).toMatchObject({
        data: { error: sensitive ? `Error: ${SECRET}` : REDACTED_ERROR },
      });
    },
  );

  it.each([false, true])(
    'redacts nested direct invocations without call details (stream=%s)',
    async (stream) => {
      const stringify = vi.fn(() => SECRET);
      const error = Object.assign(new Error(SECRET), { toString: stringify });
      const handler = vi.fn(() => 'Approved nested feedback');
      const inner = tool({
        name: 'inner',
        description: '',
        parameters: z.object({}),
        execute: () => {
          throw error;
        },
        errorFunction: handler,
      });
      const outer = tool({
        name: 'outer',
        description: '',
        parameters: z.object({}),
        execute: async (_input, context) => inner.invoke(context!, '{}'),
      });
      const { output } = await runTool(outer, stream, false);
      expect(output).toMatchObject({
        output: { type: 'text', text: 'Approved nested feedback' },
      });
      expect(handler).toHaveBeenCalledWith(
        expect.any(RunContext),
        error,
        undefined,
      );
      expect(stringify).not.toHaveBeenCalled();
      expect(JSON.stringify(spans.map((span) => span.toJSON()))).not.toContain(
        SECRET,
      );
      expect(
        spans.find((span) => span.spanData.type === 'function')?.error,
      ).toMatchObject({ data: { error: REDACTED_ERROR } });
    },
  );

  it.each(['custom', 'null'] as const)(
    'keeps runner malformed-JSON feedback outside the %s handler',
    async (mode) => {
      const handler = vi.fn(() => 'Approved parse feedback');
      const execute = vi.fn(() => 'unexpected');
      const failingTool = tool({
        name: 'parse_policy',
        description: '',
        parameters: z.object({}),
        execute,
        errorFunction: mode === 'custom' ? handler : null,
      });
      const { output } = await runTool(failingTool, false, false, SECRET);
      expect(output).toMatchObject({
        output: {
          type: 'text',
          text: 'An error occurred while parsing tool arguments. Please try again with valid JSON.',
        },
      });
      expect(handler).not.toHaveBeenCalled();
      expect(execute).not.toHaveBeenCalled();
      if (mode === 'custom') {
        await expect(
          failingTool.invoke(new RunContext(), SECRET),
        ).resolves.toBe('Approved parse feedback');
        expect(handler).toHaveBeenCalledOnce();
      } else {
        await expect(
          failingTool.invoke(new RunContext(), SECRET),
        ).rejects.toThrow();
      }
    },
  );

  it('does not inspect custom-handler exceptions for redacted tracing', async () => {
    const error = new Proxy(
      {},
      {
        get() {
          throw new Error('Must not inspect.');
        },
      },
    );
    const handler = vi.fn(
      (_context: RunContext, _error: unknown) => 'Approved feedback',
    );
    await runTool(
      tool({
        name: 'custom_redacted',
        description: '',
        parameters: z.object({}),
        execute: () => {
          throw error;
        },
        errorFunction: handler,
      }),
      false,
      false,
    );
    expect(handler.mock.calls[0]?.[1]).toBe(error);
  });

  it('preserves explicit null propagation and runner error identity', async () => {
    const error = new Error(SECRET);
    const failingTool = tool({
      name: 'propagate',
      description: '',
      parameters: z.object({}),
      execute: () => {
        throw error;
      },
      errorFunction: null,
    });
    await expect(failingTool.invoke(new RunContext(), '{}')).rejects.toBe(
      error,
    );
    await expect(runTool(failingTool, false, false)).rejects.toMatchObject({
      error,
      state: expect.anything(),
    });
    await expect(runTool(failingTool, true, false)).rejects.toBeInstanceOf(
      ToolCallError,
    );
  });

  it.each([
    { mode: 'legacy JSON', legacy: true, input: SECRET },
    { mode: 'factory JSON', legacy: false, input: SECRET },
    {
      mode: 'factory schema',
      legacy: false,
      input: JSON.stringify({ amount: SECRET }),
    },
  ])(
    'keeps invalid-input feedback fixed with logging enabled: $mode',
    async ({ mode, legacy, input }) => {
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(false);
      const execute = vi.fn(async () => 'unexpected');
      const failingTool = legacy
        ? { ...TEST_TOOL, invoke: execute }
        : tool({
            name: 'parse',
            description: '',
            parameters: z.object({ amount: z.number() }),
            execute,
          });
      const { output } = await runTool(failingTool, true, false, input);
      expect(execute).not.toHaveBeenCalled();
      expect(output).toMatchObject({
        output: {
          type: 'text',
          text:
            mode === 'factory schema'
              ? GENERIC_ERROR
              : 'An error occurred while parsing tool arguments. Please try again with valid JSON.',
        },
      });
      expect(JSON.stringify(spans.map((span) => span.toJSON()))).not.toContain(
        SECRET,
      );
    },
  );

  it('keeps opposite trace policies isolated across overlapping invocations', async () => {
    let release!: () => void;
    let markStarted!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const failingTool = tool({
      name: 'overlap',
      description: '',
      parameters: z.object({}),
      execute: async (_input, context) => {
        if (context?.context === 'held') {
          markStarted();
          await held;
        }
        throw new Error(SECRET);
      },
      errorFunction: () => 'Approved feedback',
    });
    const redactedRun = runTool(failingTool, false, false, '{}', 'held');
    await started;
    try {
      await runTool(failingTool, false, true);
    } finally {
      release();
    }
    await redactedRun;
    const errors = spans
      .filter((span) => span.spanData.type === 'function')
      .map((span) => span.error?.data?.error);
    expect(errors).toEqual([`Error: ${SECRET}`, REDACTED_ERROR]);
  });
});
