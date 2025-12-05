import { describe, it, expect, vi } from 'vitest';
import { RunResult, StreamedRunResult } from '../src/result';
import { RunState } from '../src/runState';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { RunRawModelStreamEvent } from '../src/events';
import logger from '../src/logger';
import type { StreamEventTextStream } from '../src/types/protocol';

const agent = new Agent({ name: 'A' });

function createState(): RunState<unknown, Agent<any, any>> {
  return new RunState(new RunContext(), '', agent, 1);
}

describe('RunResult', () => {
  it('returns final output when completed', () => {
    const state = createState();
    state._currentStep = { type: 'next_step_final_output', output: 'done' };
    const result = new RunResult(state);
    expect(result.finalOutput).toBe('done');
  });

  it('warns and returns undefined when not completed', () => {
    const state = createState();
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const result = new RunResult(state);
    expect(result.finalOutput).toBeUndefined();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe('StreamedRunResult', () => {
  it('collects streamed text', async () => {
    const state = createState();
    const sr = new StreamedRunResult({ state });
    const agentName = 'test';
    sr._addItem(
      new RunRawModelStreamEvent(
        { type: 'output_text_delta', delta: 'he' },
        agentName,
      ),
    );
    sr._addItem(
      new RunRawModelStreamEvent(
        { type: 'output_text_delta', delta: 'llo' },
        agentName,
      ),
    );
    sr._done();

    const vs = sr.toTextStream().values();
    let text = '';
    for await (const value of vs) {
      text += value;
    }

    await sr.completed;
    expect(text).toBe('hello');
    expect(sr.error).toBe(null);
  });

  it('records errors and rejects completed promise', async () => {
    const state = createState();
    const sr = new StreamedRunResult({ state });
    const err = new Error('boom');
    sr._raiseError(err);
    await expect(sr.completed).rejects.toBe(err);
    expect(sr.error).toBe(err);
  });

  it('handles abort while iterating without throwing', async () => {
    const state = createState();
    const controller = new AbortController();
    const sr = new StreamedRunResult({ state, signal: controller.signal });

    const consumePromise = (async () => {
      for await (const _ of sr) {
        // Intentionally empty.
      }
    })();

    await Promise.resolve();

    controller.abort();

    await expect(consumePromise).resolves.toBeUndefined();
    await expect(sr.completed).resolves.toBeUndefined();
    expect(sr.cancelled).toBe(true);
    expect(sr.error).toBe(null);
  });

  it('routes toStream through the context scope stream when streamAgentTools is enabled', async () => {
    const state = createState();
    const result = new StreamedRunResult({
      state: state,
      streamAgentTools: true,
    });
    const contextScopeStream = state._context._contextScopeStream;
    expect(contextScopeStream).toBeDefined();
    const vs = result.toStream().values();
    result._addItem(
      new RunRawModelStreamEvent(
        { type: 'output_text_delta', delta: 'hel' },
        'Agent',
      ),
    );
    result._addItem(
      new RunRawModelStreamEvent(
        { type: 'output_text_delta', delta: 'lo' },
        'Agent',
      ),
    );
    result._done();

    let text = '';
    for await (const value of vs) {
      expect(value.type).toBe('raw_model_stream_event');
      const rawModelEvent = value as RunRawModelStreamEvent;
      expect(rawModelEvent.data.type).toBe('output_text_delta');
      const data = rawModelEvent.data as StreamEventTextStream;
      text += data.delta ?? '';
    }
    await result.completed;
    expect(text).toBe('hello');
  });

  it('routes toTextStream through the context scope stream when streamAgentTools is enabled', async () => {
    const state = createState();
    const result = new StreamedRunResult({
      state: state,
      streamAgentTools: true,
    });
    const contextScopeStream = state._context._contextScopeStream;
    const textStream = result.toTextStream();
    expect(contextScopeStream).toBeDefined();
    result._addItem(
      new RunRawModelStreamEvent(
        { type: 'output_text_delta', delta: 'hel' },
        'Agent',
      ),
    );
    result._addItem(
      new RunRawModelStreamEvent(
        { type: 'output_text_delta', delta: 'lo' },
        'Agent',
      ),
    );
    result._done();

    const textIterator = textStream.values();
    let text = '';
    for await (const value of textIterator) {
      text += value;
    }
    await result.completed;
    expect(text).toBe('hello');
  });

  it('routes async iteration through the context scope stream when streamAgentTools is enabled', async () => {
    const state = createState();
    const result = new StreamedRunResult({
      state: state,
      streamAgentTools: true,
    });
    const contextScopeStream = state._context._contextScopeStream;
    expect(contextScopeStream).toBeDefined();

    result._addItem(
      new RunRawModelStreamEvent(
        { type: 'output_text_delta', delta: 'hel' },
        'Agent',
      ),
    );
    result._addItem(
      new RunRawModelStreamEvent(
        { type: 'output_text_delta', delta: 'lo' },
        'Agent',
      ),
    );
    result._done();

    let text = '';
    for await (const event of result) {
      expect(event.type).toBe('raw_model_stream_event');
      const rawModelEvent = event as RunRawModelStreamEvent;
      const data = rawModelEvent.data as StreamEventTextStream;
      text += data.delta ?? '';
    }
    await result.completed;
    expect(text).toBe('hello');
  });

  it('clears context scope stream metadata on completion', async () => {
    const state = createState();
    const sr = new StreamedRunResult({ state, streamAgentTools: true });
    expect(state._context._copyToContextScopeStream).toBe(true);
    sr._done();
    await sr.completed;
    expect(state._context._copyToContextScopeStream).toBe(false);
    expect(state._context._contextScopeStream).toBeDefined();
  });

  it('clears context scope stream metadata on error', async () => {
    const errorState = createState();
    const srError = new StreamedRunResult({
      state: errorState,
      streamAgentTools: true,
    });
    const err = new Error('agg-error');
    srError._raiseError(err);
    await expect(srError.completed).rejects.toBe(err);
    expect(errorState._context._copyToContextScopeStream).toBe(false);
    expect(errorState._context._contextScopeStream).toBeUndefined();
  });

  it('clears context scope stream metadata on abort', async () => {
    const abortState = createState();
    const controller = new AbortController();
    const srAbort = new StreamedRunResult({
      state: abortState,
      streamAgentTools: true,
      signal: controller.signal,
    });
    controller.abort();
    await srAbort.completed;
    expect(abortState._context._copyToContextScopeStream).toBe(false);
    expect(abortState._context._contextScopeStream).toBeUndefined();
  });
});
