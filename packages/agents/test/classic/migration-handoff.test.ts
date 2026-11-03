import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  Handoff,
  handoff,
  RunContext,
  RunHandoffCallItem,
  RunHandoffOutputItem,
  RunHooks,
  type HandoffInputData,
} from '@openai/agents-core';
import { functionCall, ScriptedModel } from '@openai/agents-core/testing';
import {
  captureNativeHandoff,
  prepareNativeHandoff,
} from '../../src/migration/handoff';

type Context = { customer: string };
const check = () => {};
function agents() {
  const model = new ScriptedModel([]);
  const target = new Agent<Context>({ name: 'Target', model });
  const source = new Agent<Context>({ name: 'Root', model });
  const context = new RunContext<Context>({ customer: 'original' });
  return { source, target, context };
}

describe('captured native handoff semantics', () => {
  it('reevaluates original enablement with the actual source and context inside the captured graph', async () => {
    const { source, target, context } = agents();
    let mutate = false;
    const predicate = vi.fn(
      ({
        runContext,
        agent,
      }: {
        runContext: RunContext<Context>;
        agent: Agent<Context>;
      }) => {
        expect(runContext).toBe(context);
        expect(agent).toBe(source);
        if (mutate) target.handoffs = [source];
        return runContext.context.customer === 'original';
      },
    );
    const transfer = handoff(target, { isEnabled: predicate });
    source.handoffs = [transfer];
    const plan = captureNativeHandoff(source, check)!;
    await expect(plan.enabled(context)).resolves.toBe(true);
    context.context.customer = 'revoked';
    await expect(plan.enabled(context)).resolves.toBe(false);
    expect(predicate).toHaveBeenCalledTimes(2);
    mutate = true;
    await expect(plan.enabled(context)).rejects.toThrow(
      'configuration changed',
    );
    target.handoffs = [];
    transfer.isEnabled = async () => true;
    await expect(plan.enabled(context)).rejects.toThrow(
      'configuration changed',
    );
    expect(predicate).toHaveBeenCalledTimes(3);
  });

  it('invokes the original parser once and preserves ordered identities and shallow history', async () => {
    const { source, target, context } = agents();
    const order: string[] = [];
    const parsed = vi.fn();
    const hooks = new RunHooks<Context>();
    hooks.on('agent_handoff', (seenContext, from, to) => {
      expect(seenContext).toBe(context);
      expect(from).toBe(source);
      expect(to).toBe(target);
      order.push('runner');
    });
    source.on('agent_handoff', (seenContext, to) => {
      expect(seenContext).toBe(context);
      expect(to).toBe(target);
      order.push('source');
    });
    const transfer = handoff(target, {
      inputType: z.object({ reason: z.string() }).superRefine((value) => {
        parsed(value.reason);
      }),
      onHandoff: (seenContext, input) => {
        expect(seenContext).toBe(context);
        expect(input).toEqual({ reason: 'billing' });
        order.push('callback');
      },
      inputFilter: (value) => {
        order.push('filter');
        expect(value.runContext).toBe(context);
        expect(value.inputHistory).not.toBe(input.inputHistory);
        expect(value.preHandoffItems).not.toBe(input.preHandoffItems);
        expect(value.newItems).not.toBe(input.newItems);
        expect(value.newItems[0]).toBe(callItem);
        expect(value.newItems[1]).toBeInstanceOf(RunHandoffOutputItem);
        return { ...value, inputHistory: 'filtered' };
      },
    });
    source.handoffs = [transfer];
    const call = functionCall(transfer.toolName, '{"reason":"billing"}', {
      callId: 'handoff-1',
    });
    const itemAgent: RunHandoffOutputItem['sourceAgent'] = source;
    const callItem = new RunHandoffCallItem(call, itemAgent);
    const input: HandoffInputData = {
      inputHistory: [],
      preHandoffItems: [],
      newItems: [callItem],
    };
    const plan = captureNativeHandoff(source, check)!;
    const result = await prepareNativeHandoff(plan, {
      context,
      call,
      input,
      hooks,
      check,
    });
    expect(parsed).toHaveBeenCalledExactlyOnceWith('billing');
    expect(order).toEqual(['callback', 'runner', 'source', 'filter']);
    expect(result.input.inputHistory).toBe('filtered');
    expect(input.newItems).toEqual([callItem]);
    expect(result.commitItems).toEqual([callItem, result.outputItem]);
    expect(result.outputItem.sourceAgent).toBe(source);
    expect(result.outputItem.targetAgent).toBe(target);
    expect(result.outputItem.rawItem.callId).toBe(call.callId);
    expect(result.transferMessage).toBe('{"assistant":"Target"}');
  });

  it('refuses unsupported graphs and changed declarations before callback effects', async () => {
    const { source, target, context } = agents();
    expect(captureNativeHandoff(source, check)).toBeUndefined();
    source.handoffs = [source];
    expect(() => captureNativeHandoff(source, check)).toThrow('terminal');
    source.handoffs = [target, target];
    expect(() => captureNativeHandoff(source, check)).toThrow('one static');
    const callback = vi.fn(() => target);
    const transfer = new Handoff(target, callback);
    source.handoffs = [transfer];
    const plan = captureNativeHandoff(source, check)!;
    transfer.toolDescription = 'changed';
    await expect(
      prepareNativeHandoff(plan, {
        context,
        call: functionCall(plan.declaration.name, '{}', {
          callId: 'changed-declaration',
        }),
        input: { inputHistory: '', preHandoffItems: [], newItems: [] },
        check,
      }),
    ).rejects.toThrow('configuration changed');
    expect(callback).not.toHaveBeenCalled();
  });

  it('validates the declared target before entry and returned target before hooks', async () => {
    const { source, target, context } = agents();
    const other = new Agent<Context>({ name: target.name });
    const callback = vi.fn(() => other);
    const transfer = new Handoff(target, callback);
    source.handoffs = [transfer];
    const refusal = new Error('target refused');
    expect(() =>
      captureNativeHandoff(source, (agent) => {
        if (agent === target) throw refusal;
      }),
    ).toThrow(refusal);
    expect(callback).not.toHaveBeenCalled();
    const hooks = new RunHooks<Context>();
    const event = vi.fn();
    hooks.on('agent_handoff', event);
    await expect(
      prepareNativeHandoff(captureNativeHandoff(source, check)!, {
        context,
        call: functionCall(transfer.toolName, '{}', {
          callId: 'undeclared-target',
        }),
        input: { inputHistory: '', preHandoffItems: [], newItems: [] },
        hooks,
        check,
      }),
    ).rejects.toThrow('undeclared Agent');
    expect(event).not.toHaveBeenCalled();
  });

  it('rechecks authority after callback and preserves callback and filter errors', async () => {
    const { source, target, context } = agents();
    const failure = new Error('application failure');
    const transfer = new Handoff(target, () => {
      throw failure;
    });
    source.handoffs = [transfer];
    const options = {
      context,
      call: functionCall(transfer.toolName, '{}', {
        callId: 'application-error',
      }),
      input: { inputHistory: '', preHandoffItems: [], newItems: [] },
      check,
    };
    await expect(
      prepareNativeHandoff(captureNativeHandoff(source, check)!, options),
    ).rejects.toBe(failure);
    transfer.onInvokeHandoff = () => {
      transfer.toolName = 'mutated';
      return target;
    };
    await expect(
      prepareNativeHandoff(captureNativeHandoff(source, check)!, options),
    ).rejects.toThrow('configuration changed');
    transfer.toolName = options.call.name;
    transfer.onInvokeHandoff = () => target;
    transfer.inputFilter = () => {
      throw failure;
    };
    await expect(
      prepareNativeHandoff(captureNativeHandoff(source, check)!, options),
    ).rejects.toBe(failure);
  });

  it('checks cancellation after an entered callback before emitting or filtering', async () => {
    const { source, target, context } = agents();
    const controller = new AbortController();
    const cancelled = new Error('cancelled');
    const filter = vi.fn((input: HandoffInputData) => input);
    const transfer = new Handoff(target, async () => {
      controller.abort(cancelled);
      await Promise.resolve();
      return target;
    });
    transfer.inputFilter = filter;
    source.handoffs = [transfer];
    const event = vi.fn();
    source.on('agent_handoff', event);
    await expect(
      prepareNativeHandoff(captureNativeHandoff(source, check)!, {
        context,
        call: functionCall(transfer.toolName, '{}', {
          callId: 'cancelled-handoff',
        }),
        input: { inputHistory: '', preHandoffItems: [], newItems: [] },
        check: () => controller.signal.throwIfAborted(),
      }),
    ).rejects.toBe(cancelled);
    expect(event).not.toHaveBeenCalled();
    expect(filter).not.toHaveBeenCalled();
  });
});
