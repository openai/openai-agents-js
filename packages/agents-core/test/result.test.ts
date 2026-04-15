import { describe, it, expect, vi } from 'vitest';
import { RunResult, StreamedRunResult } from '../src/result';
import { RunState } from '../src/runState';
import { Agent } from '../src/agent';
import { RunContext } from '../src/runContext';
import { RunRawModelStreamEvent } from '../src/events';
import logger from '../src/logger';
import { getEventListeners } from 'node:events';
import { runStreamedRunResultLeakCheck } from './manual/streamedRunResultLeakCheck';
import { runStreamedRunResultLeakStress } from './manual/streamedRunResultLeakStress';

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

  it('exposes the top-level run context', () => {
    const state = createState();
    const result = new RunResult(state);

    expect(result.runContext).toBe(state._context);
    expect(result.agentToolInvocation).toBeUndefined();
  });

  it('exposes nested agent-tool metadata', () => {
    const state = new RunState(new RunContext(), '', agent, 1);
    state._agentToolInvocation = {
      toolName: 'nested_tool',
      toolCallId: 'call-outer',
      toolArguments: '{"input":"hello"}',
    };
    const result = new RunResult(state as any);

    expect(result.runContext).toBe(state._context);
    expect(result.agentToolInvocation).toEqual({
      toolName: 'nested_tool',
      toolCallId: 'call-outer',
      toolArguments: '{"input":"hello"}',
    });
  });

  it('exposes nested agent-tool metadata without changing custom run contexts', () => {
    class ExtendedRunContext extends RunContext<{ locale: string }> {
      describe() {
        return `${this.context.locale}:${(this.toolInput as { input?: string } | undefined)?.input}`;
      }

      get summary() {
        return this.context.locale;
      }
    }

    const state = new RunState(
      new ExtendedRunContext({ locale: 'en-US' }),
      '',
      agent,
      1,
    );
    state._context.toolInput = { input: 'hello' };
    state._agentToolInvocation = {
      toolName: 'nested_tool',
      toolCallId: 'call-outer',
      toolArguments: '{"input":"hello"}',
    };
    const result = new RunResult(state as any);
    const firstContext = result.runContext as ExtendedRunContext;
    const secondContext = result.runContext as ExtendedRunContext;

    expect(firstContext).toBe(secondContext);
    expect(firstContext).toBeInstanceOf(ExtendedRunContext);
    expect(firstContext.describe()).toBe('en-US:hello');
    expect(
      (firstContext as ExtendedRunContext & { summary: string }).summary,
    ).toBe('en-US');
    expect(result.agentToolInvocation).toEqual({
      toolName: 'nested_tool',
      toolCallId: 'call-outer',
      toolArguments: '{"input":"hello"}',
    });

    firstContext.toolInput = { input: 'updated' };
    expect(
      (result.runContext as RunContext<{ locale: string }>).toolInput,
    ).toEqual({
      input: 'updated',
    });
    expect(state._context.toolInput).toEqual({ input: 'updated' });
    expect(state.toJSON().context.toolInput).toEqual({ input: 'updated' });
  });

  it('does not carry nested agent-tool metadata into a new top-level run', () => {
    const nestedState = new RunState(new RunContext(), '', agent, 1);
    nestedState._agentToolInvocation = {
      toolName: 'nested_tool',
      toolCallId: 'call-outer',
      toolArguments: '{"input":"hello"}',
    };

    const nestedResult = new RunResult(nestedState as any);
    const reusedState = new RunState(
      nestedResult.runContext as RunContext<unknown>,
      '',
      agent,
      1,
    );
    const reusedResult = new RunResult(reusedState as any);

    expect(reusedState._context).toBe(nestedState._context);
    expect(reusedState._agentToolInvocation).toBeUndefined();
    expect(reusedResult.agentToolInvocation).toBeUndefined();
    expect(reusedState.toJSON()).not.toHaveProperty('agentToolInvocation');
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

  it('preserves an already-aborted signal for the run loop', async () => {
    const state = createState();
    const controller = new AbortController();
    controller.abort();

    const sr = new StreamedRunResult({ state, signal: controller.signal });
    await Promise.resolve();
    const signal = sr._getAbortSignal();

    expect(signal).toBeDefined();
    expect(signal?.aborted).toBe(true);
    expect(sr.cancelled).toBe(true);
    await expect(sr.completed).resolves.toBeUndefined();
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

  it('does not retain state when the abort signal is retained', async () => {
    const result = await runStreamedRunResultLeakCheck();

    expect(result.doneCollected).toBe(true);
    expect(result.errorCollected).toBe(true);
  }, 20_000);

  it('stress-checks retained abort signals without leaking run state', async () => {
    const result = await runStreamedRunResultLeakStress({
      iterations: 250,
      snapshotEvery: 250,
      abortAfterDone: false,
      removeMode: 'noop',
      minFinalizedRatio: 0.9,
      pressureSize: 120000,
    });

    expect(result.finalizedRatio).toBeGreaterThanOrEqual(
      result.minFinalizedRatio,
    );
    expect(result.postDoneAbortMutations).toBeLessThanOrEqual(
      result.maxPostDoneAbortMutations,
    );
  }, 20_000);
});
