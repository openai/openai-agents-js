import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  setDefaultModelProvider,
  setTracingDisabled,
  withTrace,
} from '../../src';
import { Agent, AgentOutputType } from '../../src/agent';
import {
  RunHandoffOutputItem as HandoffOutputItem,
  RunCompactionItem as CompactionItem,
  RunMessageOutputItem as MessageOutputItem,
  RunReasoningItem as ReasoningItem,
  RunToolApprovalItem as ToolApprovalItem,
  RunToolCallItem as ToolCallItem,
  RunToolCallOutputItem as ToolCallOutputItem,
  RunToolSearchCallItem as ToolSearchCallItem,
  RunToolSearchOutputItem as ToolSearchOutputItem,
} from '../../src/items';
import { ModelResponse } from '../../src/model';
import {
  prepareInputItemsWithSession,
  saveStreamInputToSession,
  saveStreamResultToSession,
  saveToSession,
} from '../../src/runner/sessionPersistence';
import { ServerConversationTracker } from '../../src/runner/conversation';
import { getToolCallOutputItem } from '../../src/runner/toolExecution';
import { getManagedConversationSupplementalItems } from '../../src/runner/turnPreparation';
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
import { allowConsole } from '../../../../helpers/tests/console-guard';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new FakeModelProvider());
});

function modelResponse(
  output: ModelResponse['output'],
  responseId?: string,
): ModelResponse {
  return {
    output: structuredClone(output),
    usage: new Usage(),
    responseId,
  };
}

function functionCall(
  callId: string,
  argumentsJson = '{}',
): protocol.FunctionCallItem {
  return {
    type: 'function_call',
    callId,
    name: 'test',
    arguments: argumentsJson,
  };
}

function functionResult(
  call: protocol.FunctionCallItem,
  output: string,
): ToolCallOutputItem {
  return new ToolCallOutputItem(
    {
      type: 'function_call_result',
      callId: call.callId,
      name: call.name,
      status: 'completed',
      output,
    },
    TEST_AGENT,
    output,
  );
}

function shellCall(callId: string, command: string): protocol.ShellCallItem {
  return {
    type: 'shell_call',
    callId,
    status: 'completed',
    action: { commands: [command] },
  };
}

function shellOutput(
  callId: string,
  stdout: string,
): protocol.ShellCallResultItem {
  return {
    type: 'shell_call_output',
    callId,
    output: [
      {
        stdout,
        stderr: '',
        outcome: { type: 'exit', exitCode: 0 },
      },
    ],
  };
}

function toolSearchCall({
  itemId,
  callId,
  execution,
}: {
  itemId: string;
  callId?: string;
  execution: 'client' | 'server';
}): protocol.ToolSearchCallItem {
  return {
    type: 'tool_search_call',
    id: itemId,
    arguments: execution === 'client' ? { paths: ['crm'] } : { query: 'crm' },
    execution,
    providerData: { ...(callId ? { call_id: callId } : {}), execution },
  };
}

function toolSearchOutput({
  itemId,
  callId,
  execution,
}: {
  itemId?: string;
  callId?: string;
  execution: 'client' | 'server';
}): protocol.ToolSearchOutputItem {
  return {
    type: 'tool_search_output',
    id: itemId,
    execution,
    status: 'completed',
    tools: [],
    providerData: { ...(callId ? { call_id: callId } : {}), execution },
  };
}

function mcpApprovalRequest(
  itemId: string,
  approvalRequestId: string,
): protocol.HostedToolCallItem {
  return {
    type: 'hosted_tool_call',
    id: itemId,
    name: 'mcp_approval_request',
    providerData: {
      type: 'mcp_approval_request',
      id: approvalRequestId,
    },
  };
}

function mcpApprovalResponse(id: string): protocol.HostedToolCallItem {
  return {
    type: 'hosted_tool_call',
    name: 'mcp_approval_response',
    providerData: {
      approve: true,
      approval_request_id: id,
    },
  };
}

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

  it('uses the latest non-empty responseId when resuming without conversationId', () => {
    const tracker = new ServerConversationTracker({});

    tracker.primeFromState({
      originalInput: [],
      generatedItems: [],
      modelResponses: [
        {
          output: [],
          usage: new Usage(),
          responseId: 'resp_first',
        },
        {
          output: [],
          usage: new Usage(),
          responseId: 'resp_second',
        },
        {
          output: [],
          usage: new Usage(),
        },
      ],
    });

    expect(tracker.previousResponseId).toBe('resp_second');
  });

  it('applies reasoningItemIdPolicy when preparing generated reasoning items', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv-3',
      reasoningItemIdPolicy: 'omit',
    });
    const generatedItems = [
      new ReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_turn_input',
          content: [{ type: 'input_text', text: 'reasoning trace' }],
        },
        TEST_AGENT,
      ),
    ];

    const prepared = tracker.prepareInput([], generatedItems);
    expect(prepared).toEqual([
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'reasoning trace' }],
      },
    ]);
  });

  it('does not resend generated reasoning items after marking omitted IDs as sent', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv-4',
      reasoningItemIdPolicy: 'omit',
    });
    const generatedItems = [
      new ReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_turn_input',
          content: [{ type: 'input_text', text: 'reasoning trace' }],
        },
        TEST_AGENT,
      ),
    ];

    const firstPrepared = tracker.prepareInput([], generatedItems);
    expect(firstPrepared).toEqual([
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'reasoning trace' }],
      },
    ]);

    tracker.markInputAsSent(firstPrepared);

    const secondPrepared = tracker.prepareInput([], generatedItems);
    expect(secondPrepared).toEqual([]);
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

  it('persists reasoning items without IDs when reasoningItemIdPolicy omits them', async () => {
    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'StreamerReasoning',
      outputType: 'text',
      instructions: 'stream reasoning test',
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
    state.setReasoningItemIdPolicy('omit');

    state._modelResponses.push({
      output: [],
      usage: new Usage(),
      responseId: 'resp_reasoning',
    });
    state._generatedItems = [
      new ReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_stream',
          content: [{ type: 'input_text', text: 'thinking' }],
        },
        textAgent,
      ),
    ];

    const streamedResult = new StreamedRunResult({
      state,
    });

    await saveStreamResultToSession(session, streamedResult);

    expect(session.items).toEqual([
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'thinking' }],
      },
    ]);
  });

  it('preserves streamed reasoning IDs when the session requires them', async () => {
    class ReasoningPreservingSession extends TrackingSession {
      preserveReasoningItemIdsForPersistence(): boolean {
        return true;
      }
    }

    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'StreamerReasoningPreserve',
      outputType: 'text',
      instructions: 'stream reasoning test',
    });
    const agent = textAgent as unknown as Agent<
      UnknownContext,
      AgentOutputType
    >;
    const session = new ReasoningPreservingSession();
    const context = new RunContext<UnknownContext>(undefined as UnknownContext);
    const state = new RunState<
      UnknownContext,
      Agent<UnknownContext, AgentOutputType>
    >(context, 'hello', agent, 10);
    state.setReasoningItemIdPolicy('omit');

    state._modelResponses.push({
      output: [],
      usage: new Usage(),
      responseId: 'resp_reasoning',
    });
    state._generatedItems = [
      new ReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_stream',
          content: [{ type: 'input_text', text: 'thinking' }],
        },
        textAgent,
      ),
    ];

    const streamedResult = new StreamedRunResult({
      state,
    });

    await saveStreamResultToSession(session, streamedResult);

    expect(session.items).toEqual([
      {
        type: 'reasoning',
        id: 'rs_stream',
        content: [{ type: 'input_text', text: 'thinking' }],
      },
    ]);
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

  it('drops acknowledged results while preserving latest results when call IDs are reused', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_reused_call_id',
    });
    const previousCall = functionCall('reused-call', '{"value":"previous"}');
    const latestCall = functionCall('reused-call', '{"value":"latest"}');
    const previousResult = functionResult(previousCall, 'previous result');
    const latestResult = functionResult(latestCall, 'latest result');
    const generatedItems = [
      new ToolCallItem(previousCall, TEST_AGENT),
      previousResult,
      new ToolCallItem(latestCall, TEST_AGENT),
      latestResult,
    ];

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [
        modelResponse([previousCall], 'resp_previous'),
        modelResponse([latestCall], 'resp_latest'),
      ],
    });

    expect(tracker.prepareInput('hello', generatedItems)).toEqual([
      latestResult.rawItem,
    ]);
  });

  it('preserves every result generated for calls in the latest response', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_multiple_pending_results',
    });
    const calls = ['call-1', 'call-2'].map((callId) => functionCall(callId));
    const results = calls.map((call) =>
      functionResult(call, `${call.callId} result`),
    );
    const generatedItems = calls.flatMap((call, index) => [
      new ToolCallItem(call, TEST_AGENT),
      results[index]!,
    ]);

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [modelResponse(calls, 'resp_latest')],
    });

    expect(tracker.prepareInput('hello', generatedItems)).toEqual(
      results.map((result) => result.rawItem),
    );
  });

  it('preserves results acknowledged only by a response without an ID', () => {
    const tracker = new ServerConversationTracker({
      previousResponseId: 'resp_initial',
    });
    const toolCall = functionCall('call_unlinked_response');
    const toolResult = functionResult(toolCall, 'done');
    const finalMessage = fakeModelMessage('done');
    const generatedItems = [
      new ToolCallItem(toolCall, TEST_AGENT),
      toolResult,
      new MessageOutputItem(finalMessage, TEST_AGENT),
    ];

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [
        modelResponse([toolCall], 'resp_tool_call'),
        modelResponse([finalMessage]),
      ],
    });

    expect(tracker.previousResponseId).toBe('resp_tool_call');
    expect(tracker.prepareInput('hello', generatedItems)).toEqual([
      toolResult.rawItem,
    ]);
  });

  it('drops acknowledged client tool search outputs after a later response', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_client_tool_search',
    });
    const searchCall = toolSearchCall({
      itemId: 'tool-search-item',
      callId: 'tool-search-call',
      execution: 'client',
    });
    const searchOutput = toolSearchOutput({
      callId: 'tool-search-call',
      execution: 'client',
    });
    const finalMessage = fakeModelMessage('done');
    const generatedItems = [
      new ToolSearchCallItem(searchCall, TEST_AGENT),
      new ToolSearchOutputItem(searchOutput, TEST_AGENT),
      new MessageOutputItem(finalMessage, TEST_AGENT),
    ];

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [
        modelResponse([searchCall], 'resp_tool_search'),
        modelResponse([finalMessage], 'resp_final'),
      ],
    });

    expect(tracker.prepareInput('hello', generatedItems)).toEqual([]);
  });

  it('preserves client tool search outputs when a server call reuses the ID', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_mixed_tool_search_execution',
    });
    const sharedCallId = 'shared-tool-search-call';
    const serverCall = toolSearchCall({
      itemId: 'server-tool-search-call',
      callId: sharedCallId,
      execution: 'server',
    });
    const serverOutput = toolSearchOutput({
      itemId: 'server-tool-search-output',
      callId: sharedCallId,
      execution: 'server',
    });
    const clientCall = toolSearchCall({
      itemId: 'client-tool-search-call',
      callId: sharedCallId,
      execution: 'client',
    });
    const clientOutput = new ToolSearchOutputItem(
      toolSearchOutput({ callId: sharedCallId, execution: 'client' }),
      TEST_AGENT,
    );
    const generatedItems = [
      new ToolSearchCallItem(serverCall, TEST_AGENT),
      new ToolSearchOutputItem(serverOutput, TEST_AGENT),
      new ToolSearchCallItem(clientCall, TEST_AGENT),
      clientOutput,
    ];

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [
        modelResponse([serverCall, serverOutput], 'resp_server_tool_search'),
        modelResponse([clientCall], 'resp_client_tool_search'),
      ],
    });

    expect(tracker.prepareInput('hello', generatedItems)).toEqual([
      clientOutput.rawItem,
    ]);
  });

  it('does not replay acknowledged client tool search outputs when a later server output reuses the ID', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_later_server_tool_search_output',
    });
    const sharedCallId = 'shared-later-server-tool-search';
    const clientCall = toolSearchCall({
      itemId: 'client-tool-search-call',
      callId: sharedCallId,
      execution: 'client',
    });
    const clientOutput = new ToolSearchOutputItem(
      toolSearchOutput({ callId: sharedCallId, execution: 'client' }),
      TEST_AGENT,
    );
    const serverOutput = toolSearchOutput({
      itemId: 'server-tool-search-output',
      callId: sharedCallId,
      execution: 'server',
    });
    const generatedItems = [
      new ToolSearchCallItem(clientCall, TEST_AGENT),
      clientOutput,
      new ToolSearchOutputItem(serverOutput, TEST_AGENT),
    ];

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [
        modelResponse([clientCall], 'resp_client_tool_search'),
        modelResponse([serverOutput], 'resp_server_tool_search_output'),
      ],
    });

    expect(tracker.prepareInput('hello', generatedItems)).toEqual([]);
  });

  it('matches call-id-less client tool search outputs by response order', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_ordered_tool_search',
    });
    const sharedCallId = 'shared-ordered-tool-search';
    const previousCall = toolSearchCall({
      itemId: sharedCallId,
      execution: 'client',
    });
    const previousOutput = toolSearchOutput({
      itemId: 'previous-tool-search-output',
      execution: 'client',
    });
    const latestCall = toolSearchCall({
      itemId: sharedCallId,
      execution: 'client',
    });
    const latestOutput = new ToolSearchOutputItem(
      toolSearchOutput({ callId: sharedCallId, execution: 'client' }),
      TEST_AGENT,
    );
    const generatedItems = [
      new ToolSearchCallItem(previousCall, TEST_AGENT),
      new ToolSearchOutputItem(previousOutput, TEST_AGENT),
      new ToolSearchCallItem(latestCall, TEST_AGENT),
      latestOutput,
    ];

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [
        modelResponse(
          [previousCall, previousOutput],
          'resp_previous_tool_search',
        ),
        modelResponse([latestCall], 'resp_latest_tool_search'),
      ],
    });

    expect(tracker.prepareInput('hello', generatedItems)).toEqual([
      latestOutput.rawItem,
    ]);
  });

  it('preserves local shell outputs when a provider result reuses the ID', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_mixed_shell_execution',
    });
    const sharedCallId = 'shared-shell-call';
    const providerCall = shellCall(sharedCallId, 'echo provider');
    const providerOutput = shellOutput(sharedCallId, 'provider');
    const localCall = shellCall(sharedCallId, 'echo local');
    const localOutput = new ToolCallOutputItem(
      shellOutput(sharedCallId, 'local'),
      TEST_AGENT,
      'local',
    );
    const generatedItems = [
      new ToolCallItem(providerCall, TEST_AGENT),
      new ToolCallOutputItem(providerOutput, TEST_AGENT, providerOutput.output),
      new ToolCallItem(localCall, TEST_AGENT),
      localOutput,
    ];

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [
        modelResponse([providerCall, providerOutput], 'resp_provider_shell'),
        modelResponse([localCall], 'resp_local_shell'),
      ],
    });

    expect(tracker.prepareInput('hello', generatedItems)).toEqual([
      localOutput.rawItem,
    ]);
  });

  it('does not replay acknowledged local shell outputs when a later provider result reuses the ID', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_later_provider_shell_result',
    });
    const sharedCallId = 'shared-later-provider-shell';
    const localCall = shellCall(sharedCallId, 'echo local');
    const localOutput = new ToolCallOutputItem(
      shellOutput(sharedCallId, 'local'),
      TEST_AGENT,
      'local',
    );
    const providerCall = shellCall(sharedCallId, 'echo provider');
    const providerOutput = shellOutput(sharedCallId, 'provider');
    const generatedItems = [
      new ToolCallItem(localCall, TEST_AGENT),
      localOutput,
      new ToolCallItem(providerCall, TEST_AGENT),
      new ToolCallOutputItem(providerOutput, TEST_AGENT, providerOutput.output),
    ];

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [
        modelResponse([localCall], 'resp_local_shell'),
        modelResponse([providerCall, providerOutput], 'resp_provider_shell'),
      ],
    });

    expect(tracker.prepareInput('hello', generatedItems)).toEqual([]);
  });

  it('drops acknowledged hosted MCP approval responses while preserving the latest response', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_mcp_approvals',
    });
    const previousRequest = mcpApprovalRequest(
      'approval_item_previous',
      'approval_previous',
    );
    const latestRequest = mcpApprovalRequest(
      'approval_item_latest',
      'approval_latest',
    );
    const previousResponse = new ToolCallItem(
      mcpApprovalResponse('approval_previous'),
      TEST_AGENT,
    );
    const latestResponse = new ToolCallItem(
      mcpApprovalResponse('approval_latest'),
      TEST_AGENT,
    );
    const generatedItems = [
      new ToolCallItem(previousRequest, TEST_AGENT),
      previousResponse,
      new ToolCallItem(latestRequest, TEST_AGENT),
      latestResponse,
    ];

    tracker.primeFromState({
      originalInput: 'hello',
      generatedItems,
      modelResponses: [
        modelResponse([previousRequest], 'resp_previous'),
        modelResponse([latestRequest], 'resp_latest'),
      ],
    });

    expect(tracker.prepareInput('hello', generatedItems)).toEqual([
      latestResponse.rawItem,
    ]);
  });

  it('does not resend supplemental generated items after they were marked sent', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_supplemental_sent',
    });
    const supplementalResult: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'transfer_to_managed_c',
      callId: 'handoff-ignored',
      status: 'completed',
      output: {
        type: 'text',
        text: 'Multiple handoffs detected, ignoring this one.',
      },
    };

    const firstPrepared = tracker.prepareInput([], [], [supplementalResult]);
    expect(firstPrepared).toEqual([supplementalResult]);

    tracker.markInputAsSent(firstPrepared);

    const secondPrepared = tracker.prepareInput([], [], [supplementalResult]);
    expect(secondPrepared).toEqual([]);
  });

  it('preserves current-turn supplemental items when resuming before they were sent', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_supplemental_resume',
    });
    const initialInput = toAgentInputList('hello');
    const supplementalResult: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      name: 'transfer_to_managed_c',
      callId: 'handoff-ignored',
      status: 'completed',
      output: {
        type: 'text',
        text: 'Multiple handoffs detected, ignoring this one.',
      },
    };

    tracker.primeFromState({
      originalInput: initialInput,
      generatedItems: [],
      modelResponses: [
        {
          output: [fakeModelMessage('handoff')],
          usage: new Usage(),
        },
      ],
    });

    const nextTurnInput = tracker.prepareInput([], [], [supplementalResult]);
    expect(nextTurnInput).toEqual([supplementalResult]);
  });

  it('creates fresh supplemental items for later responses with the same ignored handoff signature', () => {
    const tracker = new ServerConversationTracker({
      conversationId: 'conv_supplemental_later_response',
    });
    const state = new RunState(
      new RunContext<UnknownContext>(undefined as UnknownContext),
      'hello',
      TEST_AGENT as Agent<UnknownContext, AgentOutputType>,
      3,
    );
    const makeProcessedResponse = (): ProcessedResponse<UnknownContext> => ({
      newItems: [],
      handoffs: [
        {
          toolCall: {
            type: 'function_call',
            id: 'handoff-accepted',
            name: 'transfer_to_managed_b',
            callId: 'handoff-accepted',
            status: 'completed',
            arguments: '{}',
          },
          handoff: {} as any,
        },
        {
          toolCall: {
            type: 'function_call',
            id: 'handoff-ignored',
            name: 'transfer_to_managed_c',
            callId: 'handoff-ignored',
            status: 'completed',
            arguments: '{}',
          },
          handoff: {} as any,
        },
      ],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    });
    state._generatedItems = [
      new HandoffOutputItem(
        {
          type: 'function_call_result',
          name: 'transfer_to_managed_b',
          callId: 'handoff-accepted',
          status: 'completed',
          output: {
            type: 'text',
            text: 'Transferred to ManagedB',
          },
        },
        TEST_AGENT as Agent<UnknownContext, AgentOutputType>,
        TEST_AGENT as Agent<UnknownContext, AgentOutputType>,
      ),
    ];

    state._lastProcessedResponse = makeProcessedResponse();
    const firstSupplementalItems =
      getManagedConversationSupplementalItems(state);
    tracker.markInputAsSent(
      tracker.prepareInput([], [], firstSupplementalItems),
    );

    state._lastProcessedResponse = makeProcessedResponse();
    const secondSupplementalItems =
      getManagedConversationSupplementalItems(state);

    expect(secondSupplementalItems).not.toBe(firstSupplementalItems);
    expect(secondSupplementalItems[0]).not.toBe(firstSupplementalItems[0]);
    expect(tracker.prepareInput([], [], secondSupplementalItems)).toEqual(
      secondSupplementalItems,
    );
  });

  it('does not create supplemental items when the accepted handoff output was filtered out', () => {
    const state = new RunState(
      new RunContext<UnknownContext>(undefined as UnknownContext),
      'hello',
      TEST_AGENT as Agent<UnknownContext, AgentOutputType>,
      3,
    );

    state._lastProcessedResponse = {
      newItems: [],
      handoffs: [
        {
          toolCall: {
            type: 'function_call',
            id: 'handoff-accepted',
            name: 'transfer_to_managed_b',
            callId: 'handoff-accepted',
            status: 'completed',
            arguments: '{}',
          },
          handoff: {} as any,
        },
        {
          toolCall: {
            type: 'function_call',
            id: 'handoff-ignored',
            name: 'transfer_to_managed_c',
            callId: 'handoff-ignored',
            status: 'completed',
            arguments: '{}',
          },
          handoff: {} as any,
        },
      ],
      functions: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [],
      hasToolsOrApprovalsToRun: () => true,
    };

    expect(getManagedConversationSupplementalItems(state)).toEqual([]);
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

  class AssistantReplaySanitizingSession extends StubSession {
    prepareHistoryItemForModelInput(item: AgentInputItem): AgentInputItem {
      if (
        !item ||
        typeof item !== 'object' ||
        Array.isArray(item) ||
        item.type !== 'message' ||
        item.role !== 'assistant'
      ) {
        return item;
      }

      const {
        id: _id,
        providerData: _providerData,
        provider_data: _provider_data,
        ...rest
      } = item as Record<string, unknown>;
      return rest as AgentInputItem;
    }
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

  it('uses only session history at and after the latest compaction', async () => {
    const oldHistory: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'old history',
    };
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_session_input',
      encrypted_content: 'ciphertext',
    };
    const retainedHistory: AgentInputItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'retained history' }],
    };
    const session = new StubSession([oldHistory, compaction, retainedHistory]);

    const result = await prepareInputItemsWithSession('new', session);

    expect(result.preparedInput).toEqual([
      compaction,
      retainedHistory,
      ...toAgentInputList('new'),
    ]);
  });

  it('rejects malformed compacted history before invoking the input callback', async () => {
    const malformedCompaction = {
      type: 'compaction',
      id: 'cmp_malformed_stored_history',
    } as AgentInputItem;
    const session = new StubSession([malformedCompaction]);
    const callback = vi.fn((history: AgentInputItem[]) => history);

    await expect(
      prepareInputItemsWithSession('new', session, callback),
    ).rejects.toThrow('Compaction item missing encrypted_content');
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects a malformed explicit marker before a later valid marker', async () => {
    const malformedCompaction = {
      type: 'compaction',
      id: 'cmp_malformed_explicit_input',
    } as AgentInputItem;
    const validCompaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_valid_explicit_input',
      encrypted_content: 'ciphertext',
    };

    await expect(
      prepareInputItemsWithSession([malformedCompaction, validCompaction]),
    ).rejects.toThrow('Compaction item missing encrypted_content');
  });

  it('rejects an explicit compaction marker with a malformed id', async () => {
    const malformedCompaction = {
      type: 'compaction',
      id: 7,
      encrypted_content: 'ciphertext',
    } as unknown as AgentInputItem;

    await expect(
      prepareInputItemsWithSession([malformedCompaction]),
    ).rejects.toThrow('Compaction item missing encrypted_content');
  });

  it('rejects malformed explicit input before invoking the input callback', async () => {
    const malformedCompaction = {
      type: 'compaction',
      id: 'cmp_malformed_explicit_callback_input',
    } as AgentInputItem;
    const callback = vi.fn(
      (history: AgentInputItem[], newItems: AgentInputItem[]) => [
        ...history,
        ...newItems,
      ],
    );

    await expect(
      prepareInputItemsWithSession(
        [malformedCompaction],
        new StubSession([]),
        callback,
      ),
    ).rejects.toThrow('Compaction item missing encrypted_content');
    expect(callback).not.toHaveBeenCalled();
  });

  it('rejects a malformed callback marker before a later valid marker', async () => {
    const malformedCompaction = {
      type: 'compaction',
      id: 'cmp_malformed_callback_output',
    } as AgentInputItem;
    const validCompaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_valid_callback_output',
      encrypted_content: 'ciphertext',
    };
    const callback = vi.fn(() => [malformedCompaction, validCompaction]);

    await expect(
      prepareInputItemsWithSession('new', new StubSession([]), callback),
    ).rejects.toThrow('Compaction item missing encrypted_content');
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it('passes only compacted session history to the input callback', async () => {
    const oldHistory: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'old history',
    };
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_session_callback',
      encrypted_content: 'ciphertext',
    };
    const retainedHistory: AgentInputItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'retained history' }],
    };
    const session = new StubSession([oldHistory, compaction, retainedHistory]);

    const result = await prepareInputItemsWithSession(
      'new',
      session,
      (history, newItems) => {
        expect(history).toEqual([compaction, retainedHistory]);
        return [...history, ...newItems];
      },
    );

    expect(result.preparedInput).toEqual([
      compaction,
      retainedHistory,
      ...toAgentInputList('new'),
    ]);
  });

  it('sanitizes assistant history items before model input when the session requests it', async () => {
    const userHistoryItem: AgentInputItem = {
      id: 'conv-user',
      type: 'message',
      role: 'user',
      content: 'user history',
      providerData: { server: 'metadata' },
    };
    const assistantHistoryItem: AgentInputItem = {
      id: 'conv-assistant',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      phase: 'commentary',
      content: [
        {
          type: 'output_text',
          text: 'assistant history',
        },
      ],
      providerData: { server: 'metadata' },
    };
    const functionCallItem: AgentInputItem = {
      id: 'conv-call',
      type: 'function_call',
      name: 'lookup',
      callId: 'call-history',
      arguments: '{}',
      status: 'completed',
    };
    const functionCallOutputItem: AgentInputItem = {
      id: 'conv-output',
      type: 'function_call_result',
      name: 'lookup',
      callId: 'call-history',
      output: 'ok',
      status: 'completed',
    };
    const session = new AssistantReplaySanitizingSession([
      userHistoryItem,
      assistantHistoryItem,
      functionCallItem,
      functionCallOutputItem,
    ]);

    const result = await prepareInputItemsWithSession('new', session);

    expect(result.preparedInput).toEqual([
      userHistoryItem,
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        phase: 'commentary',
        content: [
          {
            type: 'output_text',
            text: 'assistant history',
          },
        ],
      },
      functionCallItem,
      functionCallOutputItem,
      ...toAgentInputList('new'),
    ]);
    expect(result.sessionItems).toEqual(toAgentInputList('new'));
  });

  it('strips persisted reasoning IDs from model input when policy omits them', async () => {
    const reasoningHistoryItem: AgentInputItem = {
      id: 'rs_persisted',
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'thinking' }],
    };
    const session = new StubSession([reasoningHistoryItem]);

    const result = await prepareInputItemsWithSession(
      'new',
      session,
      undefined,
      {
        reasoningItemIdPolicy: 'omit',
      },
    );

    expect(result.preparedInput).toEqual([
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'thinking' }],
      },
      ...toAgentInputList('new'),
    ]);
    expect(result.sessionItems).toEqual(toAgentInputList('new'));
  });

  it('matches sanitized assistant history returned by callbacks without re-persisting it', async () => {
    const assistantHistoryItem: AgentInputItem = {
      id: 'conv-assistant',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [
        {
          type: 'output_text',
          text: 'assistant history',
        },
      ],
      providerData: { server: 'metadata' },
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'new',
    };
    const session = new AssistantReplaySanitizingSession([
      assistantHistoryItem,
    ]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => {
        const {
          id: _id,
          providerData: _providerData,
          ...historyCopy
        } = history[0] as Record<string, unknown>;
        return [historyCopy as AgentInputItem, { ...newItems[0] }];
      },
    );

    expect(result.preparedInput).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'assistant history',
          },
        ],
      },
      newItem,
    ]);
    expect(result.sessionItems).toEqual([newItem]);
  });

  it('matches callback-returned reasoning history after policy-based id stripping', async () => {
    const reasoningHistoryItem: AgentInputItem = {
      id: 'rs_persisted',
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'thinking' }],
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'new',
    };
    const session = new StubSession([reasoningHistoryItem]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => {
        const { id: _id, ...historyWithoutId } = history[0] as Record<
          string,
          unknown
        >;
        return [historyWithoutId as AgentInputItem, { ...newItems[0] }];
      },
      {
        reasoningItemIdPolicy: 'omit',
      },
    );

    expect(result.preparedInput).toEqual([
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'thinking' }],
      },
      newItem,
    ]);
    expect(result.sessionItems).toEqual([newItem]);
  });

  it('matches cloned callback reasoning history with persisted ids when policy omits them', async () => {
    const reasoningHistoryItem: AgentInputItem = {
      id: 'rs_persisted',
      type: 'reasoning',
      content: [{ type: 'input_text', text: 'thinking' }],
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'new',
    };
    const session = new StubSession([reasoningHistoryItem]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => [{ ...history[0] }, { ...newItems[0] }],
      {
        reasoningItemIdPolicy: 'omit',
      },
    );

    expect(result.preparedInput).toEqual([
      {
        type: 'reasoning',
        content: [{ type: 'input_text', text: 'thinking' }],
      },
      newItem,
    ]);
    expect(result.sessionItems).toEqual([newItem]);
  });

  it('keeps sanitized user history distinct when callbacks remove its id', async () => {
    const userHistoryItem: AgentInputItem = {
      id: 'conv-user',
      type: 'message',
      role: 'user',
      content: 'user history',
      providerData: { server: 'metadata' },
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'new',
    };
    const session = new AssistantReplaySanitizingSession([userHistoryItem]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => {
        const {
          id: _id,
          providerData: _providerData,
          ...historyCopy
        } = history[0] as Record<string, unknown>;
        return [historyCopy as AgentInputItem, { ...newItems[0] }];
      },
    );

    expect(result.preparedInput).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'user history',
      },
      newItem,
    ]);
    expect(result.sessionItems).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'user history',
      },
      newItem,
    ]);
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

  it('drops orphan hosted shell calls from session history when no callback is provided', async () => {
    const historyShell: AgentInputItem = {
      type: 'shell_call',
      callId: 'shell_1',
      status: 'completed',
      action: { commands: ['echo hi'] },
    };
    const session = new StubSession([historyShell]);

    const result = await prepareInputItemsWithSession('fresh input', session);

    expect(result.preparedInput).toEqual(toAgentInputList('fresh input'));
    expect(result.sessionItems).toEqual(toAgentInputList('fresh input'));
  });

  it('keeps resumable programs when callbacks drop only the program output', async () => {
    const program: AgentInputItem = {
      type: 'program',
      callId: 'program_1',
      code: 'return "done";',
      fingerprint: 'fingerprint:program-1',
    };
    const programOutput: AgentInputItem = {
      type: 'program_output',
      callId: 'program_1',
      output: 'done',
      status: 'completed',
    };
    const functionCall: AgentInputItem = {
      type: 'function_call',
      callId: 'lookup_1',
      name: 'lookup',
      arguments: '{}',
      caller: { type: 'program', callerId: 'program_1' },
    };
    const functionOutput: AgentInputItem = {
      type: 'function_call_result',
      callId: 'lookup_1',
      name: 'lookup',
      status: 'completed',
      output: 'done',
      caller: { type: 'program', callerId: 'program_1' },
    };
    const hostedCall: AgentInputItem = {
      type: 'hosted_tool_call',
      id: 'ci_1',
      name: 'code_interpreter_call',
      status: 'completed',
      caller: { type: 'program', callerId: 'program_1' },
      providerData: { type: 'code_interpreter_call' },
    };
    const session = new StubSession([
      program,
      functionCall,
      functionOutput,
      hostedCall,
      programOutput,
    ]);

    const result = await prepareInputItemsWithSession(
      'fresh input',
      session,
      (history, newItems) => [...history.slice(0, -1), ...newItems],
    );

    expect(result.preparedInput).toEqual([
      program,
      functionCall,
      functionOutput,
      hostedCall,
      ...toAgentInputList('fresh input'),
    ]);
    expect(result.sessionItems).toEqual(toAgentInputList('fresh input'));
  });

  it('drops program outputs when callbacks remove their program calls', async () => {
    const program: AgentInputItem = {
      type: 'program',
      callId: 'program_orphan',
      code: 'return "done";',
      fingerprint: 'fingerprint:orphan',
    };
    const programOutput: AgentInputItem = {
      type: 'program_output',
      callId: 'program_orphan',
      output: 'done',
      status: 'completed',
    };
    const session = new StubSession([program, programOutput]);

    const result = await prepareInputItemsWithSession(
      'fresh input',
      session,
      (history, newItems) => [history[1]!, ...newItems],
    );

    expect(result.preparedInput).toEqual(toAgentInputList('fresh input'));
    expect(result.sessionItems).toEqual(toAgentInputList('fresh input'));
  });

  it('drops program-owned pairs when callbacks remove their program calls', async () => {
    const program: AgentInputItem = {
      type: 'program',
      callId: 'program_orphan',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:orphan',
    };
    const functionCall: AgentInputItem = {
      type: 'function_call',
      callId: 'lookup_orphan',
      name: 'lookup',
      arguments: '{}',
      caller: { type: 'program', callerId: 'program_orphan' },
    };
    const functionOutput: AgentInputItem = {
      type: 'function_call_result',
      callId: 'lookup_orphan',
      name: 'lookup',
      status: 'completed',
      output: 'done',
      caller: { type: 'program', callerId: 'program_orphan' },
    };
    const programOutput: AgentInputItem = {
      type: 'program_output',
      callId: 'program_orphan',
      output: 'done',
      status: 'completed',
    };
    const session = new StubSession([
      program,
      functionCall,
      functionOutput,
      programOutput,
    ]);

    const result = await prepareInputItemsWithSession(
      'fresh input',
      session,
      (history, newItems) => [...history.slice(1), ...newItems],
    );

    expect(result.preparedInput).toEqual(toAgentInputList('fresh input'));
    expect(result.sessionItems).toEqual(toAgentInputList('fresh input'));
  });

  it('drops dangling owned results from completed session programs', async () => {
    const program: AgentInputItem = {
      type: 'program',
      callId: 'program_completed',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:completed',
    };
    const functionCall: AgentInputItem = {
      type: 'function_call',
      callId: 'lookup_completed',
      name: 'lookup',
      arguments: '{}',
      caller: { type: 'program', callerId: 'program_completed' },
    };
    const functionOutput: AgentInputItem = {
      type: 'function_call_result',
      callId: 'lookup_completed',
      name: 'lookup',
      status: 'completed',
      output: 'done',
      caller: { type: 'program', callerId: 'program_completed' },
    };
    const programOutput: AgentInputItem = {
      type: 'program_output',
      callId: 'program_completed',
      output: 'done',
      status: 'completed',
    };
    const session = new StubSession([
      program,
      functionCall,
      functionOutput,
      programOutput,
    ]);

    const result = await prepareInputItemsWithSession(
      'fresh input',
      session,
      (history, newItems) => [history[0]!, ...history.slice(2), ...newItems],
    );

    expect(result.preparedInput).toEqual([
      program,
      programOutput,
      ...toAgentInputList('fresh input'),
    ]);
    expect(result.sessionItems).toEqual(toAgentInputList('fresh input'));
  });

  it('drops pending programs with incomplete owned calls from session history', async () => {
    const program: AgentInputItem = {
      type: 'program',
      callId: 'program_orphan',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:orphan',
    };
    const functionCall: AgentInputItem = {
      type: 'function_call',
      callId: 'lookup_orphan',
      name: 'lookup',
      arguments: '{}',
      caller: { type: 'program', callerId: 'program_orphan' },
    };
    const session = new StubSession([program, functionCall]);

    const result = await prepareInputItemsWithSession('fresh input', session);

    expect(result.preparedInput).toEqual(toAgentInputList('fresh input'));
    expect(result.sessionItems).toEqual(toAgentInputList('fresh input'));
  });

  it('keeps pending programs with completed owned pairs in session history', async () => {
    const program: AgentInputItem = {
      type: 'program',
      callId: 'program_pending',
      code: 'return await tools.lookup({});',
      fingerprint: 'fingerprint:pending',
    };
    const functionCall: AgentInputItem = {
      type: 'function_call',
      callId: 'lookup_1',
      name: 'lookup',
      arguments: '{}',
      caller: { type: 'program', callerId: 'program_pending' },
    };
    const functionOutput: AgentInputItem = {
      type: 'function_call_result',
      callId: 'lookup_1',
      name: 'lookup',
      status: 'completed',
      output: 'done',
      caller: { type: 'program', callerId: 'program_pending' },
    };
    const session = new StubSession([program, functionCall, functionOutput]);

    const result = await prepareInputItemsWithSession('fresh input', session);

    expect(result.preparedInput).toEqual([
      program,
      functionCall,
      functionOutput,
      ...toAgentInputList('fresh input'),
    ]);
    expect(result.sessionItems).toEqual(toAgentInputList('fresh input'));
  });

  it('preserves caller pending shell calls when callbacks also surface orphan history', async () => {
    const historyShell: AgentInputItem = {
      type: 'shell_call',
      callId: 'history_shell',
      status: 'completed',
      action: { commands: ['echo old'] },
    };
    const pendingShell: AgentInputItem = {
      type: 'shell_call',
      callId: 'pending_shell',
      status: 'in_progress',
      action: { commands: ['echo new'] },
    };
    const session = new StubSession([historyShell]);

    const result = await prepareInputItemsWithSession(
      [pendingShell],
      session,
      (history, newItems) => [...history, ...newItems],
    );

    expect(result.preparedInput).toEqual([pendingShell]);
    expect(result.sessionItems).toEqual([pendingShell]);
  });

  it('preserves pending hosted shell calls from session history when no callback is provided', async () => {
    const historyShell: AgentInputItem = {
      type: 'shell_call',
      callId: 'shell_pending',
      status: 'in_progress',
      action: { commands: ['echo hi'] },
    };
    const session = new StubSession([historyShell]);

    const result = await prepareInputItemsWithSession('fresh input', session);

    expect(result.preparedInput).toEqual([
      historyShell,
      ...toAgentInputList('fresh input'),
    ]);
    expect(result.sessionItems).toEqual(toAgentInputList('fresh input'));
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

  it('uses a session compaction replacement capability without clearing identity', async () => {
    const previousItem = fakeModelMessage('previous history');
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_identity_preserving_session',
      encrypted_content: 'ciphertext',
    };
    const retainedItem = fakeModelMessage('retained history');
    class IdentityPreservingSession extends MemorySession {
      clearCount = 0;
      replacementItems: AgentInputItem[] | undefined;

      async replaceHistoryWithCompaction(
        items: AgentInputItem[],
      ): Promise<void> {
        this.replacementItems = structuredClone(items);
      }

      async clearSession(): Promise<void> {
        this.clearCount += 1;
        await super.clearSession();
      }
    }
    const session = new IdentityPreservingSession();
    session.items = [previousItem];
    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(compaction, TEST_AGENT),
      new MessageOutputItem(retainedItem, TEST_AGENT),
    ];

    await saveToSession(session, [], new RunResult(state as any), {
      runCompaction: false,
    });

    expect(session.replacementItems).toEqual([compaction, retainedItem]);
    expect(session.clearCount).toBe(0);
    expect(session.items).toEqual([previousItem]);
  });

  it('rejects malformed streaming compaction before mutating session history', async () => {
    const previousItem = fakeModelMessage('previous history');
    const session = new MemorySession();
    session.items = [previousItem];
    const malformedCompaction = {
      type: 'compaction',
      id: 'cmp_missing_ciphertext',
    } as AgentInputItem;

    await expect(
      saveStreamInputToSession(session, [
        malformedCompaction,
        fakeModelMessage('new history'),
      ]),
    ).rejects.toThrow('Compaction item missing encrypted_content');
    expect(session.items).toEqual([previousItem]);
  });

  it('rejects malformed result compaction before mutating session history', async () => {
    const previousItem = fakeModelMessage('previous history');
    const session = new MemorySession();
    session.items = [previousItem];
    const malformedCompaction = {
      type: 'compaction',
      id: 'cmp_missing_result_ciphertext',
    } as protocol.CompactionItem;
    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(malformedCompaction, TEST_AGENT),
    ];

    await expect(
      saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      }),
    ).rejects.toThrow('Compaction item missing encrypted_content');
    expect(session.items).toEqual([previousItem]);
  });

  it('does not reappend an accepted compaction replacement on retry', async () => {
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_accepted_then_throw',
      encrypted_content: 'ciphertext',
    };
    const retainedItem = fakeModelMessage('retained history');
    class AcceptedThenThrowSession extends MemorySession {
      replacementCount = 0;

      async replaceHistoryWithCompaction(
        items: AgentInputItem[],
      ): Promise<void> {
        this.replacementCount += 1;
        this.items.push(...structuredClone(items));
        throw new Error('write outcome unknown');
      }
    }
    const session = new AcceptedThenThrowSession();
    session.items = [fakeModelMessage('old history')];
    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(compaction, TEST_AGENT),
      new MessageOutputItem(retainedItem, TEST_AGENT),
    ];
    const result = new RunResult(state as any);

    await expect(
      saveToSession(session, [], result, { runCompaction: false }),
    ).rejects.toThrow('write outcome unknown');
    await expect(
      saveToSession(session, [], result, { runCompaction: false }),
    ).resolves.toBeUndefined();

    expect(session.replacementCount).toBe(1);
    expect(session.items.filter((item) => item.type === 'compaction')).toEqual([
      compaction,
    ]);
    expect(state._currentTurnPersistedItemCount).toBe(2);
  });

  it('does not require a process global for debug session logging', async () => {
    const processDescriptor = Object.getOwnPropertyDescriptor(
      globalThis,
      'process',
    );
    Object.defineProperty(globalThis, 'process', {
      configurable: true,
      value: undefined,
      writable: true,
    });

    try {
      const agent = new Agent<UnknownContext, 'text'>({
        name: 'ProcesslessSessionAgent',
        outputType: 'text',
        instructions: 'test',
      });
      const session = new MemorySession();
      const state = new RunState(new RunContext(), 'hello', agent as any, 10);

      state._generatedItems = [
        new MessageOutputItem(fakeModelMessage('saved'), agent),
      ];

      await expect(
        saveToSession(session, [], new RunResult(state)),
      ).resolves.toBeUndefined();
      expect(session.items).toHaveLength(1);
      expect(session.items[0]).toMatchObject({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'saved' }],
      });
    } finally {
      if (processDescriptor) {
        Object.defineProperty(globalThis, 'process', processDescriptor);
      } else {
        Reflect.deleteProperty(globalThis, 'process');
      }
    }
  });

  it('preserves reasoning IDs for sessions that require them', async () => {
    class ReasoningPreservingSession extends MemorySession {
      preserveReasoningItemIdsForPersistence(): boolean {
        return true;
      }
    }

    const agent = new Agent<UnknownContext, 'text'>({
      name: 'ReasoningSessionAgent',
      outputType: 'text',
      instructions: 'test',
    });
    const session = new ReasoningPreservingSession();
    const state = new RunState(new RunContext(), 'hello', agent as any, 10);
    state.setReasoningItemIdPolicy('omit');

    state._generatedItems = [
      new ReasoningItem(
        {
          type: 'reasoning',
          id: 'rs_session',
          content: [{ type: 'input_text', text: 'thinking' }],
        },
        agent,
      ),
    ];

    await saveToSession(session, [], new RunResult(state));

    expect(session.items).toEqual([
      {
        type: 'reasoning',
        id: 'rs_session',
        content: [{ type: 'input_text', text: 'thinking' }],
      },
    ]);
  });

  it('keeps tool_search ids when persisting session history without call ids', async () => {
    const agent = new Agent<UnknownContext, 'text'>({
      name: 'ToolSearchSessionAgent',
      outputType: 'text',
      instructions: 'test',
    });
    const session = new MemorySession();
    const state = new RunState(new RunContext(), 'hello', agent as any, 10);

    state._generatedItems = [
      new ToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call',
          status: 'completed',
          arguments: {
            query: 'shipping eta',
            paths: ['shipping'],
          },
        },
        agent,
      ),
      new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output',
          call_id: null,
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'get_shipping_eta',
            },
          ],
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    ];

    await saveToSession(
      session,
      toAgentInputList(state._originalInput),
      new RunResult(state),
    );

    expect(session.items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'tool_search_call',
        id: 'ts_call',
        status: 'completed',
        arguments: {
          query: 'shipping eta',
          paths: ['shipping'],
        },
      },
      {
        type: 'tool_search_output',
        call_id: null,
        id: 'ts_output',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'get_shipping_eta',
          },
        ],
      },
    ]);
  });

  it('strips tool_search ids when persisting session history with call ids', async () => {
    const agent = new Agent<UnknownContext, 'text'>({
      name: 'ToolSearchSessionAgent',
      outputType: 'text',
      instructions: 'test',
    });
    const session = new MemorySession();
    const state = new RunState(new RunContext(), 'hello', agent as any, 10);

    state._generatedItems = [
      new ToolSearchCallItem(
        {
          type: 'tool_search_call',
          id: 'ts_call',
          call_id: 'tool_search_call_1',
          status: 'completed',
          arguments: {
            query: 'shipping eta',
            paths: ['shipping'],
          },
        } as protocol.ToolSearchCallItem,
        agent,
      ),
      new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          id: 'ts_output',
          call_id: 'tool_search_call_1',
          status: 'completed',
          tools: [
            {
              type: 'tool_reference',
              functionName: 'get_shipping_eta',
            },
          ],
        } as protocol.ToolSearchOutputItem,
        agent,
      ),
    ];

    await saveToSession(
      session,
      toAgentInputList(state._originalInput),
      new RunResult(state),
    );

    expect(session.items).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'tool_search_call',
        call_id: 'tool_search_call_1',
        status: 'completed',
        arguments: {
          query: 'shipping eta',
          paths: ['shipping'],
        },
      },
      {
        type: 'tool_search_output',
        call_id: 'tool_search_call_1',
        status: 'completed',
        tools: [
          {
            type: 'tool_reference',
            functionName: 'get_shipping_eta',
          },
        ],
      },
    ]);
  });

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

  it('restores session history when legacy compaction reconciliation fails', async () => {
    allowConsole(['warn']);
    const call = functionCall('call_legacy_reconciliation');
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_legacy_reconciliation',
      encrypted_content: 'ciphertext',
    };

    class FailingReplacementSession implements Session {
      items: AgentInputItem[] = [structuredClone(call)];
      failNextAdd = true;

      async getSessionId(): Promise<string> {
        return 'failing-legacy-reconciliation';
      }

      async getItems(limit?: number): Promise<AgentInputItem[]> {
        const items =
          limit === undefined ? this.items : this.items.slice(-limit);
        return structuredClone(items);
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        if (this.failNextAdd) {
          this.failNextAdd = false;
          this.items.push(structuredClone(items[0]));
          throw new Error('replacement failed');
        }
        this.items.push(...structuredClone(items));
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return this.items.pop();
      }

      async clearSession(): Promise<void> {
        this.items = [];
      }
    }

    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(compaction, TEST_AGENT),
      new ToolCallItem(call, TEST_AGENT),
    ];
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 2;
    const session = new FailingReplacementSession();

    await expect(
      saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      }),
    ).rejects.toThrow('replacement failed');
    expect(session.items).toEqual([call]);
    expect(state._pendingLegacyCompactionSessionItems).toEqual([
      compaction,
      call,
    ]);
    expect(state._currentTurnPersistedItemCount).toBe(2);
  });

  it('replaces the full legacy session prefix and remains idempotent', async () => {
    const oldHistory = fakeModelMessage('old history');
    const call = functionCall('call_legacy_prefix_reconciliation');
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_legacy_prefix_reconciliation',
      encrypted_content: 'ciphertext',
    };
    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(compaction, TEST_AGENT),
      new ToolCallItem(call, TEST_AGENT),
    ];
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 2;
    const session = new MemorySession();
    session.items = [oldHistory, call];

    await saveToSession(session, [], new RunResult(state as any), {
      runCompaction: false,
    });
    expect(session.items).toEqual([compaction, call]);
    expect(state._pendingLegacyCompactionSessionItems).toBeUndefined();

    state._pendingLegacyCompactionSessionItems = [compaction, call];
    await saveToSession(session, [], new RunResult(state as any), {
      runCompaction: false,
    });
    expect(session.items).toEqual([compaction, call]);
    expect(state._pendingLegacyCompactionSessionItems).toBeUndefined();
  });

  it('uses session-owned persistence comparison and recognizes an appended compaction suffix', async () => {
    const oldHistory = fakeModelMessage('old history');
    const pendingMessage = fakeModelMessage('retained history');
    const storedMessage = {
      ...structuredClone(pendingMessage),
      id: 'backend-assigned-message-id',
      providerData: { backend: 'metadata' },
    };
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_persistence_comparison',
      encrypted_content: 'ciphertext',
    };

    class PersistenceNormalizingSession extends MemorySession {
      replacementCount = 0;
      clearCount = 0;

      prepareHistoryItemsForPersistenceComparison(
        items: AgentInputItem[],
      ): AgentInputItem[] {
        return items.map((item) => {
          const normalized = structuredClone(item) as AgentInputItem & {
            id?: string;
            providerData?: unknown;
          };
          if (normalized.type !== 'reasoning') {
            delete normalized.id;
          }
          delete normalized.providerData;
          return normalized;
        });
      }

      async replaceHistoryWithCompaction(
        items: AgentInputItem[],
      ): Promise<void> {
        this.replacementCount += 1;
        this.items.push(...structuredClone(items));
      }

      async clearSession(): Promise<void> {
        this.clearCount += 1;
        await super.clearSession();
      }
    }

    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(compaction, TEST_AGENT),
      new MessageOutputItem(pendingMessage, TEST_AGENT),
    ];
    state._pendingLegacyCompactionSessionItems = [compaction, pendingMessage];
    state._currentTurnPersistedItemCount = 2;
    const session = new PersistenceNormalizingSession();
    session.items = [oldHistory, storedMessage];

    await saveToSession(session, [], new RunResult(state as any), {
      runCompaction: false,
    });
    expect(session.replacementCount).toBe(1);
    expect(session.clearCount).toBe(0);
    expect(session.items).toEqual([
      oldHistory,
      storedMessage,
      compaction,
      pendingMessage,
    ]);
    expect(state._pendingLegacyCompactionSessionItems).toBeUndefined();

    state._pendingLegacyCompactionSessionItems = [compaction, pendingMessage];
    await saveToSession(session, [], new RunResult(state as any), {
      runCompaction: false,
    });
    expect(session.replacementCount).toBe(1);
    expect(session.clearCount).toBe(0);
    expect(state._pendingLegacyCompactionSessionItems).toBeUndefined();
  });

  it('rejects mismatched session history before legacy compaction reconciliation', async () => {
    const call = functionCall('call_expected_legacy_reconciliation');
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_mismatched_reconciliation',
      encrypted_content: 'ciphertext',
    };

    class MismatchedSession implements Session {
      items: AgentInputItem[] = [
        functionCall('call_unexpected_legacy_reconciliation'),
      ];
      clearCount = 0;

      async getSessionId(): Promise<string> {
        return 'mismatched-legacy-reconciliation';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return structuredClone(this.items);
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.items.push(...structuredClone(items));
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return this.items.pop();
      }

      async clearSession(): Promise<void> {
        this.clearCount += 1;
        this.items = [];
      }
    }

    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(compaction, TEST_AGENT),
      new ToolCallItem(call, TEST_AGENT),
    ];
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 2;
    const session = new MismatchedSession();

    await expect(
      saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      }),
    ).rejects.toThrow('cannot safely reconcile');
    expect(session.clearCount).toBe(0);
    expect(session.items).toEqual([
      functionCall('call_unexpected_legacy_reconciliation'),
    ]);
  });

  it('rejects malformed stored reconciliation history before session policy hooks', async () => {
    const call = functionCall('call_malformed_stored_reconciliation');
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_valid_pending_reconciliation',
      encrypted_content: 'ciphertext',
    };
    const malformedStoredCompaction = {
      type: 'compaction',
      id: 'cmp_malformed_stored_reconciliation',
    } as AgentInputItem;

    class StoredValidationSession extends MemorySession {
      comparisonCount = 0;
      clearCount = 0;

      prepareHistoryItemsForPersistenceComparison(
        items: AgentInputItem[],
      ): AgentInputItem[] {
        this.comparisonCount += 1;
        return items;
      }

      async clearSession(): Promise<void> {
        this.clearCount += 1;
        await super.clearSession();
      }
    }

    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(compaction, TEST_AGENT),
      new ToolCallItem(call, TEST_AGENT),
    ];
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 2;
    const session = new StoredValidationSession();
    session.items = [malformedStoredCompaction, call];

    await expect(
      saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      }),
    ).rejects.toThrow('Compaction item missing encrypted_content');
    expect(session.comparisonCount).toBe(0);
    expect(session.clearCount).toBe(0);
    expect(session.items).toEqual([malformedStoredCompaction, call]);
    expect(state._pendingLegacyCompactionSessionItems).toEqual([
      compaction,
      call,
    ]);
  });

  it('rejects legacy reconciliation state that is not derived from generated items', async () => {
    const call = functionCall('call_uncorrelated_reconciliation');
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_uncorrelated_reconciliation',
      encrypted_content: 'ciphertext',
    };
    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 0;
    const session = new MemorySession();
    session.items = [call];

    await expect(
      saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      }),
    ).rejects.toThrow('cannot safely reconcile');
    expect(session.items).toEqual([call]);
  });

  it('rejects pending reconciliation with same-id different payload', async () => {
    const call = functionCall('call_changed_reconciliation', '{"value":1}');
    const changedCall = functionCall(
      'call_changed_reconciliation',
      '{"value":2}',
    );
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_changed_reconciliation',
      encrypted_content: 'ciphertext',
    };
    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(compaction, TEST_AGENT),
      new ToolCallItem(call, TEST_AGENT),
    ];
    state._pendingLegacyCompactionSessionItems = [compaction, changedCall];
    state._currentTurnPersistedItemCount = 2;
    const session = new MemorySession();
    session.items = [changedCall];

    await expect(
      saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      }),
    ).rejects.toThrow('cannot safely reconcile');
    expect(session.items).toEqual([changedCall]);
  });

  it('rejects marker-only pending reconciliation before session mutation', async () => {
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_marker_only_reconciliation',
      encrypted_content: 'ciphertext',
    };
    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [new CompactionItem(compaction, TEST_AGENT)];
    state._pendingLegacyCompactionSessionItems = [compaction];
    state._currentTurnPersistedItemCount = 1;
    const message = fakeModelMessage('existing history');
    let policyReads = 0;
    class PolicyThrowingSession extends MemorySession {
      preserveReasoningItemIdsForPersistence(): boolean {
        policyReads += 1;
        throw new Error('session policy should not be read');
      }
    }
    const session = new PolicyThrowingSession();
    session.items = [message];

    await expect(
      saveToSession(session, [], new RunResult(state as any), {
        runCompaction: false,
      }),
    ).rejects.toThrow('cannot safely reconcile');
    expect(policyReads).toBe(0);
    expect(session.items).toEqual([message]);
  });

  it('reports both replacement and rollback failures', async () => {
    allowConsole(['warn']);
    const call = functionCall('call_failed_rollback');
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_failed_rollback',
      encrypted_content: 'ciphertext',
    };

    class FailingRollbackSession implements Session {
      items: AgentInputItem[] = [structuredClone(call)];
      addCount = 0;

      async getSessionId(): Promise<string> {
        return 'failing-rollback-reconciliation';
      }

      async getItems(): Promise<AgentInputItem[]> {
        return structuredClone(this.items);
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.addCount += 1;
        this.items.push(...structuredClone(items.slice(0, 1)));
        throw new Error(
          this.addCount === 1 ? 'replacement failed' : 'rollback failed',
        );
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        return this.items.pop();
      }

      async clearSession(): Promise<void> {
        this.items = [];
      }
    }

    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new CompactionItem(compaction, TEST_AGENT),
      new ToolCallItem(call, TEST_AGENT),
    ];
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 2;
    const session = new FailingRollbackSession();

    const error = await saveToSession(
      session,
      [],
      new RunResult(state as any),
      { runCompaction: false },
    ).catch((caught) => caught);

    expect(error).toBeInstanceOf(Error);
    expect(error).toMatchObject({
      name: 'SessionReconciliationRecoveryError',
    });
    expect((error as { errors: unknown[] }).errors).toEqual([
      expect.objectContaining({ message: 'replacement failed' }),
      expect.objectContaining({ message: 'rollback failed' }),
    ]);
    expect((error as { cause: unknown }).cause).toEqual(
      expect.objectContaining({ message: 'replacement failed' }),
    );
    expect((error as { rollbackError: unknown }).rollbackError).toEqual(
      expect.objectContaining({ message: 'rollback failed' }),
    );
    expect(state._pendingLegacyCompactionSessionItems).toEqual([
      compaction,
      call,
    ]);
  });

  it('reconciles legacy compaction before executing an approved tool', async () => {
    let executions = 0;
    const approvalTool = tool({
      name: 'legacy_compaction_preflight',
      description: 'Tool requiring approval.',
      parameters: z.object({}),
      needsApproval: true,
      async execute() {
        executions += 1;
        return 'approved';
      },
    });
    const agent = new Agent({
      name: 'LegacyCompactionPreflightAgent',
      tools: [approvalTool],
    });
    const call: protocol.FunctionCallItem = {
      type: 'function_call',
      name: approvalTool.name,
      callId: 'call_legacy_compaction_preflight',
      arguments: '{}',
      status: 'completed',
    };
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_legacy_compaction_preflight',
      encrypted_content: 'ciphertext',
    };
    const callItem = new ToolCallItem(call, agent);
    const approvalItem = new ToolApprovalItem(call, agent);
    const state = new RunState(new RunContext(), 'input', agent, 2);
    state._generatedItems = [
      new CompactionItem(compaction, agent),
      callItem,
      approvalItem,
    ];
    state._lastProcessedResponse = {
      newItems: [new CompactionItem(compaction, agent), callItem],
      handoffs: [],
      functions: [{ toolCall: call, tool: approvalTool as any }],
      functionToolsNotFound: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [approvalTool.name],
      hasToolsOrApprovalsToRun: () => true,
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [approvalItem] },
    };
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 3;
    state.approve(approvalItem);
    const session = new MemorySession();
    session.items = [functionCall('call_mismatched_preflight')];

    await expect(new Runner().run(agent, state, { session })).rejects.toThrow(
      'cannot safely reconcile',
    );
    expect(executions).toBe(0);
    expect(session.items).toEqual([functionCall('call_mismatched_preflight')]);
    expect(state._pendingLegacyCompactionSessionItems).toEqual([
      compaction,
      call,
    ]);
  });

  it('rejects legacy compaction before executing an approved tool without a session', async () => {
    let executions = 0;
    const approvalTool = tool({
      name: 'legacy_compaction_session_required',
      description: 'Tool requiring approval.',
      parameters: z.object({}),
      needsApproval: true,
      async execute() {
        executions += 1;
        return 'approved';
      },
    });
    const agent = new Agent({
      name: 'LegacyCompactionSessionRequiredAgent',
      tools: [approvalTool],
    });
    const call: protocol.FunctionCallItem = {
      type: 'function_call',
      name: approvalTool.name,
      callId: 'call_legacy_compaction_session_required',
      arguments: '{}',
      status: 'completed',
    };
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_legacy_compaction_session_required',
      encrypted_content: 'ciphertext',
    };
    const callItem = new ToolCallItem(call, agent);
    const approvalItem = new ToolApprovalItem(call, agent);
    const state = new RunState(new RunContext(), 'input', agent, 2);
    state._generatedItems = [
      new CompactionItem(compaction, agent),
      callItem,
      approvalItem,
    ];
    state._lastProcessedResponse = {
      newItems: [new CompactionItem(compaction, agent), callItem],
      handoffs: [],
      functions: [{ toolCall: call, tool: approvalTool as any }],
      functionToolsNotFound: [],
      computerActions: [],
      shellActions: [],
      applyPatchActions: [],
      mcpApprovalRequests: [],
      toolsUsed: [approvalTool.name],
      hasToolsOrApprovalsToRun: () => true,
    };
    state._currentStep = {
      type: 'next_step_interruption',
      data: { interruptions: [approvalItem] },
    };
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 3;
    state.approve(approvalItem);

    await expect(
      new Runner().run(agent, state, {
        previousResponseId: 'response_legacy_compaction_session_required',
      }),
    ).rejects.toThrow('cannot safely reconcile');
    expect(executions).toBe(0);
    expect(state._pendingLegacyCompactionSessionItems).toEqual([
      compaction,
      call,
    ]);
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
