import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent, Runner, setTracingDisabled, tool } from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
} from '@openai/agents-core/testing';
import { MigrationCleanupError, SDKRunner } from '../../src/migration';
import { NativeProvider } from '../../src/runtime/provider';

setTracingDisabled(true);

const releases: Array<() => void> = [];
const controllers: AbortController[] = [];
const owned: Promise<unknown>[] = [];
const cleanups: Array<() => Promise<void>> = [];

function gate(label: string) {
  const pending = Promise.withResolvers<void>();
  const timer = setTimeout(
    () => pending.reject(new Error(`Timed out waiting for ${label}`)),
    10_000,
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
    (error: unknown) => {
      state.settled = true;
      if (error instanceof MigrationCleanupError)
        cleanups.push(() => error.retryCleanup());
    },
  );
  return state;
}

function forbidClassicRunner() {
  return vi.spyOn(Runner.prototype, 'run').mockImplementation(() => {
    throw new Error('Agent tools must use the native runner');
  });
}

afterEach(async () => {
  for (const controller of controllers.splice(0)) controller.abort();
  for (const release of releases.splice(0)) release();
  try {
    await Promise.allSettled(owned.splice(0));
    await Promise.allSettled(cleanups.splice(0).map((cleanup) => cleanup()));
  } finally {
    vi.restoreAllMocks();
  }
}, 20_000);

describe('native Agent.asTool lifecycle ownership', () => {
  it('joins entered child Model work and owned cleanup before rejecting parent cancellation', async () => {
    const classicRun = forbidClassicRunner();
    const entered = gate('child Model entry');
    const aborted = gate('child Model signal abort');
    const releaseModel = gate('child Model release');
    const closeEntered = gate('owned provider close entry');
    const releaseClose = gate('owned provider close release');
    const controller = new AbortController();
    controllers.push(controller);
    const reason = new Error('Parent caller stopped');
    let producerJoined = false;
    const closed = new Set<NativeProvider>();
    const close = NativeProvider.prototype.close;
    vi.spyOn(NativeProvider.prototype, 'close').mockImplementation(
      async function (this: NativeProvider) {
        closeEntered.release();
        await releaseClose.promise;
        await close.call(this);
        closed.add(this);
      },
    );
    const childModel = new ScriptedModel([
      modelResponder(async (call) => {
        call.request.signal!.addEventListener('abort', aborted.release, {
          once: true,
        });
        entered.release();
        try {
          // The local Model deliberately keeps working after receiving abort.
          await releaseModel.promise;
          return [assistantMessage('Late child answer.')];
        } finally {
          producerJoined = true;
        }
      }),
    ]);
    const extract = vi.fn(() => 'Must not publish a cancelled child.');
    const child = new Agent({
      name: 'Blocked child',
      instructions: 'Return text.',
      model: childModel,
    });
    const continued = vi.fn(() => [
      assistantMessage('Unexpected continuation.'),
    ]);
    const parentModel = new ScriptedModel([
      modelResponder(() => [
        functionCall('ask_child', '{"input":"Question."}', {
          callId: 'cancel-child-call',
        }),
      ]),
      modelResponder(continued),
    ]);
    const parent = new Agent({
      name: 'Parent',
      instructions: 'Ask the child.',
      model: parentModel,
      tools: [
        child.asTool({
          toolName: 'ask_child',
          customOutputExtractor: extract,
        }),
      ],
    });
    const running = watch(
      SDKRunner.run(parent, 'Ask.', {
        context: undefined,
        signal: controller.signal,
      }),
    );
    await entered.promise;
    controller.abort(reason);
    await aborted.promise;
    expect(running.settled).toBe(false);
    expect(producerJoined).toBe(false);
    releaseModel.release();
    await closeEntered.promise;
    expect(running.settled).toBe(false);
    releaseClose.release();
    const failure: unknown = await running.promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    // Cancellation preserves the caller's error after both owners finish cleanup.
    expect(failure).toBe(reason);
    expect(producerJoined).toBe(true);
    expect(closed.size).toBe(2);
    expect(childModel.calls).toHaveLength(1);
    expect(childModel.calls[0]!.request.signal!.aborted).toBe(true);
    expect(parentModel.calls).toHaveLength(1);
    expect(continued).not.toHaveBeenCalled();
    expect(extract).not.toHaveBeenCalled();
    expect(classicRun).not.toHaveBeenCalled();
    childModel.assertComplete();
  }, 25_000);

  it('retains child cleanup failure across tool error conversion and retries cleanup without repeating effects', async () => {
    const classicRun = forbidClassicRunner();
    const retryEntered = gate('child cleanup retry entry');
    const releaseRetry = gate('child cleanup retry release');
    const closeError = new Error('Child provider close failed');
    const close = NativeProvider.prototype.close;
    let childCloseAttempts = 0;
    const closed = new Set<NativeProvider>();
    const closeSpy = vi.spyOn(NativeProvider.prototype, 'close');
    closeSpy.mockImplementation(async function (this: NativeProvider) {
      // The child completes and closes before its parent's tool can return.
      if (this === closeSpy.mock.contexts[0]) {
        childCloseAttempts++;
        if (childCloseAttempts === 1) throw closeError;
        retryEntered.release();
        await releaseRetry.promise;
      }
      await close.call(this);
      closed.add(this);
    });
    const execute = vi.fn(() => 'Accepted child effect.');
    const childModel = new ScriptedModel([
      modelResponder(() => [
        functionCall('child_effect', '{}', { callId: 'child-effect-call' }),
      ]),
      modelResponder((call) => {
        expect(call.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'child-effect-call',
            output: 'Accepted child effect.',
          }),
        );
        return [assistantMessage('Completed child answer.')];
      }),
    ]);
    const child = new Agent({
      name: 'Child with owned cleanup',
      instructions: 'Use child_effect and answer.',
      model: childModel,
      tools: [
        tool({
          name: 'child_effect',
          description: 'Record the child effect.',
          parameters: z.object({}),
          execute,
        }),
      ],
    });
    const extract = vi.fn(() => 'Must not publish before cleanup succeeds.');
    const continued = vi.fn(() => [
      assistantMessage('Unexpected continuation.'),
    ]);
    const parentModel = new ScriptedModel([
      modelResponder(() => [
        functionCall('ask_child', '{"input":"Question."}', {
          callId: 'cleanup-child-call',
        }),
      ]),
      modelResponder(continued),
    ]);
    const parent = new Agent({
      name: 'Parent',
      instructions: 'Ask the child.',
      model: parentModel,
      tools: [
        child.asTool({
          toolName: 'ask_child',
          customOutputExtractor: extract,
        }),
      ],
    });
    const running = watch(
      SDKRunner.run(parent, 'Ask.', { context: undefined }),
    );
    const failure: unknown = await running.promise.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(MigrationCleanupError);
    if (!(failure instanceof MigrationCleanupError))
      throw new Error('Expected a retained migration cleanup error');
    const childFailure = failure.cause;
    expect(childFailure).toBeInstanceOf(MigrationCleanupError);
    // runCaptured flattens AggregateError.errors but retains the child owner
    // in cause; the close error and retry route remain independently visible.
    expect(failure.errors).toContain(closeError);
    expect(childFailure).toHaveProperty('cause', closeError);
    expect(childCloseAttempts).toBe(1);
    expect(closed.size).toBe(0);
    expect(extract).not.toHaveBeenCalled();
    expect(continued).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledOnce();
    expect(childModel.calls).toHaveLength(2);
    expect(parentModel.calls).toHaveLength(1);

    const retryCleanup = failure.retryCleanup;
    const first = watch(retryCleanup());
    const second = retryCleanup();
    expect(second).toBe(first.promise);
    await retryEntered.promise;
    expect(first.settled).toBe(false);
    expect(childCloseAttempts).toBe(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(childModel.calls).toHaveLength(2);
    releaseRetry.release();
    await first.promise;
    await retryCleanup();
    expect(childCloseAttempts).toBe(2);
    expect(closed.size).toBe(2);
    expect(execute).toHaveBeenCalledOnce();
    expect(childModel.calls).toHaveLength(2);
    expect(parentModel.calls).toHaveLength(1);
    expect(extract).not.toHaveBeenCalled();
    expect(continued).not.toHaveBeenCalled();
    expect(classicRun).not.toHaveBeenCalled();
    childModel.assertComplete();
  }, 25_000);
});
