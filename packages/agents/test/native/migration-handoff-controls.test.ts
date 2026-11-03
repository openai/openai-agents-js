import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  handoff,
  RunToolCallOutputItem,
  ToolGuardrailFunctionOutputFactory as guardOutput,
  setTracingDisabled,
  tool,
  type FunctionToolResult,
  type RunContext,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelError,
  modelResponse,
} from '@openai/agents-core/testing';
import { SDKRunner } from '../../src/migration';
import { SelectedModelInvocation } from '../../src/migration/model';
import { NativeProvider } from '../../src/runtime/provider';
import { Session } from '../../src/runtime/session';
import type { SelectedModelTerminal } from '../../src/runtime/http-model';

setTracingDisabled(true);
afterEach(() => vi.restoreAllMocks());

type Context = { account: string };
const parameters = z.object({});
const allowed = { tripwireTriggered: false, outputInfo: 'checked' };

describe('native handoff active Agent controls', () => {
  it('skips source stop-first on transfer and finishes the checked target tool after a safe retry', async () => {
    const context: Context = { account: 'original' };
    const checked = 'Checked target value.';
    const retry = vi.fn(() => ({ retry: true, delayMs: 0 }));
    const model = new ScriptedModel([
      modelResponse([
        functionCall('transfer_to_Target', '{}', { callId: 'transfer' }),
      ]),
      modelError(new Error('Safe target attempt failure'), {
        replaySafety: 'safe',
      }),
      modelResponse([
        functionCall('target_work', '{}', { callId: 'target-call' }),
      ]),
    ]);
    const sourceInstructions = vi.fn(
      async (received: RunContext<Context>, owner: Agent<Context>) => {
        expect(received.context).toBe(context);
        expect(owner).toBe(source);
        return 'Source: transfer this request.';
      },
    );
    const targetInstructions = vi.fn(
      async (received: RunContext<Context>, owner: Agent<Context>) => {
        expect(received.context).toBe(context);
        expect(owner).toBe(target);
        return 'Target: execute target_work once.';
      },
    );
    const execute = vi.fn(
      (_args: Record<string, never>, received?: RunContext<Context>) => {
        expect(received?.context).toBe(context);
        return 'Private unchecked value.';
      },
    );
    const action = tool({
      name: 'target_work',
      description: 'Perform target work.',
      parameters,
      execute,
      outputGuardrails: [
        {
          name: 'checked target value',
          async run({ agent, context: received, output }) {
            expect(agent).toBe(target);
            expect(received.context).toBe(context);
            expect(output).toBe('Private unchecked value.');
            return guardOutput.rejectContent(checked, 'sanitized');
          },
        },
      ],
    });
    const policy = vi.fn(
      async (received: RunContext, results: FunctionToolResult[]) => {
        expect(received.context).toBe(context);
        expect(results).toHaveLength(1);
        const result = results[0];
        if (result?.type !== 'function_output')
          throw new Error('Expected accepted target output');
        expect(result.tool).toBe(action);
        expect(result.output).toBe(checked);
        expect(result.runItem).toBeInstanceOf(RunToolCallOutputItem);
        expect(result.runItem.agent).toBe(target);
        expect(result.runItem.rawItem).toMatchObject({
          callId: 'target-call',
          name: action.name,
          output: { type: 'text', text: checked },
        });
        return {
          isFinalOutput: true as const,
          isInterrupted: undefined,
          finalOutput: `Policy: ${result.output}`,
        };
      },
    );
    const sourceGuard = vi.fn(async () => allowed);
    const targetGuard = vi.fn(
      async (_args: { agentOutput: string }) => allowed,
    );
    const sourceEnd = vi.fn();
    const targetEnd = vi.fn();
    const targetStart = vi.fn();
    const source = new Agent<Context>({
      name: 'Source',
      model,
      instructions: sourceInstructions,
      toolUseBehavior: 'stop_on_first_tool',
      outputGuardrails: [{ name: 'source completion', execute: sourceGuard }],
    });
    const target = new Agent<Context>({
      name: 'Target',
      model,
      instructions: targetInstructions,
      tools: [action],
      modelSettings: {
        toolChoice: action.name,
        retry: { maxRetries: 1, policy: retry },
      },
      resetToolChoice: true,
      toolUseBehavior: policy,
      outputGuardrails: [{ name: 'target completion', execute: targetGuard }],
    });
    source.handoffs = [handoff(target)];
    source.on('agent_end', sourceEnd);
    target.on('agent_end', targetEnd);
    target.on('agent_start', targetStart);
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Handoff retry deadline')),
      20_000,
    );
    const running = SDKRunner.run(source, 'Transfer and act.', {
      context,
      signal: controller.signal,
      modelInvocation: 'response',
    });
    try {
      const result = await running;
      expect(execute).toHaveBeenCalledTimes(1);
      expect(policy).toHaveBeenCalledTimes(1);
      expect(policy.mock.calls[0][0]).toBe(result.runContext);
      expect(retry).toHaveBeenCalledTimes(1);
      expect(sourceInstructions).toHaveBeenCalledExactlyOnceWith(
        result.runContext,
        source,
      );
      expect(targetInstructions).toHaveBeenCalledExactlyOnceWith(
        result.runContext,
        target,
      );
      expect(targetStart).toHaveBeenCalledTimes(1);
      expect(targetStart.mock.calls[0].slice(0, 2)).toEqual([
        result.runContext,
        target,
      ]);
      expect(
        model.calls.map((entry) => entry.request.systemInstructions),
      ).toEqual([
        'Source: transfer this request.',
        'Target: execute target_work once.',
        'Target: execute target_work once.',
      ]);
      expect(
        model.calls
          .slice(1)
          .map((entry) => entry.request.modelSettings.toolChoice),
      ).toEqual([action.name, action.name]);
      expect(
        accepted.mock.calls.map((entry) => [entry[0], entry[2].success]),
      ).toEqual([
        ['transfer', true],
        ['target-call', true],
      ]);
      expect(result.finalOutput).toBe(`Policy: ${checked}`);
      expect(result.lastAgent).toBe(target);
      expect(result.native.outcome).toEqual({
        type: 'turn_aborted',
        reason: 'interrupted',
      });
      expect(result.modelResponses).toHaveLength(2);
      expect(result.newItems.map((item) => item.type)).toEqual([
        'handoff_call_item',
        'handoff_output_item',
        'tool_call_item',
        'tool_call_output_item',
      ]);
      expect(result.newItems[3]).toMatchObject({
        agent: target,
        output: checked,
      });
      expect(sourceGuard).not.toHaveBeenCalled();
      expect(sourceEnd).not.toHaveBeenCalled();
      expect(targetGuard).toHaveBeenCalledTimes(1);
      expect(targetGuard.mock.calls[0][0]).toMatchObject({
        agent: target,
        context: result.runContext,
        agentOutput: `Policy: ${checked}`,
      });
      expect(targetEnd).toHaveBeenCalledExactlyOnceWith(
        result.runContext,
        `Policy: ${checked}`,
      );
      expect(model.calls).toHaveLength(3);
      model.assertComplete();
    } finally {
      clearTimeout(timer);
      controller.abort(new Error('Handoff retry cleanup'));
      await running.catch(() => {});
    }
  }, 30_000);

  it('keeps instructions, ordinary policy results and tool-choice reset scoped to each owner', async () => {
    const context: Context = { account: 'original' };
    const model = new ScriptedModel([
      modelResponse([
        functionCall('source_work', '{}', { callId: 'source-call' }),
      ]),
      modelResponse([
        functionCall('transfer_to_Target', '{}', { callId: 'transfer' }),
      ]),
      modelResponse([
        functionCall('target_work', '{}', { callId: 'target-call' }),
      ]),
      modelResponse([assistantMessage('Target completed.')]),
    ]);
    const sourceEffect = vi.fn(() => 'Source value.');
    const targetEffect = vi.fn(() => 'Target value.');
    const sourceAction = tool({
      name: 'source_work',
      description: 'Source effect.',
      parameters,
      execute: sourceEffect,
    });
    const targetAction = tool({
      name: 'target_work',
      description: 'Target effect.',
      parameters,
      execute: targetEffect,
    });
    const sourcePolicy = vi.fn(
      async (received: RunContext, results: FunctionToolResult[]) => {
        expect(received.context).toBe(context);
        expect(results).toHaveLength(1);
        const result = results[0];
        if (result?.type !== 'function_output')
          throw new Error('Expected source output');
        expect(result.tool).toBe(sourceAction);
        expect(result.output).toBe('Source value.');
        expect(result.runItem.agent).toBe(source);
        return { isFinalOutput: false as const, isInterrupted: undefined };
      },
    );
    const targetPolicy = vi.fn(
      async (received: RunContext, results: FunctionToolResult[]) => {
        expect(received.context).toBe(context);
        expect(results).toHaveLength(1);
        const result = results[0];
        if (result?.type !== 'function_output')
          throw new Error('Expected target output');
        expect(result.tool).toBe(targetAction);
        expect(result.output).toBe('Target value.');
        expect(result.runItem.agent).toBe(target);
        return { isFinalOutput: false as const, isInterrupted: undefined };
      },
    );
    const sourceInstructions = vi.fn(
      (received: RunContext<Context>, owner: Agent<Context>) => {
        expect(received.context).toBe(context);
        expect(owner).toBe(source);
        return 'Source instructions.';
      },
    );
    const targetInstructions = vi.fn(
      async (received: RunContext<Context>, owner: Agent<Context>) => {
        expect(received.context).toBe(context);
        expect(owner).toBe(target);
        return 'Target instructions.';
      },
    );
    const targetGuard = vi.fn(async () => allowed);
    const targetEnd = vi.fn();
    const source = new Agent<Context>({
      name: 'Source',
      model,
      instructions: sourceInstructions,
      tools: [sourceAction],
      modelSettings: { toolChoice: sourceAction.name },
      resetToolChoice: true,
      toolUseBehavior: sourcePolicy,
    });
    const target = new Agent<Context>({
      name: 'Target',
      model,
      instructions: targetInstructions,
      tools: [targetAction],
      modelSettings: { toolChoice: targetAction.name },
      resetToolChoice: false,
      toolUseBehavior: targetPolicy,
      outputGuardrails: [{ name: 'target answer', execute: targetGuard }],
    });
    source.handoffs = [handoff(target)];
    target.on('agent_end', targetEnd);
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(new Error('Owner controls deadline')),
      20_000,
    );
    const running = SDKRunner.run(source, 'Act, transfer, then answer.', {
      context,
      signal: controller.signal,
      modelInvocation: 'response',
    });
    try {
      const result = await running;
      expect(
        model.calls.map((entry) => entry.request.systemInstructions),
      ).toEqual([
        'Source instructions.',
        'Source instructions.',
        'Target instructions.',
        'Target instructions.',
      ]);
      expect(
        model.calls.map((entry) => entry.request.modelSettings.toolChoice),
      ).toEqual([
        sourceAction.name,
        undefined,
        targetAction.name,
        targetAction.name,
      ]);
      expect(sourceInstructions).toHaveBeenCalledTimes(2);
      expect(targetInstructions).toHaveBeenCalledTimes(2);
      expect(
        sourceInstructions.mock.calls.every(
          ([received, owner]) =>
            received === result.runContext && owner === source,
        ),
      ).toBe(true);
      expect(
        targetInstructions.mock.calls.every(
          ([received, owner]) =>
            received === result.runContext && owner === target,
        ),
      ).toBe(true);
      expect(sourceEffect).toHaveBeenCalledTimes(1);
      expect(targetEffect).toHaveBeenCalledTimes(1);
      expect(sourcePolicy).toHaveBeenCalledTimes(1);
      expect(targetPolicy).toHaveBeenCalledTimes(1);
      expect(result.lastAgent).toBe(target);
      expect(result.finalOutput).toBe('Target completed.');
      expect(result.modelResponses).toHaveLength(4);
      expect(result.newItems.map((item) => item.type)).toEqual([
        'tool_call_item',
        'tool_call_output_item',
        'handoff_call_item',
        'handoff_output_item',
        'tool_call_item',
        'tool_call_output_item',
        'message_output_item',
      ]);
      expect(result.newItems[1]).toMatchObject({
        agent: source,
        output: 'Source value.',
        rawItem: { callId: 'source-call' },
      });
      expect(result.newItems[5]).toMatchObject({
        agent: target,
        output: 'Target value.',
        rawItem: { callId: 'target-call' },
      });
      expect(result.newItems[6]).toMatchObject({ agent: target });
      expect(targetGuard).toHaveBeenCalledTimes(1);
      expect(targetEnd).toHaveBeenCalledExactlyOnceWith(
        result.runContext,
        'Target completed.',
      );
      model.assertComplete();
    } finally {
      clearTimeout(timer);
      controller.abort(new Error('Owner controls cleanup'));
      await running.catch(() => {});
    }
  }, 30_000);

  it('preserves caller abort during joined cleanup before the target policy finalizer', async () => {
    const context: Context = { account: 'original' };
    const model = new ScriptedModel([
      modelResponse([
        functionCall('transfer_to_Target', '{}', { callId: 'transfer' }),
      ]),
      modelResponse([
        functionCall('target_work', '{}', { callId: 'target-call' }),
      ]),
    ]);
    const execute = vi.fn(() => 'Target value.');
    const action = tool({
      name: 'target_work',
      description: 'Target effect.',
      parameters,
      execute,
    });
    const policy = vi.fn(async () => ({
      isFinalOutput: true as const,
      isInterrupted: undefined,
      finalOutput: 'Target policy answer.',
    }));
    const guard = vi.fn(async () => allowed);
    const end = vi.fn();
    const source = new Agent<Context>({
      name: 'Source',
      model,
      instructions: 'Transfer.',
      toolUseBehavior: 'stop_on_first_tool',
    });
    const target = new Agent<Context>({
      name: 'Target',
      model,
      instructions: 'Use target_work.',
      tools: [action],
      toolUseBehavior: policy,
      outputGuardrails: [{ name: 'never after abort', execute: guard }],
    });
    source.handoffs = [handoff(target)];
    target.on('agent_end', end);
    const accepted = vi.spyOn(SelectedModelInvocation.prototype, 'toolResult');
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
    const physicallyJoined: string[] = [];
    const closeSession = Session.prototype.close;
    const join = SelectedModelInvocation.prototype.join;
    const closeProvider = NativeProvider.prototype.close;
    vi.spyOn(Session.prototype, 'close').mockImplementation(async function (
      this: Session,
    ) {
      await closeSession.call(this);
      physicallyJoined.push('session');
    });
    vi.spyOn(SelectedModelInvocation.prototype, 'join').mockImplementation(
      async function (this: SelectedModelInvocation) {
        await join.call(this);
        physicallyJoined.push('model');
      },
    );
    vi.spyOn(NativeProvider.prototype, 'close').mockImplementation(
      async function (this: NativeProvider) {
        await closeProvider.call(this);
        physicallyJoined.push('provider');
        entered.resolve();
        await release.promise;
      },
    );
    const controller = new AbortController();
    const reason = new Error('Caller stopped target policy cleanup');
    const expired = Promise.withResolvers<never>();
    void expired.promise.catch(() => {});
    const timer = setTimeout(() => {
      controller.abort(new Error('Target cleanup deadline'));
      release.resolve();
      expired.reject(new Error('Target cleanup gate deadline'));
    }, 20_000);
    let settled = false;
    const running = SDKRunner.run(source, 'Transfer and act.', {
      context,
      signal: controller.signal,
      modelInvocation: 'response',
    });
    const outcome = running.then(
      (value) => {
        settled = true;
        return { type: 'completed' as const, value };
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
          throw new Error('Run ended before target cleanup gate');
        }),
      ]);
      expect(physicallyJoined).toEqual(
        expect.arrayContaining(['session', 'model', 'provider']),
      );
      expect(policy).toHaveBeenCalledTimes(1);
      expect(terminals).toHaveLength(1);
      expect(terminals[0]).toMatchObject({
        kind: 'turn_aborted',
        reason: 'interrupted',
      });
      expect(
        accepted.mock.calls.map((entry) => [entry[0], entry[2].success]),
      ).toEqual([
        ['transfer', true],
        ['target-call', true],
      ]);
      controller.abort(reason);
      await Promise.race([
        new Promise<void>((resolve) => setImmediate(resolve)),
        expired.promise,
      ]);
      expect(settled).toBe(false);
      expect(guard).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
      release.resolve();
      const stopped = await Promise.race([outcome, expired.promise]);
      expect(stopped.type).toBe('error');
      if (stopped.type !== 'error')
        throw new Error('Expected exact caller abort, not a result');
      expect(stopped.error).toBe(reason);
      expect(guard).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
      model.assertComplete();
    } finally {
      clearTimeout(timer);
      controller.abort(reason);
      release.resolve();
      await outcome;
    }
  }, 30_000);
});
