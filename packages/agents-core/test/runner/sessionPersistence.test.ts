import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  setDefaultModelProvider,
  setTracingDisabled,
  withTrace,
} from '../../src';
import { Agent, AgentOutputType } from '../../src/agent';
import {
  RunMessageOutputItem as MessageOutputItem,
  RunToolApprovalItem as ToolApprovalItem,
  RunToolCallItem as ToolCallItem,
  RunToolCallOutputItem as ToolCallOutputItem,
} from '../../src/items';
import { ModelResponse } from '../../src/model';
import {
  prepareInputItemsWithSession,
  saveStreamResultToSession,
  saveToSession,
} from '../../src/runner/sessionPersistence';
import { ServerConversationTracker } from '../../src/runner/conversation';
import { getToolCallOutputItem } from '../../src/runner/toolExecution';
import { Runner } from '../../src/run';
import { RunContext } from '../../src/runContext';
import { RunResult, StreamedRunResult } from '../../src/result';
import { RunState } from '../../src/runState';
import { resolveInterruptedTurn } from '../../src/runner/turnResolution';
import type { ProcessedResponse } from '../../src/runner/types';
import type {
  OpenAIResponsesCompactionArgs,
  OpenAIResponsesCompactionResult,
  Session,
} from '../../src/memory/session';
import { toAgentInputList } from '../../src/runner/items';
import { tool } from '../../src/tool';
import type { FunctionTool } from '../../src/tool';
import { Usage, RequestUsage } from '../../src/usage';
import { z } from 'zod';
import type { AgentInputItem, UnknownContext } from '../../src/types';
import * as protocol from '../../src/types/protocol';
import { FakeModelProvider, TEST_AGENT, fakeModelMessage } from '../stubs';
import logger from '../../src/logger';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

describe('ServerConversationTracker', () => {
  it('does not update previousResponseId when conversationId is set', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv-1',
      previousResponseId: 'resp-old',
    });

    tracker.trackServerItems({
      output: [],
      usage: new Usage(),
      responseId: 'resp-new',
    });

    expect(tracker.previousResponseId).toBe('resp-old');
    expect(tracker.conversationId).toBe('conv-1');
  });

  it('preserves initial input when resuming without prior responses', () => {
    const tracker = new ServerConversationTracker({ conversationId: 'conv-2' });
    const originalInput = 'hello there';

    tracker.primeFromState({
      originalInput,
      generatedItems: [],
      modelResponses: [],
    });

    const prepared = tracker.prepareInput(originalInput, []);
    expect(prepared).toHaveLength(1);
    expect(prepared[0]).toMatchObject({
      type: 'message',
      role: 'user',
      content: originalInput,
    });
  });
});

describe('saveStreamResultToSession', () => {
  class TrackingSession implements Session {
    items: AgentInputItem[] = [];
    events: string[] = [];

    async getSessionId(): Promise<string> {
      return 'session';
    }

    async getItems(): Promise<AgentInputItem[]> {
      return [...this.items];
    }

    async addItems(items: AgentInputItem[]): Promise<void> {
      this.events.push(`addItems:${items.length}`);
      this.items.push(...items);
    }

    async popItem(): Promise<AgentInputItem | undefined> {
      return undefined;
    }

    async clearSession(): Promise<void> {
      this.items = [];
    }

    async runCompaction(
      args?: OpenAIResponsesCompactionArgs,
    ): Promise<OpenAIResponsesCompactionResult | null> {
      this.events.push(`runCompaction:${args?.responseId}`);
      return null;
    }
  }

  const buildAssistantMessage = (id: string, text: string) =>
    ({
      type: 'message',
      role: 'assistant',
      id,
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text,
        },
      ],
      providerData: {},
    }) satisfies protocol.AssistantMessageItem;

  it('persists streamed outputs and advances the persisted counter', async () => {
    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'Streamer',
      outputType: 'text',
      instructions: 'stream test',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const session = new TrackingSession();
    const context = new RunContext<UnknownContext>(undefined as UnknownContext);
    const state = new RunState<
      UnknownContext,
      Agent<UnknownContext, AgentOutputType>
    >(context, 'hello', agent, 10);

    state._modelResponses.push({
      output: [],
      usage: new Usage(),
      responseId: 'resp_stream',
    });
    state._generatedItems = [
      new MessageOutputItem(
        buildAssistantMessage('msg_stream', 'hi'),
        textAgent,
      ),
    ];

    const streamedResult = new StreamedRunResult({
      state,
    });

    await saveStreamResultToSession(session, streamedResult);

    expect(session.events).toEqual(['addItems:1', 'runCompaction:resp_stream']);
    expect(session.items).toHaveLength(1);
    expect(state._currentTurnPersistedItemCount).toBe(1);
  });

  it('skips writes when there is no new streamed output but still runs compaction', async () => {
    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'StreamerNoDelta',
      outputType: 'text',
      instructions: 'stream test',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const session = new TrackingSession();
    const context = new RunContext<UnknownContext>(undefined as UnknownContext);
    const state = new RunState<
      UnknownContext,
      Agent<UnknownContext, AgentOutputType>
    >(context, 'hello', agent, 10);

    state._modelResponses.push({
      output: [],
      usage: new Usage(),
      responseId: 'resp_stream_empty',
    });
    state._generatedItems = [
      new MessageOutputItem(
        buildAssistantMessage('msg_persisted', 'persisted'),
        textAgent,
      ),
    ];
    state._currentTurnPersistedItemCount = state._generatedItems.length;

    const streamedResult = new StreamedRunResult({
      state,
    });

    await saveStreamResultToSession(session, streamedResult);

    expect(session.events).toEqual(['runCompaction:resp_stream_empty']);
    expect(session.items).toHaveLength(0);
    expect(state._currentTurnPersistedItemCount).toBe(
      state._generatedItems.length,
    );
  });
});

describe('ServerConversationTracker', () => {
  it('marks filtered-out inputs as sent when the callModelInputFilter drops them', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_123',
    });
    const initialInput = toAgentInputList('hello');

    const turnInput = tracker.prepareInput(initialInput, []);
    expect(turnInput).toHaveLength(1);

    tracker.markInputAsSent([], {
      filterApplied: true,
      allTurnItems: turnInput,
    });

    const nextTurnInput = tracker.prepareInput(initialInput, []);
    expect(nextTurnInput).toHaveLength(0);
  });

  it('clears pending initial inputs when filter outputs are empty without turn context', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_234',
    });

    tracker.prepareInput(toAgentInputList('secret'), []);
    tracker.markInputAsSent([], { filterApplied: true });

    const nextTurnInput = tracker.prepareInput([], []);
    expect(nextTurnInput).toHaveLength(0);
  });

  it('drops partially filtered initial inputs from subsequent turns', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_partial',
    });

    const keep: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'keep',
    };
    const drop: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'drop',
    };

    const turnInput = tracker.prepareInput([keep, drop], []);
    expect(turnInput).toHaveLength(2);

    tracker.markInputAsSent([keep], {
      filterApplied: true,
      allTurnItems: turnInput,
    });

    const nextTurnInput = tracker.prepareInput([keep, drop], []);
    expect(nextTurnInput).toHaveLength(0);
  });

  it('does not resend generated items when resuming from a serialized state', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_resume',
    });
    const initialInput = toAgentInputList('hello');
    const modelMessage = fakeModelMessage('hi there');

    const generatedItems = [
      new MessageOutputItem(structuredClone(modelMessage), TEST_AGENT),
    ];
    const modelResponses: ModelResponse[] = [
      {
        output: [structuredClone(modelMessage)],
        usage: new Usage(),
      },
    ];

    tracker.primeFromState({
      originalInput: initialInput,
      generatedItems,
      modelResponses,
    });

    const nextTurnInput = tracker.prepareInput(initialInput, generatedItems);
    expect(nextTurnInput).toHaveLength(0);
  });

  it('requeues initial inputs when resuming a server-managed conversation without responses', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_no_response',
    });
    const initialInput = toAgentInputList('needs resend');

    tracker.primeFromState({
      originalInput: initialInput,
      generatedItems: [],
      modelResponses: [],
    });

    const nextTurnInput = tracker.prepareInput(initialInput, []);
    expect(nextTurnInput).toHaveLength(1);
    expect(nextTurnInput[0]).toMatchObject({
      role: 'user',
      content: 'needs resend',
    });
  });

  it('requeues initial inputs when resuming without responses and no server conversation context', () => {
    const tracker = new ServerConversationTracker({});
    const initialInput = toAgentInputList('needs resend');

    tracker.primeFromState({
      originalInput: initialInput,
      generatedItems: [],
      modelResponses: [],
    });

    const nextTurnInput = tracker.prepareInput(initialInput, []);
    expect(nextTurnInput).toHaveLength(1);
    expect(nextTurnInput[0]).toMatchObject({
      role: 'user',
      content: 'needs resend',
    });
  });

  it('serializes and restores server-managed conversation identifiers', async () => {
    const state = new RunState(
      new RunContext<UnknownContext>(undefined as UnknownContext),
      'hello',
      TEST_AGENT as Agent<UnknownContext, AgentOutputType>,
      3,
    );
    state._conversationId = 'conv_abc';
    state._previousResponseId = 'resp_123';

    const restored = await RunState.fromString(
      TEST_AGENT as Agent<UnknownContext, AgentOutputType>,
      state.toString(),
    );

    expect(restored._conversationId).toBe('conv_abc');
    expect(restored._previousResponseId).toBe('resp_123');
  });

  it('reuses server-managed conversation state when resuming a run', async () => {
    const state = new RunState(
      new RunContext<UnknownContext>(undefined as UnknownContext),
      'hello',
      TEST_AGENT as Agent<UnknownContext, AgentOutputType>,
      3,
    );
    state._conversationId = 'conv_resume';
    state._previousResponseId = 'resp_prev';

    const prepareInputSpy = vi.spyOn(
      ServerConversationTracker.prototype,
      'prepareInput',
    );

    const runner = new Runner();
    const result = await runner.run(
      TEST_AGENT as Agent<UnknownContext, AgentOutputType>,
      state,
    );

    expect(prepareInputSpy).toHaveBeenCalled();
    expect(result.state._conversationId).toBe('conv_resume');
    expect(result.state._previousResponseId).toBe('resp_prev');

    prepareInputSpy.mockRestore();
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

    expect(result.preparedInput).toEqual(toAgentInputList('fresh input'));
    expect(result.sessionItems).toEqual(toAgentInputList('fresh input'));
  });

  it('warns and restores new inputs when callback drops them under server-managed conversations', async () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const session = new StubSession([]);
    const newItems: AgentInputItem[] = [
      { type: 'message', role: 'user', content: 'keep-me' },
    ];

    const result = await prepareInputItemsWithSession(
      newItems,
      session,
      () => [],
      {
        includeHistoryInPreparedInput: false,
        preserveDroppedNewItems: true,
      },
    );

    expect(result.preparedInput).toEqual(newItems);
    expect(result.sessionItems).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    const firstCallArgs = warnSpy.mock.calls[0];
    expect(firstCallArgs[0]).toContain('server-managed conversation');
    warnSpy.mockRestore();
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
      toAgentInputList(state._originalInput),
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
      shellActions: [],
      applyPatchActions: [],
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
      toAgentInputList(state._originalInput),
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
      shellActions: [],
      applyPatchActions: [],
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

    const functionResults = session.items.filter(
      (item): item is protocol.FunctionCallResultItem =>
        item.type === 'function_call_result',
    );
    const autoResults = functionResults.filter(
      (item) => item.callId === autoCall.callId,
    );
    expect(autoResults).toHaveLength(1);
    expect(
      functionResults.some((item) => item.callId === autoCall.callId),
    ).toBe(true);
    expect(
      functionResults.some((item) => item.callId === approvalCall.callId),
    ).toBe(true);
    expect(functionResults[functionResults.length - 1]?.callId).toBe(
      approvalCall.callId,
    );
  });

  it('propagates lastResponseId to sessions after persisting items', async () => {
    class TrackingSession implements Session {
      items: AgentInputItem[] = [];
      events: string[] = [];

      async getSessionId(): Promise<string> {
        return 'session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return [...this.items];
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.events.push(`addItems:${items.length}`);
        this.items.push(...items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return undefined;
      }

      async clearSession(): Promise<void> {
        this.items = [];
      }

      async runCompaction(
        args?: OpenAIResponsesCompactionArgs,
      ): Promise<OpenAIResponsesCompactionResult | null> {
        this.events.push(`runCompaction:${args?.responseId}`);
        return null;
      }
    }

    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'Recorder',
      outputType: 'text',
      instructions: 'capture',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const session = new TrackingSession();
    const context = new RunContext<UnknownContext>(undefined as UnknownContext);
    const state = new RunState<
      UnknownContext,
      Agent<UnknownContext, AgentOutputType>
    >(context, 'hello', agent, 10);

    state._modelResponses.push({
      output: [],
      usage: new Usage(),
      responseId: 'resp_123',
    });
    state._generatedItems = [
      new MessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_123',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'here is the reply',
            },
          ],
          providerData: {},
        },
        textAgent,
      ),
    ];
    state._currentStep = {
      type: 'next_step_final_output',
      output: 'here is the reply',
    };

    const result = new RunResult(state);
    await saveToSession(
      session,
      toAgentInputList(state._originalInput),
      result,
    );

    expect(session.events).toEqual(['addItems:2', 'runCompaction:resp_123']);
    expect(session.items).toHaveLength(2);
  });

  it('invokes runCompaction when responseId is undefined', async () => {
    class TrackingSession implements Session {
      items: AgentInputItem[] = [];
      events: string[] = [];

      async getSessionId(): Promise<string> {
        return 'session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return [...this.items];
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.events.push(`addItems:${items.length}`);
        this.items.push(...items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return undefined;
      }

      async clearSession(): Promise<void> {
        this.items = [];
      }

      async runCompaction(
        args?: OpenAIResponsesCompactionArgs,
      ): Promise<OpenAIResponsesCompactionResult | null> {
        this.events.push(`runCompaction:${args?.responseId}`);
        return null;
      }
    }

    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'Recorder',
      outputType: 'text',
      instructions: 'capture',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const session = new TrackingSession();
    const context = new RunContext<UnknownContext>(undefined as UnknownContext);
    const state = new RunState<
      UnknownContext,
      Agent<UnknownContext, AgentOutputType>
    >(context, 'hello', agent, 10);

    const modelUsage = new Usage({
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      requestUsageEntries: [
        new RequestUsage({
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          endpoint: 'responses.create',
        }),
      ],
    });
    state._modelResponses.push({
      output: [],
      usage: modelUsage,
    });
    state._context.usage.add(modelUsage);
    state._generatedItems = [
      new MessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_123',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'here is the reply',
            },
          ],
          providerData: {},
        },
        textAgent,
      ),
    ];
    state._currentStep = {
      type: 'next_step_final_output',
      output: 'here is the reply',
    };

    const result = new RunResult(state);
    await saveToSession(
      session,
      toAgentInputList(state._originalInput),
      result,
    );

    expect(session.events).toEqual(['addItems:2', 'runCompaction:undefined']);
    expect(state.usage.inputTokens).toBe(2);
    expect(state.usage.outputTokens).toBe(3);
    expect(state.usage.totalTokens).toBe(5);
    expect(
      state.usage.requestUsageEntries?.map((entry) => entry.endpoint),
    ).toEqual(['responses.create']);
  });

  it('adds compaction usage to the run state when returned', async () => {
    class TrackingSession implements Session {
      items: AgentInputItem[] = [];
      events: string[] = [];

      async getSessionId(): Promise<string> {
        return 'session';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return [...this.items];
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.events.push(`addItems:${items.length}`);
        this.items.push(...items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return undefined;
      }

      async clearSession(): Promise<void> {
        this.items = [];
      }

      async runCompaction(): Promise<OpenAIResponsesCompactionResult | null> {
        this.events.push('runCompaction:resp_123');
        return {
          usage: new RequestUsage({
            inputTokens: 4,
            outputTokens: 6,
            totalTokens: 10,
            endpoint: 'responses.compact',
          }),
        };
      }
    }

    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'Recorder',
      outputType: 'text',
      instructions: 'capture',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const session = new TrackingSession();
    const context = new RunContext<UnknownContext>(undefined as UnknownContext);
    const state = new RunState<
      UnknownContext,
      Agent<UnknownContext, AgentOutputType>
    >(context, 'hello', agent, 10);

    const modelUsage = new Usage({
      requests: 1,
      inputTokens: 2,
      outputTokens: 3,
      totalTokens: 5,
      requestUsageEntries: [
        new RequestUsage({
          inputTokens: 2,
          outputTokens: 3,
          totalTokens: 5,
          endpoint: 'responses.create',
        }),
      ],
    });
    state._modelResponses.push({
      output: [],
      usage: modelUsage,
      responseId: 'resp_123',
    });
    state._context.usage.add(modelUsage);
    state._generatedItems = [
      new MessageOutputItem(
        {
          type: 'message',
          role: 'assistant',
          id: 'msg_123',
          status: 'completed',
          content: [
            {
              type: 'output_text',
              text: 'here is the reply',
            },
          ],
          providerData: {},
        },
        textAgent,
      ),
    ];
    state._currentStep = {
      type: 'next_step_final_output',
      output: 'here is the reply',
    };

    const result = new RunResult(state);
    await saveToSession(
      session,
      toAgentInputList(state._originalInput),
      result,
    );

    expect(session.events).toEqual(['addItems:2', 'runCompaction:resp_123']);
    expect(state.usage.inputTokens).toBe(6);
    expect(state.usage.outputTokens).toBe(9);
    expect(state.usage.totalTokens).toBe(15);
    expect(
      state.usage.requestUsageEntries?.map((entry) => entry.endpoint),
    ).toEqual(['responses.create', 'responses.compact']);
  });
});
