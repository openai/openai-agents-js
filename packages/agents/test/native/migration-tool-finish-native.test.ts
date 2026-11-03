import { IncomingMessage, Server, ServerResponse } from 'node:http';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunToolCallOutputItem,
  ToolGuardrailFunctionOutputFactory as guardOutput,
  Usage,
  setTracingDisabled,
  tool,
  type FunctionToolResult,
  type ModelResponse,
  type RunContext,
} from '@openai/agents-core';
import { toSmartString } from '@openai/agents-core/utils';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelError,
  modelResponse,
} from '@openai/agents-core/testing';
import {
  SDKRunner,
  MigrationCleanupError,
  type MigrationRunResult,
} from '../../src/migration';
import { SelectedModelInvocation } from '../../src/migration/model';
import { NativeProvider } from '../../src/runtime/provider';
import {
  NativeError,
  Session,
  Turn,
  TurnAborted,
} from '../../src/runtime/session';
import type { SelectedModelTerminal } from '../../src/runtime/http-model';

setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());

type Context = { account: string };
const modes = ['response', 'stream'] as const;
const parameters = z.object({});
const allowed = { tripwireTriggered: false, outputInfo: 'checked' };

function fixture(
  value: unknown = { amount: 7, text: '{"still":"text"}' },
  continueModel = false,
) {
  const responses: ModelResponse[] = [
    {
      responseId: 'actual-tool-response',
      output: [functionCall('commit', '{}', { callId: 'actual-call' })],
      usage: new Usage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
    },
    ...(continueModel
      ? [
          {
            responseId: 'actual-final-response',
            output: [
              assistantMessage('Model finished.', { id: 'actual-message' }),
            ],
            usage: new Usage({
              inputTokens: 3,
              outputTokens: 1,
              totalTokens: 4,
            }),
          },
        ]
      : []),
  ];
  const model = new ScriptedModel(responses.map(modelResponse));
  const context: Context = { account: 'original' };
  const contexts: RunContext<Context>[] = [];
  const execute = vi.fn(
    (_args: Record<string, never>, received?: RunContext<Context>) => {
      if (!received) throw new Error('Expected the original RunContext');
      expect(received.context).toBe(context);
      contexts.push(received);
      return value;
    },
  );
  const action = tool<typeof parameters, Context, unknown>({
    name: 'commit',
    description: 'Commit one application effect.',
    parameters,
    execute,
  });
  const guard = vi.fn(async (_args: { agentOutput: string }) => allowed);
  const end = vi.fn();
  const agent = new Agent<Context>({
    name: 'Native tool finish',
    instructions: 'Use commit and return the selected result.',
    model,
    modelSettings: {},
    tools: [action],
    toolUseBehavior: 'stop_on_first_tool',
    outputGuardrails: [{ name: 'chosen output', execute: guard }],
  });
  agent.on('agent_end', end);
  return {
    agent,
    action,
    model,
    responses,
    context,
    contexts,
    execute,
    guard,
    end,
    value,
  };
}

type Fixture = ReturnType<typeof fixture>;

function finalPolicy() {
  return vi.fn(
    async (_context: RunContext, _results: FunctionToolResult[]) => ({
      isFinalOutput: true as const,
      isInterrupted: undefined,
      finalOutput: 'Policy finished.',
    }),
  );
}

function functionOutput(results: FunctionToolResult[]) {
  expect(results).toHaveLength(1);
  const result = results[0];
  if (result?.type !== 'function_output')
    throw new Error('Expected function output');
  return result;
}

function expectOneEffect(current: Fixture, mode: (typeof modes)[number]) {
  expect(current.execute).toHaveBeenCalledTimes(1);
  expect(current.model.calls).toHaveLength(1);
  expect(current.model.calls[0].streamed).toBe(mode === 'stream');
  current.model.assertComplete();
}

function expectToolFinish(
  current: Fixture,
  result: MigrationRunResult<Context>,
  text: string,
) {
  expect(result.finalOutput).toBe(text);
  expect(result.rawResponses).toEqual(current.responses);
  expect(result.modelResponses).toEqual(current.responses);
  expect(result.runContext).toBe(current.contexts[0]);
  expect(result.runContext.usage.totalTokens).toBe(3);
  expect(result.native.outcome).toEqual({
    type: 'turn_aborted',
    reason: 'interrupted',
  });
  expect(result.newItems.map((item) => item.type)).toEqual([
    'tool_call_item',
    'tool_call_output_item',
  ]);
  expect(result.newItems[1]).toBeInstanceOf(RunToolCallOutputItem);
  expect(result.newItems[1]).toMatchObject({
    agent: current.agent,
    output: current.value,
    rawItem: {
      type: 'function_call_result',
      name: 'commit',
      callId: 'actual-call',
    },
  });
  expect(current.guard).toHaveBeenCalledTimes(1);
  expect(current.guard.mock.calls[0][0].agentOutput).toBe(text);
  expect(current.end).toHaveBeenCalledExactlyOnceWith(result.runContext, text);
}

function observeSettlement<T>(promise: Promise<T>) {
  const observed = { promise, settled: false };
  void promise.then(
    () => {
      observed.settled = true;
    },
    () => {
      observed.settled = true;
    },
  );
  return observed;
}

function beforeCompletion<T>(promise: Promise<T>, completed: Promise<unknown>) {
  return Promise.race([
    promise,
    completed.then(() => {
      throw new Error('Stream completed before the expected gated phase');
    }),
  ]);
}

function streamDeadline(release: () => void) {
  const controller = new AbortController();
  const expired = Promise.withResolvers<never>();
  void expired.promise.catch(() => {});
  const timer = setTimeout(() => {
    const error = new Error('Stream tool-finish probe deadline');
    controller.abort(error);
    release();
    expired.reject(error);
  }, 20_000);
  return {
    signal: controller.signal,
    wait<T>(promise: Promise<T>) {
      return Promise.race([promise, expired.promise]);
    },
    dispose() {
      clearTimeout(timer);
      controller.abort(new Error('Stream tool-finish probe cleanup'));
      release();
    },
  };
}

function observeStreamCleanup() {
  const events: string[] = [];
  const closeSession = Session.prototype.close;
  const join = SelectedModelInvocation.prototype.join;
  const closeProvider = NativeProvider.prototype.close;
  vi.spyOn(Session.prototype, 'close').mockImplementation(async function (
    this: Session,
  ) {
    await closeSession.call(this);
    events.push('session closed');
  });
  vi.spyOn(SelectedModelInvocation.prototype, 'join').mockImplementation(
    async function (this: SelectedModelInvocation) {
      await join.call(this);
      events.push('producer joined');
    },
  );
  vi.spyOn(NativeProvider.prototype, 'close').mockImplementation(
    async function (this: NativeProvider) {
      await closeProvider.call(this);
      events.push('provider closed');
    },
  );
  return events;
}

function expectStreamCleanup(events: string[]) {
  expect(events).toEqual(
    expect.arrayContaining([
      'session closed',
      'producer joined',
      'provider closed',
    ]),
  );
}

describe('migration tool finish on the actual native loop', () => {
  it('retries a safe Model failure once before an acknowledged tool finish', async () => {
    const current = fixture();
    const failure = new Error('Safely retry the selected tool request');
    current.model = new ScriptedModel([
      modelError(failure, { replaySafety: 'safe' }),
      modelResponse(current.responses[0]),
    ]);
    current.agent.model = current.model;
    const instructions = vi.fn(
      async (context: RunContext<Context>, originalAgent: Agent<Context>) => {
        expect(context.context).toBe(current.context);
        expect(originalAgent).toBe(current.agent);
        return 'Commit once after a safe retry.';
      },
    );
    current.agent.instructions = instructions;
    const policy = vi.fn(() => ({ retry: true, delayMs: 0 }));
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Retry tool-finish deadline')),
      20_000,
    );
    let running: Promise<MigrationRunResult<Context>> | undefined;
    try {
      running = SDKRunner.run(current.agent, 'Commit once.', {
        context: current.context,
        modelInvocation: 'response',
        modelSettings: { retry: { maxRetries: 1, policy } },
        signal: controller.signal,
      });
      const result = await running;
      expect(policy).toHaveBeenCalledTimes(1);
      expect(current.model.calls).toHaveLength(2);
      expect(current.model.calls[0].streamed).toBe(false);
      expect(current.model.calls[1].streamed).toBe(false);
      expect(instructions).toHaveBeenCalledExactlyOnceWith(
        result.runContext,
        current.agent,
      );
      expect(current.model.calls[0].request.systemInstructions).toBe(
        'Commit once after a safe retry.',
      );
      expect(current.model.calls[1].request.systemInstructions).toBe(
        'Commit once after a safe retry.',
      );
      expect(current.execute).toHaveBeenCalledTimes(1);
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(accepted.mock.calls[0][2].success).toBe(true);
      expect(result.modelResponses).toHaveLength(1);
      const retriedUsage = Usage.fromJSON({
        ...current.responses[0].usage,
        requests: 2,
        requestUsageEntries: [
          { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
        ],
      });
      expect(result.runContext.usage.requests).toBe(2);
      expect(result.rawResponses[0].usage.requestUsageEntries).toHaveLength(2);
      expectToolFinish(
        {
          ...current,
          responses: [{ ...current.responses[0], usage: retriedUsage }],
        },
        result,
        toSmartString(current.value),
      );
      expect(result.newItems[0].rawItem).toEqual(
        current.responses[0].output[0],
      );
      expect(result.newItems[1].rawItem).toMatchObject({
        output: toSmartString(current.value),
      });
      current.model.assertComplete();
    } finally {
      clearTimeout(timer);
      controller.abort(new Error('Retry tool-finish cleanup'));
      await running?.catch(() => {});
      accepted.mockRestore();
    }
  }, 30_000);

  it.each(modes)(
    'stores true-ACK tool facts after a %s policy finish with loaded Session history',
    async (mode) => {
      const signal = AbortSignal.timeout(20_000);
      const store = new MemorySession();
      await store.addItems([
        { type: 'message', role: 'user', content: 'Earlier input.' },
        assistantMessage('Earlier answer.'),
      ]);
      const retained = await store.getItems();
      const current = fixture();
      const instructions = vi.fn(
        async (context: RunContext<Context>, agent: Agent<Context>) => {
          expect(context.context).toBe(current.context);
          expect(agent).toBe(current.agent);
          return 'Trusted instructions after Session input preparation.';
        },
      );
      current.agent.instructions = instructions;
      const result = await SDKRunner.run(current.agent, 'Commit once.', {
        context: current.context,
        modelInvocation: mode,
        session: store,
        signal,
      });
      expectOneEffect(current, mode);
      expectToolFinish(current, result, toSmartString(current.value));
      expect(instructions).toHaveBeenCalledTimes(1);
      expect(current.model.calls[0].request.systemInstructions).toBe(
        'Trusted instructions after Session input preparation.',
      );
      expect(current.model.calls[0].request.input).toEqual([
        ...retained,
        { type: 'message', role: 'user', content: 'Commit once.' },
      ]);
      expect(result.newItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'tool_call_output_item',
      ]);
      expect(await store.getItems()).toEqual(result.toInputList());
      expect(
        (await store.getItems()).filter(
          (item) => item.type === 'message' && item.role === 'assistant',
        ),
      ).toEqual([retained[1]]);
      const saved = await store.getItems();
      const followup = new ScriptedModel([
        modelResponse([assistantMessage('History continued.')]),
      ]);
      current.agent.model = followup;
      const continued = await SDKRunner.run(
        current.agent,
        'Continue without committing.',
        {
          context: current.context,
          modelInvocation: mode,
          session: store,
          signal,
        },
      );
      expect(continued.finalOutput).toBe('History continued.');
      expect(followup.calls).toHaveLength(1);
      expect(followup.calls[0].request.input).toEqual([
        ...saved,
        {
          type: 'message',
          role: 'user',
          content: 'Continue without committing.',
        },
      ]);
      expect(current.execute).toHaveBeenCalledTimes(1);
      expect(await store.getItems()).toEqual(continued.toInputList());
      followup.assertComplete();
    },
    30_000,
  );

  it.each(
    modes.flatMap((mode) =>
      (['first', 'named', 'callable'] as const).map((behavior) => ({
        mode,
        behavior,
      })),
    ),
  )(
    'finishes $behavior without another selected Model call in $mode mode',
    async ({ mode, behavior }) => {
      const current = fixture();
      const checked = vi.spyOn(SelectedModelInvocation.prototype, 'toolValue');
      const accepted = vi.spyOn(
        SelectedModelInvocation.prototype,
        'toolResult',
      );
      const terminals: SelectedModelTerminal[] = [];
      const terminal = SelectedModelInvocation.prototype.terminal;
      vi.spyOn(
        SelectedModelInvocation.prototype,
        'terminal',
      ).mockImplementation(function (this: SelectedModelInvocation, event) {
        terminals.push(event);
        terminal.call(this, event);
      });
      const policy = vi.fn(
        async (context: RunContext, results: FunctionToolResult[]) => {
          expect(context).toBe(current.contexts[0]);
          expect(context.context).toBe(current.context);
          expect(accepted).toHaveBeenCalledTimes(1);
          const result = functionOutput(results);
          expect(result).not.toHaveProperty('toolCall');
          expect(result.tool).toBe(current.action);
          expect(result.output).toEqual(current.value);
          expect(result.output).not.toBe(current.value);
          const snapshot = checked.mock.results[0];
          if (snapshot.type !== 'return')
            throw new Error('Expected a checked JSON snapshot');
          expect(result.output).toBe(snapshot.value);
          expect(result.runItem).toBeInstanceOf(RunToolCallOutputItem);
          expect(result.runItem.output).toBe(result.output);
          expect(result.runItem.agent).toBe(current.agent);
          expect(result.runItem.rawItem).toMatchObject({
            name: 'commit',
            callId: 'actual-call',
          });
          return {
            isFinalOutput: true as const,
            isInterrupted: undefined,
            finalOutput: `Policy:${toSmartString(result.output)}`,
          };
        },
      );
      current.agent.toolUseBehavior =
        behavior === 'callable'
          ? policy
          : behavior === 'named'
            ? { stopAtToolNames: ['not_called', 'commit'] }
            : 'stop_on_first_tool';
      try {
        const result = await SDKRunner.run(current.agent, 'Commit once.', {
          context: current.context,
          signal: AbortSignal.timeout(20_000),
          modelInvocation: mode,
        });
        expectOneEffect(current, mode);
        expect(accepted).toHaveBeenCalledTimes(1);
        expect(policy).toHaveBeenCalledTimes(behavior === 'callable' ? 1 : 0);
        expectToolFinish(
          current,
          result,
          `${behavior === 'callable' ? 'Policy:' : ''}${toSmartString(current.value)}`,
        );
        expect(terminals).toHaveLength(1);
        expect(terminals[0]).toMatchObject({
          turnId: result.native.turnId,
          kind: 'turn_aborted',
          reason: 'interrupted',
        });
        expect(terminals[0].error).toBeInstanceOf(TurnAborted);
        expect(terminals[0].nativeError == null).toBe(true);
        expect(terminals[0].nativeFailure == null).toBe(true);
        expect(terminals[0].priorFailure).toBe(terminals[0].error);
      } finally {
        vi.restoreAllMocks();
      }
    },
    30_000,
  );

  it.each(modes)(
    'continues a callable policy through a real second %s Model response',
    async (mode) => {
      const current = fixture(undefined, true);
      const policy = vi.fn(
        async (_context: RunContext, results: FunctionToolResult[]) => {
          expect(functionOutput(results).output).toEqual(current.value);
          return { isFinalOutput: false as const, isInterrupted: undefined };
        },
      );
      current.agent.toolUseBehavior = policy;
      const result = await SDKRunner.run(
        current.agent,
        'Commit then continue.',
        {
          context: current.context,
          signal: AbortSignal.timeout(20_000),
          modelInvocation: mode,
        },
      );
      expect(policy).toHaveBeenCalledTimes(1);
      expect(current.execute).toHaveBeenCalledTimes(1);
      expect(current.model.calls.map((call) => call.streamed)).toEqual([
        mode === 'stream',
        mode === 'stream',
      ]);
      expect(current.model.calls[1].request.input).toContainEqual(
        expect.objectContaining({
          type: 'function_call_result',
          callId: 'actual-call',
          output: JSON.stringify(current.value),
        }),
      );
      expect(result.finalOutput).toBe('Model finished.');
      expect(result.rawResponses).toEqual(current.responses);
      expect(result.newItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'tool_call_output_item',
        'message_output_item',
      ]);
      expect(current.guard).toHaveBeenCalledTimes(1);
      expect(current.guard.mock.calls[0][0].agentOutput).toBe(
        'Model finished.',
      );
      expect(current.end).toHaveBeenCalledExactlyOnceWith(
        result.runContext,
        'Model finished.',
      );
      current.model.assertComplete();
    },
    30_000,
  );

  it('joins a caller-aborted policy after a true ACK without publishing its late decision', async () => {
    const current = fixture();
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const reason = new Error('Caller cancelled after admission');
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
    const policy = vi.fn(async () => {
      entered.resolve();
      await release.promise;
      return {
        isFinalOutput: true as const,
        isInterrupted: undefined,
        finalOutput: 'Too late.',
      };
    });
    current.agent.toolUseBehavior = policy;
    let settled = false;
    const running = SDKRunner.run(current.agent, 'Commit once.', {
      context: current.context,
      signal: controller.signal,
    });
    const outcome = running.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    const timer = setTimeout(() => {
      controller.abort(new Error('Policy gate deadline'));
      release.resolve();
    }, 20_000);
    try {
      await Promise.race([
        entered.promise,
        outcome.then(() => {
          throw new Error('Run ended before policy entry');
        }),
      ]);
      expect(accepted).toHaveBeenCalledTimes(1);
      controller.abort(reason);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(settled).toBe(false);
      expect(current.guard).not.toHaveBeenCalled();
      expect(current.end).not.toHaveBeenCalled();
      release.resolve();
      await expect(running).rejects.toBe(reason);
      expectOneEffect(current, 'response');
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(policy).toHaveBeenCalledTimes(1);
      expect(current.guard).not.toHaveBeenCalled();
      expect(current.end).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      controller.abort(reason);
      release.resolve();
      await outcome;
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('preserves a real native HTTP failure after finish intent instead of publishing success', async () => {
    const current = fixture();
    const policy = finalPolicy();
    current.agent.toolUseBehavior = policy;
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
    const emit = Server.prototype.emit;
    const cancel = Turn.prototype.cancel;
    const controller = new AbortController();
    let requests = 0;
    let carrier: ServerResponse | undefined;
    let actualFailure: unknown;
    let injected = false;
    vi.spyOn(Server.prototype, 'emit').mockImplementation(function (
      this: Server,
      event: string | symbol,
      ...args: unknown[]
    ): boolean {
      if (
        event === 'request' &&
        args[0] instanceof IncomingMessage &&
        args[1] instanceof ServerResponse &&
        /^\/p-[A-Za-z0-9_-]+\/responses$/.test(args[0].url ?? '')
      ) {
        requests++;
        if (requests === 2) carrier = args[1];
      }
      return Reflect.apply(emit, this, [event, ...args]);
    });
    vi.spyOn(Turn.prototype, 'cancel').mockImplementation(async function (
      this: Turn,
      ...args: Parameters<Turn['cancel']>
    ) {
      if (!injected) {
        injected = true;
        expect(policy).toHaveBeenCalledTimes(1);
        expect(accepted).toHaveBeenCalledTimes(1);
        if (!carrier)
          throw new Error('Expected the real second selected carrier');
        carrier.writeHead(503).end('bounded transport failure');
        try {
          await this.wait();
        } catch (error) {
          actualFailure = error;
        }
      }
      return cancel.apply(this, args);
    });
    const running = SDKRunner.run(current.agent, 'Commit once.', {
      context: current.context,
      signal: controller.signal,
    });
    const outcome = running.then(
      (value) => value,
      (error: unknown) => error,
    );
    const timer = setTimeout(
      () => controller.abort(new Error('Native failure deadline')),
      20_000,
    );
    try {
      const failure = await outcome;
      expect(injected).toBe(true);
      expect(requests).toBe(2);
      expect(actualFailure).toBeInstanceOf(NativeError);
      expect(actualFailure).not.toBeInstanceOf(TurnAborted);
      expect(failure).toBe(actualFailure);
      expectOneEffect(current, 'response');
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(policy).toHaveBeenCalledTimes(1);
      expect(current.guard).not.toHaveBeenCalled();
      expect(current.end).not.toHaveBeenCalled();
    } finally {
      clearTimeout(timer);
      controller.abort(new Error('Native failure probe cleanup'));
      if (carrier && !carrier.writableEnded) carrier.end();
      await outcome;
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('withholds a non-JSON tool value from native ACK and finish policy', async () => {
    const current = fixture(1n);
    const policy = finalPolicy();
    current.agent.toolUseBehavior = policy;
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
    try {
      await expect(
        SDKRunner.run(current.agent, 'Commit once.', {
          context: current.context,
          signal: AbortSignal.timeout(20_000),
        }),
      ).rejects.toBeInstanceOf(z.ZodError);
      expectOneEffect(current, 'response');
      expect(accepted).not.toHaveBeenCalled();
      expect(policy).not.toHaveBeenCalled();
      expect(current.guard).not.toHaveBeenCalled();
      expect(current.end).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('physically closes Session and provider before a chosen-output tripwire and never emits end', async () => {
    const current = fixture();
    const store = new MemorySession();
    const append = vi.spyOn(store, 'addItems');
    const events: string[] = [];
    const closeSession = Session.prototype.close;
    const closeProvider = NativeProvider.prototype.close;
    vi.spyOn(Session.prototype, 'close').mockImplementation(async function (
      this: Session,
    ) {
      await closeSession.call(this);
      events.push('session closed');
    });
    vi.spyOn(NativeProvider.prototype, 'close').mockImplementation(
      async function (this: NativeProvider) {
        await closeProvider.call(this);
        events.push('provider closed');
      },
    );
    const guard = vi.fn(async ({ agentOutput }: { agentOutput: string }) => {
      expect(agentOutput).toBe(toSmartString(current.value));
      expect(events).toContain('session closed');
      expect(events).toContain('provider closed');
      events.push('guard');
      return { tripwireTriggered: true, outputInfo: 'blocked selected value' };
    });
    current.agent.outputGuardrails = [
      { name: 'block chosen output', execute: guard },
    ];
    try {
      await expect(
        SDKRunner.run(current.agent, 'Commit once.', {
          context: current.context,
          session: store,
          signal: AbortSignal.timeout(20_000),
        }),
      ).rejects.toBeInstanceOf(OutputGuardrailTripwireTriggered);
      expectOneEffect(current, 'response');
      expect(guard).toHaveBeenCalledTimes(1);
      expect(events.indexOf('guard')).toBeGreaterThan(
        events.indexOf('provider closed'),
      );
      expect(current.end).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(await store.getItems()).toEqual([]);
    } finally {
      vi.restoreAllMocks();
    }
  }, 30_000);

  it('retains cleanup retry without publishing or replaying a tool-derived finish', async () => {
    const current = fixture();
    const close = Session.prototype.close;
    const cleanupFailure = new Error(
      'Session close failed after physical close',
    );
    let attempts = 0;
    let failure: unknown;
    vi.spyOn(Session.prototype, 'close').mockImplementation(async function (
      this: Session,
    ) {
      await close.call(this);
      if (++attempts === 1) throw cleanupFailure;
    });
    try {
      try {
        await SDKRunner.run(current.agent, 'Commit once.', {
          context: current.context,
          signal: AbortSignal.timeout(20_000),
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(MigrationCleanupError);
      if (!(failure instanceof MigrationCleanupError))
        throw new Error('Expected owned cleanup retry');
      expect(failure.errors).toContain(cleanupFailure);
      expect(current.guard).not.toHaveBeenCalled();
      expect(current.end).not.toHaveBeenCalled();
      await failure.retryCleanup();
      await failure.retryCleanup();
      expect(attempts).toBe(2);
      expectOneEffect(current, 'response');
      expect(current.guard).not.toHaveBeenCalled();
      expect(current.end).not.toHaveBeenCalled();
    } finally {
      try {
        if (failure instanceof MigrationCleanupError)
          await failure.retryCleanup();
      } finally {
        vi.restoreAllMocks();
      }
    }
  }, 30_000);

  it('keeps accepted facade observations unchanged when a callable mutates its policy value', async () => {
    const current = fixture();
    const policy = vi.fn(
      async (_context: RunContext, results: FunctionToolResult[]) => {
        const result = functionOutput(results);
        expect(result.output).toEqual(current.value);
        expect(result.runItem.output).toBe(result.output);
        if (!result.output || typeof result.output !== 'object')
          throw new Error('Expected object snapshot');
        Object.assign(result.output, { amount: 99 });
        return {
          isFinalOutput: true as const,
          isInterrupted: undefined,
          finalOutput: 'Policy mutated its copy.',
        };
      },
    );
    current.agent.toolUseBehavior = policy;
    const result = await SDKRunner.run(current.agent, 'Commit once.', {
      context: current.context,
      signal: AbortSignal.timeout(20_000),
    });
    expectOneEffect(current, 'response');
    expect(policy).toHaveBeenCalledTimes(1);
    expectToolFinish(current, result, 'Policy mutated its copy.');
    expect(result.newItems[1]).toMatchObject({ output: { amount: 7 } });
  }, 30_000);

  it('finishes from the actual guard-replaced string without parsing it as a wire object', async () => {
    const current = fixture();
    const replacement = '{"checked":"replacement"}';
    current.action.outputGuardrails = [
      {
        name: 'replace checked tool result',
        type: 'tool_output',
        run: async () => guardOutput.rejectContent(replacement),
      },
    ];
    const policy = vi.fn(
      async (_context: RunContext, results: FunctionToolResult[]) => {
        const result = functionOutput(results);
        expect(result.output).toBe(replacement);
        expect(result.runItem.output).toBe(replacement);
        return {
          isFinalOutput: true as const,
          isInterrupted: undefined,
          finalOutput: toSmartString(result.output),
        };
      },
    );
    current.agent.toolUseBehavior = policy;
    const result = await SDKRunner.run(current.agent, 'Commit once.', {
      context: current.context,
      signal: AbortSignal.timeout(20_000),
    });
    expectOneEffect(current, 'response');
    expect(policy).toHaveBeenCalledTimes(1);
    expect(result.finalOutput).toBe(replacement);
    expect(result.native.outcome).toEqual({
      type: 'turn_aborted',
      reason: 'interrupted',
    });
    expect(result.newItems.map((item) => item.type)).toEqual([
      'tool_call_item',
      'tool_call_output_item',
    ]);
    expect(result.newItems[1]).toMatchObject({
      output: replacement,
      rawItem: { output: replacement },
    });
    expect(result.rawResponses).toEqual(current.responses);
    expect(current.guard).toHaveBeenCalledTimes(1);
    expect(current.guard.mock.calls[0][0].agentOutput).toBe(replacement);
    expect(current.end).toHaveBeenCalledExactlyOnceWith(
      result.runContext,
      replacement,
    );
  }, 30_000);
  it('joins delayed ACK observations in a two-call batch', async () => {
    const trace: string[] = [];
    const context: Context = { account: 'original' };
    const firstValue = { effect: 'first' };
    const secondValue = { effect: 'second' };
    const firstCaptured = Promise.withResolvers<void>();
    const secondObserved = Promise.withResolvers<void>();
    const nextCurrentVerified = Promise.withResolvers<void>();
    let originalContext: RunContext<Context> | undefined;
    const firstExecute = vi.fn(
      (_args: Record<string, never>, received?: RunContext<Context>) => {
        expect(received?.context).toBe(context);
        originalContext ??= received;
        expect(received).toBe(originalContext);
        trace.push('first callback');
        return firstValue;
      },
    );
    const secondExecute = vi.fn(
      (_args: Record<string, never>, received?: RunContext<Context>) => {
        expect(received?.context).toBe(context);
        originalContext ??= received;
        expect(received).toBe(originalContext);
        trace.push('second callback');
        return secondValue;
      },
    );
    const firstTool = tool<typeof parameters, Context, typeof firstValue>({
      name: 'first',
      description: 'Record the first effect.',
      parameters,
      execute: firstExecute,
    });
    const secondTool = tool<typeof parameters, Context, typeof secondValue>({
      name: 'second',
      description: 'Record the second effect.',
      parameters,
      execute: secondExecute,
    });
    const response: ModelResponse = {
      responseId: 'actual-two-call-response',
      output: [
        functionCall('first', '{}', { callId: 'actual-first' }),
        functionCall('second', '{}', { callId: 'actual-second' }),
      ],
      usage: new Usage({ inputTokens: 2, outputTokens: 2, totalTokens: 4 }),
    };
    const model = new ScriptedModel([modelResponse(response)]);
    const acknowledgments: string[] = [];
    const observations: string[] = [];
    let deferredFirst: (() => void) | undefined;
    let firstObserverCommits = 0;
    const releaseFirst = () => {
      const observe = deferredFirst;
      deferredFirst = undefined;
      observe?.();
    };
    const observe = SelectedModelInvocation.prototype.toolResult;
    const produce = SelectedModelInvocation.prototype.produce;
    vi.spyOn(
      SelectedModelInvocation.prototype,
      'toolResult',
    ).mockImplementation(function (
      this: SelectedModelInvocation,
      ...args: Parameters<SelectedModelInvocation['toolResult']>
    ) {
      // Session invokes this observer only after the real native reply returns true.
      expect(args[2].success).toBe(true);
      acknowledgments.push(args[1]);
      if (acknowledgments.length === 1) {
        expect(deferredFirst).toBeUndefined();
        deferredFirst = () => {
          observe.apply(this, args);
          firstObserverCommits++;
          observations.push(args[1]);
        };
        firstCaptured.resolve();
        return;
      }
      expect(acknowledgments).toHaveLength(2);
      observe.apply(this, args);
      observations.push(args[1]);
      secondObserved.resolve();
    });
    vi.spyOn(SelectedModelInvocation.prototype, 'produce').mockImplementation(
      function (
        this: SelectedModelInvocation,
        ...args: Parameters<SelectedModelInvocation['produce']>
      ) {
        trace.push('produce responses=' + this.responses.length);
        if (this.responses.length === 1) {
          const current = args[2];
          args[2] = async () => {
            trace.push('next current begin');
            await current();
            trace.push('next current verified');
            nextCurrentVerified.resolve();
          };
        }
        return produce.apply(this, args);
      },
    );
    const policy = vi.fn(
      async (received: RunContext, results: FunctionToolResult[]) => {
        expect(received).toBe(originalContext);
        expect(received.context).toBe(context);
        expect(results).toHaveLength(2);
        expect(results[0].tool).toBe(firstTool);
        expect(results[1].tool).toBe(secondTool);
        expect(results.map((result) => result.runItem.rawItem)).toMatchObject([
          { callId: 'actual-first', name: 'first' },
          { callId: 'actual-second', name: 'second' },
        ]);
        expect(
          results.map((result) => {
            if (result.type !== 'function_output')
              throw new Error('Expected acknowledged function output');
            expect(result.runItem.output).toBe(result.output);
            return result.output;
          }),
        ).toEqual([firstValue, secondValue]);
        return {
          isFinalOutput: true as const,
          isInterrupted: undefined,
          finalOutput: 'Both accepted.',
        };
      },
    );
    const guard = vi.fn(async (_args: { agentOutput: string }) => allowed);
    const end = vi.fn();
    const agent = new Agent<Context>({
      name: 'Delayed ACK observations',
      instructions: 'Use both functions.',
      model,
      modelSettings: {},
      tools: [firstTool, secondTool],
      toolUseBehavior: policy,
      outputGuardrails: [{ name: 'selected batch output', execute: guard }],
    });
    agent.on('agent_end', end);
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(20_000),
    ]);
    const cancelled = Promise.withResolvers<never>();
    const onAbort = () => cancelled.reject(signal.reason);
    signal.addEventListener('abort', onAbort, { once: true });
    void cancelled.promise.catch(() => {});
    const running = SDKRunner.run(agent, 'Commit both effects.', {
      context,
      signal,
    });
    const outcome = running.then(
      () => ({ type: 'completed' as const }),
      (error: unknown) => ({ type: 'error' as const, error }),
    );
    const waitFor = <T>(gate: Promise<T>) =>
      Promise.race([
        gate,
        cancelled.promise,
        outcome.then((settled) => {
          if (settled.type === 'error') throw settled.error;
          throw new Error('Run ended before the observation gate');
        }),
      ]);
    try {
      await waitFor(firstCaptured.promise);
      expect(policy).not.toHaveBeenCalled();
      await waitFor(
        Promise.all([secondObserved.promise, nextCurrentVerified.promise]),
      );
      await waitFor(new Promise<void>((resolve) => setImmediate(resolve)));
      expect(acknowledgments).toHaveLength(2);
      expect(new Set(acknowledgments)).toEqual(new Set(['first', 'second']));
      expect(observations).toEqual([acknowledgments[1]]);
      expect(firstObserverCommits).toBe(0);
      expect(policy).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(1);
      releaseFirst();
      const result = await Promise.race([running, cancelled.promise]);
      expect(firstObserverCommits).toBe(1);
      expect(observations).toEqual([acknowledgments[1], acknowledgments[0]]);
      expect(policy).toHaveBeenCalledTimes(1);
      expect(firstExecute).toHaveBeenCalledTimes(1);
      expect(secondExecute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(result.rawResponses).toEqual([response]);
      expect(result.finalOutput).toBe('Both accepted.');
      expect(result.native.outcome).toEqual({
        type: 'turn_aborted',
        reason: 'interrupted',
      });
      expect(result.newItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'tool_call_item',
        'tool_call_output_item',
        'tool_call_output_item',
      ]);
      expect(guard).toHaveBeenCalledTimes(1);
      expect(guard.mock.calls[0][0].agentOutput).toBe('Both accepted.');
      expect(end).toHaveBeenCalledExactlyOnceWith(
        result.runContext,
        'Both accepted.',
      );
      model.assertComplete();
    } catch (error) {
      throw new Error(
        'Batch observation gates: ' +
          JSON.stringify({
            trace,
            acknowledgments,
            observations,
            firstObserverCommits,
            calls: model.calls.length,
          }),
        { cause: error },
      );
    } finally {
      controller.abort(new Error('Delayed observation probe cleanup'));
      try {
        releaseFirst();
      } finally {
        await outcome;
        signal.removeEventListener('abort', onAbort);
        vi.restoreAllMocks();
      }
    }
  }, 30_000);

  it('publishes streamed tool-policy semantics only after cleanup, guards and agent_end, with actual raw EOF', async () => {
    const current = fixture();
    const events = observeStreamCleanup();
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
    const guardEntered = Promise.withResolvers<void>();
    const releaseGuard = Promise.withResolvers<void>();
    const deadline = streamDeadline(() => releaseGuard.resolve());
    current.guard.mockImplementation(async ({ agentOutput }) => {
      expect(agentOutput).toBe(toSmartString(current.value));
      expect(accepted).toHaveBeenCalledExactlyOnceWith(
        'actual-call',
        'commit',
        expect.anything(),
      );
      expectStreamCleanup(events);
      guardEntered.resolve();
      await releaseGuard.promise;
      return allowed;
    });
    let completed: Promise<unknown> | undefined;
    try {
      const starting = SDKRunner.stream(current.agent, 'Commit once.', {
        context: current.context,
        signal: deadline.signal,
      });
      completed = starting.then((live) => live.completed);
      void completed.catch(() => {});
      const live = await deadline.wait(starting);
      const completion = observeSettlement(live.completed);
      const reader = live.toStream().getReader();
      const firstSemantic = observeSettlement(
        reader.read().then((event) => {
          expectStreamCleanup(events);
          expect(current.end).toHaveBeenCalledTimes(1);
          return event;
        }),
      );
      const raw = live.unvalidatedRaw.getReader();
      await deadline.wait(
        beforeCompletion(guardEntered.promise, live.completed),
      );
      expect(completion.settled).toBe(false);
      expect(firstSemantic.settled).toBe(false);
      expect(current.end).not.toHaveBeenCalled();
      expect(
        (await deadline.wait(beforeCompletion(raw.read(), live.completed)))
          .value?.data,
      ).toEqual({ type: 'response_started' });
      expect(
        (await deadline.wait(beforeCompletion(raw.read(), live.completed)))
          .value?.data,
      ).toMatchObject({
        type: 'response_done',
        response: {
          id: current.responses[0].responseId,
          output: current.responses[0].output,
        },
      });
      const rawEOF = observeSettlement(raw.read());
      expect(rawEOF.settled).toBe(false);
      releaseGuard.resolve();
      const result = await deadline.wait(live.completed);
      expectOneEffect(current, 'stream');
      expectToolFinish(current, result, toSmartString(current.value));
      expect(await deadline.wait(firstSemantic.promise)).toMatchObject({
        done: false,
        value: { name: 'tool_called', item: result.newItems[0] },
      });
      const output = await deadline.wait(reader.read());
      expect(output).toMatchObject({
        done: false,
        value: { name: 'tool_output' },
      });
      if (output.value?.type !== 'run_item_stream_event')
        throw new Error('Expected the accepted tool output event.');
      expect(output.value.item).toBe(result.newItems[1]);
      expect(await deadline.wait(reader.read())).toEqual({
        done: true,
        value: undefined,
      });
      // The policy value is not a fabricated Model message or raw terminal frame.
      expect(await deadline.wait(rawEOF.promise)).toEqual({
        done: true,
        value: undefined,
      });
    } finally {
      deadline.dispose();
      await completed?.then(
        () => {},
        () => {},
      );
    }
  }, 30_000);

  it('joins a gated post-ACK finish policy after semantic-reader cancellation without accepted publication', async () => {
    const current = fixture();
    const events = observeStreamCleanup();
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
    const entered = Promise.withResolvers<void>();
    const releasePolicy = Promise.withResolvers<void>();
    const deadline = streamDeadline(() => releasePolicy.resolve());
    const reason = new Error('Semantic consumer stopped after ACK');
    const policy = vi.fn(
      async (context: RunContext, results: FunctionToolResult[]) => {
        expect(context).toBe(current.contexts[0]);
        expect(functionOutput(results).tool).toBe(current.action);
        expect(functionOutput(results).output).toEqual(current.value);
        expect(accepted).toHaveBeenCalledExactlyOnceWith(
          'actual-call',
          'commit',
          expect.anything(),
        );
        entered.resolve();
        await releasePolicy.promise;
        return {
          isFinalOutput: true as const,
          isInterrupted: undefined,
          finalOutput: 'Too late.',
        };
      },
    );
    current.agent.toolUseBehavior = policy;
    let completed: Promise<unknown> | undefined;
    try {
      const starting = SDKRunner.stream(current.agent, 'Commit once.', {
        context: current.context,
        signal: deadline.signal,
      });
      completed = starting.then((live) => live.completed);
      void completed.catch(() => {});
      const live = await deadline.wait(starting);
      const completion = observeSettlement(
        live.completed.catch((error: unknown) => {
          expectStreamCleanup(events);
          throw error;
        }),
      );
      const reader = live.toStream().getReader();
      const first = observeSettlement(reader.read());
      const independentSemantics = observeSettlement(Array.fromAsync(live));
      await deadline.wait(beforeCompletion(entered.promise, live.completed));
      await deadline.wait(
        beforeCompletion(reader.cancel(reason), live.completed),
      );
      expect(await deadline.wait(first.promise)).toEqual({
        done: true,
        value: undefined,
      });
      await deadline.wait(
        new Promise<void>((resolve) => setImmediate(resolve)),
      );
      expect(completion.settled).toBe(false);
      expect(independentSemantics.settled).toBe(false);
      expect(events).not.toContain('producer joined');
      expect(events).not.toContain('provider closed');
      expect(current.guard).not.toHaveBeenCalled();
      expect(current.end).not.toHaveBeenCalled();
      releasePolicy.resolve();
      await expect(deadline.wait(completion.promise)).rejects.toBe(reason);
      await expect(deadline.wait(independentSemantics.promise)).rejects.toBe(
        reason,
      );
      expectOneEffect(current, 'stream');
      expect(policy).toHaveBeenCalledTimes(1);
      expect(accepted).toHaveBeenCalledTimes(1);
      expect(current.guard).not.toHaveBeenCalled();
      expect(current.end).not.toHaveBeenCalled();
    } finally {
      deadline.dispose();
      await completed?.then(
        () => {},
        () => {},
      );
    }
  }, 30_000);

  it('rejects streamed policy completion and accepted semantics after physical cleanup when the output guard trips', async () => {
    const current = fixture();
    const events = observeStreamCleanup();
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
    const guardEntered = Promise.withResolvers<void>();
    const releaseGuard = Promise.withResolvers<void>();
    const deadline = streamDeadline(() => releaseGuard.resolve());
    current.guard.mockImplementation(async ({ agentOutput }) => {
      expect(agentOutput).toBe(toSmartString(current.value));
      expect(accepted).toHaveBeenCalledTimes(1);
      expectStreamCleanup(events);
      guardEntered.resolve();
      await releaseGuard.promise;
      return { tripwireTriggered: true, outputInfo: 'blocked policy output' };
    });
    let completed: Promise<unknown> | undefined;
    try {
      const starting = SDKRunner.stream(current.agent, 'Commit once.', {
        context: current.context,
        signal: deadline.signal,
      });
      completed = starting.then((live) => live.completed);
      void completed.catch(() => {});
      const live = await deadline.wait(starting);
      const completion = observeSettlement(live.completed);
      const semantic = observeSettlement(live.toStream().getReader().read());
      const directSemantics = observeSettlement(Array.fromAsync(live));
      const raw = live.unvalidatedRaw.getReader();
      // These are real tool-call Model frames, visible before final approval.
      expect(
        (await deadline.wait(beforeCompletion(raw.read(), live.completed)))
          .value?.data,
      ).toEqual({ type: 'response_started' });
      expect(
        (await deadline.wait(beforeCompletion(raw.read(), live.completed)))
          .value?.data,
      ).toMatchObject({
        type: 'response_done',
        response: {
          id: current.responses[0].responseId,
          output: current.responses[0].output,
        },
      });
      await deadline.wait(
        beforeCompletion(guardEntered.promise, live.completed),
      );
      expect(completion.settled).toBe(false);
      expect(semantic.settled).toBe(false);
      expect(directSemantics.settled).toBe(false);
      expect(current.end).not.toHaveBeenCalled();
      const rawTerminal = observeSettlement(raw.read());
      releaseGuard.resolve();
      await expect(deadline.wait(live.completed)).rejects.toBeInstanceOf(
        OutputGuardrailTripwireTriggered,
      );
      const failure = await live.completed.catch((error: unknown) => error);
      await expect(deadline.wait(semantic.promise)).rejects.toBe(failure);
      await expect(deadline.wait(directSemantics.promise)).rejects.toBe(
        failure,
      );
      await expect(deadline.wait(rawTerminal.promise)).rejects.toBe(failure);
      expectStreamCleanup(events);
      expectOneEffect(current, 'stream');
      expect(current.guard).toHaveBeenCalledTimes(1);
      expect(current.end).not.toHaveBeenCalled();
    } finally {
      deadline.dispose();
      await completed?.then(
        () => {},
        () => {},
      );
    }
  }, 30_000);
});

describe('tool finish with held function consent', () => {
  it.each([true, false])(
    'finishes only after an acknowledged consent decision: approved=%s',
    async (approve) => {
      const execute = vi.fn(() => 'Approved output.');
      const instructions = vi.fn(() => 'Call consent once.');
      const guard = vi.fn(async () => allowed);
      const end = vi.fn();
      const model = new ScriptedModel([
        modelResponse([
          functionCall('consent', {}, { callId: 'consent-call' }),
        ]),
      ]);
      const agent = new Agent({
        name: 'Consent and tool finish',
        instructions,
        model,
        modelSettings: {},
        tools: [
          tool({
            name: 'consent',
            description: 'An effect requiring consent.',
            parameters,
            needsApproval: true,
            execute,
          }),
        ],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [{ name: 'checked final value', execute: guard }],
      });
      agent.on('agent_end', end);
      const paused = await SDKRunner.run(agent, 'Request consent.', {
        context: undefined,
        approvals: 'manual',
        signal: AbortSignal.timeout(20_000),
      });
      if (!('status' in paused) || paused.status !== 'paused')
        throw new Error('Expected a held function call');
      expect(execute).not.toHaveBeenCalled();
      const item = paused.interruptions[0]!;
      if (approve) paused.approve(item);
      else paused.reject(item);
      expect(execute).not.toHaveBeenCalled();
      const result = await paused.continue();
      const value = approve
        ? 'Approved output.'
        : 'Tool execution was not approved.';
      expect(result.finalOutput).toBe(value);
      expect(result.native.outcome).toEqual({
        type: 'turn_aborted',
        reason: 'interrupted',
      });
      expect(result.runContext).toBe(paused.runContext);
      expect(execute).toHaveBeenCalledTimes(approve ? 1 : 0);
      expect(instructions).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(guard).toHaveBeenCalledOnce();
      expect(end).toHaveBeenCalledExactlyOnceWith(result.runContext, value);
      expect(result.newItems.map((entry) => entry.type)).toEqual([
        'tool_call_item',
        'tool_call_output_item',
      ]);
      expect(result.newItems[1]).toMatchObject({ output: value });
      model.assertComplete();
    },
    30_000,
  );
});

describe('tool finish with native Agent tools', () => {
  it('finishes from the acknowledged native specialist value without a second parent Model call', async () => {
    const context = { account: 'specialist-context' };
    const childInstructions = vi.fn(() => 'Return the specialist answer.');
    const childModel = new ScriptedModel([
      modelResponse([assistantMessage('Specialist checked the account.')]),
    ]);
    const child = new Agent<typeof context>({
      name: 'Native specialist',
      instructions: childInstructions,
      model: childModel,
      modelSettings: {},
    });
    const parentModel = new ScriptedModel([
      modelResponse([
        functionCall(
          'consult',
          { input: 'Check the account.' },
          { callId: 'consult-call' },
        ),
      ]),
    ]);
    const guard = vi.fn(async () => allowed);
    const parent = new Agent<typeof context>({
      name: 'Specialist caller',
      model: parentModel,
      modelSettings: {},
      tools: [
        child.asTool({
          toolName: 'consult',
          toolDescription: 'Ask the specialist.',
        }),
      ],
      toolUseBehavior: 'stop_on_first_tool',
      outputGuardrails: [{ name: 'specialist value', execute: guard }],
    });
    const result = await SDKRunner.run(parent, 'Check once.', {
      context,
      signal: AbortSignal.timeout(20_000),
    });
    expect(result.finalOutput).toBe('Specialist checked the account.');
    expect(result.runContext.context).toBe(context);
    expect(childInstructions).toHaveBeenCalledOnce();
    expect(childInstructions.mock.calls[0]).toEqual([result.runContext, child]);
    expect(parentModel.calls).toHaveLength(1);
    expect(childModel.calls).toHaveLength(1);
    expect(result.native.outcome).toEqual({
      type: 'turn_aborted',
      reason: 'interrupted',
    });
    expect(result.modelResponses).toHaveLength(1);
    expect(result.newItems.map((item) => item.type)).toEqual([
      'tool_call_item',
      'tool_call_output_item',
    ]);
    expect(result.newItems[1]).toMatchObject({
      agent: parent,
      output: 'Specialist checked the account.',
    });
    expect(guard).toHaveBeenCalledOnce();
    parentModel.assertComplete();
    childModel.assertComplete();
  }, 30_000);
});
