import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  timeIso,
  defaultTracingIdGenerator,
  generateTraceId,
  generateSpanId,
  generateGroupId,
  removePrivateFields,
  NOOP_TRACE_OR_SPAN_ID,
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
  ConsoleSpanExporter,
  MultiTracingProcessor,
  TracingExporter,
  TracingProcessor,
  defaultProcessor,
} from '../src/tracing/processor';

import coreLogger from '../src/logger';
import { allowConsole } from '../../../helpers/tests/console-guard';

import {
  withTrace,
  withTraceContext,
  getCurrentTraceContext,
  getCurrentTrace,
  getCurrentSpan,
  dispatchSpan,
  dispatchTrace,
  setTraceProcessors,
  setTracingDisabled,
  setTracingIdGenerator,
  setTracingContextStorage,
  setCurrentSpan,
  resetCurrentSpan,
} from '../src/tracing';
import type {
  TraceContextSnapshot,
  TracingContextStorage,
} from '../src/tracing';

import {
  withAgentSpan,
  createAgentSpan,
  withCustomSpan,
} from '../src/tracing/createSpans';

import { TraceProvider, getGlobalTraceProvider } from '../src/tracing/provider';

import { Runner } from '../src/run';
import { Agent } from '../src/agent';
import { StreamedRunResult } from '../src/result';
import { RunContext } from '../src/runContext';
import { RunState } from '../src/runState';
import { FakeModel, fakeModelMessage, FakeModelProvider } from './stubs';
import { Usage } from '../src/usage';
import * as protocol from '../src/types/protocol';
import { setDefaultModelProvider } from '../src/providers';
import { AsyncLocalStorage as BrowserAsyncLocalStorage } from '../src/shims/shims-browser';

const ALS_SYMBOL = Symbol.for('openai.agents.core.asyncLocalStorage');

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

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Promise<unknown>).finally === 'function'
  );
}

class StackTracingContextStorage implements TracingContextStorage {
  runCalls = 0;
  enterWithCalls = 0;
  #stack: any[] = [];

  run<TResult>(store: any, callback: () => TResult): TResult {
    this.runCalls += 1;
    this.#stack.push(store);

    const restore = () => {
      this.#stack.pop();
    };

    try {
      const result = callback();
      if (isPromiseLike(result)) {
        return result.finally(restore) as TResult;
      }
      restore();
      return result;
    } catch (error) {
      restore();
      throw error;
    }
  }

  getStore() {
    return this.#stack.at(-1);
  }

  enterWith(store: any) {
    this.enterWithCalls += 1;
    if (this.#stack.length > 0) {
      this.#stack[this.#stack.length - 1] = store;
    } else {
      this.#stack.push(store);
    }
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
    const span = new Span(
      {
        traceId: 'trace_123',
        data,
        traceMetadata: { source: 'trace' },
      },
      processor,
    );

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
    expect(clone.traceMetadata).toEqual(span.traceMetadata);

    // JSON output contains expected shape
    const json = span.toJSON() as any;
    expect(json.object).toBe('trace.span');
    expect(json.id).toBe(span.spanId);
    expect(json.trace_id).toBe(span.traceId);
    expect(json.span_data).toHaveProperty('type', 'custom');
  });

  it('records errors in wrapped spans and clears current span', async () => {
    let capturedSpan: Span<any> | undefined;
    let caught: unknown;

    await withTrace('failing-span', async () => {
      try {
        await withCustomSpan(
          async (span) => {
            capturedSpan = span;
            const error = new Error('boom') as Error & {
              data?: { reason: string };
            };
            error.data = { reason: 'oops' };
            throw error;
          },
          { data: { name: 'Custom' } },
        );
      } catch (error) {
        caught = error;
      }

      expect(getCurrentSpan()).toBeNull();
    });

    expect(caught).toBeInstanceOf(Error);
    expect(capturedSpan?.error).toEqual({
      message: 'boom',
      data: { reason: 'oops' },
    });
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

  it('propagates trace metadata from trace to spans', async () => {
    await withTrace(
      'workflow',
      async () => {
        const trace = getCurrentTrace();
        expect(trace?.metadata).toEqual({ source: 'run' });
        const span = createAgentSpan({ data: { name: 'span' } });
        expect(span.traceMetadata).toEqual({ source: 'run' });
      },
      { metadata: { source: 'run' } },
    );
  });

  it('supports processor metadata lookup by span.traceId', async () => {
    class MetadataPropagatingProcessor implements TracingProcessor {
      public traceMetadata = new Map<string, Record<string, any>>();
      public lookedUpMetadata: Record<string, any> | undefined;
      public spanTraceMetadata: Record<string, any> | undefined;

      async onTraceStart(trace: Trace): Promise<void> {
        if (trace.metadata) {
          this.traceMetadata.set(trace.traceId, { ...trace.metadata });
        }
      }

      async onTraceEnd(): Promise<void> {}

      async onSpanStart(): Promise<void> {}

      async onSpanEnd(span: Span<any>): Promise<void> {
        if (span.spanData.type !== 'agent') {
          return;
        }

        this.lookedUpMetadata = this.traceMetadata.get(span.traceId);
        this.spanTraceMetadata = span.traceMetadata;
      }

      async shutdown(): Promise<void> {}

      async forceFlush(): Promise<void> {}
    }

    const metadata = {
      userId: 'u_123',
      chatType: 'support',
    };
    const processor = new MetadataPropagatingProcessor();
    setTraceProcessors([processor]);

    await withTrace(
      'workflow',
      async () => {
        await withAgentSpan(async () => {}, { data: { name: 'agent' } });
      },
      { metadata },
    );

    expect(processor.lookedUpMetadata).toEqual(metadata);
    expect(processor.spanTraceMetadata).toEqual(metadata);
  });

  it('only serializes tracing api key when explicitly requested', () => {
    const trace = new Trace({
      name: 'test-trace',
      tracingApiKey: 'secret-key',
    });

    const defaultJson = trace.toJSON();
    expect(defaultJson).not.toHaveProperty('tracing_api_key');

    const withKey = trace.toJSON({ includeTracingApiKey: true }) as any;
    expect(withKey.tracing_api_key).toBe('secret-key');
  });

  it('returns the existing global trace provider when present', () => {
    const symbol = Symbol.for('openai.agents.core.traceProvider');
    const globalHolder = globalThis as unknown as Record<
      symbol | string,
      TraceProvider | undefined
    >;
    const original = globalHolder[symbol];
    const provider = new TraceProvider();

    globalHolder[symbol] = provider;

    expect(getGlobalTraceProvider()).toBe(provider);

    if (typeof original === 'undefined') {
      delete globalHolder[symbol];
    } else {
      globalHolder[symbol] = original;
    }
  });

  it('deduplicates provider shutdown calls', async () => {
    const provider = new TraceProvider();
    const processor = new TestProcessor();
    processor.shutdown = vi.fn(async () => {});
    provider.setProcessors([processor]);

    await Promise.all([provider.shutdown(), provider.shutdown()]);
    await provider.shutdown();

    expect(processor.shutdown).toHaveBeenCalledTimes(1);
  });

  it('registers beforeExit cleanup as a one-shot listener', () => {
    const onceSpy = vi.spyOn(process, 'once');
    const onSpy = vi.spyOn(process, 'on');
    new TraceProvider();

    const beforeExitListener = onceSpy.mock.calls.find(
      ([event]) => event === 'beforeExit',
    )?.[1];

    expect(beforeExitListener).toEqual(expect.any(Function));

    if (typeof beforeExitListener === 'function') {
      process.off('beforeExit', beforeExitListener);
    }
    for (const [event, listener] of onSpy.mock.calls) {
      if (
        (event === 'SIGINT' ||
          event === 'SIGTERM' ||
          event === 'unhandledRejection') &&
        typeof listener === 'function'
      ) {
        process.off(event, listener);
      }
    }

    onceSpy.mockRestore();
    onSpy.mockRestore();
  });

  it('does not force exit when beforeExit tracing cleanup times out', async () => {
    vi.useFakeTimers();
    allowConsole(['warn']);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit should not be called');
    }) as never);
    const onceSpy = vi.spyOn(process, 'once');
    const onSpy = vi.spyOn(process, 'on');

    try {
      const provider = new TraceProvider();
      const processor = new TestProcessor();
      processor.shutdown = vi.fn(
        () => new Promise<void>(() => {}),
      ) as TestProcessor['shutdown'];
      provider.setProcessors([processor]);

      const beforeExitListener = onceSpy.mock.calls.find(
        ([event]) => event === 'beforeExit',
      )?.[1];
      expect(beforeExitListener).toEqual(expect.any(Function));

      const cleanupPromise =
        typeof beforeExitListener === 'function'
          ? beforeExitListener(0 as never)
          : Promise.resolve();
      await vi.advanceTimersByTimeAsync(5000);
      await cleanupPromise;

      expect(warnSpy).toHaveBeenCalledWith(
        'Tracing cleanup timed out; continuing exit',
      );
      expect(processor.shutdown).toHaveBeenCalledWith(5000);
      expect(exitSpy).not.toHaveBeenCalled();

      if (typeof beforeExitListener === 'function') {
        process.off('beforeExit', beforeExitListener);
      }
      for (const [event, listener] of onSpy.mock.calls) {
        if (
          (event === 'SIGINT' ||
            event === 'SIGTERM' ||
            event === 'unhandledRejection') &&
          typeof listener === 'function'
        ) {
          process.off(event, listener);
        }
      }
    } finally {
      warnSpy.mockRestore();
      exitSpy.mockRestore();
      onceSpy.mockRestore();
      onSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('clears shutdown timeout when tracing buffer is empty', async () => {
    vi.useFakeTimers();

    try {
      const processor = new BatchTraceProcessor(new TestExporter());

      await processor.shutdown(5000);

      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it('falls back to module provider when global registration fails', () => {
    const symbol = Symbol.for('openai.agents.core.traceProvider');
    const globalHolder = globalThis as unknown as Record<
      symbol | string,
      TraceProvider | undefined
    >;
    const original = globalHolder[symbol];
    delete globalHolder[symbol];

    const originalDescriptor = Object.getOwnPropertyDescriptor;
    const originalDefine = Object.defineProperty;
    const descriptorSpy = vi
      .spyOn(Object, 'getOwnPropertyDescriptor')
      .mockImplementation((target, propertyKey) => {
        if (target === globalHolder && propertyKey === symbol) {
          return undefined;
        }
        return originalDescriptor(target, propertyKey);
      });
    const defineSpy = vi
      .spyOn(Object, 'defineProperty')
      .mockImplementation((target, propertyKey, attributes) => {
        if (target === globalHolder && propertyKey === symbol) {
          throw new Error('defineProperty blocked');
        }
        return originalDefine(target, propertyKey, attributes);
      });

    const provider = getGlobalTraceProvider();
    expect(provider).toBeInstanceOf(TraceProvider);
    expect(globalHolder[symbol]).toBeUndefined();
    expect(getGlobalTraceProvider()).toBe(provider);

    defineSpy.mockRestore();
    descriptorSpy.mockRestore();

    if (typeof original === 'undefined') {
      delete globalHolder[symbol];
    } else {
      globalHolder[symbol] = original;
    }
  });
});

describe('Span creation inherits tracing fields from parents', () => {
  const provider = new TraceProvider();
  beforeEach(() => {
    provider.setDisabled(false);
  });

  it('inherits from parent trace', () => {
    const trace = provider.createTrace({
      tracingApiKey: 'trace-key',
      metadata: { source: 'trace' },
    });
    const span = provider.createSpan(
      { data: { type: 'custom', name: 's', data: {} } },
      trace,
    );
    expect(span.tracingApiKey).toBe('trace-key');
    expect(span.traceMetadata).toEqual({ source: 'trace' });
  });

  it('inherits from parent span', () => {
    const trace = provider.createTrace({
      tracingApiKey: 'trace-key',
      metadata: { source: 'trace' },
    });
    const parent = provider.createSpan(
      { data: { type: 'custom', name: 'p', data: {} } },
      trace,
    );
    const child = provider.createSpan(
      { data: { type: 'custom', name: 'c', data: {} } },
      parent,
    );
    expect(child.tracingApiKey).toBe('trace-key');
    expect(child.traceMetadata).toEqual({ source: 'trace' });
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
// Tests for ConsoleSpanExporter.
// -----------------------------------------------------------------------------------------

describe('ConsoleSpanExporter', () => {
  it('skips export when tracing is disabled', async () => {
    allowConsole(['log']);
    const debugSpy = vi.spyOn(coreLogger, 'debug').mockImplementation(() => {});
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    setTracingDisabled(true);

    const exporter = new ConsoleSpanExporter();
    await exporter.export([new Trace({ name: 'disabled-trace' })]);

    expect(debugSpy).toHaveBeenCalledWith(
      'Tracing is disabled. Skipping export',
    );
    expect(logSpy).not.toHaveBeenCalled();

    logSpy.mockRestore();
    debugSpy.mockRestore();
    setTracingDisabled(false);
  });

  it('logs traces and spans when tracing is enabled', async () => {
    allowConsole(['log']);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const originalEnv = process.env.NODE_ENV;
    const originalDisableTracing = process.env.OPENAI_AGENTS_DISABLE_TRACING;
    process.env.NODE_ENV = 'production';
    delete process.env.OPENAI_AGENTS_DISABLE_TRACING;
    setTracingDisabled(false);

    const exporter = new ConsoleSpanExporter();
    const trace = new Trace({ name: 'trace', groupId: 'group_123' });
    trace.groupId = 'group_123';
    const span = new Span(
      {
        traceId: trace.traceId,
        data: { type: 'custom', name: 'span', data: {} },
      },
      new TestProcessor(),
    );

    await exporter.export([trace, span]);

    const messages = logSpy.mock.calls.map((call) => String(call[0]));
    expect(
      messages.some(
        (msg) =>
          msg.includes('Export trace') &&
          msg.includes(trace.traceId) &&
          msg.includes('groupId=group_123'),
      ),
    ).toBe(true);
    expect(messages.some((msg) => msg.includes('Export span'))).toBe(true);

    logSpy.mockRestore();
    process.env.NODE_ENV = originalEnv;
    if (typeof originalDisableTracing === 'undefined') {
      delete process.env.OPENAI_AGENTS_DISABLE_TRACING;
    } else {
      process.env.OPENAI_AGENTS_DISABLE_TRACING = originalDisableTracing;
    }
    setTracingDisabled(true);
  });
});

// -----------------------------------------------------------------------------------------
// Tests for BatchTraceProcessor (happy‑path).
// -----------------------------------------------------------------------------------------

describe('BatchTraceProcessor', () => {
  const exporter = new TestExporter();

  beforeEach(() => {
    exporter.exported.length = 0;
  });

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

    await processor.shutdown();
  });

  it('drops items when the buffer is full', async () => {
    const errorSpy = vi.spyOn(coreLogger, 'error').mockImplementation(() => {});
    const processor = new BatchTraceProcessor(exporter, {
      maxQueueSize: 2,
      maxBatchSize: 5,
      exportTriggerRatio: 1,
      scheduleDelay: 10000,
    });

    await processor.onTraceStart(new Trace({ name: 'one' }));
    await processor.onTraceStart(new Trace({ name: 'two' }));
    await processor.onTraceStart(new Trace({ name: 'three' }));

    expect(errorSpy).toHaveBeenCalledWith(
      'Dropping trace because buffer is full',
    );

    await processor.forceFlush();
    expect(exporter.exported[0]).toHaveLength(2);

    errorSpy.mockRestore();
    await processor.shutdown();
  });

  it('exports batches when the trigger threshold is reached', async () => {
    const processor = new BatchTraceProcessor(exporter, {
      maxQueueSize: 10,
      maxBatchSize: 2,
      exportTriggerRatio: 0.2,
      scheduleDelay: 10000,
    });

    const t1 = new Trace({ name: 'first' });
    const t2 = new Trace({ name: 'second' });
    const t3 = new Trace({ name: 'third' });

    await processor.onTraceStart(t1);
    await processor.onTraceStart(t2);
    await processor.onTraceStart(t3);

    expect(exporter.exported.length).toBe(1);
    expect(exporter.exported[0]).toEqual([t1, t2]);

    await processor.forceFlush();
    expect(exporter.exported.length).toBe(2);
    expect(exporter.exported[1]).toEqual([t3]);

    await processor.shutdown();
  });

  it('exports batches on the scheduled interval', async () => {
    vi.useFakeTimers();
    const processor = new BatchTraceProcessor(exporter, {
      maxQueueSize: 10,
      maxBatchSize: 5,
      scheduleDelay: 50,
    });

    await processor.onTraceStart(new Trace({ name: 'scheduled' }));
    expect(exporter.exported.length).toBe(0);

    await vi.advanceTimersByTimeAsync(60);
    expect(exporter.exported.length).toBe(1);

    await processor.shutdown();
    vi.useRealTimers();
  });

  it('continues scheduled exports after an exporter exception', async () => {
    vi.useFakeTimers();
    const errorSpy = vi.spyOn(coreLogger, 'error').mockImplementation(() => {});
    try {
      let exportCalls = 0;
      const exported: Array<(Trace | Span<any>)[]> = [];
      const flakyExporter: TracingExporter = {
        export: async (items) => {
          exportCalls += 1;
          if (exportCalls === 1) {
            throw new Error('simulated exporter failure');
          }
          exported.push([...items]);
        },
      };
      const processor = new BatchTraceProcessor(flakyExporter, {
        maxQueueSize: 10,
        maxBatchSize: 1,
        scheduleDelay: 50,
      });
      const failed = new Trace({ name: 'failed' });
      const recovered = new Trace({ name: 'recovered' });

      await processor.onTraceStart(failed);
      await vi.advanceTimersByTimeAsync(60);
      expect(exportCalls).toBe(1);
      expect(errorSpy).toHaveBeenCalledWith(
        'Tracing exporter failed to export batch',
        expect.any(Error),
      );

      await processor.onTraceStart(recovered);
      await vi.advanceTimersByTimeAsync(60);

      expect(exportCalls).toBe(2);
      expect(exported).toEqual([[recovered]]);

      await processor.shutdown();
    } finally {
      errorSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it('waits while an export is in progress during shutdown', async () => {
    vi.useFakeTimers();
    try {
      let resolveExport: (() => void) | null = null;
      let exportCalls = 0;
      const exporterWithDelay: TracingExporter = {
        export: async () => {
          exportCalls += 1;
          if (exportCalls === 1) {
            return new Promise<void>((resolve) => {
              resolveExport = resolve;
            });
          }
        },
      };
      const processor = new BatchTraceProcessor(exporterWithDelay, {
        maxQueueSize: 10,
        maxBatchSize: 1,
        exportTriggerRatio: 0.1,
        scheduleDelay: 10000,
      });

      await processor.onTraceStart(new Trace({ name: 'first' }));
      const pendingExport = processor.onTraceStart(
        new Trace({ name: 'second' }),
      );

      const shutdownPromise = processor.shutdown();
      setTimeout(() => resolveExport?.(), 10);
      await vi.advanceTimersByTimeAsync(10);
      await pendingExport;
      await vi.advanceTimersByTimeAsync(1000);
      await shutdownPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs when automatic export loops are unsupported', async () => {
    const debugSpy = vi.fn();
    vi.resetModules();
    vi.doMock('@openai/agents-core/_shims', async () => {
      const actual = await vi.importActual('@openai/agents-core/_shims');
      return {
        ...(actual as Record<string, unknown>),
        isTracingLoopRunningByDefault: () => false,
      };
    });
    vi.doMock('../src/logger', () => ({
      default: { debug: debugSpy },
    }));

    const { BatchTraceProcessor: MockedProcessor } =
      await import('../src/tracing/processor');
    const tempExporter = new TestExporter();
    new MockedProcessor(tempExporter, { scheduleDelay: 10000 });

    expect(debugSpy).toHaveBeenCalledWith(
      'Automatic trace export loop is not supported in this environment. You need to manually call `getGlobalTraceProvider().forceFlush()` to export traces.',
    );

    vi.resetModules();
    vi.unmock('@openai/agents-core/_shims');
    vi.unmock('../src/logger');
  });

  it('logs a timeout flush during shutdown when the timeout elapses', async () => {
    vi.useFakeTimers();
    const debugSpy = vi.spyOn(coreLogger, 'debug').mockImplementation(() => {});
    class DelayedExporter implements TracingExporter {
      public exported: Array<(Trace | Span<any>)[]> = [];

      async export(items: (Trace | Span<any>)[]): Promise<void> {
        this.exported.push([...items]);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }

    const delayedExporter = new DelayedExporter();
    const processor = new BatchTraceProcessor(delayedExporter, {
      maxQueueSize: 10,
      maxBatchSize: 5,
      scheduleDelay: 10000,
    });

    await processor.onTraceStart(new Trace({ name: 'slow-export' }));
    const shutdownPromise = processor.shutdown(1);

    await vi.advanceTimersByTimeAsync(10);
    await vi.advanceTimersByTimeAsync(50);
    await shutdownPromise;

    expect(debugSpy).toHaveBeenCalledWith('Timeout reached, force flushing');

    debugSpy.mockRestore();
    vi.useRealTimers();
  });

  it('passes an abort signal to exporter during timed shutdown', async () => {
    vi.useFakeTimers();
    let exportSignal: AbortSignal | undefined;
    let resolveExport: (() => void) | undefined;
    const exporter: TracingExporter = {
      export: async (_items, signal) => {
        exportSignal = signal;
        await new Promise<void>((resolve) => {
          resolveExport = resolve;
        });
      },
    };
    const processor = new BatchTraceProcessor(exporter, {
      maxQueueSize: 10,
      maxBatchSize: 5,
      scheduleDelay: 10000,
    });

    try {
      await processor.onTraceStart(new Trace({ name: 'abortable-export' }));
      const shutdownPromise = processor.shutdown(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(exportSignal).toBeDefined();
      expect(exportSignal?.aborted).toBe(true);

      resolveExport?.();
      await shutdownPromise;
    } finally {
      vi.useRealTimers();
    }
  });

  it('aborts active exports when timed shutdown elapses', async () => {
    vi.useFakeTimers();
    let exportSignal: AbortSignal | undefined;
    let exportCalls = 0;
    const exporter: TracingExporter = {
      export: async (_items, signal) => {
        exportCalls += 1;
        exportSignal = signal;
        await new Promise<void>((resolve) => {
          if (signal?.aborted) {
            resolve();
            return;
          }
          signal?.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    };
    const processor = new BatchTraceProcessor(exporter, {
      maxQueueSize: 10,
      maxBatchSize: 5,
      exportTriggerRatio: 0.1,
      scheduleDelay: 10000,
    });

    try {
      await processor.onTraceStart(new Trace({ name: 'queued' }));
      const activeExport = processor.onTraceStart(
        new Trace({ name: 'trigger-export' }),
      );

      expect(exportCalls).toBe(1);
      expect(exportSignal).toBeDefined();

      const shutdownPromise = processor.shutdown(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(exportSignal?.aborted).toBe(true);
      await activeExport;
      await shutdownPromise;
      expect(exportCalls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
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
    setTracingContextStorage();
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

  it('uses a supplied tracing context storage implementation', async () => {
    const storage = new StackTracingContextStorage();
    const observed: Array<string | null> = [];

    setTracingContextStorage(storage);

    await withTrace('outer', async () => {
      observed.push(getCurrentTrace()?.name ?? null);

      await withTrace('inner', async () => {
        observed.push(getCurrentTrace()?.name ?? null);
      });

      observed.push(getCurrentTrace()?.name ?? null);
    });

    expect(observed).toEqual(['outer', 'inner', 'outer']);
    expect(storage.runCalls).toBe(2);
    expect(storage.enterWithCalls).toBeGreaterThan(0);
    expect(getCurrentTrace()).toBeNull();
  });

  it('keeps browser shim context active until a streamed result settles', async () => {
    const storage = new BrowserAsyncLocalStorage<any>();
    let resolveStream!: () => void;
    const streamLoopPromise = new Promise<void>((resolve) => {
      resolveStream = resolve;
    });
    let activeTrace: Trace | null = null;

    setTracingContextStorage(storage);

    await withTrace('streaming-workflow', async (trace) => {
      activeTrace = trace;
      const agent = new Agent({ name: 'stream-agent' });
      const state: RunState<unknown, Agent<any, any>> = new RunState(
        new RunContext(),
        [],
        agent,
        1,
      );
      const result = new StreamedRunResult({ state });
      result._setStreamLoopPromise(streamLoopPromise);
      return result;
    });

    expect(getCurrentTrace()).toBe(activeTrace);

    resolveStream();
    await streamLoopPromise;
    await Promise.resolve();
    await Promise.resolve();

    expect(getCurrentTrace()).toBeNull();
  });

  it('getCurrentTraceContext returns null outside a trace', () => {
    expect(getCurrentTraceContext()).toBeNull();
  });

  it('getCurrentTraceContext returns the active trace snapshot', async () => {
    await withTrace('workflow', async (trace) => {
      const snapshot = getCurrentTraceContext();

      expect(snapshot).toEqual({ trace });
      expect(snapshot?.trace).toBe(getCurrentTrace());
    });
  });

  it('withTraceContext restores a captured trace around a callback', async () => {
    let snapshot: TraceContextSnapshot | null = null;

    await withTrace('workflow', async () => {
      snapshot = getCurrentTraceContext();
    });

    expect(snapshot).not.toBeNull();
    const result = withTraceContext(snapshot, () => {
      expect(getCurrentTrace()).toBe(snapshot?.trace);
      return 'done';
    });

    expect(result).toBe('done');
    expect(getCurrentTrace()).toBeNull();
  });

  it('withTraceContext restores a provided span around a callback', () => {
    const trace = new Trace({ name: 'manual-trace' });
    const span = new Span(
      {
        traceId: trace.traceId,
        data: { type: 'custom', name: 'manual-span', data: {} },
      },
      processor,
    );

    withTraceContext({ trace, span }, () => {
      expect(getCurrentTrace()).toBe(trace);
      expect(getCurrentSpan()).toBe(span);
    });

    expect(getCurrentTrace()).toBeNull();
    expect(getCurrentSpan()).toBeNull();
  });

  it('withTraceContext clears and restores ambient trace context', async () => {
    await withTrace('workflow', async (trace) => {
      const result = withTraceContext(null, () => {
        expect(getCurrentTrace()).toBeNull();
        expect(getCurrentTraceContext()).toBeNull();
        return 'isolated';
      });

      expect(result).toBe('isolated');
      expect(getCurrentTrace()).toBe(trace);
    });
  });

  it('withTraceContext restores ambient trace context with browser storage', async () => {
    const globalScope = globalThis as unknown as Record<
      symbol,
      unknown | undefined
    >;
    const previousStorage = globalScope[ALS_SYMBOL];

    globalScope[ALS_SYMBOL] = new BrowserAsyncLocalStorage();

    try {
      await withTrace('workflow', async (trace) => {
        const overlayTrace = new Trace({ name: 'overlay-trace' });

        const isolated = withTraceContext(null, () => {
          expect(getCurrentTrace()).toBeNull();
          expect(getCurrentTraceContext()).toBeNull();
          return 'isolated';
        });

        expect(isolated).toBe('isolated');
        expect(getCurrentTrace()).toBe(trace);

        await withTraceContext({ trace: overlayTrace }, async () => {
          expect(getCurrentTrace()).toBe(overlayTrace);
          await Promise.resolve();
          expect(getCurrentTrace()).toBe(overlayTrace);
        });

        expect(getCurrentTrace()).toBe(trace);
      });
    } finally {
      if (previousStorage === undefined) {
        delete globalScope[ALS_SYMBOL];
      } else {
        globalScope[ALS_SYMBOL] = previousStorage;
      }
    }
  });

  it('withTraceContext keeps browser context until streamed results finish', async () => {
    const globalScope = globalThis as unknown as Record<
      symbol,
      unknown | undefined
    >;
    const previousStorage = globalScope[ALS_SYMBOL];
    const trace = new Trace({ name: 'manual-streaming-trace' });

    globalScope[ALS_SYMBOL] = new BrowserAsyncLocalStorage();

    try {
      let finishStreamLoop!: () => void;
      let traceDuringStreamLoop: Trace | null | undefined;
      const streamLoopGate = new Promise<void>((resolve) => {
        finishStreamLoop = resolve;
      });
      const streamLoopPromise = streamLoopGate.then(() => {
        traceDuringStreamLoop = getCurrentTrace();
      });

      const resultPromise = withTraceContext({ trace }, async () => {
        const result = new StreamedRunResult<any, any>();
        result._setStreamLoopPromise(streamLoopPromise);
        return result;
      });

      const result = await resultPromise;

      expect(result).toBeInstanceOf(StreamedRunResult);
      expect(getCurrentTrace()).toBe(trace);

      finishStreamLoop();
      await streamLoopPromise;
      await Promise.resolve();

      expect(traceDuringStreamLoop).toBe(trace);
      expect(getCurrentTrace()).toBeNull();
    } finally {
      if (previousStorage === undefined) {
        delete globalScope[ALS_SYMBOL];
      } else {
        globalScope[ALS_SYMBOL] = previousStorage;
      }
    }
  });

  it('withTraceContext keeps context across awaits', async () => {
    const trace = new Trace({ name: 'manual-async-trace' });

    await withTraceContext({ trace }, async () => {
      expect(getCurrentTrace()).toBe(trace);
      await Promise.resolve();
      expect(getCurrentTrace()).toBe(trace);
      expect(getCurrentTraceContext()?.trace).toBe(trace);
    });
    expect(getCurrentTrace()).toBeNull();
  });

  it('does not allow setting spans after a trace ends', async () => {
    let error: unknown;

    await withTrace('workflow', async () => {
      setTimeout(() => {
        try {
          const span = new Span(
            {
              traceId: 'trace_123',
              data: { type: 'custom', name: 'late-span', data: {} },
            },
            processor,
          );
          setCurrentSpan(span);
        } catch (caught) {
          error = caught;
        }
      }, 0);
    });

    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('No existing trace found');
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

  it('withTraceContext preserves the captured span stack', async () => {
    await withTrace('workflow', async () => {
      const spanA = createAgentSpan({ data: { name: 'A' } });
      setCurrentSpan(spanA);
      const spanB = createAgentSpan({ data: { name: 'B' } });
      setCurrentSpan(spanB);
      const snapshot = getCurrentTraceContext();

      expect(snapshot?.span).toBe(spanB);
      expect(spanB.previousSpan).toBe(spanA);

      withTraceContext(snapshot, () => {
        const spanC = createAgentSpan({ data: { name: 'C' } });
        setCurrentSpan(spanC);

        expect(spanC.previousSpan).toBe(spanB);
        resetCurrentSpan();
        expect(getCurrentSpan()).toBe(spanB);
        resetCurrentSpan();
        expect(getCurrentSpan()).toBe(spanA);
      });

      expect(spanB.previousSpan).toBe(spanA);
      expect(getCurrentSpan()).toBe(spanB);
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

  it('starts and flushes all processors', async () => {
    const processor1 = new TestProcessor() as TestProcessor & {
      start?: () => void;
    };
    const processor2 = new TestProcessor() as TestProcessor & {
      start?: () => void;
    };
    const start1 = vi.fn();
    const start2 = vi.fn();
    const flush1 = vi.fn().mockResolvedValue(undefined);
    const flush2 = vi.fn().mockResolvedValue(undefined);
    processor1.start = start1;
    processor2.start = start2;
    processor1.forceFlush = flush1;
    processor2.forceFlush = flush2;

    const multiProcessor = new MultiTracingProcessor();
    multiProcessor.addTraceProcessor(processor1);
    multiProcessor.addTraceProcessor(processor2);

    multiProcessor.start();
    expect(start1).toHaveBeenCalledTimes(1);
    expect(start2).toHaveBeenCalledTimes(1);

    await multiProcessor.forceFlush();
    expect(flush1).toHaveBeenCalledTimes(1);
    expect(flush2).toHaveBeenCalledTimes(1);
  });

  it('dispatches completed traces to all processors without using trace lifecycle methods', async () => {
    const processor1 = new TestProcessor();
    const processor2 = new TestProcessor();
    const multiProcessor = new MultiTracingProcessor();
    multiProcessor.addTraceProcessor(processor1);
    multiProcessor.addTraceProcessor(processor2);

    const traceProcessor = new TestProcessor();
    const trace = new Trace(
      { name: 'completed-trace', traceId: 'trace_completed', started: true },
      traceProcessor,
    );

    await trace.start();
    expect(traceProcessor.tracesStarted).toHaveLength(0);

    await multiProcessor.dispatchTrace(trace);

    expect(processor1.tracesStarted).toEqual([trace]);
    expect(processor1.tracesEnded).toEqual([trace]);
    expect(processor2.tracesStarted).toEqual([trace]);
    expect(processor2.tracesEnded).toEqual([trace]);
  });

  it('dispatches completed spans to all processors without mutating timestamps', async () => {
    const processor1 = new TestProcessor();
    const processor2 = new TestProcessor();
    const multiProcessor = new MultiTracingProcessor();
    multiProcessor.addTraceProcessor(processor1);
    multiProcessor.addTraceProcessor(processor2);

    const startedAt = '2026-05-22T00:00:00.000Z';
    const endedAt = '2026-05-22T00:00:01.000Z';
    const span = new Span(
      {
        traceId: 'trace_completed',
        spanId: 'span_completed',
        data: { type: 'custom', name: 'completed-span', data: {} },
        startedAt,
        endedAt,
      },
      new TestProcessor(),
    );

    await multiProcessor.dispatchSpan(span);

    expect(processor1.spansStarted).toEqual([span]);
    expect(processor1.spansEnded).toEqual([span]);
    expect(processor2.spansStarted).toEqual([span]);
    expect(processor2.spansEnded).toEqual([span]);
    expect(span.startedAt).toBe(startedAt);
    expect(span.endedAt).toBe(endedAt);
  });

  it('does not dispatch no-op traces or spans', async () => {
    const processor = new TestProcessor();
    const multiProcessor = new MultiTracingProcessor();
    multiProcessor.addTraceProcessor(processor);

    const noopTrace = new NoopTrace();
    const traceWithNoopId = new Trace({
      name: 'no-op-id',
      traceId: NOOP_TRACE_OR_SPAN_ID,
    });
    const noopSpan = new NoopSpan(
      { type: 'custom', name: 'noop-span', data: {} },
      new TestProcessor(),
    );
    const spanWithNoopTraceId = new Span(
      {
        traceId: NOOP_TRACE_OR_SPAN_ID,
        spanId: 'span_completed',
        data: { type: 'custom', name: 'noop-trace-id', data: {} },
        startedAt: '2026-05-22T00:00:00.000Z',
        endedAt: '2026-05-22T00:00:01.000Z',
      },
      new TestProcessor(),
    );
    const spanWithNoopSpanId = new Span(
      {
        traceId: 'trace_completed',
        spanId: NOOP_TRACE_OR_SPAN_ID,
        data: { type: 'custom', name: 'noop-span-id', data: {} },
        startedAt: '2026-05-22T00:00:00.000Z',
        endedAt: '2026-05-22T00:00:01.000Z',
      },
      new TestProcessor(),
    );

    await multiProcessor.dispatchTrace(noopTrace);
    await multiProcessor.dispatchTrace(traceWithNoopId);
    await multiProcessor.dispatchSpan(noopSpan);
    await multiProcessor.dispatchSpan(spanWithNoopTraceId);
    await multiProcessor.dispatchSpan(spanWithNoopSpanId);

    expect(processor.tracesStarted).toHaveLength(0);
    expect(processor.tracesEnded).toHaveLength(0);
    expect(processor.spansStarted).toHaveLength(0);
    expect(processor.spansEnded).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------------------
// Tests for completed trace dispatch helpers.
// -----------------------------------------------------------------------------------------

describe('completed trace dispatch helpers', () => {
  afterEach(() => {
    setTraceProcessors([defaultProcessor()]);
    setTracingDisabled(true);
  });

  it('dispatches completed traces and spans through TraceProvider', async () => {
    const processor = new TestProcessor();
    const provider = new TraceProvider();
    provider.setDisabled(false);
    provider.registerProcessor(processor);

    const trace = new Trace({ name: 'completed-trace' });
    const span = new Span(
      {
        traceId: trace.traceId,
        spanId: 'span_completed',
        data: { type: 'custom', name: 'completed-span', data: {} },
        startedAt: '2026-05-22T00:00:00.000Z',
        endedAt: '2026-05-22T00:00:01.000Z',
      },
      new TestProcessor(),
    );

    await provider.dispatchTrace(trace);
    await provider.dispatchSpan(span);

    expect(processor.tracesStarted).toEqual([trace]);
    expect(processor.tracesEnded).toEqual([trace]);
    expect(processor.spansStarted).toEqual([span]);
    expect(processor.spansEnded).toEqual([span]);
  });

  it('does not dispatch completed traces and spans when TraceProvider tracing is disabled', async () => {
    const processor = new TestProcessor();
    const provider = new TraceProvider();
    provider.setDisabled(true);
    provider.registerProcessor(processor);

    const trace = new Trace({ name: 'completed-trace' });
    const span = new Span(
      {
        traceId: trace.traceId,
        spanId: 'span_completed',
        data: { type: 'custom', name: 'completed-span', data: {} },
        startedAt: '2026-05-22T00:00:00.000Z',
        endedAt: '2026-05-22T00:00:01.000Z',
      },
      new TestProcessor(),
    );

    await provider.dispatchTrace(trace);
    await provider.dispatchSpan(span);

    expect(processor.tracesStarted).toHaveLength(0);
    expect(processor.tracesEnded).toHaveLength(0);
    expect(processor.spansStarted).toHaveLength(0);
    expect(processor.spansEnded).toHaveLength(0);
  });

  it('dispatches completed traces and spans through global helpers', async () => {
    const processor = new TestProcessor();
    setTracingDisabled(false);
    setTraceProcessors([processor]);

    const trace = new Trace({ name: 'completed-trace' });
    const span = new Span(
      {
        traceId: trace.traceId,
        spanId: 'span_completed',
        data: { type: 'custom', name: 'completed-span', data: {} },
        startedAt: '2026-05-22T00:00:00.000Z',
        endedAt: '2026-05-22T00:00:01.000Z',
      },
      new TestProcessor(),
    );

    await dispatchTrace(trace);
    await dispatchSpan(span);

    expect(processor.tracesStarted).toEqual([trace]);
    expect(processor.tracesEnded).toEqual([trace]);
    expect(processor.spansStarted).toEqual([span]);
    expect(processor.spansEnded).toEqual([span]);
  });

  it('does not dispatch completed traces and spans through global helpers when tracing is disabled', async () => {
    const processor = new TestProcessor();
    setTraceProcessors([processor]);
    setTracingDisabled(true);

    const trace = new Trace({ name: 'completed-trace' });
    const span = new Span(
      {
        traceId: trace.traceId,
        spanId: 'span_completed',
        data: { type: 'custom', name: 'completed-span', data: {} },
        startedAt: '2026-05-22T00:00:00.000Z',
        endedAt: '2026-05-22T00:00:01.000Z',
      },
      new TestProcessor(),
    );

    await dispatchTrace(trace);
    await dispatchSpan(span);

    expect(processor.tracesStarted).toHaveLength(0);
    expect(processor.tracesEnded).toHaveLength(0);
    expect(processor.spansStarted).toHaveLength(0);
    expect(processor.spansEnded).toHaveLength(0);
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
    expect(trace.traceId).toBe('no-op');

    const span = provider.createSpan(
      {
        data: { type: 'custom', name: 'noop', data: {} },
      },
      trace,
    );
    expect(span).toBeInstanceOf(NoopSpan);
  });
});

describe('TraceProvider ID generator behavior', () => {
  it('keeps the default ID generator immutable', () => {
    expect(Object.isFrozen(defaultTracingIdGenerator)).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(
        defaultTracingIdGenerator,
        'generateTraceId',
      )?.writable,
    ).toBe(false);
    expect(
      Object.getOwnPropertyDescriptor(
        defaultTracingIdGenerator,
        'generateSpanId',
      )?.writable,
    ).toBe(false);
  });

  it('uses a custom constructor ID generator for traces and spans', () => {
    const provider = new TraceProvider({
      idGenerator: {
        generateTraceId: () => 'trace_custom_1',
        generateSpanId: () => 'span_custom_1',
      },
    });
    provider.setDisabled(false);

    const trace = provider.createTrace({ name: 'deterministic' });
    const span = provider.createSpan(
      { data: { type: 'custom', name: 'deterministic', data: {} } },
      trace,
    );

    expect(trace.traceId).toBe('trace_custom_1');
    expect(span.spanId).toBe('span_custom_1');
    expect(span.traceId).toBe('trace_custom_1');
  });

  it('prefers explicit trace and span IDs over the configured generator', () => {
    const generateTraceId = vi.fn(() => 'trace_generated');
    const generateSpanId = vi.fn(() => 'span_generated');
    const provider = new TraceProvider({
      idGenerator: {
        generateTraceId,
        generateSpanId,
      },
    });
    provider.setDisabled(false);

    const trace = provider.createTrace({
      name: 'explicit',
      traceId: 'trace_explicit',
    });
    const span = provider.createSpan(
      {
        spanId: 'span_explicit',
        data: { type: 'custom', name: 'explicit', data: {} },
      },
      trace,
    );

    expect(trace.traceId).toBe('trace_explicit');
    expect(span.spanId).toBe('span_explicit');
    expect(generateTraceId).not.toHaveBeenCalled();
    expect(generateSpanId).not.toHaveBeenCalled();
  });

  it('configures and resets the global provider ID generator', () => {
    const provider = getGlobalTraceProvider();
    provider.setDisabled(false);

    try {
      setTracingIdGenerator({
        generateTraceId: () => 'trace_configured_global',
        generateSpanId: () => 'span_configured_global',
      });

      const trace = provider.createTrace({ name: 'global' });
      const span = provider.createSpan(
        { data: { type: 'custom', name: 'global', data: {} } },
        trace,
      );

      expect(trace.traceId).toBe('trace_configured_global');
      expect(span.spanId).toBe('span_configured_global');
    } finally {
      setTracingIdGenerator();
      provider.setDisabled(true);
    }
  });

  it('prefers provider ID generation methods over the global ID generator', () => {
    class DeterministicTraceProvider extends TraceProvider {
      override generateTraceId(): string {
        return 'trace_provider_custom';
      }

      override generateSpanId(): string {
        return 'span_provider_custom';
      }
    }

    const symbol = Symbol.for('openai.agents.core.traceProvider');
    const globalHolder = globalThis as unknown as Record<
      symbol | string,
      TraceProvider | undefined
    >;
    const original = globalHolder[symbol];
    const provider = new DeterministicTraceProvider();
    const generateTraceId = vi.fn(() => 'trace_global_generator');
    const generateSpanId = vi.fn(() => 'span_global_generator');

    provider.setDisabled(false);
    globalHolder[symbol] = provider;

    try {
      setTracingIdGenerator({ generateTraceId, generateSpanId });

      const trace = getGlobalTraceProvider().createTrace({
        name: 'provider-priority',
      });
      const span = getGlobalTraceProvider().createSpan(
        { data: { type: 'custom', name: 'provider-priority', data: {} } },
        trace,
      );

      expect(trace.traceId).toBe('trace_provider_custom');
      expect(span.spanId).toBe('span_provider_custom');
      expect(generateTraceId).not.toHaveBeenCalled();
      expect(generateSpanId).not.toHaveBeenCalled();
    } finally {
      setTracingIdGenerator();
      provider.setDisabled(true);
      if (typeof original === 'undefined') {
        delete globalHolder[symbol];
      } else {
        globalHolder[symbol] = original;
      }
    }
  });
});

describe('TraceProvider span creation without parents', () => {
  it('returns NoopSpan when no active trace is available', () => {
    const loggerError = vi
      .spyOn(coreLogger, 'error')
      .mockImplementation(() => {});
    const loggerDebug = vi
      .spyOn(coreLogger, 'debug')
      .mockImplementation(() => {});
    const provider = new TraceProvider();
    provider.setDisabled(false);

    const span = provider.createSpan({
      data: { type: 'custom', name: 'no-trace', data: {} },
    });
    expect(span).toBeInstanceOf(NoopSpan);
    expect(loggerDebug).toHaveBeenCalledWith(
      'No active trace. Make sure to start a trace with `withTrace()` first. Returning NoopSpan.',
    );
    expect(loggerError).not.toHaveBeenCalled();
    loggerDebug.mockRestore();
    loggerError.mockRestore();
  });

  it('creates spans using the active trace when no parent is provided', async () => {
    const provider = getGlobalTraceProvider();
    provider.setDisabled(false);

    await withTrace('active-trace', async () => {
      const trace = getCurrentTrace();
      expect(trace).not.toBeNull();
      const span = provider.createSpan({
        data: { type: 'custom', name: 'active', data: {} },
      });
      expect(span).toBeInstanceOf(Span);
      expect(span.traceId).toBe(trace?.traceId);
    });

    provider.setDisabled(true);
  });

  it('returns NoopSpan when parent trace/span is noop', () => {
    const provider = new TraceProvider();
    provider.setDisabled(false);

    const fromTrace = provider.createSpan(
      { data: { type: 'custom', name: 'noop-trace', data: {} } },
      new NoopTrace(),
    );
    expect(fromTrace).toBeInstanceOf(NoopSpan);

    const traceWithNoopId = new Trace({
      name: 'noop-trace-id',
      traceId: 'no-op',
    });
    const fromTraceId = provider.createSpan(
      { data: { type: 'custom', name: 'noop-trace-id', data: {} } },
      traceWithNoopId,
    );
    expect(fromTraceId).toBeInstanceOf(NoopSpan);

    const noopSpan = new NoopSpan(
      { type: 'custom', name: 'noop-span', data: {} },
      new TestProcessor(),
    );
    const fromSpan = provider.createSpan(
      { data: { type: 'custom', name: 'noop-parent', data: {} } },
      noopSpan,
    );
    expect(fromSpan).toBeInstanceOf(NoopSpan);
  });

  it('returns NoopSpan when the span id is the no-op sentinel', async () => {
    const provider = getGlobalTraceProvider();
    provider.setDisabled(false);

    await withTrace('active-trace', async () => {
      const span = provider.createSpan({
        data: { type: 'custom', name: 'noop-id', data: {} },
        spanId: 'no-op',
      });
      expect(span).toBeInstanceOf(NoopSpan);
    });

    provider.setDisabled(true);
  });

  it('returns NoopSpan when the parent span id is the no-op sentinel', async () => {
    const provider = getGlobalTraceProvider();
    provider.setDisabled(false);

    await withTrace('active-trace', async () => {
      const currentTrace = getCurrentTrace();
      expect(currentTrace).not.toBeNull();

      const parentSpan = new Span(
        {
          traceId: currentTrace!.traceId,
          spanId: 'no-op',
          data: { type: 'custom', name: 'noop-parent-id', data: {} },
        },
        new TestProcessor(),
      );
      setCurrentSpan(parentSpan);

      try {
        const span = provider.createSpan({
          data: { type: 'custom', name: 'child', data: {} },
        });
        expect(span).toBeInstanceOf(NoopSpan);
      } finally {
        resetCurrentSpan();
      }
    });

    provider.setDisabled(true);
  });

  it('returns NoopSpan when span options are disabled', () => {
    const provider = new TraceProvider();
    provider.setDisabled(false);

    const span = provider.createSpan({
      data: { type: 'custom', name: 'disabled-span', data: {} },
      disabled: true,
    });
    expect(span).toBeInstanceOf(NoopSpan);
  });

  it('returns NoopSpan when the current trace is a NoopTrace', async () => {
    const provider = getGlobalTraceProvider();
    setTracingDisabled(true);

    await withTrace('noop-trace', async () => {
      const span = provider.createSpan({
        data: { type: 'custom', name: 'noop-trace-span', data: {} },
      });
      expect(span).toBeInstanceOf(NoopSpan);
    });

    setTracingDisabled(false);
  });

  it('returns NoopSpan when the current span is a NoopSpan', async () => {
    const provider = getGlobalTraceProvider();
    provider.setDisabled(false);

    await withTrace('active-trace', async () => {
      const noopSpan = new NoopSpan(
        { type: 'custom', name: 'noop-current', data: {} },
        new TestProcessor(),
      );
      setCurrentSpan(noopSpan);
      try {
        const span = provider.createSpan({
          data: { type: 'custom', name: 'child', data: {} },
        });
        expect(span).toBeInstanceOf(NoopSpan);
      } finally {
        resetCurrentSpan();
      }
    });

    provider.setDisabled(true);
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
