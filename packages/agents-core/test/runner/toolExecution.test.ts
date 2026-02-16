import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';

import {
  setDefaultModelProvider,
  setTraceProcessors,
  setTracingDisabled,
  withTrace,
} from '../../src';
import { Agent, AgentOutputType } from '../../src/agent';
import { saveAgentToolRunResult } from '../../src/agentToolRunResults';
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
  ToolTimeoutError,
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
import logger from '../../src/logger';
import {
  defaultProcessor,
  TracingProcessor,
} from '../../src/tracing/processor';
import type { Span } from '../../src/tracing/spans';
import type { Trace } from '../../src/tracing/traces';

const createMockLogger = (): Logger => ({
  namespace: 'test',
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  dontLogModelData: true,
  dontLogToolData: true,
});

const CUSTOM_REJECTION_MESSAGE =
  'Tool execution was dismissed. You may retry this tool later.';

class RecordingProcessor implements TracingProcessor {
  tracesStarted: Trace[] = [];
  tracesEnded: Trace[] = [];
  spansStarted: Span<any>[] = [];
  spansEnded: Span<any>[] = [];

  async onTraceStart(trace: Trace): Promise<void> {
    this.tracesStarted.push(trace);
  }
  async onTraceEnd(trace: Trace): Promise<void> {
    this.tracesEnded.push(trace);
  }
  async onSpanStart(span: Span<any>): Promise<void> {
    this.spansStarted.push(span);
  }
  async onSpanEnd(span: Span<any>): Promise<void> {
    this.spansEnded.push(span);
  }
  async shutdown(): Promise<void> {
    /* noop */
  }
  async forceFlush(): Promise<void> {
    /* noop */
  }
}

async function withRecordingTrace<T>(
  fn: (processor: RecordingProcessor) => Promise<T>,
): Promise<T> {
  const processor = new RecordingProcessor();
  setTracingDisabled(false);
  setTraceProcessors([processor]);

  try {
    return await fn(processor);
  } finally {
    setTraceProcessors([defaultProcessor()]);
    setTracingDisabled(true);
  }
}

function getEndedFunctionSpan(
  processor: RecordingProcessor,
  toolName: string,
): Span<any> {
  const functionSpan = processor.spansEnded.find(
    (span) =>
      span.spanData.type === 'function' && span.spanData.name === toolName,
  );
  expect(functionSpan).toBeDefined();
  return functionSpan as Span<any>;
}

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

  it('emits a function span for computer actions', async () => {
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
    const computer = computerTool({ computer: fakeComputer });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1_trace',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };

    await withRecordingTrace(async (processor) => {
      await withTrace('test', () =>
        executeComputerActions(
          new Agent({ name: 'Comp' }),
          [{ toolCall: call, computer }],
          new Runner({ tracingDisabled: false }),
          new RunContext(),
        ),
      );

      getEndedFunctionSpan(processor, computer.name);
    });
  });

  it('records span errors for failed computer actions', async () => {
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn().mockRejectedValue(new Error('computer boom')),
      click: vi.fn(),
      doubleClick: vi.fn(),
      drag: vi.fn(),
      keypress: vi.fn(),
      move: vi.fn(),
      scroll: vi.fn(),
      type: vi.fn(),
      wait: vi.fn(),
    } as any;
    const computer = computerTool({ computer: fakeComputer });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1_trace_error',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };
    const mockLogger = createMockLogger();

    await withRecordingTrace(async (processor) => {
      await withTrace('test', () =>
        executeComputerActions(
          new Agent({ name: 'Comp' }),
          [{ toolCall: call, computer }],
          new Runner({ tracingDisabled: false }),
          new RunContext(),
          mockLogger,
        ),
      );

      const functionSpan = getEndedFunctionSpan(processor, computer.name);
      expect(functionSpan.error).toEqual({
        message: 'Error running tool',
        data: {
          tool_name: computer.name,
          error: 'computer boom',
        },
      });
    });
  });

  it('does not trace computer action input/output when sensitive data is disabled', async () => {
    const secretInput = 'super-secret-input';
    const secretOutput = 'super-secret-output';
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn().mockResolvedValue(secretOutput),
      click: vi.fn(),
      doubleClick: vi.fn(),
      drag: vi.fn(),
      keypress: vi.fn(),
      move: vi.fn(),
      scroll: vi.fn(),
      type: vi.fn(),
      wait: vi.fn(),
    } as any;
    const computer = computerTool({ computer: fakeComputer });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1_trace_sensitive',
      status: 'completed',
      action: { type: 'type', text: secretInput } as any,
    };

    await withRecordingTrace(async (processor) => {
      await withTrace('test', () =>
        executeComputerActions(
          new Agent({ name: 'Comp' }),
          [{ toolCall: call, computer }],
          new Runner({
            tracingDisabled: false,
            traceIncludeSensitiveData: false,
          }),
          new RunContext(),
        ),
      );

      const functionSpan = getEndedFunctionSpan(processor, computer.name);
      expect(functionSpan.spanData.input).toBe('');
      expect(functionSpan.spanData.output).toBe('');
      expect(JSON.stringify(functionSpan.toJSON())).not.toContain(secretInput);
      expect(JSON.stringify(functionSpan.toJSON())).not.toContain(secretOutput);
    });
  });

  it('defaults missing needsApproval to false for computer tools', async () => {
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
    const tool = {
      type: 'computer',
      name: 'computer_use_preview',
      computer: fakeComputer,
    } as any;
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
    expect(items[0]).toBeInstanceOf(ToolCallOutputItem);
    expect(fakeComputer.screenshot).toHaveBeenCalledTimes(1);
  });

  it('passes RunContext to computer actions', async () => {
    const runContext = new RunContext({ run: 'ctx' });
    let clickContext: RunContext | undefined;
    let screenshotContext: RunContext | undefined;
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn().mockImplementation(async (ctx?: RunContext) => {
        screenshotContext = ctx;
        return 'img';
      }),
      click: vi
        .fn()
        .mockImplementation(
          async (_x: number, _y: number, _button: string, ctx?: RunContext) => {
            clickContext = ctx;
          },
        ),
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
      callId: 'c2',
      status: 'completed',
      action: { type: 'click', x: 1, y: 2, button: 'left' },
    };

    await executeComputerActions(
      new Agent({ name: 'Comp' }),
      [{ toolCall: call, computer: tool }],
      new Runner(),
      runContext,
    );
    expect(clickContext).toBe(runContext);
    expect(screenshotContext).toBe(runContext);
  });

  it('returns approval items when computer actions require approval', async () => {
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
    const tool = computerTool({ computer: fakeComputer, needsApproval: true });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c3',
      status: 'completed',
      action: { type: 'screenshot' },
    };

    const items = await executeComputerActions(
      new Agent({ name: 'Comp' }),
      [{ toolCall: call, computer: tool }],
      new Runner(),
      new RunContext(),
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(ToolApprovalItem);
    expect(fakeComputer.screenshot).not.toHaveBeenCalled();
  });

  it('returns rejection output when computer action is rejected', async () => {
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
    const tool = computerTool({ computer: fakeComputer, needsApproval: true });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c3b',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const agent = new Agent({ name: 'Comp' });
    const runContext = new RunContext();
    runContext.rejectTool(new ToolApprovalItem(call, agent, tool.name));

    const items = await executeComputerActions(
      agent,
      [{ toolCall: call, computer: tool }],
      new Runner(),
      runContext,
    );

    expect(items).toHaveLength(2);
    expect(items[0]).toBeInstanceOf(ToolCallOutputItem);
    expect(items[1]).toBeInstanceOf(MessageOutputItem);
    const rawItem = (items[0] as ToolCallOutputItem)
      .rawItem as protocol.ComputerCallResultItem;
    expect(rawItem.output.data).toMatch(/^data:image\/png;base64,/);
    expect(rawItem.output.providerData).toEqual({
      approvalStatus: 'rejected',
      message: 'Tool execution was not approved.',
    });
    expect((items[1] as MessageOutputItem).content).toBe(
      'Tool execution was not approved.',
    );
    expect(fakeComputer.screenshot).not.toHaveBeenCalled();
  });

  it('uses toolErrorFormatter message when computer action is rejected', async () => {
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
    const tool = computerTool({ computer: fakeComputer, needsApproval: true });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c3c',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const agent = new Agent({ name: 'Comp' });
    const runContext = new RunContext();
    runContext.rejectTool(new ToolApprovalItem(call, agent, tool.name));
    const runner = new Runner({
      toolErrorFormatter: () => CUSTOM_REJECTION_MESSAGE,
    });

    const items = await executeComputerActions(
      agent,
      [{ toolCall: call, computer: tool }],
      runner,
      runContext,
      undefined,
      runner.config.toolErrorFormatter,
    );

    expect(items).toHaveLength(2);
    const rawItem = (items[0] as ToolCallOutputItem)
      .rawItem as protocol.ComputerCallResultItem;
    expect(rawItem.output.providerData).toEqual({
      approvalStatus: 'rejected',
      message: CUSTOM_REJECTION_MESSAGE,
    });
    expect((items[1] as MessageOutputItem).content).toBe(
      CUSTOM_REJECTION_MESSAGE,
    );
  });

  it('executes computer actions after approval', async () => {
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
    const tool = computerTool({ computer: fakeComputer, needsApproval: true });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c4',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const agent = new Agent({ name: 'Comp' });
    const runContext = new RunContext();
    runContext.approveTool(new ToolApprovalItem(call, agent, tool.name));

    const items = await executeComputerActions(
      agent,
      [{ toolCall: call, computer: tool }],
      new Runner(),
      runContext,
    );
    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(ToolCallOutputItem);
    expect(fakeComputer.screenshot).toHaveBeenCalledTimes(1);
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
  it('skips malformed local shell actions without implementation', async () => {
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
      [
        {
          toolCall,
          shell: {
            type: 'shell',
            name: 'shell',
            environment: { type: 'local' },
            needsApproval: async () => false,
          },
        } as any,
      ],
      runner,
      runContext,
      mockLogger,
    );

    expect(results).toEqual([]);
    expect(mockLogger.warn).toHaveBeenCalledWith(
      'Skipping shell action for tool "shell" because no local shell implementation is configured.',
    );
  });

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

  it('emits a function span for shell actions', async () => {
    const shell = new FakeShell();
    const shellDef = shellTool({ shell });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell_trace',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };

    await withRecordingTrace(async (processor) => {
      await withTrace('test', () =>
        executeShellActions(
          agent,
          [{ toolCall, shell: shellDef } as any],
          new Runner({ tracingDisabled: false }),
          runContext,
        ),
      );

      getEndedFunctionSpan(processor, shellDef.name);
    });
  });

  it('records span errors for failed shell actions', async () => {
    const shell = new FakeShell();
    shell.error = new Error('shell boom');
    const shellDef = shellTool({ shell });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell_trace_error',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const mockLogger = createMockLogger();

    await withRecordingTrace(async (processor) => {
      await withTrace('test', () =>
        executeShellActions(
          agent,
          [{ toolCall, shell: shellDef } as any],
          new Runner({ tracingDisabled: false }),
          runContext,
          mockLogger,
        ),
      );

      const functionSpan = getEndedFunctionSpan(processor, shellDef.name);
      expect(functionSpan.error).toEqual({
        message: 'Error running tool',
        data: {
          tool_name: shellDef.name,
          error: 'shell boom',
        },
      });
    });
  });

  it('does not trace shell input/output when sensitive data is disabled', async () => {
    const secretInput = 'super-secret-shell-input';
    const secretOutput = 'super-secret-shell-output';
    const shell = new FakeShell();
    shell.result = {
      output: [
        {
          stdout: secretOutput,
          stderr: '',
          outcome: { type: 'exit', exitCode: 0 },
        },
      ],
    };
    const shellDef = shellTool({ shell });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell_trace_sensitive',
      status: 'completed',
      action: { commands: [secretInput] },
    };

    await withRecordingTrace(async (processor) => {
      await withTrace('test', () =>
        executeShellActions(
          agent,
          [{ toolCall, shell: shellDef } as any],
          new Runner({
            tracingDisabled: false,
            traceIncludeSensitiveData: false,
          }),
          runContext,
        ),
      );

      const functionSpan = getEndedFunctionSpan(processor, shellDef.name);
      expect(functionSpan.spanData.input).toBe('');
      expect(functionSpan.spanData.output).toBe('');
      expect(JSON.stringify(functionSpan.toJSON())).not.toContain(secretInput);
      expect(JSON.stringify(functionSpan.toJSON())).not.toContain(secretOutput);
    });
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

    it('emits a function span for apply_patch operations', async () => {
      const editor = new FakeEditor();
      const applyPatch = applyPatchTool({ editor });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch_trace',
        status: 'completed',
        operation: {
          type: 'update_file',
          path: 'README.md',
          diff: 'diff --git',
        },
      };

      await withRecordingTrace(async (processor) => {
        await withTrace('test', () =>
          executeApplyPatchOperations(
            agent,
            [{ toolCall, applyPatch } as any],
            new Runner({ tracingDisabled: false }),
            runContext,
          ),
        );

        getEndedFunctionSpan(processor, applyPatch.name);
      });
    });

    it('records span errors for failed apply_patch operations', async () => {
      const editor = new FakeEditor();
      editor.errors.delete_file = new Error('patch boom');
      const applyPatch = applyPatchTool({ editor });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch_trace_error',
        status: 'completed',
        operation: {
          type: 'delete_file',
          path: 'README.md',
        },
      };
      const mockLogger = createMockLogger();

      await withRecordingTrace(async (processor) => {
        await withTrace('test', () =>
          executeApplyPatchOperations(
            agent,
            [{ toolCall, applyPatch } as any],
            new Runner({ tracingDisabled: false }),
            runContext,
            mockLogger,
          ),
        );

        const functionSpan = getEndedFunctionSpan(processor, applyPatch.name);
        expect(functionSpan.error).toEqual({
          message: 'Error running tool',
          data: {
            tool_name: applyPatch.name,
            error: 'patch boom',
          },
        });
      });
    });

    it('does not trace apply_patch input/output when sensitive data is disabled', async () => {
      const secretInput = 'super-secret-patch-input';
      const secretOutput = 'super-secret-patch-output';
      const editor = new FakeEditor();
      editor.result = {
        status: 'completed',
        output: secretOutput,
      };
      const applyPatch = applyPatchTool({ editor });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch_trace_sensitive',
        status: 'completed',
        operation: {
          type: 'update_file',
          path: 'README.md',
          diff: secretInput,
        },
      };

      await withRecordingTrace(async (processor) => {
        await withTrace('test', () =>
          executeApplyPatchOperations(
            agent,
            [{ toolCall, applyPatch } as any],
            new Runner({
              tracingDisabled: false,
              traceIncludeSensitiveData: false,
            }),
            runContext,
          ),
        );

        const functionSpan = getEndedFunctionSpan(processor, applyPatch.name);
        expect(functionSpan.spanData.input).toBe('');
        expect(functionSpan.spanData.output).toBe('');
        expect(JSON.stringify(functionSpan.toJSON())).not.toContain(
          secretInput,
        );
        expect(JSON.stringify(functionSpan.toJSON())).not.toContain(
          secretOutput,
        );
      });
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

    it('uses toolErrorFormatter message for rejected apply_patch operations', async () => {
      const editor = new FakeEditor();
      const applyPatch = applyPatchTool({
        editor,
        needsApproval: async () => true,
      });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const runner = new Runner({
        tracingDisabled: true,
        toolErrorFormatter: () => CUSTOM_REJECTION_MESSAGE,
      });
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch_custom',
        status: 'completed',
        operation: {
          type: 'delete_file',
          path: 'README.md',
        },
      };

      runContext.rejectTool(
        new ToolApprovalItem(toolCall, agent, applyPatch.name),
      );

      const results = await executeApplyPatchOperations(
        agent,
        [{ toolCall, applyPatch } as any],
        runner,
        runContext,
        undefined,
        runner.config.toolErrorFormatter,
      );

      const rawItem = results[0].rawItem as protocol.ApplyPatchCallResultItem;
      expect(rawItem.status).toBe('failed');
      expect(rawItem.output).toBe(CUSTOM_REJECTION_MESSAGE);
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

    it('uses toolErrorFormatter message when approval is false', async () => {
      const t = makeTool(true);
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(false as any);

      const customRunner = new Runner({
        tracingDisabled: true,
        toolErrorFormatter: () => CUSTOM_REJECTION_MESSAGE,
      });

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          customRunner,
          state,
          customRunner.config.toolErrorFormatter,
        ),
      );

      expect(res[0].type).toBe('function_output');
      if (res[0].type === 'function_output') {
        expect(res[0].output).toBe(CUSTOM_REJECTION_MESSAGE);
        const rawItem = res[0].runItem
          .rawItem as protocol.FunctionCallResultItem;
        expect(rawItem.output).toEqual({
          type: 'text',
          text: CUSTOM_REJECTION_MESSAGE,
        });
      }
    });

    it('does not trace formatted rejection text when sensitive data is disabled', async () => {
      const t = makeTool(true);
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(false as any);
      const sensitiveMessage = 'sensitive secret from formatter';
      const processor = new RecordingProcessor();

      const customRunner = new Runner({
        tracingDisabled: false,
        traceIncludeSensitiveData: false,
        toolErrorFormatter: () => sensitiveMessage,
      });

      setTracingDisabled(false);
      setTraceProcessors([processor]);

      try {
        const res = await withTrace('test', () =>
          executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall, tool: t }],
            customRunner,
            state,
            customRunner.config.toolErrorFormatter,
          ),
        );

        expect(res[0].type).toBe('function_output');
        if (res[0].type === 'function_output') {
          expect(res[0].output).toBe(sensitiveMessage);
        }

        const functionSpan = processor.spansEnded.find(
          (span) =>
            span.spanData.type === 'function' && span.spanData.name === t.name,
        );
        expect(functionSpan).toBeDefined();
        expect(functionSpan?.spanData.output).toBe('');
        expect(functionSpan?.error?.message).toBe(
          'Tool execution was not approved.',
        );
        expect(JSON.stringify(functionSpan?.toJSON())).not.toContain(
          sensitiveMessage,
        );
      } finally {
        setTraceProcessors([defaultProcessor()]);
        setTracingDisabled(true);
      }
    });

    it('falls back to default rejection message when toolErrorFormatter throws', async () => {
      const t = makeTool(true);
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(false as any);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

      const customRunner = new Runner({
        tracingDisabled: true,
        toolErrorFormatter: () => {
          throw new Error('formatter failed');
        },
      });

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          customRunner,
          state,
          customRunner.config.toolErrorFormatter,
        ),
      );

      expect(res[0].type).toBe('function_output');
      if (res[0].type === 'function_output') {
        expect(res[0].output).toBe('Tool execution was not approved.');
      }
      expect(warnSpy).toHaveBeenCalledWith(
        'toolErrorFormatter threw while formatting approval rejection: formatter failed',
      );
      warnSpy.mockRestore();
    });

    it('clears pending nested agent run when approval is rejected', async () => {
      const t = makeTool(true);
      state.setPendingAgentToolRun(t.name, toolCall.callId, 'pending-state');
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(false as any);

      await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      expect(state.hasPendingAgentToolRun(t.name, toolCall.callId)).toBe(false);
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

    it('returns a timeout message when timeoutBehavior is error_as_result', async () => {
      const t = tool({
        name: 'slow_tool',
        description: 'slow tool',
        parameters: z.object({}),
        timeoutMs: 5,
        execute: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return 'late';
        }),
      }) as unknown as FunctionTool;

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      expect(res).toHaveLength(1);
      expect(res[0].type).toBe('function_output');
      if (res[0].type === 'function_output') {
        expect(res[0].output).toBe("Tool 'slow_tool' timed out after 5ms.");
      }
    });

    it('throws ToolTimeoutError with run state when timeoutBehavior is raise_exception', async () => {
      const t = tool({
        name: 'slow_tool',
        description: 'slow tool',
        parameters: z.object({}),
        timeoutMs: 5,
        timeoutBehavior: 'raise_exception',
        execute: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return 'late';
        }),
      }) as unknown as FunctionTool;

      const timeoutError = (await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      ).catch((error) => error)) as ToolTimeoutError;

      expect(timeoutError).toBeInstanceOf(ToolTimeoutError);
      expect(timeoutError.state).toBe(state);
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

    it('acknowledges pending safety checks via onSafetyCheck', async () => {
      const comp = makeComputer();
      const onSafetyCheck = vi.fn(async ({ pendingSafetyChecks }) => ({
        acknowledgedSafetyChecks: pendingSafetyChecks,
      }));
      const tool = computerTool({ computer: comp, onSafetyCheck });
      const call = {
        toolCall: {
          id: 'id1',
          type: 'computer_call',
          callId: 'id1',
          status: 'completed',
          action: { type: 'screenshot' },
          providerData: {
            pending_safety_checks: [
              {
                id: 'sc1',
                code: 'malicious_instructions',
                message: 'Review before proceeding.',
              },
            ],
          },
        } as protocol.ComputerUseCallItem,
        computer: tool,
      };

      const [result] = await withTrace('test', () =>
        executeComputerActions(
          new Agent({ name: 'C' }),
          [call],
          new Runner(),
          new RunContext(),
        ),
      );

      const rawItem = result.rawItem as protocol.ComputerCallResultItem;
      expect(onSafetyCheck).toHaveBeenCalledWith({
        runContext: expect.any(RunContext),
        pendingSafetyChecks: [
          {
            id: 'sc1',
            code: 'malicious_instructions',
            message: 'Review before proceeding.',
          },
        ],
        toolCall: call.toolCall,
      });
      expect(rawItem.providerData?.acknowledgedSafetyChecks).toEqual([
        {
          id: 'sc1',
          code: 'malicious_instructions',
          message: 'Review before proceeding.',
        },
      ]);
    });

    it('accepts acknowledged_safety_checks from onSafetyCheck', async () => {
      const comp = makeComputer();
      const onSafetyCheck = vi.fn(async (_args) => ({
        acknowledged_safety_checks: [{ id: 'sc2', code: 'irrelevant_domain' }],
      }));
      const tool = computerTool({ computer: comp, onSafetyCheck });
      const call = {
        toolCall: {
          id: 'id2',
          type: 'computer_call',
          callId: 'id2',
          status: 'completed',
          action: { type: 'screenshot' },
          providerData: {
            pending_safety_checks: [{ id: 'sc2', code: 'irrelevant_domain' }],
          },
        } as protocol.ComputerUseCallItem,
        computer: tool,
      };

      const [result] = await withTrace('test', () =>
        executeComputerActions(
          new Agent({ name: 'C' }),
          [call],
          new Runner(),
          new RunContext(),
        ),
      );

      const rawItem = result.rawItem as protocol.ComputerCallResultItem;
      expect(rawItem.providerData?.acknowledgedSafetyChecks).toEqual([
        { id: 'sc2', code: 'irrelevant_domain' },
      ]);
    });

    it('accepts boolean true from onSafetyCheck', async () => {
      const comp = makeComputer();
      const onSafetyCheck = vi.fn(async (_args) => true);
      const tool = computerTool({ computer: comp, onSafetyCheck });
      const call = {
        toolCall: {
          id: 'id3',
          type: 'computer_call',
          callId: 'id3',
          status: 'completed',
          action: { type: 'screenshot' },
          providerData: {
            pending_safety_checks: [{ id: 'sc3', code: 'sensitive_domain' }],
          },
        } as protocol.ComputerUseCallItem,
        computer: tool,
      };

      const [result] = await withTrace('test', () =>
        executeComputerActions(
          new Agent({ name: 'C' }),
          [call],
          new Runner(),
          new RunContext(),
        ),
      );

      const rawItem = result.rawItem as protocol.ComputerCallResultItem;
      expect(rawItem.providerData?.acknowledgedSafetyChecks).toEqual([
        { id: 'sc3', code: 'sensitive_domain' },
      ]);
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

  it('uses toolErrorFormatter message when shell approval is rejected', async () => {
    const shell = new FakeShell();
    const shellToolDef = shellTool({ shell, needsApproval: async () => true });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({
      tracingDisabled: true,
      toolErrorFormatter: () => CUSTOM_REJECTION_MESSAGE,
    });
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell_custom',
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
      undefined,
      runner.config.toolErrorFormatter,
    );

    const rawItem = results[0].rawItem as protocol.ShellCallResultItem;
    expect(rawItem.output).toEqual([
      {
        stdout: '',
        stderr: CUSTOM_REJECTION_MESSAGE,
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
