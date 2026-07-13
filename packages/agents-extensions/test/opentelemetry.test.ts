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
import type { Span, Trace } from '@openai/agents-core';
import { OpenTelemetryTracingProcessor } from '../src/opentelemetry';

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
  spanData: Record<string, any>,
  options: {
    traceId?: string;
    spanId?: string;
    parentId?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
    error?: Span['error'];
  } = {},
): Span {
  return {
    traceId: options.traceId ?? 'trace_123',
    spanId: options.spanId ?? 'span_123',
    parentId: options.parentId ?? null,
    startedAt: options.startedAt ?? null,
    endedAt: options.endedAt ?? null,
    error: options.error ?? null,
    spanData,
  } as unknown as Span;
}

async function startTestTrace(
  processor: OpenTelemetryTracingProcessor,
  traceId: string = 'trace_123',
): Promise<void> {
  await processor.onTraceStart({
    traceId,
    name: `Trace ${traceId}`,
    groupId: null,
  } as Trace);
}

describe('OpenTelemetryTracingProcessor', () => {
  test('creates a trace root and nests agent spans beneath it', async () => {
    const root = createOtelSpan();
    const child = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValueOnce(root).mockReturnValueOnce(child),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentTrace = {
      traceId: 'trace_123',
      name: 'Support workflow',
      groupId: 'group_123',
    } as Trace;
    const agentSpan = createAgentSpan(
      { type: 'agent', name: 'Support agent' },
      {
        startedAt: '2026-01-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:01.000Z',
      },
    );

    await processor.onTraceStart(agentTrace);
    await processor.onSpanStart(agentSpan);
    await processor.onSpanEnd(agentSpan);
    await processor.onTraceEnd(agentTrace);

    expect(tracer.startSpan).toHaveBeenNthCalledWith(
      1,
      'Support workflow',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'openai.agents.trace.id': 'trace_123',
        }),
      }),
    );
    expect(tracer.startSpan).toHaveBeenNthCalledWith(
      2,
      'invoke_agent Support agent',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'gen_ai.agent.name': 'Support agent',
        }),
      }),
      expect.anything(),
    );
    expect(child.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({ 'openai.agents.span.type': 'agent' }),
    );
    expect(child.end).toHaveBeenCalled();
    expect(root.end).toHaveBeenCalled();
  });

  test('falls back to the Agents trace root when a parent span is missing', async () => {
    const root = createOtelSpan();
    const child = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValueOnce(root).mockReturnValueOnce(child),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentTrace = {
      traceId: 'trace_123',
      name: 'Resumed workflow',
      groupId: null,
    } as Trace;
    const childSpan = createAgentSpan(
      { type: 'function', name: 'approved_tool' },
      { spanId: 'span_child', parentId: 'span_missing' },
    );

    await processor.onTraceStart(agentTrace);
    await processor.onSpanStart(childSpan);

    const parentContext = vi.mocked(tracer.startSpan).mock.calls[1]?.[2];
    expect(trace.getSpan(parentContext!)).toBe(root);

    await processor.onTraceEnd(agentTrace);
    expect(child.end).toHaveBeenCalled();
  });

  test('refreshes open span attributes before trace cleanup', async () => {
    const root = createOtelSpan();
    const agent = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValueOnce(root).mockReturnValueOnce(agent),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentTrace = {
      traceId: 'trace_123',
      name: 'Successful workflow',
      groupId: null,
    } as Trace;
    const agentSpan = createAgentSpan({
      type: 'agent',
      name: 'Reviewer',
      tools: [],
      handoffs: [],
    });

    await processor.onTraceStart(agentTrace);
    await processor.onSpanStart(agentSpan);
    agentSpan.spanData.tools = ['fetch_page'];
    agentSpan.spanData.handoffs = ['Escalation'];
    await processor.onTraceEnd(agentTrace);

    expect(agent.setAttributes).toHaveBeenCalledWith(
      expect.objectContaining({
        'openai.agents.agent.tools': ['fetch_page'],
        'openai.agents.agent.handoffs': ['Escalation'],
      }),
    );
    expect(agent.end).toHaveBeenCalled();
    expect(root.end).toHaveBeenCalled();
  });

  test('suppresses nested automatic instrumentation by default', async () => {
    const otelSpan = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValue(otelSpan),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentSpan = createAgentSpan({ type: 'response' });

    await startTestTrace(processor);
    await processor.onSpanStart(agentSpan);
    const withSpy = vi.spyOn(context, 'with');
    await processor.withSpan(agentSpan, async () => undefined);
    const activeContext = withSpy.mock.calls[0]?.[0];
    expect(trace.getSpan(activeContext!)).toBe(otelSpan);
    expect(isTracingSuppressed(activeContext!)).toBe(true);
    withSpy.mockRestore();
  });

  test('supports a custom instrumentation suppression policy', async () => {
    const otelSpan = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValue(otelSpan),
    } as unknown as Tracer;
    const suppressInstrumentation = vi.fn(
      (spanData: Span['spanData']) => spanData.type === 'function',
    );
    const processor = new OpenTelemetryTracingProcessor({
      tracer,
      suppressInstrumentation,
    });
    const agentSpan = createAgentSpan({
      type: 'function',
      name: 'fetch_page',
    });

    await startTestTrace(processor);
    await processor.onSpanStart(agentSpan);
    const withSpy = vi.spyOn(context, 'with');
    await processor.withSpan(agentSpan, async () => undefined);
    const activeContext = withSpy.mock.calls[0]?.[0];

    expect(suppressInstrumentation).toHaveBeenCalledWith(agentSpan.spanData);
    expect(isTracingSuppressed(activeContext!)).toBe(true);
    withSpy.mockRestore();
  });

  test('does not record model input or output unless requested', async () => {
    const otelSpan = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValue(otelSpan),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentSpan = createAgentSpan({
      type: 'generation',
      model: 'gpt-5',
      input: [{ role: 'user' }],
      output: [{ role: 'assistant' }],
      usage: { input_tokens: 12, output_tokens: 4 },
    });

    await startTestTrace(processor);
    await processor.onSpanStart(agentSpan);

    expect(tracer.startSpan).toHaveBeenCalledWith(
      'chat gpt-5',
      expect.objectContaining({
        attributes: expect.not.objectContaining({
          'gen_ai.input.messages': expect.anything(),
          'gen_ai.output.messages': expect.anything(),
        }),
      }),
      expect.anything(),
    );
  });

  test('records Responses API payloads when content capture is enabled', async () => {
    const otelSpan = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValue(otelSpan),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({
      tracer,
      recordInputs: true,
      recordOutputs: true,
    });
    const agentSpan = createAgentSpan({
      type: 'response',
      response_id: 'resp_123',
      _input: [{ role: 'user', content: 'Review this commit.' }],
      _response: { output: [{ type: 'message', content: 'No findings.' }] },
    });

    await startTestTrace(processor);
    await processor.onSpanStart(agentSpan);

    expect(tracer.startSpan).toHaveBeenCalledWith(
      'chat',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'gen_ai.response.id': 'resp_123',
          'gen_ai.input.messages': expect.stringContaining(
            'Review this commit.',
          ),
          'gen_ai.output.messages': expect.stringContaining('No findings.'),
        }),
      }),
      expect.anything(),
    );
  });

  test('exports agent capabilities and non-text span metadata', async () => {
    const otelSpan = createOtelSpan();
    const startSpan = vi.fn().mockReturnValue(otelSpan);
    const tracer = { startSpan } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({
      tracer,
      recordInputs: true,
      recordOutputs: true,
      recordCustomData: true,
    });
    const spans = [
      {
        spanId: 'agent',
        spanData: {
          type: 'agent',
          name: 'Reviewer',
          tools: ['fetch_page'],
          handoffs: ['Escalation'],
          output_type: 'Review',
        },
      },
      {
        spanId: 'custom',
        spanData: {
          type: 'custom',
          name: 'sandbox.read',
          data: { path: '/tmp' },
        },
      },
      {
        spanId: 'mcp',
        spanData: {
          type: 'mcp_tools',
          server: 'github',
          result: ['search', 'get_file'],
        },
      },
      {
        spanId: 'speech',
        spanData: {
          type: 'speech',
          input: 'Hello',
          output: { data: 'audio-data', format: 'pcm' },
          model: 'gpt-4o-mini-tts',
        },
      },
    ].map(
      ({ spanId, spanData }) =>
        ({
          traceId: 'trace_123',
          spanId,
          parentId: null,
          startedAt: null,
          endedAt: null,
          error: null,
          spanData,
        }) as unknown as Span,
    );

    await startTestTrace(processor);
    for (const span of spans) await processor.onSpanStart(span);

    const attributes = startSpan.mock.calls.map((call) => call[1]?.attributes);
    expect(attributes).toContainEqual(
      expect.objectContaining({
        'openai.agents.agent.tools': ['fetch_page'],
        'openai.agents.agent.handoffs': ['Escalation'],
        'openai.agents.agent.output_type': 'Review',
      }),
    );
    expect(attributes).toContainEqual(
      expect.objectContaining({
        'openai.agents.custom.name': 'sandbox.read',
        'openai.agents.custom.data': '{"path":"/tmp"}',
      }),
    );
    expect(attributes).toContainEqual(
      expect.objectContaining({
        'openai.agents.mcp.server': 'github',
        'openai.agents.mcp.tools': ['search', 'get_file'],
      }),
    );
    expect(attributes).toContainEqual(
      expect.objectContaining({
        'gen_ai.request.model': 'gpt-4o-mini-tts',
        'openai.agents.audio.output_format': 'pcm',
        'openai.agents.speech.input': 'Hello',
        'openai.agents.audio.output_data': 'audio-data',
      }),
    );
  });

  test('delegates tracing lifecycle when callbacks are configured', async () => {
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

  test('custom data serialization cannot fail traced work', async () => {
    const otelSpan = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValue(otelSpan),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({
      tracer,
      recordCustomData: true,
    });
    const data: Record<string, unknown> = { kept: true, bigint: 1n };
    data.circular = data;
    const agentSpan = {
      traceId: 'trace_123',
      spanId: 'span_123',
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: { type: 'custom', name: 'arbitrary', data },
    } as unknown as Span;

    await startTestTrace(processor);
    await expect(processor.onSpanStart(agentSpan)).resolves.toBeUndefined();
    expect(tracer.startSpan).toHaveBeenCalledWith(
      'custom arbitrary',
      expect.objectContaining({
        attributes: expect.objectContaining({
          'openai.agents.custom.data': '{"kept":true}',
        }),
      }),
      expect.anything(),
    );

    agentSpan.spanData.data = Object.defineProperty({}, 'unreadable', {
      enumerable: true,
      get() {
        throw new Error('unreadable');
      },
    });
    await expect(processor.onSpanEnd(agentSpan)).resolves.toBeUndefined();
    expect(otelSpan.end).toHaveBeenCalled();
  });

  test('isolates equal span IDs in different traces', async () => {
    const rootA = createOtelSpan();
    const rootB = createOtelSpan();
    const spanA = createOtelSpan();
    const spanB = createOtelSpan();
    const tracer = {
      startSpan: vi
        .fn()
        .mockReturnValueOnce(rootA)
        .mockReturnValueOnce(rootB)
        .mockReturnValueOnce(spanA)
        .mockReturnValueOnce(spanB),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentSpanA = createAgentSpan(
      { type: 'agent', name: 'Agent A' },
      { traceId: 'trace_a', spanId: 'shared_span_id' },
    );
    const agentSpanB = createAgentSpan(
      { type: 'agent', name: 'Agent B' },
      { traceId: 'trace_b', spanId: 'shared_span_id' },
    );

    await startTestTrace(processor, 'trace_a');
    await startTestTrace(processor, 'trace_b');
    await processor.onSpanStart(agentSpanA);
    await processor.onSpanStart(agentSpanB);
    await processor.onSpanEnd(agentSpanA);
    await processor.onSpanEnd(agentSpanB);
    await processor.onTraceEnd({ traceId: 'trace_a' } as Trace);
    await processor.onTraceEnd({ traceId: 'trace_b' } as Trace);

    expect(spanA.end).toHaveBeenCalledOnce();
    expect(spanB.end).toHaveBeenCalledOnce();
    expect(rootA.end).toHaveBeenCalledOnce();
    expect(rootB.end).toHaveBeenCalledOnce();
  });

  test('evaluates custom suppression policy once per span', async () => {
    const root = createOtelSpan();
    const otelSpan = createOtelSpan();
    const tracer = {
      startSpan: vi
        .fn()
        .mockReturnValueOnce(root)
        .mockReturnValueOnce(otelSpan),
    } as unknown as Tracer;
    const suppressInstrumentation = vi.fn(() => true);
    const processor = new OpenTelemetryTracingProcessor({
      tracer,
      suppressInstrumentation,
    });
    const agentSpan = createAgentSpan({ type: 'response' });

    await startTestTrace(processor);
    await processor.onSpanStart(agentSpan);
    await processor.withSpan(agentSpan, async () => undefined);
    await processor.withSpan(agentSpan, async () => undefined);
    await processor.withSpan(agentSpan, async () => undefined);

    expect(suppressInstrumentation).toHaveBeenCalledOnce();
  });

  test('does not let suppression policy failures affect traced work', async () => {
    const root = createOtelSpan();
    const otelSpan = createOtelSpan();
    const tracer = {
      startSpan: vi
        .fn()
        .mockReturnValueOnce(root)
        .mockReturnValueOnce(otelSpan),
    } as unknown as Tracer;
    const policyError = new Error('policy failed');
    const suppressInstrumentation = vi.fn(() => {
      throw policyError;
    });
    const diagnostic = vi.spyOn(diag, 'error').mockImplementation(() => {
      // Expected policy failure.
    });
    const processor = new OpenTelemetryTracingProcessor({
      tracer,
      suppressInstrumentation,
    });
    const agentSpan = createAgentSpan({ type: 'response' });
    const work = vi.fn(async () => 'result');

    await startTestTrace(processor);
    await expect(processor.onSpanStart(agentSpan)).resolves.toBeUndefined();
    await expect(processor.withSpan(agentSpan, work)).resolves.toBe('result');

    expect(work).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      'OpenTelemetry suppression policy failed',
      policyError,
    );
    diagnostic.mockRestore();
  });

  test('does not let span context setup failures affect traced work', async () => {
    const root = createOtelSpan();
    const setupError = new Error('span setup failed');
    const tracer = {
      startSpan: vi
        .fn()
        .mockReturnValueOnce(root)
        .mockImplementation(() => {
          throw setupError;
        }),
    } as unknown as Tracer;
    const diagnostic = vi.spyOn(diag, 'error').mockImplementation(() => {
      // Expected setup failure.
    });
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentSpan = createAgentSpan({ type: 'response' });
    const work = vi.fn(async () => 'result');

    await startTestTrace(processor);
    await expect(processor.withSpan(agentSpan, work)).resolves.toBe('result');

    expect(work).toHaveBeenCalledOnce();
    expect(diagnostic).toHaveBeenCalledWith(
      'OpenTelemetry span context setup failed',
      setupError,
    );
    diagnostic.mockRestore();
  });

  test('exports a real OTel hierarchy and preserves tool instrumentation', async () => {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const contextManager = new AsyncLocalStorageContextManager().enable();
    context.setGlobalContextManager(contextManager);
    const tracer = provider.getTracer('test');
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentTrace = {
      traceId: 'trace_123',
      name: 'Agent workflow',
      groupId: null,
    } as Trace;
    const makeSpan = (
      spanId: string,
      parentId: string | null,
      spanData: Record<string, unknown>,
    ) =>
      ({
        traceId: 'trace_123',
        spanId,
        parentId,
        startedAt: null,
        endedAt: null,
        error: null,
        spanData,
      }) as unknown as Span;
    const agentSpan = makeSpan('agent', null, {
      type: 'agent',
      name: 'Reviewer',
    });
    const toolSpan = makeSpan('tool', 'agent', {
      type: 'function',
      name: 'fetch_page',
      input: '{}',
      output: 'Example Domain',
    });
    const responseSpan = makeSpan('response', 'agent', {
      type: 'response',
    });

    try {
      await processor.onTraceStart(agentTrace);
      await processor.onSpanStart(agentSpan);
      await processor.onSpanStart(toolSpan);
      await processor.withSpan(toolSpan, async () => {
        expect(isTracingSuppressed(context.active())).toBe(false);
        const internalSpan = tracer.startSpan('tool-internal');
        internalSpan.end();
      });
      await processor.onSpanEnd(toolSpan);

      await processor.onSpanStart(responseSpan);
      await processor.withSpan(responseSpan, async () => {
        expect(isTracingSuppressed(context.active())).toBe(true);
      });
      await processor.onSpanEnd(responseSpan);
      await processor.onSpanEnd(agentSpan);
      await processor.onTraceEnd(agentTrace);
      await provider.forceFlush();

      const spans = exporter.getFinishedSpans();
      const root = spans.find((span) => span.name === 'Agent workflow');
      const agent = spans.find((span) => span.name === 'invoke_agent Reviewer');
      const tool = spans.find(
        (span) => span.name === 'execute_tool fetch_page',
      );
      const internal = spans.find((span) => span.name === 'tool-internal');
      const response = spans.find((span) => span.name === 'chat');

      expect(root).toBeDefined();
      expect(agent?.parentSpanContext?.spanId).toBe(root?.spanContext().spanId);
      expect(tool?.parentSpanContext?.spanId).toBe(agent?.spanContext().spanId);
      expect(internal?.parentSpanContext?.spanId).toBe(
        tool?.spanContext().spanId,
      );
      expect(response?.parentSpanContext?.spanId).toBe(
        agent?.spanContext().spanId,
      );
    } finally {
      context.disable();
      await provider.shutdown();
    }
  });
});
