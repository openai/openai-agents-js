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
  setCurrentSpan,
  resetCurrentSpan,
} from '../src/tracing';
import {
  cloneCurrentContext,
  withNewSpanContext,
} from '../src/tracing/context';

import { withAgentSpan, createAgentSpan } from '../src/tracing/createSpans';

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
  beforeEach(() => {
    setTracingDisabled(false);
  });
  afterEach(() => {
    setTracingDisabled(true);
  });

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

  it('propagates tracing api key from trace to spans', async () => {
    await withTrace(
      'workflow',
      async () => {
        const trace = getCurrentTrace();
        expect(trace?.tracingApiKey).toBe('run-key');
        const span = createAgentSpan({ data: { name: 'span' } });
        expect(span.tracingApiKey).toBe('run-key');
      },
      { tracingApiKey: 'run-key' },
    );
  });
});

describe('Span creation inherits tracing api key from parents', () => {
  const provider = new TraceProvider();
  beforeEach(() => {
    provider.setDisabled(false);
  });

  it('inherits from parent trace', () => {
    const trace = provider.createTrace({ tracingApiKey: 'trace-key' });
    const span = provider.createSpan(
      { data: { type: 'custom', name: 's', data: {} } },
      trace,
    );
    expect(span.tracingApiKey).toBe('trace-key');
  });

  it('inherits from parent span', () => {
    const trace = provider.createTrace({ tracingApiKey: 'trace-key' });
    const parent = provider.createSpan(
      { data: { type: 'custom', name: 'p', data: {} } },
      trace,
    );
    const child = provider.createSpan(
      { data: { type: 'custom', name: 'c', data: {} } },
      parent,
    );
    expect(child.tracingApiKey).toBe('trace-key');
  });
});

describe('Runner tracing configuration', () => {
  beforeEach(() => {
    setDefaultModelProvider(new FakeModelProvider());
    setTracingDisabled(false);
  });

  afterEach(() => {
    setTraceProcessors([defaultProcessor()]);
    setTracingDisabled(true);
  });

  it('uses per-run tracing api key when creating trace', async () => {
    const processor = new TestProcessor();
    setTraceProcessors([processor]);

    const agent = new Agent({
      name: 'TestAgent',
      model: new FakeModel([
        {
          output: [fakeModelMessage('hi')],
          usage: new Usage(),
        },
      ]),
    });

    const runner = new Runner({ tracingDisabled: false });
    await runner.run(agent, 'hello', { tracing: { apiKey: 'runner-key' } });

    expect(processor.tracesStarted[0]?.tracingApiKey).toBe('runner-key');
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

  it('clears global fallback even when a cloned context is installed', async () => {
    const CONTEXT_SYMBOL = Symbol.for('openai.agents.core.lastContext');

    await withTrace('workflow', async () => {
      const current = (globalThis as any)[CONTEXT_SYMBOL];
      expect(current?.trace?.traceId).toBeDefined();

      const cloned = cloneCurrentContext(current);
      // Simulate a nested scope installing a cloned context on the global fallback.
      (globalThis as any)[CONTEXT_SYMBOL] = cloned;
    });

    expect((globalThis as any)[CONTEXT_SYMBOL]).toBeUndefined();
  });

  it('uses global fallback only when a single trace owner is active', () => {
    const CONTEXT_SYMBOL = Symbol.for('openai.agents.core.lastContext');
    const OWNERS_SYMBOL = Symbol.for('openai.agents.core.globalFallbackOwners');
    const ownerToken = Symbol('owner');

    const context = {
      trace: new Trace({ name: 'global-fallback' }),
      active: true,
      fallbackOwnerToken: ownerToken,
    } as any;

    (globalThis as any)[OWNERS_SYMBOL] = new Set<symbol>([ownerToken]);
    (globalThis as any)[CONTEXT_SYMBOL] = context;

    expect(getCurrentTrace()?.traceId).toBe(context.trace.traceId);

    (globalThis as any)[OWNERS_SYMBOL].clear();
    delete (globalThis as any)[CONTEXT_SYMBOL];
  });

  it('ignores global fallback when multiple trace owners are active', () => {
    const CONTEXT_SYMBOL = Symbol.for('openai.agents.core.lastContext');
    const OWNERS_SYMBOL = Symbol.for('openai.agents.core.globalFallbackOwners');
    const ownerA = Symbol('ownerA');
    const ownerB = Symbol('ownerB');

    const contextA = {
      trace: new Trace({ name: 'A' }),
      active: true,
      fallbackOwnerToken: ownerA,
    } as any;

    const owners = new Set<symbol>();
    owners.add(ownerA);
    owners.add(ownerB);
    (globalThis as any)[OWNERS_SYMBOL] = owners;
    (globalThis as any)[CONTEXT_SYMBOL] = contextA;

    expect(getCurrentTrace()).toBeNull();

    owners.clear();
    delete (globalThis as any)[CONTEXT_SYMBOL];
  });

  it('does not restore a foreign global context into ALS when there was no store', async () => {
    const CONTEXT_SYMBOL = Symbol.for('openai.agents.core.lastContext');
    const OWNERS_SYMBOL = Symbol.for('openai.agents.core.globalFallbackOwners');
    const foreignOwner = Symbol('foreign');
    const otherOwner = Symbol('other');

    const foreignContext = {
      trace: new Trace({ name: 'foreign' }),
      active: true,
      fallbackOwnerToken: foreignOwner,
    } as any;

    const owners = new Set<symbol>([foreignOwner, otherOwner]);
    (globalThis as any)[OWNERS_SYMBOL] = owners;
    (globalThis as any)[CONTEXT_SYMBOL] = foreignContext;

    await withTrace('local', async (trace) => {
      expect(getCurrentTrace()?.traceId).toBe(trace.traceId);
    });

    // Fallback is gated (owners > 1) so the ALS store must not have been
    // restored to the foreign context; otherwise the current trace would
    // resolve to the foreign one here.
    expect(getCurrentTrace()).toBeNull();

    owners.clear();
    delete (globalThis as any)[CONTEXT_SYMBOL];
  });

  it('consults global fallback when ALS store is inactive', () => {
    const ALS_SYMBOL = Symbol.for('openai.agents.core.asyncLocalStorage');
    const CONTEXT_SYMBOL = Symbol.for('openai.agents.core.lastContext');
    const OWNERS_SYMBOL = Symbol.for('openai.agents.core.globalFallbackOwners');
    const ownerToken = Symbol('owner');

    // Ensure the global ALS exists for this test.
    expect(getCurrentTrace()).toBeNull();

    const context = {
      trace: new Trace({ name: 'global-fallback' }),
      active: true,
      fallbackOwnerToken: ownerToken,
    } as any;

    const owners = new Set<symbol>([ownerToken]);
    (globalThis as any)[OWNERS_SYMBOL] = owners;
    (globalThis as any)[CONTEXT_SYMBOL] = context;

    const als = (globalThis as any)[ALS_SYMBOL] as any;
    expect(als).toBeDefined();

    als.run({ active: false }, () => {
      expect(getCurrentTrace()?.traceId).toBe(context.trace.traceId);
    });

    owners.clear();
    delete (globalThis as any)[CONTEXT_SYMBOL];
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

  it('withNewSpanContext restores the previous global fallback after exiting', async () => {
    const CONTEXT_SYMBOL = Symbol.for('openai.agents.core.lastContext');

    await withTrace('workflow', async () => {
      const outerContext = (globalThis as any)[CONTEXT_SYMBOL];
      expect(outerContext?.trace?.traceId).toBeDefined();

      await withNewSpanContext(async () => {
        const innerContext = (globalThis as any)[CONTEXT_SYMBOL];
        expect(innerContext).not.toBe(outerContext);
        expect(innerContext?.trace?.traceId).toBe(outerContext.trace?.traceId);
      });

      expect((globalThis as any)[CONTEXT_SYMBOL]).toBe(outerContext);
    });

    expect((globalThis as any)[CONTEXT_SYMBOL]).toBeUndefined();
  });

  it('withNewSpanContext keeps ALS context when global fallback is absent', async () => {
    const CONTEXT_SYMBOL = Symbol.for('openai.agents.core.lastContext');
    const OWNERS_SYMBOL = Symbol.for('openai.agents.core.globalFallbackOwners');

    await withTrace('workflow', async () => {
      // Simulate a locked-down global by clearing fallback visibility.
      delete (globalThis as any)[CONTEXT_SYMBOL];
      delete (globalThis as any)[OWNERS_SYMBOL];

      await withNewSpanContext(async () => {
        expect(getCurrentTrace()).not.toBeNull();
      });

      // After exiting, ALS should still have the outer trace.
      expect(getCurrentTrace()).not.toBeNull();
    });
  });

  it('withNewSpanContext does not drop owner token when another trace overwrote fallback', async () => {
    const CONTEXT_SYMBOL = Symbol.for('openai.agents.core.lastContext');
    const OWNERS_SYMBOL = Symbol.for('openai.agents.core.globalFallbackOwners');

    await withTrace('outer', async () => {
      const owners: Set<symbol> =
        (globalThis as any)[OWNERS_SYMBOL] ?? new Set<symbol>();
      const outerContext = (globalThis as any)[CONTEXT_SYMBOL];
      const outerOwner = outerContext?.fallbackOwnerToken;
      expect(outerOwner).toBeDefined();

      const foreignOwner = Symbol('foreign');
      owners.add(foreignOwner);
      (globalThis as any)[OWNERS_SYMBOL] = owners;
      // Simulate another trace overwriting the global fallback while the outer
      // trace is still active.
      const foreignTrace = new Trace({
        name: 'foreign',
        traceId: outerContext.trace?.traceId,
      });
      (globalThis as any)[CONTEXT_SYMBOL] = {
        trace: foreignTrace,
        active: true,
        fallbackOwnerToken: foreignOwner,
      };

      await withNewSpanContext(async () => {
        expect(getCurrentTrace()).not.toBeNull();
      });

      // Owner set should still include the outer owner token.
      expect(owners.has(outerOwner)).toBe(true);
      expect(owners.size).toBeGreaterThanOrEqual(2);

      owners.clear();
      delete (globalThis as any)[CONTEXT_SYMBOL];
    });
  });

  it('sets previousSpan when updating the current span and maintains reset stack', async () => {
    await withTrace('workflow', async () => {
      const spanA = createAgentSpan({ data: { name: 'A' } });
      setCurrentSpan(spanA);
      expect(getCurrentSpan()).toBe(spanA);

      const spanB = createAgentSpan({ data: { name: 'B' } });
      setCurrentSpan(spanB);
      expect(spanB.previousSpan).toBe(spanA);

      const spanC = createAgentSpan({ data: { name: 'C' } });
      setCurrentSpan(spanC);
      expect(spanC.previousSpan).toBe(spanB);

      resetCurrentSpan();
      expect(getCurrentSpan()).toBe(spanB);

      resetCurrentSpan();
      expect(getCurrentSpan()).toBe(spanA);

      resetCurrentSpan();
      expect(getCurrentSpan()).toBeNull();
    });
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
