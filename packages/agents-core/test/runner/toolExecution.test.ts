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
import { getAgentToolParentRunConfigFromDetails } from '../../src/agentToolRunConfig';
import {
  RunHandoffCallItem as HandoffCallItem,
  RunHandoffOutputItem as HandoffOutputItem,
  RunMessageOutputItem as MessageOutputItem,
  RunReasoningItem as ReasoningItem,
  RunToolApprovalItem as ToolApprovalItem,
  RunToolCallItem as ToolCallItem,
  RunToolCallOutputItem as ToolCallOutputItem,
  RunToolSearchCallItem as ToolSearchCallItem,
  RunToolSearchOutputItem as ToolSearchOutputItem,
} from '../../src/items';
import {
  addStepToRunResult,
  streamStepItemsToRunResult,
} from '../../src/runner/streaming';
import {
  checkForFinalOutputFromTools,
  collectInterruptions,
  executeApplyPatchOperations,
  executeComputerActions,
  executeFunctionToolCalls,
  executeHandoffCalls,
  executeShellActions,
  getToolCallOutputItem,
} from '../../src/runner/toolExecution';
import logger, { type Logger } from '../../src/logger';
import { Runner } from '../../src/run';
import { RunContext } from '../../src/runContext';
import { RunResult, StreamedRunResult } from '../../src/result';
import { RunState } from '../../src/runState';
import { handoff } from '../../src/handoff';
import {
  InvalidToolInputError,
  InvalidToolOutputError,
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
  type FunctionToolCustomDataContext,
  FunctionToolResult,
  type ToolCallDetails,
  applyPatchTool,
  computerTool,
  shellTool,
  tool,
  toolNamespace,
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
import { runWithSiblingCancellation } from '../../src/runner/siblingCancellation';
import { z } from 'zod';
import {
  defaultProcessor,
  TracingProcessor,
} from '../../src/tracing/processor';
import type { Span } from '../../src/tracing/spans';
import type { Trace } from '../../src/tracing/traces';
import { getFunctionToolStateKey } from '../../src/toolIdentity';

const createMockLogger = (): Logger => ({
  namespace: 'test',
  debug: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  dontLogModelData: true,
  dontLogToolData: true,
});

describe('Programmatic Tool Calling outputs', () => {
  it('copies caller linkage to function outputs', () => {
    const output = getToolCallOutputItem(
      {
        type: 'function_call',
        id: 'fc_1',
        callId: 'call_1',
        name: 'lookup',
        arguments: '{}',
        caller: { type: 'program', callerId: 'call_program_1' },
      },
      { value: 'ok' },
    );

    expect(output.caller).toEqual({
      type: 'program',
      callerId: 'call_program_1',
    });
  });
});

const CUSTOM_REJECTION_MESSAGE =
  'Tool execution was dismissed. You may retry this tool later.';
const REDACTED_TOOL_ERROR_MESSAGE =
  'Tool execution failed. Error details are redacted.';

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

function getEndedHandoffSpan(processor: RecordingProcessor): Span<any> {
  const handoffSpan = processor.spansEnded.find(
    (span) => span.spanData.type === 'handoff',
  );
  expect(handoffSpan).toBeDefined();
  return handoffSpan as Span<any>;
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

  it('preserves namespace on function_call_result items', () => {
    const output = getToolCallOutputItem(
      {
        ...TEST_MODEL_FUNCTION_CALL,
        namespace: 'crm',
      },
      'hi',
    );

    expect(output).toEqual({
      type: 'function_call_result',
      name: TEST_MODEL_FUNCTION_CALL.name,
      namespace: 'crm',
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

  it('converts MCP image outputs with mimeType into data URLs', () => {
    const base64 = Buffer.from('hi').toString('base64');
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'image',
      data: base64,
      mimeType: 'image/jpeg',
    });

    expect(result.output).toEqual([
      {
        type: 'input_image',
        image: `data:image/jpeg;base64,${base64}`,
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

  it('serializes schema-backed content-like objects as JSON text', () => {
    const output = getToolCallOutputItem(
      TEST_MODEL_FUNCTION_CALL,
      {
        type: 'text',
        text: 'schema value',
      },
      {
        outputSchema: {
          type: 'object',
          properties: {
            type: { type: 'string' },
            text: { type: 'string' },
          },
          required: ['type', 'text'],
          additionalProperties: false,
        },
      },
    );

    expect(output.output).toEqual({
      type: 'text',
      text: JSON.stringify({ type: 'text', text: 'schema value' }),
    });
  });

  it('returns an empty array as plain text output', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, []);

    expect(result.output).toEqual({
      type: 'text',
      text: '[]',
    });
  });
});

describe('checkForFinalOutputFromTools', () => {
  it('keeps the same function approval identity for separate agents', () => {
    const root = new Agent({ name: 'Approval identity root' });
    const child = new Agent({ name: 'Approval identity child' });
    const createCall = (id: string): protocol.FunctionCallItem => ({
      type: 'function_call',
      id,
      callId: 'shared_approval_call_id',
      name: 'shared_tool',
      status: 'completed',
      arguments: '{}',
    });

    const interruptions = collectInterruptions(
      [],
      [
        new ToolApprovalItem(createCall('root_call'), root),
        new ToolApprovalItem(createCall('child_call'), child),
      ],
    );

    expect(interruptions).toHaveLength(2);
    expect(interruptions.map((item) => item.agent)).toEqual([root, child]);
  });

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

  it.each(['stop_on_first_tool' as const, { stopAtToolNames: ['weather'] }])(
    'does not promote a completed sibling after an incomplete result with %j',
    async (behavior) => {
      const agent = new Agent({
        name: 'IncompleteResult',
        toolUseBehavior: behavior,
      });
      const cancelledTool = tool({
        name: 'cancelled_tool',
        description: 'cancelled tool',
        parameters: z.object({}),
        execute: async () => 'unused',
      });
      const incompleteResult: FunctionToolResult = {
        type: 'function_output',
        tool: cancelledTool,
        output: 'aborted',
        runItem: new ToolCallOutputItem(
          {
            type: 'function_call_result',
            name: 'cancelled_tool',
            callId: 'call_cancelled_incomplete',
            status: 'incomplete',
            output: { type: 'text', text: 'aborted' },
          },
          agent,
          'aborted',
        ),
      };

      const res = await checkForFinalOutputFromTools(
        agent,
        [incompleteResult, toolResult],
        state,
      );

      expect(res.isFinalOutput).toBe(false);
    },
  );

  it('does not invoke custom finalization after an incomplete result', async () => {
    const finalize = vi.fn(async () => ({
      isFinalOutput: true as const,
      finalOutput: 'sunny',
      isInterrupted: undefined,
    }));
    const agent = new Agent({
      name: 'CustomIncompleteResult',
      toolUseBehavior: finalize,
    });
    const incompleteResult: FunctionToolResult = {
      type: 'function_output',
      tool: weatherTool,
      output: 'aborted',
      runItem: new ToolCallOutputItem(
        {
          type: 'function_call_result',
          name: 'weather',
          callId: 'call_weather_incomplete',
          status: 'incomplete',
          output: { type: 'text', text: 'aborted' },
        },
        agent,
        'aborted',
      ),
    };

    const res = await checkForFinalOutputFromTools(
      agent,
      [incompleteResult, toolResult],
      state,
    );

    expect(res.isFinalOutput).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
  });

  it.each(['stop_on_first_tool' as const, { stopAtToolNames: ['weather'] }])(
    'does not finalize program-owned tool results with %j',
    async (behavior) => {
      const agent = new Agent({
        name: 'ProgramOwnedResult',
        toolUseBehavior: behavior,
      });
      const programOwnedResult: FunctionToolResult = {
        type: 'function_output',
        tool: weatherTool,
        output: 'sunny',
        runItem: new ToolCallOutputItem(
          {
            type: 'function_call_result',
            name: 'weather',
            callId: 'call_weather',
            status: 'completed',
            output: { type: 'text', text: 'sunny' },
            caller: { type: 'program', callerId: 'call_program' },
          },
          agent,
          'sunny',
        ),
      };

      const res = await checkForFinalOutputFromTools(
        agent,
        [programOwnedResult],
        state,
      );

      expect(res.isFinalOutput).toBe(false);
    },
  );

  it('does not pass program-owned tool results to custom finalization', async () => {
    const finalize = vi.fn(async () => ({
      isFinalOutput: true as const,
      finalOutput: 'sunny',
      isInterrupted: undefined,
    }));
    const agent = new Agent({
      name: 'CustomProgramOwnedResult',
      toolUseBehavior: finalize,
    });
    const programOwnedResult: FunctionToolResult = {
      type: 'function_output',
      tool: weatherTool,
      output: 'sunny',
      runItem: new ToolCallOutputItem(
        {
          type: 'function_call_result',
          name: 'weather',
          callId: 'call_weather',
          status: 'completed',
          output: { type: 'text', text: 'sunny' },
          caller: { type: 'program', callerId: 'call_program' },
        },
        agent,
        'sunny',
      ),
    };

    const res = await checkForFinalOutputFromTools(
      agent,
      [programOwnedResult],
      state,
    );

    expect(res.isFinalOutput).toBe(false);
    expect(finalize).not.toHaveBeenCalled();
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

  it('matches stopAtToolNames against namespaced tool identities', async () => {
    const [crmLookup] = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [
        tool({
          name: 'lookup_account',
          description: 'Look up an account in CRM.',
          parameters: z.object({
            accountId: z.string(),
          }),
          execute: async () => 'crm result',
        }),
      ],
    });
    const agent = new Agent({
      name: 'NamespacedStop',
      toolUseBehavior: { stopAtToolNames: ['crm.lookup_account'] },
    });
    const toolResult: FunctionToolResult = {
      type: 'function_output',
      tool: crmLookup,
      output: 'crm result',
      runItem: {} as any,
    };

    const res = await checkForFinalOutputFromTools(agent, [toolResult], state);

    expect(res).toEqual({
      isFinalOutput: true,
      isInterrupted: undefined,
      finalOutput: 'crm result',
    });
  });

  it('matches namespaced tools by bare stopAtToolNames entries', async () => {
    const [crmLookup] = toolNamespace({
      name: 'crm',
      description: 'CRM tools',
      tools: [
        tool({
          name: 'lookup_account',
          description: 'Look up an account in CRM.',
          parameters: z.object({
            accountId: z.string(),
          }),
          execute: async () => 'crm result',
        }),
      ],
    });
    const agent = new Agent({
      name: 'NamespacedStopNoMatch',
      toolUseBehavior: { stopAtToolNames: ['lookup_account'] },
    });
    const toolResult: FunctionToolResult = {
      type: 'function_output',
      tool: crmLookup,
      output: 'crm result',
      runItem: {} as any,
    };

    const res = await checkForFinalOutputFromTools(agent, [toolResult], state);

    expect(res).toEqual({
      isFinalOutput: true,
      isInterrupted: undefined,
      finalOutput: 'crm result',
    });
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
    const toolSearchCallItem = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        id: 'ts_call',
        status: 'completed',
        arguments: {
          paths: ['crm'],
          query: 'profile',
        },
      },
      agent,
    );
    const toolSearchOutputItem = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        id: 'ts_output',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'lookup_account',
            namespace: 'crm',
          },
        ],
      },
      agent,
    );
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
        toolSearchCallItem,
        toolSearchOutputItem,
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
      'tool_search_called',
      'tool_search_output_created',
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

  it.each([
    [true, false],
    [false, true],
    [true, true],
  ])(
    'redacts unknown run items when model=%s or tool=%s logging is disabled',
    (dontLogModelData, dontLogToolData) => {
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      vi.spyOn(logger, 'dontLogModelData', 'get').mockReturnValue(
        dontLogModelData,
      );
      vi.spyOn(logger, 'dontLogToolData', 'get').mockReturnValue(
        dontLogToolData,
      );
      const streamedResult = new StreamedRunResult();
      const secret = 'SECRET_UNKNOWN_RUN_ITEM_123';

      streamStepItemsToRunResult(streamedResult, [
        { type: 'unknown', secret } as any,
      ]);

      expect(warnSpy).toHaveBeenCalledWith(
        'Unknown item type. Item data is redacted.',
      );
      expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
      vi.restoreAllMocks();
    },
  );
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

  it('does not start an action after cancellation', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop before computer action'));
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn().mockResolvedValue('img'),
    } as any;
    const computer = computerTool({ computer: fakeComputer });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'cancelled-computer-call',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };

    const items = await executeComputerActions(
      new Agent({ name: 'CancelledComputer' }),
      [{ toolCall: call, computer }],
      new Runner(),
      new RunContext(),
      undefined,
      undefined,
      controller.signal,
    );

    expect(fakeComputer.screenshot).not.toHaveBeenCalled();
    expect(items[0]).toMatchObject({
      rawItem: {
        type: 'computer_call_result',
        callId: call.callId,
        output: {
          type: 'computer_screenshot',
          data: expect.stringMatching(/^data:image\/png;base64,/),
        },
        providerData: { status: 'incomplete' },
      },
    });
  });

  it.each(['fulfills', 'rejects'] as const)(
    'reconciles computer approval that %s after sibling cancellation',
    async (settlement) => {
      const primaryError = new Error('sibling category failed');
      const approvalError = new Error('approval failed after cancellation');
      let markApprovalStarted: (() => void) | undefined;
      const approvalStarted = new Promise<void>((resolve) => {
        markApprovalStarted = resolve;
      });
      let releaseApproval: (() => void) | undefined;
      const approvalCanFinish = new Promise<void>((resolve) => {
        releaseApproval = resolve;
      });
      let markFatalFailure: (() => void) | undefined;
      const fatalFailure = new Promise<void>((resolve) => {
        markFatalFailure = resolve;
      });
      const fakeComputer = {
        environment: 'mac',
        dimensions: [1, 1] as [number, number],
        screenshot: vi.fn().mockResolvedValue('img'),
      } as any;
      const needsApproval = vi.fn(async () => {
        markApprovalStarted?.();
        await approvalCanFinish;
        if (settlement === 'rejects') {
          throw approvalError;
        }
        return true;
      });
      const computer = computerTool({ computer: fakeComputer, needsApproval });
      const call: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        callId: 'cancelled-computer-approval',
        status: 'completed',
        action: { type: 'screenshot' } as any,
      };
      const runner = new Runner();
      const agent = new Agent({ name: 'CancelledComputerApproval' });
      const start = vi.fn();
      const end = vi.fn();
      const formatter = vi.fn(() => 'should not format cancellation');
      runner.on('agent_tool_start', start);
      runner.on('agent_tool_end', end);
      let computerItems: Awaited<
        ReturnType<typeof executeComputerActions>
      > | null = null;

      let settled = false;
      const resultPromise = runWithSiblingCancellation([
        async (signal) => {
          computerItems = await executeComputerActions(
            agent,
            [{ toolCall: call, computer }],
            runner,
            new RunContext(),
            undefined,
            formatter,
            signal,
          );
        },
        async (_signal, reserveFailure) => {
          await approvalStarted;
          reserveFailure?.();
          markFatalFailure?.();
          throw primaryError;
        },
      ]).finally(() => {
        settled = true;
      });
      await fatalFailure;

      expect(settled).toBe(false);
      releaseApproval?.();

      await expect(resultPromise).rejects.toBe(primaryError);
      expect(needsApproval).toHaveBeenCalledTimes(1);
      expect(formatter).not.toHaveBeenCalled();
      expect(fakeComputer.screenshot).not.toHaveBeenCalled();
      expect(start).not.toHaveBeenCalled();
      expect(end).not.toHaveBeenCalled();
      expect(computerItems).toHaveLength(1);
      expect(computerItems?.[0]).toMatchObject({
        rawItem: {
          type: 'computer_call_result',
          callId: call.callId,
          providerData: { status: 'incomplete' },
        },
      });
    },
  );

  it('does not format a rejected computer approval after sibling cancellation', async () => {
    const primaryError = new Error('sibling category failed');
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn().mockResolvedValue('img'),
    } as any;
    const computer = computerTool({ computer: fakeComputer });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'rejected-computer-approval',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };
    const agent = new Agent({ name: 'RejectedComputerApproval' });
    const runContext = new RunContext();
    runContext.rejectTool(new ToolApprovalItem(call, agent, computer.name));
    const formatter = vi.fn(() => 'should not format cancellation');
    let computerItems: Awaited<
      ReturnType<typeof executeComputerActions>
    > | null = null;

    const resultPromise = runWithSiblingCancellation([
      async (signal) => {
        computerItems = await executeComputerActions(
          agent,
          [{ toolCall: call, computer }],
          new Runner(),
          runContext,
          undefined,
          formatter,
          signal,
        );
      },
      async (_signal, reserveFailure) => {
        reserveFailure?.();
        throw primaryError;
      },
    ]);

    await expect(resultPromise).rejects.toBe(primaryError);
    expect(formatter).not.toHaveBeenCalled();
    expect(fakeComputer.screenshot).not.toHaveBeenCalled();
    expect(computerItems).toHaveLength(1);
    expect(computerItems?.[0]).toMatchObject({
      rawItem: {
        type: 'computer_call_result',
        callId: call.callId,
        providerData: { status: 'incomplete' },
      },
    });
  });

  it('drains started batched computer approval callbacks before rejecting', async () => {
    const primaryError = new Error('computer approval failed');
    let startedApprovals = 0;
    let markApprovalsStarted: (() => void) | undefined;
    const approvalsStarted = new Promise<void>((resolve) => {
      markApprovalsStarted = resolve;
    });
    let markApprovalRejected: (() => void) | undefined;
    const approvalRejected = new Promise<void>((resolve) => {
      markApprovalRejected = resolve;
    });
    let releaseBlockedApproval: (() => void) | undefined;
    const blockedApprovalCanFinish = new Promise<void>((resolve) => {
      releaseBlockedApproval = resolve;
    });
    let settled = false;
    let sideEffectAfterRejection = false;
    const needsApproval = vi.fn(
      async (_runContext: RunContext, action: protocol.ComputerAction) => {
        startedApprovals += 1;
        if (startedApprovals === 2) {
          markApprovalsStarted?.();
        }
        await approvalsStarted;
        if (action.type === 'click') {
          markApprovalRejected?.();
          throw primaryError;
        }
        await blockedApprovalCanFinish;
        sideEffectAfterRejection = settled;
        return false;
      },
    );
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn().mockResolvedValue('img'),
    } as any;
    const computer = computerTool({ computer: fakeComputer, needsApproval });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'batched-computer-approval',
      status: 'completed',
      actions: [
        { type: 'click', x: 1, y: 2, button: 'left' },
        { type: 'move', x: 3, y: 4 },
      ],
    };

    const resultPromise = executeComputerActions(
      new Agent({ name: 'BatchedComputerApproval' }),
      [{ toolCall: call, computer }],
      new Runner(),
      new RunContext(),
    ).finally(() => {
      settled = true;
    });
    await approvalRejected;
    await Promise.resolve();

    expect(settled).toBe(false);
    releaseBlockedApproval?.();

    await expect(resultPromise).rejects.toBe(primaryError);
    expect(needsApproval).toHaveBeenCalledTimes(2);
    expect(sideEffectAfterRejection).toBe(false);
    expect(fakeComputer.screenshot).not.toHaveBeenCalled();
  });

  it('does not emit a success end event when computer customDataExtractor fails', async () => {
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
    const tool = computerTool({
      computer: fakeComputer,
      customDataExtractor: () => ({ bad: BigInt(1) }) as any,
    });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1_bad_custom_data',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };
    const runner = new Runner();
    const end = vi.fn();
    runner.on('agent_tool_end', end);

    await expect(
      executeComputerActions(
        new Agent({ name: 'Comp' }),
        [{ toolCall: call, computer: tool }],
        runner,
        new RunContext(),
      ),
    ).rejects.toThrow(/customDataExtractor must return JSON-compatible data/);

    expect(end).not.toHaveBeenCalled();
  });

  it.each(['fulfills', 'rejects'] as const)(
    'reports cancellation when computer custom data extraction %s as aborted',
    async (settlement) => {
      const primaryError = new Error('primary category failure');
      const customDataError = new Error(
        'custom data failed after cancellation',
      );
      let markCustomDataStarted: (() => void) | undefined;
      const customDataStarted = new Promise<void>((resolve) => {
        markCustomDataStarted = resolve;
      });
      let releaseCustomData: (() => void) | undefined;
      const customDataCanFinish = new Promise<void>((resolve) => {
        releaseCustomData = resolve;
      });
      let customDataFinished = false;
      const fakeComputer = {
        environment: 'mac',
        dimensions: [1, 1] as [number, number],
        screenshot: vi.fn().mockResolvedValue('img'),
      } as any;
      const computer = computerTool({
        computer: fakeComputer,
        customDataExtractor: async () => {
          markCustomDataStarted?.();
          await customDataCanFinish;
          customDataFinished = true;
          if (settlement === 'rejects') {
            throw customDataError;
          }
          return { extracted: true };
        },
      });
      const call: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        callId: `computer-custom-data-${settlement}`,
        status: 'completed',
        action: { type: 'screenshot' },
      };
      const runner = new Runner();
      const end = vi.fn();
      runner.on('agent_tool_end', end);

      let settled = false;
      const resultPromise = runWithSiblingCancellation([
        (signal) =>
          executeComputerActions(
            new Agent({ name: 'ComputerCustomDataCancellation' }),
            [{ toolCall: call, computer }],
            runner,
            new RunContext(),
            undefined,
            undefined,
            signal,
          ),
        async (_signal, reserveFailure) => {
          await customDataStarted;
          reserveFailure?.(primaryError);
          throw primaryError;
        },
      ]).finally(() => {
        settled = true;
      });
      await customDataStarted;
      await Promise.resolve();

      expect(settled).toBe(false);
      releaseCustomData?.();

      await expect(resultPromise).rejects.toBe(primaryError);
      const computerEndCalls = end.mock.calls.filter(
        ([, , endedTool]) => endedTool === computer,
      );
      expect(customDataFinished).toBe(true);
      expect(computerEndCalls).toHaveLength(1);
      expect(computerEndCalls[0]?.[3]).toBe('aborted');
    },
  );

  it('passes a cloned computer tool call to customDataExtractor', async () => {
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
    const tool = computerTool({
      computer: fakeComputer,
      customDataExtractor: (context) => {
        (context.toolCall as any).sdkOnly = { traceId: 'sdk-only' };
        context.toolCall.action = {
          type: 'click',
          button: 'left',
          x: 1,
          y: 2,
        } as any;
        return { annotatedCall: context.toolCall };
      },
    });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1_cloned_custom_data',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };

    const items = await executeComputerActions(
      new Agent({ name: 'Comp' }),
      [{ toolCall: call, computer: tool }],
      new Runner(),
      new RunContext(),
    );

    expect((call as any).sdkOnly).toBeUndefined();
    expect(call.action).toEqual({ type: 'screenshot' });
    expect(items[0]).toBeInstanceOf(ToolCallOutputItem);
    expect((items[0] as ToolCallOutputItem).customData).toEqual({
      annotatedCall: {
        ...call,
        action: {
          type: 'click',
          button: 'left',
          x: 1,
          y: 2,
        },
        sdkOnly: { traceId: 'sdk-only' },
      },
    });
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

      getEndedFunctionSpan(processor, 'computer');
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

      const functionSpan = getEndedFunctionSpan(processor, 'computer');
      expect(functionSpan.error).toEqual({
        message: 'Error running tool',
        data: {
          tool_name: 'computer',
          error: 'computer boom',
        },
      });
    });
  });

  it('redacts computer action errors when sensitive tracing data is disabled', async () => {
    const sensitiveError = 'computer secret output';
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn().mockRejectedValue(new Error(sensitiveError)),
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
      callId: 'c1_trace_error_redacted',
      status: 'completed',
      action: { type: 'screenshot' } as any,
    };
    const mockLogger = createMockLogger();

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
          mockLogger,
        ),
      );

      const functionSpan = getEndedFunctionSpan(processor, 'computer');
      expect(functionSpan.error).toEqual({
        message: 'Error running tool',
        data: {
          tool_name: 'computer',
          error: REDACTED_TOOL_ERROR_MESSAGE,
        },
      });
      expect(JSON.stringify(functionSpan.toJSON())).not.toContain(
        sensitiveError,
      );
    });
  });

  it('propagates onSafetyCheck callback errors', async () => {
    const sensitiveError = 'safety check leaked data';
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
    const onSafetyCheck = vi.fn().mockRejectedValue(new Error(sensitiveError));
    const computer = computerTool({ computer: fakeComputer, onSafetyCheck });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c1_trace_safety_check_error_redacted',
      status: 'completed',
      action: { type: 'screenshot' } as any,
      providerData: {
        pending_safety_checks: [
          {
            id: 'sc1',
            code: 'malicious_instructions',
            message: 'Review before proceeding.',
          },
        ],
      },
    };
    const mockLogger = createMockLogger();

    await expect(
      withTrace('test', () =>
        executeComputerActions(
          new Agent({ name: 'Comp' }),
          [{ toolCall: call, computer }],
          new Runner({
            tracingDisabled: true,
            traceIncludeSensitiveData: false,
          }),
          new RunContext(),
          mockLogger,
        ),
      ),
    ).rejects.toThrow(sensitiveError);
    expect(fakeComputer.screenshot).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
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

      const functionSpan = getEndedFunctionSpan(processor, 'computer');
      expect(functionSpan.spanData.input).toBe('');
      expect(functionSpan.spanData.output).toBe('');
      expect(JSON.stringify(functionSpan.toJSON())).not.toContain(secretInput);
      expect(JSON.stringify(functionSpan.toJSON())).not.toContain(secretOutput);
    });
  });

  it('runs batched computer actions in order and captures a final screenshot', async () => {
    const invocations: string[] = [];
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn().mockImplementation(async () => {
        invocations.push('screenshot');
        return 'img';
      }),
      click: vi.fn().mockImplementation(async () => {
        invocations.push('click');
      }),
      doubleClick: vi.fn(),
      drag: vi.fn(),
      keypress: vi.fn(),
      move: vi.fn().mockImplementation(async () => {
        invocations.push('move');
      }),
      scroll: vi.fn(),
      type: vi.fn(),
      wait: vi.fn(),
    } as any;
    const tool = computerTool({ computer: fakeComputer });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c-batched',
      status: 'completed',
      actions: [
        { type: 'move', x: 1, y: 2 },
        { type: 'click', x: 1, y: 2, button: 'left' },
      ],
    };

    const items = await executeComputerActions(
      new Agent({ name: 'Comp' }),
      [{ toolCall: call, computer: tool }],
      new Runner(),
      new RunContext(),
    );

    expect(invocations).toEqual(['move', 'click', 'screenshot']);
    expect(items).toHaveLength(1);
    expect((items[0] as any).output).toBe('data:image/png;base64,img');
  });

  it.each(['fulfills', 'rejects'] as const)(
    'does not start later batched computer actions when the active action %s after cancellation',
    async (settlement) => {
      const controller = new AbortController();
      let markClickStarted: (() => void) | undefined;
      const clickStarted = new Promise<void>((resolve) => {
        markClickStarted = resolve;
      });
      let releaseClick: (() => void) | undefined;
      const clickCanFinish = new Promise<void>((resolve) => {
        releaseClick = resolve;
      });
      const fakeComputer = {
        environment: 'mac',
        dimensions: [1, 1] as [number, number],
        screenshot: vi.fn().mockResolvedValue('img'),
        click: vi.fn().mockImplementation(async () => {
          markClickStarted?.();
          await clickCanFinish;
          if (settlement === 'rejects') {
            throw new Error('computer action failed after cancellation');
          }
        }),
        doubleClick: vi.fn(),
        drag: vi.fn(),
        keypress: vi.fn(),
        move: vi.fn(),
        scroll: vi.fn(),
        type: vi.fn(),
        wait: vi.fn(),
      } as any;
      const customDataExtractor = vi.fn(() => ({ shouldNotRun: true }));
      const computer = computerTool({
        computer: fakeComputer,
        customDataExtractor,
      });
      const call: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        callId: 'cancelled-batch',
        status: 'completed',
        actions: [
          { type: 'click', x: 1, y: 2, button: 'left' },
          { type: 'move', x: 3, y: 4 },
        ],
      };

      const runner = new Runner();
      const agent = new Agent({ name: 'Comp' });
      const runContext = new RunContext();
      const end = vi.fn();
      runner.on('agent_tool_end', end);
      const resultPromise = executeComputerActions(
        agent,
        [{ toolCall: call, computer }],
        runner,
        runContext,
        undefined,
        undefined,
        controller.signal,
      );
      await clickStarted;
      controller.abort(new Error('stop batched actions'));
      releaseClick?.();

      const [item] = await resultPromise;
      expect(fakeComputer.click).toHaveBeenCalledTimes(1);
      expect(fakeComputer.move).not.toHaveBeenCalled();
      expect(fakeComputer.screenshot).not.toHaveBeenCalled();
      expect(customDataExtractor).not.toHaveBeenCalled();
      expect(end).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledWith(runContext, agent, computer, 'aborted', {
        toolCall: call,
      });
      expect(item.rawItem).toMatchObject({
        type: 'computer_call_result',
        callId: call.callId,
        providerData: { status: 'incomplete' },
      });
    },
  );

  it('rechecks cancellation after the final screenshot helper returns', async () => {
    const controller = new AbortController();
    const fakeComputer = {
      environment: 'mac',
      dimensions: [1, 1] as [number, number],
      screenshot: vi.fn(async () => {
        queueMicrotask(() => {
          queueMicrotask(() => {
            controller.abort(new Error('stop after screenshot helper'));
          });
        });
        return 'img';
      }),
      click: vi.fn(),
      doubleClick: vi.fn(),
      drag: vi.fn(),
      keypress: vi.fn(),
      move: vi.fn(),
      scroll: vi.fn(),
      type: vi.fn(),
      wait: vi.fn(),
    } as any;
    const customDataExtractor = vi.fn(() => ({ shouldNotRun: true }));
    const computer = computerTool({
      computer: fakeComputer,
      customDataExtractor,
    });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'cancelled-after-screenshot-helper',
      status: 'completed',
      action: { type: 'screenshot' },
    };
    const runner = new Runner();
    const agent = new Agent({ name: 'Comp' });
    const runContext = new RunContext();
    const endHookError = new Error('computer end hook failed');
    const end = vi.fn(() => {
      throw endHookError;
    });
    runner.on('agent_tool_end', end);

    await expect(
      executeComputerActions(
        agent,
        [{ toolCall: call, computer }],
        runner,
        runContext,
        undefined,
        undefined,
        controller.signal,
      ),
    ).rejects.toBe(endHookError);

    expect(controller.signal.aborted).toBe(true);
    expect(customDataExtractor).not.toHaveBeenCalled();
    expect(end).toHaveBeenCalledTimes(1);
    expect(end).toHaveBeenCalledWith(runContext, agent, computer, 'aborted', {
      toolCall: call,
    });
  });

  it.each(['fulfills', 'rejects'] as const)(
    'treats cancellation when the final screenshot %s as incomplete',
    async (settlement) => {
      const controller = new AbortController();
      let markScreenshotStarted: (() => void) | undefined;
      const screenshotStarted = new Promise<void>((resolve) => {
        markScreenshotStarted = resolve;
      });
      let releaseScreenshot: (() => void) | undefined;
      const screenshotCanFinish = new Promise<void>((resolve) => {
        releaseScreenshot = resolve;
      });
      const fakeComputer = {
        environment: 'mac',
        dimensions: [1, 1] as [number, number],
        screenshot: vi.fn().mockImplementation(async () => {
          markScreenshotStarted?.();
          await screenshotCanFinish;
          if (settlement === 'rejects') {
            throw new Error('final screenshot failed after cancellation');
          }
          return 'img';
        }),
        click: vi.fn(),
        doubleClick: vi.fn(),
        drag: vi.fn(),
        keypress: vi.fn(),
        move: vi.fn(),
        scroll: vi.fn(),
        type: vi.fn(),
        wait: vi.fn(),
      } as any;
      const customDataExtractor = vi.fn(() => ({ shouldNotRun: true }));
      const computer = computerTool({
        computer: fakeComputer,
        customDataExtractor,
      });
      const call: protocol.ComputerUseCallItem = {
        type: 'computer_call',
        callId: 'cancelled-final-screenshot',
        status: 'completed',
        actions: [{ type: 'move', x: 1, y: 2 }],
      };
      const runner = new Runner();
      const agent = new Agent({ name: 'Comp' });
      const runContext = new RunContext();
      const end = vi.fn();
      runner.on('agent_tool_end', end);
      let settled = false;

      const resultPromise = executeComputerActions(
        agent,
        [{ toolCall: call, computer }],
        runner,
        runContext,
        undefined,
        undefined,
        controller.signal,
      ).finally(() => {
        settled = true;
      });
      await screenshotStarted;
      controller.abort(new Error('stop final screenshot'));
      await new Promise<void>((resolve) => setTimeout(resolve, 0));

      expect(settled).toBe(false);
      releaseScreenshot?.();

      const [item] = await resultPromise;
      expect(customDataExtractor).not.toHaveBeenCalled();
      expect(end).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledWith(runContext, agent, computer, 'aborted', {
        toolCall: call,
      });
      expect(item.rawItem).toMatchObject({
        type: 'computer_call_result',
        callId: call.callId,
        providerData: { status: 'incomplete' },
      });
    },
  );

  it('checks approval against each batched computer action', async () => {
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
    const needsApproval = vi.fn(
      async (_ctx, action: protocol.ComputerAction) => {
        return action.type === 'click';
      },
    );
    const tool = computerTool({ computer: fakeComputer, needsApproval });
    const call: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      callId: 'c-batched-approval',
      status: 'completed',
      actions: [
        { type: 'move', x: 1, y: 2 },
        { type: 'click', x: 1, y: 2, button: 'left' },
      ],
    };

    const items = await executeComputerActions(
      new Agent({ name: 'Comp' }),
      [{ toolCall: call, computer: tool }],
      new Runner(),
      new RunContext(),
    );

    expect(items).toHaveLength(1);
    expect(items[0]).toBeInstanceOf(ToolApprovalItem);
    expect(needsApproval).toHaveBeenCalledTimes(2);
    expect(needsApproval.mock.calls.map((entry) => entry[1].type)).toEqual([
      'move',
      'click',
    ]);
    expect(fakeComputer.screenshot).not.toHaveBeenCalled();
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
    expect(fakeComputer.screenshot).toHaveBeenCalledTimes(2);
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
    const needsApproval = vi.fn(async () => true);
    const tool = computerTool({ computer: fakeComputer, needsApproval });
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
    expect(needsApproval).not.toHaveBeenCalled();
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
    const needsApproval = vi.fn(async () => true);
    const tool = computerTool({ computer: fakeComputer, needsApproval });
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
    expect(needsApproval).not.toHaveBeenCalled();
    expect(fakeComputer.screenshot).toHaveBeenCalledTimes(2);
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

  it('drops ignored handoffs from the step items', async () => {
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
        [
          new HandoffCallItem(call1.toolCall, TEST_AGENT),
          new HandoffCallItem(call2.toolCall, TEST_AGENT),
        ],
        TEST_MODEL_RESPONSE_WITH_FUNCTION,
        [call1, call2],
        new Runner({ tracingDisabled: true }),
        new RunContext(),
      ),
    );

    expect(
      res.newStepItems.filter((item) => item instanceof HandoffCallItem),
    ).toHaveLength(1);
    expect(
      (
        res.newStepItems.find(
          (item) => item instanceof HandoffCallItem,
        ) as HandoffCallItem
      ).rawItem.callId,
    ).toBe('1');
    expect(
      res.newStepItems.some((item) => item instanceof ToolCallOutputItem),
    ).toBe(false);
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

  it.each([
    ['string', 'not callable'],
    ['false', false],
    ['empty string', ''],
    ['zero', 0],
  ])(
    'throws before invoking handoff if inputFilter is %s',
    async (_label, inputFilter) => {
      const target = new Agent({ name: 'Target' });
      const onHandoff = vi.fn();
      const h = handoff(target, {
        onHandoff,
        inputFilter: inputFilter as any,
      });
      const runner = new Runner({ tracingDisabled: true });
      const runnerHandoffListener = vi.fn();
      const agentHandoffListener = vi.fn();
      runner.on('agent_handoff', runnerHandoffListener);
      TEST_AGENT.on('agent_handoff', agentHandoffListener);
      const call: any = {
        toolCall: { ...TEST_MODEL_FUNCTION_CALL, name: h.toolName },
        handoff: h,
      };

      try {
        await expect(
          withTrace('test', () =>
            executeHandoffCalls(
              TEST_AGENT,
              'orig',
              [],
              [],
              TEST_MODEL_RESPONSE_WITH_FUNCTION,
              [call],
              runner,
              new RunContext(),
            ),
          ),
        ).rejects.toThrow(UserError);

        expect(onHandoff).not.toHaveBeenCalled();
        expect(runnerHandoffListener).not.toHaveBeenCalled();
        expect(agentHandoffListener).not.toHaveBeenCalled();
      } finally {
        runner.off('agent_handoff', runnerHandoffListener);
        TEST_AGENT.off('agent_handoff', agentHandoffListener);
      }
    },
  );

  it('preserves structured handoff span errors for invalid inputFilter', async () => {
    const target = new Agent({ name: 'Target' });
    const h = handoff(target);
    h.inputFilter = false as any;
    const call: any = {
      toolCall: { ...TEST_MODEL_FUNCTION_CALL, name: h.toolName },
      handoff: h,
    };

    await withRecordingTrace(async (processor) => {
      let caught: unknown;

      try {
        await withTrace('test', () =>
          executeHandoffCalls(
            TEST_AGENT,
            'orig',
            [],
            [],
            TEST_MODEL_RESPONSE_WITH_FUNCTION,
            [call],
            new Runner(),
            new RunContext(),
          ),
        );
      } catch (error) {
        caught = error;
      }

      expect(caught).toBeInstanceOf(UserError);
      expect(
        (caught as UserError & { data?: Record<string, unknown> }).data,
      ).toEqual({
        details: 'not callable',
      });

      const handoffSpan = getEndedHandoffSpan(processor);
      expect(handoffSpan.error).toEqual({
        message: 'Invalid handoff input filter: not callable',
        data: {
          details: 'not callable',
        },
      });
    });
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

  it('redacts shell action errors when sensitive tracing data is disabled', async () => {
    const sensitiveError = 'shell secret output';
    const shell = new FakeShell();
    shell.error = new Error(sensitiveError);
    const shellDef = shellTool({ shell });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell_trace_error_redacted',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const mockLogger = createMockLogger();

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
          mockLogger,
        ),
      );

      const functionSpan = getEndedFunctionSpan(processor, shellDef.name);
      expect(functionSpan.error).toEqual({
        message: 'Error running tool',
        data: {
          tool_name: shellDef.name,
          error: REDACTED_TOOL_ERROR_MESSAGE,
        },
      });
      expect(JSON.stringify(functionSpan.toJSON())).not.toContain(
        sensitiveError,
      );
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
      'object',
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

    it('does not emit a success end event when apply_patch customDataExtractor fails', async () => {
      const editor = new FakeEditor();
      const applyPatch = applyPatchTool({
        editor,
        customDataExtractor: () => ({ bad: BigInt(1) }) as any,
      });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const runner = new Runner({ tracingDisabled: true });
      const end = vi.fn();
      runner.on('agent_tool_end', end);
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch_bad_custom_data',
        status: 'completed',
        operation: {
          type: 'update_file',
          path: 'README.md',
          diff: 'diff --git',
        },
      };

      await expect(
        executeApplyPatchOperations(
          agent,
          [{ toolCall, applyPatch } as any],
          runner,
          runContext,
        ),
      ).rejects.toThrow(/customDataExtractor must return JSON-compatible data/);

      expect(end).not.toHaveBeenCalled();
      expect(editor.operations).toHaveLength(1);
    });

    it('passes RunContext to apply_patch editor operations', async () => {
      const editor = new FakeEditor();
      const applyPatch = applyPatchTool({ editor });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext({ run: 'ctx' });
      const runner = new Runner({ tracingDisabled: true });
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch_context',
        status: 'completed',
        operation: {
          type: 'delete_file',
          path: 'README.md',
        },
      };

      await executeApplyPatchOperations(
        agent,
        [{ toolCall, applyPatch } as any],
        runner,
        runContext,
      );

      expect(editor.contexts).toHaveLength(1);
      expect(editor.contexts[0]?.runContext).toBe(runContext);
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

    it('redacts apply_patch errors when sensitive tracing data is disabled', async () => {
      const sensitiveError = 'patch secret output';
      const editor = new FakeEditor();
      editor.errors.delete_file = new Error(sensitiveError);
      const applyPatch = applyPatchTool({ editor });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch_trace_error_redacted',
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
            new Runner({
              tracingDisabled: false,
              traceIncludeSensitiveData: false,
            }),
            runContext,
            mockLogger,
          ),
        );

        const functionSpan = getEndedFunctionSpan(processor, applyPatch.name);
        expect(functionSpan.error).toEqual({
          message: 'Error running tool',
          data: {
            tool_name: applyPatch.name,
            error: REDACTED_TOOL_ERROR_MESSAGE,
          },
        });
        expect(JSON.stringify(functionSpan.toJSON())).not.toContain(
          sensitiveError,
        );
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
        'object',
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

    it('does not recheck apply_patch approval after approval', async () => {
      const editor = new FakeEditor();
      const needsApproval = vi.fn(async () => true);
      const applyPatch = applyPatchTool({ editor, needsApproval });
      const agent = new Agent({ name: 'EditorAgent' });
      const runContext = new RunContext();
      const runner = new Runner({ tracingDisabled: true });
      const toolCall: protocol.ApplyPatchCallItem = {
        type: 'apply_patch_call',
        callId: 'call_patch_approved',
        status: 'completed',
        operation: {
          type: 'update_file',
          path: 'README.md',
          diff: 'diff --git',
        },
      };

      const pendingResults = await executeApplyPatchOperations(
        agent,
        [{ toolCall, applyPatch } as any],
        runner,
        runContext,
      );
      expect(needsApproval).toHaveBeenCalledTimes(1);
      runContext.approveTool(pendingResults[0] as ToolApprovalItem);

      const approvedResults = await executeApplyPatchOperations(
        agent,
        [{ toolCall, applyPatch } as any],
        runner,
        runContext,
      );

      expect(approvedResults[0].type).toBe('tool_call_output_item');
      expect(needsApproval).toHaveBeenCalledTimes(1);
      expect(editor.operations).toHaveLength(1);
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

    it('preserves apply_patch onApproval rejection reasons', async () => {
      const editor = new FakeEditor();
      const onApproval = vi.fn(async () => ({
        approve: false,
        reason: 'Patch denied',
      }));
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
      const outputItem = results[0] as ToolCallOutputItem;
      const rawItem = outputItem.rawItem as protocol.ApplyPatchCallResultItem;
      expect(rawItem.status).toBe('failed');
      expect(rawItem.output).toBe('Patch denied');
      expect(outputItem.output).toBe('Patch denied');
      expect(editor.operations).toHaveLength(0);
    });

    it('uses toolErrorFormatter message for rejected apply_patch operations', async () => {
      const editor = new FakeEditor();
      const needsApproval = vi.fn(async () => true);
      const applyPatch = applyPatchTool({
        editor,
        needsApproval,
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
      expect(needsApproval).not.toHaveBeenCalled();
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

    it('wraps hostile unrelated errors without inspecting their prototype twice', async () => {
      let stringifyCount = 0;
      const { proxy, revoke } = Proxy.revocable(new Error('tool failed'), {
        get(target, property, receiver) {
          if (property === 'toString') {
            return () => {
              stringifyCount += 1;
              if (stringifyCount === 2) {
                revoke();
              }
              return 'Error: tool failed';
            };
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const t = tool({
        name: 'hostile_error',
        description: 'Throw an error with a hostile prototype trap.',
        parameters: z.object({}),
        errorFunction: null,
        execute: async () => {
          throw proxy;
        },
      }) as unknown as FunctionTool;

      const error = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: { ...toolCall, name: 'hostile_error' },
              tool: t,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught),
      );

      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBe(proxy);
      expect((error as ToolCallError).state).toBe(state);
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

    it('does not reuse a bare approval for a same-name deferred tool', async () => {
      const deferredExecute = vi.fn(async () => 'deferred');
      const bare = tool({
        name: 'lookup',
        description: 'Immediate lookup.',
        parameters: z.object({}),
        needsApproval: true,
        execute: vi.fn(async () => 'bare'),
      }) as unknown as FunctionTool;
      const deferred = tool({
        name: 'lookup',
        description: 'Deferred lookup.',
        parameters: z.object({}),
        deferLoading: true,
        needsApproval: true,
        execute: deferredExecute,
      }) as unknown as FunctionTool;
      state._context.approveTool(
        new ToolApprovalItem(
          {
            type: 'function_call',
            callId: 'approved-bare',
            name: 'lookup',
            arguments: '{}',
          },
          state._currentAgent,
        ),
        { alwaysApprove: true },
      );

      const [result] = await executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              type: 'function_call',
              callId: 'deferred-call',
              name: 'lookup',
              namespace: 'lookup',
              arguments: '{}',
            },
            tool: deferred,
            availableFunctionTools: [bare, deferred],
          },
        ],
        runner,
        state,
      );

      expect(result.type).toBe('function_approval');
      expect(deferredExecute).not.toHaveBeenCalled();
    });

    it('does not use a bare function approval for a deferred tool', async () => {
      const deferredExecute = vi.fn(async () => 'deferred');
      const deferred = tool({
        name: 'lookup',
        description: 'Deferred lookup.',
        parameters: z.object({}),
        deferLoading: true,
        needsApproval: true,
        execute: deferredExecute,
      }) as unknown as FunctionTool;
      state._context.approveTool(
        new ToolApprovalItem(
          {
            type: 'function_call',
            callId: 'legacy-approval',
            name: 'lookup',
            arguments: '{}',
          },
          state._currentAgent,
        ),
        { alwaysApprove: true },
      );

      const [result] = await executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              type: 'function_call',
              callId: 'deferred-call',
              name: 'lookup',
              namespace: 'lookup',
              arguments: '{}',
            },
            tool: deferred,
            availableFunctionTools: [deferred],
          },
        ],
        runner,
        state,
      );

      expect(result.type).toBe('function_approval');
      expect(deferredExecute).not.toHaveBeenCalled();
    });

    it.each([
      ['per-call', false],
      ['permanent', true],
    ] as const)(
      'does not use a same-name shell %s approval for a function tool',
      async (_decision, alwaysApprove) => {
        const execute = vi.fn(async () => 'function');
        const functionTool = tool({
          name: 'shell',
          description: 'Function named shell.',
          parameters: z.object({}),
          needsApproval: true,
          execute,
        }) as unknown as FunctionTool;
        const sharedCallId = 'same-name-shell-function';
        state._context.approveTool(
          new ToolApprovalItem(
            {
              type: 'shell_call',
              callId: sharedCallId,
              status: 'completed',
              action: { commands: ['echo approved'] },
            },
            state._currentAgent,
            'shell',
          ),
          { alwaysApprove },
        );

        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                type: 'function_call',
                callId: sharedCallId,
                name: 'shell',
                arguments: '{}',
              },
              tool: functionTool,
            },
          ],
          runner,
          state,
        );

        expect(result.type).toBe('function_approval');
        expect(execute).not.toHaveBeenCalled();
      },
    );

    it.each([
      ['malformed JSON', '{'],
      ['an array', '[]'],
      ['null', 'null'],
      ['a number', '42'],
      ['a string', '"unsafe"'],
      ['a boolean', 'true'],
    ])(
      'requires approval without invoking a dynamic policy for %s',
      async (_label, args) => {
        const needsApproval = vi.fn(async () => false);
        const t = tool({
          name: 'hi',
          description: 'dynamic approval tool',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
          needsApproval,
          execute: vi.fn(async () => 'ok'),
        }) as unknown as FunctionTool;
        const invokeSpy = vi.spyOn(t, 'invoke');

        const result = await executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall: { ...toolCall, arguments: args }, tool: t }],
          runner,
          state,
        );

        expect(result[0].type).toBe('function_approval');
        expect(needsApproval).not.toHaveBeenCalled();
        expect(invokeSpy).not.toHaveBeenCalled();
      },
    );

    it('fails closed for directly constructed dynamic approval policies', async () => {
      const needsApproval = vi.fn(async () => false);
      const t = {
        ...tool({
          name: 'hi',
          description: 'directly constructed approval tool',
          parameters: {
            type: 'object',
            properties: {},
            required: [],
            additionalProperties: false,
          },
          needsApproval: false,
          execute: vi.fn(async () => 'ok'),
        }),
        needsApproval,
      } as unknown as FunctionTool;
      const invokeSpy = vi.spyOn(t, 'invoke');

      const result = await executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall: { ...toolCall, arguments: '[]' }, tool: t }],
        runner,
        state,
      );

      expect(result[0].type).toBe('function_approval');
      expect(needsApproval).not.toHaveBeenCalled();
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('continues evaluating dynamic approval policies for valid objects', async () => {
      const needsApproval = vi.fn(async () => false);
      const t = tool({
        name: 'hi',
        description: 'dynamic approval tool',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        needsApproval,
        execute: vi.fn(async () => 'ok'),
      }) as unknown as FunctionTool;

      const result = await executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: { ...toolCall, arguments: '{"safe":true}' },
            tool: t,
          },
        ],
        runner,
        state,
      );

      expect(result[0].type).toBe('function_output');
      expect(needsApproval).toHaveBeenCalledWith(
        state._context,
        { safe: true },
        toolCall.callId,
      );
    });

    it('evaluates dynamic approval policies for schema-invalid objects', async () => {
      const needsApproval = vi.fn(async () => false);
      const execute = vi.fn(async () => 'unexpected');
      const t = tool({
        name: 'schema_invalid_dynamic_approval',
        description: 'Return a fallback for schema-invalid input.',
        parameters: z.object({ value: z.number() }),
        needsApproval,
        execute,
      }) as unknown as FunctionTool;
      const invalidArguments = { value: 'invalid' };

      const [result] = await executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              name: 'schema_invalid_dynamic_approval',
              arguments: JSON.stringify(invalidArguments),
            },
            tool: t,
          },
        ],
        runner,
        state,
      );

      expect(result).toMatchObject({
        type: 'function_output',
        output: expect.stringContaining('running the tool'),
      });
      expect(needsApproval).toHaveBeenCalledWith(
        state._context,
        invalidArguments,
        toolCall.callId,
      );
      expect(execute).not.toHaveBeenCalled();
    });

    it.each([
      ['secure from start', true],
      ['promoted by the callback', false],
    ] as const)(
      'redacts arbitrary schema-invalid approval failures when %s',
      async (_mode, initiallyRedacted) => {
        const secret = 'SECRET_SCHEMA_APPROVAL_FAILURE_123';
        let redactToolData = initiallyRedacted;
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockImplementation(() => redactToolData);
        const debugSpy = vi.spyOn(logger, 'debug');
        const invalidArguments = { value: secret };
        const { proxy, revoke } = Proxy.revocable({ secret }, {});
        revoke();
        const thrownValues: unknown[] = [new Error(secret), secret, proxy];
        let thrownValue: unknown;
        const needsApproval = vi.fn(async (_context, args) => {
          expect(args).toEqual(invalidArguments);
          debugSpy.mockClear();
          redactToolData = true;
          throw thrownValue;
        });
        const t = tool({
          name: 'schema_invalid_approval_failure',
          description: 'Fail while deciding approval for invalid input.',
          parameters: z.object({ value: z.number() }),
          needsApproval,
          execute: vi.fn(async () => 'unexpected'),
        }) as unknown as FunctionTool;

        try {
          for (let index = 0; index < thrownValues.length; index += 1) {
            redactToolData = initiallyRedacted;
            thrownValue = thrownValues[index];
            const error = await executeFunctionToolCalls(
              state._currentAgent,
              [
                {
                  toolCall: {
                    ...toolCall,
                    callId: `schema_invalid_approval_failure_${index}`,
                    name: 'schema_invalid_approval_failure',
                    arguments: JSON.stringify(invalidArguments),
                  },
                  tool: t,
                },
              ],
              runner,
              state,
            ).catch((caught) => caught);

            expect(error).toBeInstanceOf(ToolCallError);
            expect((error as ToolCallError).state).toBeUndefined();
            expect((error as ToolCallError).error).toBeInstanceOf(
              InvalidToolInputError,
            );
            expect((error as ToolCallError).error).toMatchObject({
              message:
                "Invalid input for function tool 'schema_invalid_approval_failure'.",
            });
            expect((error as ToolCallError).message).not.toContain(secret);
            expect(JSON.stringify(error)).not.toContain(secret);
            expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(secret);
          }
        } finally {
          debugSpy.mockRestore();
          flagSpy.mockRestore();
        }
      },
    );

    it('preserves diagnostic schema-invalid approval failures', async () => {
      const secret = 'SECRET_DIAGNOSTIC_SCHEMA_APPROVAL_FAILURE_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(false);
      const approvalError = new Error(secret);
      const needsApproval = vi.fn(async () => {
        throw approvalError;
      });
      const t = tool({
        name: 'diagnostic_schema_invalid_approval_failure',
        description: 'Preserve diagnostic approval failures.',
        parameters: z.object({ value: z.number() }),
        needsApproval,
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'diagnostic_schema_invalid_approval_failure',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).state).toBe(state);
        expect((error as ToolCallError).error).toBe(approvalError);
        expect((error as ToolCallError).message).toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('rejects malformed arguments without invoking the approval policy', async () => {
      const needsApproval = vi.fn(async () => false);
      const t = tool({
        name: 'hi',
        description: 'dynamic approval tool',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        needsApproval,
        execute: vi.fn(async () => 'ok'),
      }) as unknown as FunctionTool;
      const invalidCall = { ...toolCall, arguments: '{' };
      state._context.rejectTool(
        new ToolApprovalItem(invalidCall, state._currentAgent),
      );
      const invokeSpy = vi.spyOn(t, 'invoke');

      const result = await executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall: invalidCall, tool: t }],
        runner,
        state,
      );

      expect(result[0].type).toBe('function_output');
      expect(needsApproval).not.toHaveBeenCalled();
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('keeps approved malformed arguments on the existing parse-error path', async () => {
      const needsApproval = vi.fn(async () => false);
      const t = tool({
        name: 'hi',
        description: 'dynamic approval tool',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        needsApproval,
        execute: vi.fn(async () => 'ok'),
      }) as unknown as FunctionTool;
      const invalidCall = { ...toolCall, arguments: '{' };
      state._context.approveTool(
        new ToolApprovalItem(invalidCall, state._currentAgent),
      );
      const invokeSpy = vi.spyOn(t, 'invoke');

      const result = await executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall: invalidCall, tool: t }],
        runner,
        state,
      );

      expect(result[0]).toMatchObject({
        type: 'function_output',
        output: expect.stringContaining('valid JSON'),
      });
      expect(needsApproval).not.toHaveBeenCalled();
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('preserves fixed approval behavior for non-object arguments', async () => {
      const t = tool({
        name: 'hi',
        description: 'fixed approval tool',
        parameters: {
          type: 'object',
          properties: {},
          required: [],
          additionalProperties: false,
        },
        needsApproval: false,
        execute: vi.fn(async () => 'ok'),
      }) as unknown as FunctionTool;

      const result = await executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall: { ...toolCall, arguments: '[]' }, tool: t }],
        runner,
        state,
      );

      expect(result[0].type).toBe('function_output');
    });

    it('does not run input guardrails before pending approval by default', async () => {
      const guardrailRun = vi.fn(async () =>
        ToolGuardrailFunctionOutputFactory.allow(),
      );
      const t = tool({
        name: 'hi',
        description: 't',
        parameters: z.object({}),
        needsApproval: true,
        inputGuardrails: [
          {
            name: 'default_approval_guardrail',
            run: guardrailRun,
          },
        ],
        execute: vi.fn(async () => 'ok'),
      }) as unknown as FunctionTool;
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(
        undefined as any,
      );

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      expect(res[0].type).toBe('function_approval');
      expect(guardrailRun).not.toHaveBeenCalled();
      expect(state._toolInputGuardrailResults).toHaveLength(0);
    });

    it('runs input guardrails before pending approval when opted in', async () => {
      const guardrailRun = vi.fn(async () =>
        ToolGuardrailFunctionOutputFactory.allow(),
      );
      const t = tool({
        name: 'hi',
        description: 't',
        parameters: z.object({}),
        needsApproval: true,
        inputGuardrails: [
          {
            name: 'pre_approval_guardrail',
            run: guardrailRun,
          },
        ],
        execute: vi.fn(async () => 'ok'),
      }) as unknown as FunctionTool;
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(
        undefined as any,
      );
      const preApprovalRunner = new Runner({
        tracingDisabled: true,
        toolExecution: { preApprovalInputGuardrails: true },
      });

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          preApprovalRunner,
          state,
        ),
      );

      expect(res[0].type).toBe('function_approval');
      expect(guardrailRun).toHaveBeenCalledTimes(1);
      expect(state._toolInputGuardrailResults).toHaveLength(1);
    });

    it('returns guardrail rejection output instead of pending approval when opted in', async () => {
      const guardrailRun = vi.fn(async () =>
        ToolGuardrailFunctionOutputFactory.rejectContent(
          'blocked before approval',
        ),
      );
      const t = tool({
        name: 'hi',
        description: 't',
        parameters: z.object({}),
        needsApproval: true,
        inputGuardrails: [
          {
            name: 'pre_approval_blocker',
            run: guardrailRun,
          },
        ],
        execute: vi.fn(async () => 'ok'),
      }) as unknown as FunctionTool;
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(
        undefined as any,
      );
      const invokeSpy = vi.spyOn(t, 'invoke');
      const preApprovalRunner = new Runner({
        tracingDisabled: true,
        toolExecution: { preApprovalInputGuardrails: true },
      });

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          preApprovalRunner,
          state,
        ),
      );

      expect(res[0].type).toBe('function_output');
      if (res[0].type === 'function_output') {
        expect(res[0].output).toBe('blocked before approval');
      }
      expect(guardrailRun).toHaveBeenCalledTimes(1);
      expect(invokeSpy).not.toHaveBeenCalled();
      expect(state._toolInputGuardrailResults).toHaveLength(1);
    });

    it('maps pre-approval guardrail rejection through a structured error fallback', async () => {
      const errorFunction = vi.fn(() => ({ status: 'blocked' as const }));
      const t = tool({
        name: 'hi',
        description: 'structured guarded tool',
        parameters: z.object({}),
        outputSchema: z.object({ status: z.literal('blocked') }),
        needsApproval: true,
        inputGuardrails: [
          {
            name: 'structured_pre_approval_blocker',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.rejectContent(
                'blocked before approval',
              ),
          },
        ],
        errorFunction,
        execute: vi.fn(async () => ({ status: 'blocked' as const })),
      }) as unknown as FunctionTool;
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(
        undefined as any,
      );
      const preApprovalRunner = new Runner({
        tracingDisabled: true,
        toolExecution: { preApprovalInputGuardrails: true },
      });

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          preApprovalRunner,
          state,
        ),
      );

      expect(res[0]).toMatchObject({
        type: 'function_output',
        output: { status: 'blocked' },
        runItem: {
          rawItem: {
            output: {
              type: 'text',
              text: JSON.stringify({ status: 'blocked' }),
            },
          },
        },
      });
      expect(errorFunction).toHaveBeenCalledWith(
        state._context,
        expect.objectContaining({ message: 'blocked before approval' }),
        { toolCall },
      );
    });

    it('runs input guardrails again before execution after approval', async () => {
      const guardrailRun = vi.fn(async () =>
        ToolGuardrailFunctionOutputFactory.allow(),
      );
      const needsApproval = vi.fn(async () => true);
      const t = tool({
        name: 'hi',
        description: 't',
        parameters: z.object({}),
        needsApproval,
        inputGuardrails: [
          {
            name: 'double_check',
            run: guardrailRun,
          },
        ],
        execute: vi.fn(async () => 'ok'),
      }) as unknown as FunctionTool;
      const invokeSpy = vi.spyOn(t, 'invoke');
      const preApprovalRunner = new Runner({
        tracingDisabled: true,
        toolExecution: { preApprovalInputGuardrails: true },
      });

      const first = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          preApprovalRunner,
          state,
        ),
      );

      expect(first[0].type).toBe('function_approval');
      expect(needsApproval).toHaveBeenCalledTimes(1);
      state._context.approveTool(first[0].runItem as ToolApprovalItem);

      const second = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          preApprovalRunner,
          state,
        ),
      );

      expect(second[0].type).toBe('function_output');
      expect(needsApproval).toHaveBeenCalledTimes(1);
      expect(guardrailRun).toHaveBeenCalledTimes(2);
      expect(invokeSpy).toHaveBeenCalledTimes(1);
      expect(state._toolInputGuardrailResults).toHaveLength(2);
    });

    it('returns rejection output when approval is false', async () => {
      const needsApproval = vi.fn(async () => true);
      const t = makeTool(needsApproval);
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
      expect(needsApproval).not.toHaveBeenCalled();
      expect(invokeSpy).not.toHaveBeenCalled();
    });

    it('maps approval rejection through a structured error fallback', async () => {
      const errorFunction = vi.fn(() => ({ status: 'rejected' as const }));
      const t = tool({
        name: 'hi',
        description: 'structured approval tool',
        parameters: z.object({}),
        outputSchema: z.object({ status: z.literal('rejected') }),
        needsApproval: true,
        errorFunction,
        execute: vi.fn(async () => ({ status: 'rejected' as const })),
      }) as unknown as FunctionTool;
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(false as any);

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      expect(res[0]).toMatchObject({
        type: 'function_output',
        output: { status: 'rejected' },
        runItem: {
          rawItem: {
            output: {
              type: 'text',
              text: JSON.stringify({ status: 'rejected' }),
            },
          },
        },
      });
      expect(errorFunction).toHaveBeenCalledWith(
        state._context,
        expect.objectContaining({
          message: 'Tool execution was not approved.',
        }),
        { toolCall },
      );
    });

    it.each(['formatter', 'fallback', 'fallback-rejection'] as const)(
      'skips approval rejection processing when cancellation arrives during %s',
      async (phase) => {
        const primaryError = new Error('primary tool failure');
        const fallbackError = new Error('secondary rejection fallback failure');
        let markPhaseStarted: (() => void) | undefined;
        const phaseStarted = new Promise<void>((resolve) => {
          markPhaseStarted = resolve;
        });
        let releasePhase: (() => void) | undefined;
        const phaseCanFinish = new Promise<void>((resolve) => {
          releasePhase = resolve;
        });
        let markFatalFailure: (() => void) | undefined;
        const fatalFailure = new Promise<void>((resolve) => {
          markFatalFailure = resolve;
        });
        const errorFunction = vi.fn(async () => {
          if (phase !== 'formatter') {
            markPhaseStarted?.();
            await phaseCanFinish;
          }
          if (phase === 'fallback-rejection') {
            throw fallbackError;
          }
          return { status: 'rejected' as const };
        });
        const rejectedToolExecute = vi.fn(async () => ({
          status: 'rejected' as const,
        }));
        const rejectedTool = tool({
          name: 'rejected_tool',
          description: 'waits while processing an approval rejection',
          parameters: z.object({}),
          outputSchema: z.object({ status: z.literal('rejected') }),
          needsApproval: true,
          errorFunction,
          execute: rejectedToolExecute,
        }) as unknown as FunctionTool;
        const failingTool = tool({
          name: 'failing_tool',
          description: 'fails while its sibling processes a rejection',
          parameters: z.object({}),
          errorFunction: null,
          execute: async () => {
            await phaseStarted;
            throw primaryError;
          },
        }) as unknown as FunctionTool;
        const toolErrorFormatter = vi.fn(async () => {
          if (phase === 'formatter') {
            markPhaseStarted?.();
            await phaseCanFinish;
          }
          return 'formatted rejection';
        });
        const customRunner = new Runner({
          tracingDisabled: false,
          toolErrorFormatter,
        });
        vi.spyOn(state._context, 'isToolApproved').mockImplementation(
          ({ callId }) =>
            (callId === 'rejected-call' ? false : undefined) as any,
        );

        let rejectedToolSpan: Span<any> | undefined;
        let settled = false;
        const resultPromise = withRecordingTrace(async (processor) => {
          const error = await withTrace('test', () =>
            executeFunctionToolCalls(
              state._currentAgent,
              [
                {
                  toolCall: {
                    ...toolCall,
                    callId: 'rejected-call',
                    name: 'rejected_tool',
                  },
                  tool: rejectedTool,
                },
                {
                  toolCall: {
                    ...toolCall,
                    callId: 'failing-call',
                    name: 'failing_tool',
                  },
                  tool: failingTool,
                },
              ],
              customRunner,
              state,
              customRunner.config.toolErrorFormatter,
              undefined,
              undefined,
              () => markFatalFailure?.(),
            ),
          ).catch((caught) => caught);
          rejectedToolSpan = getEndedFunctionSpan(processor, 'rejected_tool');
          return error;
        }).finally(() => {
          settled = true;
        });
        await fatalFailure;

        expect(settled).toBe(false);
        releasePhase?.();

        const error = await resultPromise;
        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).error).toBe(primaryError);
        expect(toolErrorFormatter).toHaveBeenCalledTimes(1);
        expect(errorFunction).toHaveBeenCalledTimes(
          phase === 'formatter' ? 0 : 1,
        );
        expect(rejectedToolExecute).not.toHaveBeenCalled();
        expect(rejectedToolSpan?.error).toBeNull();
        expect(rejectedToolSpan?.spanData.output).toBe('');
      },
    );

    it.each(['formatter', 'fallback', 'fallback-rejection'] as const)(
      'preserves approval rejection processing when parent cancellation arrives during %s',
      async (phase) => {
        const parentCancellation = new Error('parent cancellation');
        const fallbackError = new Error('rejection fallback failure');
        let markPhaseStarted: (() => void) | undefined;
        const phaseStarted = new Promise<void>((resolve) => {
          markPhaseStarted = resolve;
        });
        let releasePhase: (() => void) | undefined;
        const phaseCanFinish = new Promise<void>((resolve) => {
          releasePhase = resolve;
        });
        const errorFunction = vi.fn(async () => {
          if (phase !== 'formatter') {
            markPhaseStarted?.();
            await phaseCanFinish;
          }
          if (phase === 'fallback-rejection') {
            throw fallbackError;
          }
          return { status: 'rejected' as const };
        });
        const rejectedToolExecute = vi.fn(async () => ({
          status: 'rejected' as const,
        }));
        const rejectedTool = tool({
          name: 'rejected_tool',
          description: 'waits while processing an approval rejection',
          parameters: z.object({}),
          outputSchema: z.object({ status: z.literal('rejected') }),
          needsApproval: true,
          errorFunction,
          execute: rejectedToolExecute,
        }) as unknown as FunctionTool;
        const toolErrorFormatter = vi.fn(async () => {
          if (phase === 'formatter') {
            markPhaseStarted?.();
            await phaseCanFinish;
          }
          return 'formatted rejection';
        });
        const customRunner = new Runner({
          tracingDisabled: false,
          toolErrorFormatter,
        });
        const controller = new AbortController();
        vi.spyOn(state._context, 'isToolApproved').mockReturnValue(
          false as any,
        );

        let rejectedToolSpan: Span<any> | undefined;
        let settled = false;
        const resultPromise = withRecordingTrace(async (processor) => {
          const result = await withTrace('test', () =>
            executeFunctionToolCalls(
              state._currentAgent,
              [{ toolCall, tool: rejectedTool }],
              customRunner,
              state,
              customRunner.config.toolErrorFormatter,
              undefined,
              controller.signal,
            ),
          ).catch((caught) => caught);
          rejectedToolSpan = getEndedFunctionSpan(processor, 'rejected_tool');
          return result;
        }).finally(() => {
          settled = true;
        });
        await phaseStarted;

        controller.abort(parentCancellation);
        expect(settled).toBe(false);
        releasePhase?.();

        const result = await resultPromise;
        if (phase === 'fallback-rejection') {
          expect(result).toBeInstanceOf(ToolCallError);
          expect((result as ToolCallError).error).toBe(fallbackError);
          expect(rejectedToolSpan?.spanData.output).toBe('');
        } else {
          expect(result).toMatchObject([
            {
              type: 'function_output',
              output: { status: 'rejected' },
            },
          ]);
        }
        expect(toolErrorFormatter).toHaveBeenCalledTimes(1);
        expect(errorFunction).toHaveBeenCalledTimes(1);
        expect(rejectedToolExecute).not.toHaveBeenCalled();
        expect(rejectedToolSpan?.error?.message).toBe('formatted rejection');
      },
    );

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

    it('uses the bare tool name for top-level deferred tool trace spans', async () => {
      const t = tool({
        name: 'get_shipping_eta',
        description: 'Look up a shipping ETA.',
        parameters: z.object({
          tracking_number: z.string(),
        }),
        deferLoading: true,
        needsApproval: true,
        execute: vi.fn(async () => 'Tomorrow'),
      }) as unknown as FunctionTool;
      const deferredToolCall: protocol.FunctionCallItem = {
        type: 'function_call',
        id: 'fc_shipping_eta',
        callId: 'call_shipping_eta',
        name: 'get_shipping_eta',
        namespace: 'get_shipping_eta',
        status: 'completed',
        arguments: '{"tracking_number":"ZX-123"}',
      };
      const approvalSpy = vi
        .spyOn(state._context, 'isToolApproved')
        .mockImplementation(({ toolName }) =>
          toolName === getFunctionToolStateKey(t) ? false : undefined,
        );
      const customRunner = new Runner({ tracingDisabled: false });

      await withRecordingTrace(async (processor) => {
        const res = await withTrace('test', () =>
          executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall: deferredToolCall, tool: t }],
            customRunner,
            state,
          ),
        );

        expect(res[0].type).toBe('function_output');
        expect(approvalSpy).toHaveBeenCalledWith({
          toolName: getFunctionToolStateKey(t),
          callId: 'call_shipping_eta',
          functionTool: false,
          agent: state._currentAgent,
        });
        getEndedFunctionSpan(processor, 'get_shipping_eta');
        expect(
          processor.spansEnded.some(
            (span) =>
              span.spanData.type === 'function' &&
              span.spanData.name === 'get_shipping_eta.get_shipping_eta',
          ),
        ).toBe(false);
      });
    });

    it('keeps explicit namespaces in function trace span names', async () => {
      const [crmLookup] = toolNamespace({
        name: 'crm',
        description: 'CRM tools',
        tools: [
          tool({
            name: 'lookup_account',
            description: 'Look up an account in CRM.',
            parameters: z.object({
              accountId: z.string(),
            }),
            execute: vi.fn(async () => 'crm'),
          }),
        ],
      }) as unknown as FunctionTool[];
      const namespacedToolCall: protocol.FunctionCallItem = {
        type: 'function_call',
        id: 'fc_lookup_account',
        callId: 'call_lookup_account',
        name: 'lookup_account',
        namespace: 'crm',
        status: 'completed',
        arguments: '{"accountId":"acct_42"}',
      };
      const customRunner = new Runner({ tracingDisabled: false });

      await withRecordingTrace(async (processor) => {
        const res = await withTrace('test', () =>
          executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall: namespacedToolCall, tool: crmLookup }],
            customRunner,
            state,
          ),
        );

        expect(res[0].type).toBe('function_output');
        getEndedFunctionSpan(processor, 'crm.lookup_account');
      });
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
        'toolErrorFormatter threw while formatting approval rejection: object',
      );
      warnSpy.mockRestore();
    });

    it('redacts toolErrorFormatter errors when tool-data logging is disabled', async () => {
      const secret = 'SECRET_FORMATTER_VALUE_123';
      const constructorGetter = vi.fn(() => {
        throw new Error('The Error constructor must not be inspected.');
      });
      const formatterError = new Error(secret);
      Object.defineProperty(formatterError, 'constructor', {
        get: constructorGetter,
      });
      const t = makeTool(true);
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(false as any);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const customRunner = new Runner({
        tracingDisabled: true,
        toolErrorFormatter: () => {
          throw formatterError;
        },
      });

      try {
        const result = await withTrace('test', () =>
          executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall, tool: t }],
            customRunner,
            state,
            customRunner.config.toolErrorFormatter,
          ),
        );

        expect(result[0].type).toBe('function_output');
        expect(warnSpy).toHaveBeenCalledWith(
          'toolErrorFormatter threw while formatting approval rejection: object',
        );
        expect(JSON.stringify(warnSpy.mock.calls)).not.toContain(secret);
        expect(constructorGetter).not.toHaveBeenCalled();
      } finally {
        flagSpy.mockRestore();
        warnSpy.mockRestore();
      }
    });

    it('falls back when a redacted toolErrorFormatter throws a hostile Proxy', async () => {
      const formatterError = new Proxy(
        {},
        {
          getPrototypeOf() {
            throw new Error('SECRET_PROXY_TRAP_123');
          },
        },
      );
      const t = makeTool(true);
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(false as any);
      const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const customRunner = new Runner({
        tracingDisabled: true,
        toolErrorFormatter: () => {
          throw formatterError;
        },
      });

      try {
        const result = await withTrace('test', () =>
          executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall, tool: t }],
            customRunner,
            state,
            customRunner.config.toolErrorFormatter,
          ),
        );

        expect(result[0].type).toBe('function_output');
        if (result[0].type === 'function_output') {
          expect(result[0].output).toBe('Tool execution was not approved.');
        }
        expect(warnSpy).toHaveBeenCalledWith(
          'toolErrorFormatter threw while formatting approval rejection: object',
        );
      } finally {
        flagSpy.mockRestore();
        warnSpy.mockRestore();
      }
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

    it('preserves schema-backed content-like outputs as JSON', async () => {
      const outputSchema = z.object({
        type: z.literal('text'),
        text: z.string(),
      });
      const t = tool({
        name: 'hi',
        description: 'structured content-like output',
        parameters: z.object({}),
        outputSchema,
        execute: async () => ({ type: 'text' as const, text: 'ok' }),
      }) as unknown as FunctionTool;

      const results = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      expect(results[0]).toMatchObject({
        type: 'function_output',
        output: { type: 'text', text: 'ok' },
        runItem: {
          rawItem: {
            output: {
              type: 'text',
              text: JSON.stringify({ type: 'text', text: 'ok' }),
            },
          },
        },
      });
    });

    it('passes a cloned tool call to customDataExtractor', async () => {
      const localToolCall = {
        ...toolCall,
        callId: 'c_cloned_tool_call',
        arguments: '{}',
      };
      const t = tool({
        name: 'hi',
        description: 't',
        parameters: z.object({}),
        execute: vi.fn(async () => 'ok'),
        customDataExtractor: (context) => {
          (context.toolCall as any).sdkOnly = { traceId: 'sdk-only' };
          context.toolCall.arguments = '{"leaked":true}';
          return { annotatedCall: context.toolCall };
        },
      }) as unknown as FunctionTool;

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall: localToolCall, tool: t }],
          runner,
          state,
        ),
      );

      expect(res[0].type).toBe('function_output');
      expect((localToolCall as any).sdkOnly).toBeUndefined();
      expect(localToolCall.arguments).toBe('{}');
      if (res[0].type === 'function_output') {
        expect(res[0].runItem.customData).toEqual({
          annotatedCall: {
            ...localToolCall,
            arguments: '{"leaked":true}',
            sdkOnly: { traceId: 'sdk-only' },
          },
        });
      }
    });

    it('passes the executed tool input to customDataExtractor', async () => {
      const executedInputs: unknown[] = [];
      const t = tool({
        name: 'hi',
        description: 't',
        parameters: z.object({
          name: z.string(),
          optional: z.string().optional(),
          withDefault: z.string().default('default-value'),
        }),
        execute: vi.fn(async (input) => {
          executedInputs.push(input);
          return 'ok';
        }),
        customDataExtractor: (context) => ({
          input: context.input,
        }),
      }) as unknown as FunctionTool;
      const localToolCall = {
        ...toolCall,
        callId: 'c_executed_input_custom_data',
        arguments: JSON.stringify({
          name: 'alice',
          optional: null,
        }),
      };

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall: localToolCall, tool: t }],
          runner,
          state,
        ),
      );

      const expectedInput = {
        name: 'alice',
        withDefault: 'default-value',
      };
      expect(executedInputs).toEqual([expectedInput]);
      expect(res[0].type).toBe('function_output');
      if (res[0].type === 'function_output') {
        expect(res[0].runItem.customData).toEqual({
          input: expectedInput,
        });
      }
    });

    it('emits a single error end event when customDataExtractor fails', async () => {
      const t = tool({
        name: 'hi',
        description: 't',
        parameters: z.object({}),
        execute: vi.fn(async () => 'ok'),
        customDataExtractor: () => ({ bad: BigInt(1) }) as any,
      }) as unknown as FunctionTool;
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
      ).rejects.toThrow(/customDataExtractor must return JSON-compatible data/);

      expect(start).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledTimes(1);
      expect(end).toHaveBeenCalledWith(
        state._context,
        state._currentAgent,
        t,
        expect.stringContaining(
          'customDataExtractor must return JSON-compatible data',
        ),
        { toolCall },
      );
      expect(end).not.toHaveBeenCalledWith(
        state._context,
        state._currentAgent,
        t,
        'ok',
        { toolCall },
      );
    });

    it('starts all function tool calls by default', async () => {
      let activeCount = 0;
      let maxSeenCount = 0;
      const t = tool({
        name: 'hi',
        description: 'tracked tool',
        parameters: z.object({ value: z.number() }),
        execute: vi.fn(async ({ value }) => {
          activeCount += 1;
          maxSeenCount = Math.max(maxSeenCount, activeCount);
          try {
            await new Promise((resolve) => setTimeout(resolve, 10));
            return `ok-${value}`;
          } finally {
            activeCount -= 1;
          }
        }),
      }) as unknown as FunctionTool;

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [1, 2, 3].map((value) => ({
            toolCall: {
              ...toolCall,
              callId: `c${value}`,
              arguments: JSON.stringify({ value }),
            },
            tool: t,
          })),
          runner,
          state,
        ),
      );

      expect(activeCount).toBe(0);
      expect(maxSeenCount).toBe(3);
      expect(
        res.map((result) => {
          expect(result.type).toBe('function_output');
          return result.type === 'function_output' ? result.output : undefined;
        }),
      ).toEqual(['ok-1', 'ok-2', 'ok-3']);
    });

    it('cancels and drains an uncapped sibling after a tool failure', async () => {
      let markSiblingStarted: (() => void) | undefined;
      const siblingStarted = new Promise<void>((resolve) => {
        markSiblingStarted = resolve;
      });
      const primaryError = new Error('boom');
      let siblingCancelled = false;
      let siblingDrained = false;
      let lateSideEffect = false;
      const failingTool = tool({
        name: 'failing_tool',
        description: 'fails while a sibling remains pending',
        parameters: z.object({}),
        errorFunction: null,
        execute: vi.fn(async () => {
          await siblingStarted;
          throw primaryError;
        }),
      }) as unknown as FunctionTool;
      const pendingTool = tool({
        name: 'pending_tool',
        description: 'remains pending until released',
        parameters: z.object({}),
        execute: vi.fn(async (_input, _context, details) => {
          markSiblingStarted?.();
          if (!details?.signal) {
            throw new Error('Expected an internal cancellation signal');
          }
          try {
            await new Promise<void>((_resolve, reject) => {
              details.signal?.addEventListener(
                'abort',
                () => reject(details.signal?.reason),
                { once: true },
              );
            });
            lateSideEffect = true;
            return 'unexpected';
          } catch (error) {
            siblingCancelled = true;
            await Promise.resolve();
            siblingDrained = true;
            throw error;
          }
        }),
      }) as unknown as FunctionTool;

      const resultPromise = executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              callId: 'failing-call',
              name: 'failing_tool',
            },
            tool: failingTool,
          },
          {
            toolCall: {
              ...toolCall,
              callId: 'pending-call',
              name: 'pending_tool',
            },
            tool: pendingTool,
          },
        ],
        runner,
        state,
      );
      await siblingStarted;

      const error = await resultPromise.catch((caught) => caught);

      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBe(primaryError);
      expect(siblingCancelled).toBe(true);
      expect(siblingDrained).toBe(true);
      expect(lateSideEffect).toBe(false);
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      expect(lateSideEffect).toBe(false);
    });

    it('skips approved tool setup when a sibling fails during async approval', async () => {
      const primaryError = new Error('primary tool failure');
      let markApprovalStarted: (() => void) | undefined;
      const approvalStarted = new Promise<void>((resolve) => {
        markApprovalStarted = resolve;
      });
      let releaseApproval: (() => void) | undefined;
      const approvalCanFinish = new Promise<void>((resolve) => {
        releaseApproval = resolve;
      });
      let markFatalFailure: (() => void) | undefined;
      const fatalFailure = new Promise<void>((resolve) => {
        markFatalFailure = resolve;
      });
      const inputGuardrail = defineToolInputGuardrail({
        name: 'should_not_run',
        run: vi.fn(async () => ToolGuardrailFunctionOutputFactory.allow()),
      });
      const approvedToolExecute = vi.fn(async () => 'unexpected');
      const approvalTool = tool({
        name: 'approval_tool',
        description: 'waits for an async approval decision',
        parameters: z.object({}),
        needsApproval: async () => {
          markApprovalStarted?.();
          await approvalCanFinish;
          return true;
        },
        inputGuardrails: [inputGuardrail],
        execute: approvedToolExecute,
      }) as unknown as FunctionTool;
      runner = new Runner({
        tracingDisabled: true,
        toolExecution: { preApprovalInputGuardrails: true },
      });
      const failingTool = tool({
        name: 'failing_tool',
        description: 'fails while its sibling awaits approval',
        parameters: z.object({}),
        errorFunction: null,
        execute: async () => {
          await approvalStarted;
          throw primaryError;
        },
      }) as unknown as FunctionTool;

      let settled = false;
      const resultPromise = executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              callId: 'approval-call',
              name: 'approval_tool',
            },
            tool: approvalTool,
          },
          {
            toolCall: {
              ...toolCall,
              callId: 'failing-call',
              name: 'failing_tool',
            },
            tool: failingTool,
          },
        ],
        runner,
        state,
        undefined,
        undefined,
        undefined,
        () => markFatalFailure?.(),
      ).finally(() => {
        settled = true;
      });
      await fatalFailure;

      expect(settled).toBe(false);
      releaseApproval?.();

      const error = await resultPromise.catch((caught) => caught);
      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBe(primaryError);
      expect(inputGuardrail.run).not.toHaveBeenCalled();
      expect(approvedToolExecute).not.toHaveBeenCalled();
      expect(state._toolInputGuardrailResults).toHaveLength(0);
    });

    it('skips pre-approval rejection fallback after sibling cancellation', async () => {
      const primaryError = new Error('primary tool failure');
      let markGuardrailStarted: (() => void) | undefined;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      let releaseGuardrail: (() => void) | undefined;
      const guardrailCanFinish = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      let markFatalFailure: (() => void) | undefined;
      const fatalFailure = new Promise<void>((resolve) => {
        markFatalFailure = resolve;
      });
      const inputGuardrail = defineToolInputGuardrail({
        name: 'blocking_pre_approval_guardrail',
        run: vi.fn(async () => {
          markGuardrailStarted?.();
          await guardrailCanFinish;
          return ToolGuardrailFunctionOutputFactory.rejectContent('blocked');
        }),
      });
      const errorFunction = vi.fn(() => ({ status: 'blocked' as const }));
      const guardedToolExecute = vi.fn(async () => ({
        status: 'blocked' as const,
      }));
      const guardedTool = tool({
        name: 'guarded_tool',
        description: 'waits in a pre-approval guardrail',
        parameters: z.object({}),
        outputSchema: z.object({ status: z.literal('blocked') }),
        needsApproval: true,
        inputGuardrails: [inputGuardrail],
        errorFunction,
        execute: guardedToolExecute,
      }) as unknown as FunctionTool;
      const failingTool = tool({
        name: 'failing_tool',
        description: 'fails while its sibling guardrail remains active',
        parameters: z.object({}),
        errorFunction: null,
        execute: async () => {
          await guardrailStarted;
          throw primaryError;
        },
      }) as unknown as FunctionTool;
      runner = new Runner({
        tracingDisabled: true,
        toolExecution: { preApprovalInputGuardrails: true },
      });

      let settled = false;
      const resultPromise = executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              callId: 'guarded-call',
              name: 'guarded_tool',
            },
            tool: guardedTool,
          },
          {
            toolCall: {
              ...toolCall,
              callId: 'failing-call',
              name: 'failing_tool',
            },
            tool: failingTool,
          },
        ],
        runner,
        state,
        undefined,
        undefined,
        undefined,
        () => markFatalFailure?.(),
      ).finally(() => {
        settled = true;
      });
      await fatalFailure;

      expect(settled).toBe(false);
      releaseGuardrail?.();

      const error = await resultPromise.catch((caught) => caught);
      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBe(primaryError);
      expect(inputGuardrail.run).toHaveBeenCalledTimes(1);
      expect(state._toolInputGuardrailResults).toHaveLength(1);
      expect(errorFunction).not.toHaveBeenCalled();
      expect(guardedToolExecute).not.toHaveBeenCalled();
    });

    it('does not wait past timeout for a cancelled sibling invocation', async () => {
      vi.useFakeTimers();
      try {
        const primaryError = new Error('primary tool failure');
        let markTimedToolStarted: (() => void) | undefined;
        const timedToolStarted = new Promise<void>((resolve) => {
          markTimedToolStarted = resolve;
        });
        let releaseTimedTool: (() => void) | undefined;
        const timedToolCanFinish = new Promise<void>((resolve) => {
          releaseTimedTool = resolve;
        });
        let markFatalFailure: (() => void) | undefined;
        const fatalFailure = new Promise<void>((resolve) => {
          markFatalFailure = resolve;
        });
        let runRejected = false;
        let sideEffectAfterRejection = false;
        let markTimedToolFinished: (() => void) | undefined;
        const timedToolFinished = new Promise<void>((resolve) => {
          markTimedToolFinished = resolve;
        });
        const timedTool = tool({
          name: 'timed_tool',
          description: 'ignores sibling cancellation until after its timeout',
          parameters: z.object({}),
          timeoutMs: 1_000,
          execute: async () => {
            markTimedToolStarted?.();
            await timedToolCanFinish;
            sideEffectAfterRejection = runRejected;
            markTimedToolFinished?.();
            return 'late tool output';
          },
        }) as unknown as FunctionTool;
        const failingTool = tool({
          name: 'failing_tool',
          description: 'fails while its timed sibling remains active',
          parameters: z.object({}),
          errorFunction: null,
          execute: async () => {
            await timedToolStarted;
            throw primaryError;
          },
        }) as unknown as FunctionTool;

        const resultPromise = executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                callId: 'timed-call',
                name: 'timed_tool',
              },
              tool: timedTool,
            },
            {
              toolCall: {
                ...toolCall,
                callId: 'failing-call',
                name: 'failing_tool',
              },
              tool: failingTool,
            },
          ],
          runner,
          state,
          undefined,
          undefined,
          undefined,
          () => markFatalFailure?.(),
        ).catch((caught) => {
          runRejected = true;
          return caught;
        });
        await fatalFailure;

        await vi.advanceTimersByTimeAsync(1_000);
        const error = await resultPromise;
        expect(runRejected).toBe(true);
        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).error).toBe(primaryError);
        expect(sideEffectAfterRejection).toBe(false);

        releaseTimedTool?.();
        await timedToolFinished;
        expect(sideEffectAfterRejection).toBe(true);
      } finally {
        vi.useRealTimers();
      }
    });

    it('does not drain the timed-out owner before raising its failure', async () => {
      vi.useFakeTimers();
      let releaseTimedTool: (() => void) | undefined;
      let resultPromise: Promise<unknown> | undefined;
      try {
        let markTimedToolStarted: (() => void) | undefined;
        const timedToolStarted = new Promise<void>((resolve) => {
          markTimedToolStarted = resolve;
        });
        const timedToolCanFinish = new Promise<void>((resolve) => {
          releaseTimedTool = resolve;
        });
        let markSiblingStarted: (() => void) | undefined;
        const siblingStarted = new Promise<void>((resolve) => {
          markSiblingStarted = resolve;
        });
        const timedTool = tool({
          name: 'timed_tool',
          description: 'owns the first fatal timeout',
          parameters: z.object({}),
          timeoutMs: 1_000,
          timeoutBehavior: 'raise_exception',
          execute: async () => {
            markTimedToolStarted?.();
            await timedToolCanFinish;
            return 'late tool output';
          },
        }) as unknown as FunctionTool;
        const siblingTool = tool({
          name: 'sibling_tool',
          description: 'settles when its timed sibling cancels it',
          parameters: z.object({}),
          execute: async (_input, _context, details) => {
            markSiblingStarted?.();
            await new Promise<void>((resolve) => {
              details?.signal?.addEventListener('abort', () => resolve(), {
                once: true,
              });
            });
            return 'cancelled sibling output';
          },
        }) as unknown as FunctionTool;

        let settled = false;
        let resultError: unknown;
        resultPromise = executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                callId: 'timed-call',
                name: 'timed_tool',
              },
              tool: timedTool,
            },
            {
              toolCall: {
                ...toolCall,
                callId: 'sibling-call',
                name: 'sibling_tool',
              },
              tool: siblingTool,
            },
          ],
          runner,
          state,
        )
          .catch((caught) => {
            resultError = caught;
          })
          .finally(() => {
            settled = true;
          });
        await Promise.all([timedToolStarted, siblingStarted]);
        await vi.advanceTimersByTimeAsync(1_000);

        expect(settled).toBe(true);
        expect(resultError).toBeInstanceOf(ToolTimeoutError);
      } finally {
        releaseTimedTool?.();
        await resultPromise;
        vi.useRealTimers();
      }
    });

    it.each(['resolves', 'rejects'] as const)(
      'reports an uncapped sibling that %s after cancellation as aborted',
      async (settlement) => {
        const primaryError = new Error('primary tool failure');
        let markSlowToolStarted: (() => void) | undefined;
        const slowToolStarted = new Promise<void>((resolve) => {
          markSlowToolStarted = resolve;
        });
        let markCancellationObserved: (() => void) | undefined;
        const cancellationObserved = new Promise<void>((resolve) => {
          markCancellationObserved = resolve;
        });
        let releaseSlowTool: (() => void) | undefined;
        const slowToolCanFinish = new Promise<void>((resolve) => {
          releaseSlowTool = resolve;
        });
        const outputGuardrail = defineToolOutputGuardrail({
          name: 'should_not_run',
          run: vi.fn(async () => ToolGuardrailFunctionOutputFactory.allow()),
        });
        const customDataExtractor = vi.fn(() => ({ shouldNotRun: true }));
        const failingTool = tool({
          name: 'failing_tool',
          description: 'fails after its sibling starts',
          parameters: z.object({}),
          errorFunction: null,
          execute: async () => {
            await slowToolStarted;
            throw primaryError;
          },
        }) as unknown as FunctionTool;
        const slowTool = tool({
          name: 'slow_tool',
          description: 'ignores cancellation and resolves later',
          parameters: z.object({}),
          outputGuardrails: [outputGuardrail],
          customDataExtractor,
          execute: async (_input, _context, details) => {
            markSlowToolStarted?.();
            details?.signal?.addEventListener(
              'abort',
              () => markCancellationObserved?.(),
              { once: true },
            );
            await slowToolCanFinish;
            if (settlement === 'rejects') {
              throw new Error('late invocation rejection');
            }
            return 'late tool output';
          },
        }) as unknown as FunctionTool;
        const endHookError = new Error('function end hook failed');
        const end = vi.fn((...args: unknown[]) => {
          if (settlement === 'rejects' && args[2] === slowTool) {
            throw endHookError;
          }
        });
        runner = new Runner({ tracingDisabled: false });
        runner.on('agent_tool_end', end);

        let settled = false;
        let slowToolSpan: Span<any> | undefined;
        const resultPromise = withRecordingTrace(async (processor) => {
          const error = await withTrace('test', () =>
            executeFunctionToolCalls(
              state._currentAgent,
              [
                {
                  toolCall: {
                    ...toolCall,
                    callId: 'failing-call',
                    name: 'failing_tool',
                  },
                  tool: failingTool,
                },
                {
                  toolCall: {
                    ...toolCall,
                    callId: 'slow-call',
                    name: 'slow_tool',
                  },
                  tool: slowTool,
                },
              ],
              runner,
              state,
            ),
          ).catch((caught) => caught);
          slowToolSpan = getEndedFunctionSpan(processor, 'slow_tool');
          return error;
        }).finally(() => {
          settled = true;
        });
        await cancellationObserved;

        expect(settled).toBe(false);
        releaseSlowTool?.();

        const error = await resultPromise;
        const slowToolEndCalls = end.mock.calls.filter(
          ([, , endedTool]) => endedTool === slowTool,
        );
        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).error).toBe(primaryError);
        expect(outputGuardrail.run).not.toHaveBeenCalled();
        expect(customDataExtractor).not.toHaveBeenCalled();
        expect(slowToolEndCalls).toHaveLength(1);
        expect(slowToolEndCalls[0]?.[3]).toBe('aborted');
        if (settlement === 'rejects') {
          expect(slowToolSpan?.error).toMatchObject({
            message: endHookError.message,
          });
        } else {
          expect(slowToolSpan?.error).toBeNull();
        }
        expect(slowToolSpan?.spanData.output).toBe('aborted');
      },
    );

    it('stops success post-processing after cancellation during output guardrails', async () => {
      const primaryError = new Error('primary tool failure');
      let markGuardrailStarted: (() => void) | undefined;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      let releaseGuardrail: (() => void) | undefined;
      const guardrailCanFinish = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      let markFatalFailure: (() => void) | undefined;
      const fatalFailure = new Promise<void>((resolve) => {
        markFatalFailure = resolve;
      });
      const outputGuardrail = defineToolOutputGuardrail({
        name: 'blocking_output_guardrail',
        run: vi.fn(async () => {
          markGuardrailStarted?.();
          await guardrailCanFinish;
          return ToolGuardrailFunctionOutputFactory.rejectContent(
            'invalid replacement',
          );
        }),
      });
      const customDataExtractor = vi.fn(() => ({ shouldNotRun: true }));
      const guardedTool = tool({
        name: 'guarded_tool',
        description: 'waits in an output guardrail',
        parameters: z.object({}),
        outputSchema: z.object({ status: z.literal('ok') }),
        outputGuardrails: [outputGuardrail],
        customDataExtractor,
        execute: async () => ({ status: 'ok' as const }),
      }) as unknown as FunctionTool;
      const failingTool = tool({
        name: 'failing_tool',
        description: 'fails while its sibling output guardrail remains active',
        parameters: z.object({}),
        errorFunction: null,
        execute: async () => {
          await guardrailStarted;
          throw primaryError;
        },
      }) as unknown as FunctionTool;
      const end = vi.fn();
      runner.on('agent_tool_end', end);

      let settled = false;
      const resultPromise = executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              callId: 'guarded-call',
              name: 'guarded_tool',
            },
            tool: guardedTool,
          },
          {
            toolCall: {
              ...toolCall,
              callId: 'failing-call',
              name: 'failing_tool',
            },
            tool: failingTool,
          },
        ],
        runner,
        state,
        undefined,
        undefined,
        undefined,
        () => markFatalFailure?.(),
      ).finally(() => {
        settled = true;
      });
      await guardrailStarted;
      await fatalFailure;
      expect(settled).toBe(false);
      releaseGuardrail?.();

      const error = await resultPromise.catch((caught) => caught);
      const guardedToolEndCalls = end.mock.calls.filter(
        ([, , endedTool]) => endedTool === guardedTool,
      );
      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBe(primaryError);
      expect(outputGuardrail.run).toHaveBeenCalledTimes(1);
      expect(state._toolOutputGuardrailResults).toHaveLength(1);
      expect(customDataExtractor).not.toHaveBeenCalled();
      expect(guardedToolEndCalls).toHaveLength(1);
      expect(guardedToolEndCalls[0]?.[3]).toBe('aborted');
    });

    it.each(['fulfills', 'rejects'] as const)(
      'reports cancellation when function custom data extraction %s as aborted',
      async (settlement) => {
        const primaryError = new Error('primary tool failure');
        const customDataError = new Error(
          'custom data failed after cancellation',
        );
        let markCustomDataStarted: (() => void) | undefined;
        const customDataStarted = new Promise<void>((resolve) => {
          markCustomDataStarted = resolve;
        });
        let releaseCustomData: (() => void) | undefined;
        const customDataCanFinish = new Promise<void>((resolve) => {
          releaseCustomData = resolve;
        });
        let markFatalFailure: (() => void) | undefined;
        const fatalFailure = new Promise<void>((resolve) => {
          markFatalFailure = resolve;
        });
        let customDataFinished = false;
        const extractingTool = tool({
          name: 'extracting_tool',
          description: 'waits while extracting custom data',
          parameters: z.object({}),
          execute: async () => 'tool output',
          customDataExtractor: async () => {
            markCustomDataStarted?.();
            await customDataCanFinish;
            customDataFinished = true;
            if (settlement === 'rejects') {
              throw customDataError;
            }
            return { extracted: true };
          },
        }) as unknown as FunctionTool;
        const failingTool = tool({
          name: 'failing_tool',
          description: 'fails while its sibling extracts custom data',
          parameters: z.object({}),
          errorFunction: null,
          execute: async () => {
            await customDataStarted;
            throw primaryError;
          },
        }) as unknown as FunctionTool;
        const end = vi.fn();
        runner.on('agent_tool_end', end);

        let settled = false;
        const resultPromise = executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                callId: 'extracting-call',
                name: 'extracting_tool',
              },
              tool: extractingTool,
            },
            {
              toolCall: {
                ...toolCall,
                callId: 'failing-call',
                name: 'failing_tool',
              },
              tool: failingTool,
            },
          ],
          runner,
          state,
          undefined,
          undefined,
          undefined,
          () => markFatalFailure?.(),
        ).finally(() => {
          settled = true;
        });
        await fatalFailure;

        expect(settled).toBe(false);
        releaseCustomData?.();

        const error = await resultPromise.catch((caught) => caught);
        const extractingToolEndCalls = end.mock.calls.filter(
          ([, , endedTool]) => endedTool === extractingTool,
        );
        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).error).toBe(primaryError);
        expect(customDataFinished).toBe(true);
        expect(extractingToolEndCalls).toHaveLength(1);
        expect(extractingToolEndCalls[0]?.[3]).toBe('aborted');
      },
    );

    it('prioritizes cancellation after custom data promotes redaction', async () => {
      const secret = 'SECRET_CANCELLED_CUSTOM_DATA_REDACTION_123';
      const primaryError = new Error('primary tool failure');
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      let markCustomDataStarted: (() => void) | undefined;
      const customDataStarted = new Promise<void>((resolve) => {
        markCustomDataStarted = resolve;
      });
      let releaseCustomData: (() => void) | undefined;
      const customDataCanFinish = new Promise<void>((resolve) => {
        releaseCustomData = resolve;
      });
      let markFatalFailure: (() => void) | undefined;
      const fatalFailure = new Promise<void>((resolve) => {
        markFatalFailure = resolve;
      });
      const invalidInputTool = tool({
        name: 'invalid_input_custom_data',
        description: 'promotes redaction while extracting custom data',
        parameters: z.object({ value: z.number() }),
        errorFunction: () => 'diagnostic fallback',
        customDataExtractor: async (context) => {
          markCustomDataStarted?.();
          await customDataCanFinish;
          redactToolData = true;
          return { captured: context.input };
        },
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const failingTool = tool({
        name: 'failing_tool',
        description: 'fails while its sibling extracts custom data',
        parameters: z.object({}),
        errorFunction: null,
        execute: async () => {
          await customDataStarted;
          throw primaryError;
        },
      }) as unknown as FunctionTool;
      const invalidToolCall = {
        ...toolCall,
        callId: 'invalid-custom-data-call',
        name: 'invalid_input_custom_data',
        arguments: JSON.stringify({ value: secret }),
      };
      const end = vi.fn();
      runner = new Runner({
        tracingDisabled: false,
        traceIncludeSensitiveData: true,
      });
      runner.on('agent_tool_end', end);

      try {
        let invalidToolSpan: Span<any> | undefined;
        let settled = false;
        const resultPromise = withRecordingTrace(async (processor) => {
          const error = await withTrace('test', () =>
            executeFunctionToolCalls(
              state._currentAgent,
              [
                { toolCall: invalidToolCall, tool: invalidInputTool },
                {
                  toolCall: {
                    ...toolCall,
                    callId: 'failing-call',
                    name: 'failing_tool',
                  },
                  tool: failingTool,
                },
              ],
              runner,
              state,
              undefined,
              undefined,
              undefined,
              () => markFatalFailure?.(),
            ),
          ).catch((caught) => caught);
          invalidToolSpan = getEndedFunctionSpan(
            processor,
            'invalid_input_custom_data',
          );
          return error;
        }).finally(() => {
          settled = true;
        });
        await fatalFailure;

        expect(settled).toBe(false);
        releaseCustomData?.();

        const error = await resultPromise;
        const invalidToolEndCalls = end.mock.calls.filter(
          ([, , endedTool]) => endedTool === invalidInputTool,
        );
        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).error).toBe(primaryError);
        expect(invalidToolEndCalls).toHaveLength(1);
        expect(invalidToolEndCalls[0]?.[3]).toBe('aborted');
        expect(invalidToolSpan?.error).toMatchObject({
          message: 'Error running tool (non-fatal)',
        });
        expect(invalidToolSpan?.spanData.output).toBe('aborted');
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it.each(['fulfills', 'rejects'] as const)(
      'stops success post-processing when an input guardrail fallback %s after cancellation',
      async (settlement) => {
        const primaryError = new Error('primary tool failure');
        const fallbackError = new Error('fallback failed after cancellation');
        let markFallbackStarted: (() => void) | undefined;
        const fallbackStarted = new Promise<void>((resolve) => {
          markFallbackStarted = resolve;
        });
        let releaseFallback: (() => void) | undefined;
        const fallbackCanFinish = new Promise<void>((resolve) => {
          releaseFallback = resolve;
        });
        let markFatalFailure: (() => void) | undefined;
        const fatalFailure = new Promise<void>((resolve) => {
          markFatalFailure = resolve;
        });
        let fallbackDrained = false;
        const inputGuardrail = defineToolInputGuardrail({
          name: 'rejecting_input_guardrail',
          run: vi.fn(async () =>
            ToolGuardrailFunctionOutputFactory.rejectContent('blocked'),
          ),
        });
        const guardedToolExecute = vi.fn(async () => ({
          status: 'unexpected' as const,
        }));
        const customDataExtractor = vi.fn(() => ({ shouldNotRun: true }));
        const guardedTool = tool({
          name: 'guarded_tool',
          description: 'waits in an input guardrail fallback',
          parameters: z.object({}),
          outputSchema: z.object({ status: z.string() }),
          inputGuardrails: [inputGuardrail],
          errorFunction: async () => {
            markFallbackStarted?.();
            await fallbackCanFinish;
            fallbackDrained = true;
            if (settlement === 'rejects') {
              throw fallbackError;
            }
            return { status: 'blocked' };
          },
          customDataExtractor,
          execute: guardedToolExecute,
        }) as unknown as FunctionTool;
        const failingTool = tool({
          name: 'failing_tool',
          description: 'fails while its sibling fallback remains active',
          parameters: z.object({}),
          errorFunction: null,
          execute: async () => {
            await fallbackStarted;
            throw primaryError;
          },
        }) as unknown as FunctionTool;
        const end = vi.fn();
        runner = new Runner({ tracingDisabled: false });
        runner.on('agent_tool_end', end);

        let settled = false;
        let guardedToolSpan: Span<any> | undefined;
        const resultPromise = withRecordingTrace(async (processor) => {
          const error = await withTrace('test', () =>
            executeFunctionToolCalls(
              state._currentAgent,
              [
                {
                  toolCall: {
                    ...toolCall,
                    callId: 'guarded-call',
                    name: 'guarded_tool',
                  },
                  tool: guardedTool,
                },
                {
                  toolCall: {
                    ...toolCall,
                    callId: 'failing-call',
                    name: 'failing_tool',
                  },
                  tool: failingTool,
                },
              ],
              runner,
              state,
              undefined,
              undefined,
              undefined,
              () => markFatalFailure?.(),
            ),
          ).catch((caught) => caught);
          guardedToolSpan = getEndedFunctionSpan(processor, 'guarded_tool');
          return error;
        }).finally(() => {
          settled = true;
        });
        await fallbackStarted;
        await fatalFailure;

        expect(settled).toBe(false);
        releaseFallback?.();

        const error = await resultPromise;
        const guardedToolEndCalls = end.mock.calls.filter(
          ([, , endedTool]) => endedTool === guardedTool,
        );
        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).error).toBe(primaryError);
        expect(inputGuardrail.run).toHaveBeenCalledTimes(1);
        expect(fallbackDrained).toBe(true);
        expect(guardedToolExecute).not.toHaveBeenCalled();
        expect(customDataExtractor).not.toHaveBeenCalled();
        expect(guardedToolEndCalls).toHaveLength(1);
        expect(guardedToolEndCalls[0]?.[3]).toBe('aborted');
        expect(guardedToolSpan?.error).toBeNull();
        expect(guardedToolSpan?.spanData.output).toBe('aborted');
      },
    );

    it('preserves aborted lifecycle output when an end hook promotes redaction', async () => {
      const secret = 'SECRET_CANCELLED_INVALID_INPUT_123';
      const primaryError = new Error('primary tool failure');
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      let markFallbackStarted: (() => void) | undefined;
      const fallbackStarted = new Promise<void>((resolve) => {
        markFallbackStarted = resolve;
      });
      let markCancellationObserved: (() => void) | undefined;
      const cancellationObserved = new Promise<void>((resolve) => {
        markCancellationObserved = resolve;
      });
      let releaseFallback: (() => void) | undefined;
      const fallbackCanFinish = new Promise<void>((resolve) => {
        releaseFallback = resolve;
      });
      const invalidInputTool = tool({
        name: 'cancelled_invalid_input',
        description: 'Wait in an invalid-input fallback until cancelled.',
        parameters: z.object({ value: z.number() }),
        errorFunction: async (_context, _error, details) => {
          markFallbackStarted?.();
          details?.signal?.addEventListener(
            'abort',
            () => markCancellationObserved?.(),
            { once: true },
          );
          await fallbackCanFinish;
          return 'late fallback';
        },
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const failingTool = tool({
        name: 'redaction_triggering_sibling_failure',
        description: 'Fail after the invalid-input fallback starts.',
        parameters: z.object({}),
        errorFunction: null,
        execute: async () => {
          await fallbackStarted;
          throw primaryError;
        },
      }) as unknown as FunctionTool;
      const runnerEnd = vi.fn((...args: unknown[]) => {
        if (args[2] === invalidInputTool) {
          redactToolData = true;
        }
      });
      const agentEnd = vi.fn();
      runner = new Runner({ tracingDisabled: false });
      runner.on('agent_tool_end', runnerEnd);
      state._currentAgent.on('agent_tool_end', agentEnd);

      try {
        let cancelledToolSpan: Span<any> | undefined;
        const resultPromise = withRecordingTrace(async (processor) => {
          const error = await withTrace('test', () =>
            executeFunctionToolCalls(
              state._currentAgent,
              [
                {
                  toolCall: {
                    ...toolCall,
                    callId: 'invalid-call',
                    name: 'cancelled_invalid_input',
                    arguments: JSON.stringify({ value: secret }),
                  },
                  tool: invalidInputTool,
                },
                {
                  toolCall: {
                    ...toolCall,
                    callId: 'failing-call',
                    name: 'redaction_triggering_sibling_failure',
                    arguments: '{}',
                  },
                  tool: failingTool,
                },
              ],
              runner,
              state,
            ),
          ).catch((caught) => caught);
          cancelledToolSpan = getEndedFunctionSpan(
            processor,
            'cancelled_invalid_input',
          );
          return error;
        });
        await cancellationObserved;
        releaseFallback?.();

        const error = await resultPromise;
        const runnerCalls = runnerEnd.mock.calls.filter(
          ([, , endedTool]) => endedTool === invalidInputTool,
        );
        const agentCalls = agentEnd.mock.calls.filter(
          ([, endedTool]) => endedTool === invalidInputTool,
        );
        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).error).toBe(primaryError);
        expect(runnerCalls).toHaveLength(1);
        expect(runnerCalls[0]?.[3]).toBe('aborted');
        expect(agentCalls).toHaveLength(1);
        expect(agentCalls[0]?.[2]).toBe('aborted');
        expect(agentCalls[0]?.[3]).toEqual({
          toolCall: expect.objectContaining({ arguments: '' }),
        });
        expect(cancelledToolSpan?.error).toMatchObject({
          message: 'Error running tool (non-fatal)',
        });
        expect(cancelledToolSpan?.spanData.input).toBe('');
        expect(cancelledToolSpan?.spanData.output).toBe('aborted');
      } finally {
        releaseFallback?.();
        flagSpy.mockRestore();
      }
    });

    it('reserves abort-shaped nested failure ownership while cleanup drains', async () => {
      const primaryError = new Error('primary function failure');
      primaryError.name = 'AbortError';
      let wrappedPrimaryError: ToolCallError | undefined;
      const secondaryError = new Error('secondary category failure');
      let markCleanupStarted: (() => void) | undefined;
      const cleanupStarted = new Promise<void>((resolve) => {
        markCleanupStarted = resolve;
      });
      let releaseCleanup: (() => void) | undefined;
      const cleanupCanFinish = new Promise<void>((resolve) => {
        releaseCleanup = resolve;
      });

      const resultPromise = runWithSiblingCancellation([
        async (signal, reserveFailure) => {
          try {
            await runWithSiblingCancellation(
              [
                async () => {
                  throw primaryError;
                },
                async (innerSignal) => {
                  try {
                    await new Promise<void>((_resolve, reject) => {
                      innerSignal?.addEventListener(
                        'abort',
                        () => reject(innerSignal.reason),
                        { once: true },
                      );
                    });
                  } catch {
                    markCleanupStarted?.();
                    await cleanupCanFinish;
                  }
                },
              ],
              signal,
              reserveFailure,
            );
          } catch (error) {
            if (!(error instanceof Error)) {
              throw error;
            }
            wrappedPrimaryError = new ToolCallError(
              'Failed to run function tools',
              error,
            );
            throw wrappedPrimaryError;
          }
        },
        async (signal) => {
          await new Promise<void>((resolve) => {
            signal?.addEventListener('abort', () => resolve(), { once: true });
          });
          throw secondaryError;
        },
      ]);
      await cleanupStarted;
      releaseCleanup?.();

      const rejection = await resultPromise.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(rejection).toBe(wrappedPrimaryError);
      expect(wrappedPrimaryError?.error).toBe(primaryError);
    });

    it('preserves a reserved abort-shaped failure when cancellation aborts the parent', async () => {
      const primaryError = new Error('primary function failure');
      primaryError.name = 'AbortError';
      const parentReason = new Error('parent aborted during cancellation');
      const parentController = new AbortController();
      let markSiblingStarted: (() => void) | undefined;
      const siblingStarted = new Promise<void>((resolve) => {
        markSiblingStarted = resolve;
      });

      const resultPromise = runWithSiblingCancellation(
        [
          async (_signal, reserveFailure) => {
            await siblingStarted;
            reserveFailure?.();
            throw primaryError;
          },
          async (signal) => {
            markSiblingStarted?.();
            await new Promise<void>((_resolve, reject) => {
              signal?.addEventListener(
                'abort',
                () => {
                  parentController.abort(parentReason);
                  reject(signal.reason);
                },
                { once: true },
              );
            });
          },
        ],
        parentController.signal,
      );

      await expect(resultPromise).rejects.toBe(primaryError);
    });

    it('preserves undefined rejections in uncapped tools', async () => {
      const t = tool({
        name: 'undefined_error',
        description: 'rejects without an error value',
        parameters: z.object({}),
        errorFunction: null,
        execute: vi.fn(async () => {
          throw undefined;
        }),
      }) as unknown as FunctionTool;

      const error = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ).catch((caught) => caught),
      );

      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBeUndefined();
    });

    it('limits function tool concurrency and preserves output order', async () => {
      let activeCount = 0;
      let maxSeenCount = 0;
      runner = new Runner({
        tracingDisabled: true,
        toolExecution: { maxFunctionToolConcurrency: 2 },
      });
      const t = tool({
        name: 'hi',
        description: 'tracked tool',
        parameters: z.object({ value: z.number() }),
        execute: vi.fn(async ({ value }) => {
          activeCount += 1;
          maxSeenCount = Math.max(maxSeenCount, activeCount);
          try {
            await new Promise((resolve) =>
              setTimeout(resolve, value === 1 ? 30 : 1),
            );
            return `ok-${value}`;
          } finally {
            activeCount -= 1;
          }
        }),
      }) as unknown as FunctionTool;

      const res = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [1, 2, 3].map((value) => ({
            toolCall: {
              ...toolCall,
              callId: `c${value}`,
              arguments: JSON.stringify({ value }),
            },
            tool: t,
          })),
          runner,
          state,
        ),
      );

      expect(activeCount).toBe(0);
      expect(maxSeenCount).toBe(2);
      expect(
        res.map((result) => {
          expect(result.type).toBe('function_output');
          return result.type === 'function_output' ? result.output : undefined;
        }),
      ).toEqual(['ok-1', 'ok-2', 'ok-3']);
    });

    it('does not start queued function tool calls after a capped failure', async () => {
      const startedTools: string[] = [];
      runner = new Runner({
        tracingDisabled: true,
        toolExecution: { maxFunctionToolConcurrency: 1 },
      });
      const failingTool = tool({
        name: 'failing_tool',
        description: 'failing tool',
        parameters: z.object({}),
        errorFunction: null,
        execute: vi.fn(async () => {
          startedTools.push('failing_tool');
          throw new Error('boom');
        }),
      }) as unknown as FunctionTool;
      const queuedTool = tool({
        name: 'queued_tool',
        description: 'queued tool',
        parameters: z.object({}),
        execute: vi.fn(async () => {
          startedTools.push('queued_tool');
          return 'should-not-run';
        }),
      }) as unknown as FunctionTool;

      await expect(
        withTrace('test', () =>
          executeFunctionToolCalls(
            state._currentAgent,
            [
              {
                toolCall: {
                  ...toolCall,
                  name: 'failing_tool',
                  callId: 'c1',
                  arguments: '{}',
                },
                tool: failingTool,
              },
              {
                toolCall: {
                  ...toolCall,
                  name: 'queued_tool',
                  callId: 'c2',
                  arguments: '{}',
                },
                tool: queuedTool,
              },
            ],
            runner,
            state,
          ),
        ),
      ).rejects.toThrow(/Failed to run function tools/);

      expect(startedTools).toEqual(['failing_tool']);
    });

    it('reserves a capped worker failure before another worker takes queued work', async () => {
      const startedTools: string[] = [];
      let activeTools = 0;
      let markActiveToolsStarted: (() => void) | undefined;
      const activeToolsStarted = new Promise<void>((resolve) => {
        markActiveToolsStarted = resolve;
      });
      let rejectFailingTool: ((error: Error) => void) | undefined;
      const failingToolResult = new Promise<string>((_resolve, reject) => {
        rejectFailingTool = reject;
      });
      let resolveCompletingCustomData: (() => void) | undefined;
      const completingCustomDataCanFinish = new Promise<void>((resolve) => {
        resolveCompletingCustomData = resolve;
      });
      runner = new Runner({
        tracingDisabled: true,
        toolExecution: { maxFunctionToolConcurrency: 2 },
      });
      const failingTool = {
        ...tool({
          name: 'failing_tool',
          description: 'Fail after the other worker starts.',
          parameters: z.object({}),
          errorFunction: null,
          execute: vi.fn(async () => 'unused'),
        }),
        invoke: vi.fn(() => {
          startedTools.push('failing_tool');
          activeTools += 1;
          if (activeTools === 2) {
            markActiveToolsStarted?.();
          }
          return failingToolResult;
        }),
      } as unknown as FunctionTool;
      const completingTool = {
        ...tool({
          name: 'completing_tool',
          description: 'Complete while the failure propagates.',
          parameters: z.object({}),
          customDataExtractor: async () => {
            activeTools += 1;
            if (activeTools === 2) {
              markActiveToolsStarted?.();
            }
            await completingCustomDataCanFinish;
            return undefined;
          },
          execute: vi.fn(async () => 'unused'),
        }),
        invoke: vi.fn(() => {
          startedTools.push('completing_tool');
          return Promise.resolve('completed');
        }),
      } as unknown as FunctionTool;
      const queuedParser = vi.fn(() => true);
      const queuedTool = tool({
        name: 'queued_tool',
        description: 'Must remain queued after the active failure.',
        parameters: z.object({ value: z.string().refine(queuedParser) }),
        execute: vi.fn(async () => {
          startedTools.push('queued_tool');
          return 'should-not-run';
        }),
      }) as unknown as FunctionTool;

      const resultPromise = executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              name: 'failing_tool',
              callId: 'c1',
              arguments: '{}',
            },
            tool: failingTool,
          },
          {
            toolCall: {
              ...toolCall,
              name: 'completing_tool',
              callId: 'c2',
              arguments: '{}',
            },
            tool: completingTool,
          },
          {
            toolCall: {
              ...toolCall,
              name: 'queued_tool',
              callId: 'c3',
              arguments: JSON.stringify({ value: 'queued' }),
            },
            tool: queuedTool,
          },
        ],
        runner,
        state,
      );
      await activeToolsStarted;
      rejectFailingTool?.(new Error('boom'));
      resolveCompletingCustomData?.();

      await expect(resultPromise).rejects.toThrow(
        /Failed to run function tools/,
      );
      expect(startedTools).toEqual(['failing_tool', 'completing_tool']);
      expect(queuedParser).not.toHaveBeenCalled();
    });

    it('parses capped function calls when their scheduler slot starts', async () => {
      const order: string[] = [];
      let ready = false;
      runner = new Runner({
        tracingDisabled: true,
        toolExecution: { maxFunctionToolConcurrency: 1 },
      });
      const firstTool = tool({
        name: 'prepare_refinement_state',
        description: 'Prepare state for the next parser.',
        parameters: z.object({}),
        execute: vi.fn(async () => {
          order.push('execute-first');
          ready = true;
          return 'first-ok';
        }),
      }) as unknown as FunctionTool;
      const secondTool = tool({
        name: 'observe_refinement_state',
        description: 'Observe state when parsing starts.',
        parameters: z.object({
          value: z.string().refine(() => {
            order.push(`parse-second-ready-${ready}`);
            return ready;
          }),
        }),
        execute: vi.fn(async () => 'second-ok'),
      }) as unknown as FunctionTool;

      const results = await executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              name: 'prepare_refinement_state',
              callId: 'c1',
              arguments: '{}',
            },
            tool: firstTool,
          },
          {
            toolCall: {
              ...toolCall,
              name: 'observe_refinement_state',
              callId: 'c2',
              arguments: JSON.stringify({ value: 'ok' }),
            },
            tool: secondTool,
          },
        ],
        runner,
        state,
      );

      expect(order).toEqual(['execute-first', 'parse-second-ready-true']);
      expect(results).toMatchObject([
        { type: 'function_output', output: 'first-ok' },
        { type: 'function_output', output: 'second-ok' },
      ]);
    });

    it('does not parse queued function calls after a capped failure', async () => {
      const queuedRefinement = vi.fn(() => true);
      runner = new Runner({
        tracingDisabled: true,
        toolExecution: { maxFunctionToolConcurrency: 1 },
      });
      const failingTool = tool({
        name: 'fail_before_queued_parser',
        description: 'Fail before the queued parser starts.',
        parameters: z.object({}),
        errorFunction: null,
        execute: vi.fn(async () => {
          throw new Error('boom');
        }),
      }) as unknown as FunctionTool;
      const queuedTool = tool({
        name: 'queued_parser',
        description: 'Remain queued after the failure.',
        parameters: z.object({ value: z.string().refine(queuedRefinement) }),
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;

      await expect(
        executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'fail_before_queued_parser',
                callId: 'c1',
                arguments: '{}',
              },
              tool: failingTool,
            },
            {
              toolCall: {
                ...toolCall,
                name: 'queued_parser',
                callId: 'c2',
                arguments: JSON.stringify({ value: 'queued' }),
              },
              tool: queuedTool,
            },
          ],
          runner,
          state,
        ),
      ).rejects.toThrow(/Failed to run function tools/);

      expect(queuedRefinement).not.toHaveBeenCalled();
    });

    it('does not expose parentRunConfig on public tool callback details', async () => {
      const circularProvider: Record<string, unknown> = {};
      circularProvider.self = circularProvider;
      runner = new Runner({
        tracingDisabled: true,
        modelProvider: circularProvider as any,
      });

      const t = makeTool(false);
      let capturedDetails: Record<string, unknown> | undefined;
      vi.spyOn(t, 'invoke').mockImplementation(async (_ctx, _args, details) => {
        capturedDetails = details as Record<string, unknown> | undefined;
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

      expect(res[0].type).toBe('function_output');
      expect(capturedDetails).toBeDefined();
      expect(Object.keys(capturedDetails ?? {})).not.toContain(
        'parentRunConfig',
      );
      expect((capturedDetails as any)?.parentRunConfig).toBeUndefined();
      expect(
        getAgentToolParentRunConfigFromDetails(capturedDetails)?.modelProvider,
      ).toBe(circularProvider);
      expect(() => JSON.stringify(capturedDetails)).not.toThrow();
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

    it('does not invoke a tool when cancellation occurs during an input guardrail', async () => {
      const controller = new AbortController();
      let markGuardrailStarted: (() => void) | undefined;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      let releaseGuardrail: (() => void) | undefined;
      const guardrailCanFinish = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      const guardrail = defineToolInputGuardrail({
        name: 'slow_allow',
        run: async () => {
          markGuardrailStarted?.();
          await guardrailCanFinish;
          return ToolGuardrailFunctionOutputFactory.allow();
        },
      });
      const execute = vi.fn(async () => 'should-not-run');
      const t = tool({
        name: 'guarded_tool',
        description: 'tool with an asynchronous input guardrail',
        parameters: z.object({}),
        execute,
        inputGuardrails: [guardrail],
      }) as unknown as FunctionTool;

      const resultPromise = executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall, tool: t }],
        runner,
        state,
        undefined,
        undefined,
        controller.signal,
      );
      await guardrailStarted;
      controller.abort(new Error('stop during tool preparation'));
      releaseGuardrail?.();

      const result = await resultPromise;

      expect(execute).not.toHaveBeenCalled();
      expect(result[0]).toMatchObject({
        type: 'function_output',
        runItem: {
          rawItem: {
            type: 'function_call_result',
            callId: toolCall.callId,
            status: 'incomplete',
          },
        },
      });
    });

    it('does not report a rejected input guardrail after sibling cancellation', async () => {
      const primaryError = new Error('primary tool failure');
      const secondaryError = new Error('secondary input guardrail failure');
      let markGuardrailStarted: (() => void) | undefined;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      let releaseGuardrail: (() => void) | undefined;
      const guardrailCanFinish = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      let markFatalFailure: (() => void) | undefined;
      const fatalFailure = new Promise<void>((resolve) => {
        markFatalFailure = resolve;
      });
      const rejectingGuardrail = defineToolInputGuardrail({
        name: 'reject_after_cancellation',
        run: async () => {
          markGuardrailStarted?.();
          await guardrailCanFinish;
          throw secondaryError;
        },
      });
      const guardedExecute = vi.fn(async () => 'should-not-run');
      const guardedTool = tool({
        name: 'guarded_tool',
        description: 'rejects its input guardrail after cancellation',
        parameters: z.object({}),
        execute: guardedExecute,
        inputGuardrails: [rejectingGuardrail],
      }) as unknown as FunctionTool;
      const failingTool = tool({
        name: 'failing_tool',
        description: 'fails while its sibling input guardrail is pending',
        parameters: z.object({}),
        errorFunction: null,
        execute: async () => {
          await guardrailStarted;
          throw primaryError;
        },
      }) as unknown as FunctionTool;
      const end = vi.fn();
      runner = new Runner({ tracingDisabled: false });
      runner.on('agent_tool_end', end);

      let guardedToolSpan: Span<any> | undefined;
      const resultPromise = withRecordingTrace(async (processor) => {
        const error = await withTrace('test', () =>
          executeFunctionToolCalls(
            state._currentAgent,
            [
              {
                toolCall: {
                  ...toolCall,
                  callId: 'guarded-call',
                  name: 'guarded_tool',
                },
                tool: guardedTool,
              },
              {
                toolCall: {
                  ...toolCall,
                  callId: 'failing-call',
                  name: 'failing_tool',
                },
                tool: failingTool,
              },
            ],
            runner,
            state,
            undefined,
            undefined,
            undefined,
            () => markFatalFailure?.(),
          ),
        ).catch((caught) => caught);
        guardedToolSpan = getEndedFunctionSpan(processor, 'guarded_tool');
        return error;
      });
      await fatalFailure;
      releaseGuardrail?.();

      const error = await resultPromise;
      const guardedToolEndCalls = end.mock.calls.filter(
        ([, , endedTool]) => endedTool === guardedTool,
      );
      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBe(primaryError);
      expect(guardedExecute).not.toHaveBeenCalled();
      expect(guardedToolEndCalls).toHaveLength(0);
      expect(guardedToolSpan?.error).toBeNull();
    });

    it('rejects input guardrail messages for Zod output schemas without a fallback', async () => {
      const inputGuardrail = defineToolInputGuardrail({
        name: 'block_structured_tool',
        run: async () =>
          ToolGuardrailFunctionOutputFactory.rejectContent('blocked'),
      });
      const t = tool({
        name: 'structured_input_guardrail_tool',
        description: 'tool with structured output',
        parameters: z.object({}),
        outputSchema: z.object({ value: z.string() }),
        execute: vi.fn(async () => ({ value: 'should-not-run' })),
        inputGuardrails: [inputGuardrail],
      }) as unknown as FunctionTool;

      const error = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ).catch((caught) => caught),
      );

      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toMatchObject({
        message: 'blocked',
      });
    });

    it('rejects input guardrail messages for plain JSON output schemas without a fallback', async () => {
      const inputGuardrail = defineToolInputGuardrail({
        name: 'block_plain_structured_tool',
        run: async () =>
          ToolGuardrailFunctionOutputFactory.rejectContent('blocked'),
      });
      const execute = vi.fn(async () => ({ value: 'should-not-run' }));
      const t = tool({
        name: 'plain_structured_input_guardrail_tool',
        description: 'tool with a plain JSON output schema',
        parameters: z.object({}),
        outputSchema: {
          type: 'object',
          properties: { value: { type: 'string' } },
          required: ['value'],
          additionalProperties: false,
        },
        execute,
        inputGuardrails: [inputGuardrail],
      }) as unknown as FunctionTool;

      const error = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ).catch((caught) => caught),
      );

      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toMatchObject({
        message: 'blocked',
      });
      expect(execute).not.toHaveBeenCalled();
    });

    it('maps input guardrail rejection through a structured error fallback', async () => {
      const errorFunction = vi.fn(() => ({ value: 'blocked' }));
      const inputGuardrail = defineToolInputGuardrail({
        name: 'map_structured_rejection',
        run: async () =>
          ToolGuardrailFunctionOutputFactory.rejectContent('blocked'),
      });
      const t = tool({
        name: 'structured_input_guardrail_fallback_tool',
        description: 'tool with structured output',
        parameters: z.object({}),
        outputSchema: z.object({ value: z.string() }),
        errorFunction,
        execute: vi.fn(async () => ({ value: 'should-not-run' })),
        inputGuardrails: [inputGuardrail],
      }) as unknown as FunctionTool;

      const result = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      expect(result[0]).toMatchObject({
        type: 'function_output',
        output: { value: 'blocked' },
        runItem: {
          rawItem: {
            output: {
              type: 'text',
              text: JSON.stringify({ value: 'blocked' }),
            },
          },
        },
      });
      expect(errorFunction).toHaveBeenCalledWith(
        state._context,
        expect.objectContaining({ message: 'blocked' }),
        { toolCall },
      );
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

    it('does not start prepared-input guardrails after approval aborts', async () => {
      const controller = new AbortController();
      const abortReason = new Error('approval aborted');
      const inputGuardrail = defineToolInputGuardrail({
        name: 'should_not_run',
        run: vi.fn(async () => ToolGuardrailFunctionOutputFactory.allow()),
      });
      const execute = vi.fn(async () => 'unexpected');
      const preparedInputTool = tool({
        name: 'prepared_input_tool',
        description: 'has schema-invalid prepared input',
        parameters: z.object({ value: z.number() }),
        inputGuardrails: [inputGuardrail],
        execute,
      }) as unknown as FunctionTool;
      const approvalSpy = vi
        .spyOn(state._context, 'isToolApproved')
        .mockImplementation(({ callId }) => {
          if (callId === 'prepared-input-call') {
            controller.abort(abortReason);
          }
          return true;
        });

      try {
        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                callId: 'prepared-input-call',
                name: 'prepared_input_tool',
                arguments: JSON.stringify({ value: 'invalid' }),
              },
              tool: preparedInputTool,
            },
          ],
          runner,
          state,
          undefined,
          undefined,
          controller.signal,
        );

        expect(controller.signal.reason).toBe(abortReason);
        expect(result).toMatchObject({
          type: 'function_output',
          output: 'aborted',
        });
        expect(inputGuardrail.run).not.toHaveBeenCalled();
        expect(execute).not.toHaveBeenCalled();
      } finally {
        approvalSpy.mockRestore();
      }
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

    it('rejects guardrail replacements that violate a Zod output schema', async () => {
      const outputGuardrail = defineToolOutputGuardrail({
        name: 'replace_structured_output',
        run: async () =>
          ToolGuardrailFunctionOutputFactory.rejectContent('redacted'),
      });
      const t = tool({
        name: 'structured_output_guardrail_tool',
        description: 'tool with structured output',
        parameters: z.object({}),
        outputSchema: z.object({ value: z.string() }),
        execute: vi.fn(async () => ({ value: 'ok' })),
        outputGuardrails: [outputGuardrail],
      }) as unknown as FunctionTool;

      const error = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ).catch((caught) => caught),
      );

      expect(error).toBeInstanceOf(ToolCallError);
      expect((error as ToolCallError).error).toBeInstanceOf(
        InvalidToolOutputError,
      );
    });

    it('does not validate Zod outputs twice in the runner', async () => {
      let validationCount = 0;
      const t = tool({
        name: 'structured_validation_tool',
        description: 'tool with a runtime output schema',
        parameters: z.object({}),
        outputSchema: z.object({
          value: z.string().refine(() => {
            validationCount += 1;
            return true;
          }),
        }),
        execute: vi.fn(async () => ({ value: 'ok' })),
      }) as unknown as FunctionTool;

      const result = await withTrace('test', () =>
        executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall, tool: t }],
          runner,
          state,
        ),
      );

      expect(result[0]).toMatchObject({
        type: 'function_output',
        output: { value: 'ok' },
      });
      expect(validationCount).toBe(1);
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

    it('redacts malformed JSON from the default model-visible output', async () => {
      // Reproduces issue #723: SyntaxError stops agent when LLM generates invalid JSON
      const secret = 'SECRET_RUNNER_MALFORMED_ARGUMENT_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
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
        arguments: secret,
      };

      try {
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
          expect(firstResult.output).toBe(
            'An error occurred while parsing tool arguments. Please try again with valid JSON.',
          );
          expect(JSON.stringify(firstResult.runItem.rawItem)).not.toContain(
            secret,
          );
        }
        expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(secret);
      } finally {
        debugSpy.mockRestore();
        flagSpy.mockRestore();
      }
    });

    it('preserves malformed JSON details in diagnostic mode', async () => {
      const secret = 'SECRT123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(false);
      const t = tool({
        name: 'diagnostic_parser',
        description: 'Parse diagnostic input.',
        parameters: z.object({ value: z.string() }),
        execute: vi.fn(async () => 'success'),
      }) as unknown as FunctionTool;
      const invalidToolCall = {
        ...toolCall,
        name: 'diagnostic_parser',
        arguments: secret,
      };

      try {
        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall: invalidToolCall, tool: t }],
          runner,
          state,
        );

        expect(result.type).toBe('function_output');
        if (result.type === 'function_output') {
          expect(String(result.output)).toContain(secret);
        }
      } finally {
        flagSpy.mockRestore();
      }
    });

    it.each([
      ['redacted', true],
      ['diagnostic', false],
    ] as const)(
      'maps %s parse failures through a structured error fallback',
      async (_mode, dontLogToolData) => {
        const secret = 'SECRET_STRUCTURED_PARSE_ARGUMENT_123';
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockReturnValue(dontLogToolData);
        const errorFunction = vi.fn(
          (
            _context: RunContext,
            _error: unknown,
            details?: ToolCallDetails,
          ) => ({
            status: 'invalid_input' as const,
            detail: details?.toolCall?.arguments ?? 'redacted',
          }),
        );
        const t = tool({
          name: 'structured_parser',
          description: 'Parse structured input.',
          parameters: z.object({ value: z.string() }),
          outputSchema: z.object({
            status: z.literal('invalid_input'),
            detail: z.string(),
          }),
          errorFunction,
          execute: vi.fn(async () => ({
            status: 'invalid_input' as const,
            detail: 'unexpected',
          })),
        }) as unknown as FunctionTool;
        const invalidToolCall = {
          ...toolCall,
          name: 'structured_parser',
          arguments: secret,
        };

        try {
          const res = await withTrace('test', () =>
            executeFunctionToolCalls(
              state._currentAgent,
              [{ toolCall: invalidToolCall, tool: t }],
              runner,
              state,
            ),
          );

          expect(res[0]).toMatchObject({
            type: 'function_output',
            output: {
              status: 'invalid_input',
              detail: dontLogToolData ? 'redacted' : secret,
            },
            runItem: {
              rawItem: {
                output: {
                  type: 'text',
                  text: JSON.stringify({
                    status: 'invalid_input',
                    detail: dontLogToolData ? 'redacted' : secret,
                  }),
                },
              },
            },
          });
          expect(errorFunction).toHaveBeenCalledWith(
            state._context,
            expect.objectContaining({
              name: 'InvalidToolInputError',
              originalError: dontLogToolData ? undefined : expect.anything(),
              toolInvocation: dontLogToolData
                ? undefined
                : expect.objectContaining({ input: secret }),
            }),
            dontLogToolData ? undefined : { toolCall: invalidToolCall },
          );
          const capturedError = errorFunction.mock.calls[0][1] as
            InvalidToolInputError | undefined;
          expect(capturedError).toBeDefined();
          if (dontLogToolData) {
            expect(capturedError?.toolInvocation).toBeUndefined();
            expect(errorFunction.mock.calls[0][2]).toBeUndefined();
            expect(JSON.stringify(res[0])).not.toContain(secret);
          } else {
            expect(capturedError?.toolInvocation).toMatchObject({
              input: secret,
            });
            expect(errorFunction.mock.calls[0][2]).toEqual({
              toolCall: invalidToolCall,
            });
          }
        } finally {
          flagSpy.mockRestore();
        }
      },
    );

    it('preserves errorFunction null for runner-detected schema failures', async () => {
      const secret = 'SECRET_NULL_SCHEMA_ARGUMENT_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const execute = vi.fn(async () => 'unexpected');
      const t = tool({
        name: 'null_schema_parser',
        description: 'Reject schema input without a fallback.',
        parameters: z.object({ value: z.number() }),
        errorFunction: null,
        execute,
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'null_schema_parser',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(execute).not.toHaveBeenCalled();
        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).error).toBeInstanceOf(
          InvalidToolInputError,
        );
        expect((error as ToolCallError).state).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it.each([
      ['redacted', true],
      ['diagnostic', false],
    ] as const)(
      'maps %s schema failures through an unstructured error fallback',
      async (_mode, dontLogToolData) => {
        const secret = 'SECRET_UNSTRUCTURED_SCHEMA_ARGUMENT_123';
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockReturnValue(dontLogToolData);
        const execute = vi.fn(async () => 'unexpected');
        const errorFunction = vi.fn(
          (_context: RunContext, _error: unknown, details?: ToolCallDetails) =>
            `custom fallback: ${details?.toolCall?.arguments ?? 'redacted'}`,
        );
        const t = tool({
          name: 'unstructured_schema_parser',
          description: 'Parse schema input with an unstructured fallback.',
          parameters: z.object({ value: z.number() }),
          errorFunction,
          execute,
        }) as unknown as FunctionTool;
        const invalidToolCall = {
          ...toolCall,
          name: 'unstructured_schema_parser',
          arguments: JSON.stringify({ value: secret }),
        };

        try {
          const [result] = await executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall: invalidToolCall, tool: t }],
            runner,
            state,
          );

          expect(execute).not.toHaveBeenCalled();
          expect(result).toMatchObject({
            type: 'function_output',
            output: `custom fallback: ${
              dontLogToolData ? 'redacted' : invalidToolCall.arguments
            }`,
          });
          expect(errorFunction).toHaveBeenCalledWith(
            state._context,
            expect.objectContaining({
              name: 'InvalidToolInputError',
              message: 'Invalid JSON input for tool',
              state: undefined,
              originalError: dontLogToolData ? undefined : expect.anything(),
              toolInvocation: dontLogToolData
                ? undefined
                : expect.objectContaining({
                    input: invalidToolCall.arguments,
                    details: expect.objectContaining({
                      toolCall: invalidToolCall,
                    }),
                  }),
            }),
            dontLogToolData
              ? undefined
              : expect.objectContaining({ toolCall: invalidToolCall }),
          );
          if (dontLogToolData) {
            expect(JSON.stringify(result)).not.toContain(secret);
          }
        } finally {
          flagSpy.mockRestore();
        }
      },
    );

    it('preserves the default factory fallback for schema failures', async () => {
      const [result] = await executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              name: 'default_schema_fallback',
              arguments: JSON.stringify({ value: 'invalid' }),
            },
            tool: tool({
              name: 'default_schema_fallback',
              description: 'Use the default schema failure fallback.',
              parameters: z.object({ value: z.number() }),
              execute: vi.fn(async () => 'unexpected'),
            }) as unknown as FunctionTool,
          },
        ],
        runner,
        state,
      );

      expect(result).toMatchObject({
        type: 'function_output',
        output:
          'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool',
      });
    });

    it('keeps schema failure fallbacks inside the tool lifecycle', async () => {
      const secret = 'SECRET_SCHEMA_LIFECYCLE_ARGUMENT_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const start = vi.fn();
      const end = vi.fn();
      const outputGuardrail = vi.fn(async () =>
        ToolGuardrailFunctionOutputFactory.allow(),
      );
      const customDataExtractor = vi.fn(
        (context: FunctionToolCustomDataContext) => ({
          inputRedacted: typeof context.input === 'undefined',
        }),
      );
      const t = tool({
        name: 'schema_failure_lifecycle',
        description: 'Keep schema fallbacks in the normal lifecycle.',
        parameters: z.object({ value: z.number() }),
        errorFunction: () => 'safe fallback',
        outputGuardrails: [
          {
            name: 'observe_fallback',
            run: outputGuardrail,
          },
        ],
        customDataExtractor,
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const invalidToolCall = {
        ...toolCall,
        name: 'schema_failure_lifecycle',
        arguments: JSON.stringify({ value: secret }),
      };
      runner.on('agent_tool_start', start);
      runner.on('agent_tool_end', end);

      try {
        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall: invalidToolCall, tool: t }],
          runner,
          state,
        );

        expect(result).toMatchObject({
          type: 'function_output',
          output: 'safe fallback',
          runItem: { customData: { inputRedacted: true } },
        });
        expect(outputGuardrail).toHaveBeenCalledTimes(1);
        expect(customDataExtractor).toHaveBeenCalledWith(
          expect.objectContaining({
            input: undefined,
            output: 'safe fallback',
          }),
        );
        expect(start).toHaveBeenCalledTimes(1);
        expect(end).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('keeps the classification-time redaction policy across awaits', async () => {
      const secret = 'SECRET_SCHEMA_POLICY_SNAPSHOT_123';
      let redactToolData = true;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
      const errorFunction = vi.fn(() => 'safe fallback');
      const t = tool({
        name: 'schema_policy_snapshot',
        description: 'Keep the classification-time redaction policy.',
        parameters: z.object({ value: z.number() }),
        errorFunction,
        inputGuardrails: [
          {
            name: 'change_policy_after_classification',
            run: async () => {
              redactToolData = false;
              return ToolGuardrailFunctionOutputFactory.allow();
            },
          },
        ],
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;

      try {
        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'schema_policy_snapshot',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          runner,
          state,
        );

        expect(result).toMatchObject({
          type: 'function_output',
          output: 'safe fallback',
        });
        expect(errorFunction).toHaveBeenCalledWith(
          state._context,
          expect.objectContaining({
            message: 'Invalid JSON input for tool',
            originalError: undefined,
            toolInvocation: undefined,
          }),
          undefined,
        );
        expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(secret);
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        debugSpy.mockRestore();
        flagSpy.mockRestore();
      }
    });

    it('promotes prepared failure redaction when secure mode is enabled after classification', async () => {
      const secret = 'SECRET_SCHEMA_POLICY_PROMOTION_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const errorFunction = vi.fn(() => 'safe fallback');
      const customDataExtractor = vi.fn(
        (context: FunctionToolCustomDataContext) => ({
          inputRedacted: typeof context.input === 'undefined',
        }),
      );
      const t = tool({
        name: 'schema_policy_promotion',
        description: 'Promote redaction after classification.',
        parameters: z.object({ value: z.number() }),
        errorFunction,
        inputGuardrails: [
          {
            name: 'enable_secure_mode',
            run: async () => {
              redactToolData = true;
              return ToolGuardrailFunctionOutputFactory.allow();
            },
          },
        ],
        customDataExtractor,
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const invalidToolCall = {
        ...toolCall,
        name: 'schema_policy_promotion',
        arguments: JSON.stringify({ value: secret }),
      };

      try {
        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [{ toolCall: invalidToolCall, tool: t }],
          runner,
          state,
        );

        expect(errorFunction).toHaveBeenCalledWith(
          state._context,
          expect.objectContaining({
            message: 'Invalid JSON input for tool',
            originalError: undefined,
            toolInvocation: undefined,
          }),
          undefined,
        );
        expect(customDataExtractor).toHaveBeenCalledWith(
          expect.objectContaining({
            input: undefined,
            output: 'safe fallback',
          }),
        );
        expect(result).toMatchObject({
          type: 'function_output',
          runItem: { customData: { inputRedacted: true } },
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it.each([
      ['malformed JSON', 'SECRET_LATE_MALFORMED_ERROR_FUNCTION_123'],
      [
        'schema validation',
        JSON.stringify({ value: 'SECRET_LATE_SCHEMA_ERROR_FUNCTION_123' }),
      ],
    ])(
      'discards %s fallback output when errorFunction enables secure mode',
      async (_label, input) => {
        let redactToolData = false;
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockImplementation(() => redactToolData);
        const errorFunction = vi.fn(
          (
            _context: RunContext,
            _error: unknown,
            details?: ToolCallDetails,
          ) => {
            redactToolData = true;
            return {
              status: details?.toolCall?.arguments ?? input,
            };
          },
        );
        const t = tool({
          name: 'late_error_function_redaction',
          description: 'Promote redaction while building a fallback.',
          parameters: z.object({ value: z.number() }),
          outputSchema: z.object({ status: z.string() }),
          errorFunction,
          execute: vi.fn(async () => ({ status: 'unexpected' })),
        }) as unknown as FunctionTool;

        try {
          const error = await executeFunctionToolCalls(
            state._currentAgent,
            [
              {
                toolCall: {
                  ...toolCall,
                  name: 'late_error_function_redaction',
                  arguments: input,
                },
                tool: t,
              },
            ],
            runner,
            state,
          ).catch((caught) => caught);

          expect(errorFunction).toHaveBeenCalledOnce();
          expect(error).toBeInstanceOf(ToolCallError);
          expect((error as ToolCallError).state).toBeUndefined();
          expect(JSON.stringify(error)).not.toContain(input);
        } finally {
          flagSpy.mockRestore();
        }
      },
    );

    it('clears malformed-input trace data after errorFunction enables secure mode', async () => {
      const secret = 'SECRET_LATE_MALFORMED_TRACE_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const t = tool({
        name: 'late_malformed_trace_redaction',
        description: 'Promote redaction while building a fallback.',
        parameters: z.object({ value: z.number() }),
        outputSchema: z.object({ status: z.string() }),
        errorFunction: (_context, _error, details) => {
          redactToolData = true;
          return { status: details?.toolCall?.arguments ?? secret };
        },
        execute: vi.fn(async () => ({ status: 'unexpected' })),
      }) as unknown as FunctionTool;

      try {
        await withRecordingTrace(async (processor) => {
          const error = await withTrace('test', () =>
            executeFunctionToolCalls(
              state._currentAgent,
              [
                {
                  toolCall: {
                    ...toolCall,
                    name: 'late_malformed_trace_redaction',
                    arguments: secret,
                  },
                  tool: t,
                },
              ],
              new Runner({
                tracingDisabled: false,
                traceIncludeSensitiveData: true,
              }),
              state,
            ).catch((caught) => caught),
          );

          expect(error).toBeInstanceOf(ToolCallError);
          const functionSpan = getEndedFunctionSpan(
            processor,
            'late_malformed_trace_redaction',
          );
          expect(JSON.stringify(functionSpan.toJSON())).not.toContain(secret);
          expect(JSON.stringify(error)).not.toContain(secret);
        });
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('discards custom data when its extractor enables secure mode', async () => {
      const secret = 'SECRET_LATE_CUSTOM_DATA_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const t = tool({
        name: 'late_custom_data_redaction',
        description: 'Promote redaction while extracting custom data.',
        parameters: z.object({ value: z.number() }),
        errorFunction: () => 'diagnostic fallback',
        customDataExtractor: (context) => {
          redactToolData = true;
          return { captured: context.input };
        },
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'late_custom_data_redaction',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).state).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('discards output guardrail artifacts when secure mode is enabled', async () => {
      const secret = 'SECRET_LATE_OUTPUT_GUARDRAIL_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const t = tool({
        name: 'late_output_guardrail_redaction',
        description: 'Promote redaction in an output guardrail.',
        parameters: z.object({ value: z.number() }),
        errorFunction: () => 'diagnostic fallback',
        outputGuardrails: [
          {
            name: 'enable_secure_mode',
            run: async ({ toolCall: callbackToolCall }) => {
              redactToolData = true;
              return ToolGuardrailFunctionOutputFactory.rejectContent(
                callbackToolCall.arguments,
              );
            },
          },
        ],
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'late_output_guardrail_redaction',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).state).toBeUndefined();
        expect(state._toolOutputGuardrailResults).toHaveLength(0);
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('preserves SDK guardrail tripwires for already-redacted invalid input', async () => {
      const secret = 'SECRET_REDACTED_GUARDRAIL_TRIPWIRE_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const t = tool({
        name: 'redacted_guardrail_tripwire',
        description: 'Preserve the SDK guardrail failure type.',
        parameters: z.object({ value: z.number() }),
        inputGuardrails: [
          {
            name: 'tripwire',
            run: async () =>
              ToolGuardrailFunctionOutputFactory.throwException(),
          },
        ],
        errorFunction: () => 'unexpected',
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'redacted_guardrail_tripwire',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).state).toBeUndefined();
        expect((error as ToolCallError).error).toBeInstanceOf(
          ToolInputGuardrailTripwireTriggered,
        );
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it.each([
      ['secure from start', true],
      ['promoted in hook', false],
    ] as const)(
      'redacts arbitrary end-hook failures when %s',
      async (_mode, initiallyRedacted) => {
        const secret = 'SECRET_END_HOOK_THROW_123';
        let redactToolData = initiallyRedacted;
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockImplementation(() => redactToolData);
        const thrownValues = [
          new Error(secret),
          secret,
          (() => {
            const { proxy, revoke } = Proxy.revocable({}, {});
            revoke();
            return proxy;
          })(),
        ];
        const t = tool({
          name: 'redacted_end_hook_failure',
          description: 'Redact arbitrary end-hook failures.',
          parameters: z.object({ value: z.number() }),
          errorFunction: () => 'safe fallback',
          execute: vi.fn(async () => 'unexpected'),
        }) as unknown as FunctionTool;
        let currentThrown: unknown;
        runner.on('agent_tool_end', () => {
          redactToolData = true;
          throw currentThrown;
        });

        try {
          for (let index = 0; index < thrownValues.length; index += 1) {
            redactToolData = initiallyRedacted;
            currentThrown = thrownValues[index];
            const error = await executeFunctionToolCalls(
              state._currentAgent,
              [
                {
                  toolCall: {
                    ...toolCall,
                    callId: `redacted_end_hook_${index}`,
                    name: 'redacted_end_hook_failure',
                    arguments: JSON.stringify({ value: secret }),
                  },
                  tool: t,
                },
              ],
              runner,
              state,
            ).catch((caught) => caught);

            expect(error).toBeInstanceOf(ToolCallError);
            expect((error as ToolCallError).state).toBeUndefined();
            expect((error as ToolCallError).error).toBeInstanceOf(
              InvalidToolInputError,
            );
            expect(JSON.stringify(error)).not.toContain(secret);
          }
        } finally {
          flagSpy.mockRestore();
        }
      },
    );

    it('redacts invalid arguments from later hooks after policy promotion', async () => {
      const secret = 'SECRET_LATE_HOOK_ARGUMENT_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const agentHook = vi.fn();
      const t = tool({
        name: 'late_hook_redaction',
        description: 'Promote redaction between tool hooks.',
        parameters: z.object({ value: z.number() }),
        errorFunction: () => 'safe fallback',
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      runner.on('agent_tool_start', () => {
        redactToolData = true;
      });
      state._currentAgent.on('agent_tool_start', agentHook);

      try {
        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'late_hook_redaction',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          runner,
          state,
        );

        expect(agentHook).toHaveBeenCalledWith(
          state._context,
          t,
          expect.objectContaining({
            toolCall: expect.objectContaining({ arguments: '' }),
          }),
        );
        expect(result).toMatchObject({
          type: 'function_output',
          output: 'safe fallback',
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('promotes redaction before a pre-approval guardrail fallback', async () => {
      const secret = 'SECRET_PREAPPROVAL_POLICY_PROMOTION_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const errorFunction = vi.fn(() => ({ status: 'blocked' as const }));
      const t = tool({
        name: 'preapproval_policy_promotion',
        description: 'Promote redaction before approval fallback.',
        parameters: z.object({ value: z.number() }),
        outputSchema: z.object({ status: z.literal('blocked') }),
        needsApproval: async () => true,
        inputGuardrails: [
          {
            name: 'enable_secure_mode_and_reject',
            run: async () => {
              redactToolData = true;
              return ToolGuardrailFunctionOutputFactory.rejectContent(secret);
            },
          },
        ],
        errorFunction,
        execute: vi.fn(async () => ({ status: 'blocked' as const })),
      }) as unknown as FunctionTool;
      const customRunner = new Runner({
        tracingDisabled: true,
        toolExecution: { preApprovalInputGuardrails: true },
      });

      try {
        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'preapproval_policy_promotion',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          customRunner,
          state,
        );

        expect(errorFunction).toHaveBeenCalledWith(
          state._context,
          expect.objectContaining({
            message:
              "Invalid input for function tool 'preapproval_policy_promotion'.",
          }),
          undefined,
        );
        expect(result).toMatchObject({
          type: 'function_output',
          output: { status: 'blocked' },
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('redacts a pre-approval guardrail tripwire after policy promotion', async () => {
      const secret = 'SECRET_PREAPPROVAL_TRIPWIRE_PROMOTION_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const debugSpy = vi.spyOn(logger, 'debug');
      const t = tool({
        name: 'preapproval_tripwire_policy_promotion',
        description: 'Promote redaction before a guardrail tripwire.',
        parameters: z.object({ value: z.number() }),
        needsApproval: async () => true,
        inputGuardrails: [
          {
            name: 'enable_secure_mode_and_throw',
            run: async ({ toolCall: callbackToolCall }) => {
              redactToolData = true;
              return ToolGuardrailFunctionOutputFactory.throwException({
                captured: callbackToolCall.arguments,
              });
            },
          },
        ],
        errorFunction: () => 'unexpected',
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const customRunner = new Runner({
        tracingDisabled: true,
        toolExecution: { preApprovalInputGuardrails: true },
      });

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'preapproval_tripwire_policy_promotion',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          customRunner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).state).toBeUndefined();
        expect((error as ToolCallError).error).toBeInstanceOf(
          InvalidToolInputError,
        );
        expect((error as ToolCallError).error).toMatchObject({
          message:
            "Invalid input for function tool 'preapproval_tripwire_policy_promotion'.",
        });
        expect(state._toolInputGuardrailResults).toHaveLength(0);
        expect(JSON.stringify(error)).not.toContain(secret);
        expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(secret);
      } finally {
        debugSpy.mockRestore();
        flagSpy.mockRestore();
      }
    });

    it('promotes malformed-input redaction before a pre-approval fallback', async () => {
      const secret = 'SECRET_MALFORMED_POLICY_PROMOTION_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const errorFunction = vi.fn(() => ({ status: 'blocked' as const }));
      const t = tool({
        name: 'malformed_policy_promotion',
        description: 'Promote malformed-input redaction before fallback.',
        parameters: z.object({ value: z.number() }),
        outputSchema: z.object({ status: z.literal('blocked') }),
        needsApproval: async () => true,
        inputGuardrails: [
          {
            name: 'enable_secure_mode_and_reject',
            run: async () => {
              redactToolData = true;
              return ToolGuardrailFunctionOutputFactory.rejectContent(secret);
            },
          },
        ],
        errorFunction,
        execute: vi.fn(async () => ({ status: 'blocked' as const })),
      }) as unknown as FunctionTool;
      const customRunner = new Runner({
        tracingDisabled: true,
        toolExecution: { preApprovalInputGuardrails: true },
      });

      try {
        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'malformed_policy_promotion',
                arguments: secret,
              },
              tool: t,
            },
          ],
          customRunner,
          state,
        );

        expect(errorFunction).toHaveBeenCalledWith(
          state._context,
          expect.objectContaining({
            message:
              "Invalid input for function tool 'malformed_policy_promotion'.",
          }),
          undefined,
        );
        expect(result).toMatchObject({
          type: 'function_output',
          output: { status: 'blocked' },
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('rechecks redaction after an async approval error formatter', async () => {
      const secret = 'SECRET_FORMATTER_POLICY_PROMOTION_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const errorFunction = vi.fn(() => ({ status: 'rejected' as const }));
      const t = tool({
        name: 'formatter_policy_promotion',
        description: 'Promote redaction in the approval formatter.',
        parameters: z.object({ value: z.number() }),
        outputSchema: z.object({ status: z.literal('rejected') }),
        errorFunction,
        execute: vi.fn(async () => ({ status: 'rejected' as const })),
      }) as unknown as FunctionTool;
      const customRunner = new Runner({
        tracingDisabled: true,
        toolErrorFormatter: async () => {
          redactToolData = true;
          return secret;
        },
      });
      vi.spyOn(state._context, 'isToolApproved').mockReturnValue(false as any);

      try {
        const [result] = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'formatter_policy_promotion',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: t,
            },
          ],
          customRunner,
          state,
          customRunner.config.toolErrorFormatter,
        );

        expect(errorFunction).toHaveBeenCalledWith(
          state._context,
          expect.objectContaining({
            message:
              "Invalid input for function tool 'formatter_policy_promotion'.",
          }),
          undefined,
        );
        expect(result).toMatchObject({
          type: 'function_output',
          output: { status: 'rejected' },
        });
        expect(JSON.stringify(result)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('removes batch state after redaction is promoted during a sibling run', async () => {
      const secret = 'SECRET_SIBLING_POLICY_PROMOTION_123';
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      let releaseSibling = () => {};
      const policyPromoted = new Promise<void>((resolve) => {
        releaseSibling = resolve;
      });
      const invalidInputTool = tool({
        name: 'sibling_policy_promotion',
        description: 'Promote redaction before a sibling failure.',
        parameters: z.object({ value: z.number() }),
        inputGuardrails: [
          {
            name: 'enable_secure_mode',
            run: async () => {
              redactToolData = true;
              releaseSibling();
              return ToolGuardrailFunctionOutputFactory.allow();
            },
          },
        ],
        errorFunction: () => 'safe fallback',
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const failingTool = tool({
        name: 'promoted_policy_sibling_failure',
        description: 'Fail after secure mode is enabled.',
        parameters: z.object({}),
        errorFunction: null,
        execute: vi.fn(async () => {
          await policyPromoted;
          throw new Error('sibling failed');
        }),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'sibling_policy_promotion',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: invalidInputTool,
            },
            {
              toolCall: {
                ...toolCall,
                callId: 'c2',
                name: 'promoted_policy_sibling_failure',
                arguments: '{}',
              },
              tool: failingTool,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).state).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        releaseSibling();
        flagSpy.mockRestore();
      }
    });

    it('applies tool timeouts to schema failure fallbacks', async () => {
      let redactToolData = false;
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockImplementation(() => redactToolData);
      const t = tool({
        name: 'schema_failure_timeout',
        description: 'Time out a schema failure fallback.',
        parameters: z.object({ value: z.number() }),
        inputGuardrails: [
          {
            name: 'enable_secure_mode',
            run: async () => {
              redactToolData = true;
              return ToolGuardrailFunctionOutputFactory.allow();
            },
          },
        ],
        errorFunction: async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return 'late fallback';
        },
        timeoutMs: 5,
        timeoutBehavior: 'raise_exception',
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'schema_failure_timeout',
                arguments: JSON.stringify({ value: 'invalid' }),
              },
              tool: t,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolTimeoutError);
        expect((error as ToolTimeoutError).state).toBeUndefined();
      } finally {
        flagSpy.mockRestore();
      }
    });

    it.each([
      ['malformed JSON', 'throw', 'SECRET_CALLBACK_THROW_MALFORMED_123'],
      [
        'schema validation',
        'throw',
        JSON.stringify({ value: 'SECRET_CALLBACK_THROW_SCHEMA_123' }),
      ],
      ['malformed JSON', 'invalid', 'SECRET_INVALID_FALLBACK_MALFORMED_123'],
      [
        'schema validation',
        'invalid',
        JSON.stringify({ value: 'SECRET_INVALID_FALLBACK_SCHEMA_123' }),
      ],
    ] as const)(
      'uses a fixed error when redacted %s uses a %s fallback',
      async (_inputKind, failureMode, secret) => {
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockReturnValue(true);
        const errorFunction = vi.fn(
          (
            _context: RunContext,
            _error: unknown,
            details?: ToolCallDetails,
          ) => {
            expect(details).toBeUndefined();
            if (failureMode === 'throw') {
              throw new Error('fallback failed');
            }
            return { status: 'invalid' } as any;
          },
        );
        const t = tool({
          name: 'failing_structured_fallback',
          description: 'Fail while handling invalid arguments.',
          parameters: z.object({ value: z.number() }),
          outputSchema: z.object({ status: z.literal('valid') }),
          errorFunction,
          timeoutMs: 1_000,
          execute: vi.fn(async () => ({ status: 'valid' as const })),
        }) as unknown as FunctionTool;
        const invalidToolCall = {
          ...toolCall,
          name: 'failing_structured_fallback',
          arguments: secret,
        };

        try {
          const error = await executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall: invalidToolCall, tool: t }],
            runner,
            state,
          ).catch((caught) => caught);

          expect(error).toBeInstanceOf(ToolCallError);
          expect((error as ToolCallError).state).toBeUndefined();
          expect((error as ToolCallError).error).toBeInstanceOf(
            InvalidToolInputError,
          );
          expect((error as ToolCallError).error).toMatchObject({
            message:
              "Invalid input for function tool 'failing_structured_fallback'.",
            originalError: undefined,
            toolInvocation: undefined,
          });
          expect(JSON.stringify(error)).not.toContain(secret);
        } finally {
          flagSpy.mockRestore();
        }
      },
    );

    it.each([
      ['redacted', true, 'SECRET_REJECTED_MALFORMED_123'],
      [
        'redacted schema',
        true,
        JSON.stringify({ value: 'SECRET_REJECTED_SCHEMA_123' }),
      ],
      ['diagnostic', false, 'SECRET_REJECTED_DIAGNOSTIC_MALFORMED_123'],
      [
        'diagnostic schema',
        false,
        JSON.stringify({ value: 'SECRET_REJECTED_DIAGNOSTIC_SCHEMA_123' }),
      ],
    ] as const)(
      'applies %s details policy to rejected invalid input',
      async (_mode, dontLogToolData, input) => {
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockReturnValue(dontLogToolData);
        const approvalSpy = vi
          .spyOn(state._context, 'isToolApproved')
          .mockReturnValue(false as any);
        const errorFunction = vi.fn(
          (
            _context: RunContext,
            _error: unknown,
            details?: ToolCallDetails,
          ) => ({
            status: 'rejected' as const,
            detail: details?.toolCall?.arguments ?? 'redacted',
          }),
        );
        const t = tool({
          name: 'rejected_invalid_input',
          description: 'Reject invalid input.',
          parameters: z.object({ value: z.number() }),
          outputSchema: z.object({
            status: z.literal('rejected'),
            detail: z.string(),
          }),
          needsApproval: async () => true,
          errorFunction,
          execute: vi.fn(async () => ({
            status: 'rejected' as const,
            detail: 'unexpected',
          })),
        }) as unknown as FunctionTool;
        const invalidToolCall = {
          ...toolCall,
          name: 'rejected_invalid_input',
          arguments: input,
        };

        try {
          const [result] = await executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall: invalidToolCall, tool: t }],
            runner,
            state,
          );

          expect(errorFunction.mock.calls[0][2]).toEqual(
            dontLogToolData ? undefined : { toolCall: invalidToolCall },
          );
          expect(result).toMatchObject({
            type: 'function_output',
            output: {
              status: 'rejected',
              detail: dontLogToolData ? 'redacted' : input,
            },
          });
          if (dontLogToolData) {
            expect(JSON.stringify(result)).not.toContain(input);
          }
        } finally {
          approvalSpy.mockRestore();
          flagSpy.mockRestore();
        }
      },
    );

    it.each([
      ['throwing callback', 'throw'],
      ['invalid fallback', 'invalid'],
    ] as const)(
      'preserves diagnostic state for a %s after a parse failure',
      async (_label, failureMode) => {
        const secret = `SECRET_DIAGNOSTIC_${failureMode.toUpperCase()}_123`;
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockReturnValue(false);
        const errorFunction = vi.fn(
          (
            _context: RunContext,
            _error: unknown,
            _details?: ToolCallDetails,
          ) => {
            if (failureMode === 'throw') {
              throw new Error('diagnostic fallback failed');
            }
            return { status: 'invalid' } as any;
          },
        );
        const t = tool({
          name: 'diagnostic_failing_fallback',
          description: 'Preserve diagnostic failure context.',
          parameters: z.object({ value: z.number() }),
          outputSchema: z.object({ status: z.literal('valid') }),
          errorFunction,
          execute: vi.fn(async () => ({ status: 'valid' as const })),
        }) as unknown as FunctionTool;
        const invalidToolCall = {
          ...toolCall,
          name: 'diagnostic_failing_fallback',
          arguments: secret,
        };

        try {
          const error = await executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall: invalidToolCall, tool: t }],
            runner,
            state,
          ).catch((caught) => caught);

          expect(error).toBeInstanceOf(ToolCallError);
          expect((error as ToolCallError).state).toBe(state);
          expect(errorFunction.mock.calls[0][2]).toEqual({
            toolCall: invalidToolCall,
          });
        } finally {
          flagSpy.mockRestore();
        }
      },
    );

    it('omits state when a sibling failure wins a batch with redacted invalid input', async () => {
      const secret = 'SECRET_MIXED_PARSE_FAILURE_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const invalidInputTool = tool({
        name: 'invalid_input',
        description: 'Recover from invalid input.',
        parameters: z.object({ value: z.number() }),
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const failingTool = tool({
        name: 'sibling_failure',
        description: 'Fail independently.',
        parameters: z.object({}),
        errorFunction: null,
        execute: vi.fn(async () => {
          throw new Error('sibling failed');
        }),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'invalid_input',
                arguments: secret,
              },
              tool: invalidInputTool,
            },
            {
              toolCall: {
                ...toolCall,
                callId: 'c2',
                name: 'sibling_failure',
                arguments: '{}',
              },
              tool: failingTool,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).error).toMatchObject({
          message: 'sibling failed',
        });
        expect((error as ToolCallError).state).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('clears matching state from a nested sibling ToolCallError', async () => {
      const secret = 'SECRET_NESTED_TOOL_CALL_STATE_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const invalidInputTool = tool({
        name: 'nested_state_invalid_input',
        description: 'Reject invalid input.',
        parameters: z.object({ value: z.number() }),
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const failingTool = tool({
        name: 'nested_tool_call_failure',
        description: 'Throw an SDK tool-call error.',
        parameters: z.object({}),
        errorFunction: null,
        execute: vi.fn(async () => {
          throw new ToolCallError(
            'nested tool call failed',
            new Error('nested failure'),
            state,
          );
        }),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'nested_state_invalid_input',
                arguments: secret,
              },
              tool: invalidInputTool,
            },
            {
              toolCall: {
                ...toolCall,
                callId: 'c2',
                name: 'nested_tool_call_failure',
                arguments: '{}',
              },
              tool: failingTool,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).state).toBeUndefined();
        expect((error as ToolCallError).error).toBeInstanceOf(ToolCallError);
        expect(((error as ToolCallError).error as ToolCallError).state).toBe(
          undefined,
        );
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it('classifies schema-invalid input before dynamic approval and sibling failure', async () => {
      const secret = 'SECRET_PREAPPROVAL_SCHEMA_FAILURE_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      let releaseApproval = () => {};
      const approvalGate = new Promise<void>((resolve) => {
        releaseApproval = resolve;
      });
      const needsApproval = vi.fn(async () => {
        await approvalGate;
        return false;
      });
      const invalidInputTool = tool({
        name: 'schema_invalid_input',
        description: 'Reject schema-invalid input before approval.',
        parameters: z.object({ value: z.number() }),
        needsApproval,
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const failingTool = tool({
        name: 'preapproval_sibling_failure',
        description: 'Fail while a sibling awaits approval.',
        parameters: z.object({}),
        errorFunction: null,
        execute: vi.fn(async () => {
          releaseApproval();
          throw new Error('preapproval sibling failed');
        }),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'schema_invalid_input',
                arguments: JSON.stringify({ value: secret }),
              },
              tool: invalidInputTool,
            },
            {
              toolCall: {
                ...toolCall,
                callId: 'c2',
                name: 'preapproval_sibling_failure',
                arguments: '{}',
              },
              tool: failingTool,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(needsApproval).toHaveBeenCalledWith(
          state._context,
          { value: secret },
          toolCall.callId,
        );
        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).state).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        releaseApproval();
        flagSpy.mockRestore();
      }
    });

    it('reuses the pre-approval parsed input during invocation', async () => {
      const refine = vi.fn((_value: string) => true);
      const execute = vi.fn(async (input: { value: string }) => input.value);
      const t = tool({
        name: 'single_parse',
        description: 'Parse input once.',
        parameters: z.object({ value: z.string().refine(refine) }),
        execute,
      }) as unknown as FunctionTool;
      const inputToolCall = {
        ...toolCall,
        name: 'single_parse',
        arguments: JSON.stringify({ value: 'prepared' }),
      };

      const result = await executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall: inputToolCall, tool: t }],
        runner,
        state,
      );

      expect(refine).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledWith(
        { value: 'prepared' },
        state._context,
        expect.objectContaining({ toolCall: inputToolCall }),
      );
      expect(result[0]).toMatchObject({
        type: 'function_output',
        output: 'prepared',
      });
    });

    it('does not trust prepared input across a forwarding invoke wrapper', async () => {
      const execute = vi.fn(async () => 'unexpected');
      const innerTool = tool({
        name: 'wrapped_inner',
        description: 'Validate wrapped input.',
        parameters: z.object({ value: z.number() }),
        execute,
      });
      const wrappedTool = {
        ...innerTool,
        name: 'wrapped_outer',
        invoke: (
          context: RunContext,
          input: string,
          details?: ToolCallDetails,
        ) => innerTool.invoke(context, input, details),
      } as unknown as FunctionTool;
      const wrappedToolCall = {
        ...toolCall,
        name: 'wrapped_outer',
        arguments: JSON.stringify({ value: 'SECRET_WRAPPED_SCHEMA_123' }),
      };

      const [result] = await executeFunctionToolCalls(
        state._currentAgent,
        [{ toolCall: wrappedToolCall, tool: wrappedTool }],
        runner,
        state,
      );

      expect(execute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        type: 'function_output',
        output:
          'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool',
      });
    });

    it('does not trust prepared input across tools sharing callback details', async () => {
      const innerExecute = vi.fn(async () => 'unexpected');
      const innerTool = tool({
        name: 'details_inner',
        description: 'Validate nested input.',
        parameters: z.object({ value: z.number() }),
        execute: innerExecute,
      });
      const outerTool = tool({
        name: 'details_outer',
        description: 'Forward callback details.',
        parameters: z.object({ outer: z.string() }),
        execute: async (_input, context, details) =>
          innerTool.invoke(
            context!,
            JSON.stringify({ value: 'SECRET_CROSS_TOOL_SCHEMA_123' }),
            details,
          ),
      }) as unknown as FunctionTool;

      const [result] = await executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              name: 'details_outer',
              arguments: JSON.stringify({ outer: 'ok' }),
            },
            tool: outerTool,
          },
        ],
        runner,
        state,
      );

      expect(innerExecute).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        type: 'function_output',
        output:
          'An error occurred while running the tool. Please try again. Error: InvalidToolInputError: Invalid JSON input for tool',
      });
    });

    it('isolates execution input from dynamic approval mutation', async () => {
      const execute = vi.fn(async (input: { value: string }) => input.value);
      const needsApproval = vi.fn(
        async (_context: RunContext, input: { value: string }) => {
          input.value = 'mutated';
          return false;
        },
      );
      const t = tool({
        name: 'approval_input_isolation',
        description: 'Keep execution input authoritative.',
        parameters: z.object({ value: z.string() }),
        needsApproval,
        execute,
      }) as unknown as FunctionTool;

      const [result] = await executeFunctionToolCalls(
        state._currentAgent,
        [
          {
            toolCall: {
              ...toolCall,
              name: 'approval_input_isolation',
              arguments: JSON.stringify({ value: 'original' }),
            },
            tool: t,
          },
        ],
        runner,
        state,
      );

      expect(needsApproval).toHaveBeenCalledWith(
        state._context,
        { value: 'mutated' },
        toolCall.callId,
      );
      expect(execute).toHaveBeenCalledWith(
        { value: 'original' },
        state._context,
        expect.anything(),
      );
      expect(result).toMatchObject({
        type: 'function_output',
        output: 'original',
      });
    });

    it('omits state when a timeout wins a batch with redacted invalid input', async () => {
      const secret = 'SECRET_MIXED_PARSE_TIMEOUT_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const invalidInputTool = tool({
        name: 'invalid_input',
        description: 'Recover from invalid input.',
        parameters: z.object({ value: z.number() }),
        execute: vi.fn(async () => 'unexpected'),
      }) as unknown as FunctionTool;
      const timeoutTool = tool({
        name: 'timeout_failure',
        description: 'Time out independently.',
        parameters: z.object({}),
        timeoutMs: 5,
        timeoutBehavior: 'raise_exception',
        execute: vi.fn(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30));
          return 'late';
        }),
      }) as unknown as FunctionTool;

      try {
        const error = await executeFunctionToolCalls(
          state._currentAgent,
          [
            {
              toolCall: {
                ...toolCall,
                name: 'invalid_input',
                arguments: secret,
              },
              tool: invalidInputTool,
            },
            {
              toolCall: {
                ...toolCall,
                callId: 'c2',
                name: 'timeout_failure',
                arguments: '{}',
              },
              tool: timeoutTool,
            },
          ],
          runner,
          state,
        ).catch((caught) => caught);

        expect(error).toBeInstanceOf(ToolTimeoutError);
        expect((error as ToolTimeoutError).state).toBeUndefined();
        expect(JSON.stringify(error)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
      }
    });

    it.each([false, true])(
      'redacts schema validation failures when traceIncludeSensitiveData is %s',
      async (traceIncludeSensitiveData) => {
        const secret = 'SECRET_SCHEMA_TRACE_ARGUMENT_123';
        const flagSpy = vi
          .spyOn(logger, 'dontLogToolData', 'get')
          .mockReturnValue(true);
        const debugSpy = vi.spyOn(logger, 'debug').mockImplementation(() => {});
        const t = tool({
          name: 'schema_trace_parser',
          description: 'Parse schema input.',
          parameters: z.object({ value: z.number() }),
          execute: vi.fn(async () => 'success'),
        }) as unknown as FunctionTool;
        const invalidToolCall = {
          ...toolCall,
          name: 'schema_trace_parser',
          arguments: JSON.stringify({ value: secret }),
        };

        try {
          await withRecordingTrace(async (processor) => {
            const [result] = await withTrace('test', () =>
              executeFunctionToolCalls(
                state._currentAgent,
                [{ toolCall: invalidToolCall, tool: t }],
                new Runner({
                  tracingDisabled: false,
                  traceIncludeSensitiveData,
                }),
                state,
              ),
            );

            expect(result.type).toBe('function_output');
            if (result.type === 'function_output') {
              expect(String(result.output)).not.toContain(secret);
            }
            const functionSpan = getEndedFunctionSpan(
              processor,
              'schema_trace_parser',
            );
            expect(JSON.stringify(functionSpan.toJSON())).not.toContain(secret);
          });
          expect(JSON.stringify(debugSpy.mock.calls)).not.toContain(secret);
        } finally {
          debugSpy.mockRestore();
          flagSpy.mockRestore();
        }
      },
    );

    it('throws structured parse failures without an error fallback', async () => {
      const secret = 'SECRET_THROWN_PARSE_ARGUMENT_123';
      const flagSpy = vi
        .spyOn(logger, 'dontLogToolData', 'get')
        .mockReturnValue(true);
      const t = tool({
        name: 'structured_parser_without_fallback',
        description: 'Parse structured input.',
        parameters: z.object({ value: z.string() }),
        outputSchema: z.object({ status: z.string() }),
        execute: vi.fn(async () => ({ status: 'ok' })),
      }) as unknown as FunctionTool;
      const invalidToolCall = {
        ...toolCall,
        name: 'structured_parser_without_fallback',
        arguments: secret,
      };

      try {
        const error = await withTrace('test', () =>
          executeFunctionToolCalls(
            state._currentAgent,
            [{ toolCall: invalidToolCall, tool: t }],
            runner,
            state,
          ).catch((caught) => caught),
        );

        expect(error).toBeInstanceOf(ToolCallError);
        expect((error as ToolCallError).state).toBeUndefined();
        const inputError = (error as ToolCallError).error;
        expect(inputError).toBeInstanceOf(InvalidToolInputError);
        expect(inputError).toMatchObject({
          state: undefined,
          originalError: undefined,
          toolInvocation: undefined,
        });
        expect(JSON.stringify(inputError)).not.toContain(secret);
      } finally {
        flagSpy.mockRestore();
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
        'object',
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

  it('does not recheck shell approval after approval', async () => {
    const shell = new FakeShell();
    const needsApproval = vi.fn(async () => true);
    const shellToolDef = shellTool({ shell, needsApproval });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({ tracingDisabled: true });
    const toolCall: protocol.ShellCallItem = {
      type: 'shell_call',
      callId: 'call_shell_approved',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };

    const pendingResults = await executeShellActions(
      agent,
      [{ toolCall, shell: shellToolDef } as any],
      runner,
      runContext,
    );
    expect(needsApproval).toHaveBeenCalledTimes(1);
    runContext.approveTool(pendingResults[0] as ToolApprovalItem);

    const approvedResults = await executeShellActions(
      agent,
      [{ toolCall, shell: shellToolDef } as any],
      runner,
      runContext,
    );

    expect(approvedResults[0].type).toBe('tool_call_output_item');
    expect(needsApproval).toHaveBeenCalledTimes(1);
    expect(shell.calls).toHaveLength(1);
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

  it('preserves shell onApproval rejection reasons', async () => {
    const shell = new FakeShell();
    const onApproval = vi.fn(async () => ({
      approve: false,
      reason: 'Not allowed',
    }));
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
    expect(shell.calls).toHaveLength(0);
    const outputItem = results[0] as ToolCallOutputItem;
    const rawItem = outputItem.rawItem as protocol.ShellCallResultItem;
    expect(rawItem.output).toEqual([
      {
        stdout: '',
        stderr: 'Not allowed',
        outcome: { type: 'exit', exitCode: null },
      },
    ]);
    expect(outputItem.output).toBe('Not allowed');
  });

  it('uses the default shell rejection message for empty onApproval reasons', async () => {
    const shell = new FakeShell();
    const onApproval = vi.fn(async () => ({
      approve: false,
      reason: '',
    }));
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

    const rawItem = results[0].rawItem as protocol.ShellCallResultItem;
    expect(rawItem.output[0]?.stderr).toBe('Tool execution was not approved.');
    expect(shell.calls).toHaveLength(0);
  });

  it('prefers shell onApproval reasons over toolErrorFormatter messages', async () => {
    const shell = new FakeShell();
    const onApproval = vi.fn(async () => ({
      approve: false,
      reason: 'Policy denied',
    }));
    const shellToolDef = shellTool({
      shell,
      needsApproval: async () => true,
      onApproval,
    });
    const agent = new Agent({ name: 'ShellAgent' });
    const runContext = new RunContext();
    const runner = new Runner({
      tracingDisabled: true,
      toolErrorFormatter: () => CUSTOM_REJECTION_MESSAGE,
    });
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
      undefined,
      runner.config.toolErrorFormatter,
    );

    const rawItem = results[0].rawItem as protocol.ShellCallResultItem;
    expect(rawItem.output[0]?.stderr).toBe('Policy denied');
    expect(shell.calls).toHaveLength(0);
  });

  it('returns failed output when approval explicitly rejected', async () => {
    const shell = new FakeShell();
    const needsApproval = vi.fn(async () => true);
    const shellToolDef = shellTool({ shell, needsApproval });
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
    expect(needsApproval).not.toHaveBeenCalled();
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
