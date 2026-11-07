import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  RunToolApprovalItem,
  Usage,
  ToolGuardrailFunctionOutputFactory as guardOutput,
  setTracingDisabled,
  tool,
  type RunContext,
} from '@openai/agents/classic';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponder,
  modelResponse,
} from '@openai/agents/classic/testing';
import {
  SDKRunner,
  type MigrationApprovalOptions,
} from '@openai/agents/migration';
import { localStorage } from '../../src';

setTracingDisabled(true);

const controllers: AbortController[] = [];
const releases: Array<() => void> = [];
const owned: Promise<unknown>[] = [];
const profiles: string[] = [];
const allowed = { tripwireTriggered: false, outputInfo: 'checked' };
const refusal = 'Tool execution was not approved.';
const emptyParameters = z.object({});

// As in migration-stream.test.ts, every held owner has finite cleanup.
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
    await Promise.all(
      profiles
        .splice(0)
        .map((path) => rm(path, { recursive: true, force: true })),
    );
    vi.restoreAllMocks();
  }
}, 15_000);

type PauseOptions<T> = T extends unknown
  ? Omit<T, 'context' | 'approvals'>
  : never;

async function pause<Context>(
  agent: Agent<Context, 'text'>,
  context: Context,
  options: PauseOptions<MigrationApprovalOptions<Context>> = {},
) {
  const result = await watch(
    SDKRunner.run(agent, 'Input.', {
      ...options,
      context,
      approvals: 'manual',
      signal: options.signal ?? callerSignal().signal,
    }),
  ).promise;
  if (!('status' in result) || result.status !== 'paused')
    throw new Error('Expected a held native function call');
  watch(result.completed);
  return result;
}

function approvalAgent(model: ScriptedModel, execute: () => string) {
  return new Agent({
    name: 'Held native migration consumer',
    instructions: 'Use lookup and return text.',
    model,
    tools: [
      tool({
        name: 'lookup',
        description: 'Read one record.',
        parameters: emptyParameters,
        needsApproval: true,
        execute,
      }),
    ],
  });
}

describe('one held SDK function on the real native migration loop', () => {
  it('preserves checked object output across the held approval and native finalizer', async () => {
    const outputType = z.object({ approved: z.boolean() });
    const execute = vi.fn(() => 'confirmed');
    const model = new ScriptedModel([
      modelResponse([
        functionCall('confirm', '{}', { callId: 'object-approval-call' }),
      ]),
      modelResponder((call) => {
        expect(call.request.outputType).toEqual(
          expect.objectContaining({ type: 'json_schema' }),
        );
        return {
          output: [assistantMessage('{"approved":true}')],
          usage: new Usage(),
        };
      }),
    ]);
    const agent = new Agent({
      name: 'Checked approval result',
      instructions: 'Confirm once and return the declared report.',
      model,
      outputType,
      tools: [
        tool({
          name: 'confirm',
          description: 'Confirm the report.',
          parameters: emptyParameters,
          needsApproval: true,
          execute,
        }),
      ],
    });
    const first = await watch(
      SDKRunner.run(agent, 'Confirm.', {
        context: undefined,
        approvals: 'manual',
        signal: callerSignal().signal,
      }),
    ).promise;
    if (!('status' in first)) throw new Error('Expected the actual held call');
    watch(first.completed);
    expect(execute).not.toHaveBeenCalled();
    expect(first.lastAgent).toBe(agent);
    first.approve(first.interruptions[0]);
    const result = await first.continue();
    expectTypeOf(result.finalOutput).toEqualTypeOf<{ approved: boolean }>();
    expect(result.finalOutput).toEqual({ approved: true });
    expect(result.lastAgent).toBe(agent);
    expect(execute).toHaveBeenCalledOnce();
    model.assertComplete();
  });

  it('holds the original SDK item, parses once on approval, and joins the guarded round trip', async () => {
    const session = new MemorySession();
    const order: string[] = [];
    const context = { account: 'original' };
    const parse = vi.fn((key: string) => key.trim());
    const parameters = z.object({ key: z.string().overwrite(parse) });
    const value = { label: 'record x' };
    const call = functionCall(
      'lookup',
      { key: ' x ' },
      { callId: 'approved-call', id: 'actual-sdk-approval-item' },
    );
    const finalGuardEntered = gate('approved final guard entry');
    const releaseFinalGuard = gate('approved final guard release');
    const inputVerdict = guardOutput.allow('actual tool input');
    const outputVerdict = guardOutput.allow('actual tool output');
    let observedContext: RunContext<typeof context> | undefined;
    const execute = vi.fn(
      (
        args: z.output<typeof parameters>,
        received?: RunContext<typeof context>,
      ) => {
        order.push('execute');
        expect(args).toEqual({ key: 'x' });
        observedContext = received;
        return value;
      },
    );
    const model = new ScriptedModel([
      modelResponder(() => {
        order.push('model call');
        return [call];
      }),
      modelResponder((received) => {
        order.push('model result');
        expect(execute).toHaveBeenCalledTimes(1);
        expect(received.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: call.callId,
            output: JSON.stringify(value),
          }),
        );
        return [assistantMessage('Done.', { id: 'approved-final-message' })];
      }),
    ]);
    const agent = new Agent<typeof context>({
      name: 'Original approval Agent',
      instructions: 'Use lookup and return text.',
      model,
      tools: [
        tool<typeof parameters, typeof context, typeof value>({
          name: 'lookup',
          description: 'Read one record.',
          parameters,
          needsApproval: true,
          execute,
          inputGuardrails: [
            { name: 'tool input', run: async () => inputVerdict },
          ],
          outputGuardrails: [
            { name: 'tool output', run: async () => outputVerdict },
          ],
        }),
      ],
    });
    const held = await pause(agent, context, {
      session,
      inputGuardrails: [
        { name: 'input', runInParallel: false, execute: async () => allowed },
      ],
      outputGuardrails: [
        {
          name: 'final output',
          execute: async (args) => {
            order.push('final guard');
            expect(args.agent).toBe(agent);
            expect(args.context).toBe(observedContext);
            expect(args.context.context).toBe(context);
            expect(args.agentOutput).toBe('Done.');
            expect(args.details?.output).toContainEqual(
              expect.objectContaining({
                type: 'function_call_result',
                callId: call.callId,
                output: { type: 'text', text: JSON.stringify(value) },
              }),
            );
            finalGuardEntered.release();
            await releaseFinalGuard.promise;
            return allowed;
          },
        },
      ],
    });
    const completion = watch(held.completed);
    const item = held.interruptions[0]!;
    expect(held.interruptions).toHaveLength(1);
    expect(item).toBeInstanceOf(RunToolApprovalItem);
    expect(item.agent).toBe(agent);
    expect(item.rawItem).toMatchObject({
      type: 'function_call',
      id: 'actual-sdk-approval-item',
      callId: call.callId,
      name: call.name,
      arguments: call.arguments,
    });
    expect(held.lastAgent).toBe(agent);
    expect(held.runContext.context).toBe(context);
    expect(held.native).toMatchObject({ callId: call.callId });
    expect(held.native.sessionId).toBeTruthy();
    expect(held.native.submissionId).toBeTruthy();
    expect(held.native.turnId).toBeTruthy();
    expect(held).not.toHaveProperty('state');
    expect(held).not.toHaveProperty('finalOutput');
    expect(held).not.toHaveProperty('history');
    expect(completion.settled).toBe(false);
    expect(await session.getItems()).toEqual([]);
    expect(model.calls).toHaveLength(1);
    expect(parse).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    held.approve(item);
    expect(execute).not.toHaveBeenCalled();
    const continued = held.continue();
    expect(held.continue()).toBe(continued);
    expect(continued).toBe(held.completed);
    await Promise.race([
      finalGuardEntered.promise,
      continued.then(
        () => {
          throw new Error('Completed before final guard entered');
        },
        (error: unknown) => {
          throw error;
        },
      ),
    ]);
    expect(completion.settled).toBe(false);
    expect(parse).toHaveBeenCalledTimes(1);
    releaseFinalGuard.release();
    const result = await continued;
    order.push('completed');
    expect(result.finalOutput).toBe('Done.');
    expect(result.lastAgent).toBe(agent);
    expect(result.runContext).toBe(held.runContext);
    expect(result.runContext).toBe(observedContext);
    expect(result.native.sessionId).toBe(held.native.sessionId);
    expect(result.native.turnId).toBe(held.native.turnId);
    expect(result.rawResponses[0]?.output).toContainEqual(item.rawItem);
    expect(result.newItems.map((entry) => entry.type)).toEqual([
      'tool_call_item',
      'tool_call_output_item',
      'message_output_item',
    ]);
    expect(result.newItems[1]).toMatchObject({
      agent,
      output: value,
      rawItem: { callId: call.callId, output: JSON.stringify(value) },
    });
    expect(result.inputGuardrailResults[0]?.output).toEqual(allowed);
    expect(result.outputGuardrailResults[0]?.output).toEqual(allowed);
    expect(result.toolInputGuardrailResults[0]?.output).toEqual(inputVerdict);
    expect(result.toolOutputGuardrailResults[0]?.output).toEqual(outputVerdict);
    expect(result.interruptions).toEqual([]);
    expect(await session.getItems()).toEqual(result.toInputList());
    // These are observable round-trip boundaries, not a claim about ACK scheduling.
    expect(order).toEqual([
      'model call',
      'execute',
      'model result',
      'final guard',
      'completed',
    ]);
    expect(model.calls).toHaveLength(2);
    expect(await held.continue()).toBe(result);
    await expect(result.completed).resolves.toBeUndefined();
    model.assertComplete();
  }, 15_000);

  it('rejects without a callback effect and delivers the actual refusal to the Model', async () => {
    const execute = vi.fn(() => 'must never become an effect result');
    const call = functionCall('lookup', '{}', { callId: 'rejected-call' });
    const model = new ScriptedModel([
      modelResponder(() => [call]),
      modelResponder((received) => {
        expect(execute).not.toHaveBeenCalled();
        expect(received.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: call.callId,
            output: refusal,
          }),
        );
        return [assistantMessage('Declined.')];
      }),
    ]);
    const agent = approvalAgent(model, execute);
    const held = await pause(agent, undefined);
    held.reject(held.interruptions[0]!);
    expect(model.calls).toHaveLength(1);
    const result = await held.continue();
    expect(result.finalOutput).toBe('Declined.');
    expect(result.newItems[1]).toMatchObject({
      agent,
      output: refusal,
      rawItem: { callId: call.callId, output: refusal },
    });
    expect(JSON.stringify(result.history)).not.toContain('must never');
    expect(result.toolInputGuardrailResults).toEqual([]);
    expect(result.toolOutputGuardrailResults).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
    expect(result.rawResponses).toHaveLength(2);
    await expect(result.completed).resolves.toBeUndefined();
    model.assertComplete();
  }, 15_000);

  it('binds choices to each live item and caches the original continuation', async () => {
    const execute = vi.fn(() => 'approved once');
    // Equal wire IDs in independent runs must not confer choice authority.
    const call = functionCall('lookup', '{}', { callId: 'shared-wire-id' });
    const firstModel = new ScriptedModel([
      modelResponder(() => [call]),
      modelResponder(() => [assistantMessage('First done.')]),
    ]);
    const secondModel = new ScriptedModel([
      modelResponder(() => [call]),
      modelResponder(() => [assistantMessage('Second declined.')]),
    ]);
    const first = await pause(approvalAgent(firstModel, execute), undefined);
    const second = await pause(approvalAgent(secondModel, execute), undefined);
    const firstItem = first.interruptions[0]!;
    const secondItem = second.interruptions[0]!;
    expect(first.native.sessionId).not.toBe(second.native.sessionId);
    expect(() => first.continue()).toThrow();
    expect(() => first.approve(secondItem)).toThrow();
    expect(() => second.reject(firstItem)).toThrow();
    expect(() =>
      first.approve({ ...firstItem } as RunToolApprovalItem),
    ).toThrow();
    first.approve(firstItem);
    expect(() => first.approve(firstItem)).toThrow();
    expect(() => first.reject(firstItem)).toThrow();
    second.reject(secondItem);
    expect(() => second.reject(secondItem)).toThrow();
    expect(execute).not.toHaveBeenCalled();
    const firstCompletion = first.continue();
    const secondCompletion = second.continue();
    expect(first.continue()).toBe(firstCompletion);
    expect(second.continue()).toBe(secondCompletion);
    expect(firstCompletion).toBe(first.completed);
    const [firstResult, secondResult] = await Promise.all([
      firstCompletion,
      secondCompletion,
    ]);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(firstResult.finalOutput).toBe('First done.');
    expect(secondResult.newItems[1]).toMatchObject({ output: refusal });
    expect(first.continue()).toBe(firstCompletion);
    expect(second.continue()).toBe(secondCompletion);
    expect(() => first.approve(firstItem)).toThrow();
    firstModel.assertComplete();
    secondModel.assertComplete();
  }, 15_000);

  it.each(['ephemeral', 'local'] as const)(
    'joins caller cancellation while held and expires the uncontinued choice in %s storage',
    async (mode) => {
      const execute = vi.fn(() => 'must not execute');
      const model = new ScriptedModel([
        modelResponder(() => [
          functionCall('lookup', '{}', { callId: 'held-abort' }),
        ]),
      ]);
      const controller = callerSignal();
      const path =
        mode === 'local'
          ? await mkdtemp(join(tmpdir(), 'held-local-cancellation-'))
          : undefined;
      if (path) profiles.push(path);
      const held = await pause(approvalAgent(model, execute), undefined, {
        signal: controller.signal,
        ...(path ? { storage: localStorage(path) } : {}),
      });
      const item = held.interruptions[0]!;
      const completion = watch(held.completed);
      held.approve(item);
      const reason = new Error('Caller stopped the held call');
      controller.abort(reason);
      await expect(completion.promise).rejects.toBe(reason);
      expect(completion.settled).toBe(true);
      expect(() => held.approve(item)).toThrow();
      expect(() => held.reject(item)).toThrow();
      expect(() => held.continue()).toThrow();
      expect(execute).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(1);
      model.assertComplete();
    },
    15_000,
  );

  it('joins an entered callback on abort and never accepts its late output', async () => {
    const entered = gate('callback entry');
    const aborted = gate('callback abort');
    const release = gate('physical callback release');
    let joined = false;
    const execute = vi.fn(
      async (
        _args: Record<string, never>,
        _context?: RunContext,
        details?: { signal?: AbortSignal },
      ) => {
        const signal = details?.signal;
        if (!signal) throw new Error('Expected the callback owner signal');
        signal.addEventListener('abort', aborted.release, { once: true });
        entered.release();
        try {
          await release.promise;
          return 'late output must not be accepted';
        } finally {
          signal.removeEventListener('abort', aborted.release);
          joined = true;
        }
      },
    );
    const model = new ScriptedModel([
      modelResponder(() => [
        functionCall('lookup', '{}', { callId: 'entered-abort' }),
      ]),
    ]);
    const agent = new Agent({
      name: 'Entered approval callback',
      model,
      tools: [
        tool({
          name: 'lookup',
          description: 'Wait.',
          parameters: emptyParameters,
          needsApproval: true,
          execute,
        }),
      ],
    });
    const controller = callerSignal();
    const held = await pause(agent, undefined, { signal: controller.signal });
    held.approve(held.interruptions[0]!);
    const completion = watch(held.continue());
    await entered.promise;
    const reason = new Error('Caller stopped entered work');
    controller.abort(reason);
    await aborted.promise;
    expect(joined).toBe(false);
    expect(completion.settled).toBe(false);
    release.release();
    const failure = await completion.promise.then(
      () => {
        throw new Error('Expected entered-work cancellation');
      },
      (error: unknown) => error,
    );
    expect(failure).toBe(reason);
    await expect(held.completed).rejects.toBe(reason);
    expect(joined).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
    expect(held).not.toHaveProperty('history');
    expect(held).not.toHaveProperty('finalOutput');
    model.assertComplete();
  }, 15_000);

  it('rejects a batch before either SDK callback can have an effect', async () => {
    const execute = vi.fn(() => 'must not execute');
    const model = new ScriptedModel([
      modelResponder(() => [
        functionCall('lookup', '{}', { callId: 'batch-first' }),
        functionCall('lookup', '{}', { callId: 'batch-second' }),
      ]),
    ]);
    const running = watch(
      SDKRunner.run(approvalAgent(model, execute), 'Input.', {
        context: undefined,
        approvals: 'manual',
        signal: callerSignal().signal,
      }),
    );
    await expect(running.promise).rejects.toThrow(/one function call/i);
    expect(execute).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
    model.assertComplete();
  }, 15_000);

  it('rejects a later call after one accepted effect without replaying that effect', async () => {
    const execute = vi.fn(() => 'one actual effect');
    const model = new ScriptedModel([
      modelResponder(() => [
        functionCall('lookup', '{}', { callId: 'first-effect' }),
      ]),
      modelResponder((received) => {
        expect(received.request.input).toContainEqual(
          expect.objectContaining({
            type: 'function_call_result',
            callId: 'first-effect',
            output: 'one actual effect',
          }),
        );
        return [functionCall('lookup', '{}', { callId: 'unsupported-repeat' })];
      }),
    ]);
    const held = await pause(approvalAgent(model, execute), undefined);
    held.approve(held.interruptions[0]!);
    const completion = held.continue();
    await expect(completion).rejects.toThrow(/one function call/i);
    expect(held.continue()).toBe(completion);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(2);
    expect(held).not.toHaveProperty('history');
    model.assertComplete();
  }, 15_000);
});
