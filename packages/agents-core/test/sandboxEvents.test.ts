import { afterEach, describe, expect, it } from 'vitest';
import {
  addSandboxEventSink,
  clearSandboxEventSinks,
  createChainedSandboxEventSink,
  createSandboxHttpEventSink,
  createSandboxJsonlEventSink,
  SandboxProviderError,
  type SandboxEvent,
  type SandboxHttpEventFetch,
  withSandboxSpan,
} from '../src/sandbox';
import {
  setTraceProcessors,
  setTracingContextStorage,
  setTracingDisabled,
  createCustomSpan,
  getCurrentSpan,
  getCurrentTrace,
  withTrace,
  type Span,
  type Trace,
  type TracingProcessor,
} from '../src/tracing';
import { getGlobalTraceProvider } from '../src/tracing/provider';
import { AsyncLocalStorage as BrowserAsyncLocalStorage } from '../src/shims/shims-browser';

class RecordingProcessor implements TracingProcessor {
  spansEnded: Span<any>[] = [];

  async onTraceStart(_trace: Trace): Promise<void> {}
  async onTraceEnd(_trace: Trace): Promise<void> {}
  async onSpanStart(_span: Span<any>): Promise<void> {}
  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spansEnded.push(span);
  }
  async shutdown(): Promise<void> {}
  async forceFlush(): Promise<void> {}
}

describe('sandbox events', () => {
  afterEach(() => {
    clearSandboxEventSinks();
    setTracingContextStorage();
    setTracingDisabled(true);
    setTraceProcessors([]);
  });

  it.each([
    { browser: false, parentType: 'trace' as const },
    { browser: false, parentType: 'span' as const },
    { browser: true, parentType: 'trace' as const },
    { browser: true, parentType: 'span' as const },
  ])(
    'restores tracing context for an explicit $parentType parent without ambient context (browser=$browser)',
    async ({ browser, parentType }) => {
      if (browser) {
        setTracingContextStorage(new BrowserAsyncLocalStorage());
      }
      const processor = new RecordingProcessor();
      setTraceProcessors([processor]);
      setTracingDisabled(false);
      const trace = getGlobalTraceProvider().createTrace({
        name: 'detached sandbox operation',
      });
      await trace.start();
      const parentSpan = createCustomSpan(
        { data: { name: 'sandbox parent', data: {} } },
        trace,
      );
      parentSpan.start();
      const parent = parentType === 'trace' ? trace : parentSpan;

      expect(getCurrentTrace()).toBeNull();
      expect(getCurrentSpan()).toBeNull();
      await expect(
        withSandboxSpan(
          'sandbox.detached',
          { parent_type: parentType },
          async (span) => {
            expect(getCurrentTrace()?.traceId).toBe(trace.traceId);
            expect(getCurrentSpan()).toBe(span);
            return 'ok';
          },
          parent,
        ),
      ).resolves.toBe('ok');
      expect(getCurrentTrace()).toBeNull();
      expect(getCurrentSpan()).toBeNull();

      const sandboxSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'custom' &&
          span.spanData.name === 'sandbox.detached',
      );
      expect(sandboxSpan?.traceId).toBe(trace.traceId);
      expect(sandboxSpan?.parentId).toBe(
        parentType === 'span' ? parentSpan.spanId : null,
      );

      parentSpan.end();
      await trace.end();
    },
  );

  it.each([false, true])(
    'preserves detached sandbox failures and restores context (browser=%s)',
    async (browser) => {
      if (browser) {
        setTracingContextStorage(new BrowserAsyncLocalStorage());
      }
      const processor = new RecordingProcessor();
      setTraceProcessors([processor]);
      setTracingDisabled(false);
      const trace = getGlobalTraceProvider().createTrace({
        name: 'detached sandbox failure',
      });
      await trace.start();
      const parentSpan = createCustomSpan(
        { data: { name: 'sandbox parent', data: {} } },
        trace,
      );
      parentSpan.start();
      const operationError = new SandboxProviderError('cleanup unavailable', {
        status: 503,
      });

      await expect(
        withSandboxSpan(
          'sandbox.detached_cleanup',
          {},
          async () => {
            throw operationError;
          },
          parentSpan,
        ),
      ).rejects.toBe(operationError);
      expect(getCurrentTrace()).toBeNull();
      expect(getCurrentSpan()).toBeNull();

      const sandboxSpan = processor.spansEnded.find(
        (span) =>
          span.spanData.type === 'custom' &&
          span.spanData.name === 'sandbox.detached_cleanup',
      );
      expect(sandboxSpan?.parentId).toBe(parentSpan.spanId);
      expect(sandboxSpan?.spanData.data).toMatchObject({
        error_retryable: true,
        error: {
          message: 'cleanup unavailable',
          retryable: true,
        },
      });

      parentSpan.end();
      await trace.end();
    },
  );

  it('emits operation start and end events without exposing operation output', async () => {
    const events: SandboxEvent[] = [];
    addSandboxEventSink((event) => {
      events.push(event);
    });
    addSandboxEventSink(() => {
      throw new Error('sink failed');
    });

    await expect(
      withSandboxSpan(
        'sandbox.exec',
        { cmd: 'echo ok', run_as: 'agent' },
        async () => 'command output',
      ),
    ).resolves.toBe('command output');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'sandbox_operation',
      name: 'sandbox.exec',
      phase: 'start',
      data: { cmd: 'echo ok', run_as: 'agent' },
    });
    expect(events[1]).toMatchObject({
      type: 'sandbox_operation',
      name: 'sandbox.exec',
      phase: 'end',
      data: { cmd: 'echo ok', run_as: 'agent' },
    });
    expect(events[1].durationMs).toEqual(expect.any(Number));
    expect(events[1]).not.toHaveProperty('result');
  });

  it('writes sandbox events as JSONL without exposing operation output', async () => {
    const lines: string[] = [];
    addSandboxEventSink(
      createSandboxJsonlEventSink((line) => {
        lines.push(line);
      }),
    );

    await withSandboxSpan('sandbox.exec', { cmd: 'echo ok' }, async () => {
      return 'command output';
    });

    expect(lines).toHaveLength(2);
    expect(lines.every((line) => line.endsWith('\n'))).toBe(true);
    expect(JSON.parse(lines[0])).toMatchObject({
      type: 'sandbox_operation',
      name: 'sandbox.exec',
      phase: 'start',
      data: { cmd: 'echo ok' },
    });
    const endEvent = JSON.parse(lines[1]);
    expect(endEvent).toMatchObject({
      type: 'sandbox_operation',
      name: 'sandbox.exec',
      phase: 'end',
      data: { cmd: 'echo ok' },
    });
    expect(endEvent).not.toHaveProperty('result');
  });

  it('posts sandbox events to an HTTP sink as JSON', async () => {
    const requests: Array<{ endpoint: string; body: SandboxEvent }> = [];
    const fetch: SandboxHttpEventFetch = async (endpoint, request) => {
      expect(request.method).toBe('POST');
      expect(request.headers).toMatchObject({
        'content-type': 'application/json',
        authorization: 'Bearer test',
      });
      requests.push({
        endpoint,
        body: JSON.parse(request.body),
      });
      return {
        ok: true,
        status: 204,
      };
    };

    addSandboxEventSink(
      createSandboxHttpEventSink({
        endpoint: 'https://example.test/sandbox-events',
        fetch,
        headers: { authorization: 'Bearer test' },
      }),
    );

    await withSandboxSpan(
      'sandbox.read_file',
      { path: 'README.md' },
      async () => 'contents',
    );

    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      endpoint: 'https://example.test/sandbox-events',
      body: {
        type: 'sandbox_operation',
        name: 'sandbox.read_file',
        phase: 'start',
      },
    });
    expect(requests[1].body).toMatchObject({
      type: 'sandbox_operation',
      name: 'sandbox.read_file',
      phase: 'end',
      data: { path: 'README.md' },
    });
  });

  it('isolates JSONL and HTTP sink failures from the operation', async () => {
    const events: SandboxEvent[] = [];
    addSandboxEventSink((event) => {
      events.push(event);
    });
    addSandboxEventSink(
      createSandboxJsonlEventSink(() => {
        throw new Error('outbox unavailable');
      }),
    );
    addSandboxEventSink(
      createSandboxHttpEventSink({
        endpoint: 'https://example.test/sandbox-events',
        fetch: async () => ({
          ok: false,
          status: 503,
          statusText: 'Service Unavailable',
          text: async () => 'retry later',
        }),
      }),
    );

    await expect(
      withSandboxSpan('sandbox.write_file', { path: 'out.txt' }, async () => {
        return 'ok';
      }),
    ).resolves.toBe('ok');

    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      name: 'sandbox.write_file',
      phase: 'start',
    });
    expect(events[1]).toMatchObject({
      name: 'sandbox.write_file',
      phase: 'end',
    });
  });

  it('delivers chained sinks even when one child sink fails', async () => {
    const calls: string[] = [];
    addSandboxEventSink(
      createChainedSandboxEventSink(
        () => {
          calls.push('first');
          throw new Error('first failed');
        },
        () => {
          calls.push('second');
        },
      ),
    );

    await withSandboxSpan('sandbox.cleanup', {}, async () => undefined);

    expect(calls).toEqual(['first', 'second', 'first', 'second']);
  });

  it('emits operation error events and preserves the original failure', async () => {
    const events: SandboxEvent[] = [];
    addSandboxEventSink((event) => {
      events.push(event);
    });

    await expect(
      withSandboxSpan('sandbox.start', { provider: 'fake' }, async () => {
        throw new SandboxProviderError('provider unavailable');
      }),
    ).rejects.toThrow('provider unavailable');

    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({
      type: 'sandbox_operation',
      name: 'sandbox.start',
      phase: 'error',
      data: { provider: 'fake' },
      error: {
        name: 'SandboxProviderError',
        message: 'provider unavailable',
        code: 'provider_error',
        retryable: null,
      },
    });
  });

  it('emits sandbox retryability in error events and traces', async () => {
    const events: SandboxEvent[] = [];
    const processor = new RecordingProcessor();
    addSandboxEventSink((event) => {
      events.push(event);
    });
    setTraceProcessors([processor]);
    setTracingDisabled(false);

    await expect(
      withTrace('sandbox retryability', async () => {
        await withSandboxSpan(
          'sandbox.read',
          { path: 'missing.txt' },
          async () => {
            throw new SandboxProviderError('missing path', {
              status: 404,
            });
          },
        );
      }),
    ).rejects.toThrow('missing path');

    expect(events[1]).toMatchObject({
      type: 'sandbox_operation',
      name: 'sandbox.read',
      phase: 'error',
      error: {
        code: 'provider_error',
        retryable: false,
      },
    });

    const sandboxSpan = processor.spansEnded.find(
      (span) =>
        span.spanData.type === 'custom' &&
        span.spanData.name === 'sandbox.read',
    );
    expect(sandboxSpan?.spanData.data).toMatchObject({
      path: 'missing.txt',
      error_retryable: false,
      error: {
        code: 'provider_error',
        retryable: false,
      },
    });
  });
});
