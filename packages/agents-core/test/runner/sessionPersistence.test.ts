import { beforeAll, describe, expect, it, vi } from 'vitest';

import {
  setDefaultModelProvider,
  setTracingDisabled,
  withTrace,
} from '../../src';
import { Agent, AgentOutputType } from '../../src/agent';
import {
  RunHandoffCallItem as HandoffCallItem,
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
  applySessionHistoryMutationsBeforeRun,
  prepareInputItemsWithSession,
  releaseUnusedSessionHistoryTransactionBinding,
  saveStreamInputToSession,
  saveStreamResultToSession,
  saveToSession,
  selectRunItemsForBlockedOutput,
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
  SessionHistoryRewriteArgs,
  SessionHistoryTransactionArgs,
} from '../../src/memory/session';
import { MemorySession as TransactionMemorySession } from '../../src/memory/memorySession';
import { applySessionHistoryMutations } from '../../src/memory/historyMutations';
import { toAgentInputList } from '../../src/runner/items';
import { tool } from '../../src/tool';
import type { FunctionTool } from '../../src/tool';
import { Usage, RequestUsage } from '../../src/usage';
import { z } from 'zod';
import type { AgentInputItem, UnknownContext } from '../../src/types';
import * as protocol from '../../src/types/protocol';
import { ScriptedModelProvider, TEST_AGENT, fakeModelMessage } from '../stubs';
import logger from '../../src/logger';

beforeAll(() => {
  setTracingDisabled(true);
  setDefaultModelProvider(new ScriptedModelProvider());
});

describe('applySessionHistoryMutationsBeforeRun', () => {
  it('delegates the complete mutation batch to the session atomic boundary', async () => {
    const firstExpected = functionCall('call_first');
    const secondExpected = functionCall('call_second');
    const mutations = [firstExpected, secondExpected].map((expected) => ({
      type: 'replace_function_call' as const,
      callId: expected.callId,
      expected,
      replacement: { ...expected, arguments: '{"ok":true}' },
    }));
    let receivedMutations: typeof mutations | undefined;
    const session = {
      supportsExpectedHistoryMutations: true,
      getItems: async () => {
        throw new Error('runner must not perform a separate history read');
      },
      prepareHistoryItemsForPersistenceComparison: () => {
        throw new Error('normalization belongs to the atomic rewrite');
      },
      applyHistoryMutations: async (args: { mutations: typeof mutations }) => {
        receivedMutations = args.mutations;
      },
    } as unknown as Session;
    const state = {
      _context: new RunContext(),
      _currentTurnPersistedItemCount: 1,
      _getValidatedSessionHistoryMutations: () => mutations,
    } as unknown as RunState<any, any>;

    await applySessionHistoryMutationsBeforeRun(session, state, {
      serverManagesConversation: false,
    });

    expect(receivedMutations).toEqual(mutations);
  });

  it('skips rewrites when the interrupted turn has no persisted items', async () => {
    const expected = functionCall('call_unpersisted');
    const mutations = [
      {
        type: 'replace_function_call' as const,
        callId: expected.callId,
        expected,
        replacement: { ...expected, arguments: '{"ok":true}' },
      },
    ];
    const session = {} as Session;
    const state = {
      _context: new RunContext(),
      _currentTurnPersistedItemCount: 0,
      _getValidatedSessionHistoryMutations: () => mutations,
    } as unknown as RunState<any, any>;

    await expect(
      applySessionHistoryMutationsBeforeRun(session, state, {
        serverManagesConversation: false,
      }),
    ).resolves.toBeUndefined();
  });
});

async function expectLoggerWarnings<T>(
  expectedCalls: unknown[][],
  callback: () => Promise<T>,
): Promise<T> {
  const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

  try {
    const result = await callback();
    expect(warnSpy.mock.calls).toEqual(expectedCalls);
    return result;
  } finally {
    warnSpy.mockRestore();
  }
}

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

function executedFunctionResult(
  call: protocol.FunctionCallItem,
  output: string,
  agent: Agent<any, any> = TEST_AGENT,
): ToolCallOutputItem {
  return new ToolCallOutputItem(
    {
      type: 'function_call_result',
      callId: call.callId,
      name: call.name,
      status: 'completed',
      output,
      ...(call.caller ? { caller: call.caller } : {}),
    },
    agent,
    output,
    undefined,
    'executed',
  );
}

describe('selectRunItemsForBlockedOutput', () => {
  it('retains a committed pair and only reasoning tied to its call', () => {
    const call = functionCall('call-retained');
    const callItem = new ToolCallItem(call, TEST_AGENT);
    const rejectedReasoning = new ReasoningItem(
      {
        type: 'reasoning',
        id: 'reasoning-rejected',
        content: [{ type: 'input_text', text: 'draft message' }],
      },
      TEST_AGENT,
    );
    const rejectedMessage = new MessageOutputItem(
      fakeModelMessage('blocked'),
      TEST_AGENT,
    );
    const retainedReasoning = new ReasoningItem(
      {
        type: 'reasoning',
        id: 'reasoning-retained',
        content: [{ type: 'input_text', text: 'call tool' }],
      },
      TEST_AGENT,
    );
    const result = executedFunctionResult(call, 'done');

    expect(
      selectRunItemsForBlockedOutput([
        rejectedReasoning,
        rejectedMessage,
        retainedReasoning,
        callItem,
        result,
      ]),
    ).toEqual([retainedReasoning, callItem, result]);
  });

  it('retains a terminal result for a previously persisted approval call', () => {
    const call = functionCall('call-rejected-after-approval');
    const callItem = new ToolCallItem(call, TEST_AGENT);
    const rejectedResult = functionResult(call, 'rejected');

    expect(
      selectRunItemsForBlockedOutput([callItem, rejectedResult], 1),
    ).toEqual([rejectedResult]);
    expect(
      selectRunItemsForBlockedOutput([callItem, rejectedResult], 0),
    ).toEqual([]);
  });

  it('uses provider shell result status and execution provenance', () => {
    const call = new ToolCallItem(
      {
        type: 'shell_call',
        callId: 'shell-call',
        status: 'in_progress',
        action: { commands: ['echo committed'] },
      },
      TEST_AGENT,
    );
    const result = new ToolCallOutputItem(
      {
        type: 'shell_call_output',
        callId: 'shell-call',
        output: [],
        providerData: { status: 'completed' },
      },
      TEST_AGENT,
      [],
      undefined,
      'executed',
    );
    const incompleteResult = new ToolCallOutputItem(
      {
        type: 'shell_call_output',
        callId: 'shell-call',
        output: [],
        providerData: { status: 'incomplete' },
      },
      TEST_AGENT,
      [],
      undefined,
      'executed',
    );
    const providerIncompleteResult = new ToolCallOutputItem(
      {
        type: 'shell_call_output',
        callId: 'shell-call',
        status: 'completed',
        output: [],
        providerData: { status: 'incomplete' },
      },
      TEST_AGENT,
      [],
      undefined,
      'executed',
    );
    const itemIncompleteResult = new ToolCallOutputItem(
      {
        type: 'shell_call_output',
        callId: 'shell-call',
        status: 'incomplete',
        output: [],
        providerData: { status: 'completed' },
      },
      TEST_AGENT,
      [],
      undefined,
      'executed',
    );
    const statuslessExecutedResult = new ToolCallOutputItem(
      {
        type: 'shell_call_output',
        callId: 'shell-call',
        output: [],
      },
      TEST_AGENT,
      [],
      undefined,
      'executed',
    );

    expect(selectRunItemsForBlockedOutput([call, result])).toEqual([
      call,
      result,
    ]);
    expect(selectRunItemsForBlockedOutput([call, incompleteResult])).toEqual(
      [],
    );
    expect(
      selectRunItemsForBlockedOutput([call, providerIncompleteResult]),
    ).toEqual([]);
    expect(
      selectRunItemsForBlockedOutput([call, itemIncompleteResult]),
    ).toEqual([]);
    expect(
      selectRunItemsForBlockedOutput([call, statuslessExecutedResult]),
    ).toEqual([call, statuslessExecutedResult]);
  });

  it('retains session authority for an executed result excluded from blocked history', async () => {
    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state._generatedItems = [
      new ToolCallItem(
        {
          type: 'shell_call',
          callId: 'excluded-bound-shell',
          status: 'completed',
          action: { commands: ['echo committed'] },
        },
        TEST_AGENT,
      ),
      new ToolCallOutputItem(
        {
          type: 'shell_call_output',
          callId: 'excluded-bound-shell',
          output: [],
          providerData: { status: 'incomplete' },
        },
        TEST_AGENT,
        [],
        undefined,
        'executed',
      ),
    ];
    state._currentTurnSessionHistoryTransactionSessionId =
      'excluded-bound-session';

    releaseUnusedSessionHistoryTransactionBinding(state);

    expect(state._currentTurnSessionHistoryTransactionSessionId).toBe(
      'excluded-bound-session',
    );
    const serialized = state.toJSON();
    expect(serialized.currentTurnExecutedWithSessionBinding).toBe(true);
    await expect(
      RunState.fromString(TEST_AGENT, JSON.stringify(serialized)),
    ).rejects.toThrow(
      'Serialized output guardrail session transaction authority cannot be resumed safely.',
    );
  });

  it('does not treat program output as locally executed provenance', () => {
    const program = new ToolCallItem(
      {
        type: 'program',
        callId: 'program-untrusted-execution',
        code: 'return "done";',
        fingerprint: 'program-untrusted-execution-fingerprint',
      },
      TEST_AGENT,
    );
    const output = new ToolCallOutputItem(
      {
        type: 'program_output',
        callId: 'program-untrusted-execution',
        status: 'completed',
        output: 'done',
      },
      TEST_AGENT,
      'done',
      undefined,
      'executed',
    );

    expect(selectRunItemsForBlockedOutput([program, output])).toEqual([]);
  });

  it('retains completed handoff context and a pending program owner', () => {
    const handoffCall = {
      ...functionCall('call-handoff'),
      name: 'transfer_to_target',
    };
    const handoffCallItem = new HandoffCallItem(handoffCall, TEST_AGENT);
    const handoffOutputItem = new HandoffOutputItem(
      {
        type: 'function_call_result',
        callId: handoffCall.callId,
        name: handoffCall.name,
        status: 'completed',
        output: 'Transferred',
      },
      TEST_AGENT,
      TEST_AGENT,
    );
    const program = new ToolCallItem(
      {
        type: 'program',
        callId: 'program-owner',
        code: 'return await tools.test({});',
        fingerprint: 'program-owner-fingerprint',
      },
      TEST_AGENT,
    );
    const childCall = {
      ...functionCall('program-child'),
      caller: { type: 'program' as const, callerId: 'program-owner' },
    };
    const child = new ToolCallItem(childCall, TEST_AGENT);
    const childResult = executedFunctionResult(childCall, 'committed');

    expect(
      selectRunItemsForBlockedOutput([
        handoffCallItem,
        handoffOutputItem,
        program,
        child,
        childResult,
      ]),
    ).toEqual([
      handoffCallItem,
      handoffOutputItem,
      program,
      child,
      childResult,
    ]);
  });

  it('retains classified hosted tools and drops unknown completed kinds', () => {
    const hosted = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'hosted-completed',
        name: 'web_search_call',
        status: 'completed',
        providerData: { type: 'web_search_call' },
      },
      TEST_AGENT,
    );
    const unknown = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'hosted-future',
        name: 'future_hosted_call',
        status: 'completed',
        providerData: { type: 'future_hosted_call' },
      },
      TEST_AGENT,
    );
    const legacyMcp = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'legacy-mcp-completed',
        name: 'hosted_mcp',
        providerData: { type: 'mcp_call', status: 'completed' },
      },
      TEST_AGENT,
    );
    const incompleteLegacyMcp = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'legacy-mcp-incomplete',
        name: 'hosted_mcp',
        providerData: { type: 'mcp_call', status: 'incomplete' },
      },
      TEST_AGENT,
    );
    const conflictingStatus = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'hosted-conflicting-status',
        name: 'web_search_call',
        status: 'completed',
        providerData: {
          type: 'web_search_call',
          status: 'incomplete',
        },
      },
      TEST_AGENT,
    );
    const conflictingType = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'hosted-conflicting-type',
        name: 'web_search_call',
        status: 'completed',
        providerData: { type: 'future_hosted_call' },
      },
      TEST_AGENT,
    );

    expect(selectRunItemsForBlockedOutput([hosted])).toEqual([hosted]);
    expect(selectRunItemsForBlockedOutput([legacyMcp])).toEqual([legacyMcp]);
    expect(selectRunItemsForBlockedOutput([incompleteLegacyMcp])).toEqual([]);
    expect(selectRunItemsForBlockedOutput([conflictingStatus])).toEqual([]);
    expect(selectRunItemsForBlockedOutput([conflictingType])).toEqual([]);
    expect(selectRunItemsForBlockedOutput([unknown])).toEqual([]);
  });

  it('retains tool-search provenance that loaded a committed dynamic tool', () => {
    const searchCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        arguments: { paths: ['dynamic_commit'] },
        execution: 'client',
        providerData: {
          call_id: 'call-tool-search-dynamic',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const searchOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        status: 'completed',
        execution: 'client',
        tools: [{ type: 'function', name: 'dynamic_commit' }],
        providerData: {
          call_id: 'call-tool-search-dynamic',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const call = {
      ...functionCall('call-dynamic-commit'),
      name: 'dynamic_commit',
    };
    const callItem = new ToolCallItem(call, TEST_AGENT);
    const result = executedFunctionResult(call, 'committed');

    expect(
      selectRunItemsForBlockedOutput([
        searchCall,
        searchOutput,
        callItem,
        result,
      ]),
    ).toEqual([searchCall, searchOutput, callItem, result]);
  });

  it('retains tool-search provenance that loaded a completed hosted MCP call', () => {
    const searchCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        arguments: { paths: ['inventory'] },
        execution: 'client',
        providerData: {
          call_id: 'call-tool-search-hosted-mcp',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const searchOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        status: 'completed',
        execution: 'client',
        tools: [
          {
            type: 'mcp',
            server_label: 'inventory',
            server_url: 'https://inventory.example.com/mcp',
            defer_loading: true,
            require_approval: 'never',
          },
        ],
        providerData: {
          call_id: 'call-tool-search-hosted-mcp',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const hostedMcpCall = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'hosted-mcp-call',
        name: 'hosted_mcp',
        status: 'completed',
        providerData: {
          type: 'mcp_call',
          server_label: 'inventory',
        },
      },
      TEST_AGENT,
    );

    expect(
      selectRunItemsForBlockedOutput([searchCall, searchOutput, hostedMcpCall]),
    ).toEqual([searchCall, searchOutput, hostedMcpCall]);
  });

  it('keeps an earlier committed tool when an unrelated matching search appears later', () => {
    const call = {
      ...functionCall('call-dynamic-before-search'),
      name: 'dynamic_commit',
    };
    const callItem = new ToolCallItem(call, TEST_AGENT);
    const result = executedFunctionResult(call, 'committed');
    const searchCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        arguments: { paths: ['dynamic_commit'] },
        execution: 'client',
        providerData: {
          call_id: 'call-late-dynamic-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const searchOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        status: 'completed',
        execution: 'client',
        tools: [{ type: 'function', name: 'dynamic_commit' }],
        providerData: {
          call_id: 'call-late-dynamic-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );

    expect(
      selectRunItemsForBlockedOutput([
        callItem,
        result,
        searchCall,
        searchOutput,
      ]),
    ).toEqual([callItem, result]);
  });

  it('keeps an earlier hosted MCP call when a matching search appears later', () => {
    const hostedMcpCall = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'hosted-mcp-before-search',
        name: 'hosted_mcp',
        status: 'completed',
        providerData: {
          type: 'mcp_call',
          server_label: 'inventory',
        },
      },
      TEST_AGENT,
    );
    const searchCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        arguments: { paths: ['inventory'] },
        execution: 'client',
        providerData: {
          call_id: 'call-late-hosted-mcp-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const searchOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        status: 'completed',
        execution: 'client',
        tools: [
          {
            type: 'mcp',
            server_label: 'inventory',
            server_url: 'https://inventory.example.com/mcp',
            defer_loading: true,
            require_approval: 'never',
          },
        ],
        providerData: {
          call_id: 'call-late-hosted-mcp-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );

    expect(
      selectRunItemsForBlockedOutput([hostedMcpCall, searchCall, searchOutput]),
    ).toEqual([hostedMcpCall]);
  });

  it('keeps explicit server tool-search outputs out of the FIFO fallback queue', () => {
    const firstCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        call_id: 'server-search-a',
        execution: 'server',
        status: 'completed',
        arguments: { paths: ['alpha'] },
      } as any,
      TEST_AGENT,
    );
    const secondCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        call_id: 'server-search-b',
        execution: 'server',
        status: 'completed',
        arguments: { paths: ['beta'] },
      } as any,
      TEST_AGENT,
    );
    const firstOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        call_id: 'server-search-a',
        execution: 'server',
        status: 'completed',
        tools: [],
      } as any,
      TEST_AGENT,
    );
    const secondOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        execution: 'server',
        status: 'completed',
        tools: [
          {
            type: 'mcp',
            server_label: 'beta',
            server_url: 'https://beta.example.com/mcp',
            defer_loading: true,
            require_approval: 'never',
          },
        ],
      } as any,
      TEST_AGENT,
    );
    const hostedMcpCall = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'hosted-mcp-beta',
        name: 'hosted_mcp',
        status: 'completed',
        providerData: { type: 'mcp_call', server_label: 'beta' },
      },
      TEST_AGENT,
    );

    expect(
      selectRunItemsForBlockedOutput([
        firstCall,
        secondCall,
        firstOutput,
        secondOutput,
        hostedMcpCall,
      ]),
    ).toEqual([secondCall, secondOutput, hostedMcpCall]);
  });

  it('drops completed server tool-search output from an incomplete call', () => {
    const searchCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        call_id: 'server-incomplete-search',
        execution: 'server',
        status: 'incomplete',
        arguments: { paths: ['inventory'] },
      },
      TEST_AGENT,
    );
    const searchOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        call_id: 'server-incomplete-search',
        execution: 'server',
        status: 'completed',
        tools: [
          {
            type: 'mcp',
            server_label: 'inventory',
            server_url: 'https://inventory.example.com/mcp',
            defer_loading: true,
            require_approval: 'never',
          },
        ],
      },
      TEST_AGENT,
    );
    const hostedMcpCall = new ToolCallItem(
      {
        type: 'hosted_tool_call',
        id: 'hosted-mcp-incomplete-search-call',
        name: 'hosted_mcp',
        status: 'completed',
        providerData: {
          type: 'mcp_call',
          server_label: 'inventory',
        },
      },
      TEST_AGENT,
    );

    expect(
      selectRunItemsForBlockedOutput([searchCall, searchOutput, hostedMcpCall]),
    ).toEqual([]);
  });

  it.each([
    { label: 'missing', status: undefined },
    { label: 'incomplete', status: 'incomplete' as const },
  ])(
    'drops a defer-loaded hosted MCP call with $label tool-search provenance',
    ({ status }) => {
      const searchCall = new ToolSearchCallItem(
        {
          type: 'tool_search_call',
          arguments: { paths: ['inventory'] },
          execution: 'client',
          providerData: {
            call_id: 'call-incomplete-hosted-mcp-search',
            execution: 'client',
          },
        },
        TEST_AGENT,
      );
      const searchOutput = new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          status,
          execution: 'client',
          tools: [
            {
              type: 'mcp',
              server_label: 'inventory',
              server_url: 'https://inventory.example.com/mcp',
              defer_loading: true,
              require_approval: 'never',
            },
          ],
          providerData: {
            call_id: 'call-incomplete-hosted-mcp-search',
            execution: 'client',
          },
        },
        TEST_AGENT,
      );
      const hostedMcpCall = new ToolCallItem(
        {
          type: 'hosted_tool_call',
          id: 'hosted-mcp-incomplete-supplier',
          name: 'hosted_mcp',
          status: 'completed',
          providerData: {
            type: 'mcp_call',
            server_label: 'inventory',
          },
        },
        TEST_AGENT,
      );

      expect(
        selectRunItemsForBlockedOutput([
          searchCall,
          searchOutput,
          hostedMcpCall,
        ]),
      ).toEqual([]);
    },
  );

  it.each([
    {
      name: 'incomplete supplier',
      buildSearchItems: () => {
        const searchCall = new ToolSearchCallItem(
          {
            type: 'tool_search_call',
            arguments: { paths: ['dynamic_commit'] },
            execution: 'client',
            providerData: {
              call_id: 'call-incomplete-search',
              execution: 'client',
            },
          },
          TEST_AGENT,
        );
        const searchOutput = new ToolSearchOutputItem(
          {
            type: 'tool_search_output',
            status: 'incomplete',
            execution: 'client',
            tools: [{ type: 'function', name: 'dynamic_commit' }],
            providerData: {
              call_id: 'call-incomplete-search',
              execution: 'client',
            },
          },
          TEST_AGENT,
        );
        return [searchCall, searchOutput];
      },
    },
    {
      name: 'out-of-order supplier',
      buildSearchItems: () => [
        new ToolSearchOutputItem(
          {
            type: 'tool_search_output',
            status: 'completed',
            execution: 'client',
            tools: [{ type: 'function', name: 'dynamic_commit' }],
            providerData: {
              call_id: 'call-out-of-order-search',
              execution: 'client',
            },
          },
          TEST_AGENT,
        ),
        new ToolSearchCallItem(
          {
            type: 'tool_search_call',
            arguments: { paths: ['dynamic_commit'] },
            execution: 'client',
            providerData: {
              call_id: 'call-out-of-order-search',
              execution: 'client',
            },
          },
          TEST_AGENT,
        ),
      ],
    },
  ])('drops a dynamic tool pair with a $name', ({ buildSearchItems }) => {
    const call = {
      ...functionCall('call-unresolved-dynamic-commit'),
      name: 'dynamic_commit',
    };
    const callItem = new ToolCallItem(call, TEST_AGENT);
    const result = executedFunctionResult(call, 'committed');

    expect(
      selectRunItemsForBlockedOutput([...buildSearchItems(), callItem, result]),
    ).toEqual([]);
  });

  it('retains the latest same-call-id tool-search replacement for a committed dynamic tool', () => {
    const searchCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        arguments: { paths: ['dynamic_commit'] },
        execution: 'client',
        providerData: {
          call_id: 'call-replaced-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const firstOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        status: 'completed',
        execution: 'client',
        tools: [{ type: 'function', name: 'dynamic_commit' }],
        providerData: {
          call_id: 'call-replaced-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const replacementOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        status: 'completed',
        execution: 'client',
        tools: [{ type: 'function', name: 'dynamic_commit' }],
        providerData: {
          call_id: 'call-replaced-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const call = {
      ...functionCall('call-after-replaced-search'),
      name: 'dynamic_commit',
    };
    const callItem = new ToolCallItem(call, TEST_AGENT);
    const result = executedFunctionResult(call, 'committed');

    expect(
      selectRunItemsForBlockedOutput([
        searchCall,
        firstOutput,
        replacementOutput,
        callItem,
        result,
      ]),
    ).toEqual([searchCall, replacementOutput, callItem, result]);
  });

  it.each(['client', 'server'] as const)(
    'matches an explicit %s tool-search output to the latest repeated call occurrence',
    (execution) => {
      const searchCall = (path: string) =>
        new ToolSearchCallItem(
          {
            type: 'tool_search_call',
            arguments: { paths: [path] },
            execution,
            ...(execution === 'server'
              ? { call_id: 'call-repeated-search', status: 'completed' }
              : {
                  providerData: {
                    call_id: 'call-repeated-search',
                    execution,
                  },
                }),
          } as any,
          TEST_AGENT,
        );
      const firstCall = searchCall('first_search');
      const latestCall = searchCall('dynamic_commit');
      const explicitOutput = new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          status: 'completed',
          execution,
          tools: [{ type: 'function', name: 'dynamic_commit' }],
          ...(execution === 'server'
            ? { call_id: 'call-repeated-search' }
            : {
                providerData: {
                  call_id: 'call-repeated-search',
                  execution,
                },
              }),
        } as any,
        TEST_AGENT,
      );
      const call = {
        ...functionCall(`call-after-repeated-${execution}-search`),
        name: 'dynamic_commit',
      };
      const callItem = new ToolCallItem(call, TEST_AGENT);
      const result = executedFunctionResult(call, 'committed');

      expect(
        selectRunItemsForBlockedOutput([
          firstCall,
          latestCall,
          explicitOutput,
          callItem,
          result,
        ]),
      ).toEqual([latestCall, explicitOutput, callItem, result]);
    },
  );

  it.each(['client', 'server'] as const)(
    'matches an anonymous %s tool-search output to the oldest occurrence left by an explicit output',
    (execution) => {
      const searchCall = (path: string) =>
        new ToolSearchCallItem(
          {
            type: 'tool_search_call',
            arguments: { paths: [path] },
            execution,
            ...(execution === 'server'
              ? { call_id: 'call-mixed-search', status: 'completed' }
              : {
                  providerData: {
                    call_id: 'call-mixed-search',
                    execution,
                  },
                }),
          } as any,
          TEST_AGENT,
        );
      const firstCall = searchCall('dynamic_commit');
      const latestCall = searchCall('other_tool');
      const explicitOutput = new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          status: 'completed',
          execution,
          tools: [{ type: 'function', name: 'other_tool' }],
          ...(execution === 'server'
            ? { call_id: 'call-mixed-search' }
            : {
                providerData: {
                  call_id: 'call-mixed-search',
                  execution,
                },
              }),
        } as any,
        TEST_AGENT,
      );
      const anonymousOutput = new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          status: 'completed',
          execution,
          tools: [{ type: 'function', name: 'dynamic_commit' }],
        } as any,
        TEST_AGENT,
      );
      const call = {
        ...functionCall(`call-after-mixed-${execution}-search`),
        name: 'dynamic_commit',
      };
      const callItem = new ToolCallItem(call, TEST_AGENT);
      const result = executedFunctionResult(call, 'committed');

      expect(
        selectRunItemsForBlockedOutput([
          firstCall,
          latestCall,
          explicitOutput,
          anonymousOutput,
          callItem,
          result,
        ]),
      ).toEqual([firstCall, anonymousOutput, callItem, result]);
    },
  );

  it('retains the latest completed tool-search refresh for a committed dynamic tool', () => {
    const searchItems = ['first', 'second'].flatMap((suffix) => [
      new ToolSearchCallItem(
        {
          type: 'tool_search_call',
          arguments: { paths: ['dynamic_commit'] },
          execution: 'client',
          providerData: {
            call_id: `call-${suffix}-refresh`,
            execution: 'client',
          },
        },
        TEST_AGENT,
      ),
      new ToolSearchOutputItem(
        {
          type: 'tool_search_output',
          status: 'completed',
          execution: 'client',
          tools: [{ type: 'function', name: 'dynamic_commit' }],
          providerData: {
            call_id: `call-${suffix}-refresh`,
            execution: 'client',
          },
        },
        TEST_AGENT,
      ),
    ]);
    const call = {
      ...functionCall('call-after-refreshed-search'),
      name: 'dynamic_commit',
    };
    const callItem = new ToolCallItem(call, TEST_AGENT);
    const result = executedFunctionResult(call, 'committed');

    expect(
      selectRunItemsForBlockedOutput([...searchItems, callItem, result]),
    ).toEqual([...searchItems.slice(2), callItem, result]);
  });

  it.each([
    ['client', 'incomplete'],
    ['client', 'out_of_order'],
    ['server', 'incomplete'],
    ['server', 'out_of_order'],
  ] as const)(
    'keeps a completed %s supplier when a different-key occurrence is %s',
    (execution, invalidKind) => {
      const searchCall = (key: string) =>
        new ToolSearchCallItem(
          {
            type: 'tool_search_call',
            arguments: { paths: ['dynamic_commit'] },
            execution,
            ...(execution === 'server'
              ? { call_id: key, status: 'completed' }
              : {
                  providerData: { call_id: key, execution },
                }),
          } as any,
          TEST_AGENT,
        );
      const searchOutput = (key: string, status: 'completed' | 'incomplete') =>
        new ToolSearchOutputItem(
          {
            type: 'tool_search_output',
            status,
            execution,
            tools: [{ type: 'function', name: 'dynamic_commit' }],
            ...(execution === 'server'
              ? { call_id: key }
              : {
                  providerData: { call_id: key, execution },
                }),
          } as any,
          TEST_AGENT,
        );
      const firstCall = searchCall('call-effective-first');
      const firstOutput = searchOutput('call-effective-first', 'completed');
      const invalidCall = searchCall('call-ineffective-second');
      const invalidOutput = searchOutput(
        'call-ineffective-second',
        invalidKind === 'incomplete' ? 'incomplete' : 'completed',
      );
      const invalidItems =
        invalidKind === 'out_of_order'
          ? [invalidOutput, invalidCall]
          : [invalidCall, invalidOutput];
      const call = {
        ...functionCall('call-after-ineffective-search'),
        name: 'dynamic_commit',
      };
      const callItem = new ToolCallItem(call, TEST_AGENT);
      const result = executedFunctionResult(call, 'committed');

      expect(
        selectRunItemsForBlockedOutput([
          firstCall,
          firstOutput,
          ...invalidItems,
          callItem,
          result,
        ]),
      ).toEqual([firstCall, firstOutput, callItem, result]);
    },
  );

  it('invalidates an earlier supplier when a same-key replacement is incomplete', () => {
    const searchCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        arguments: { paths: ['dynamic_commit'] },
        execution: 'client',
        providerData: {
          call_id: 'call-invalidated-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const completedOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        status: 'completed',
        execution: 'client',
        tools: [{ type: 'function', name: 'dynamic_commit' }],
        providerData: {
          call_id: 'call-invalidated-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const incompleteReplacement = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        status: 'incomplete',
        execution: 'client',
        tools: [{ type: 'function', name: 'dynamic_commit' }],
        providerData: {
          call_id: 'call-invalidated-search',
          execution: 'client',
        },
      },
      TEST_AGENT,
    );
    const call = {
      ...functionCall('call-after-invalidated-search'),
      name: 'dynamic_commit',
    };

    expect(
      selectRunItemsForBlockedOutput([
        searchCall,
        completedOutput,
        incompleteReplacement,
        new ToolCallItem(call, TEST_AGENT),
        executedFunctionResult(call, 'committed'),
      ]),
    ).toEqual([]);
  });

  it('rejects serialized pending blocked-output transaction authority', async () => {
    const call = {
      ...functionCall('call-serialized-before-search'),
      name: 'dynamic_commit',
    };
    const callItem = new ToolCallItem(call, TEST_AGENT);
    const result = executedFunctionResult(call, 'committed');
    const searchCall = new ToolSearchCallItem(
      {
        type: 'tool_search_call',
        call_id: 'call-serialized-late-search',
        status: 'completed',
        execution: 'server',
        arguments: { paths: ['dynamic_commit'] },
      } as any,
      TEST_AGENT,
    );
    const searchOutput = new ToolSearchOutputItem(
      {
        type: 'tool_search_output',
        call_id: 'call-serialized-late-search',
        status: 'completed',
        execution: 'server',
        tools: [{ type: 'function', name: 'dynamic_commit' }],
      } as any,
      TEST_AGENT,
    );
    const state = new RunState(
      new RunContext(undefined),
      'input',
      TEST_AGENT,
      10,
    );
    state._generatedItems = [callItem, result, searchCall, searchOutput];
    state._currentTurnBlockedSessionStartIndex = 0;
    state._currentTurnSessionHistoryTransactionSessionId =
      'serialized-plan-session';
    state._currentTurnSessionReasoningItemIdPolicy = 'preserve';
    state._currentTurnSessionHistoryTransactionInputItems = [];
    state._currentTurnSessionHistoryTransactionCanReplaceAcceptedOutput = true;
    state._pendingSessionHistoryTransaction = {
      operationId: `${state._sessionHistoryTransactionId}:${state._currentTurn}:blocked_append:0:4`,
      transactionKind: 'blocked_append',
      runItemIndexes: [0, 1],
      replaceRunItemIndexes: [],
      alreadyPersistedCount: 0,
      persistedItemCount: 4,
      deferredItemIndexes: [2, 3],
    };

    await expect(
      RunState.fromString(TEST_AGENT, state.toString()),
    ).rejects.toThrow(
      'Serialized output guardrail session transaction authority cannot be resumed safely.',
    );
  });
});

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
      return this.items.pop();
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

  it('persists streamed input and output as one normalized turn', async () => {
    const textAgent = new Agent<UnknownContext, 'text'>({
      name: 'StreamReconciliation',
      outputType: 'text',
      instructions: 'stream reconciliation test',
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
    const oldOutput: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'call_stream_ordered',
      name: 'lookup',
      status: 'completed',
      output: 'old',
    };
    const call: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: 'call_stream_ordered',
      name: 'lookup',
      arguments: '{}',
    };
    const newOutput: protocol.FunctionCallResultItem = {
      ...oldOutput,
      output: 'new',
    };
    state._generatedItems = [
      new ToolCallOutputItem(newOutput, textAgent, newOutput.output),
    ];
    const streamedResult = new StreamedRunResult({ state });

    await saveStreamResultToSession(session, streamedResult, {}, [
      oldOutput,
      call,
    ]);

    expect(session.items).toEqual([call, newOutput]);
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

  it('does not persist a repeated original history reference', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'history',
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'new',
    };
    const session = new StubSession([historyItem]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => [history[0], history[0], newItems[0]],
    );

    expect(result.preparedInput).toEqual([historyItem, historyItem, newItem]);
    expect(result.sessionItems).toEqual([newItem]);
  });

  it('keeps equal-content new input when history is repeated', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'same',
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'same',
    };
    const session = new StubSession([historyItem]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => [history[0], history[0], newItems[0]],
    );

    expect(result.preparedInput).toEqual([historyItem, historyItem, newItem]);
    expect(result.sessionItems).toEqual([newItem]);
    expect(result.sessionItems?.[0]).toBe(newItem);
  });

  it('persists a clone after shared history and new-input identity is consumed', async () => {
    const sharedItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'shared',
    };
    const session = new StubSession([sharedItem]);
    let reconstructed: AgentInputItem | undefined;

    const result = await prepareInputItemsWithSession(
      [sharedItem],
      session,
      (history) => {
        reconstructed = structuredClone(history[0]);
        return [history[0], history[0], reconstructed];
      },
    );

    expect(result.preparedInput).toEqual([
      sharedItem,
      sharedItem,
      reconstructed,
    ]);
    expect(result.sessionItems).toEqual([reconstructed]);
  });

  it('preserves history provenance after async pop, move, and repeat', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'history',
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'new',
    };
    const session = new StubSession([historyItem]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      async (history, newItems) => {
        await Promise.resolve();
        const moved = history.pop();
        if (!moved) {
          throw new Error('Expected history item.');
        }
        newItems.unshift(moved);
        return [...newItems, moved];
      },
    );

    expect(result.preparedInput).toEqual([historyItem, newItem, historyItem]);
    expect(result.sessionItems).toEqual([newItem]);
  });

  it('persists a replacement history object as injected input', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'history',
    };
    const replacement: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'summary',
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'new',
    };
    const session = new StubSession([historyItem]);

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => {
        history[0] = replacement;
        return history.concat(newItems);
      },
    );

    expect(result.preparedInput).toEqual([replacement, newItem]);
    expect(result.sessionItems).toEqual([replacement, newItem]);
  });

  it('persists an extra reconstructed history copy as injected input', async () => {
    const historyItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'history',
    };
    const newItem: AgentInputItem = {
      type: 'message',
      role: 'user',
      content: 'new',
    };
    const session = new StubSession([historyItem]);
    let reconstructed: AgentInputItem | undefined;

    const result = await prepareInputItemsWithSession(
      [newItem],
      session,
      (history, newItems) => {
        reconstructed = structuredClone(history[0]);
        return [history[0], reconstructed, newItems[0]];
      },
    );

    expect(result.preparedInput).toEqual([historyItem, reconstructed, newItem]);
    expect(result.sessionItems).toEqual([reconstructed, newItem]);
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

  it('retries a blocked-output transaction without duplicating committed tool effects', async () => {
    class AcceptedBlockedThenThrowSession extends TransactionMemorySession {
      operationIds: string[] = [];
      transactions: SessionHistoryTransactionArgs['transaction'][] = [];
      preserveReasoningIds = false;
      private throwAfterFirstCommit = true;

      preserveReasoningItemIdsForPersistence(): boolean {
        return this.preserveReasoningIds;
      }

      override async applyHistoryTransaction(
        args: SessionHistoryTransactionArgs,
      ): Promise<void> {
        this.operationIds.push(args.operationId);
        this.transactions.push(structuredClone(args.transaction));
        await super.applyHistoryTransaction(args);
        if (this.throwAfterFirstCommit) {
          this.throwAfterFirstCommit = false;
          throw new Error('write outcome unknown');
        }
      }
    }

    const call = {
      ...functionCall('call-blocked-retry'),
      providerData: undefined,
    };
    const callItem = new ToolCallItem(call, TEST_AGENT);
    const resultItem = executedFunctionResult(call, 'committed');
    const session = new AcceptedBlockedThenThrowSession();
    const state = new RunState(new RunContext(), 'input', TEST_AGENT, 1);
    state.setReasoningItemIdPolicy('omit');
    state._generatedItems = [
      new ReasoningItem(
        {
          type: 'reasoning',
          id: 'reasoning-blocked-retry',
          content: [{ type: 'input_text', text: 'run the committed tool' }],
        },
        TEST_AGENT,
      ),
      callItem,
      resultItem,
    ];
    const result = new RunResult(state as any);
    const input = fakeModelMessage('blocked transaction input');
    state._currentTurnSessionHistoryTransactionInputItems = [input];

    await expect(
      saveToSession(session, [input], result, {
        outputBlocked: true,
      }),
    ).rejects.toThrow('write outcome unknown');
    expect(state._currentTurnPersistedItemCount).toBe(0);
    expect(state._pendingSessionHistoryTransaction).toBeDefined();
    expect(
      (session.transactions[0] as { items: AgentInputItem[] }).items.find(
        (item) => item.type === 'function_call',
      ),
    ).not.toHaveProperty('providerData');
    session.preserveReasoningIds = true;

    const differentSession = new TransactionMemorySession({
      sessionId: 'different-session',
    });

    await expect(
      saveToSession(differentSession, [], new RunResult(state as any), {
        outputBlocked: true,
      }),
    ).rejects.toThrow(
      'Output guardrail session persistence belongs to a different session',
    );
    expect(await differentSession.getItems()).toEqual([]);
    expect(state._pendingSessionHistoryTransaction).toBeDefined();

    await expect(
      saveToSession(session, [], new RunResult(state as any), {
        outputBlocked: true,
      }),
    ).resolves.toBeUndefined();

    expect(session.operationIds).toHaveLength(2);
    expect(session.operationIds[1]).toBe(session.operationIds[0]);
    const persistedItems = await session.getItems();
    expect(persistedItems).toEqual(
      JSON.parse(
        JSON.stringify([
          input,
          {
            type: 'reasoning',
            content: [{ type: 'input_text', text: 'run the committed tool' }],
          },
          call,
          resultItem.rawItem,
        ]),
      ),
    );
    expect(state._currentTurnPersistedItemCount).toBe(3);
    expect(state._pendingSessionHistoryTransaction).toBeUndefined();
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

  it('keeps the latest persisted tool output after its matching call', async () => {
    const agent = new Agent<UnknownContext, 'text'>({
      name: 'OrderedSessionAgent',
      outputType: 'text',
      instructions: 'test',
    });
    const session = new MemorySession();
    const state = new RunState(new RunContext(), 'hello', agent as any, 10);
    const oldOutput: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'call_ordered',
      name: 'lookup',
      status: 'completed',
      output: 'old',
    };
    const call: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: 'call_ordered',
      name: 'lookup',
      arguments: '{}',
    };
    const newOutput: protocol.FunctionCallResultItem = {
      ...oldOutput,
      output: 'new',
    };
    state._generatedItems = [
      new ToolCallOutputItem(newOutput, agent, newOutput.output),
    ];

    await saveToSession(session, [oldOutput, call], new RunResult(state));

    expect(session.items).toEqual([call, newOutput]);
  });

  it('deduplicates replayed calls with mixed item and call identities', async () => {
    const agent = new Agent<UnknownContext, 'text'>({
      name: 'MixedIdentitySessionAgent',
      outputType: 'text',
      instructions: 'test',
    });
    const session = new MemorySession();
    const state = new RunState(new RunContext(), 'hello', agent as any, 10);
    const oldCall: protocol.FunctionCallItem = {
      type: 'function_call',
      id: 'item_old',
      callId: 'call_mixed',
      name: 'lookup',
      arguments: '{"value":"old"}',
    };
    const output: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: 'call_mixed',
      name: 'lookup',
      status: 'completed',
      output: 'done',
    };
    const newCall: protocol.FunctionCallItem = {
      ...oldCall,
      id: undefined,
      arguments: '{"value":"new"}',
    };

    await saveToSession(
      session,
      [oldCall, output, newCall],
      new RunResult(state),
    );

    expect(session.items).toEqual([newCall, output]);
  });

  it('preserves persisted duplicates with empty correlations', async () => {
    const agent = new Agent<UnknownContext, 'text'>({
      name: 'EmptyCorrelationSessionAgent',
      outputType: 'text',
      instructions: 'test',
    });
    const session = new MemorySession();
    const state = new RunState(new RunContext(), 'hello', agent as any, 10);
    const oldOutput: protocol.FunctionCallResultItem = {
      type: 'function_call_result',
      callId: '',
      name: 'lookup',
      status: 'completed',
      output: 'old',
    };
    const newOutput: protocol.FunctionCallResultItem = {
      ...oldOutput,
      output: 'new',
    };
    state._generatedItems = [
      new ToolCallOutputItem(newOutput, agent, newOutput.output),
    ];

    await saveToSession(session, [oldOutput], new RunResult(state));

    expect(session.items).toEqual([oldOutput, newOutput]);
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

    await expectLoggerWarnings(
      [
        [
          'Restored session history after compaction replacement failed.',
          'object',
        ],
      ],
      async () => {
        await expect(
          saveToSession(session, [], new RunResult(state as any), {
            runCompaction: false,
          }),
        ).rejects.toThrow('replacement failed');
      },
    );
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

    const error = await expectLoggerWarnings(
      [
        [
          'Failed to restore session history after compaction replacement failed.',
          'object',
        ],
      ],
      () =>
        saveToSession(session, [], new RunResult(state as any), {
          runCompaction: false,
        }).catch((caught) => caught),
    );

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

  it('retains an applied override mutation when legacy reconciliation fails', async () => {
    let executions = 0;
    const approvalTool = tool({
      name: 'legacy_compaction_override_retry',
      description: 'Tool requiring approval.',
      parameters: z.object({ value: z.string() }),
      needsApproval: true,
      async execute({ value }) {
        executions += 1;
        return value;
      },
    });
    const agent = new Agent({
      name: 'LegacyCompactionOverrideRetryAgent',
      tools: [approvalTool],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const call: protocol.FunctionCallItem = {
      type: 'function_call',
      name: approvalTool.name,
      callId: 'call_legacy_compaction_override_retry',
      arguments: JSON.stringify({ value: 'original' }),
      status: 'completed',
    };
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'cmp_legacy_compaction_override_retry',
      encrypted_content: 'ciphertext',
    };
    const callItem = new ToolCallItem(call, agent);
    const approvalItem = new ToolApprovalItem(call, agent);
    const response = modelResponse([call]);
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
    state._modelResponses = [response];
    state._lastTurnResponse = response;
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 3;
    state.approve(approvalItem, {
      overrideArguments: { value: 'updated' },
    });

    class RewriteSession implements Session {
      readonly supportsExpectedHistoryMutations = true;
      items: AgentInputItem[] = [structuredClone(call)];
      rewriteCalls = 0;

      constructor(
        private readonly sessionId: string,
        private failNextAdd: boolean,
      ) {}

      async getSessionId(): Promise<string> {
        return this.sessionId;
      }

      async getItems(): Promise<AgentInputItem[]> {
        return structuredClone(this.items);
      }

      async addItems(items: AgentInputItem[]): Promise<void> {
        if (this.failNextAdd) {
          this.failNextAdd = false;
          this.items.push(structuredClone(items[0]!));
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

      async applyHistoryMutations(
        args: SessionHistoryRewriteArgs,
      ): Promise<void> {
        this.rewriteCalls += 1;
        this.items = applySessionHistoryMutations(this.items, args.mutations);
      }
    }

    const failingSession = new RewriteSession('failing-rewrite-session', true);
    await expectLoggerWarnings(
      [
        [
          'Restored session history after compaction replacement failed.',
          'object',
        ],
      ],
      async () => {
        await expect(
          new Runner().run(agent, state, { session: failingSession }),
        ).rejects.toThrow('replacement failed');
      },
    );

    expect(executions).toBe(0);
    expect(failingSession.rewriteCalls).toBe(1);
    expect(
      failingSession.items.find((item) => item.type === 'function_call'),
    ).toMatchObject({ arguments: JSON.stringify({ value: 'updated' }) });
    expect(state._getSessionHistoryMutations()).toHaveLength(1);

    const retrySession = new RewriteSession('retry-rewrite-session', false);
    const result = await new Runner().run(agent, state, {
      session: retrySession,
    });

    expect(result.finalOutput).toBe('updated');
    expect(executions).toBe(1);
    expect(retrySession.rewriteCalls).toBe(1);
    expect(
      retrySession.items.find((item) => item.type === 'function_call'),
    ).toMatchObject({ arguments: JSON.stringify({ value: 'updated' }) });
    expect(state._getSessionHistoryMutations()).toEqual([]);
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
