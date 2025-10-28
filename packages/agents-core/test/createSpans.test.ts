import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  createAgentSpan,
  createFunctionSpan,
  createGuardrailSpan,
  createSpeechSpan,
  createMCPListToolsSpan,
  withAgentSpan,
  withFunctionSpan,
} from '../src/tracing/createSpans';
import {
  getCurrentSpan,
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
} from '../src/tracing';
import type { TraceProvider } from '../src/tracing/provider';
import type { Span } from '../src/tracing/spans';
import * as providerModule from '../src/tracing/provider';
import { defaultProcessor, TracingProcessor } from '../src/tracing/processor';
import type { Trace } from '../src/tracing/traces';

class RecordingProcessor implements TracingProcessor {
  tracesStarted: Trace[] = [];
  tracesEnded: Trace[] = [];
  spansStarted: Span<any>[] = [];
  spansEnded: Span<any>[] = [];

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
  reset() {
    this.tracesStarted.length = 0;
    this.tracesEnded.length = 0;
    this.spansStarted.length = 0;
    this.spansEnded.length = 0;
  }
}

describe('create*Span helpers', () => {
  const createSpanMock = vi.fn();
  let providerSpy: ReturnType<typeof vi.spyOn> | undefined;
  const fakeSpan = { spanId: 'span', traceId: 'trace' } as Span<any>;

  beforeEach(() => {
    createSpanMock.mockReturnValue(fakeSpan);
    providerSpy = vi.spyOn(providerModule, 'getGlobalTraceProvider');
    providerSpy.mockReturnValue({
      createSpan: createSpanMock,
    } as unknown as TraceProvider);
  });

  afterEach(() => {
    createSpanMock.mockReset();
    providerSpy?.mockRestore();
  });

  it('createAgentSpan falls back to the default name when not provided', () => {
    createAgentSpan();

    expect(createSpanMock).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ type: 'agent', name: 'Agent' }),
      }),
      undefined,
    );
  });

  it('createFunctionSpan populates default input/output values', () => {
    createFunctionSpan({ data: { name: 'call' } });

    const calls = createSpanMock.mock.calls;
    const [options] = calls[calls.length - 1];
    expect(options.data).toMatchObject({
      type: 'function',
      name: 'call',
      input: '',
      output: '',
    });
  });

  it('createGuardrailSpan enforces a non-triggered default state', () => {
    createGuardrailSpan({ data: { name: 'moderation' } });

    const calls = createSpanMock.mock.calls;
    const [options] = calls[calls.length - 1];
    expect(options.data).toMatchObject({
      type: 'guardrail',
      name: 'moderation',
      triggered: false,
    });
  });

  it('createSpeechSpan forwards the provided payload with the expected type', () => {
    createSpeechSpan({
      data: { output: { data: 'pcm-data', format: 'pcm' } },
    });

    const calls = createSpanMock.mock.calls;
    const [options] = calls[calls.length - 1];
    expect(options.data).toMatchObject({
      type: 'speech',
      output: { data: 'pcm-data', format: 'pcm' },
    });
  });

  it('createMCPListToolsSpan stamps the span type', () => {
    createMCPListToolsSpan();

    const calls = createSpanMock.mock.calls;
    const [options] = calls[calls.length - 1];
    expect(options.data).toMatchObject({ type: 'mcp_tools' });
  });
});

describe('with*Span helpers', () => {
  const processor = new RecordingProcessor();

  beforeEach(() => {
    processor.reset();
    setTraceProcessors([processor]);
    setTracingDisabled(false);
  });

  afterEach(() => {
    setTraceProcessors([defaultProcessor()]);
    setTracingDisabled(true);
  });

  it('records errors and restores the previous span when the callback throws', async () => {
    const failingError = Object.assign(new Error('boom'), {
      data: { reason: 'bad input' },
    });

    await withTrace('workflow', async () => {
      await withAgentSpan(async (outerSpan) => {
        await expect(
          withFunctionSpan(
            async () => {
              expect(getCurrentSpan()).toBeDefined();
              throw failingError;
            },
            { data: { name: 'inner' } },
          ),
        ).rejects.toThrow('boom');

        expect(getCurrentSpan()).toBe(outerSpan);
      });

      expect(getCurrentSpan()).toBeNull();
    });

    const functionSpan = processor.spansEnded.find(
      (span) => span.spanData.type === 'function',
    );
    expect(functionSpan?.error).toMatchObject({
      message: 'boom',
      data: { reason: 'bad input' },
    });
  });
});
