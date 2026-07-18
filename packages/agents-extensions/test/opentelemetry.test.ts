import {
  context,
  diag,
  trace,
  type Span as OtelSpan,
  type Tracer,
} from '@opentelemetry/api';
import { isTracingSuppressed } from '@opentelemetry/core';
import { AsyncLocalStorageContextManager } from '@opentelemetry/context-async-hooks';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, test, vi } from 'vitest';
import type { Span, SpanData, Trace } from '@openai/agents-core';
import {
  OpenTelemetryTracingProcessor,
  type OpenTelemetryTracingProcessorOptions,
} from '../src/opentelemetry';

function createOtelSpan(): OtelSpan {
  return {
    setAttribute: vi.fn(),
    setAttributes: vi.fn(),
    addEvent: vi.fn(),
    addLink: vi.fn(),
    addLinks: vi.fn(),
    setStatus: vi.fn(),
    updateName: vi.fn(),
    end: vi.fn(),
    isRecording: () => true,
    recordException: vi.fn(),
    spanContext: () => ({
      traceId: '1'.repeat(32),
      spanId: '1'.repeat(16),
      traceFlags: 1,
    }),
  } as unknown as OtelSpan;
}

function createAgentSpan(
  spanData: SpanData,
  options: Partial<
    Pick<Span<any>, 'traceId' | 'spanId' | 'parentId' | 'startedAt' | 'endedAt'>
  > = {},
): Span<any> {
  return {
    traceId: options.traceId ?? 'trace_123',
    spanId: options.spanId ?? 'span_123',
    parentId: options.parentId ?? null,
    startedAt: options.startedAt ?? null,
    endedAt: options.endedAt ?? null,
    error: null,
    spanData,
  } as Span<any>;
}

function createTrace(traceId = 'trace_123', name = `Trace ${traceId}`): Trace {
  return { traceId, name, groupId: null } as Trace;
}

function createHarness(options: OpenTelemetryTracingProcessorOptions = {}) {
  const spans: OtelSpan[] = [];
  const startSpan = vi.fn((..._args: any[]) => {
    const span = createOtelSpan();
    spans.push(span);
    return span;
  });
  const processor = new OpenTelemetryTracingProcessor({
    ...options,
    tracer: { startSpan } as unknown as Tracer,
  });
  return {
    processor,
    spans,
    startSpan,
    async start(traceId = 'trace_123', name?: string) {
      const agentTrace = createTrace(traceId, name);
      await processor.onTraceStart(agentTrace);
      return agentTrace;
    },
  };
}

describe('OpenTelemetryTracingProcessor', () => {
  test('falls back to the trace root when a restored parent is missing', async () => {
    const harness = createHarness();
    const agentTrace = await harness.start();
    const child = createAgentSpan(
      { type: 'function', name: 'approved_tool', input: '{}', output: 'ok' },
      { parentId: 'span_missing' },
    );

    await harness.processor.onSpanStart(child);
    expect(trace.getSpan(harness.startSpan.mock.calls[1][2]!)).toBe(
      harness.spans[0],
    );
    await harness.processor.onTraceEnd(agentTrace);
    expect(harness.spans[1].end).toHaveBeenCalledOnce();
  });

  test('refreshes mutable span attributes during trace cleanup', async () => {
    const harness = createHarness();
    const agentTrace = await harness.start();
    const agentSpan = createAgentSpan({
      type: 'agent',
      name: 'Reviewer',
      tools: [],
      handoffs: [],
    });

    await harness.processor.onSpanStart(agentSpan);
    agentSpan.spanData.tools = ['fetch_page'];
    agentSpan.spanData.handoffs = ['Escalation'];
    await harness.processor.onTraceEnd(agentTrace);

    expect(harness.spans[1].setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'openai.agents.agent.tools': ['fetch_page'],
        'openai.agents.agent.handoffs': ['Escalation'],
      }),
    );
  });

  test('maps span data to semantic attributes while keeping content private by default', async () => {
    const cases: Array<{
      data: SpanData;
      options?: OpenTelemetryTracingProcessorOptions;
      expected: Record<string, unknown>;
      absent?: string[];
    }> = [
      {
        data: {
          type: 'task',
          name: 'Review workflow',
          usage: {
            requests: 2,
            input_tokens: 12,
            output_tokens: 4,
            total_tokens: 16,
            cached_input_tokens: 3,
            cache_write_input_tokens: 1,
          },
        },
        expected: {
          'openai.agents.task.name': 'Review workflow',
          'openai.agents.task.requests': 2,
          'gen_ai.usage.input_tokens': 12,
          'openai.agents.usage.total_tokens': 16,
        },
      },
      {
        data: {
          type: 'turn',
          turn: 2,
          agent_name: 'Reviewer',
          usage: {
            input_tokens: 8,
            output_tokens: 3,
            cached_input_tokens: 2,
            cache_write_input_tokens: 0,
          },
        },
        expected: {
          'openai.agents.turn.number': 2,
          'gen_ai.agent.name': 'Reviewer',
          'gen_ai.usage.output_tokens': 3,
        },
      },
      {
        data: {
          type: 'generation',
          model: 'gpt-5',
          input: [{ role: 'user' }],
          output: [{ role: 'assistant' }],
          usage: { input_tokens: 12, output_tokens: 4 },
        },
        expected: {
          'gen_ai.request.model': 'gpt-5',
          'gen_ai.usage.input_tokens': 12,
        },
        absent: ['gen_ai.input.messages', 'gen_ai.output.messages'],
      },
      {
        data: {
          type: 'response',
          response_id: 'resp_123',
          _input: [{ role: 'user', content: 'Review this commit.' }],
          _response: { output: [{ content: 'No findings.' }] },
        },
        options: { recordInputs: true, recordOutputs: true },
        expected: {
          'gen_ai.response.id': 'resp_123',
          'gen_ai.input.messages': expect.stringContaining(
            'Review this commit.',
          ),
          'gen_ai.output.messages': expect.stringContaining('No findings.'),
        },
      },
      {
        data: {
          type: 'agent',
          name: 'Reviewer',
          tools: ['fetch_page'],
          handoffs: ['Escalation'],
          output_type: 'Review',
        },
        expected: {
          'openai.agents.agent.tools': ['fetch_page'],
          'openai.agents.agent.handoffs': ['Escalation'],
          'openai.agents.agent.output_type': 'Review',
        },
      },
      {
        data: { type: 'custom', name: 'sandbox.read', data: { path: '/tmp' } },
        options: { recordCustomData: true },
        expected: { 'openai.agents.custom.data': '{"path":"/tmp"}' },
      },
      {
        data: { type: 'mcp_tools', server: 'github', result: ['search'] },
        expected: {
          'openai.agents.mcp.server': 'github',
          'openai.agents.mcp.tools': ['search'],
        },
      },
      {
        data: {
          type: 'speech',
          input: 'Hello',
          output: { data: 'audio-data', format: 'pcm' },
          model: 'gpt-4o-mini-tts',
        },
        options: { recordInputs: true, recordOutputs: true },
        expected: {
          'gen_ai.request.model': 'gpt-4o-mini-tts',
          'openai.agents.speech.input': 'Hello',
          'openai.agents.audio.output_data': 'audio-data',
        },
      },
    ];

    for (const { data, options, expected, absent = [] } of cases) {
      const harness = createHarness(options);
      await harness.start();
      await harness.processor.onSpanStart(createAgentSpan(data));
      const attributes = harness.startSpan.mock.calls[1][1]?.attributes ?? {};
      expect(attributes).toEqual(expect.objectContaining(expected));
      for (const key of absent) expect(attributes).not.toHaveProperty(key);
    }
  });

  test('sanitizes custom data without affecting traced work', async () => {
    const harness = createHarness({ recordCustomData: true });
    const data: Record<string, unknown> = { kept: true, bigint: 1n };
    data.circular = data;
    const agentSpan = createAgentSpan({
      type: 'custom',
      name: 'arbitrary',
      data,
    });

    await harness.start();
    await expect(
      harness.processor.onSpanStart(agentSpan),
    ).resolves.toBeUndefined();
    expect(harness.startSpan.mock.calls[1][1]?.attributes).toEqual(
      expect.objectContaining({
        'openai.agents.custom.data': '{"kept":true}',
      }),
    );

    agentSpan.spanData.data = Object.defineProperty({}, 'unreadable', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    await expect(
      harness.processor.onSpanEnd(agentSpan),
    ).resolves.toBeUndefined();
  });

  test('suppresses model instrumentation and caches custom policy results', async () => {
    const withSpy = vi.spyOn(context, 'with');
    const policy = vi.fn((data: SpanData) => data.type === 'function');
    const customHarness = createHarness({ suppressInstrumentation: policy });
    const tool = createAgentSpan({
      type: 'function',
      name: 'fetch_page',
      input: '{}',
      output: 'ok',
    });
    await customHarness.start();
    await customHarness.processor.onSpanStart(tool);
    for (let index = 0; index < 3; index++) {
      await customHarness.processor.withSpan(tool, async () => undefined);
    }
    expect(policy).toHaveBeenCalledOnce();
    expect(isTracingSuppressed(withSpy.mock.calls[0][0])).toBe(true);
    withSpy.mockRestore();
  });

  test('isolates equal span IDs in different traces', async () => {
    const harness = createHarness();
    const traceA = await harness.start('trace_a');
    const traceB = await harness.start('trace_b');
    const spanA = createAgentSpan(
      { type: 'agent', name: 'Agent A' },
      { traceId: 'trace_a', spanId: 'shared' },
    );
    const spanB = createAgentSpan(
      { type: 'agent', name: 'Agent B' },
      { traceId: 'trace_b', spanId: 'shared' },
    );

    await harness.processor.onSpanStart(spanA);
    await harness.processor.onSpanStart(spanB);
    await harness.processor.onTraceEnd(traceA);
    await harness.processor.onTraceEnd(traceB);

    for (const span of harness.spans) expect(span.end).toHaveBeenCalledOnce();
  });

  test('contains suppression and context setup failures', async () => {
    const diagnostic = vi.spyOn(diag, 'error').mockImplementation(() => {});
    const policyError = new Error('policy failed');
    const policyHarness = createHarness({
      suppressInstrumentation: () => {
        throw policyError;
      },
    });
    const response = createAgentSpan({ type: 'response' });
    await policyHarness.start();
    await policyHarness.processor.onSpanStart(response);
    await expect(
      policyHarness.processor.withSpan(response, async () => 'result'),
    ).resolves.toBe('result');
    expect(diagnostic).toHaveBeenCalledWith(
      'OpenTelemetry suppression policy failed',
      policyError,
    );

    const setupError = new Error('span setup failed');
    const processor = new OpenTelemetryTracingProcessor({
      tracer: {
        startSpan: vi
          .fn()
          .mockReturnValueOnce(createOtelSpan())
          .mockImplementation(() => {
            throw setupError;
          }),
      } as unknown as Tracer,
    });
    await processor.onTraceStart(createTrace());
    await expect(
      processor.withSpan(response, async () => 'result'),
    ).resolves.toBe('result');
    expect(diagnostic).toHaveBeenCalledWith(
      'OpenTelemetry span context setup failed',
      setupError,
    );
    diagnostic.mockRestore();
  });

  test('delegates flush and shutdown when configured', async () => {
    const forceFlush = vi.fn(async () => undefined);
    const shutdown = vi.fn(async (_timeout?: number) => undefined);
    const processor = new OpenTelemetryTracingProcessor({
      forceFlush,
      shutdown,
    });

    await processor.forceFlush();
    await processor.shutdown(5000);

    expect(forceFlush).toHaveBeenCalledOnce();
    expect(shutdown).toHaveBeenCalledWith(5000);
  });

  test('exports a real hierarchy and preserves tool instrumentation', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
    const tracer = provider.getTracer('test');
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentTrace = createTrace('trace_123', 'Agent workflow');
    agentTrace.groupId = 'group_123';
    const agent = createAgentSpan(
      { type: 'agent', name: 'Reviewer' },
      { spanId: 'agent' },
    );
    const tool = createAgentSpan(
      { type: 'function', name: 'fetch_page', input: '{}', output: 'Example' },
      { spanId: 'tool', parentId: 'agent' },
    );
    const response = createAgentSpan(
      { type: 'response' },
      { spanId: 'response', parentId: 'agent' },
    );

    try {
      await processor.onTraceStart(agentTrace);
      await processor.onSpanStart(agent);
      await processor.onSpanStart(tool);
      await processor.withSpan(tool, async () => {
        const internal = tracer.startSpan('tool-internal');
        internal.end();
      });
      await processor.onSpanEnd(tool);
      await processor.onSpanStart(response);
      await processor.withSpan(response, async () => {
        expect(isTracingSuppressed(context.active())).toBe(true);
      });
      await processor.onSpanEnd(response);
      await processor.onSpanEnd(agent);
      await processor.onTraceEnd(agentTrace);
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const byName = (name: string) => spans.find((span) => span.name === name);
      const root = byName('Agent workflow');
      const agentSpan = byName('invoke_agent Reviewer');
      const toolSpan = byName('execute_tool fetch_page');
      const responseSpan = byName('chat');
      expect(root?.attributes).toEqual(
        expect.objectContaining({
          'openai.agents.trace.id': 'trace_123',
          'openai.agents.group.id': 'group_123',
        }),
      );
      expect(agentSpan?.parentSpanContext?.spanId).toBe(
        root?.spanContext().spanId,
      );
      expect(toolSpan?.parentSpanContext?.spanId).toBe(
        agentSpan?.spanContext().spanId,
      );
      expect(byName('tool-internal')?.parentSpanContext?.spanId).toBe(
        toolSpan?.spanContext().spanId,
      );
      expect(responseSpan?.parentSpanContext?.spanId).toBe(
        agentSpan?.spanContext().spanId,
      );
    } finally {
      context.disable();
      await provider.shutdown();
    }
  });
});
