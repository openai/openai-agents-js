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
import { codexTool } from '../src/codexTool';

type AnySpan = Span<any>;

const codexMockState: {
  events: any[];
  threadId: string;
} = {
  events: [],
  threadId: 'thread-1',
};

vi.mock('@openai/codex-sdk', () => {
  class FakeThread {
    id: string | null = null;

    async runStreamed(): Promise<{ events: AsyncGenerator<any> }> {
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

  beforeEach(() => {
    processor.spans = [];
    setTracingDisabled(false);
    setTraceProcessors([processor]);
    codexMockState.events = [];
    codexMockState.threadId = 'thread-1';
  });

  afterEach(() => {
    setTracingDisabled(true);
    setTraceProcessors([new BatchTraceProcessor(new ConsoleSpanExporter())]);
    vi.restoreAllMocks();
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
              task: 'Diagnose failure',
            }),
          ),
        { data: { name: tool.name } },
      ),
    );

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
});
