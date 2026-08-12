import { beforeAll, describe, expect, it } from 'vitest';

import { setDefaultModelProvider, setTracingDisabled } from '../../src';
import { Agent, AgentOutputType } from '../../src/agent';
import { RunContext } from '../../src/runContext';
import { applyCallModelInputFilter } from '../../src/runner/conversation';
import type { AgentInputItem } from '../../src/types';
import { UserError } from '../../src/errors';
import { ScriptedModelProvider } from '../stubs';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new ScriptedModelProvider());
});

const makeAgent = (name: string) =>
  new Agent({ name }) as Agent<unknown, AgentOutputType<unknown>>;

describe('applyCallModelInputFilter', () => {
  it('returns clones and marks filter as not applied when no filter is provided', async () => {
    const agent = makeAgent('NoFilter');
    const context = new RunContext();
    const original: AgentInputItem[] = [
      { type: 'message', role: 'user', content: 'hi' },
    ];

    const result = await applyCallModelInputFilter(
      agent,
      undefined,
      context,
      original,
      'sys',
    );

    expect(result.filterApplied).toBe(false);
    expect(result.modelInput.input).toEqual(original);
    expect(result.modelInput.input[0]).not.toBe(original[0]);
    expect(result.sourceItems[0]).toBe(original[0]);
    expect(result.persistedItems).toEqual(original);
    expect(result.persistedItems[0]).not.toBe(result.modelInput.input[0]);
    expect(result.modelInput.instructions).toBe('sys');
  });

  it('maps filtered items back to originals and clones persisted items', async () => {
    const agent = makeAgent('Filter');
    const context = new RunContext();
    const first: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'secret',
    };
    const second: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'keep me',
    };

    const result = await applyCallModelInputFilter(
      agent,
      async ({ modelData }) => {
        const redacted = {
          ...(modelData.input[0] as AgentInputItem),
          content: 'redacted',
        } as AgentInputItem;
        return {
          // Reorder and mutate to exercise mapping and fallback matching.
          input: [modelData.input[1] as AgentInputItem, redacted],
          instructions: 'filtered',
        };
      },
      context,
      [first, second],
      'original sys',
    );

    expect(result.filterApplied).toBe(true);
    expect(result.modelInput.input).toHaveLength(2);
    expect(result.modelInput.instructions).toBe('filtered');
    expect(result.sourceItems).toEqual([second, first]);
    expect(result.modelInput.input[0]).not.toBe(second);
    expect(result.modelInput.input[1]).not.toBe(first);
    expect(result.persistedItems).toHaveLength(2);
    expect(result.persistedItems[0]).not.toBe(result.modelInput.input[0]);
    expect(first.content).toBe('secret');
    expect(second.content).toBe('keep me');
  });

  it('leaves sourceItems undefined for injected filter items', async () => {
    const agent = makeAgent('FilterInject');
    const context = new RunContext();
    const first: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'first',
    };
    const second: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'second',
    };

    const result = await applyCallModelInputFilter(
      agent,
      async ({ modelData }) => {
        return {
          input: [
            modelData.input[0] as AgentInputItem,
            modelData.input[1] as AgentInputItem,
            { type: 'message', role: 'user', content: 'injected' },
          ],
        };
      },
      context,
      [first, second],
      undefined,
    );

    expect(result.filterApplied).toBe(true);
    expect(result.sourceItems).toEqual([first, second, undefined]);
    expect(result.persistedItems).toHaveLength(3);
    expect(result.persistedItems[2]).toMatchObject({
      type: 'message',
      role: 'user',
      content: 'injected',
    });
  });

  it('reserves exact sources before matching equal-content injected items', async () => {
    const agent = makeAgent('FilterEqualInjection');
    const context = new RunContext();
    const original: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'same',
    };

    const result = await applyCallModelInputFilter(
      agent,
      ({ modelData }) => ({
        input: [structuredClone(modelData.input[0]), modelData.input[0]],
      }),
      context,
      [original],
      undefined,
    );

    expect(result.modelInput.input).toHaveLength(2);
    expect(result.sourceItems).toEqual([undefined, original]);
    expect(result.persistedItems).toHaveLength(2);
  });

  it('treats repeated use of one filter clone as an injected occurrence', async () => {
    const agent = makeAgent('FilterRepeatedClone');
    const context = new RunContext();
    const original: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'repeat',
    };

    const result = await applyCallModelInputFilter(
      agent,
      ({ modelData }) => ({
        input: [modelData.input[0], modelData.input[0]],
      }),
      context,
      [original],
      undefined,
    );

    expect(result.modelInput.input).toHaveLength(2);
    expect(result.sourceItems).toEqual([original, undefined]);
    expect(result.persistedItems).toHaveLength(2);
  });

  it('does not match a repeated filter clone to equal-content history', async () => {
    const agent = makeAgent('FilterRepeatedCloneEqualHistory');
    const context = new RunContext();
    const history: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'same',
    };
    const current: AgentInputItem = { ...history };

    const result = await applyCallModelInputFilter(
      agent,
      ({ modelData }) => ({
        input: [modelData.input[1], modelData.input[1]],
      }),
      context,
      [history, current],
      undefined,
    );

    expect(result.modelInput.input).toHaveLength(2);
    expect(result.sourceItems).toEqual([current, undefined]);
    expect(result.persistedItems).toHaveLength(2);
  });

  it('throws a UserError when the filter returns an invalid shape', async () => {
    const agent = makeAgent('InvalidFilter');
    const context = new RunContext();

    await expect(
      applyCallModelInputFilter(
        agent,
        async () => {
          return { input: null } as any;
        },
        context,
        [{ type: 'message', role: 'user', content: 'hi' }],
        undefined,
      ),
    ).rejects.toBeInstanceOf(UserError);
  });

  it('normalizes provider-identified duplicates after the filter returns', async () => {
    const agent = makeAgent('FilterDuplicates');
    const context = new RunContext();
    const oldCall: AgentInputItem = {
      type: 'function_call',
      callId: 'call_filter',
      name: 'lookup',
      arguments: '{"value":"old"}',
    };
    const output: AgentInputItem = {
      type: 'function_call_result',
      callId: 'call_filter',
      name: 'lookup',
      status: 'completed',
      output: 'done',
    };
    const newCall: AgentInputItem = {
      ...oldCall,
      arguments: '{"value":"new"}',
    };

    const result = await applyCallModelInputFilter(
      agent,
      ({ modelData }) => modelData,
      context,
      [oldCall, output, newCall],
      undefined,
    );

    expect(result.modelInput.input).toEqual([newCall, output]);
    expect(result.persistedItems).toEqual([newCall, output]);
    expect(result.sourceItems).toEqual([newCall, output]);
  });

  it('normalizes mixed item and call identities without a filter', async () => {
    const agent = makeAgent('MixedIdentities');
    const context = new RunContext();
    const oldCall: AgentInputItem = {
      type: 'function_call',
      id: 'item_old',
      callId: 'call_mixed',
      name: 'lookup',
      arguments: '{"value":"old"}',
    };
    const output: AgentInputItem = {
      type: 'function_call_result',
      callId: 'call_mixed',
      name: 'lookup',
      status: 'completed',
      output: 'done',
    };
    const newCall: AgentInputItem = {
      ...oldCall,
      id: undefined,
      arguments: '{"value":"new"}',
    };

    const result = await applyCallModelInputFilter(
      agent,
      undefined,
      context,
      [oldCall, output, newCall],
      undefined,
    );

    expect(result.modelInput.input).toEqual([newCall, output]);
    expect(result.persistedItems).toEqual([newCall, output]);
    expect(result.sourceItems).toEqual([newCall, output]);
  });

  it('preserves filtered duplicates with empty correlations', async () => {
    const agent = makeAgent('FilterEmptyCorrelations');
    const context = new RunContext();
    const oldCall: AgentInputItem = {
      type: 'function_call',
      callId: '',
      name: 'lookup',
      arguments: '{"value":"old"}',
    };
    const newCall: AgentInputItem = {
      ...oldCall,
      arguments: '{"value":"new"}',
    };

    const result = await applyCallModelInputFilter(
      agent,
      ({ modelData }) => modelData,
      context,
      [oldCall, newCall],
      undefined,
    );

    expect(result.modelInput.input).toEqual([oldCall, newCall]);
    expect(result.persistedItems).toEqual([oldCall, newCall]);
    expect(result.sourceItems).toEqual([oldCall, newCall]);
  });
});
