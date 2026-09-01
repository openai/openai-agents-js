import { describe, expect, it } from 'vitest';

import { NoopSpan, Span, type CustomSpanData } from '../src/tracing/spans';
import { NoopTrace, Trace } from '../src/tracing/traces';
import type { TracingProcessor } from '../src/tracing/processor';

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

  async shutdown(): Promise<void> {}

  async forceFlush(): Promise<void> {}
}

describe('tracing clone fidelity', () => {
  it('preserves a custom processor when cloning a trace', async () => {
    const processor = new RecordingProcessor();
    const clone = new Trace({ name: 'custom-processor' }, processor).clone();

    await clone.start();
    await clone.end();

    expect(processor.tracesStarted).toEqual([clone]);
    expect(processor.tracesEnded).toEqual([clone]);
  });

  it('keeps cloned no-op traces disabled', () => {
    const clone = new NoopTrace().clone();

    expect(clone).toBeInstanceOf(NoopTrace);
    expect(clone.toJSON()).toBeNull();
  });

  it('keeps cloned no-op spans disabled', () => {
    const processor = new RecordingProcessor();
    const data: CustomSpanData = {
      type: 'custom',
      name: 'disabled',
      data: {},
    };
    const clone = new NoopSpan(data, processor).clone();

    expect(clone).toBeInstanceOf(NoopSpan);
    expect(clone.toJSON()).toBeNull();

    clone.start();
    clone.end();

    expect(processor.spansStarted).toEqual([]);
    expect(processor.spansEnded).toEqual([]);
  });
});
