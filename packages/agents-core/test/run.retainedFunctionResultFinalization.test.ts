import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  Agent,
  computerTool,
  RunState,
  Runner,
  hostedMcpTool,
  tool,
  type AgentInputItem,
} from '../src';
import { RunContext } from '../src/runContext';
import { MemorySession } from '../src/memory/memorySession';
import { Usage } from '../src/usage';
import { FakeComputer, fakeModelMessage } from './stubs';
import { ScriptedModel, functionCall } from '../src/testing';
import {
  createResumableState,
  hostedApprovalRequest,
} from './fixtures/runState';

describe('retained function result finalization', () => {
  it('does not select a consumed receipt when a later accepted response repeats the call', async () => {
    const call = functionCall('ticket', {}, { callId: 'same-ticket' });
    const model = new ScriptedModel([
      { output: [call], usage: new Usage(), responseId: 'first-ticket' },
      {
        output: [{ ...call }, hostedApprovalRequest()],
        usage: new Usage(),
        responseId: 'repeated-ticket',
      },
      {
        output: [fakeModelMessage('done')],
        usage: new Usage(),
        responseId: 'finished',
      },
    ]);
    const execute = vi.fn(async () => 'receipt');
    const ticket = tool({
      name: 'ticket',
      description: 'Creates a ticket.',
      parameters: z.object({}),
      execute,
      customDataExtractor: () => {
        throw new Error('metadata failed');
      },
    });
    const approveRemote = vi
      .fn(async () => ({ approve: true }))
      .mockRejectedValueOnce(new Error('approval unavailable'));
    const remote = hostedMcpTool({
      serverLabel: 'demo',
      serverUrl: 'https://example.com',
      requireApproval: 'always',
      onApproval: approveRemote,
    });
    const select = vi.fn(async () => ({
      isFinalOutput: false as const,
      isInterrupted: undefined,
    }));
    const agent = new Agent({
      name: 'receipts',
      model,
      tools: [ticket, remote],
      toolUseBehavior: select,
    });
    const state = createResumableState(agent, 6);
    const conversationId = 'repeated-ticket-conversation';
    state.setConversationContext(conversationId);
    state.addInput('still staged');
    const runner = new Runner({ tracingDisabled: true });
    const options = {
      conversationId,
      callModelInputFilter: ({
        modelData,
      }: {
        modelData: { input: AgentInputItem[]; instructions?: string };
      }) => ({
        ...modelData,
        input: modelData.input.filter(
          (item) =>
            !(item.type === 'message' && item.content === 'still staged'),
        ),
      }),
    };
    await expect(runner.run(agent, state, options)).rejects.toThrow(
      'metadata failed',
    );
    const restored = await RunState.fromString(agent, state.toString());
    await expect(runner.run(agent, restored, options)).rejects.toThrow(
      'approval unavailable',
    );
    expect(model.calls).toHaveLength(2);
    expect(
      (
        await runner.run(
          agent,
          await RunState.fromString(agent, restored.toString()),
          options,
        )
      ).finalOutput,
    ).toBe('done');
    expect(select).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(3);
  });

  it('supplies a completed child run to a live selector after the parent tool end hook fails', async () => {
    const childModel = new ScriptedModel([
      { output: [fakeModelMessage('child result')], usage: new Usage() },
    ]);
    const child = new Agent({ name: 'child', model: childModel });
    const nested = child.asTool({
      toolName: 'child',
      toolDescription: 'Runs the child.',
      needsApproval: true,
    });
    const parentModel = new ScriptedModel([
      {
        output: [
          functionCall('child', { input: 'work' }, { callId: 'child-call' }),
        ],
        usage: new Usage(),
      },
    ]);
    const parent = new Agent({
      name: 'parent',
      model: parentModel,
      tools: [nested],
      toolUseBehavior: async (_context, results) => ({
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput:
          results[0]?.type === 'function_output'
            ? results[0].agentRunResult?.finalOutput
            : undefined,
      }),
    });
    const runner = new Runner({ tracingDisabled: true });
    const end = vi.fn(() => {
      throw new Error('parent hook failed');
    });
    runner.on('agent_tool_end', end);
    const parked = await runner.run(parent, 'run the child');
    parked.state.approve(parked.interruptions[0]);
    await expect(runner.run(parent, parked.state)).rejects.toThrow(
      'parent hook failed',
    );
    expect((await runner.run(parent, parked.state)).finalOutput).toBe(
      'child result',
    );
    expect(end).toHaveBeenCalledTimes(1);
    expect(childModel.calls).toHaveLength(1);
    expect(parentModel.calls).toHaveLength(1);
  });

  it('selects the failed approval receipt after an automatic sibling already completed', async () => {
    const automaticExecute = vi.fn(async () => 'automatic receipt');
    const approvedExecute = vi.fn(async () => 'approved receipt');
    const automatic = tool({
      name: 'automatic',
      description: 'Fetches the automatic receipt.',
      parameters: z.object({}),
      execute: automaticExecute,
    });
    const approved = tool({
      name: 'approved',
      description: 'Requires approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute: approvedExecute,
      customDataExtractor: () => {
        throw new Error('metadata failed');
      },
    });
    const model = new ScriptedModel([
      {
        output: [automatic, approved].map(({ name }) =>
          functionCall(name, {}, { callId: name }),
        ),
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'receipts',
      model,
      tools: [automatic, approved],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const runner = new Runner({ tracingDisabled: true });
    const parked = await runner.run(agent, 'get receipts');
    parked.state.approve(parked.interruptions[0]);
    await expect(runner.run(agent, parked.state)).rejects.toThrow(
      'metadata failed',
    );
    const restored = await RunState.fromString(agent, parked.state.toString());
    expect((await runner.run(agent, restored)).finalOutput).toBe(
      'approved receipt',
    );
    expect(automaticExecute).toHaveBeenCalledTimes(1);
    expect(approvedExecute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it.each(['first', 'custom'] as const)(
    'preserves a failed receipt across a computer rejection for the %s selector',
    async (behavior) => {
      const executeFirst = vi.fn(async () => 'first receipt');
      const executeSecond = vi.fn(async () => 'second receipt');
      const extract = vi.fn(() => {
        throw new Error('metadata unavailable');
      });
      const first = tool({
        name: 'first',
        description: 'Produces the first receipt.',
        parameters: z.object({}),
        needsApproval: true,
        execute: executeFirst,
        customDataExtractor: extract,
      });
      const second = tool({
        name: 'second',
        description: 'Produces the second receipt.',
        parameters: z.object({}),
        needsApproval: true,
        execute: executeSecond,
      });
      const computer = new FakeComputer();
      const screenshot = vi.spyOn(computer, 'screenshot');
      const model = new ScriptedModel([
        {
          output: [
            functionCall('first', {}, { callId: 'first-call' }),
            functionCall('second', {}, { callId: 'second-call' }),
            {
              type: 'computer_call',
              id: 'screen',
              callId: 'screen',
              status: 'completed',
              action: { type: 'screenshot' },
            },
          ],
          usage: new Usage(),
        },
      ]);
      const select = vi.fn((values: unknown[]) => ({
        isFinalOutput: true as const,
        isInterrupted: undefined,
        finalOutput: JSON.stringify(values),
      }));
      const agent = new Agent({
        name: 'receipts',
        model,
        tools: [first, second, computerTool({ computer, needsApproval: true })],
        toolUseBehavior:
          behavior === 'first'
            ? 'stop_on_first_tool'
            : async (_ctx, results) =>
                select(
                  results.map(
                    (result) =>
                      result.type === 'function_output' && result.output,
                  ),
                ),
      });
      const runner = new Runner({ tracingDisabled: true });
      const parked = await runner.run(agent, 'collect receipts');
      expect(parked.interruptions).toHaveLength(3);
      parked.state.approve(
        parked.interruptions.find((item) => item.name === 'first')!,
      );
      await expect(runner.run(agent, parked.state)).rejects.toThrow(
        'metadata unavailable',
      );
      const failed = await RunState.fromString(agent, parked.state.toString());
      failed.reject(
        failed
          .getInterruptions()
          .find((item) => item.rawItem.type === 'computer_call')!,
        { message: 'Screen access declined' },
      );
      const partial = await runner.run(agent, failed);
      expect(partial.interruptions.map((item) => item.name)).toEqual([
        'second',
      ]);
      expect(partial.newItems).toContainEqual(
        expect.objectContaining({
          type: 'message_output_item',
          rawItem: expect.objectContaining({
            content: [{ type: 'output_text', text: 'Screen access declined' }],
          }),
        }),
      );
      expect(select).not.toHaveBeenCalled();
      const restored = await RunState.fromString(
        agent,
        partial.state.toString(),
      );
      restored.approve(restored.getInterruptions()[0]);
      const completed = await runner.run(agent, restored);
      expect(completed.finalOutput).toBe(
        behavior === 'first'
          ? 'first receipt'
          : JSON.stringify(['first receipt', 'second receipt']),
      );
      expect(executeFirst).toHaveBeenCalledTimes(1);
      expect(executeSecond).toHaveBeenCalledTimes(1);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(screenshot).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(1);
      expect(
        completed.history
          .filter((item) => item.type === 'function_call_result')
          .map((item) => item.callId),
      ).toEqual(['first-call', 'second-call']);
    },
  );

  it('excludes a recovered approval receipt when a later interrupted turn repeats its call', async () => {
    const firstCall = functionCall('first', {}, { callId: 'first-call' });
    const secondCall = functionCall('second', {}, { callId: 'second-call' });
    const executeFirst = vi.fn(async () => 'first receipt');
    const first = tool({
      name: 'first',
      description: 'Produces the first receipt.',
      parameters: z.object({}),
      needsApproval: true,
      execute: executeFirst,
      customDataExtractor: () => {
        throw new Error('metadata unavailable');
      },
    });
    const second = tool({
      name: 'second',
      description: 'Produces the second receipt.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'second receipt',
    });
    const model = new ScriptedModel([
      { output: [firstCall], usage: new Usage() },
      { output: [{ ...firstCall }, secondCall], usage: new Usage() },
    ]);
    const batches: unknown[][] = [];
    const agent = new Agent({
      name: 'receipts',
      model,
      tools: [first, second],
      toolUseBehavior: async (_context, results) => {
        const outputs = results.map(
          (result) => result.type === 'function_output' && result.output,
        );
        batches.push(outputs);
        return outputs.includes('second receipt')
          ? {
              isFinalOutput: true,
              isInterrupted: undefined,
              finalOutput: 'done',
            }
          : { isFinalOutput: false, isInterrupted: undefined };
      },
    });
    const runner = new Runner({ tracingDisabled: true });
    const parked = await runner.run(agent, 'collect receipts');
    parked.state.approve(parked.interruptions[0]);
    await expect(runner.run(agent, parked.state)).rejects.toThrow(
      'metadata unavailable',
    );
    const next = await runner.run(agent, parked.state);
    expect(next.interruptions.map((item) => item.name)).toEqual(['second']);
    const restored = await RunState.fromString(agent, next.state.toString());
    restored.approve(restored.getInterruptions()[0]);
    expect((await runner.run(agent, restored)).finalOutput).toBe('done');
    expect(batches).toEqual([['first receipt'], ['second receipt']]);
    expect(executeFirst).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(2);
  });

  it('round-trips a replacement approval for a tool that already ran automatically', async () => {
    let reviewRequired = true;
    const receipt = tool({
      name: 'receipt',
      description: 'Produces a receipt.',
      parameters: z.object({}),
      needsApproval: async () => reviewRequired,
      execute: async () => 'receipt',
    });
    const finish = tool({
      name: 'finish',
      description: 'Finishes the task.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'done',
    });
    const output = [receipt, finish].map(({ name }) =>
      functionCall(name, {}, { callId: name }),
    );
    const model = new ScriptedModel([
      { output, usage: new Usage() },
      { output, usage: new Usage() },
    ]);
    const agent = new Agent({
      name: 'receipts',
      model,
      tools: [receipt, finish],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const runner = new Runner({ tracingDisabled: true });
    const review = await runner.run(agent, 'review', {
      context: { review: true },
    });
    const replacement = new RunContext({ review: true });
    replacement.approveTool(review.interruptions[0]);
    reviewRequired = false;
    const automatic = await runner.run(agent, 'work');
    const state = await RunState.fromStringWithContext(
      agent,
      automatic.state.toString(),
      replacement,
      { contextStrategy: 'replace' },
    );
    const restored = await RunState.fromString(agent, state.toString());
    expect(restored.toJSON().$schemaVersion).toBe('1.23');
    restored.approve(restored.getInterruptions()[0]);
    expect((await runner.run(agent, restored)).finalOutput).toBe('done');
  });

  it('selects the first retained result when a sibling granted sticky approval', async () => {
    const execute = vi.fn(async ({ n }: { n: number }) => 'receipt ' + n);
    const extract = vi.fn(({ input }) => {
      if (input.n === 1) throw new Error('metadata failed');
      return { receiptNumber: input.n };
    });
    const receipt = tool({
      name: 'receipt',
      description: 'Issues a numbered receipt.',
      parameters: z.object({ n: z.number() }),
      needsApproval: true,
      execute,
      customDataExtractor: extract,
    });
    const model = new ScriptedModel([
      {
        output: [1, 2].map((n) =>
          functionCall('receipt', { n }, { callId: 'receipt-' + n }),
        ),
        usage: new Usage(),
      },
    ]);
    const agent = new Agent({
      name: 'receipts',
      model,
      tools: [receipt],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const runner = new Runner({
      tracingDisabled: true,
      toolExecution: { maxFunctionToolConcurrency: 1 },
    });
    const parked = await runner.run(agent, 'get both receipts');
    parked.state.approve(parked.interruptions[1], { alwaysApprove: true });
    await expect(runner.run(agent, parked.state)).rejects.toThrow(
      'metadata failed',
    );
    const snapshot = parked.state.toJSON();
    expect(snapshot.$schemaVersion).toBe('1.25');
    const parent = new RunState(new RunContext(), '', agent, 5);
    parent.setPendingAgentToolRun(
      'child',
      'child-call',
      JSON.stringify(snapshot),
    );
    expect(parent.toJSON().$schemaVersion).toBe('1.25');

    await expect(
      RunState.fromString(
        agent,
        JSON.stringify({ ...snapshot, $schemaVersion: '1.23' }),
      ),
    ).rejects.toThrow(/requires RunState schema 1.25/);
    const restored = await RunState.fromString(agent, parked.state.toString());
    expect((await runner.run(agent, restored)).finalOutput).toBe('receipt 1');
    expect(execute.mock.calls.map(([{ n }]) => n)).toEqual([1, 2]);
    expect(extract).toHaveBeenCalledTimes(2);
    expect(model.calls).toHaveLength(1);
  });

  it.each(['first', 'named', 'custom'] as const)(
    'finalizes a restored approval using the retained result with a %s stop',
    async (behavior) => {
      const receipt = { ticket: 'T-1' };
      const execute = vi.fn(async () => receipt);
      const extract = vi.fn(() => {
        throw new Error('metadata unavailable');
      });
      const ticket = tool({
        name: 'ticket',
        description: 'Opens a ticket.',
        parameters: z.object({}),
        needsApproval: true,
        execute,
        customDataExtractor: extract,
      });
      const confirm = tool({
        name: 'confirm',
        description: 'Confirms the ticket.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'confirmed',
      });
      const selected = vi.fn((results: unknown[]) => ({
        isInterrupted: undefined,
        isFinalOutput: true as const,
        finalOutput: JSON.stringify(results),
      }));
      const tools = behavior === 'custom' ? [ticket, confirm] : [ticket];
      const model = new ScriptedModel([
        {
          output: tools.map(({ name }) =>
            functionCall(name, {}, { callId: name }),
          ),
          usage: new Usage(),
        },
        {
          output: [fakeModelMessage('unexpected extra turn')],
          usage: new Usage(),
        },
      ]);
      const agent = new Agent({
        name: 'tickets',
        model,
        tools,
        toolUseBehavior:
          behavior === 'first'
            ? 'stop_on_first_tool'
            : behavior === 'named'
              ? { stopAtToolNames: ['ticket'] }
              : async (_context, results) =>
                  selected(
                    results.map(
                      (result) =>
                        result.type === 'function_output' && [
                          result.tool.name,
                          result.output,
                        ],
                    ),
                  ),
      });
      const runner = new Runner({
        tracingDisabled: true,
        toolExecution: { maxFunctionToolConcurrency: 1 },
      });
      const session = new MemorySession();
      const parked = await runner.run(agent, 'open a ticket', { session });
      parked.state.approve(parked.interruptions[0]);
      await expect(
        runner.run(agent, parked.state, { session }),
      ).rejects.toThrow('metadata unavailable');
      // The replacement context must still decide the unexecuted sibling.
      if (behavior === 'custom') parked.state.approve(parked.interruptions[1]);
      const restored = await RunState.fromStringWithContext(
        agent,
        parked.state.toString(),
        new RunContext<unknown>({}),
        { contextStrategy: 'replace' },
      );
      if (behavior === 'custom') {
        const pending = await runner.run(agent, restored, { session });
        expect(pending.interruptions.map((approval) => approval.name)).toEqual([
          'confirm',
        ]);
        restored.approve(pending.interruptions[0]);
      }
      const resumed = await runner.run(agent, restored, { session });
      expect(resumed.finalOutput).toBe(
        behavior === 'custom'
          ? JSON.stringify([
              ['ticket', receipt],
              ['confirm', 'confirmed'],
            ])
          : JSON.stringify(receipt),
      );
      expect(selected).toHaveBeenCalledTimes(behavior === 'custom' ? 1 : 0);
      expect(model.calls).toHaveLength(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(extract).toHaveBeenCalledTimes(1);
      expect(
        (await session.getItems())
          .filter((item) => item.type === 'function_call_result')
          .map((item) => item.callId),
      ).toEqual(tools.map(({ name }) => name));
    },
  );
});
