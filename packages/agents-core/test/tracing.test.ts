import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  timeIso,
  generateTraceId,
  generateSpanId,
  generateGroupId,
  removePrivateFields,
} from '../src/tracing/utils';

import { Trace, NoopTrace } from '../src/tracing/traces';

import {
  Span,
  CustomSpanData,
  ResponseSpanData,
  NoopSpan,
} from '../src/tracing/spans';

import {
  BatchTraceProcessor,
  MultiTracingProcessor,
  TracingExporter,
  TracingProcessor,
  defaultProcessor,
} from '../src/tracing/processor';

import {
  withTrace,
  getCurrentTrace,
  getCurrentSpan,
  setTraceProcessors,
  setTracingDisabled,
} from '../src/tracing';

import { withAgentSpan } from '../src/tracing/createSpans';

import { TraceProvider } from '../src/tracing/provider';

import { Runner } from '../src/run';
import { Agent } from '../src/agent';
import { FakeModel, fakeModelMessage, FakeModelProvider } from './stubs';
import { Usage } from '../src/usage';
import * as protocol from '../src/types/protocol';
import { setDefaultModelProvider } from '../src/providers';

class TestExporter implements TracingExporter {
  public exported: Array<(Trace | Span<any>)[]> = [];

  async export(items: (Trace | Span<any>)[]): Promise<void> {
    // Push a shallow copy so that later mutations don't affect stored value
    this.exported.push([...items]);
  }
}

class TestProcessor implements TracingProcessor {
  public tracesStarted: Trace[] = [];
  public tracesEnded: Trace[] = [];
  public spansStarted: Span<any>[] = [];
  public spansEnded: Span<any>[] = [];

  async onTraceStart(trace: Trace): Promise<void> {
    this.tracesStarted.push(trace);
  }
  async onTraceEnd(trace: Trace): Promise<void> {
    this.tracesEnded.push(trace);
  }
  async onSpanStart(span: Span<any>): Promise<void> {
    this.spansStarted.push(span);
  }
  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spansEnded.push(span);
  }
  async shutdown(): Promise<void> {
    /* noop */
  }
  async forceFlush(): Promise<void> {
    /* noop */
  }
}

// -----------------------------------------------------------------------------------------
// Tests for utils.ts.
// -----------------------------------------------------------------------------------------

describe('tracing/utils', () => {
  it('timeIso returns ISO‑8601 timestamps', () => {
    const iso = timeIso();
    // Date constructor will throw for invalid ISO strings
    const parsed = new Date(iso);
    expect(Number.isNaN(parsed.getTime())).toBe(false);
  });

  it('generateTraceId / SpanId / GroupId follow expected format and uniqueness', () => {
    const traceId = generateTraceId();
    const spanId = generateSpanId();
    const groupId = generateGroupId();

    expect(traceId).toMatch(/^trace_[a-f0-9]{32}$/);
    expect(spanId).toMatch(/^span_[a-f0-9]{24}$/);
    expect(groupId).toMatch(/^group_[a-f0-9]{24}$/);

    // uniqueness check – extremely low probability of collision
    expect(generateTraceId()).not.toEqual(traceId);
    expect(generateSpanId()).not.toEqual(spanId);
    expect(generateGroupId()).not.toEqual(groupId);
  });

  it('removePrivateFields removes keys starting with "_"', () => {
    const obj = { a: 1, _b: 2, c: 3, _d: 4 };
    const cleaned = removePrivateFields(obj);
    expect(cleaned).toEqual({ a: 1, c: 3 });
  });
});

// -----------------------------------------------------------------------------------------
// Tests for Span / Trace core behavior.
// -----------------------------------------------------------------------------------------

describe('Trace & Span lifecycle', () => {
  const processor = new TestProcessor();

  it('Trace start/end invokes processor callbacks', async () => {
    const trace = new Trace({ name: 'test-trace' }, processor);

    await trace.start();
    expect(processor.tracesStarted).toContain(trace);

    await trace.end();
    expect(processor.tracesEnded).toContain(trace);
  });

  it('Span start/end/error/clone works as expected', () => {
    const data: CustomSpanData = {
      type: 'custom',
      name: 'span',
      data: { x: 1 },
    };
    const span = new Span({ traceId: 'trace_123', data }, processor);

    // start
    span.start();
    expect(processor.spansStarted).toContain(span);
    expect(span.startedAt).not.toBeNull();

    // error
    span.setError({ message: 'boom' });
    expect(span.error).toEqual({ message: 'boom' });

    // end
    span.end();
    expect(processor.spansEnded).toContain(span);
    expect(span.endedAt).not.toBeNull();

    // clone produces deep copy retaining ids but not referential equality
    const clone = span.clone();
    expect(clone).not.toBe(span);
    expect(clone.spanId).toBe(span.spanId);
    expect(clone.traceId).toBe(span.traceId);

    // JSON output contains expected shape
    const json = span.toJSON() as any;
    expect(json.object).toBe('trace.span');
    expect(json.id).toBe(span.spanId);
    expect(json.trace_id).toBe(span.traceId);
    expect(json.span_data).toHaveProperty('type', 'custom');
  });
});

// -----------------------------------------------------------------------------------------
// Tests for BatchTraceProcessor (happy‑path).
// -----------------------------------------------------------------------------------------

describe('BatchTraceProcessor', () => {
  const exporter = new TestExporter();

  it('buffers items and flushes them when forceFlush is called', async () => {
    const processor = new BatchTraceProcessor(exporter, {
      maxQueueSize: 10,
      maxBatchSize: 5,
      scheduleDelay: 10000, // large so automatic timer does not interfere
    });

    // Add two fake traces
    const t1 = new Trace({ name: 'a' });
    const t2 = new Trace({ name: 'b' });
    await processor.onTraceStart(t1);
    await processor.onTraceStart(t2);

    // Nothing exported yet – buffer should be present
    expect(exporter.exported.length).toBe(0);

    // Force flush should push one batch into exporter
    await processor.forceFlush();

    expect(exporter.exported.length).toBe(1);
    const batch = exporter.exported[0];
    expect(batch).toContain(t1);
    expect(batch).toContain(t2);
  });
});

// -----------------------------------------------------------------------------------------
// Tests for high‑level context helpers.
// -----------------------------------------------------------------------------------------

describe('withTrace & span helpers (integration)', () => {
  const processor = new TestProcessor();

  beforeEach(() => {
    // Replace processors with isolated test processor
    setTraceProcessors([processor]);
    // Tracing is disabled by default during tests
    setTracingDisabled(false);
  });

  afterEach(() => {
    // Clean up to avoid cross‑test leakage
    processor.tracesStarted.length = 0;
    processor.tracesEnded.length = 0;
    processor.spansStarted.length = 0;
    processor.spansEnded.length = 0;

    // Restore original default processor so other test suites are unaffected
    // restore the global processor so subsequent tests are unaffected
    setTraceProcessors([defaultProcessor()]);
  });

  it('withTrace creates a trace that is accessible via getCurrentTrace()', async () => {
    let insideTrace: Trace | null = null;

    await withTrace('workflow', async (trace) => {
      insideTrace = getCurrentTrace();
      expect(insideTrace).toBe(trace);
      return 'done';
    });

    // Outside the AsyncLocalStorage scope there should be no active trace
    expect(getCurrentTrace()).toBeNull();

    // Processor should have been notified
    expect(processor.tracesStarted.length).toBe(1);
    expect(processor.tracesEnded.length).toBe(1);
  });

  it('withAgentSpan nests a span within a trace and resets current span afterwards', async () => {
    let capturedSpanId: string | null = null;

    await withTrace('workflow', async () => {
      // At this point there is no current span
      expect(getCurrentSpan()).toBeNull();

      await withAgentSpan(async (span) => {
        capturedSpanId = span.spanId;
        // Inside the callback, the span should be the current one
        expect(getCurrentSpan()).toBe(span);
      });

      // After the helper returns, current span should be reset
      expect(getCurrentSpan()).toBeNull();
    });

    // Processor should have received span start/end notifications
    const startedIds = processor.spansStarted.map((s) => s.spanId);
    const endedIds = processor.spansEnded.map((s) => s.spanId);
    expect(startedIds).toContain(capturedSpanId);
    expect(endedIds).toContain(capturedSpanId);
  });

  it('streaming run waits for stream loop to complete before calling onTraceEnd', async () => {
    // Set up model provider
    setDefaultModelProvider(new FakeModelProvider());

    const traceStartTimes: number[] = [];
    const traceEndTimes: number[] = [];
    const spanEndTimes: number[] = [];

    class OrderTrackingProcessor implements TracingProcessor {
      async onTraceStart(_trace: Trace): Promise<void> {
        traceStartTimes.push(Date.now());
      }
      async onTraceEnd(_trace: Trace): Promise<void> {
        traceEndTimes.push(Date.now());
      }
      async onSpanStart(_span: Span<any>): Promise<void> {
        // noop
      }
      async onSpanEnd(_span: Span<any>): Promise<void> {
        spanEndTimes.push(Date.now());
      }
      async shutdown(): Promise<void> {
        /* noop */
      }
      async forceFlush(): Promise<void> {
        /* noop */
      }
    }

    const orderProcessor = new OrderTrackingProcessor();
    setTraceProcessors([orderProcessor]);

    // Create a fake model that supports streaming
    class StreamingFakeModel extends FakeModel {
      async *getStreamedResponse(
        _request: any,
      ): AsyncIterable<protocol.StreamEvent> {
        const response = await this.getResponse(_request);
        yield {
          type: 'response_done',
          response: {
            id: 'resp-1',
            usage: {
              requests: 1,
              inputTokens: 0,
              outputTokens: 0,
              totalTokens: 0,
            },
            output: response.output,
          },
        } as any;
      }
    }

    const agent = new Agent({
      name: 'TestAgent',
      model: new StreamingFakeModel([
        {
          output: [fakeModelMessage('Final output')],
          usage: new Usage(),
        },
      ]),
    });

    const runner = new Runner({
      tracingDisabled: false,
    });

    // Run with streaming
    const result = await runner.run(agent, 'test input', { stream: true });

    // Consume the stream
    for await (const _event of result) {
      // consume all events
    }

    // Wait for completion
    await result.completed;

    // onTraceEnd should be called after all spans have ended
    expect(traceStartTimes.length).toBe(1);
    expect(traceEndTimes.length).toBe(1);
    expect(spanEndTimes.length).toBeGreaterThan(0);

    // The trace should end after all spans have ended
    const lastSpanEndTime = Math.max(...spanEndTimes);
    const traceEndTime = traceEndTimes[0];

    expect(traceEndTime).toBeGreaterThanOrEqual(lastSpanEndTime);
  });
});

// -----------------------------------------------------------------------------------------
// Tests for MultiTracingProcessor.
// -----------------------------------------------------------------------------------------

describe('MultiTracingProcessor', () => {
  it('should call all processors shutdown when setting new processors', () => {
    const processor1 = new TestProcessor();
    processor1.shutdown = vi.fn();
    const processor2 = new TestProcessor();
    processor2.shutdown = vi.fn();
    const multiProcessor = new MultiTracingProcessor();
    multiProcessor.setProcessors([processor1]);
    expect(processor1.shutdown).not.toHaveBeenCalled();
    expect(processor2.shutdown).not.toHaveBeenCalled();
    multiProcessor.setProcessors([processor2]);
    expect(processor1.shutdown).toHaveBeenCalled();
    expect(processor2.shutdown).not.toHaveBeenCalled();
    multiProcessor.shutdown();
    expect(processor2.shutdown).toHaveBeenCalled();
    expect(processor1.shutdown).toHaveBeenCalledTimes(1);
    expect(processor2.shutdown).toHaveBeenCalledTimes(1);
  });
});

// -----------------------------------------------------------------------------------------
// Tests for TraceProvider disabled flag.
// -----------------------------------------------------------------------------------------

describe('TraceProvider disabled behavior', () => {
  it('returns NoopTrace/NoopSpan when disabled', () => {
    const provider = new TraceProvider();
    provider.setDisabled(true);

    const trace = provider.createTrace({ name: 'disabled' });
    expect(trace).toBeInstanceOf(NoopTrace);

    const span = provider.createSpan(
      {
        data: { type: 'custom', name: 'noop', data: {} },
      },
      trace,
    );
    expect(span).toBeInstanceOf(NoopSpan);
  });
});

// -----------------------------------------------------------------------------------------
// Tests for ResponseSpanData serialization.
// -----------------------------------------------------------------------------------------

describe('ResponseSpanData serialization', () => {
  it('removes private fields _input and _response from JSON output', () => {
    const data: ResponseSpanData = {
      type: 'response',
      response_id: 'resp_123',
      _input: 'private input data',
      _response: { id: 'response_obj' } as any,
    };

    const span = new Span({ traceId: 'trace_123', data }, new TestProcessor());

    const json = span.toJSON() as any;

    expect(json.span_data.type).toBe('response');
    expect(json.span_data.response_id).toBe('resp_123');
    expect(json.span_data).not.toHaveProperty('_input');
    expect(json.span_data).not.toHaveProperty('_response');
  });
});
