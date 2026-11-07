import { afterEach, describe, expect, it, vi } from 'vitest';
import { AsyncLocalStorage } from 'node:async_hooks';
import { z } from 'zod';
import {
  Agent,
  OutputGuardrailTripwireTriggered,
  RunItemStreamEvent,
  RunRawModelStreamEvent,
  setTracingDisabled,
  tool,
  type RunContext,
} from '@openai/agents-core';
import type { AgentInputItem, StreamEvent } from '@openai/agents-core/types';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelStreamResponder,
} from '@openai/agents-core/testing';
import { SDKRunner } from '../../src/migration';

setTracingDisabled(true);

const releases: Array<() => void> = [];
const controllers: AbortController[] = [];
const owned: Promise<unknown>[] = [];
const allowed = { tripwireTriggered: false, outputInfo: 'checked' };

// Every suspension has a deadline and is released even if an assertion fails.
function gate(label: string) {
  const pending = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => pending.reject(new Error(`Timed out waiting for ${label}`)),
    5_000,
  );
  void pending.promise.catch(() => {});
  const release = () => {
    clearTimeout(timer);
    pending.resolve();
  };
  releases.push(release);
  return { promise: pending.promise, release };
}

function watch<T>(promise: Promise<T>) {
  const state = { promise, settled: false };
  owned.push(promise);
  void promise.then(
    () => {
      state.settled = true;
    },
    () => {
      state.settled = true;
    },
  );
  return state;
}

function callerSignal() {
  const controller = new AbortController();
  controllers.push(controller);
  return controller;
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const release of releases.splice(0)) release();
  try {
    await Promise.allSettled(owned.splice(0));
  } finally {
    vi.restoreAllMocks();
  }
}, 15_000);

function agentFor(model: ScriptedModel) {
  return new Agent({
    name: 'Live migration consumer',
    instructions: 'Return text.',
    model,
  });
}

function done(text = 'Done.'): StreamEvent {
  return {
    type: 'response_done',
    response: {
      id: 'actual-sdk-response',
      requestId: 'actual-sdk-request',
      output: [assistantMessage(text, { id: 'actual-sdk-message' })],
      usage: { requests: 1, inputTokens: 2, outputTokens: 1, totalTokens: 3 },
    },
  };
}

const delta = { type: 'output_text_delta', delta: 'Done.' } as const;

describe('live SDK Model events on the real native migration loop', () => {
  it('delivers actual unvalidated deltas before final validation and joins before completion', async () => {
    const releaseModel = gate('model terminal release');
    const guardEntered = gate('final guard entry');
    const releaseGuard = gate('final guard release');
    let iteratorJoined = false;
    const model = new ScriptedModel([
      modelStreamResponder(async function* () {
        try {
          yield delta;
          await releaseModel.promise;
          yield done();
        } finally {
          iteratorJoined = true;
        }
      }),
    ]);
    const live = await SDKRunner.stream(agentFor(model), 'Input.', {
      context: undefined,
      signal: callerSignal().signal,
      outputGuardrails: [
        {
          name: 'delayed final check',
          execute: async () => {
            guardEntered.release();
            await releaseGuard.promise;
            return allowed;
          },
        },
      ],
    });
    const completion = watch(live.completed);
    const semanticReader = live.replayEvents().getReader();
    const firstSemantic = watch(semanticReader.read());
    const directSemantics = watch(Array.fromAsync(live.replayEvents()));
    const reader = live.unvalidatedRaw.getReader();
    expect(await reader.read()).toEqual({
      done: false,
      value: new RunRawModelStreamEvent(delta),
    });
    expect(completion.settled).toBe(false);
    releaseModel.release();
    await guardEntered.promise;
    expect(iteratorJoined).toBe(true);
    expect(completion.settled).toBe(false);
    expect(firstSemantic.settled).toBe(false);
    expect(directSemantics.settled).toBe(false);
    releaseGuard.release();
    const result = await completion.promise;
    expect(result.finalOutput).toBe('Done.');
    expect(result.lastResponseId).toBe('actual-sdk-response');
    expect(result.outputGuardrailResults).toHaveLength(1);
    expect(result.runContext.usage.totalTokens).toBe(3);
    const accepted = new RunItemStreamEvent(
      'message_output_created',
      result.newItems[0]!,
    );
    expect(await firstSemantic.promise).toEqual({
      done: false,
      value: accepted,
    });
    expect(await semanticReader.read()).toEqual({
      done: true,
      value: undefined,
    });
    expect(await directSemantics.promise).toEqual([accepted]);
    expect((await reader.read()).value?.data).toEqual(done());
    expect(await reader.read()).toEqual({ done: true, value: undefined });
    expect(model.calls.map((call) => call.streamed)).toEqual([true]);
    model.assertComplete();
  });

  it('maps a native tool round trip to accepted semantics and preserves only actual Model frames in raw delivery', async () => {
    const context = { account: 'original' };
    const value = { answer: 7 };
    const parameters = z.object({});
    let observedContext: RunContext<typeof context> | undefined;
    const execute = vi.fn(
      async (
        _args: Record<string, never>,
        received?: RunContext<typeof context>,
      ) => {
        observedContext = received;
        return value;
      },
    );
    const call = functionCall('lookup', '{}', { callId: 'live-tool-call' });
    const toolFrames: StreamEvent[] = [
      { type: 'response_started' },
      { type: 'model', event: { marker: 'actual SDK tool frame' } },
      {
        type: 'response_done',
        response: {
          id: 'actual-sdk-tools',
          output: [call],
          usage: {
            requests: 1,
            inputTokens: 2,
            outputTokens: 1,
            totalTokens: 3,
          },
        },
      },
    ];
    const model = new ScriptedModel([
      modelStreamResponder(() => toolFrames),
      modelStreamResponder((received) => {
        expect(received.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: call.callId,
            output: JSON.stringify(value),
          }),
        );
        return [delta, done()];
      }),
    ]);
    const agent = new Agent<typeof context>({
      name: 'Streamed tool consumer',
      instructions: 'Use lookup and return text.',
      model,
      tools: [
        tool<typeof parameters, typeof context, typeof value>({
          name: 'lookup',
          description: 'Read.',
          parameters,
          execute,
        }),
      ],
    });
    const live = await SDKRunner.stream(agent, 'Input.', {
      context,
      signal: callerSignal().signal,
    });
    const semantics = watch(Array.fromAsync(live.replayEvents()));
    const result = await watch(live.completed).promise;
    const accepted = await semantics.promise;
    expect(
      accepted.map((event) =>
        event.type === 'run_item_stream_event' ? event.name : event.type,
      ),
    ).toEqual(['tool_called', 'tool_output', 'message_output_created']);
    expect(accepted.every((event) => event instanceof RunItemStreamEvent)).toBe(
      true,
    );
    const acceptedItems = accepted.filter(
      (event): event is RunItemStreamEvent =>
        event.type === 'run_item_stream_event',
    );
    acceptedItems.forEach((event, index) => {
      expect(event.item).toBe(result.newItems[index]);
      const item = result.newItems[index]!;
      expect(item.type !== 'handoff_output_item' && item.agent === agent).toBe(
        true,
      );
    });
    expect(result.newItems[1]).toMatchObject({
      output: value,
      rawItem: { callId: call.callId, output: JSON.stringify(value) },
    });
    expect(result.lastAgent).toBe(agent);
    expect(result.runContext).toBe(observedContext);
    expect(result.runContext.context).toBe(context);
    expect(result.runContext.usage.totalTokens).toBe(6);
    expect(result.finalOutput).toBe('Done.');
    expect(result.native.turnId).toBeTruthy();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(await Array.fromAsync(live.unvalidatedRaw)).toEqual(
      [...toolFrames, delta, done()].map(
        (event) => new RunRawModelStreamEvent(event),
      ),
    );
    expect(model.calls.map((entry) => entry.streamed)).toEqual([true, true]);
    model.assertComplete();
  });

  it('captures input, options, context identity and ALS before the first await', async () => {
    const storage = new AsyncLocalStorage<string>();
    const context = { account: 'original' };
    const originalSignal = callerSignal();
    const replacementSignal = callerSignal();
    const check = vi.fn(
      async (args: { context: RunContext<typeof context> }) => {
        expect(storage.getStore()).toBe('original caller');
        expect(args.context.context).toBe(context);
        return allowed;
      },
    );
    const model = new ScriptedModel([
      modelStreamResponder((call) => {
        expect(storage.getStore()).toBe('original caller');
        expect(call.streamed).toBe(true);
        expect(call.request.input).toEqual([
          { role: 'user', content: 'Original input.' },
        ]);
        expect(call.request.modelSettings.temperature).toBe(0.2);
        return [delta, done()];
      }),
    ]);
    const agent = new Agent<typeof context>({
      name: 'Captured stream',
      instructions: 'Return text.',
      model,
    });
    const message = { role: 'user' as const, content: 'Original input.' };
    const input: AgentInputItem[] = [message];
    const options = {
      context,
      signal: originalSignal.signal,
      modelSettings: { temperature: 0.2 },
      outputGuardrails: [{ name: 'original guard', execute: check }],
    };
    const starting = storage.run('original caller', () =>
      SDKRunner.stream(agent, input, options),
    );
    message.content = 'Changed input.';
    input.length = 0;
    options.context = { account: 'replacement' };
    options.modelSettings.temperature = 0.9;
    options.outputGuardrails.length = 0;
    options.signal = replacementSignal.signal;
    replacementSignal.abort(new Error('Replacement signal must be ignored'));
    const live = await starting;
    const result = await watch(live.completed).promise;
    expect(result.input).toEqual([
      { role: 'user', content: 'Original input.' },
    ]);
    expect(result.lastAgent).toBe(agent);
    expect(result.runContext.context).toBe(context);
    expect(check).toHaveBeenCalledTimes(1);
    expect(await Array.fromAsync(live.unvalidatedRaw)).toEqual(
      [delta, done()].map((event) => new RunRawModelStreamEvent(event)),
    );
    model.assertComplete();
  });

  it('completes with no reader and retains actual SDK event order through EOF', async () => {
    const events: StreamEvent[] = [
      { type: 'response_started' },
      {
        type: 'model',
        event: { marker: 'provider event' },
        providerData: { rawModelEventSource: 'actual-provider' },
      },
      delta,
      done(),
    ];
    const model = new ScriptedModel([modelStreamResponder(() => events)]);
    const live = await SDKRunner.stream(agentFor(model), 'Input.', {
      context: undefined,
      signal: callerSignal().signal,
    });
    const result = await watch(live.completed).promise;
    expect(result.finalOutput).toBe('Done.');
    expect(result.newItems.map((item) => item.type)).toEqual([
      'message_output_item',
    ]);
    const raw = await Array.fromAsync(live.unvalidatedRaw);
    expect(raw).toEqual(
      events.map((event) => new RunRawModelStreamEvent(event)),
    );
    expect(raw[1]?.source).toBe('actual-provider');
    expect(raw.every((event) => event instanceof RunRawModelStreamEvent)).toBe(
      true,
    );
    model.assertComplete();
  });

  it.each(['reader', 'iterator', 'signal'] as const)(
    'joins blocked Model next and return after early %s cancellation',
    async (consumer) => {
      const nextEntered = gate('blocked model next');
      const releaseNext = gate('model next release');
      const returnEntered = gate('model return entry');
      const releaseReturn = gate('model return release');
      const aborted = gate('model signal abort');
      const controller = callerSignal();
      const reason = new Error('Consumer stopped');
      let joined = false;
      const model = new ScriptedModel([
        modelStreamResponder((call) => {
          call.request.signal!.addEventListener('abort', aborted.release, {
            once: true,
          });
          return (async function* () {
            try {
              yield delta;
              nextEntered.release();
              await releaseNext.promise;
              yield delta;
            } finally {
              returnEntered.release();
              await releaseReturn.promise;
              joined = true;
            }
          })();
        }),
      ]);
      const live = await SDKRunner.stream(agentFor(model), 'Input.', {
        context: undefined,
        signal: controller.signal,
      });
      const completion = watch(live.completed);
      const reader =
        consumer !== 'iterator' ? live.unvalidatedRaw.getReader() : undefined;
      const iterator =
        consumer === 'iterator'
          ? live.unvalidatedRaw[Symbol.asyncIterator]()
          : undefined;
      const first = await (reader ? reader.read() : iterator!.next());
      expect(first.value?.data).toEqual(delta);
      await nextEntered.promise;
      let cancellation: Promise<void>;
      if (consumer === 'signal') {
        controller.abort(reason);
        cancellation = Promise.resolve();
      } else if (reader) {
        cancellation = reader.cancel(reason);
      } else {
        cancellation = iterator!.return!(undefined).then(() => {});
      }
      watch(cancellation);
      await aborted.promise;
      expect(completion.settled).toBe(false);
      expect(joined).toBe(false);
      releaseNext.release();
      await returnEntered.promise;
      expect(completion.settled).toBe(false);
      expect(joined).toBe(false);
      releaseReturn.release();
      if (consumer !== 'iterator') {
        await expect(completion.promise).rejects.toBe(reason);
      } else {
        await expect(completion.promise).rejects.toBeDefined();
      }
      await cancellation;
      expect(joined).toBe(true);
      expect(model.calls).toHaveLength(1);
      expect(model.calls[0]!.request.signal!.aborted).toBe(true);
      model.assertComplete();
    },
  );

  it.each(['model error', 'missing response_done'] as const)(
    'errors raw delivery instead of reporting EOF after %s',
    async (failure) => {
      const release = gate('model failure release');
      const original = new Error('Actual SDK Model failure');
      let joined = false;
      const model = new ScriptedModel([
        modelStreamResponder(async function* () {
          try {
            yield delta;
            await release.promise;
            if (failure === 'model error') throw original;
          } finally {
            joined = true;
          }
        }),
      ]);
      const live = await SDKRunner.stream(agentFor(model), 'Input.', {
        context: undefined,
        signal: callerSignal().signal,
      });
      const completion = watch(live.completed);
      const reader = live.unvalidatedRaw.getReader();
      const semantic = watch(live.replayEvents().getReader().read());
      const directSemantics = watch(Array.fromAsync(live.replayEvents()));
      expect((await reader.read()).value?.data).toEqual(delta);
      const next = watch(reader.read());
      release.release();
      if (failure === 'model error') {
        await expect(next.promise).rejects.toBe(original);
        await expect(semantic.promise).rejects.toBe(original);
        await expect(directSemantics.promise).rejects.toBe(original);
        await expect(completion.promise).rejects.toBe(original);
      } else {
        await expect(next.promise).rejects.toThrow('response_done');
        await expect(semantic.promise).rejects.toThrow('response_done');
        await expect(directSemantics.promise).rejects.toThrow('response_done');
        await expect(completion.promise).rejects.toThrow('response_done');
      }
      expect(joined).toBe(true);
      model.assertComplete();
    },
  );

  it('rejects accepted semantics when the final guard blocks already visible raw output', async () => {
    const releaseTerminal = gate('guard rejection terminal release');
    const guardEntered = gate('rejecting output guard entry');
    const releaseGuard = gate('rejecting output guard release');
    let joined = false;
    const model = new ScriptedModel([
      modelStreamResponder(async function* () {
        try {
          yield delta;
          await releaseTerminal.promise;
          yield done();
        } finally {
          joined = true;
        }
      }),
    ]);
    const live = await SDKRunner.stream(agentFor(model), 'Input.', {
      context: undefined,
      signal: callerSignal().signal,
      outputGuardrails: [
        {
          name: 'reject streamed output',
          execute: async () => {
            guardEntered.release();
            await releaseGuard.promise;
            return { tripwireTriggered: true, outputInfo: 'blocked' };
          },
        },
      ],
    });
    const completion = watch(live.completed);
    const semantic = watch(live.replayEvents().getReader().read());
    const directSemantics = watch(Array.fromAsync(live.replayEvents()));
    const reader = live.unvalidatedRaw.getReader();
    expect(await reader.read()).toEqual({
      done: false,
      value: new RunRawModelStreamEvent(delta),
    });
    releaseTerminal.release();
    expect(await reader.read()).toEqual({
      done: false,
      value: new RunRawModelStreamEvent(done()),
    });
    await guardEntered.promise;
    expect(joined).toBe(true);
    expect(completion.settled).toBe(false);
    expect(semantic.settled).toBe(false);
    expect(directSemantics.settled).toBe(false);
    releaseGuard.release();
    await expect(completion.promise).rejects.toBeInstanceOf(
      OutputGuardrailTripwireTriggered,
    );
    const failure = await completion.promise.catch((error: unknown) => error);
    await expect(semantic.promise).rejects.toBe(failure);
    await expect(directSemantics.promise).rejects.toBe(failure);
    model.assertComplete();
  });

  it('withholds an actual SDK event after response_done and joins before rejecting completion', async () => {
    const releaseLate = gate('post-terminal SDK event release');
    const returnEntered = gate('post-terminal iterator return');
    const releaseReturn = gate('post-terminal iterator cleanup release');
    const late: StreamEvent = {
      type: 'output_text_delta',
      delta: 'Must never reach the consumer.',
    };
    let joined = false;
    const model = new ScriptedModel([
      modelStreamResponder(async function* () {
        try {
          yield delta;
          yield done();
          await releaseLate.promise;
          yield late;
        } finally {
          returnEntered.release();
          await releaseReturn.promise;
          joined = true;
        }
      }),
    ]);
    const live = await SDKRunner.stream(agentFor(model), 'Input.', {
      context: undefined,
      signal: callerSignal().signal,
    });
    const completion = watch(live.completed);
    const semantic = watch(live.replayEvents().getReader().read());
    const directSemantics = watch(Array.fromAsync(live.replayEvents()));
    const reader = live.unvalidatedRaw.getReader();
    expect(await reader.read()).toEqual({
      done: false,
      value: new RunRawModelStreamEvent(delta),
    });
    expect(await reader.read()).toEqual({
      done: false,
      value: new RunRawModelStreamEvent(done()),
    });
    const next = watch(reader.read());
    releaseLate.release();
    await returnEntered.promise;
    expect(completion.settled).toBe(false);
    expect(joined).toBe(false);
    releaseReturn.release();
    await expect(completion.promise).rejects.toThrow('after response_done');
    const failure = await completion.promise.catch((error: unknown) => error);
    await expect(next.promise).rejects.toBe(failure);
    await expect(semantic.promise).rejects.toBe(failure);
    await expect(directSemantics.promise).rejects.toBe(failure);
    expect(joined).toBe(true);
    expect(model.calls).toHaveLength(1);
    model.assertComplete();
  });

  it('fails an unread raw backlog when the SDK wrapper takes an allowed event over 4 MiB', async () => {
    const cap = 4 * 1024 * 1024;
    const empty = { type: 'output_text_delta', delta: '' } as const;
    const event: StreamEvent = {
      ...empty,
      delta: 'x'.repeat(cap - Buffer.byteLength(JSON.stringify(empty))),
    };
    expect(Buffer.byteLength(JSON.stringify(event))).toBe(cap);
    expect(
      Buffer.byteLength(JSON.stringify(new RunRawModelStreamEvent(event))),
    ).toBeGreaterThan(cap);
    const returnEntered = gate('overflow iterator return');
    const releaseReturn = gate('overflow iterator cleanup release');
    let joined = false;
    const model = new ScriptedModel([
      modelStreamResponder(async function* () {
        try {
          yield event;
          yield done();
        } finally {
          returnEntered.release();
          await releaseReturn.promise;
          joined = true;
        }
      }),
    ]);
    const live = await SDKRunner.stream(agentFor(model), 'Input.', {
      context: undefined,
      signal: callerSignal().signal,
    });
    const completion = watch(live.completed);
    await returnEntered.promise;
    expect(completion.settled).toBe(false);
    expect(joined).toBe(false);
    releaseReturn.release();
    await expect(completion.promise).rejects.toThrow(/backlog/i);
    expect(joined).toBe(true);
    expect(model.calls[0]!.request.signal!.aborted).toBe(true);
    await expect(live.unvalidatedRaw.getReader().read()).rejects.toThrow(
      /backlog/i,
    );
    model.assertComplete();
  });

  it('rejects explicit response invocation before model or guard effects', async () => {
    const model = new ScriptedModel([]);
    const guard = vi.fn(async () => allowed);
    await expect(
      SDKRunner.stream(agentFor(model), 'Input.', {
        context: undefined,
        modelInvocation: 'response',
        inputGuardrails: [
          { name: 'must not enter', runInParallel: false, execute: guard },
        ],
      }),
    ).rejects.toThrow(/stream|response/i);
    expect(model.calls).toHaveLength(0);
    expect(guard).not.toHaveBeenCalled();
    model.assertComplete();
  });
});
