import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';

import {
  setDefaultModelProvider,
  setTracingDisabled,
  withTrace,
} from '../../src';
import {
  Agent,
  AgentOutputType,
  saveAgentToolRunResult,
} from '../../src/agent';
import {
  RunHandoffCallItem as HandoffCallItem,
  RunHandoffOutputItem as HandoffOutputItem,
  RunMessageOutputItem as MessageOutputItem,
  RunReasoningItem as ReasoningItem,
  RunToolApprovalItem as ToolApprovalItem,
  RunToolCallItem as ToolCallItem,
  RunToolCallOutputItem as ToolCallOutputItem,
} from '../../src/items';
import {
  addStepToRunResult,
  streamStepItemsToRunResult,
} from '../../src/runner/streaming';
import {
  checkForFinalOutputFromTools,
  executeApplyPatchOperations,
  executeComputerActions,
  executeFunctionToolCalls,
  executeHandoffCalls,
  executeShellActions,
  getToolCallOutputItem,
} from '../../src/runner/toolExecution';
import type { Logger } from '../../src/logger';
import { Runner } from '../../src/run';
import { RunContext } from '../../src/runContext';
import { RunResult, StreamedRunResult } from '../../src/result';
import { RunState } from '../../src/runState';
import { handoff } from '../../src/handoff';
import {
  ToolCallError,
  ToolInputGuardrailTripwireTriggered,
  ToolOutputGuardrailTripwireTriggered,
  UserError,
} from '../../src/errors';
import { Computer } from '../../src/computer';
import {
  ToolGuardrailFunctionOutputFactory,
  defineToolInputGuardrail,
  defineToolOutputGuardrail,
} from '../../src/toolGuardrail';
import {
  FunctionTool,
  FunctionToolResult,
  applyPatchTool,
  computerTool,
  shellTool,
  tool,
} from '../../src/tool';
import {
  TEST_AGENT,
  TEST_MODEL_FUNCTION_CALL,
  TEST_MODEL_MESSAGE,
  TEST_MODEL_RESPONSE_WITH_FUNCTION,
  TEST_TOOL,
  FakeModelProvider,
  FakeShell,
  FakeEditor,
} from '../stubs';
import * as protocol from '../../src/types/protocol';
import { AgentToolUseTracker } from '../../src/runner/toolUseTracker';
import { z } from 'zod';

const createMockLogger = (): Logger => ({
  namespace: 'test',
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  dontLogModelData: true,
  dontLogToolData: true,
});

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
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

  it('converts structured text outputs into input_text items', () => {
    const output = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'text',
      text: 'structured',
    });

    expect(output.output).toEqual([
      {
        type: 'input_text',
        text: 'structured',
      },
    ]);
  });

  it('converts image outputs with URLs', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'image',
      image: 'https://example.com/image.png',
      detail: 'high',
    });

    expect(result.output).toEqual([
      {
        type: 'input_image',
        image: 'https://example.com/image.png',
        detail: 'high',
      },
    ]);
  });

  it('converts nested image objects with base64 payloads', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'image',
      image: {
        data: Buffer.from('hi').toString('base64'),
      },
      detail: 'low',
    });

    expect(result.output).toEqual([
      {
        type: 'input_image',
        image: 'aGk=',
        detail: 'low',
      },
    ]);
  });

  it('converts file outputs with base64 data', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'file',
      file: {
        data: Buffer.from('content').toString('base64'),
        mediaType: 'text/plain',
        filename: 'file.txt',
      },
    });

    expect(result.output).toEqual([
      {
        type: 'input_file',
        file: expect.stringContaining('data:text/plain;base64,'),
        filename: 'file.txt',
      },
    ]);
  });

  it('converts file outputs with referenced ids and provider data', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'file',
      file: { id: 'file_123', filename: 'x.txt' },
      providerData: { source: 'test' },
    });

    expect(result.output).toEqual([
      {
        type: 'input_file',
        file: { id: 'file_123' },
        filename: 'x.txt',
        providerData: { source: 'test' },
      },
    ]);
  });

  it('converts image outputs with file references', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'image',
      image: { fileId: 'img_1', mediaType: 'image/png' },
      detail: 'auto',
    });

    expect(result.output).toEqual([
      {
        type: 'input_image',
        image: { id: 'img_1' },
        detail: 'auto',
      },
    ]);
  });

  it('returns plain text output when normalization fails', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'unknown',
      value: 'x',
    });

    expect(result.output).toEqual({
      type: 'text',
      text: JSON.stringify({ type: 'unknown', value: 'x' }),
    });
  });
});

describe('checkForFinalOutputFromTools', () => {
  const state: RunState<any, any> = {} as any;

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
    runItem: {} as any,
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

  it('does not re-emit items that were already streamed', () => {
    const agent = new Agent({ name: 'StreamOnce' });

    const toolCallItem = new ToolCallItem(TEST_MODEL_FUNCTION_CALL, agent);
    const toolOutputItem = new ToolCallOutputItem(
      getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, 'ok'),
      agent,
      'ok',
    );

    const step: any = {
      newStepItems: [toolCallItem, toolOutputItem],
    };

    const streamedResult = new StreamedRunResult();
    const captured: string[] = [];
    (streamedResult as any)._addItem = (evt: any) => captured.push(evt.name);

    const alreadyStreamed = new Set([toolCallItem]);
    streamStepItemsToRunResult(streamedResult, [toolCallItem]);
    addStepToRunResult(streamedResult, step, { skipItems: alreadyStreamed });

    expect(captured).toEqual(['tool_called', 'tool_output']);
  });

  it('maintains event order when mixing pre-streamed and step items', () => {
    const agent = new Agent({ name: 'OrderedStream' });

    const messageItem = new MessageOutputItem(TEST_MODEL_MESSAGE, agent);
    const toolCallItem = new ToolCallItem(TEST_MODEL_FUNCTION_CALL, agent);
    const toolOutputItem = new ToolCallOutputItem(
      getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, 'done'),
      agent,
      'done',
    );

    const step: any = {
      newStepItems: [messageItem, toolCallItem, toolOutputItem],
    };

    const streamedResult = new StreamedRunResult();
    const captured: string[] = [];
    (streamedResult as any)._addItem = (evt: any) => captured.push(evt.name);

    const preStreamed = new Set([messageItem, toolCallItem]);
    streamStepItemsToRunResult(streamedResult, [messageItem, toolCallItem]);
    addStepToRunResult(streamedResult, step, { skipItems: preStreamed });

    expect(captured).toEqual([
      'message_output_created',
      'tool_called',
      'tool_output',
    ]);
  });
});

describe('AgentToolUseTracker', () => {
  it('tracks usage and serializes', () => {
    const tracker = new AgentToolUseTracker();
    const agent = new Agent({ name: 'Track' });
    tracker.addToolUse(agent, ['foo']);
    expect(tracker.hasUsedTools(agent)).toBe(true);
    expect(tracker.toJSON()).toEqual({ Track: ['foo'] });
  });

  it('ignores empty tool lists so unused agents do not mark tool usage', () => {
    const tracker = new AgentToolUseTracker();
    const agent = new Agent({ name: 'Track' });
    tracker.addToolUse(agent, []);
    expect(tracker.hasUsedTools(agent)).toBe(false);
    expect(tracker.toJSON()).toEqual({});
  });

  it('tracks tool usage per agent', () => {
    const tracker = new AgentToolUseTracker();
    const a = new Agent({ name: 'A' });
    tracker.addToolUse(a, ['t1']);
    expect(tracker.hasUsedTools(a)).toBe(true);
    expect(tracker.toJSON()).toEqual({ A: ['t1'] });
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

  it('returns interruptions when nested run results contain approvals', async () => {
    const agent = new Agent({ name: 'A', toolUseBehavior: 'run_llm_again' });
    const nestedAgent = new Agent({ name: 'Nested' }) as Agent<
      unknown,
      AgentOutputType
    >;
    const nestedState = new RunState(new RunContext(), '', nestedAgent, 1);
    const approval = new ToolApprovalItem(
      TEST_MODEL_FUNCTION_CALL,
      nestedAgent,
    );
    nestedState._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [approval] },
    } as any;
    const nestedResult = new RunResult(nestedState);

    const res = await checkForFinalOutputFromTools(
      agent,
      [
        {
          type: 'function_output',
          tool: TEST_TOOL,
          output: 'ok',
          runItem: {} as any,
          agentRunResult: nestedResult,
        },
      ],
      state,
    );

    expect(res.isInterrupted).toBe(true);
    if (res.isInterrupted) {
      expect(res.interruptions).toEqual([approval]);
    }
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
describe('executeShellActions', () => {
  it('runs shell commands and truncates output when maxOutputLength provided', async () => {
    const shell = new FakeShell();
    shell.result = {
      output: [
        {
          stdout: '0123456789',
          stderr: 'stderr-info',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
    };
    const shellToolDef = shellTool({ shell });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({ tracingDisabled: true });
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'], maxOutputLength: 5 },
    };

    const results = await executeShellActions(
      agent,
      [{ toolCall, shell: shellToolDef } as any],
      runner,
      runContext,
    );

    expect(results).toHaveLength(1);
    const rawItem = results[0].rawItem as protocol.ShellCallResultItem;
    expect(rawItem.output).toEqual(shell.result.output);
    expect(rawItem.providerData).toBeUndefined();
    expect(rawItem.maxOutputLength).toBeUndefined();
    expect(shell.calls).toHaveLength(1);
  });

  it('returns failed status when shell throws', async () => {
    const shell = new FakeShell();
    shell.error = new Error('boom');
    const shellToolDef = shellTool({ shell });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({ tracingDisabled: true });
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };

    const mockLogger = createMockLogger();
    const results = await executeShellActions(
      agent,
      [{ toolCall, shell: shellToolDef } as any],
      runner,
      runContext,
      mockLogger,
    );

    const rawItem = results[0].rawItem as protocol.ShellCallResultItem;
    expect(Array.isArray(rawItem.output)).toBe(true);
    expect(rawItem.output[0]).toMatchObject({
      stdout: '',
      stderr: 'boom',
      outcome: { type: 'exit', exitCode: null },
    });
    expect(mockLogger.error).toHaveBeenCalledWith(
      'Failed to execute shell action:',
      shell.error,
    );
  });

  describe('executeApplyPatchOperations', () => {
    it('runs apply_patch operations and returns outputs', async () => {
      const editor = new FakeEditor();
      const applyPatch = applyPatchTool({ editor });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const runner = new Runner({ tracingDisabled: true });
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch',
        status: 'completed',
        operation: {
          type: 'update_file',
          path: 'README.md',
          diff: 'diff --git',
        },
      };

      const results = await executeApplyPatchOperations(
        agent,
        [{ toolCall, applyPatch } as any],
        runner,
        runContext,
      );

      const rawItem = results[0].rawItem as protocol.ApplyPatchCallResultItem;
      expect(rawItem.status).toBe('completed');
      expect(rawItem.output).toBeUndefined();
      expect(editor.operations).toHaveLength(1);
    });

    it('returns failed status when editor throws', async () => {
      const editor = new FakeEditor();
      const applyPatch = applyPatchTool({ editor });
      editor.errors.delete_file = new Error('cannot delete');
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const runner = new Runner({ tracingDisabled: true });
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch',
        status: 'completed',
        operation: {
          type: 'delete_file',
          path: 'README.md',
        },
      };

      const mockLogger = createMockLogger();
      const results = await executeApplyPatchOperations(
        agent,
        [{ toolCall, applyPatch } as any],
        runner,
        runContext,
        mockLogger,
      );

      const rawItem = results[0].rawItem as protocol.ApplyPatchCallResultItem;
      expect(rawItem.status).toBe('failed');
      expect(rawItem.output).toBe('cannot delete');
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to execute apply_patch operation:',
        editor.errors.delete_file,
      );
    });

    it('returns approval item when not yet approved', async () => {
      const editor = new FakeEditor();
      const applyPatch = applyPatchTool({
        editor,
        needsApproval: async () => true,
      });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const runner = new Runner({ tracingDisabled: true });
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch',
        status: 'completed',
        operation: {
          type: 'update_file',
          path: 'README.md',
          diff: 'diff --git',
        },
      };

      const results = await executeApplyPatchOperations(
        agent,
        [{ toolCall, applyPatch } as any],
        runner,
        runContext,
      );

      expect(results[0].type).toBe('tool_approval_item');
      expect(editor.operations).toHaveLength(0);
    });

    it('respects onApproval callback for apply_patch', async () => {
      const editor = new FakeEditor();
      const onApproval = vi.fn(async () => ({ approve: false }));
      const applyPatch = applyPatchTool({
        editor,
        needsApproval: async () => true,
        onApproval,
      });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const runner = new Runner({ tracingDisabled: true });
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch',
        status: 'completed',
        operation: {
          type: 'delete_file',
          path: 'README.md',
        },
      };

      const results = await executeApplyPatchOperations(
        agent,
        [{ toolCall, applyPatch } as any],
        runner,
        runContext,
      );

      expect(onApproval).toHaveBeenCalled();
      const rawItem = results[0].rawItem as protocol.ApplyPatchCallResultItem;
      expect(rawItem.status).toBe('failed');
      expect(rawItem.output).toBe('Tool execution was not approved.');
      expect(editor.operations).toHaveLength(0);
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
      expect(start).toHaveBeenCalledWith(
        state._context,
        state._currentAgent,
        t,
        {
          toolCall,
        },
      );
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

    it('emits agent_tool_end even when function tool throws error', async () => {
      const errorMessage = 'Tool execution failed';
      const t = tool({
        name: 'failing_tool',
        description: 'A tool that throws an error',
        parameters: z.object({}),
        errorFunction: null,
        execute: vi.fn(async () => {
          throw new Error(errorMessage);
        }),
      }) as any;

      const start = vi.fn();
      const end = vi.fn();
      runner.on('agent_tool_start', start);
      runner.on('agent_tool_end', end);

      await expect(
        withTrace('test', () =>
          executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall, tool: t }],
            runner,
            state,
          ),
        ),
      ).rejects.toThrow();

      expect(start).toHaveBeenCalledWith(
        state._context,
        state._currentAgent,
        t,
        {
          toolCall,
        },
      );
      expect(end).toHaveBeenCalled();
      expect(end).toHaveBeenCalledWith(
        state._context,
        state._currentAgent,
        t,
        expect.stringContaining(errorMessage),
        { toolCall },
      );
    });

    it('skips tool execution when input guardrail rejects content', async () => {
      const guardrail = defineToolInputGuardrail({
        name: 'block',
        run: async () =>
          ToolGuardrailFunctionOutputFactory.rejectContent(
            'blocked by guardrail',
          ),
      });
      const t = tool({
        name: 'guarded_tool',
        description: 'tool with input guardrail',
        parameters: z.object({}),
        execute: vi.fn(async () => 'should-not-run'),
        inputGuardrails: [guardrail],
      }) as unknown as FunctionTool;
      const invokeSpy = vi.spyOn(t, 'invoke');

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      const first = res[0];
      expect(first.type).toBe('function_output');
      if (first.type === 'function_output') {
        expect(first.output).toBe('blocked by guardrail');
      }
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(state._toolInputGuardrailResults).toHaveLength(1);
      expect(state._toolOutputGuardrailResults).toHaveLength(0);
    });

    it('throws when output guardrail requests exception', async () => {
      const guardrail = defineToolOutputGuardrail({
        name: 'halt',
        run: async () => ToolGuardrailFunctionOutputFactory.throwException(),
      });
      const t = tool({
        name: 'output_guarded_tool',
        description: 'tool with output guardrail',
        parameters: z.object({}),
        execute: vi.fn(async () => 'raw'),
        outputGuardrails: [guardrail],
      }) as unknown as FunctionTool;
      const invokeSpy = vi.spyOn(t, 'invoke');

      const error = (await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ).catch((e) => e),
      )) as unknown;

      expect(error).toBeInstanceOf(ToolCallError);
      if (error instanceof ToolCallError) {
        expect(error.error).toBeInstanceOf(
          ToolOutputGuardrailTripwireTriggered,
        );
      }

      expect(invokeSpy).toHaveBeenCalled();
      expect(state._toolOutputGuardrailResults).toHaveLength(1);
    });

    it('supports inputGuardrails/outputGuardrails without define helpers', async () => {
      const t = tool({
        name: 'guardrails_no_define',
        description: 'tool with inline guardrails',
        parameters: z.object({}),
        execute: vi.fn(async () => 'ok'),
        inputGuardrails: [
          {
            name: 'inline_block',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.rejectContent(
                'blocked inline',
              ),
          },
        ],
        outputGuardrails: [
          {
            name: 'inline_out',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.throwException(),
          },
        ],
      }) as unknown as FunctionTool;

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      const first = res[0];
      expect(first.type).toBe('function_output');
      if (first.type === 'function_output') {
        expect(first.output).toBe('blocked inline');
      }
      expect(state._toolInputGuardrailResults).toHaveLength(1);
      expect(state._toolOutputGuardrailResults).toHaveLength(0);
    });

    it('wraps input guardrail throwException in ToolCallError with tripwire detail', async () => {
      const guardrail = defineToolInputGuardrail({
        name: 'trip',
        run: async () => ToolGuardrailFunctionOutputFactory.throwException(),
      });
      const t = tool({
        name: 'input_trip_tool',
        description: 'tool with throwing input guardrail',
        parameters: z.object({}),
        execute: vi.fn(async () => 'never'),
        inputGuardrails: [guardrail],
      }) as unknown as FunctionTool;

      const error = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ).catch((e) => e),
      );

      expect(error).toBeInstanceOf(ToolCallError);
      if (error instanceof ToolCallError) {
        expect(error.error).toBeInstanceOf(ToolInputGuardrailTripwireTriggered);
      }
      expect(state._toolInputGuardrailResults).toHaveLength(1);
      expect(vi.spyOn(t, 'invoke')).not.toHaveBeenCalled();
    });

    it('stops evaluating further input guardrails after rejectContent', async () => {
      const first = defineToolInputGuardrail({
        name: 'rejector',
        run: async () =>
          ToolGuardrailFunctionOutputFactory.rejectContent('blocked'),
      });
      const secondRun = vi.fn();
      const second = defineToolInputGuardrail({
        name: 'should_not_run',
        run: async (...args) => {
          secondRun(...args);
          return ToolGuardrailFunctionOutputFactory.allow();
        },
      });
      const t = tool({
        name: 'multi_input_guardrail_tool',
        description: 'tool with multiple input guardrails',
        parameters: z.object({}),
        execute: vi.fn(async () => 'should-not-run'),
        inputGuardrails: [first, second],
      }) as unknown as FunctionTool;

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      const firstResult = res[0];
      expect(firstResult.type).toBe('function_output');
      if (firstResult.type === 'function_output') {
        expect(firstResult.output).toBe('blocked');
      }
      expect(secondRun).not.toHaveBeenCalled();
      expect(state._toolInputGuardrailResults).toHaveLength(1);
    });

    it('stops evaluating further output guardrails after rejectContent and returns replacement', async () => {
      const first = defineToolOutputGuardrail({
        name: 'replace',
        run: async () =>
          ToolGuardrailFunctionOutputFactory.rejectContent('redacted'),
      });
      const secondRun = vi.fn();
      const second = defineToolOutputGuardrail({
        name: 'should_not_run',
        run: async (...args) => {
          secondRun(...args);
          return ToolGuardrailFunctionOutputFactory.allow();
        },
      });
      const t = tool({
        name: 'multi_output_guardrail_tool',
        description: 'tool with multiple output guardrails',
        parameters: z.object({}),
        execute: vi.fn(async () => ({ secret: true })),
        outputGuardrails: [first, second],
      }) as unknown as FunctionTool;

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      const firstResult = res[0];
      expect(firstResult.type).toBe('function_output');
      if (firstResult.type === 'function_output') {
        expect(firstResult.output).toBe('redacted');
      }
      expect(secondRun).not.toHaveBeenCalled();
      expect(state._toolOutputGuardrailResults).toHaveLength(1);
    });

    it('propagates nested run result interruptions when provided by agent tools', async () => {
      const t = makeTool(false);
      const nestedAgent = new Agent({ name: 'Nested' }) as Agent<
        unknown,
        AgentOutputType
      >;
      const nestedState = new RunState(new RunContext(), '', nestedAgent, 1);
      const approval = new ToolApprovalItem(
        TEST_MODEL_FUNCTION_CALL,
        nestedAgent,
      );
      nestedState._currentStep = {
        type: 'next_step_interruption',
        data: { interruptions: [approval] },
      } as any;
      const nestedRunResult = new RunResult(nestedState);

      vi.spyOn(t, 'invoke').mockImplementation(async (_ctx, _args, details) => {
        saveAgentToolRunResult(details?.toolCall, nestedRunResult);
        return 'ok';
      });

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      const firstResult = res[0];
      if (firstResult.type !== 'function_output') {
        throw new Error('Expected function_output result.');
      }
      expect(firstResult.agentRunResult).toBe(nestedRunResult);
      expect(firstResult.interruptions).toEqual([approval]);
    });

    it('handles invalid JSON in tool call arguments gracefully instead of crashing', async () => {
      // Reproduces issue #723: SyntaxError stops agent when LLM generates invalid JSON
      const t = tool({
        name: 'checkTagActivity',
        description: 'Check tag activity',
        parameters: z.object({
          tagIds: z.array(z.string()),
          since: z.string(),
        }),
        execute: vi.fn(async () => 'success'),
      }) as unknown as FunctionTool;

      const invalidToolCall = {
        ...toolCall,
        name: 'checkTagActivity',
        arguments:
          '{"{"tagIds":["65aafb7e-4293-4376-baf6-1f9d197e960a"],"since":"2025-09-04T13:26:13.991Z"}',
      };

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall: invalidToolCall, tool: t }],
          runner,
          state,
        ),
      );

      expect(res).toHaveLength(1);
      const firstResult = res[0];

      expect(firstResult.type).toBe('function_output');
      if (firstResult.type === 'function_output') {
        expect(String(firstResult.output)).toContain(
          'An error occurred while parsing tool arguments',
        );
        expect(String(firstResult.output)).toContain('valid JSON');
      }
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
          new Runner(),
          new RunContext(),
        ),
      );

      expect(result).toHaveLength(actions.length);
      expect(
        (result[result.length - 1]?.rawItem as protocol.ComputerCallResultItem)
          .output,
      ).toEqual({ type: 'computer_screenshot', data: expect.any(String) });
      expect(comp.screenshot).toHaveBeenCalled();
    });

    it('returns empty image when screenshot fails', async () => {
      const comp = makeComputer();
      vi.spyOn(comp, 'screenshot').mockRejectedValue(new Error('bad'));
      const tool = computerTool({ computer: comp });
      const call = {
        toolCall: {
          id: 'id1',
          type: 'computer_call',
          callId: 'id1',
          status: 'completed',
          action: { type: 'screenshot' },
        } as protocol.ComputerUseCallItem,
        computer: tool,
      };

      const mockLogger = createMockLogger();
      const [result] = await withTrace('test', () =>
        executeComputerActions(
          new Agent({ name: 'C' }),
          [call],
          new Runner(),
          new RunContext(),
          mockLogger,
        ),
      );

      const rawItem = result.rawItem as protocol.ComputerCallResultItem;
      expect(rawItem.output).toEqual({
        type: 'computer_screenshot',
        data: '',
      });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to execute computer action:',
        expect.any(Error),
      );
    });
  });

  it('returns approval item when needsApproval is true and not yet approved', async () => {
    const shell = new FakeShell();
    const shellToolDef = shellTool({ shell, needsApproval: async () => true });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({ tracingDisabled: true });
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };

    const results = await executeShellActions(
      agent,
      [{ toolCall, shell: shellToolDef } as any],
      runner,
      runContext,
    );

    expect(results).toHaveLength(1);
    expect(results[0].type).toBe('tool_approval_item');
    expect(shell.calls).toHaveLength(0);
  });

  it('honors onApproval for shell tools', async () => {
    const shell = new FakeShell();
    const onApproval = vi.fn(async () => ({ approve: true }));
    const shellToolDef = shellTool({
      shell,
      needsApproval: async () => true,
      onApproval,
    });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({ tracingDisabled: true });
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };

    const results = await executeShellActions(
      agent,
      [{ toolCall, shell: shellToolDef } as any],
      runner,
      runContext,
    );

    expect(onApproval).toHaveBeenCalled();
    expect(shell.calls).toHaveLength(1);
    expect(results[0].rawItem.type).toBe('shell_call_output');
  });

  it('returns failed output when approval explicitly rejected', async () => {
    const shell = new FakeShell();
    const shellToolDef = shellTool({ shell, needsApproval: async () => true });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({ tracingDisabled: true });
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };

    runContext.rejectTool(
      new ToolApprovalItem(toolCall, agent, shellToolDef.name),
    );

    const results = await executeShellActions(
      agent,
      [{ toolCall, shell: shellToolDef } as any],
      runner,
      runContext,
    );

    const rawItem = results[0].rawItem as protocol.ShellCallResultItem;
    expect(rawItem.output).toEqual([
      {
        stdout: '',
        stderr: 'Tool execution was not approved.',
        outcome: { type: 'exit', exitCode: null },
      },
    ]);
  });

  it('returns output with maxOutputLength metadata when provided by provider', async () => {
    const shell = new FakeShell();
    shell.result = {
      output: [
        {
          stdout: 'hi',
          stderr: 'stderr-info',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
      maxOutputLength: 123,
    };
    const shellToolDef = shellTool({ shell });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({ tracingDisabled: true });
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };

    const results = await executeShellActions(
      agent,
      [{ toolCall, shell: shellToolDef } as any],
      runner,
      runContext,
    );

    const rawItem = results[0].rawItem as protocol.ShellCallResultItem;
    expect(rawItem.maxOutputLength).toBe(123);
  });

  it('passes through providerData when present', async () => {
    const shell = new FakeShell();
    shell.result = {
      output: [
        {
          stdout: 'hi',
          stderr: 'stderr-info',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
      providerData: { foo: 'bar' },
    };
    const shellToolDef = shellTool({ shell });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({ tracingDisabled: true });
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };

    const results = await executeShellActions(
      agent,
      [{ toolCall, shell: shellToolDef } as any],
      runner,
      runContext,
    );

    const rawItem = results[0].rawItem as protocol.ShellCallResultItem;
    expect(rawItem.providerData).toEqual(shell.result.providerData);
  });
});
