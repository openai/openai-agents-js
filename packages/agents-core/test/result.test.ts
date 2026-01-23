import { describe, it, expect, vi } from 'vitest';
import { RunResult, StreamedRunResult } from '../src/result';
import { RunState } from '../src/runState';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { RunRawModelStreamEvent } from '../src/events';
import logger from '../src/logger';
import { getEventListeners } from 'node:events';

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

  it('exposes the active agent', () => {
    const state = createState();
    const result = new RunResult(state);
    expect(result.activeAgent).toBe(agent);
  });
});

describe('StreamedRunResult', () => {
  it('collects streamed text', async () => {
    const state = createState();
    const sr = new StreamedRunResult({ state });
    sr._addItem(
      new RunRawModelStreamEvent({ type: 'output_text_delta', delta: 'he' }),
    );
    sr._addItem(
      new RunRawModelStreamEvent({ type: 'output_text_delta', delta: 'llo' }),
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

  it('removes abort listeners when the stream is cancelled by the consumer', async () => {
    const state = createState();
    const sr = new StreamedRunResult({ state });
    const signal = sr._getAbortSignal();

    expect(signal).toBeDefined();
    if (!signal) {
      throw new Error('Expected an abort signal');
    }
    expect(getEventListeners(signal, 'abort').length).toBe(1);

    const reader = (sr.toStream() as any).getReader();
    await reader.cancel();
    await sr.completed;

    expect(sr.cancelled).toBe(true);
    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });

  it('ignores external aborts after the run has already completed', async () => {
    const state = createState();
    const controller = new AbortController();
    const sr = new StreamedRunResult({ state, signal: controller.signal });
    const signal = sr._getAbortSignal();

    expect(signal).toBeDefined();
    if (!signal) {
      throw new Error('Expected an abort signal');
    }
    expect(getEventListeners(signal, 'abort').length).toBe(1);

    sr._done();
    await sr.completed;
    expect(getEventListeners(signal, 'abort').length).toBe(0);

    controller.abort();

    expect(sr.cancelled).toBe(false);
    expect(sr.error).toBe(null);
  });

  it('removes abort listeners after completion', async () => {
    const state = createState();
    const sr = new StreamedRunResult({ state });
    const signal = sr._getAbortSignal();

    expect(signal).toBeDefined();
    if (!signal) {
      throw new Error('Expected an abort signal');
    }
    expect(getEventListeners(signal, 'abort').length).toBe(1);

    sr._done();
    await sr.completed;

    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });

  it('removes abort listeners after errors', async () => {
    const state = createState();
    const sr = new StreamedRunResult({ state });
    const signal = sr._getAbortSignal();

    expect(signal).toBeDefined();
    if (!signal) {
      throw new Error('Expected an abort signal');
    }
    expect(getEventListeners(signal, 'abort').length).toBe(1);

    const err = new Error('boom');
    sr._raiseError(err);
    await expect(sr.completed).rejects.toBe(err);

    expect(getEventListeners(signal, 'abort').length).toBe(0);
  });
});
