import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';
import { z } from 'zod/v3';

import { Agent } from '../src/agent';
import {
  RunHandoffCallItem as HandoffCallItem,
  RunHandoffOutputItem as HandoffOutputItem,
  RunMessageOutputItem as MessageOutputItem,
  RunReasoningItem as ReasoningItem,
  RunToolCallItem as ToolCallItem,
  RunToolCallOutputItem as ToolCallOutputItem,
  RunToolApprovalItem as ToolApprovalItem,
} from '../src/items';
import { ModelResponse } from '../src/model';
import { StreamedRunResult } from '../src/result';
import { getTracing } from '../src/run';
import { RunState } from '../src/runState';
import {
  addStepToRunResult,
  AgentToolUseTracker,
  checkForFinalOutputFromTools,
  getToolCallOutputItem,
  maybeResetToolChoice,
  processModelResponse,
  executeFunctionToolCalls,
  executeComputerActions,
  executeHandoffCalls,
  executeToolsAndSideEffects,
} from '../src/runImplementation';
import { FunctionTool, FunctionToolResult, tool } from '../src/tool';
import { handoff } from '../src/handoff';
import { ModelBehaviorError, UserError } from '../src/errors';
import { Computer } from '../src/computer';
import { Usage } from '../src/usage';
import { setTracingDisabled, withTrace } from '../src';

import {
  TEST_AGENT,
  TEST_MODEL_FUNCTION_CALL,
  TEST_MODEL_MESSAGE,
  TEST_MODEL_RESPONSE_WITH_FUNCTION,
  TEST_TOOL,
  FakeModelProvider,
} from './stubs';
import { computerTool } from '../src/tool';
import * as protocol from '../src/types/protocol';
import { Runner } from '../src/run';
import { RunContext } from '../src/runContext';
import { setDefaultModelProvider } from '../src';
import { Logger } from '../src/logger';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

describe('processModelResponse', () => {
  it('should correctly process message outputs', () => {
    const modelResponse: ModelResponse = TEST_MODEL_RESPONSE_WITH_FUNCTION;

    const result = processModelResponse(
      modelResponse,
      TEST_AGENT,
      [TEST_TOOL],
      [],
    );

    expect(result.newItems).toHaveLength(2);
    expect(result.newItems[0]).toBeInstanceOf(ToolCallItem);
    expect(result.newItems[0].rawItem).toEqual(
      TEST_MODEL_RESPONSE_WITH_FUNCTION.output[0],
    );
    expect(result.toolsUsed).toEqual(['test']);
    expect(result.functions).toContainEqual({
      tool: TEST_TOOL,
      toolCall: TEST_MODEL_RESPONSE_WITH_FUNCTION.output[0],
    });
    expect(result.newItems[1]).toBeInstanceOf(MessageOutputItem);
    expect(result.newItems[1].rawItem).toEqual(
      TEST_MODEL_RESPONSE_WITH_FUNCTION.output[1],
    );
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });
});

describe('getTracing', () => {
  it('should return the correct tracing value', () => {
    const tracingDisabled = true;
    const tracingEnabled = false;
    const tracingIncludeSensitiveData = true;
    const tracingIncludeSensitiveDataDisabled = false;

    expect(getTracing(tracingDisabled, tracingIncludeSensitiveData)).toEqual(
      false,
    );
    expect(
      getTracing(tracingDisabled, tracingIncludeSensitiveDataDisabled),
    ).toEqual(false);
    expect(getTracing(tracingEnabled, tracingIncludeSensitiveData)).toEqual(
      true,
    );
    expect(
      getTracing(tracingEnabled, tracingIncludeSensitiveDataDisabled),
    ).toEqual('enabled_without_data');
  });
});

describe('maybeResetToolChoice', () => {
  const agent = new Agent({ name: 'A' });
  const tracker = new AgentToolUseTracker();

  const modelSettings = { temperature: 0.5, toolChoice: 'auto' as const };

  it('does not reset when agent.resetToolChoice is false', () => {
    const result = maybeResetToolChoice(agent, tracker, modelSettings);
    expect(result.toolChoice).toBe('auto');
  });

  it('resets tool choice once the agent has used a tool', () => {
    const resetAgent = new Agent({ name: 'B', resetToolChoice: true });
    tracker.addToolUse(resetAgent, ['some_tool']);

    const result = maybeResetToolChoice(resetAgent, tracker, modelSettings);
    expect(result.toolChoice).toBeUndefined();
  });
});

describe('getToolCallOutputItem', () => {
  it('produces a correctly shaped function_call_output item', () => {
    const output = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, 'hi');

    expect(output).toEqual({
      type: 'function_call_result',
      name: TEST_MODEL_FUNCTION_CALL.name,
      callId: TEST_MODEL_FUNCTION_CALL.callId,
      status: 'completed',
      output: {
        type: 'text',
        text: 'hi',
      },
    });
  });
});

describe('checkForFinalOutputFromTools', () => {
  const state: RunState<any, any> = {} as any;

  // create a fake FunctionTool and corresponding result object that matches
  const weatherTool = tool({
    name: 'weather',
    description: 'weather',
    parameters: z.object({ city: z.string() }),
    execute: async () => 'sunny',
  });

  const toolResult: FunctionToolResult = {
    type: 'function_output',
    tool: weatherTool,
    output: 'sunny',
    runItem: {} as any, // not used by the function under test
  };

  it('returns NOT_FINAL_OUTPUT when no tools executed', async () => {
    const agent = new Agent({
      name: 'NoTools',
      toolUseBehavior: 'run_llm_again',
    });
    const res = await checkForFinalOutputFromTools(agent, [], state);
    expect(res.isFinalOutput).toBe(false);
  });

  it('stop_on_first_tool stops immediately', async () => {
    const agent = new Agent({
      name: 'Stop',
      toolUseBehavior: 'stop_on_first_tool',
    });
    const res = await checkForFinalOutputFromTools(agent, [toolResult], state);
    expect(res).toEqual({ isFinalOutput: true, finalOutput: 'sunny' });
  });

  it("stop_on_first_tool returns NOT_FINAL_OUTPUT when first isn't function output", async () => {
    const agent = new Agent({
      name: 'StopNoOut',
      toolUseBehavior: 'stop_on_first_tool',
    });
    const approvalResult: FunctionToolResult = {
      type: 'function_approval',
      tool: weatherTool,
      runItem: {} as any,
    };
    const res = await checkForFinalOutputFromTools(
      agent,
      [approvalResult],
      state,
    );
    expect(res.isFinalOutput).toBe(false);
  });

  it('Object based stopAtToolNames works', async () => {
    const agent = new Agent({
      name: 'Obj',
      toolUseBehavior: { stopAtToolNames: ['weather'] },
    });
    const res = await checkForFinalOutputFromTools(agent, [toolResult], state);
    expect(res.isFinalOutput).toBe(true);
    if (res.isFinalOutput) {
      expect(res.finalOutput).toBe('sunny');
    }
  });

  it('Object based stopAtToolNames returns NOT_FINAL_OUTPUT when unmatched', async () => {
    const agent = new Agent({
      name: 'ObjNoMatch',
      toolUseBehavior: { stopAtToolNames: ['other'] },
    });
    const res = await checkForFinalOutputFromTools(agent, [toolResult], state);
    expect(res.isFinalOutput).toBe(false);
  });

  it('Function based toolUseBehavior delegates decision', async () => {
    const agent = new Agent({
      name: 'Func',
      // Echo back decision logic
      toolUseBehavior: async (_ctx, _results) => ({
        isFinalOutput: true,
        finalOutput: 'sunny',
        isInterrupted: undefined,
      }),
    });
    const res = await checkForFinalOutputFromTools(agent, [toolResult], state);
    expect(res.isFinalOutput).toBe(true);
    if (res.isFinalOutput) {
      expect(res.finalOutput).toBe('sunny');
    }
  });

  it('run_llm_again continues running', async () => {
    const agent = new Agent({
      name: 'RunAgain',
      toolUseBehavior: 'run_llm_again',
    });
    const res = await checkForFinalOutputFromTools(agent, [toolResult], state);
    expect(res.isFinalOutput).toBe(false);
  });
});

describe('addStepToRunResult', () => {
  it('emits the correct RunItemStreamEvents for each item type', () => {
    const agent = new Agent({ name: 'Events' });

    const messageItem = new MessageOutputItem(TEST_MODEL_MESSAGE, agent);
    const handoffCallItem = new HandoffCallItem(
      TEST_MODEL_FUNCTION_CALL,
      agent,
    );
    const handoffOutputItem = new HandoffOutputItem(
      getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, 'transfer'),
      agent,
      agent,
    );
    const toolCallItem = new ToolCallItem(TEST_MODEL_FUNCTION_CALL, agent);
    const toolOutputItem = new ToolCallOutputItem(
      getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, 'hi'),
      agent,
      'hi',
    );

    // fake reasoning item
    const reasoningItem = new ReasoningItem(
      {
        id: 'r',
        type: 'reasoning',
        content: 'thought',
      } as any,
      agent,
    );

    const step: any = {
      newStepItems: [
        messageItem,
        handoffCallItem,
        handoffOutputItem,
        toolCallItem,
        toolOutputItem,
        reasoningItem,
      ],
    };

    const streamedResult = new StreamedRunResult();
    const captured: { name: string; item: any }[] = [];

    // Override _addItem to capture events
    (streamedResult as any)._addItem = (evt: any) => captured.push(evt);

    addStepToRunResult(streamedResult, step);

    const names = captured.map((e) => e.name);

    expect(names).toEqual([
      'message_output_created',
      'handoff_requested',
      'handoff_occurred',
      'tool_called',
      'tool_output',
      'reasoning_item_created',
    ]);
  });
});

// Additional tests for AgentToolUseTracker and executeComputerActions

describe('AgentToolUseTracker', () => {
  it('tracks usage and serializes', () => {
    const tracker = new AgentToolUseTracker();
    const agent = new Agent({ name: 'Track' });
    tracker.addToolUse(agent, ['foo']);
    expect(tracker.hasUsedTools(agent)).toBe(true);
    expect(tracker.toJSON()).toEqual({ Track: ['foo'] });
  });
});

describe('executeComputerActions', () => {
  it('runs action and returns screenshot output', async () => {
    setDefaultModelProvider(new FakeModelProvider());
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn().mockResolvedValue('img'),
      click: vi.fn(),
      doubleClick: vi.fn(),
      drag: vi.fn(),
      keypress: vi.fn(),
      move: vi.fn(),
      scroll: vi.fn(),
      type: vi.fn(),
      wait: vi.fn(),
    } as any;
    const tool = computerTool({ computer: fakeComputer });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };

    const items = await executeComputerActions(
      new Agent({ name: 'Comp' }),
      [{ toolCall: call, computer: tool }],
      new Runner(),
      new RunContext(),
    );
    expect(items).toHaveLength(1);
    expect((items[0] as any).output).toBe('data:image/png;base64,img');
  });
});

// --------------------------------------------------------------------------
// Additional tests based on comprehensive test plan
// --------------------------------------------------------------------------

describe('processModelResponse edge cases', () => {
  it('throws when model references unknown tool', () => {
    const badCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      name: 'missing_tool',
    };
    const response: ModelResponse = {
      output: [badCall],
      usage: new Usage(),
    } as any;

    expect(() =>
      processModelResponse(response, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('throws when computer action emitted without computer tool', () => {
    const compCall: protocol.ComputerUseCallItem = {
      id: 'c1',
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'click', x: 1, y: 1, button: 'left' },
    };
    const response: ModelResponse = {
      output: [compCall],
      usage: new Usage(),
    } as any;

    expect(() =>
      processModelResponse(response, TEST_AGENT, [TEST_TOOL], []),
    ).toThrow(ModelBehaviorError);
  });

  it('classifies functions, handoffs and computer actions', () => {
    const target = new Agent({ name: 'B' });
    const h = handoff(target);
    const computer = computerTool({
      computer: {
        environment: 'mac',
        dimensions: [10, 10],
        screenshot: vi.fn(async () => 'img'),
        click: vi.fn(async () => {}),
        doubleClick: vi.fn(async () => {}),
        drag: vi.fn(async () => {}),
        keypress: vi.fn(async () => {}),
        move: vi.fn(async () => {}),
        scroll: vi.fn(async () => {}),
        type: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    });

    const funcCall = { ...TEST_MODEL_FUNCTION_CALL, callId: 'f1' };
    const compCall: protocol.ComputerUseCallItem = {
      id: 'c1',
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const handCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      name: h.toolName,
      callId: 'h1',
    };
    const response: ModelResponse = {
      output: [funcCall, compCall, handCall, TEST_MODEL_MESSAGE],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(
      response,
      TEST_AGENT,
      [TEST_TOOL, computer],
      [h],
    );

    expect(result.functions[0]?.toolCall).toBe(funcCall);
    expect(result.computerActions[0]?.toolCall).toBe(compCall);
    expect(result.handoffs[0]?.toolCall).toBe(handCall);
    expect(result.toolsUsed).toEqual(['test', 'computer_use', h.toolName]);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
    expect(result.newItems[3]).toBeInstanceOf(MessageOutputItem);
  });
});

describe('maybeResetToolChoice additional case', () => {
  it('keeps tool choice when agent has not used tools', () => {
    const tracker = new AgentToolUseTracker();
    const agent = new Agent({ name: 'A', resetToolChoice: true });
    const settings = { temperature: 0, toolChoice: 'auto' as const };
    expect(maybeResetToolChoice(agent, tracker, settings).toolChoice).toBe(
      'auto',
    );
  });
});

describe('executeFunctionToolCalls', () => {
  const toolCall = { ...TEST_MODEL_FUNCTION_CALL, name: 'hi', callId: 'c1' };

  function makeTool(
    needs: boolean | (() => Promise<boolean>),
  ): FunctionTool<any, any, any> {
    return tool({
      name: 'hi',
      description: 't',
      parameters: z.object({}),
      needsApproval: needs,
      execute: vi.fn(async () => 'ok'),
    });
  }

  let state: RunState<any, any>;
  let runner: Runner;

  beforeEach(() => {
    runner = new Runner({ tracingDisabled: true });
    state = new RunState(new RunContext(), '', new Agent({ name: 'T' }), 1);
  });

  it('returns approval item when not yet approved', async () => {
    const t = makeTool(true);
    vi.spyOn(state._context, 'isToolApproved').mockReturnValue(
      undefined as any,
    );
    const invokeSpy = vi.spyOn(t, 'invoke');

    const res = await withTrace('test', () =>
      executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall, tool: t }],
        runner,
        state,
      ),
    );

    expect(res[0].type).toBe('function_approval');
    expect(res[0].runItem).toBeInstanceOf(ToolApprovalItem);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('returns rejection output when approval is false', async () => {
    const t = makeTool(true);
    vi.spyOn(state._context, 'isToolApproved').mockReturnValue(false as any);
    const invokeSpy = vi.spyOn(t, 'invoke');

    const res = await withTrace('test', () =>
      executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall, tool: t }],
        runner,
        state,
      ),
    );

    expect(res[0].type).toBe('function_output');
    expect(res[0].runItem).toBeInstanceOf(ToolCallOutputItem);
    expect(invokeSpy).not.toHaveBeenCalled();
  });

  it('runs tool and emits events on success', async () => {
    const t = makeTool(false);
    const start = vi.fn();
    const end = vi.fn();
    runner.on('agent_tool_start', start);
    runner.on('agent_tool_end', end);
    const invokeSpy = vi.spyOn(t, 'invoke');

    const res = await withTrace('test', () =>
      executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall, tool: t }],
        runner,
        state,
      ),
    );

    expect(res[0].type).toBe('function_output');
    expect(start).toHaveBeenCalledWith(state._context, state._currentAgent, t, {
      toolCall,
    });
    expect(end).toHaveBeenCalledWith(
      state._context,
      state._currentAgent,
      t,
      'ok',
      { toolCall },
    );
    expect(res[0].runItem).toBeInstanceOf(ToolCallOutputItem);
    expect(invokeSpy).toHaveBeenCalled();
  });
});

describe('executeComputerActions', () => {
  function makeComputer(): Computer {
    return {
      environment: 'mac',
      dimensions: [1, 1],
      screenshot: vi.fn(async () => 'img'),
      click: vi.fn(async () => {}),
      doubleClick: vi.fn(async () => {}),
      drag: vi.fn(async () => {}),
      keypress: vi.fn(async () => {}),
      move: vi.fn(async () => {}),
      scroll: vi.fn(async () => {}),
      type: vi.fn(async () => {}),
      wait: vi.fn(async () => {}),
    };
  }

  const actions: protocol.ComputerAction[] = [
    { type: 'click', x: 1, y: 2, button: 'left' },
    { type: 'double_click', x: 2, y: 2 },
    { type: 'drag', path: [{ x: 1, y: 1 }] },
    { type: 'keypress', keys: ['a'] },
    { type: 'move', x: 3, y: 3 },
    { type: 'screenshot' },
    { type: 'scroll', x: 0, y: 0, scroll_x: 0, scroll_y: 1 },
    { type: 'type', text: 'hi' },
    { type: 'wait' },
  ];

  it('invokes computer methods and returns screenshots', async () => {
    const comp = makeComputer();
    const tool = computerTool({ computer: comp });
    const calls = actions.map((a, i) => ({
      toolCall: {
        id: `id${i}`,
        type: 'computer_call',
        callId: `id${i}`,
        status: 'completed',
        action: a,
      } as protocol.ComputerUseCallItem,
      computer: tool,
    }));

    const result = await withTrace('test', () =>
      executeComputerActions(
        new Agent({ name: 'C' }),
        calls,
        new Runner({ tracingDisabled: true }),
        new RunContext(),
      ),
    );

    expect(result).toHaveLength(actions.length);
    expect(comp.screenshot).toHaveBeenCalledTimes(actions.length);
    expect(result.every((r) => r instanceof ToolCallOutputItem)).toBe(true);
  });

  it('throws if computer lacks screenshot', async () => {
    const comp: any = {
      environment: 'mac',
      dimensions: [1, 1],
      click: async () => {},
      doubleClick: async () => {},
      drag: async () => {},
      keypress: async () => {},
      move: async () => {},
      scroll: async () => {},
      type: async () => {},
      wait: async () => {},
    };
    const tool = computerTool({ computer: comp });
    const call = {
      toolCall: {
        id: 'id',
        type: 'computer_call',
        callId: 'id',
        status: 'completed',
        action: { type: 'click', x: 1, y: 1, button: 'left' },
      } as protocol.ComputerUseCallItem,
      computer: tool,
    };
    const res = await withTrace('test', () =>
      executeComputerActions(
        new Agent({ name: 'C' }),
        [call],
        new Runner({ tracingDisabled: true }),
        new RunContext(),
        { error: (_: string) => {} } as unknown as Logger,
      ),
    );

    expect(res[0]).toBeInstanceOf(ToolCallOutputItem);
    expect(res[0].type).toBe('tool_call_output_item');
    expect(res[0].rawItem.type).toBe('computer_call_result');
    expect((res[0].rawItem as any).output.data).toBe('');
  });
});

describe('executeHandoffCalls', () => {
  it('executes single handoff', async () => {
    const target = new Agent({ name: 'Target' });
    const h = handoff(target);
    const call: any = {
      toolCall: { ...TEST_MODEL_FUNCTION_CALL, name: h.toolName },
      handoff: h,
    };
    const res = await withTrace('test', () =>
      executeHandoffCalls(
        TEST_AGENT,
        '',
        [],
        [],
        TEST_MODEL_RESPONSE_WITH_FUNCTION,
        [call],
        new Runner({ tracingDisabled: true }),
        new RunContext(),
      ),
    );

    expect(res.nextStep.type).toBe('next_step_handoff');
    if (res.nextStep.type === 'next_step_handoff') {
      expect(res.nextStep.newAgent).toBe(target);
    }
  });

  it('handles multiple handoffs by rejecting extras', async () => {
    const target = new Agent({ name: 'Target' });
    const h = handoff(target);
    const call1: any = {
      toolCall: { ...TEST_MODEL_FUNCTION_CALL, name: h.toolName, callId: '1' },
      handoff: h,
    };
    const call2: any = {
      toolCall: { ...TEST_MODEL_FUNCTION_CALL, name: h.toolName, callId: '2' },
      handoff: h,
    };

    const res = await withTrace('test', () =>
      executeHandoffCalls(
        TEST_AGENT,
        '',
        [],
        [],
        TEST_MODEL_RESPONSE_WITH_FUNCTION,
        [call1, call2],
        new Runner({ tracingDisabled: true }),
        new RunContext(),
      ),
    );

    expect(
      res.newStepItems.some(
        (i) =>
          i instanceof ToolCallOutputItem && (i.rawItem as any).callId === '2',
      ),
    ).toBe(true);
  });

  it('filters input when inputFilter provided', async () => {
    const target = new Agent({ name: 'Target' });
    const h = handoff(target);
    h.inputFilter = (_data) => ({
      inputHistory: 'filtered',
      preHandoffItems: [],
      newItems: [],
    });
    const call: any = {
      toolCall: { ...TEST_MODEL_FUNCTION_CALL, name: h.toolName },
      handoff: h,
    };

    const res = await withTrace('test', () =>
      executeHandoffCalls(
        TEST_AGENT,
        'orig',
        [],
        [],
        TEST_MODEL_RESPONSE_WITH_FUNCTION,
        [call],
        new Runner({ tracingDisabled: true }),
        new RunContext(),
      ),
    );

    expect(res.originalInput).toBe('filtered');
  });
});

describe('checkForFinalOutputFromTools interruptions and errors', () => {
  const state: RunState<any, any> = {} as any;

  it('returns interruptions when approval items present', async () => {
    const agent = new Agent({ name: 'A', toolUseBehavior: 'run_llm_again' });
    const approval = new ToolApprovalItem(TEST_MODEL_FUNCTION_CALL, agent);
    const res = await checkForFinalOutputFromTools(
      agent,
      [{ type: 'function_approval', tool: TEST_TOOL, runItem: approval }],
      state,
    );
    expect(res.isInterrupted).toBe(true);
    expect((res as any).interruptions[0]).toBe(approval);
  });

  it('throws on unknown behavior', async () => {
    const agent = new Agent({ name: 'Bad', toolUseBehavior: 'nope' as any });
    await expect(
      checkForFinalOutputFromTools(
        agent,
        [
          {
            type: 'function_output',
            tool: TEST_TOOL,
            output: 'o',
            runItem: {} as any,
          },
        ],
        state,
      ),
    ).rejects.toBeInstanceOf(UserError);
  });
});

describe('AgentToolUseTracker', () => {
  it('tracks tool usage per agent', () => {
    const tracker = new AgentToolUseTracker();
    const a = new Agent({ name: 'A' });
    tracker.addToolUse(a, ['t1']);
    expect(tracker.hasUsedTools(a)).toBe(true);
    expect(tracker.toJSON()).toEqual({ A: ['t1'] });
  });
});

describe('empty execution helpers', () => {
  it('handles empty function and computer calls', async () => {
    const agent = new Agent({ name: 'Empty' });
    const runner = new Runner({ tracingDisabled: true });
    const state = new RunState(new RunContext(), '', agent, 1);

    const fn = await withTrace('test', () =>
      executeFunctionToolCalls(agent, [], runner, state),
    );
    const comp = await withTrace('test', () =>
      executeComputerActions(agent, [], runner, state._context),
    );

    expect(fn).toEqual([]);
    expect(comp).toEqual([]);
  });
});

describe('hasToolsOrApprovalsToRun method', () => {
  it('returns true when handoffs are pending', () => {
    const target = new Agent({ name: 'Target' });
    const h = handoff(target);
    const response: ModelResponse = {
      output: [{ ...TEST_MODEL_FUNCTION_CALL, name: h.toolName }],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(response, TEST_AGENT, [], [h]);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('returns true when function calls are pending', () => {
    const result = processModelResponse(
      TEST_MODEL_RESPONSE_WITH_FUNCTION,
      TEST_AGENT,
      [TEST_TOOL],
      [],
    );
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('returns true when computer actions are pending', () => {
    const computer = computerTool({
      computer: {
        environment: 'mac',
        dimensions: [10, 10],
        screenshot: vi.fn(async () => 'img'),
        click: vi.fn(async () => {}),
        doubleClick: vi.fn(async () => {}),
        drag: vi.fn(async () => {}),
        keypress: vi.fn(async () => {}),
        move: vi.fn(async () => {}),
        scroll: vi.fn(async () => {}),
        type: vi.fn(async () => {}),
        wait: vi.fn(async () => {}),
      },
    });
    const compCall: protocol.ComputerUseCallItem = {
      id: 'c1',
      type: 'computer_call',
      callId: 'c1',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const response: ModelResponse = {
      output: [compCall],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(response, TEST_AGENT, [computer], []);
    expect(result.hasToolsOrApprovalsToRun()).toBe(true);
  });

  it('returns false when no tools or approvals are pending', () => {
    const response: ModelResponse = {
      output: [TEST_MODEL_MESSAGE],
      usage: new Usage(),
    } as any;

    const result = processModelResponse(response, TEST_AGENT, [], []);
    expect(result.hasToolsOrApprovalsToRun()).toBe(false);
  });
});

describe('executeToolsAndSideEffects', () => {
  let runner: Runner;
  let state: RunState<any, any>;

  beforeEach(() => {
    runner = new Runner({ tracingDisabled: true });
    state = new RunState(new RunContext(), 'test input', TEST_AGENT, 1);
  });

  it('continues execution when text agent has tools pending', async () => {
    const textAgent = new Agent({ name: 'TextAgent', outputType: 'text' });
    const processedResponse = processModelResponse(
      TEST_MODEL_RESPONSE_WITH_FUNCTION,
      textAgent,
      [TEST_TOOL],
      [],
    );

    expect(processedResponse.hasToolsOrApprovalsToRun()).toBe(true);

    const result = await withTrace('test', () =>
      executeToolsAndSideEffects(
        textAgent,
        'test input',
        [],
        TEST_MODEL_RESPONSE_WITH_FUNCTION,
        processedResponse,
        runner,
        state,
      ),
    );

    expect(result.nextStep.type).toBe('next_step_run_again');
  });

  it('returns final output when text agent has no tools pending', async () => {
    const textAgent = new Agent({ name: 'TextAgent', outputType: 'text' });
    const response: ModelResponse = {
      output: [TEST_MODEL_MESSAGE],
      usage: new Usage(),
    } as any;
    const processedResponse = processModelResponse(response, textAgent, [], []);

    expect(processedResponse.hasToolsOrApprovalsToRun()).toBe(false);

    const result = await withTrace('test', () =>
      executeToolsAndSideEffects(
        textAgent,
        'test input',
        [],
        response,
        processedResponse,
        runner,
        state,
      ),
    );

    expect(result.nextStep.type).toBe('next_step_final_output');
    if (result.nextStep.type === 'next_step_final_output') {
      expect(result.nextStep.output).toBe('Hello World');
    }
  });
});
