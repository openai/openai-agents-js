import {
  context,
  trace,
  type Span as OtelSpan,
  type Tracer,
} from '@opentelemetry/api';
import { isTracingSuppressed } from '@opentelemetry/core';
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
    const agentSpan = {
      traceId: 'trace_123',
      spanId: 'span_123',
      parentId: null,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-01-01T00:00:01.000Z',
      error: null,
      spanData: { type: 'agent', name: 'Support agent' },
    } as unknown as Span;

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

  test('suppresses nested automatic instrumentation by default', async () => {
    const otelSpan = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValue(otelSpan),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentSpan = {
      traceId: 'trace_123',
      spanId: 'span_123',
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: { type: 'function', name: 'lookup', input: '{}', output: '{}' },
    } as unknown as Span;

    await processor.onSpanStart(agentSpan);
    const withSpy = vi.spyOn(context, 'with');
    await processor.withSpan(agentSpan, async () => undefined);
    const activeContext = withSpy.mock.calls[0]?.[0];
    expect(trace.getSpan(activeContext!)).toBe(otelSpan);
    expect(isTracingSuppressed(activeContext!)).toBe(true);
  });

  test('does not record model input or output unless requested', async () => {
    const otelSpan = createOtelSpan();
    const tracer = {
      startSpan: vi.fn().mockReturnValue(otelSpan),
    } as unknown as Tracer;
    const processor = new OpenTelemetryTracingProcessor({ tracer });
    const agentSpan = {
      traceId: 'trace_123',
      spanId: 'span_123',
      parentId: null,
      startedAt: null,
      endedAt: null,
      error: null,
      spanData: {
        type: 'generation',
        model: 'gpt-5',
        input: [{ role: 'user' }],
        output: [{ role: 'assistant' }],
        usage: { input_tokens: 12, output_tokens: 4 },
      },
    } as unknown as Span;

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
});
