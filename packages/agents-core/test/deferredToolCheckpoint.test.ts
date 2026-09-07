import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Agent } from '../src/agent';
import { OutputGuardrailTripwireTriggered, UserError } from '../src/errors';
import { Runner } from '../src/run';
import { handoff } from '../src/handoff';
import { RunState } from '../src/runState';
import { attachClientToolSearchExecutor, tool } from '../src/tool';
import { ScriptedModel, assistantMessage, functionCall } from '../src/testing';
import type * as protocol from '../src/types/protocol';

type Scenario = {
  stream?: boolean;
  needsApproval?: boolean;
  clientSearch?: boolean;
  selfNamespaced?: boolean;
  bareOwner?: boolean;
  legacyPending?: boolean;
  searchInInput?: boolean;
  searchViaAddInput?: boolean;
};

async function pauseAfterDeferredTool({
  stream = false,
  needsApproval = true,
  clientSearch = false,
  selfNamespaced = false,
  bareOwner = false,
  legacyPending = false,
  searchInInput = false,
  searchViaAddInput = false,
}: Scenario = {}) {
  const execute = vi.fn(async () => 'deferred result');
  const bareExecute = vi.fn(async () => 'bare result');
  const nextExecute = vi.fn(async () => 'next result');
  const deferred = tool({
    name: 'lookup',
    description: 'Look up a record.',
    parameters: z.object({ value: z.string() }),
    deferLoading: true,
    needsApproval,
    execute,
  });
  const bare = tool({
    name: 'lookup',
    description: 'Look up a record immediately.',
    parameters: z.object({ value: z.string() }),
    needsApproval,
    execute: bareExecute,
  });
  const next = tool({
    name: 'next_step',
    description: 'Perform the next step.',
    parameters: z.object({}),
    needsApproval: true,
    execute: nextExecute,
  });
  const search = {
    type: 'hosted_tool' as const,
    name: 'tool_search',
    providerData: {
      type: 'tool_search',
      execution: clientSearch ? 'client' : 'server',
    },
  };
  const searchTool = clientSearch
    ? attachClientToolSearchExecutor(search, async () => deferred)
    : search;
  const searchCall: protocol.ToolSearchCallItem = {
    type: 'tool_search_call',
    id: 'search_item',
    status: 'completed',
    arguments: { paths: ['lookup'] },
    providerData: {
      execution: clientSearch ? 'client' : 'server',
      call_id: clientSearch ? 'search_call' : null,
    },
  };
  const searchOutput: protocol.ToolSearchOutputItem = {
    type: 'tool_search_output',
    id: 'search_output',
    toolSearchAgentName: 'DeferredCheckpointAgent',
    status: 'completed',
    tools: [
      {
        type: 'function',
        name: 'lookup',
        description: deferred.description,
        parameters: deferred.parameters,
        strict: true,
        defer_loading: true,
      },
    ],
    providerData: { execution: 'server', call_id: null },
  };
  const firstCall = functionCall(
    'lookup',
    { value: 'first' },
    {
      callId: 'lookup_call',
      ...(selfNamespaced ? { namespace: 'lookup' } : {}),
    },
  );
  const prepare = tool({
    name: 'prepare',
    description: 'Prepare the lookup.',
    parameters: z.object({}),
    needsApproval: true,
    execute: async () => 'ready',
  });
  const model = new ScriptedModel([
    ...(searchViaAddInput
      ? [[functionCall('prepare', {}, { callId: 'prepare_call' })]]
      : []),
    [
      ...(searchInInput || searchViaAddInput
        ? []
        : [searchCall, ...(clientSearch ? [] : [searchOutput])]),
      firstCall,
    ],
    [functionCall('next_step', {}, { callId: 'next_call' })],
  ]);
  const makeAgent = () =>
    new Agent({
      name: 'DeferredCheckpointAgent',
      model,
      tools: [
        searchTool,
        ...(searchViaAddInput ? [prepare] : []),
        ...(clientSearch ? [] : [deferred]),
        ...(bareOwner ? [bare] : []),
        next,
      ],
    });
  let agent = makeAgent();
  const runner = new Runner({ tracingDisabled: true });
  const run = async (
    input: string | protocol.OutputModelItem[] | RunState<any, Agent<any, any>>,
  ) => {
    if (stream) {
      const result = await runner.run(agent, input, { stream: true });
      for await (const _event of result) {
        // Drain the stream so the checkpoint includes the completed turn.
      }
      await result.completed;
      return result;
    }
    return runner.run(agent, input);
  };
  let result = await run(
    searchInInput
      ? [searchCall, searchOutput]
      : 'Look up a record, then perform the next step.',
  );
  if (searchViaAddInput) {
    const restored = await RunState.fromString(agent, result.state.toString());
    restored.addInput([searchCall, searchOutput]);
    restored.approve(restored.getInterruptions()[0]);
    result = await run(restored);
  }
  if (needsApproval) {
    expect(result.interruptions).toHaveLength(1);
    expect(execute).not.toHaveBeenCalled();
    expect(bareExecute).not.toHaveBeenCalled();
    const checkpoint = JSON.stringify(result.state.toJSON(), (_key, value) => {
      if (legacyPending && value?.type === 'tool_call_item') {
        const { functionToolStateKey: _identity, ...legacyItem } = value;
        return legacyItem;
      }
      return value;
    });
    agent = makeAgent();
    const restored = await RunState.fromString(agent, checkpoint);
    restored.approve(restored.getInterruptions()[0]);
    result = await run(restored);
  }
  expect(result.interruptions).toHaveLength(1);
  expect(result.interruptions[0].rawItem).toMatchObject({
    callId: 'next_call',
  });
  expect(execute).toHaveBeenCalledTimes(bareOwner ? 0 : 1);
  expect(bareExecute).toHaveBeenCalledTimes(bareOwner ? 1 : 0);
  expect(nextExecute).not.toHaveBeenCalled();
  return {
    agent,
    model,
    run,
    result,
    firstCall,
    execute,
    bare,
    bareExecute,
    nextExecute,
  };
}

describe('deferred function checkpoints', () => {
  it.each([
    { label: 'server search', scenario: {} },
    {
      label: 'search admitted with addInput',
      scenario: { searchViaAddInput: true },
    },
    {
      label: 'search supplied in input history',
      scenario: { searchInInput: true },
    },
    { label: 'streamed server search', scenario: { stream: true } },
    { label: 'execution without approval', scenario: { needsApproval: false } },
    { label: 'client search runtime tool', scenario: { clientSearch: true } },
    { label: 'self-namespaced call', scenario: { selfNamespaced: true } },
    { label: 'same-name immediate owner', scenario: { bareOwner: true } },
    { label: 'older pending call metadata', scenario: { legacyPending: true } },
  ])(
    'saves and resumes a second approval after $label',
    async ({ scenario }) => {
      const {
        agent,
        model,
        run,
        result,
        firstCall,
        execute,
        bareExecute,
        nextExecute,
      } = await pauseAfterDeferredTool(scenario);
      const checkpoint = result.state.toString();
      expect(result.state.toString()).toBe(checkpoint);
      expect(JSON.stringify(result.state.toJSON())).toBe(checkpoint);
      const restored = await RunState.fromString(agent, checkpoint);
      // A repeated completed call must not repeat the tool's side effect.
      model.enqueue([firstCall], [assistantMessage('done')]);
      restored.approve(restored.getInterruptions()[0]);
      const final = await run(restored);
      expect(final.finalOutput).toBe('done');
      expect(execute.mock.calls.length + bareExecute.mock.calls.length).toBe(1);
      expect(nextExecute).toHaveBeenCalledTimes(1);
      expect(() => final.state.toString()).not.toThrow();
    },
  );

  it('rejects call metadata that conflicts with completion fingerprints', async () => {
    const bareExecute = vi.fn(async () => 'bare result');
    const deferredExecute = vi.fn(async () => 'deferred result');
    const nextExecute = vi.fn(async () => 'next result');
    const bare = tool({
      name: 'lookup',
      description: 'Look up a record.',
      parameters: z.object({}),
      execute: bareExecute,
    });
    const deferred = tool({
      name: 'lookup',
      description: 'Look up a record after search.',
      parameters: z.object({}),
      deferLoading: true,
      execute: deferredExecute,
    });
    const next = tool({
      name: 'next_step',
      description: 'Perform the next step.',
      parameters: z.object({}),
      needsApproval: true,
      execute: nextExecute,
    });
    const model = new ScriptedModel([
      [functionCall('lookup', {}, { callId: 'lookup_call' })],
      [functionCall('next_step', {}, { callId: 'next_call' })],
    ]);
    const agent = new Agent({ name: 'Agent', tools: [bare, next], model });
    const result = await new Runner({ tracingDisabled: true }).run(
      agent,
      'start',
    );
    const checkpoint = result.state.toJSON();
    const completed = checkpoint.completedToolInvocations![0].invocations;
    const fingerprint = JSON.parse(completed.lookup_call);
    fingerprint.toolName = '["deferred_top_level","lookup"]';
    for (const item of checkpoint.generatedItems) {
      if (
        item.type === 'tool_call_item' &&
        item.rawItem.type === 'function_call' &&
        item.rawItem.callId === 'lookup_call'
      ) {
        item.functionToolStateKey = fingerprint.toolName;
      }
    }
    const replacement = new Agent({
      name: 'Agent',
      tools: [deferred, next],
      model,
    });

    await expect(
      RunState.fromString(replacement, JSON.stringify(checkpoint)),
    ).rejects.toThrow(UserError);
    expect(bareExecute).toHaveBeenCalledTimes(1);
    expect(deferredExecute).not.toHaveBeenCalled();
    expect(nextExecute).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'saves a redacted terminal deferred call (stream: %s)',
    async (stream) => {
      const execute = vi.fn(async () => 'sensitive result');
      const deferred = tool({
        name: 'lookup',
        description: 'Look up a record.',
        parameters: z.object({}),
        deferLoading: true,
        execute,
      });
      const searchOutput: protocol.ToolSearchOutputItem = {
        type: 'tool_search_output',
        id: 'search_output',
        status: 'completed',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            parameters: deferred.parameters,
            description: deferred.description,
            strict: true,
            defer_loading: true,
          },
        ],
        providerData: { execution: 'server', call_id: null },
      };
      const model = new ScriptedModel([
        [searchOutput],
        [functionCall('lookup', {}, { callId: 'terminal_call' })],
      ]);
      const agent = new Agent({
        name: 'TerminalAgent',
        model,
        tools: [
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search', execution: 'server' },
          },
          deferred,
        ],
        toolUseBehavior: { stopAtToolNames: ['lookup'] },
        outputGuardrails: [
          {
            name: 'block',
            execute: async () => ({
              tripwireTriggered: true,
              outputInfo: undefined,
            }),
          },
        ],
      });
      const runner = new Runner({ tracingDisabled: true });
      let tripwire: OutputGuardrailTripwireTriggered<any, any> | undefined;
      try {
        if (stream) {
          const result = await runner.run(agent, 'start', { stream: true });
          await result.completed;
        } else {
          await runner.run(agent, 'start');
        }
      } catch (error) {
        expect(error).toBeInstanceOf(OutputGuardrailTripwireTriggered);
        tripwire = error as OutputGuardrailTripwireTriggered<any, any>;
      }
      expect(tripwire).toBeDefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(tripwire!.state).toBeDefined();
      const checkpoint = tripwire!.state!.toString();
      expect(checkpoint).not.toContain('sensitive result');
      const restored = await RunState.fromString(agent, checkpoint);
      expect(() => restored.toString()).not.toThrow();
    },
  );

  it.each([
    {
      label: 'admitted search across a handoff',
      admitted: true,
      sameName: false,
      ownSearch: false,
      stream: false,
    },
    {
      label: 'model search from a same-name agent',
      admitted: false,
      sameName: true,
      ownSearch: false,
      stream: true,
    },
    {
      label: 'the receiving agent searches independently',
      admitted: true,
      sameName: true,
      ownSearch: true,
      stream: false,
    },
  ])(
    'enforces search ownership for $label',
    async ({ admitted, sameName, ownSearch, stream }) => {
      const execute = vi.fn(async () => 'lookup result');
      const lookup = tool({
        name: 'lookup',
        description: 'Look up a record.',
        parameters: z.object({}),
        deferLoading: true,
        execute,
      });
      const prepare = tool({
        name: 'prepare',
        description: 'Prepare the lookup.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'ready',
      });
      const next = tool({
        name: 'next_step',
        description: 'Continue.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'next',
      });
      const search = {
        type: 'hosted_tool' as const,
        name: 'tool_search',
        providerData: { type: 'tool_search', execution: 'server' },
      };
      const searchOutput: protocol.ToolSearchOutputItem = {
        type: 'tool_search_output',
        id: 'source_search',
        status: 'completed',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            description: lookup.description,
            parameters: lookup.parameters,
            strict: true,
            defer_loading: true,
          },
        ],
        providerData: { execution: 'server', call_id: null },
      };
      const call = functionCall('lookup', {}, { callId: 'lookup_call' });
      const targetModel = new ScriptedModel([
        [
          ...(ownSearch ? [{ ...searchOutput, id: 'target_search' }] : []),
          call,
        ],
        [functionCall('next_step', {}, { callId: 'next_call' })],
      ]);
      const target = new Agent({
        name: sameName ? 'SharedAgent' : 'TargetAgent',
        tools: [search, lookup, next],
        model: targetModel,
      });
      const source = new Agent({
        name: sameName ? 'SharedAgent' : 'SourceAgent',
        tools: [search, prepare, lookup],
        handoffs: [handoff(target, { toolNameOverride: 'transfer_target' })],
        model: new ScriptedModel([
          [
            ...(admitted ? [] : [searchOutput]),
            functionCall('prepare', {}, { callId: 'prepare_call' }),
          ],
          [functionCall('transfer_target', {}, { callId: 'handoff_call' })],
        ]),
      });
      const runner = new Runner({ tracingDisabled: true });
      const paused = await runner.run(source, 'start');
      const restored = await RunState.fromString(
        source,
        paused.state.toString(),
      );
      if (admitted) restored.addInput([searchOutput]);
      restored.approve(restored.getInterruptions()[0]);
      const resume = async () => {
        if (stream) {
          const result = await runner.run(source, restored, { stream: true });
          await result.completed;
          return result;
        }
        return runner.run(source, restored);
      };
      if (!ownSearch) {
        await expect(resume()).rejects.toThrow(
          /before it was loaded via tool_search/,
        );
        expect(execute).not.toHaveBeenCalled();
        expect(() => restored.toString()).not.toThrow();
        return;
      }
      const result = await resume();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(result.interruptions).toHaveLength(1);
      const checkpoint = await RunState.fromString(
        source,
        result.state.toString(),
      );
      checkpoint.approve(checkpoint.getInterruptions()[0]);
      targetModel.enqueue([call], [assistantMessage('done')]);
      const final = await runner.run(source, checkpoint);
      expect(final.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(() => final.state.toString()).not.toThrow();
    },
  );

  it.each([false, true])(
    'preserves completed calls after a handoff filters search history (stream: %s)',
    async (stream) => {
      const execute = vi.fn(async () => 'lookup result');
      const nextExecute = vi.fn(async () => 'next result');
      const lookup = tool({
        name: 'lookup',
        description: 'Look up a record.',
        parameters: z.object({}),
        deferLoading: true,
        needsApproval: true,
        execute,
      });
      const next = tool({
        name: 'next_step',
        description: 'Continue.',
        parameters: z.object({}),
        needsApproval: true,
        execute: nextExecute,
      });
      const target = new Agent({
        name: 'Target',
        tools: [next],
        model: new ScriptedModel([
          [functionCall('next_step', {}, { callId: 'next_call' })],
          [assistantMessage('done')],
        ]),
      });
      const searchOutput: protocol.ToolSearchOutputItem = {
        type: 'tool_search_output',
        id: 'search_output',
        status: 'completed',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            description: lookup.description,
            parameters: lookup.parameters,
            strict: true,
            defer_loading: true,
          },
        ],
        providerData: { execution: 'server', call_id: null },
      };
      const source = new Agent({
        name: 'Source',
        tools: [
          lookup,
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search', execution: 'server' },
          },
        ],
        handoffs: [
          handoff(target, {
            toolNameOverride: 'transfer_to_target',
            inputFilter: (data) => ({
              ...data,
              preHandoffItems: data.preHandoffItems.filter(
                (item) => item.rawItem.type !== 'tool_search_output',
              ),
            }),
          }),
        ],
        model: new ScriptedModel([
          [searchOutput, functionCall('lookup', {}, { callId: 'lookup_call' })],
          [functionCall('transfer_to_target', {}, { callId: 'handoff_call' })],
        ]),
      });
      const runner = new Runner({ tracingDisabled: true });
      const run = async (input: string | RunState<any, Agent<any, any>>) => {
        if (stream) {
          const result = await runner.run(source, input, { stream: true });
          await result.completed;
          return result;
        }
        return runner.run(source, input);
      };
      const initial = await run('start');
      expect(execute).not.toHaveBeenCalled();
      const approved = await RunState.fromString(
        source,
        initial.state.toString(),
      );
      approved.approve(approved.getInterruptions()[0]);
      const paused = await run(approved);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(nextExecute).not.toHaveBeenCalled();
      expect(
        paused.newItems.some(
          (item) => item.rawItem.type === 'tool_search_output',
        ),
      ).toBe(false);
      expect(
        paused.newItems.some(
          (item) =>
            item.rawItem.type === 'function_call' &&
            item.rawItem.callId === 'lookup_call',
        ),
      ).toBe(true);
      expect(
        paused.newItems.some(
          (item) =>
            item.rawItem.type === 'function_call_result' &&
            item.rawItem.callId === 'lookup_call',
        ),
      ).toBe(true);
      const restored = await RunState.fromString(
        source,
        paused.state.toString(),
      );
      restored.approve(restored.getInterruptions()[0]);
      const final = await run(restored);
      expect(final.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(nextExecute).toHaveBeenCalledTimes(1);
      expect(() => final.state.toString()).not.toThrow();
    },
  );

  it.each([false, true])(
    'requires discovery after replayed compaction (stream: %s)',
    async (stream) => {
      const execute = vi.fn(async () => 'lookup result');
      let requireApproval = false;
      const lookup = tool({
        name: 'lookup',
        description: 'Look up a record.',
        parameters: z.object({}),
        deferLoading: true,
        needsApproval: async () => requireApproval,
        execute,
      });
      const searchOutput: protocol.ToolSearchOutputItem = {
        type: 'tool_search_output',
        id: 'old_search',
        status: 'completed',
        toolSearchAgentName: 'Agent',
        tools: [
          {
            type: 'function',
            name: 'lookup',
            description: lookup.description,
            parameters: lookup.parameters,
            strict: true,
            defer_loading: true,
          },
        ],
        providerData: { execution: 'server', call_id: null },
      };
      const compaction: protocol.CompactionItem = {
        type: 'compaction',
        id: 'compaction',
        encrypted_content: 'compacted-history',
      };
      const call = functionCall('lookup', {}, { callId: 'lookup_call' });
      const model = new ScriptedModel([[call], [assistantMessage('done')]]);
      const agent = new Agent({
        name: 'Agent',
        tools: [
          lookup,
          {
            type: 'hosted_tool',
            name: 'tool_search',
            providerData: { type: 'tool_search', execution: 'server' },
          },
        ],
        model,
      });
      const runner = new Runner({ tracingDisabled: true });
      const run = async (
        input: protocol.ModelItem[] | RunState<any, Agent<any, any>>,
      ) => {
        if (stream) {
          const result = await runner.run(agent, input, { stream: true });
          await result.completed;
          return result;
        }
        return runner.run(agent, input);
      };
      const input = [searchOutput, compaction];
      await expect(run(input)).rejects.toThrow(
        /before it was loaded via tool_search/,
      );
      expect(execute).not.toHaveBeenCalled();
      expect(model.calls[0].request.input).toEqual([compaction]);

      const freshModel = new ScriptedModel([
        [{ ...searchOutput, id: 'fresh_search' }],
        [call],
        [assistantMessage('done')],
      ]);
      agent.model = freshModel;
      requireApproval = true;
      const paused = await run(input);
      expect(paused.interruptions).toHaveLength(1);
      expect(execute).not.toHaveBeenCalled();
      const restored = await RunState.fromString(
        agent,
        paused.state.toString(),
      );
      restored.approve(restored.getInterruptions()[0]);
      const final = await run(restored);
      expect(final.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(() => final.state.toString()).not.toThrow();
    },
  );

  it('rejects a checkpoint with changed completed-call arguments', async () => {
    const { agent, result, execute, nextExecute } =
      await pauseAfterDeferredTool();
    const checkpoint = result.state.toJSON();
    const call = checkpoint.generatedItems.find(
      (item) =>
        item.type === 'tool_call_item' &&
        item.rawItem.type === 'function_call' &&
        item.rawItem.callId === 'lookup_call',
    );
    if (
      call?.type !== 'tool_call_item' ||
      call.rawItem.type !== 'function_call'
    ) {
      throw new Error(
        'The completed function call is missing from the checkpoint.',
      );
    }
    call.rawItem.arguments = '{"value":"changed"}';
    await expect(
      RunState.fromString(agent, JSON.stringify(checkpoint)),
    ).rejects.toThrow(UserError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(nextExecute).not.toHaveBeenCalled();
  });

  it('does not authorize a same-name bare owner with a completed deferred call', async () => {
    const { agent, model, result, firstCall, execute, bare, bareExecute } =
      await pauseAfterDeferredTool();
    const replacementAgent = new Agent({
      name: agent.name,
      model,
      tools: [...agent.tools, bare],
    });
    const restored = await RunState.fromString(
      replacementAgent,
      result.state.toString(),
    );
    restored.approve(restored.getInterruptions()[0]);
    model.enqueue([firstCall]);
    await expect(
      new Runner({ tracingDisabled: true }).run(replacementAgent, restored),
    ).rejects.toThrow(/different invocation|different tool invocation/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(bareExecute).not.toHaveBeenCalled();
  });
});
