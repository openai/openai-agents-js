import {
  BatchTraceProcessor,
  ConsoleSpanExporter,
  RunContext,
  Span,
  TracingProcessor,
  setTraceProcessors,
  setTracingDisabled,
  withFunctionSpan,
  withTrace,
} from '@openai/agents';
import { describe, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { codexTool } from '../../../src/experimental/codex';

type AnySpan = Span<any>;

const codexMockState: {
  events: any[];
  threadId: string | null;
  lastTurnOptions?: any;
} = {
  events: [],
  threadId: 'thread-1',
};

const codexConstructorState: {
  options?: unknown;
  instance?: {
    startThread: ReturnType<typeof vi.fn>;
    resumeThread: ReturnType<typeof vi.fn>;
  };
} = {};

vi.mock('@openai/codex-sdk', () => {
  class FakeThread {
    id: string | null = null;

    async runStreamed(
      _input?: unknown,
      turnOptions?: unknown,
    ): Promise<{ events: AsyncGenerator<any> }> {
      codexMockState.lastTurnOptions = turnOptions;
      this.id = codexMockState.threadId;
      async function* eventStream(events: any[]) {
        for (const event of events) {
          yield event;
        }
      }
      return { events: eventStream(codexMockState.events) };
    }
  }

  return {
    Codex: class FakeCodex {
      constructor(options?: unknown) {
        codexConstructorState.options = options;
        codexConstructorState.instance = this;
      }
      startThread = vi.fn(() => new FakeThread());
      resumeThread = vi.fn(() => new FakeThread());
    },
  };
});

class CollectingProcessor implements TracingProcessor {
  public spans: AnySpan[] = [];

  async onTraceStart(): Promise<void> {}

  async onTraceEnd(): Promise<void> {}

  async onSpanStart(): Promise<void> {}

  async onSpanEnd(span: AnySpan): Promise<void> {
    this.spans.push(span);
  }

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

describe('codexTool', () => {
  const processor = new CollectingProcessor();
  let originalOpenAIKey: string | undefined;
  let originalCodexKey: string | undefined;

  beforeEach(() => {
    processor.spans = [];
    setTracingDisabled(false);
    setTraceProcessors([processor]);
    codexMockState.events = [];
    codexMockState.threadId = 'thread-1';
    codexMockState.lastTurnOptions = undefined;
    codexConstructorState.options = undefined;
    originalOpenAIKey = process.env.OPENAI_API_KEY;
    originalCodexKey = process.env.CODEX_API_KEY;
  });

  afterEach(() => {
    setTracingDisabled(true);
    setTraceProcessors([new BatchTraceProcessor(new ConsoleSpanExporter())]);
    vi.restoreAllMocks();
    if (originalOpenAIKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAIKey;
    }
    if (originalCodexKey === undefined) {
      delete process.env.CODEX_API_KEY;
    } else {
      process.env.CODEX_API_KEY = originalCodexKey;
    }
  });

  test('creates child spans for streamed Codex events and returns final response', async () => {
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'turn.started' },
      {
        type: 'item.started',
        item: { id: 'reason-1', type: 'reasoning', text: 'Initial reasoning' },
      },
      {
        type: 'item.updated',
        item: { id: 'reason-1', type: 'reasoning', text: 'Refined reasoning' },
      },
      {
        type: 'item.completed',
        item: { id: 'reason-1', type: 'reasoning', text: 'Final reasoning' },
      },
      {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: '',
          status: 'in_progress',
        },
      },
      {
        type: 'item.updated',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'Running tests',
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'npm test',
          aggregated_output: 'All good',
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'gitmcp',
          tool: 'search_codex_code',
          arguments: { query: 'foo' },
          status: 'in_progress',
        },
      },
      {
        type: 'item.updated',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'gitmcp',
          tool: 'search_codex_code',
          arguments: { query: 'foo' },
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'gitmcp',
          tool: 'search_codex_code',
          arguments: { query: 'foo' },
          status: 'completed',
          result: { content: [], structured_content: null },
        },
      },
      {
        type: 'item.completed',
        item: { id: 'agent-1', type: 'agent_message', text: 'Codex finished.' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 1, output_tokens: 5 },
      },
    ];

    const tool = codexTool();
    const runContext = new RunContext();

    const result = await withTrace('codex-test', () =>
      withFunctionSpan(
        async () =>
          tool.invoke(
            runContext,
            JSON.stringify({
              inputs: [
                {
                  type: 'text',
                  text: 'Diagnose failure',
                },
              ],
            }),
          ),
        { data: { name: tool.name } },
      ),
    );

    if (typeof result === 'string') {
      throw new Error('Codex tool unexpectedly returned a string result.');
    }

    expect(result.threadId).toBe('thread-1');
    expect(result.response).toBe('Codex finished.');
    expect(result.usage).toEqual({
      input_tokens: 10,
      cached_input_tokens: 1,
      output_tokens: 5,
    });

    expect(runContext.usage.totalTokens).toBe(15);
    expect(runContext.usage.requests).toBe(1);

    expect(processor.spans.length).toBeGreaterThan(0);

    const functionSpan = processor.spans.find(
      (span) =>
        span.spanData.type === 'function' && span.spanData.name === tool.name,
    );
    expect(functionSpan).toBeDefined();

    const customSpans = processor.spans.filter(
      (span) => span.spanData.type === 'custom',
    );
    expect(customSpans).toHaveLength(3);

    const reasoningSpan = customSpans.find(
      (span) => span.spanData.name === 'Codex reasoning',
    );
    expect(reasoningSpan?.parentId).toBe(functionSpan?.spanId);
    expect(reasoningSpan?.spanData.data.text).toBe('Final reasoning');

    const commandSpan = customSpans.find(
      (span) => span.spanData.name === 'Codex command execution',
    );
    expect(commandSpan?.parentId).toBe(functionSpan?.spanId);
    expect(commandSpan?.spanData.data).toMatchObject({
      command: 'npm test',
      status: 'completed',
      output: 'All good',
      exitCode: 0,
    });

    const mcpSpan = customSpans.find(
      (span) => span.spanData.name === 'Codex MCP tool call',
    );
    expect(mcpSpan?.parentId).toBe(functionSpan?.spanId);
    expect(mcpSpan?.spanData.data).toMatchObject({
      server: 'gitmcp',
      tool: 'search_codex_code',
      status: 'completed',
    });
  });

  test('truncates large span fields to avoid oversized trace payloads', async () => {
    const longOutput = 'x'.repeat(5000);
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'cat large.log',
          aggregated_output: longOutput,
          status: 'in_progress',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'cat large.log',
          aggregated_output: longOutput,
          exit_code: 0,
          status: 'completed',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const tool = codexTool();
    const runContext = new RunContext();

    await withTrace('codex-test', () =>
      withFunctionSpan(
        async () =>
          tool.invoke(
            runContext,
            JSON.stringify({
              inputs: [
                {
                  type: 'text',
                  text: 'Emit a long output.',
                },
              ],
            }),
          ),
        { data: { name: tool.name } },
      ),
    );

    const commandSpan = processor.spans.find(
      (span) => span.spanData.name === 'Codex command execution',
    );
    const spanData = commandSpan?.spanData.data as
      | { output?: string; output_truncated?: boolean; output_length?: number }
      | undefined;

    expect(spanData?.output_truncated).toBe(true);
    expect(spanData?.output_length).toBe(longOutput.length);
    expect(spanData?.output?.length).toBeLessThan(longOutput.length);
  });

  test('invokes onStream for each event and uses streamed thread id fallback', async () => {
    const onStream = vi.fn();
    codexMockState.threadId = null;
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-stream' },
      {
        type: 'item.completed',
        item: {
          id: 'agent-1',
          type: 'agent_message',
          text: 'Codex streamed.',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const tool = codexTool({ onStream });
    const runContext = new RunContext();

    const result = await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Stream events.',
          },
        ],
      }),
    );

    if (typeof result === 'string') {
      throw new Error('Codex tool unexpectedly returned a string result.');
    }

    expect(result.threadId).toBe('thread-stream');
    expect(onStream).toHaveBeenCalledTimes(codexMockState.events.length);
    expect(onStream.mock.calls[0]?.[0]).toMatchObject({
      threadId: 'thread-stream',
      event: { type: 'thread.started' },
    });
  });

  test('defaults Codex api key to OPENAI_API_KEY when CODEX_API_KEY is missing', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    delete process.env.CODEX_API_KEY;

    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'agent-1', type: 'agent_message', text: 'Codex done.' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const tool = codexTool();
    const runContext = new RunContext();

    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Check default api key.',
          },
        ],
      }),
    );

    const options = codexConstructorState.options as
      | { apiKey?: string }
      | undefined;
    expect(options?.apiKey).toBe('openai-key');
  });

  test('accepts a Zod output schema descriptor', async () => {
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'agent-1', type: 'agent_message', text: 'Codex done.' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const tool = codexTool({
      outputSchema: z.object({
        summary: z.string(),
      }),
    });
    const runContext = new RunContext();

    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Check schema.',
          },
        ],
      }),
    );

    expect(codexMockState.lastTurnOptions?.outputSchema).toMatchObject({
      type: 'object',
      additionalProperties: false,
      properties: {
        summary: { type: 'string' },
      },
      required: ['summary'],
    });
  });

  test('respects required fields for output schema descriptors', async () => {
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'agent-1', type: 'agent_message', text: 'Codex done.' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const tool = codexTool({
      outputSchema: {
        title: 'CodexSummary',
        properties: [
          {
            name: 'summary',
            description: 'High-level summary.',
            schema: {
              type: 'string',
            },
          },
          {
            name: 'commands',
            description: 'Commands executed.',
            schema: {
              type: 'array',
              items: {
                type: 'string',
              },
            },
          },
        ],
        required: ['summary'],
      },
    });
    const runContext = new RunContext();

    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Check descriptor schema.',
          },
        ],
      }),
    );

    expect(codexMockState.lastTurnOptions?.outputSchema).toMatchObject({
      title: 'CodexSummary',
      required: ['summary'],
      properties: {
        summary: {
          type: 'string',
          description: 'High-level summary.',
        },
        commands: {
          type: 'array',
          description: 'Commands executed.',
        },
      },
    });
  });

  test('reuses the same thread when persistSession is enabled', async () => {
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.completed',
        item: { id: 'agent-1', type: 'agent_message', text: 'Codex done.' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const tool = codexTool({ persistSession: true });
    const runContext = new RunContext();

    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'First call.',
          },
        ],
      }),
    );
    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Second call.',
          },
        ],
      }),
    );

    const instance = codexConstructorState.instance;
    expect(instance?.startThread).toHaveBeenCalledTimes(1);
    expect(instance?.resumeThread).not.toHaveBeenCalled();
  });
});
