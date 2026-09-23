import {
  Agent,
  BatchTraceProcessor,
  ConsoleSpanExporter,
  RunContext,
  Runner,
  createCustomSpan,
  Span,
  TracingProcessor,
  setTraceProcessors,
  setTracingDisabled,
  tool,
  withFunctionSpan,
  withTrace,
} from '@openai/agents';
import { describe, afterEach, beforeEach, expect, test, vi } from 'vitest';
import { z } from 'zod';
import { ScriptedModel, functionCall } from '@openai/agents-core/testing';
import { codexTool } from '../../../src/experimental/codex';

type AnySpan = Span<any>;

const codexMockState: {
  events: any[];
  threadId: string | null;
  lastTurnOptions?: any;
  afterEvent?: () => void;
  streamError?: Error;
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
          codexMockState.afterEvent?.();
        }
      }
      const stream = async function* () {
        yield* eventStream(codexMockState.events);
        if (codexMockState.streamError) {
          throw codexMockState.streamError;
        }
      };
      return { events: stream() };
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
  public started: AnySpan[] = [];
  public startSnapshots: unknown[] = [];

  async onTraceStart(): Promise<void> {}

  async onTraceEnd(): Promise<void> {}

  async onSpanStart(span: AnySpan): Promise<void> {
    this.started.push(span);
    this.startSnapshots.push(structuredClone(span.toJSON()));
  }

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
    processor.started = [];
    processor.startSnapshots = [];
    codexMockState.afterEvent = undefined;
    codexMockState.streamError = undefined;
    setTracingDisabled(false);
    setTraceProcessors([processor]);
    codexMockState.events = [];
    codexMockState.threadId = 'thread-1';
    codexMockState.lastTurnOptions = undefined;
    codexConstructorState.options = undefined;
    codexConstructorState.instance = undefined;
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

  function policyEvents() {
    const events: any[] = [{ type: 'thread.started', thread_id: 'thread-1' }];
    for (const phase of ['started', 'updated', 'completed']) {
      const payload = `private-${phase}`;
      const status = phase === 'completed' ? 'failed' : 'in_progress';
      const items = [
        {
          id: 'command',
          type: 'command_execution',
          command: payload,
          aggregated_output: payload,
          exit_code: 7,
          status,
        },
        {
          id: 'files',
          type: 'file_change',
          changes: [{ path: payload, kind: 'update' }],
          status,
        },
        {
          id: 'mcp',
          type: 'mcp_tool_call',
          server: 'server',
          tool: 'lookup',
          arguments: { query: payload },
          result: {
            content: [{ type: 'text', text: payload }],
            structured_content: { answer: payload },
          },
          error: { message: payload },
          status,
        },
        { id: 'search', type: 'web_search', query: payload },
        {
          id: 'todo',
          type: 'todo_list',
          items: [{ text: payload, completed: phase === 'completed' }],
        },
        { id: 'reason', type: 'reasoning', text: payload },
        { id: 'error', type: 'error', message: payload },
      ];
      events.push(...items.map((item) => ({ type: `item.${phase}`, item })));
    }
    events.push(
      {
        type: 'item.completed',
        item: {
          id: 'message',
          type: 'agent_message',
          text: 'private-response',
        },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 10, cached_input_tokens: 2, output_tokens: 3 },
      },
    );
    return events;
  }

  async function runPolicyTool({
    includeSensitiveData = true,
    disabled = false,
    stream = false,
    onStream,
  }: {
    includeSensitiveData?: boolean;
    disabled?: boolean;
    stream?: boolean;
    onStream?: NonNullable<Parameters<typeof codexTool>[0]>['onStream'];
  } = {}) {
    const codex = codexTool({ onStream, useRunContextThreadId: true });
    const model = new ScriptedModel([
      [
        functionCall(
          codex.name,
          { inputs: [{ type: 'text', text: 'private-input' }] },
          { callId: 'codex-call' },
        ),
      ],
    ]);
    const agent = new Agent({
      name: 'Policy agent',
      model,
      tools: [codex],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const runner = new Runner({
      traceIncludeSensitiveData: includeSensitiveData,
      tracingDisabled: disabled,
    });
    const context: Record<string, unknown> = {};
    const result = stream
      ? await runner.run(agent, 'Run the tool.', { stream: true, context })
      : await runner.run(agent, 'Run the tool.', { context });
    if ('completed' in result) {
      for await (const _event of result) {
        // Drain all events before asserting completed trace data.
      }
      await result.completed;
    }
    return { result, context };
  }

  test.each([false, true])(
    'honors the Runner policy through every Codex item phase (stream=%s)',
    async (stream) => {
      for (const includeSensitiveData of [false, true]) {
        processor.spans = [];
        processor.started = [];
        processor.startSnapshots = [];
        codexMockState.events = policyEvents();
        const eventSnapshots: string[] = [];
        codexMockState.afterEvent = () =>
          eventSnapshots.push(
            JSON.stringify(processor.started.map((span) => span.toJSON())),
          );
        const onStream = vi.fn();
        const { result, context } = await runPolicyTool({
          includeSensitiveData,
          stream,
          onStream,
        });
        const custom = processor.spans.filter(
          (span) => span.spanData.type === 'custom',
        );
        expect(custom).toHaveLength(7);
        const functionSpan = processor.spans.find(
          (span) => span.spanData.type === 'function',
        );
        expect(
          custom.every((span) => span.parentId === functionSpan?.spanId),
        ).toBe(true);
        const data = Object.fromEntries(
          custom.map((span) => [span.spanData.name, span.spanData.data]),
        );
        expect(data['Codex command execution']).toMatchObject({
          status: 'failed',
          exitCode: 7,
        });
        expect(data['Codex MCP tool call']).toMatchObject({
          server: 'server',
          tool: 'lookup',
          status: 'failed',
          result: { content_items: 1 },
        });
        if (includeSensitiveData) {
          expect(JSON.stringify(processor.startSnapshots)).toContain(
            'private-started',
          );
          expect(
            eventSnapshots.some((snapshot) =>
              snapshot.includes('private-updated'),
            ),
          ).toBe(true);
          expect(data['Codex command execution']).toMatchObject({
            command: 'private-completed',
            output: 'private-completed',
          });
          expect(data['Codex file change'].changes).toEqual([
            { path: 'private-completed', kind: 'update' },
          ]);
          expect(data['Codex MCP tool call']).toMatchObject({
            arguments: '{"query":"private-completed"}',
            error: 'private-completed',
            result: { structured_content: '{"answer":"private-completed"}' },
          });
          expect(data['Codex web search']).toEqual({
            query: 'private-completed',
          });
          expect(data['Codex todo list']).toEqual({
            items: [{ text: 'private-completed', completed: true }],
          });
          expect(data['Codex reasoning']).toEqual({
            text: 'private-completed',
          });
          expect(data['Codex error']).toEqual({ message: 'private-completed' });
          expect(
            custom.find(
              (span) => span.spanData.name === 'Codex command execution',
            )?.error?.data,
          ).toEqual({ exitCode: 7, output: 'private-completed' });
        } else {
          expect(JSON.stringify(processor.startSnapshots)).not.toContain(
            'private-',
          );
          expect(
            eventSnapshots.every((snapshot) => !snapshot.includes('private-')),
          ).toBe(true);
          expect(
            JSON.stringify(processor.spans.map((span) => span.toJSON())),
          ).not.toContain('private-');
          expect(data).toEqual({
            'Codex command execution': { status: 'failed', exitCode: 7 },
            'Codex file change': {
              status: 'failed',
              changes: [{ kind: 'update' }],
            },
            'Codex MCP tool call': {
              server: 'server',
              tool: 'lookup',
              status: 'failed',
              result: { content_items: 1 },
            },
            'Codex web search': {},
            'Codex todo list': { items: [{ completed: true }] },
            'Codex reasoning': {},
            'Codex error': {},
          });
          expect(
            custom.find(
              (span) => span.spanData.name === 'Codex command execution',
            )?.error?.data,
          ).toEqual({ exitCode: 7 });
          expect(
            custom.find((span) => span.spanData.name === 'Codex file change')
              ?.error?.data,
          ).toEqual({ changes_total: 1 });
        }
        expect(result.finalOutput).toContain('private-response');
        expect(result.finalOutput).toContain('thread-1');
        expect(result.state.usage.inputTokens).toBeGreaterThanOrEqual(10);
        expect(result.state.usage.outputTokens).toBeGreaterThanOrEqual(3);
        expect(context.codexThreadId).toBe('thread-1');
        expect(onStream.mock.calls.map(([payload]) => payload.event)).toEqual(
          codexMockState.events,
        );
        expect(processor.spans).toHaveLength(processor.started.length);
      }
    },
  );

  test.each(['turn.failed', 'error', 'iterator'])(
    'filters %s failure traces and preserves the default redacted error',
    async (failure) => {
      for (const includeSensitiveData of [false, true]) {
        processor.spans = [];
        processor.started = [];
        codexMockState.events = policyEvents().slice(0, 2);
        if (failure === 'iterator') {
          codexMockState.streamError = new Error('private-failure');
        } else {
          codexMockState.events.push(
            failure === 'turn.failed'
              ? { type: failure, error: { message: 'private-failure' } }
              : { type: failure, message: 'private-failure' },
          );
        }
        const { result } = await runPolicyTool({ includeSensitiveData });
        expect(result.finalOutput).toBe(
          'An error occurred while running the tool. Please try again.',
        );
        const functionSpan = processor.spans.find(
          (span) => span.spanData.type === 'function',
        );
        expect(functionSpan?.error?.message).toBe(
          'Error running tool (non-fatal)',
        );
        const trace = JSON.stringify(
          processor.spans.map((span) => span.toJSON()),
        );
        expect(trace).not.toContain('private-failure');
        expect(functionSpan?.error?.data).toEqual({
          tool_name: 'codex',
          error: 'Tool execution failed. Error details are redacted.',
        });
        if (includeSensitiveData) {
          expect(trace).toContain('private-started');
        } else {
          expect(trace).not.toContain('private-');
        }
        expect(processor.spans).toHaveLength(processor.started.length);
        expect(new Set(processor.spans.map((span) => span.spanId)).size).toBe(
          processor.spans.length,
        );
        expect(
          processor.spans.some(
            (span) => span.spanData.name === 'Codex command execution',
          ),
        ).toBe(true);
      }
    },
  );

  test.each([false, true])(
    'preserves no-op tracing and restores ambient context (stream=%s)',
    async (stream) => {
      for (const ambient of [false, true]) {
        for (const fail of [false, true]) {
          processor.spans = [];
          processor.started = [];
          codexMockState.events = fail
            ? policyEvents().slice(0, 2)
            : policyEvents();
          codexMockState.streamError = fail
            ? new Error('private-failure')
            : undefined;
          const execute = async () => {
            await runPolicyTool({ disabled: true, stream });
            expect(processor.started).toHaveLength(0);
            const span = createCustomSpan({
              data: {
                name: 'Application span',
                data: { text: 'application-data' },
              },
            });
            span.start();
            span.end();
          };
          if (ambient) {
            await withTrace('Ambient caller', execute);
            expect(processor.spans.map((span) => span.spanData.name)).toEqual([
              'Application span',
            ]);
          } else {
            await execute();
            expect(processor.spans).toHaveLength(0);
          }
        }
      }
    },
  );

  test('leaves application-owned callback spans unchanged', async () => {
    codexMockState.events = policyEvents();
    await runPolicyTool({
      includeSensitiveData: false,
      onStream: ({ event }) => {
        if (event.type === 'thread.started') {
          const span = createCustomSpan({
            data: {
              name: 'Application span',
              data: { text: 'application-data' },
            },
          });
          span.start();
          span.end();
        }
      },
    });
    expect(
      processor.spans.find((span) => span.spanData.name === 'Application span')
        ?.spanData.data,
    ).toEqual({ text: 'application-data' });
  });

  test.each([undefined, false])(
    'uses the immediate nested Runner policy (child=%s)',
    async (childPolicy) => {
      codexMockState.events = policyEvents();
      const codex = codexTool();
      const child = new Agent({
        name: 'Child',
        model: new ScriptedModel([
          [
            functionCall(
              codex.name,
              { inputs: [{ type: 'text', text: 'Run Codex.' }] },
              { callId: 'inner' },
            ),
          ],
        ]),
        tools: [codex],
        toolUseBehavior: 'stop_on_first_tool',
      });
      const childTool = child.asTool({
        toolName: 'child',
        toolDescription: 'Run child.',
        runConfig: { traceIncludeSensitiveData: childPolicy },
      });
      const parent = new Agent({
        name: 'Parent',
        model: new ScriptedModel([
          [
            functionCall(
              childTool.name,
              { input: 'Run Codex.' },
              { callId: 'outer' },
            ),
          ],
        ]),
        tools: [childTool],
        toolUseBehavior: 'stop_on_first_tool',
      });
      await new Runner({ traceIncludeSensitiveData: false }).run(
        parent,
        'Start.',
      );
      const command = processor.spans.find(
        (span) => span.spanData.name === 'Codex command execution',
      );
      expect(command).toBeDefined();
      expect(command?.spanData.data.command).toBe(
        childPolicy === false ? undefined : 'private-completed',
      );
    },
  );

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
      { apiKey?: string } | undefined;
    expect(options?.apiKey).toBe('openai-key');
  });

  test('defaults Codex api key to OPENAI_API_KEY when CODEX_API_KEY is blank', async () => {
    process.env.OPENAI_API_KEY = 'openai-key';
    process.env.CODEX_API_KEY = '';

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
            text: 'Check blank api key.',
          },
        ],
      }),
    );

    const options = codexConstructorState.options as
      { apiKey?: string } | undefined;
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

  test('rejects output schema descriptors with duplicate properties', () => {
    expect(() =>
      codexTool({
        outputSchema: {
          properties: [
            { name: 'summary', schema: { type: 'string' } },
            { name: 'summary', schema: { type: 'number' } },
          ],
        },
      }),
    ).toThrow('Duplicate property name');
  });

  test('rejects output schema descriptors with missing required properties', () => {
    expect(() =>
      codexTool({
        outputSchema: {
          properties: [{ name: 'summary', schema: { type: 'string' } }],
          required: ['missing'],
        },
      }),
    ).toThrow(/Required property/);
  });

  test('rejects JSON schema output with additionalProperties enabled', () => {
    expect(() =>
      codexTool({
        outputSchema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
      }),
    ).toThrow('additionalProperties');
  });

  test('rejects Zod output schemas with unsupported field types', () => {
    expect(() =>
      codexTool({
        outputSchema: z.object({
          summary: z.string(),
          unsupported: z.any(),
        }),
      }),
    ).toThrow('Codex output schema must be a Zod object');
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

  test('prefers CODEX_API_KEY from codexOptions.env', async () => {
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
      codexOptions: {
        env: {
          CODEX_API_KEY: 'codex-key',
          OPENAI_API_KEY: 'openai-key',
        },
      },
    });
    const runContext = new RunContext();

    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Check env api key.',
          },
        ],
      }),
    );

    const options = codexConstructorState.options as
      { apiKey?: string } | undefined;
    expect(options?.apiKey).toBe('codex-key');
  });

  test('passes resolved thread options to startThread', async () => {
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
      defaultThreadOptions: { region: 'us' } as any,
      sandboxMode: 'workspace' as any,
      workingDirectory: '/tmp',
      skipGitRepoCheck: true,
    });
    const runContext = new RunContext();

    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Check thread options.',
          },
        ],
      }),
    );

    const instance = codexConstructorState.instance;
    expect(instance?.startThread).toHaveBeenCalledWith(
      expect.objectContaining({
        region: 'us',
        sandboxMode: 'workspace',
        workingDirectory: '/tmp',
        skipGitRepoCheck: true,
      }),
    );
  });

  test('resumes a specific thread when threadId is provided', async () => {
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

    const tool = codexTool({ threadId: 'thread-resume' });
    const runContext = new RunContext();

    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Resume thread.',
          },
        ],
      }),
    );

    const instance = codexConstructorState.instance;
    expect(instance?.resumeThread).toHaveBeenCalledWith(
      'thread-resume',
      undefined,
    );
    expect(instance?.startThread).not.toHaveBeenCalled();
  });

  test('accepts threadId from tool input', async () => {
    codexMockState.threadId = 'thread-from-input';
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-from-input' },
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

    const result = await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Continue thread.',
          },
        ],
        threadId: 'thread-xyz',
      }),
    );

    const instance = codexConstructorState.instance;
    expect(instance?.resumeThread).toHaveBeenCalledWith(
      'thread-xyz',
      undefined,
    );
    if (typeof result === 'string') {
      throw new Error('Codex tool unexpectedly returned a string result.');
    }
    expect(result.threadId).toBe('thread-from-input');
  });

  test('uses run context thread id and persists latest thread id', async () => {
    codexMockState.threadId = 'thread-next';
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-next' },
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
      useRunContextThreadId: true,
      runContextThreadIdKey: 'codexAgentThreadId',
    });
    const runContext = new RunContext({
      codexAgentThreadId: 'thread-prev',
    });

    const result = await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Continue thread.',
          },
        ],
      }),
    );

    const instance = codexConstructorState.instance;
    expect(instance?.resumeThread).toHaveBeenCalledWith(
      'thread-prev',
      undefined,
    );
    expect(runContext.context).toMatchObject({
      codexAgentThreadId: 'thread-next',
    });
    if (typeof result === 'string') {
      throw new Error('Codex tool unexpectedly returned a string result.');
    }
    expect(result.threadId).toBe('thread-next');
  });

  test('tool input threadId overrides run context thread id', async () => {
    codexMockState.threadId = 'thread-from-tool-input';
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-from-tool-input' },
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
      useRunContextThreadId: true,
      parameters: z
        .object({
          inputs: z.array(z.any()).min(1),
          threadId: z.string().trim().min(1).nullable().default(null),
        })
        .strict() as any,
    });
    const runContext = new RunContext({
      codexThreadId: 'thread-from-context',
    });

    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Continue thread.',
          },
        ],
        threadId: 'thread-from-input',
      }),
    );

    const instance = codexConstructorState.instance;
    expect(instance?.resumeThread).toHaveBeenCalledWith(
      'thread-from-input',
      undefined,
    );
  });

  test('uses default run context key derived from codex tool name', async () => {
    codexMockState.threadId = 'thread-next';
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-next' },
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
      name: 'codex_engineer',
      useRunContextThreadId: true,
    });
    const runContext = new RunContext({
      codexThreadId_engineer: 'thread-prev',
    });

    await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Continue thread.',
          },
        ],
      }),
    );

    const instance = codexConstructorState.instance;
    expect(instance?.resumeThread).toHaveBeenCalledWith(
      'thread-prev',
      undefined,
    );
    expect(runContext.context).toMatchObject({
      codexThreadId_engineer: 'thread-next',
    });
  });

  test('derives default run context key from normalized tool name', async () => {
    codexMockState.threadId = 'thread-next';
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-next' },
      {
        type: 'item.completed',
        item: { id: 'agent-1', type: 'agent_message', text: 'Codex done.' },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const codex = codexTool({
      name: 'dev engineer',
      useRunContextThreadId: true,
    });
    const runContext = new RunContext({
      codexThreadId_dev_engineer: 'thread-prev',
    });

    await codex.invoke(
      runContext,
      JSON.stringify({
        inputs: [{ type: 'text', text: 'Continue thread.' }],
      }),
    );

    const instance = codexConstructorState.instance;
    expect(instance?.resumeThread).toHaveBeenCalledWith(
      'thread-prev',
      undefined,
    );
    expect(runContext.context).toMatchObject({
      codexThreadId_dev_engineer: 'thread-next',
    });
  });

  test('hides threadId in the default parameters for run context mode', () => {
    const codex = codexTool({ useRunContextThreadId: true });
    const properties = (codex.parameters as { properties?: unknown })
      .properties as Record<string, unknown> | undefined;
    expect(properties?.threadId).toBeUndefined();
  });

  test('prefixes custom tool names into codex namespace', () => {
    const codex = codexTool({ name: 'engineer' });
    expect(codex.name).toBe('codex_engineer');
  });

  test('normalizes codex tool names with spaces like other function tools', () => {
    const codex = codexTool({ name: 'dev engineer' });
    expect(codex.name).toBe('codex_dev_engineer');
  });

  test('does not double-prefix names that normalize to codex_ prefix', () => {
    const codex = codexTool({ name: 'codex-foo' });
    expect(codex.name).toBe('codex_foo');
  });

  test('keeps codex prefix when spaces normalize to underscores', () => {
    const codex = codexTool({ name: 'codex foo' });
    expect(codex.name).toBe('codex_foo');
  });

  test('rejects empty runContextThreadIdKey', () => {
    expect(() =>
      codexTool({
        useRunContextThreadId: true,
        runContextThreadIdKey: '  ',
      }),
    ).toThrow('runContextThreadIdKey');
  });

  test('fails fast when duplicate Codex tool names are present', async () => {
    const agent = new Agent({
      name: 'test',
      instructions: 'test',
      tools: [codexTool(), codexTool()],
    });

    await expect(agent.getAllTools(new RunContext())).rejects.toThrow(
      'Duplicate Codex tool names found',
    );
  });

  test('fails fast when a non-codex tool collides with a codex tool name', async () => {
    const otherTool = tool({
      name: 'codex',
      description: 'Other tool.',
      parameters: z.object({}),
      execute: async () => 'ok',
    });
    const agent = new Agent({
      name: 'test',
      instructions: 'test',
      tools: [codexTool(), otherTool],
    });

    await expect(agent.getAllTools(new RunContext())).rejects.toThrow(
      'Duplicate Codex tool names found',
    );
  });

  test('requires mutable context when useRunContextThreadId is enabled', async () => {
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

    const tool = codexTool({ useRunContextThreadId: true });
    const runContext = new RunContext<Record<string, unknown>>();
    runContext.context = undefined as unknown as Record<string, unknown>;

    const result = await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'No context.',
          },
        ],
      }),
    );

    expect(result).toBe(
      'An error occurred while running the tool. Please try again.',
    );
    expect(codexConstructorState.instance).toBeUndefined();
  });

  test('rejects immutable object context when useRunContextThreadId is enabled', async () => {
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

    const tool = codexTool({ useRunContextThreadId: true });
    const runContext = new RunContext(
      Object.freeze({ codexThreadId: 'thread-prev' }),
    );

    const result = await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Immutable context.',
          },
        ],
      }),
    );

    expect(result).toBe(
      'An error occurred while running the tool. Please try again.',
    );
    expect(codexConstructorState.instance).toBeUndefined();
  });

  test('rejects non-string run context thread IDs', async () => {
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

    const tool = codexTool({ useRunContextThreadId: true });
    const runContext = new RunContext({
      codexThreadId: 123,
    });

    const result = await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Bad context thread ID.',
          },
        ],
      }),
    );

    expect(result).toBe(
      'An error occurred while running the tool. Please try again.',
    );
    expect(codexConstructorState.instance).toBeUndefined();
  });

  test('throws when persistSession is reused with a mismatched thread id', async () => {
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

    const tool = codexTool({ persistSession: true, threadId: 'thread-2' });
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

    const result = await tool.invoke(
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

    expect(result).toBe(
      'An error occurred while running the tool. Please try again.',
    );
  });

  test('throws when Codex turn fails', async () => {
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'turn.failed',
        error: { message: 'bad turn' },
      },
    ];

    const tool = codexTool();
    const runContext = new RunContext();

    const result = await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Trigger failure.',
          },
        ],
      }),
    );

    expect(result).toBe(
      'An error occurred while running the tool. Please try again.',
    );
  });

  test('throws when Codex emits an error event', async () => {
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      { type: 'error', message: 'stream error' },
    ];

    const tool = codexTool();
    const runContext = new RunContext();

    const result = await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'Trigger stream error.',
          },
        ],
      }),
    );

    expect(result).toBe(
      'An error occurred while running the tool. Please try again.',
    );
  });

  test('returns a default response when no agent message is streamed', async () => {
    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'turn.completed',
        usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1 },
      },
    ];

    const tool = codexTool();
    const runContext = new RunContext();

    const result = await tool.invoke(
      runContext,
      JSON.stringify({
        inputs: [
          {
            type: 'text',
            text: 'No agent message.',
          },
        ],
      }),
    );

    if (typeof result === 'string') {
      throw new Error('Codex tool unexpectedly returned a string result.');
    }

    expect(result.response).toBe('Codex task completed with inputs.');
  });

  test('captures file change, todo, web search, and error spans', async () => {
    const todoItems = Array.from({ length: 201 }, (_, index) => ({
      completed: index % 2 === 0,
      text: `Todo ${index}`,
    }));
    const fileChanges = Array.from({ length: 201 }, (_, index) => ({
      path: `file-${index}.txt`,
      kind: index % 2 === 0 ? 'added' : 'modified',
    }));
    const longQuery = 'q'.repeat(2500);

    codexMockState.events = [
      { type: 'thread.started', thread_id: 'thread-1' },
      {
        type: 'item.started',
        item: {
          id: 'file-1',
          type: 'file_change',
          status: 'in_progress',
          changes: fileChanges,
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'file-1',
          type: 'file_change',
          status: 'failed',
          changes: fileChanges,
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'todo-1',
          type: 'todo_list',
          status: 'in_progress',
          items: todoItems,
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'todo-1',
          type: 'todo_list',
          status: 'completed',
          items: todoItems,
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'web-1',
          type: 'web_search',
          status: 'completed',
          query: longQuery,
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'web-1',
          type: 'web_search',
          status: 'completed',
          query: longQuery,
        },
      },
      {
        type: 'item.started',
        item: {
          id: 'err-1',
          type: 'error',
          status: 'completed',
          message: 'Something went wrong.',
        },
      },
      {
        type: 'item.completed',
        item: {
          id: 'err-1',
          type: 'error',
          status: 'completed',
          message: 'Something went wrong.',
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
                  text: 'Capture spans.',
                },
              ],
            }),
          ),
        { data: { name: tool.name } },
      ),
    );

    const fileSpan = processor.spans.find(
      (span) => span.spanData.name === 'Codex file change',
    );
    const fileData = fileSpan?.spanData.data as
      | {
          changes?: unknown[];
          changes_truncated?: boolean;
          changes_total?: number;
        }
      | undefined;
    expect(fileData?.changes?.length).toBe(200);
    expect(fileData?.changes_truncated).toBe(true);
    expect(fileData?.changes_total).toBe(fileChanges.length);
    expect(fileSpan?.error?.message).toBe('Codex file change failed.');

    const todoSpan = processor.spans.find(
      (span) => span.spanData.name === 'Codex todo list',
    );
    const todoData = todoSpan?.spanData.data as
      | { items?: unknown[]; items_truncated?: boolean; items_total?: number }
      | undefined;
    expect(todoData?.items?.length).toBe(200);
    expect(todoData?.items_truncated).toBe(true);
    expect(todoData?.items_total).toBe(todoItems.length);

    const webSpan = processor.spans.find(
      (span) => span.spanData.name === 'Codex web search',
    );
    const webData = webSpan?.spanData.data as
      | { query?: string; query_truncated?: boolean; query_length?: number }
      | undefined;
    expect(webData?.query_truncated).toBe(true);
    expect(webData?.query_length).toBe(longQuery.length);

    const errorSpan = processor.spans.find(
      (span) => span.spanData.name === 'Codex error',
    );
    expect(errorSpan?.error?.message).toBe('Something went wrong.');
  });
});
