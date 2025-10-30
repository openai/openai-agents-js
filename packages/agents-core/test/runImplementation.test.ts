import { describe, expect, it, vi, beforeEach, beforeAll } from 'vitest';
import { Buffer } from 'node:buffer';
import { z } from 'zod';

import { Agent, saveAgentToolRunResult } from '../src/agent';
import type { AgentOutputType } from '../src/agent';
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
import { RunResult, StreamedRunResult } from '../src/result';
import { getTracing } from '../src/run';
import { RunState } from '../src/runState';
import type { ProcessedResponse } from '../src/runImplementation';
import {
  addStepToRunResult,
  AgentToolUseTracker,
  checkForFinalOutputFromTools,
  getToolCallOutputItem,
  maybeResetToolChoice,
  processModelResponse,
  prepareInputItemsWithSession,
  executeFunctionToolCalls,
  executeComputerActions,
  executeHandoffCalls,
  resolveTurnAfterModelResponse,
  streamStepItemsToRunResult,
  saveToSession,
  resolveInterruptedTurn,
  toInputItemList,
} from '../src/runImplementation';
import {
  FunctionTool,
  FunctionToolResult,
  tool,
  computerTool,
  hostedMcpTool,
} from '../src/tool';
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
  fakeModelMessage,
} from './stubs';
import * as protocol from '../src/types/protocol';
import { Runner } from '../src/run';
import { RunContext } from '../src/runContext';
import { setDefaultModelProvider } from '../src';
import { Logger } from '../src/logger';
import type { UnknownContext } from '../src/types';
import type { Session } from '../src/memory/session';
import type { AgentInputItem } from '../src/types';

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

describe('saveToSession', () => {
  class MemorySession implements Session {
    items: AgentInputItem[] = [];

    async getSessionId(): Promise<string> {
      return 'session';
    }

    async getItems(): Promise<AgentInputItem[]> {
      return [...this.items];
    }

    async addItems(items: AgentInputItem[]): Promise<void> {
      this.items.push(...items);
    }

    async popItem(): Promise<AgentInputItem | undefined> {
      return this.items.pop();
    }

    async clearSession(): Promise<void> {
      this.items = [];
    }
  }

  it('persists tool outputs when resuming a turn after approvals', async () => {
    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'Hitl Agent',
      outputType: 'text',
      instructions: 'test',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const session = new MemorySession();
    const context = new RunContext<UnknownContext>(undefined as UnknownContext);
    const state = new RunState<
      UnknownContext,
      Agent<UnknownContext, AgentOutputType>
    >(context, 'hello', agent, 10);

    const functionCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_1',
      callId: 'call_1',
      name: 'lookup_customer_profile',
      status: 'completed',
      arguments: JSON.stringify({ id: '1' }),
      providerData: {},
    };

    const approvalItem = new ToolApprovalItem(functionCall, textAgent);
    state._generatedItems = [approvalItem];
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [approvalItem],
      },
    };

    const preApprovalResult = new RunResult(state);
    await saveToSession(
      session,
      toInputItemList(state._originalInput),
      preApprovalResult,
    );

    expect(session.items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
    ]);
    expect(state._currentTurnPersistedItemCount).toBe(1);

    const toolDefinition = tool({
      name: 'lookup_customer_profile',
      description: 'mock lookup',
      parameters: z.object({ id: z.string() }),
      async execute({ id }) {
        return `No customer found for id ${id}.`;
      },
    }) as unknown as FunctionTool<UnknownContext>;

    const assistantMessage: protocol.AssistantMessageItem = {
      type: 'message',
      id: 'msg_1',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'Ready to help.',
        },
      ],
      providerData: {},
    };

    const processedResponse: ProcessedResponse<UnknownContext> = {
      newItems: [new MessageOutputItem(assistantMessage, textAgent)],
      handoffs: [],
      functions: [
        {
          toolCall: functionCall,
          tool: toolDefinition,
        },
      ],
      computerActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun() {
        return false;
      },
    } as ProcessedResponse<UnknownContext>;

    const runner = new Runner();
    const resumedResponse: ModelResponse = {
      usage: new Usage({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      output: [],
    };

    const turnResult = await withTrace('hitl-test-trace', async () => {
      return resolveInterruptedTurn(
        textAgent,
        state._originalInput,
        state._generatedItems,
        resumedResponse,
        processedResponse,
        runner,
        state,
      );
    });

    state._originalInput = turnResult.originalInput;
    state._generatedItems = turnResult.generatedItems;
    state._currentStep = turnResult.nextStep;

    const resumedResult = new RunResult(state);
    await saveToSession(session, [], resumedResult);

    expect(session.items).toHaveLength(2);
    const last = session.items[
      session.items.length - 1
    ] as protocol.FunctionCallResultItem;
    expect(last.type).toBe('function_call_result');
    expect(last.callId).toBe(functionCall.callId);
  });

  it('persists HITL tool outputs when approval items are not the last generated entries', async () => {
    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'Interleaved HITL Agent',
      outputType: 'text',
      instructions: 'test',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const session = new MemorySession();
    const context = new RunContext<UnknownContext>(undefined as UnknownContext);
    const state = new RunState<
      UnknownContext,
      Agent<UnknownContext, AgentOutputType>
    >(context, 'hello', agent, 10);

    const approvalCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_hitl',
      callId: 'call_hitl',
      name: 'lookup_customer_profile',
      status: 'completed',
      arguments: JSON.stringify({ id: '101' }),
      providerData: {},
    };

    const autoCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'fc_auto',
      callId: 'call_auto',
      name: 'fetch_image_data',
      status: 'completed',
      arguments: JSON.stringify({ id: '101' }),
      providerData: {},
    };

    const approvalToolCallItem = new ToolCallItem(approvalCall, textAgent);
    const autoToolCallItem = new ToolCallItem(autoCall, textAgent);
    const approvalItem = new ToolApprovalItem(approvalCall, textAgent);
    const autoOutputRaw = getToolCallOutputItem(autoCall, 'Fetched image.');
    const autoOutputItem = new ToolCallOutputItem(
      autoOutputRaw,
      textAgent,
      'Fetched image.',
    );

    state._generatedItems = [
      approvalToolCallItem,
      autoToolCallItem,
      approvalItem,
      autoOutputItem,
    ];
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [approvalItem],
      },
    };

    const preApprovalResult = new RunResult(state);
    await saveToSession(
      session,
      toInputItemList(state._originalInput),
      preApprovalResult,
    );

    expect(state._currentTurnPersistedItemCount).toBe(4);
    expect(session.items).toHaveLength(4);
    const preResumeResult = session.items[3] as protocol.FunctionCallResultItem;
    expect(preResumeResult.type).toBe('function_call_result');
    expect(preResumeResult.callId).toBe(autoCall.callId);

    state.approve(approvalItem);

    const approvalTool = tool({
      name: approvalCall.name,
      description: 'Approval tool',
      parameters: z.object({ id: z.string() }),
      needsApproval: async () => true,
      async execute({ id }) {
        return `Customer ${id} details.`;
      },
    }) as unknown as FunctionTool<UnknownContext>;

    const autoTool = tool({
      name: autoCall.name,
      description: 'Auto tool',
      parameters: z.object({ id: z.string() }),
      async execute({ id }) {
        return `Image for ${id}.`;
      },
    }) as unknown as FunctionTool<UnknownContext>;

    const processedResponse: ProcessedResponse<UnknownContext> = {
      newItems: [
        approvalToolCallItem,
        autoToolCallItem,
        approvalItem,
        autoOutputItem,
      ],
      handoffs: [],
      functions: [
        {
          toolCall: approvalCall,
          tool: approvalTool,
        },
        {
          toolCall: autoCall,
          tool: autoTool,
        },
      ],
      computerActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [approvalCall.name, autoCall.name],
      hasToolsOrApprovalsToRun() {
        return false;
      },
    } as ProcessedResponse<UnknownContext>;

    const runner = new Runner();
    const resumedResponse: ModelResponse = {
      usage: new Usage({
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
      output: [],
    };

    const turnResult = await withTrace('interleaved-hitl', async () => {
      return resolveInterruptedTurn(
        textAgent,
        state._originalInput,
        state._generatedItems,
        resumedResponse,
        processedResponse,
        runner,
        state,
      );
    });

    state._originalInput = turnResult.originalInput;
    state._generatedItems = turnResult.generatedItems;
    state._currentStep = turnResult.nextStep;

    const resumedResult = new RunResult(state);
    await saveToSession(session, [], resumedResult);

    expect(session.items).toHaveLength(5);
    const latest = session.items[4] as protocol.FunctionCallResultItem;
    expect(latest.type).toBe('function_call_result');
    expect(latest.callId).toBe(approvalCall.callId);
  });
});

describe('prepareInputItemsWithSession', () => {
  class StubSession implements Session {
    constructor(private history: AgentInputItem[]) {}

    async getSessionId(): Promise<string> {
      return 'session';
    }

    async getItems(): Promise<AgentInputItem[]> {
      return [...this.history];
    }

    async addItems(_items: AgentInputItem[]): Promise<void> {}

    async popItem(): Promise<AgentInputItem | undefined> {
      return undefined;
    }

    async clearSession(): Promise<void> {}
  }

  it('concatenates session history with array inputs when no callback is provided', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'history',
      id: 'history-1',
    };
    const newItems: AgentInputItem[] = [
      {
        type: 'message',
        role: 'user',
        content: 'fresh text',
        id: 'new-1',
      },
      {
        type: 'function_call_result',
        name: 'foo-func',
        callId: 'new-2',
        output: [
          {
            type: 'input_image',
            image: 'https://example.com/image.png',
          },
        ],
        status: 'completed',
      },
    ];
    const session = new StubSession([historyItem]);

    const result = await prepareInputItemsWithSession(newItems, session);

    expect(result.preparedInput).toEqual([historyItem, ...newItems]);
    const sessionItems = result.sessionItems;
    if (!sessionItems) {
      throw new Error('Expected sessionItems to be defined.');
    }
    expect(sessionItems).toEqual(newItems);
    expect(sessionItems[0]).toBe(newItems[0]);
    expect(sessionItems[1]).toBe(newItems[1]);
  });

  it('only persists new inputs when callbacks prepend history duplicates', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'ok',
      id: 'history-1',
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'ok',
      id: 'new-1',
    };
    const session = new StubSession([historyItem]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => {
        expect(history).toHaveLength(1);
        expect(history[0]).toBe(historyItem);
        expect(newItems).toHaveLength(1);
        expect(newItems[0]).toBe(newItem);
        return [...history.slice(-1), ...newItems];
      },
    );

    expect(result.preparedInput).toEqual([historyItem, newItem]);
    const sessionItems = result.sessionItems;
    if (!sessionItems) {
      throw new Error('Expected sessionItems to be defined.');
    }
    expect(sessionItems).toEqual([newItem]);
    expect(sessionItems[0]).toBe(newItem);
  });

  it('respects callbacks that intentionally drop new inputs', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'previous',
      id: 'history-1',
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'fresh',
      id: 'new-1',
    };
    const session = new StubSession([historyItem]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history) => history.slice(),
      { includeHistoryInPreparedInput: false },
    );

    expect(result.preparedInput).toEqual([]);
    const sessionItems = result.sessionItems;
    if (!sessionItems) {
      throw new Error('Expected sessionItems to be defined.');
    }
    expect(sessionItems).toEqual([]);
  });

  it('persists appended copies when callbacks mutate history in place', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'past',
      id: 'history-1',
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'fresh',
      id: 'new-1',
    };
    const session = new StubSession([historyItem]);

    let appendedItems: AgentInputItem[] = [];
    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => {
        appendedItems = newItems.map((item) => ({
          ...item,
          providerData: { annotated: true },
        }));
        history.push(...appendedItems);
        return history;
      },
    );

    expect(appendedItems).toHaveLength(1);
    expect(result.preparedInput).toEqual([historyItem, ...appendedItems]);
    const sessionItems = result.sessionItems;
    if (!sessionItems) {
      throw new Error('Expected sessionItems to be defined.');
    }
    expect(sessionItems).toEqual(appendedItems);
    expect(sessionItems[0]).toBe(appendedItems[0]);
    expect(sessionItems[0]).not.toBe(newItem);
  });

  it('omits session history from prepared input when includeHistoryInPreparedInput is false', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'past',
      id: 'history-1',
    };
    const session = new StubSession([historyItem]);
    const result = await prepareInputItemsWithSession(
      'fresh input',
      session,
      undefined,
      { includeHistoryInPreparedInput: false },
    );

    expect(result.preparedInput).toEqual(toInputItemList('fresh input'));
    expect(result.sessionItems).toEqual(toInputItemList('fresh input'));
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
        data: 'AAA',
        mediaType: 'image/png',
      },
    });

    expect(result.output).toEqual([
      {
        type: 'input_image',
        image: 'data:image/png;base64,AAA',
      },
    ]);
  });

  it('converts nested image objects with binary payloads', () => {
    const bytes = Buffer.from('png-binary');
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'image',
      image: {
        data: new Uint8Array(bytes),
        mediaType: 'image/png',
      },
    });

    expect(result.output).toEqual([
      {
        type: 'input_image',
        image: `data:image/png;base64,${bytes.toString('base64')}`,
      },
    ]);
  });

  it('converts image outputs with file IDs', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'image',
      image: { fileId: 'file_999' },
    });

    expect(result.output).toEqual([
      {
        type: 'input_image',
        image: { id: 'file_999' },
      },
    ]);
  });

  it('converts file outputs', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'file',
      file: {
        id: 'file_123',
        filename: 'report.pdf',
      },
    });

    expect(result.output).toEqual([
      {
        type: 'input_file',
        file: { id: 'file_123' },
        filename: 'report.pdf',
      },
    ]);
  });

  it('supports legacy fileData payloads', () => {
    const base64 = Buffer.from('legacy file').toString('base64');
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'file',
      fileData: base64,
      filename: 'legacy.txt',
      mediaType: 'text/plain',
    });

    expect(result.output).toEqual([
      {
        type: 'input_file',
        file: `data:text/plain;base64,${base64}`,
        filename: 'legacy.txt',
      },
    ]);
  });

  it('respects mediaType for inline file data (string)', () => {
    const base64 = Buffer.from('pdf binary data').toString('base64');
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'file',
      file: {
        data: base64,
        mediaType: 'application/pdf',
        filename: 'report.pdf',
      },
    });

    expect(result.output).toEqual([
      {
        type: 'input_file',
        file: `data:application/pdf;base64,${base64}`,
        filename: 'report.pdf',
      },
    ]);
  });

  it('respects mediaType for inline file data (Uint8Array)', () => {
    const bytes = Buffer.from('%PDF-1.7');
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'file',
      file: {
        data: new Uint8Array(bytes),
        mediaType: 'application/pdf',
        filename: 'binary.pdf',
      },
    });

    expect(result.output).toEqual([
      {
        type: 'input_file',
        file: `data:application/pdf;base64,${bytes.toString('base64')}`,
        filename: 'binary.pdf',
      },
    ]);
  });

  it('converts arrays of structured outputs', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, [
      { type: 'text', text: 'alpha' },
      { type: 'image', image: 'data:image/png;base64,AAA' },
    ]);

    expect(result.output).toEqual([
      { type: 'input_text', text: 'alpha' },
      {
        type: 'input_image',
        image: 'data:image/png;base64,AAA',
      },
    ]);
  });

  it('stringifies arrays of primitives', () => {
    const raw = [1, true, 'alpha'];
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, raw);

    expect(result.output).toEqual({
      type: 'text',
      text: JSON.stringify(raw),
    });
  });

  it('stringifies arrays of plain objects', () => {
    const raw = [{ foo: 'bar' }, { baz: 2 }];
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, raw);

    expect(result.output).toEqual({
      type: 'text',
      text: JSON.stringify(raw),
    });
  });

  it('falls back to text output when array contains unsupported items', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, [
      { type: 'text', text: 'alpha' },
      { foo: 'bar' },
    ]);

    expect(result.output).toEqual({
      type: 'text',
      text: '[{"type":"text","text":"alpha"},{"foo":"bar"}]',
    });
  });

  it('stringifies plain objects that are not structured outputs', () => {
    const raw = { foo: 'bar' };
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, raw);

    expect(result.output).toEqual({
      type: 'text',
      text: JSON.stringify(raw),
    });
  });

  it('preserves custom image detail values', () => {
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'image',
      image: 'https://example.com/image.png',
      detail: 'ultra',
    });

    expect(result.output).toEqual([
      {
        type: 'input_image',
        image: 'https://example.com/image.png',
        detail: 'ultra',
      },
    ]);
  });

  it('converts Uint8Array image data into base64 strings', () => {
    const bytes = Buffer.from('image-binary');
    const result = getToolCallOutputItem(TEST_MODEL_FUNCTION_CALL, {
      type: 'image',
      data: new Uint8Array(bytes),
      mediaType: 'image/png',
    });

    expect(result.output).toEqual([
      {
        type: 'input_image',
        image: `data:image/png;base64,${bytes.toString('base64')}`,
      },
    ]);
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
    // Simulate the streaming loop emitting early items and then the step emitter
    // flushing the remainder without duplicating the first two events.
    streamStepItemsToRunResult(streamedResult, [messageItem, toolCallItem]);
    addStepToRunResult(streamedResult, step, { skipItems: preStreamed });

    expect(captured).toEqual([
      'message_output_created',
      'tool_called',
      'tool_output',
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

describe('resolveTurnAfterModelResponse', () => {
  let runner: Runner;
  let state: RunState<any, any>;

  beforeEach(() => {
    runner = new Runner({ tracingDisabled: true });
    state = new RunState(new RunContext(), 'test input', TEST_AGENT, 1);
  });

  it('does not finalize when tools are used in the same turn (text output); runs again', async () => {
    const textAgent = new Agent({ name: 'TextAgent', outputType: 'text' });
    const processedResponse = processModelResponse(
      TEST_MODEL_RESPONSE_WITH_FUNCTION,
      textAgent,
      [TEST_TOOL],
      [],
    );

    expect(processedResponse.hasToolsOrApprovalsToRun()).toBe(true);

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
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

  it('does not finalize when tools are used in the same turn (structured output); runs again', async () => {
    const structuredAgent = new Agent({
      name: 'StructuredAgent',
      outputType: z.object({
        foo: z.string(),
      }),
    });

    const structuredResponse: ModelResponse = {
      output: [
        { ...TEST_MODEL_FUNCTION_CALL },
        fakeModelMessage('{"foo":"bar"}'),
      ],
      usage: new Usage(),
    } as any;

    const processedResponse = processModelResponse(
      structuredResponse,
      structuredAgent,
      [TEST_TOOL],
      [],
    );

    expect(processedResponse.hasToolsOrApprovalsToRun()).toBe(true);

    const structuredState = new RunState(
      new RunContext(),
      'test input',
      structuredAgent,
      1,
    );

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
        structuredAgent,
        'test input',
        [],
        structuredResponse,
        processedResponse,
        runner,
        structuredState,
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
      resolveTurnAfterModelResponse(
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

  it('returns final output when final message text is empty', async () => {
    const textAgent = new Agent({ name: 'TextAgent', outputType: 'text' });
    const imageCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'img1',
      name: 'image_generation_call',
      status: 'completed',
      output: 'iVBORw0KGgoAAAANSUhEUgAABAAAAAYACAIAAABn4K39AAHH1....', // base64 encoded image
      providerData: { type: 'image_generation_call' },
    };
    const emptyMessage: protocol.AssistantMessageItem = {
      id: 'msg1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: '' }],
    };
    const response: ModelResponse = {
      output: [imageCall, emptyMessage],
      usage: new Usage(),
    } as any;
    const processedResponse = processModelResponse(response, textAgent, [], []);

    expect(processedResponse.hasToolsOrApprovalsToRun()).toBe(false);

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
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
      expect(result.nextStep.output).toBe('');
    }
  });

  it('does not finalize after computer actions in the same turn; runs again', async () => {
    const computerAgent = new Agent({
      name: 'ComputerAgent',
      outputType: 'text',
    });
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
    };
    const computer = computerTool({
      computer: fakeComputer as unknown as Computer,
    });
    const computerCall: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      id: 'comp1',
      callId: 'comp1',
      status: 'completed',
      action: { type: 'screenshot' },
    } as protocol.ComputerUseCallItem;

    const computerResponse: ModelResponse = {
      output: [computerCall, { ...TEST_MODEL_MESSAGE }],
      usage: new Usage(),
    } as any;

    const processedResponse = processModelResponse(
      computerResponse,
      computerAgent,
      [computer],
      [],
    );

    const computerState = new RunState(
      new RunContext(),
      'test input',
      computerAgent,
      1,
    );

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
        computerAgent,
        'test input',
        [],
        computerResponse,
        processedResponse,
        runner,
        computerState,
      ),
    );

    expect(result.nextStep.type).toBe('next_step_run_again');
  });

  it('does not duplicate previously persisted model items when resuming after approvals', async () => {
    const toolCall = {
      ...TEST_MODEL_FUNCTION_CALL,
      id: 'call-resume',
      callId: 'call-resume',
    };
    const message = fakeModelMessage('Tool approval pending');
    message.id = 'message-resume';
    const response: ModelResponse = {
      output: [toolCall, message],
      usage: new Usage(),
    } as any;

    const processedResponse = processModelResponse(
      response,
      TEST_AGENT,
      [TEST_TOOL],
      [],
    );

    const priorItems = [...processedResponse.newItems];
    state._generatedItems = priorItems;

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
        TEST_AGENT,
        'test input',
        priorItems,
        response,
        processedResponse,
        runner,
        state,
      ),
    );

    const persistedToolCalls = result.generatedItems.filter((item) => {
      return item instanceof ToolCallItem && item.rawItem.id === 'call-resume';
    });
    expect(persistedToolCalls).toHaveLength(1);

    const persistedMessages = result.generatedItems.filter((item) => {
      return (
        item instanceof MessageOutputItem &&
        item.rawItem.id === 'message-resume'
      );
    });
    expect(persistedMessages).toHaveLength(1);
  });

  it('does not finalize when hosted MCP approval happens in the same turn; runs again', async () => {
    const approvalAgent = new Agent({ name: 'MCPAgent', outputType: 'text' });
    const mcpTool = hostedMcpTool({
      serverLabel: 'demo_server',
      serverUrl: 'https://example.com',
      requireApproval: {
        always: { toolNames: ['demo_tool'] },
      },
      onApproval: async () => ({ approve: true, reason: 'approved in test' }),
    });

    const approvalCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'approval1',
      name: 'mcp_approval_request',
      status: 'completed',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'demo_server',
        name: 'demo_tool',
        id: 'approval1',
        arguments: '{}',
      },
    } as protocol.HostedToolCallItem;

    const approvalResponse: ModelResponse = {
      output: [approvalCall, { ...TEST_MODEL_MESSAGE }],
      usage: new Usage(),
    } as any;

    const processedResponse = processModelResponse(
      approvalResponse,
      approvalAgent,
      [mcpTool],
      [],
    );

    const approvalState = new RunState(
      new RunContext(),
      'test input',
      approvalAgent,
      1,
    );

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
        approvalAgent,
        'test input',
        [],
        approvalResponse,
        processedResponse,
        runner,
        approvalState,
      ),
    );

    expect(result.nextStep.type).toBe('next_step_run_again');
  });

  it('returns interruption when hosted MCP approval requires user input', async () => {
    const approvalAgent = new Agent({ name: 'MCPAgent', outputType: 'text' });
    const mcpTool = hostedMcpTool({
      serverLabel: 'demo_server',
      serverUrl: 'https://example.com',
      requireApproval: {
        always: { toolNames: ['demo_tool'] },
      },
    });

    const approvalCall: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'approval1',
      name: 'mcp_approval_request',
      status: 'completed',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'demo_server',
        name: 'demo_tool',
        id: 'approval1',
        arguments: '{}',
      },
    } as protocol.HostedToolCallItem;

    const approvalResponse: ModelResponse = {
      output: [approvalCall, { ...TEST_MODEL_MESSAGE }],
      usage: new Usage(),
    } as any;

    const processedResponse = processModelResponse(
      approvalResponse,
      approvalAgent,
      [mcpTool],
      [],
    );

    const approvalState = new RunState(
      new RunContext(),
      'test input',
      approvalAgent,
      1,
    );

    const result = await withTrace('test', () =>
      resolveTurnAfterModelResponse(
        approvalAgent,
        'test input',
        [],
        approvalResponse,
        processedResponse,
        runner,
        approvalState,
      ),
    );

    expect(result.nextStep.type).toBe('next_step_interruption');
    if (result.nextStep.type === 'next_step_interruption') {
      expect(result.nextStep.data.interruptions).toHaveLength(1);
      expect(result.nextStep.data.interruptions[0].rawItem).toMatchObject({
        providerData: { id: 'approval1', type: 'mcp_approval_request' },
      });
    }
  });

  it('preserves pending hosted MCP approvals when resuming an interrupted turn', async () => {
    const approvalAgent = new Agent({ name: 'MCPAgent', outputType: 'text' });
    const mcpTool = hostedMcpTool({
      serverLabel: 'demo_server',
      serverUrl: 'https://example.com',
      requireApproval: {
        always: { toolNames: ['demo_tool'] },
      },
    });

    const approvalRequest: protocol.HostedToolCallItem = {
      type: 'hosted_tool_call',
      id: 'approval1',
      name: 'demo_tool',
      status: 'in_progress',
      providerData: {
        type: 'mcp_approval_request',
        server_label: 'demo_server',
        name: 'demo_tool',
        id: 'approval1',
        arguments: '{}',
      },
    } as protocol.HostedToolCallItem;

    const approvalItem = new ToolApprovalItem(approvalRequest, approvalAgent);
    const originalPreStepItems = [approvalItem];

    const processedResponse: ProcessedResponse = {
      newItems: [],
      handoffs: [],
      functions: [],
      computerActions: [],
      mcpApprovalRequests: [
        {
          requestItem: approvalItem,
          mcpTool,
        },
      ],
      toolsUsed: [],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };

    const resumedResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const resumedState = new RunState(
      new RunContext(),
      'test input',
      approvalAgent,
      1,
    );

    const runner = new Runner();

    const result = await resolveInterruptedTurn(
      approvalAgent,
      'test input',
      originalPreStepItems,
      resumedResponse,
      processedResponse,
      runner,
      resumedState,
    );

    expect(result.nextStep.type).toBe('next_step_interruption');
    if (result.nextStep.type === 'next_step_interruption') {
      expect(result.nextStep.data.interruptions).toContain(approvalItem);
    }
    expect(result.preStepItems).toContain(approvalItem);
    expect(result.newStepItems).not.toContain(approvalItem);
  });
});

describe('resolveInterruptedTurn', () => {
  it('rewinds persisted count only for pending approval placeholders', async () => {
    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'SequentialApprovalsAgent',
      outputType: 'text',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const firstCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      id: 'call-first',
      callId: 'call-first',
    };
    const secondCall: protocol.FunctionCallItem = {
      ...TEST_MODEL_FUNCTION_CALL,
      id: 'call-second',
      callId: 'call-second',
    };

    const firstApproval = new ToolApprovalItem(firstCall, agent);
    const firstOutputRaw = getToolCallOutputItem(firstCall, 'done');
    const firstOutput = new ToolCallOutputItem(firstOutputRaw, agent, 'done');
    const secondApproval = new ToolApprovalItem(secondCall, agent);

    const generatedItems = [firstApproval, firstOutput, secondApproval];
    const state = new RunState(new RunContext(), 'hello', agent, 5);
    state._generatedItems = generatedItems;
    state._currentTurnPersistedItemCount = generatedItems.length;
    state._currentStep = {
      type: 'next_step_interruption',
      data: {
        interruptions: [secondApproval],
      },
    };

    const processedResponse: ProcessedResponse = {
      newItems: [],
      handoffs: [],
      functions: [],
      computerActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun() {
        return false;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const modelResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const result = await resolveInterruptedTurn(
      agent,
      'hello',
      generatedItems,
      modelResponse,
      processedResponse,
      runner,
      state,
    );

    expect(state._currentTurnPersistedItemCount).toBe(
      generatedItems.length - 1,
    );
    expect(result.preStepItems).toEqual([firstOutput]);
  });

  it('dispatches approved computer actions when resuming an interruption', async () => {
    const fakeComputer: Computer = {
      environment: 'mac',
      dimensions: [1, 1],
      screenshot: vi.fn().mockResolvedValue('img'),
      click: vi.fn(async (_x: number, _y: number, _button: any) => {}),
      doubleClick: vi.fn(async (_x: number, _y: number) => {}),
      drag: vi.fn(async (_path: [number, number][]) => {}),
      keypress: vi.fn(async (_keys: string[]) => {}),
      move: vi.fn(async (_x: number, _y: number) => {}),
      scroll: vi.fn(
        async (_x: number, _y: number, _sx: number, _sy: number) => {},
      ),
      type: vi.fn(async (_text: string) => {}),
      wait: vi.fn(async () => {}),
    };
    const computer = computerTool({ computer: fakeComputer });
    const agent = new Agent({ name: 'ComputerAgent', tools: [computer] });
    const computerCall: protocol.ComputerUseCallItem = {
      type: 'computer_call',
      id: 'comp1',
      callId: 'comp1',
      status: 'in_progress',
      action: { type: 'screenshot' } as any,
    };
    const processedResponse: ProcessedResponse<UnknownContext> = {
      newItems: [new ToolCallItem(computerCall, agent)],
      handoffs: [],
      functions: [],
      computerActions: [{ toolCall: computerCall, computer }],
      mcpApprovalRequests: [],
      toolsUsed: ['computer_use'],
      hasToolsOrApprovalsToRun() {
        return true;
      },
    };

    const runner = new Runner({ tracingDisabled: true });
    const state = new RunState(new RunContext(), 'hello', agent, 1);
    const approvalSpy = vi
      .spyOn(state._context, 'isToolApproved')
      .mockImplementation(({ toolName, callId }) => {
        if (toolName === computer.name && callId === computerCall.callId) {
          return true as any;
        }
        return undefined as any;
      });

    const originalItems = [new ToolCallItem(computerCall, agent)];
    const resumedResponse: ModelResponse = {
      output: [],
      usage: new Usage(),
    } as any;

    const result = await resolveInterruptedTurn(
      agent,
      'hello',
      originalItems,
      resumedResponse,
      processedResponse,
      runner,
      state,
    );

    approvalSpy.mockRestore();

    const toolOutputs = result.newStepItems.filter(
      (item): item is ToolCallOutputItem => item instanceof ToolCallOutputItem,
    );

    expect(toolOutputs).toHaveLength(1);
    expect(
      (toolOutputs[0].rawItem as protocol.ComputerCallResultItem).callId,
    ).toBe(computerCall.callId);
    expect(fakeComputer.screenshot).toHaveBeenCalledTimes(1);
  });
});
