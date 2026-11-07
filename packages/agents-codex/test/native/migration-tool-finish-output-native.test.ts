import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  MemorySession,
  OutputGuardrailTripwireTriggered,
  RunToolCallOutputItem,
  Usage,
  setTracingDisabled,
  tool,
  type FunctionToolResult,
  type RunContext,
  type ToolUseBehavior,
} from '@openai/agents/classic';
import { toSmartString } from '@openai/agents-core/utils';
import {
  ScriptedModel,
  functionCall,
  modelResponse,
} from '@openai/agents/classic/testing';
import { MigrationCleanupError, SDKRunner } from '../../src/migration';
import { SelectedModelInvocation } from '../../src/migration/model';
import { OutputValidationError } from '../../src/runtime/output';
import { NativeProvider } from '../../src/runtime/provider';
import { Session, Turn, TurnAborted } from '../../src/runtime/session';
import type { SelectedModelTerminal } from '../../src/runtime/http-model';

setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());

type Context = { account: string };
type Report = { title: string; count: number };
const value: Report = { title: 'Checked policy report', count: 7 };

function fixture(
  toolValue: unknown,
  behavior: ToolUseBehavior,
  tripwire = false,
) {
  const schema = z.object({ title: z.string(), count: z.number() }).strict();
  const context: Context = { account: 'original' };
  const order: string[] = [];
  const terminals: SelectedModelTerminal[] = [];
  let runContext: RunContext<Context> | undefined;
  const execute = vi.fn(
    (_args: Record<string, never>, received?: RunContext<Context>) => {
      expect(received?.context).toBe(context);
      runContext = received;
      order.push('effect');
      return toolValue;
    },
  );
  const action = tool({
    name: 'report',
    description: 'Produce one application report.',
    parameters: z.object({}),
    execute,
  });
  const response = {
    responseId: 'structured-policy-tools',
    output: [functionCall(action.name, '{}', { callId: 'report-call' })],
    usage: new Usage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
  };
  const model = new ScriptedModel([modelResponse(response)]);
  const checked = vi.spyOn(SelectedModelInvocation.prototype, 'toolValue');
  const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
  const terminal = SelectedModelInvocation.prototype.terminal;
  vi.spyOn(SelectedModelInvocation.prototype, 'terminal').mockImplementation(
    function (this: SelectedModelInvocation, event) {
      terminals.push(event);
      terminal.call(this, event);
    },
  );
  const cancel = Turn.prototype.cancel;
  vi.spyOn(Turn.prototype, 'cancel').mockImplementation(async function (
    this: Turn,
    ...args: Parameters<Turn['cancel']>
  ) {
    await cancel.apply(this, args);
    if (args[0]?.mode === 'force') order.push('force stop returned');
  });
  const closeSession = Session.prototype.close;
  vi.spyOn(Session.prototype, 'close').mockImplementation(async function (
    this: Session,
  ) {
    await closeSession.call(this);
    order.push('session closed');
  });
  const join = SelectedModelInvocation.prototype.join;
  vi.spyOn(SelectedModelInvocation.prototype, 'join').mockImplementation(
    async function (this: SelectedModelInvocation) {
      await join.call(this);
      order.push('producer joined');
    },
  );
  const closeProvider = NativeProvider.prototype.close;
  vi.spyOn(NativeProvider.prototype, 'close').mockImplementation(
    async function (this: NativeProvider) {
      await closeProvider.call(this);
      order.push('provider closed');
    },
  );
  const expectStoppedAndJoined = () => {
    expect(accepted).toHaveBeenCalledExactlyOnceWith(
      'report-call',
      action.name,
      expect.anything(),
    );
    expect(order).toEqual(
      expect.arrayContaining([
        'force stop returned',
        'session closed',
        'producer joined',
        'provider closed',
      ]),
    );
    expect(terminals).toHaveLength(1);
    expect(terminals[0].kind).toBe('turn_aborted');
    expect(terminals[0].reason).toBe('interrupted');
    expect(terminals[0].error).toBeInstanceOf(TurnAborted);
    expect(terminals[0].nativeError == null).toBe(true);
    expect(terminals[0].priorFailure).toBe(terminals[0].error);
    expect(terminals[0].nativeFailure == null).toBe(true);
  };
  // Observe the real captured Zod parser, including its throwing path.
  const parse = schema.parse;
  const parsed = vi
    .spyOn(schema, 'parse')
    .mockImplementation((input, params) => {
      expectStoppedAndJoined();
      expect(input).toEqual(toolValue);
      order.push('parse');
      return parse(input, params);
    });
  const guard = vi.fn(async ({ agentOutput }: { agentOutput: Report }) => {
    expectStoppedAndJoined();
    expect(parsed).toHaveBeenCalledTimes(1);
    const result = parsed.mock.results[0];
    if (result.type !== 'return') throw new Error('Expected checked output');
    expect(agentOutput).toBe(result.value);
    expect(agentOutput).toEqual(value);
    expect(agentOutput).not.toBe(toolValue);
    order.push('guard');
    return { tripwireTriggered: tripwire, outputInfo: 'checked policy report' };
  });
  const end = vi.fn();
  const agent = new Agent<Context, typeof schema>({
    name: 'Structured tool-policy finish',
    instructions: 'Use report and return its declared object.',
    model,
    modelSettings: {},
    tools: [action],
    outputType: schema,
    toolUseBehavior: behavior,
    outputGuardrails: [{ name: 'parsed report', execute: guard }],
  });
  agent.on('agent_end', end);
  return {
    agent,
    action,
    context,
    execute,
    model,
    response,
    checked,
    accepted,
    guard,
    end,
    parsed,
    order,
    expectStoppedAndJoined,
    get runContext() {
      return runContext;
    },
  };
}

type Fixture = ReturnType<typeof fixture>;

async function runOwned(
  current: Fixture,
  modelInvocation: 'response' | 'stream',
) {
  const controller = new AbortController();
  const expired = Promise.withResolvers<never>();
  const timer = setTimeout(() => {
    const error = new Error('Structured policy composition deadline');
    controller.abort(error);
    expired.reject(error);
  }, 20_000);
  // Structured output supports buffered Model streaming, not SDKRunner.stream().
  const running = SDKRunner.run(current.agent, 'Report.', {
    context: current.context,
    signal: controller.signal,
    modelInvocation,
  }).catch(async (error: unknown) => {
    if (error instanceof MigrationCleanupError) await error.retryCleanup();
    throw error;
  });
  void running.catch(() => {});
  try {
    return await Promise.race([running, expired.promise]);
  } finally {
    clearTimeout(timer);
    controller.abort(new Error('Structured policy probe cleanup'));
    await running.catch(() => {});
  }
}

function expectOneRequestAndEffect(current: Fixture, streamed: boolean) {
  expect(current.execute).toHaveBeenCalledTimes(1);
  expect(current.model.calls).toHaveLength(1);
  expect(current.model.calls[0].streamed).toBe(streamed);
  expect(current.model.calls[0].request.outputType).toMatchObject({
    type: 'json_schema',
    name: 'output',
    strict: true,
    schema: {
      type: 'object',
      properties: { title: { type: 'string' }, count: { type: 'number' } },
      required: ['title', 'count'],
      additionalProperties: false,
    },
  });
  current.model.assertComplete();
  current.expectStoppedAndJoined();
}

describe('structured output with native tool-policy finish', () => {
  it('parses stop-first output after true ACK and physical joins, then shares the checked object with finalization', async () => {
    const current = fixture(value, 'stop_on_first_tool');
    const result = await runOwned(current, 'response');
    expectOneRequestAndEffect(current, false);
    expect(result.finalOutput).toEqual(value);
    expect(result.finalOutput).toBe(current.parsed.mock.results[0].value);
    expect(current.parsed).toHaveBeenCalledTimes(1);
    expect(current.guard).toHaveBeenCalledTimes(1);
    expect(result.outputGuardrailResults[0].agent).toBe(current.agent);
    expect(result.outputGuardrailResults[0].agentOutput).toBe(
      result.finalOutput,
    );
    expect(current.end).toHaveBeenCalledExactlyOnceWith(
      current.runContext,
      result.finalOutput,
    );
    expect(result.lastAgent).toBe(current.agent);
    expect(result.runContext).toBe(current.runContext);
    expect(result.native.outcome).toEqual({
      type: 'turn_aborted',
      reason: 'interrupted',
    });
    expect(result.rawResponses).toEqual([current.response]);
    expect(result.newItems.map((item) => item.type)).toEqual([
      'tool_call_item',
      'tool_call_output_item',
    ]);
    expect(result.newItems[1]).toBeInstanceOf(RunToolCallOutputItem);
    expect(result.newItems[1]).toMatchObject({
      agent: current.agent,
      output: value,
      rawItem: {
        callId: 'report-call',
        name: current.action.name,
        output: toSmartString(value),
      },
    });
    expect(await Array.fromAsync(result.replayEvents())).toHaveLength(2);
    expect(current.order.indexOf('parse')).toBeGreaterThan(
      current.order.indexOf('provider closed'),
    );
    expect(current.order.indexOf('guard')).toBeGreaterThan(
      current.order.indexOf('parse'),
    );
    expect(current.parsed).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('rejects a named-stop schema mismatch after ACK and joins without a result or agent_end', async () => {
    const invalid = { title: 'Invalid count', count: 'not a number' };
    const current = fixture(invalid, { stopAtToolNames: ['report'] });
    const running = runOwned(current, 'stream');
    await expect(running).rejects.toBeInstanceOf(OutputValidationError);
    const failure = await running.catch((error: unknown) => error);
    expect(failure).toMatchObject({
      rawOutput: toSmartString(invalid),
      issues: [{ code: 'invalid_type', path: ['count'] }],
    });
    expectOneRequestAndEffect(current, true);
    expect(current.parsed).toHaveBeenCalledTimes(1);
    expect(current.parsed.mock.results[0].type).toBe('throw');
    // A lifecycle assertion swallowed by the redacting parser is not this oracle.
    expect(current.parsed.mock.results[0].value).toBeInstanceOf(z.ZodError);
    expect(current.guard).not.toHaveBeenCalled();
    expect(current.end).not.toHaveBeenCalled();
  }, 30_000);

  it('checks callable true-ACK objects and trips the parsed-output guard without a result or agent_end', async () => {
    const policy = vi.fn(
      async (context: RunContext, results: FunctionToolResult[]) => {
        expect(context).toBe(current.runContext);
        expect(current.accepted).toHaveBeenCalledTimes(1);
        expect(results).toHaveLength(1);
        const output = results[0];
        if (output.type !== 'function_output')
          throw new Error('Expected function output');
        expect(output.tool).toBe(current.action);
        expect(output.output).toEqual(value);
        expect(output.output).not.toBe(value);
        expect(output.output).toBe(current.checked.mock.results[0].value);
        expect(output.runItem).toBeInstanceOf(RunToolCallOutputItem);
        expect(output.runItem.agent).toBe(current.agent);
        expect(output.runItem.output).toBe(output.output);
        expect(output.runItem.rawItem).toMatchObject({
          callId: 'report-call',
          name: current.action.name,
        });
        return {
          isFinalOutput: true as const,
          isInterrupted: undefined,
          finalOutput: toSmartString(output.output),
        };
      },
    );
    const current = fixture(value, policy, true);
    await expect(runOwned(current, 'stream')).rejects.toBeInstanceOf(
      OutputGuardrailTripwireTriggered,
    );
    expectOneRequestAndEffect(current, true);
    expect(policy).toHaveBeenCalledTimes(1);
    expect(current.parsed).toHaveBeenCalledTimes(1);
    expect(current.guard).toHaveBeenCalledTimes(1);
    expect(current.end).not.toHaveBeenCalled();
  }, 30_000);

  it('does not parse or refine policy output after caller abort during joined cleanup', async () => {
    const store = new MemorySession();
    const append = vi.spyOn(store, 'addItems');
    const refinements: string[] = [];
    const schema = z
      .object({ title: z.string(), count: z.number() })
      .strict()
      .superRefine(() => {
        refinements.push('application refinement');
      });
    // Call through without lifecycle assertions that could mask the refinement.
    const parsed = vi.spyOn(schema, 'parse');
    const execute = vi.fn(() => value);
    const model = new ScriptedModel([
      modelResponse({
        responseId: 'cleanup-abort-tool',
        output: [
          functionCall('report', '{}', { callId: 'cleanup-abort-call' }),
        ],
        usage: new Usage({ inputTokens: 2, outputTokens: 1, totalTokens: 3 }),
      }),
    ]);
    const guard = vi.fn(async () => ({
      tripwireTriggered: false,
      outputInfo: 'must not enter after cancellation',
    }));
    const agent = Agent.create({
      name: 'Cancelled structured policy finalizer',
      instructions: 'Use report and return the declared object.',
      model,
      modelSettings: {},
      outputType: schema,
      tools: [
        tool({
          name: 'report',
          description: 'Produce one valid report.',
          parameters: z.object({}),
          execute,
        }),
      ],
      toolUseBehavior: 'stop_on_first_tool',
      outputGuardrails: [{ name: 'not after cancellation', execute: guard }],
    });
    const end = vi.fn();
    agent.on('agent_end', end);
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
    const cancel = vi.spyOn(Turn.prototype, 'cancel');
    const terminals: SelectedModelTerminal[] = [];
    const terminal = SelectedModelInvocation.prototype.terminal;
    vi.spyOn(SelectedModelInvocation.prototype, 'terminal').mockImplementation(
      function (this: SelectedModelInvocation, event) {
        terminals.push(event);
        terminal.call(this, event);
      },
    );
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const close = NativeProvider.prototype.close;
    let physicallyClosed = false;
    vi.spyOn(NativeProvider.prototype, 'close').mockImplementation(
      async function (this: NativeProvider) {
        await close.call(this);
        physicallyClosed = true;
        entered.resolve();
        await release.promise;
      },
    );
    const controller = new AbortController();
    const reason = new Error('Caller stopped during policy cleanup');
    const expired = Promise.withResolvers<never>();
    void expired.promise.catch(() => {});
    const timer = setTimeout(() => {
      const error = new Error('Policy cleanup cancellation probe deadline');
      controller.abort(error);
      release.resolve();
      expired.reject(error);
    }, 20_000);
    let settled = false;
    const running = SDKRunner.run(agent, 'Report.', {
      context: undefined,
      session: store,
      signal: controller.signal,
    });
    const outcome = running.then(
      (result) => {
        settled = true;
        return { type: 'completed' as const, result };
      },
      (error: unknown) => {
        settled = true;
        return { type: 'error' as const, error };
      },
    );
    try {
      await Promise.race([
        entered.promise,
        expired.promise,
        outcome.then(() => {
          throw new Error('Run ended before the provider cleanup gate');
        }),
      ]);
      expect(physicallyClosed).toBe(true);
      expect(accepted).toHaveBeenCalledExactlyOnceWith(
        'cleanup-abort-call',
        'report',
        expect.anything(),
      );
      expect(cancel).toHaveBeenCalledWith({ mode: 'force' });
      expect(terminals).toHaveLength(1);
      expect(terminals[0].kind).toBe('turn_aborted');
      expect(terminals[0].reason).toBe('interrupted');
      controller.abort(reason);
      await Promise.race([
        new Promise<void>((resolve) => setImmediate(resolve)),
        expired.promise,
      ]);
      expect(settled).toBe(false);
      expect(parsed).not.toHaveBeenCalled();
      expect(refinements).toEqual([]);
      expect(guard).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
      release.resolve();
      const stopped = await Promise.race([outcome, expired.promise]);
      expect(stopped.type).toBe('error');
      if (stopped.type !== 'error')
        throw new Error('Expected caller cancellation');
      expect(stopped.error).toBe(reason);
      expect(refinements).toEqual([]);
      expect(parsed).not.toHaveBeenCalled();
      expect(guard).not.toHaveBeenCalled();
      expect(append).not.toHaveBeenCalled();
      expect(await store.getItems()).toEqual([]);
      expect(end).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      model.assertComplete();
    } finally {
      clearTimeout(timer);
      controller.abort(reason);
      release.resolve();
      await outcome;
    }
  }, 30_000);
});
