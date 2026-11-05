import { describe, expect, it } from 'vitest';
import { Agent, RunToolApprovalItem } from '@openai/agents-core';
import { approvalDecision } from '../../src/migration/approvals';

function fixture() {
  const agent = new Agent({ name: 'Held function' });
  const call = {
    type: 'function_call' as const,
    callId: 'actual-model-call',
    name: 'lookup',
    arguments: '{}',
  };
  const item = new RunToolApprovalItem(call, agent);
  const controller = new AbortController();
  return {
    item,
    controller,
    decision: approvalDecision(item, controller.signal),
  };
}

describe('one live SDK tool approval decision', () => {
  it('does not release its owner until an approval is explicitly continued', async () => {
    const { item, decision } = fixture();
    let released = false;
    const owner = decision.wait.then((value) => {
      released = true;
      return value;
    });
    decision.approve(item);
    await Promise.resolve();
    expect(released).toBe(false);
    expect(decision.continue()).toBe(decision.continue());
    await expect(owner).resolves.toBe('approve');
    expect(item.rawItem).toMatchObject({ callId: 'actual-model-call' });
  });

  it('releases rejection without granting approval', async () => {
    const { item, decision } = fixture();
    decision.reject(item);
    await expect(decision.continue()).resolves.toBe('reject');
  });

  it('rejects copied or foreign items and unchosen continuation', () => {
    const { item, decision } = fixture();
    expect(() => decision.continue()).toThrow('Approve or reject');
    expect(() => decision.approve({ ...item } as RunToolApprovalItem)).toThrow(
      'exact live item',
    );
    expect(() =>
      decision.reject(new RunToolApprovalItem(item.rawItem, item.agent)),
    ).toThrow('exact live item');
    decision.reject(item);
    expect(() => decision.approve(item)).toThrow('already has a decision');
    void decision.continue();
  });

  it('revokes a selected but uncontinued decision on native-owner cancellation', async () => {
    const { item, controller, decision } = fixture();
    decision.approve(item);
    const reason = new Error('Native owner stopped');
    controller.abort(reason);
    await expect(decision.wait).rejects.toBe(reason);
    expect(() => decision.continue()).toThrow(reason);
    expect(() => decision.reject(item)).toThrow(reason);
  });

  it('keeps an already released choice while the native owner handles later cancellation', async () => {
    const { item, controller, decision } = fixture();
    decision.approve(item);
    const continued = decision.continue();
    controller.abort(new Error('Later native stop'));
    await expect(continued).resolves.toBe('approve');
  });
});

import { tool } from '@openai/agents-core';
import { ScriptedModel } from '@openai/agents-core/testing';
import { z } from 'zod';
import { capture } from '../../src/migration/run';

function heldAgent(needsApproval: boolean | (() => Promise<boolean>) = true) {
  const execute = () => 'done';
  const options = {
    name: 'lookup',
    description: 'Read a value',
    parameters: z.object({}),
    needsApproval,
    execute,
  };
  const fn = tool(options);
  const agent = new Agent({
    name: 'Held',
    model: new ScriptedModel([]),
    tools: [fn],
  });
  return { agent, fn, options };
}

describe('held function declaration admission', () => {
  it('preserves the default approval-free refusal and captures the explicit static opt-in', () => {
    const { agent, options } = heldAgent();
    expect(() => capture(agent, 'Hi', { context: undefined })).toThrow(
      'approval-free',
    );
    const captured = capture(agent, 'Hi', {
      context: undefined,
      approvals: 'manual',
    });
    options.needsApproval = false;
    expect(captured.tools[0].approval).toBe(true);
    expect(captured.approvals).toBe('manual');
  });

  it('rejects unsupported predicates without calling them', () => {
    let policies = 0;
    const { agent } = heldAgent(async () => {
      policies++;
      return true;
    });
    expect(() =>
      capture(agent, 'Hi', { context: undefined, approvals: 'manual' }),
    ).toThrow();
    expect(policies).toBe(0);
  });

  it('rejects live-stream approval opt-in and multiple declarations before work', () => {
    const { agent } = heldAgent();
    expect(() =>
      capture(
        agent,
        'Hi',
        { context: undefined, approvals: 'manual' },
        'stream',
      ),
    ).toThrow('stream()');
    agent.tools.push(
      tool({
        name: 'other',
        description: 'Other',
        parameters: z.object({}),
        execute: () => 'other',
      }),
    );
    expect(() =>
      capture(agent, 'Hi', { context: undefined, approvals: 'manual' }),
    ).toThrow('one enabled');
  });

  it('retains registered invoker and Agent.asTool ownership checks', () => {
    const { agent, fn } = heldAgent();
    agent.tools = [{ ...fn, invoke: async () => 'custom' }];
    expect(() =>
      capture(agent, 'Hi', { context: undefined, approvals: 'manual' }),
    ).toThrow('registered');
    agent.tools = [
      new Agent({ name: 'Child' }).asTool({
        toolName: 'child',
        toolDescription: 'Child',
      }),
    ];
    expect(() =>
      capture(agent, 'Hi', { context: undefined, approvals: 'manual' }),
    ).toThrow('ordinary registered');
  });
});
