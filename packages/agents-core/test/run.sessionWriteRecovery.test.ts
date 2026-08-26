import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  RunState,
  Usage,
  UserError,
  run,
  setTracingDisabled,
  tool,
  type AgentInputItem,
  type OpenAIResponsesCompactionArgs,
  type Session,
  type SessionHistoryTransactionArgs,
  type SessionHistoryTransactionAwareSession,
  type ToolToFinalOutputFunction,
  type ToolUseBehavior,
} from '../src';
import * as protocol from '../src/types/protocol';
import { attachClientToolSearchExecutor } from '../src/tool';
import { ScriptedModel, modelResponder } from '../src/testing';
import { fakeModelMessage } from './stubs';

type RunMode = 'non_streamed' | 'streamed';

class UncertainAppendSession implements Session {
  readonly compactionArgs: OpenAIResponsesCompactionArgs[] = [];
  addCalls = 0;
  sessionIdCalls = 0;
  itemsCalls = 0;
  policyCalls = 0;
  collapseComparisonItems = false;
  rejectComparisonWithToolResult = false;
  private items: AgentInputItem[] = [];
  private failure: 'before' | 'after' | 'partial' | 'abort' | undefined;
  private compactionFailure = false;
  private compactionReplacementFailure = false;
  private sessionIdFailureCall: number | undefined;
  private readFailureCall: number | undefined;
  private policyFailureCall: number | undefined;
  private rejectAllPolicyReads = false;
  private preserveReasoningItemIds = false;
  private readGate: { started: () => void; promise: Promise<void> } | undefined;
  private compactionGate:
    { started: () => void; promise: Promise<void> } | undefined;

  constructor(private readonly sessionId = 'uncertain-append-session') {}

  failNextAppend(failure: 'before' | 'after' | 'partial' | 'abort') {
    this.failure = failure;
  }

  failNextCompaction() {
    this.compactionFailure = true;
  }

  failNextCompactionAfterReplacement() {
    this.compactionReplacementFailure = true;
  }

  failNextSessionIdRead() {
    this.failSessionIdReadAfter(1);
  }

  failNextItemsRead() {
    this.failItemsReadAfter(1);
  }

  failSessionIdReadAfter(additionalCalls: number) {
    this.sessionIdFailureCall = this.sessionIdCalls + additionalCalls;
  }

  failItemsReadAfter(additionalCalls: number) {
    this.readFailureCall = this.itemsCalls + additionalCalls;
  }

  failPolicyReadAfter(additionalCalls: number) {
    this.policyFailureCall = this.policyCalls + additionalCalls;
  }

  failAllPolicyReads() {
    this.rejectAllPolicyReads = true;
  }

  setPreserveReasoningItemIds(value: boolean) {
    this.preserveReasoningItemIds = value;
  }

  blockNextRead() {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.readGate = { started: markStarted, promise };
    return { started, release };
  }

  blockNextCompaction() {
    let markStarted!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.compactionGate = { started: markStarted, promise };
    return { started, release };
  }

  async getSessionId() {
    this.sessionIdCalls += 1;
    if (this.sessionIdFailureCall === this.sessionIdCalls) {
      this.sessionIdFailureCall = undefined;
      throw new Error('session ID read rejected');
    }
    return this.sessionId;
  }

  async getItems(limit?: number) {
    this.itemsCalls += 1;
    if (this.readFailureCall === this.itemsCalls) {
      this.readFailureCall = undefined;
      throw new Error('session history read rejected');
    }
    const gate = this.readGate;
    if (gate) {
      this.readGate = undefined;
      gate.started();
      await gate.promise;
    }
    const items = structuredClone(this.items);
    return limit === undefined ? items : items.slice(-Math.max(0, limit));
  }

  async addItems(items: AgentInputItem[]) {
    this.addCalls += 1;
    const failure = this.failure;
    this.failure = undefined;
    if (failure === 'before') {
      throw new Error('append rejected before commit');
    }
    if (failure === 'abort') {
      throw new DOMException('append cancelled', 'AbortError');
    }
    if (failure === 'partial') {
      this.items.push(...structuredClone(items.slice(0, 1)));
      throw new Error('append rejected after partial commit');
    }
    this.items.push(...structuredClone(items));
    if (failure === 'after') {
      throw new Error('append acknowledgement lost after commit');
    }
  }

  preserveReasoningItemIdsForPersistence() {
    this.policyCalls += 1;
    if (this.rejectAllPolicyReads) {
      throw new Error('Session persistence policy read rejected');
    }
    if (this.policyFailureCall === this.policyCalls) {
      this.policyFailureCall = undefined;
      throw new Error('Session persistence policy read rejected');
    }
    return this.preserveReasoningItemIds;
  }

  async popItem() {
    return this.items.pop();
  }

  async clearSession() {
    this.items = [];
  }

  prepareHistoryItemsForPersistenceComparison(items: AgentInputItem[]) {
    if (
      this.rejectComparisonWithToolResult &&
      items.some((item) => item.type === 'function_call_result')
    ) {
      throw new Error('tool result comparison rejected');
    }
    return this.collapseComparisonItems ? items.slice(0, 1) : items;
  }

  async runCompaction(args?: OpenAIResponsesCompactionArgs) {
    this.compactionArgs.push(args ?? {});
    const gate = this.compactionGate;
    if (gate) {
      this.compactionGate = undefined;
      gate.started();
      await gate.promise;
    }
    if (this.compactionReplacementFailure) {
      this.compactionReplacementFailure = false;
      this.items = [
        {
          type: 'compaction',
          encrypted_content: 'replacement-acknowledgement-lost',
        },
      ];
      throw new Error('input compaction acknowledgement lost');
    }
    if (this.compactionFailure) {
      this.compactionFailure = false;
      throw new Error('input compaction rejected');
    }
    return null;
  }
}

class TransactionAwareUncertainAppendSession
  extends UncertainAppendSession
  implements SessionHistoryTransactionAwareSession
{
  historyTransactionCalls = 0;

  async applyHistoryTransaction(_args: SessionHistoryTransactionArgs) {
    this.historyTransactionCalls += 1;
    throw new Error('unexpected history transaction');
  }
}

function functionToolCall(callId = 'approval-call'): protocol.FunctionCallItem {
  return {
    type: 'function_call',
    id: `${callId}-item`,
    callId,
    name: 'approval_tool',
    status: 'completed',
    arguments: '{}',
    providerData: {},
  };
}

async function runOnce<TAgent extends Agent<any, any>>(
  mode: RunMode,
  agent: TAgent,
  input: string | RunState<unknown, TAgent>,
  session: Session,
  options: { reasoningItemIdPolicy?: 'preserve' | 'omit' } = {},
) {
  if (mode === 'streamed') {
    const result = await run(agent, input, {
      session,
      stream: true,
      ...options,
    });
    await result.completed;
    return result;
  }
  return await run(agent, input, { session, ...options });
}

async function runWithoutSession<TAgent extends Agent<any, any>>(
  mode: RunMode,
  agent: TAgent,
  input: RunState<unknown, TAgent>,
) {
  if (mode === 'streamed') {
    const result = await run(agent, input, { stream: true });
    await result.completed;
    return result;
  }
  return await run(agent, input);
}

function createApprovalRun(
  execute = vi.fn(async () => 'approved-result'),
  toolUseBehavior: ToolUseBehavior = 'run_llm_again',
) {
  const approvalTool = tool({
    name: 'approval_tool',
    description: 'Returns a result after approval.',
    parameters: z.object({}),
    needsApproval: true,
    execute,
  });
  const model = new ScriptedModel([
    modelResponder(() => ({
      output: [functionToolCall()],
      usage: new Usage(),
    })),
    modelResponder(() => ({
      output: [fakeModelMessage('done')],
      usage: new Usage(),
    })),
  ]);
  const agent = new Agent({
    name: 'Session write recovery agent',
    model,
    tools: [approvalTool],
    toolUseBehavior,
  });
  return { agent, execute, model };
}

function createApprovalRunWithToolSearch(
  toolUseBehavior: 'run_llm_again' | 'stop_on_first_tool' = 'run_llm_again',
) {
  const approvalTool = tool({
    name: 'approval_tool',
    description: 'Returns a result after approval.',
    parameters: z.object({}),
    needsApproval: true,
    execute: async () => 'approved-result',
  });
  const loadedTool = tool({
    name: 'loaded_tool',
    description: 'Loaded by client tool search.',
    parameters: z.object({}),
    execute: async () => 'loaded-result',
  });
  const toolSearchExecute = vi.fn(async () => loadedTool);
  const toolSearch = attachClientToolSearchExecutor(
    {
      type: 'hosted_tool',
      name: 'tool_search',
      providerData: {
        type: 'tool_search',
        execution: 'client',
        parameters: {
          type: 'object',
          properties: {},
          additionalProperties: false,
        },
      },
    },
    toolSearchExecute,
  );

  const model = new ScriptedModel([
    modelResponder(() => ({
      output: [
        {
          type: 'tool_search_call',
          id: 'tool-search-item',
          status: 'completed',
          arguments: {},
          providerData: { call_id: 'tool-search-call' },
        } as protocol.ToolSearchCallItem,
        functionToolCall(),
      ],
      usage: new Usage(),
    })),
    modelResponder(() => ({
      output: [fakeModelMessage('done')],
      usage: new Usage(),
    })),
  ]);
  const agent = new Agent({
    name: 'Session write recovery agent with tool search',
    model,
    tools: [approvalTool, toolSearch],
    toolUseBehavior,
  });
  return { agent, model, toolSearchExecute };
}

describe('resumed Session write recovery', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });

  it.each([
    ['function', '1.20'],
    ['function', '1.19'],
    ['declarative', '1.20'],
    ['declarative', '1.19'],
  ] as const)(
    'does not infer pending compaction from an ordinary %s terminal schema %s state',
    async (behaviorKind, schemaVersion) => {
      const execute = vi.fn(async () => 'ordinary-result');
      const ordinaryTool = tool({
        name: 'approval_tool',
        description: 'Returns an ordinary terminal result.',
        parameters: z.object({}),
        execute,
      });
      const customBehavior = vi.fn<ToolToFinalOutputFunction>(async () => ({
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: 'ordinary-result',
      }));
      const model = new ScriptedModel([
        modelResponder(() => ({
          output: [functionToolCall('ordinary-call')],
          usage: new Usage(),
        })),
      ]);
      const agent = new Agent({
        name: 'Ordinary terminal Session agent',
        model,
        tools: [ordinaryTool],
        toolUseBehavior:
          behaviorKind === 'function' ? customBehavior : 'stop_on_first_tool',
      });
      const session = new UncertainAppendSession();
      const completed = await runOnce(
        'non_streamed',
        agent,
        'Use approval_tool',
        session,
      );
      expect(completed.finalOutput).toBe('ordinary-result');
      const compactionsAfterCompletion = session.compactionArgs.length;

      const serialized = completed.state.toJSON() as any;
      expect(
        serialized.currentTurnSessionWriteCompactedItemCount,
      ).toBeUndefined();
      if (schemaVersion === '1.19') {
        serialized.$schemaVersion = schemaVersion;
        delete serialized.currentResponseGeneratedItemOwnership;
        delete serialized.currentTurnSessionWriteCompactedItemCount;
        delete serialized.pendingSessionWrite;
      }
      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );
      const resumed = await runOnce('non_streamed', agent, restored, session);

      expect(resumed.finalOutput).toBe('ordinary-result');
      expect(session.compactionArgs).toHaveLength(compactionsAfterCompletion);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(customBehavior).toHaveBeenCalledTimes(
        behaviorKind === 'function' ? 1 : 0,
      );
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'recovers a transaction-aware Session ordinary $mode checkpoint after serialization',
    async (mode) => {
      const { agent, execute, model } = createApprovalRun();
      const session = new TransactionAwareUncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      const serialized = first.state.toJSON() as any;
      expect(serialized.pendingSessionWrite).toBeDefined();
      expect(serialized.currentTurnExecutedWithSessionBinding).toBe(true);
      expect(serialized.pendingSessionWrite.appendItems).toBeUndefined();

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );
      const completed = await runOnce(mode, agent, restored, session);

      expect(completed.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
      expect(session.historyTransactionCalls).toBe(0);
      expect(restored._currentTurnSessionHistoryTransactionSessionId).toBe(
        undefined,
      );
      expect(restored._currentTurnSessionHistoryTransactionInputItems).toBe(
        undefined,
      );
      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual([
        'message:user',
        'function_call',
        'function_call_result',
        'message:assistant',
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'reconstructs a serialized transaction-aware passing-guardrail $mode checkpoint',
    async (mode) => {
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        'stop_on_first_tool',
      );
      agent.outputGuardrails.push({
        name: 'passing recovery guardrail',
        execute: async () => ({
          outputInfo: undefined,
          tripwireTriggered: false,
        }),
      });
      const session = new TransactionAwareUncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      const serialized = first.state.toJSON() as any;
      expect(serialized.currentTurnExecutedWithSessionBinding).toBe(true);
      expect(serialized.currentTurnSessionInputItems).toBeUndefined();
      expect(serialized.pendingSessionWrite).not.toHaveProperty('appendItems');
      expect(serialized.pendingSessionWrite).not.toHaveProperty(
        'appendInputItemCount',
      );

      const restored = await RunState.fromString(
        agent,
        JSON.stringify(serialized),
      );
      const completed = await runOnce(mode, agent, restored, session);

      expect(completed.finalOutput).toBe('approved-result');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(session.historyTransactionCalls).toBe(0);
      expect(
        (await session.getItems()).map((item) =>
          item.type === 'message' ? `${item.type}:${item.role}` : item.type,
        ),
      ).toEqual(['message:user', 'function_call', 'function_call_result']);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'retains a transaction-aware Session ordinary $mode checkpoint when post-tool preflight fails',
    async (mode) => {
      const session = new TransactionAwareUncertainAppendSession();
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => {
          session.failNextSessionIdRead();
          return 'approved-result';
        }),
      );
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /session ID read rejected/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe('prepared');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(session.historyTransactionCalls).toBe(0);

      const restored = await RunState.fromString(agent, first.state.toString());
      const completed = await runOnce(mode, agent, restored, session);

      expect(completed.finalOutput).toBe('done');
      expect(restored._pendingSessionWrite).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
      expect(session.historyTransactionCalls).toBe(0);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'retains a $mode checkpoint when the Session policy hook fails after tool execution',
    async (mode) => {
      const session = new TransactionAwareUncertainAppendSession();
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => {
          session.failPolicyReadAfter(1);
          return 'approved-result';
        }),
      );
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /policy read rejected/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe('prepared');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(session.historyTransactionCalls).toBe(0);

      const restored = await RunState.fromString(agent, first.state.toString());
      const completed = await runOnce(mode, agent, restored, session);

      expect(completed.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
      expect(session.historyTransactionCalls).toBe(0);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'keeps $mode reconciliation fail closed while the Session policy hook keeps failing',
    async (mode) => {
      const session = new TransactionAwareUncertainAppendSession();
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => {
          session.failAllPolicyReads();
          return 'approved-result';
        }),
      );
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /policy read rejected/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe('prepared');
      const sessionCallsBeforeRetry = {
        add: session.addCalls,
        compaction: session.compactionArgs.length,
        id: session.sessionIdCalls,
        items: session.itemsCalls,
      };

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /policy read rejected/,
      );

      expect(first.state._pendingSessionWrite?.phase).toBe('prepared');
      expect(session.addCalls).toBe(sessionCallsBeforeRetry.add);
      expect(session.compactionArgs).toHaveLength(
        sessionCallsBeforeRetry.compaction,
      );
      expect(session.sessionIdCalls).toBe(sessionCallsBeforeRetry.id);
      expect(session.itemsCalls).toBe(sessionCallsBeforeRetry.items);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(session.historyTransactionCalls).toBe(0);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects a changed $mode Session policy before reconciling the append',
    async (mode) => {
      const session = new TransactionAwareUncertainAppendSession();
      session.setPreserveReasoningItemIds(true);
      const { agent, execute, model } = createApprovalRun();
      const first = await runOnce(mode, agent, 'Use approval_tool', session, {
        reasoningItemIdPolicy: 'omit',
      });
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('before');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /before commit/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe('append_ready');
      session.setPreserveReasoningItemIds(false);
      const sessionCallsBeforeRetry = {
        add: session.addCalls,
        compaction: session.compactionArgs.length,
        id: session.sessionIdCalls,
        items: session.itemsCalls,
      };

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /policy changed while a resumed write was pending/,
      );

      expect(first.state._pendingSessionWrite?.phase).toBe('append_ready');
      expect(session.addCalls).toBe(sessionCallsBeforeRetry.add);
      expect(session.compactionArgs).toHaveLength(
        sessionCallsBeforeRetry.compaction,
      );
      expect(session.sessionIdCalls).toBe(sessionCallsBeforeRetry.id);
      expect(session.itemsCalls).toBe(sessionCallsBeforeRetry.items);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(session.historyTransactionCalls).toBe(0);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'fails before approved tool execution when $mode Session ID preparation fails',
    async (mode) => {
      const { agent, execute, model } = createApprovalRun();
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextSessionIdRead();

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /read rejected/,
      );
      expect(execute).not.toHaveBeenCalled();
      expect(model.calls).toHaveLength(1);
      expect(first.state._pendingSessionWrite).toBeUndefined();

      const completed = await runOnce(mode, agent, first.state, session);
      expect(completed.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'recovers a serialized $mode prepared phase after comparison fails',
    async (mode) => {
      const { agent, execute, model } = createApprovalRun();
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.rejectComparisonWithToolResult = true;

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /tool result comparison rejected/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe('prepared');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);

      const restored = await RunState.fromString(agent, first.state.toString());
      session.rejectComparisonWithToolResult = false;
      const completed = await runOnce(mode, agent, restored, session);

      expect(completed.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
      expect(restored._pendingSessionWrite).toBeUndefined();
    },
  );

  it.each<{
    mode: RunMode;
    failure: 'session_id' | 'history';
  }>([
    { mode: 'non_streamed', failure: 'session_id' },
    { mode: 'streamed', failure: 'history' },
  ])(
    'retains a prepared $mode checkpoint when the post-tool Session $failure read fails',
    async ({ mode, failure }) => {
      const { agent, execute, model } = createApprovalRun();
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      if (failure === 'session_id') {
        session.failSessionIdReadAfter(2);
      } else {
        session.failNextItemsRead();
      }

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /read rejected/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe('prepared');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);

      const completed = await runOnce(mode, agent, first.state, session);
      expect(completed.finalOutput).toBe('done');
      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
    },
  );

  it.each<{
    mode: RunMode;
    failure: 'before' | 'after';
    serialize: boolean;
  }>([
    { mode: 'non_streamed', failure: 'before', serialize: false },
    { mode: 'non_streamed', failure: 'after', serialize: true },
    { mode: 'streamed', failure: 'before', serialize: true },
    { mode: 'streamed', failure: 'after', serialize: false },
  ])(
    'settles a $failure-commit $mode append before another model call',
    async ({ mode, failure, serialize }) => {
      const { agent, execute, model } = createApprovalRun();
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      expect(first.interruptions).toHaveLength(1);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend(failure);

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /append/,
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(first.state._pendingSessionWrite).toBeDefined();

      const resumedState = serialize
        ? await RunState.fromString(agent, first.state.toString())
        : first.state;
      const completed = await runOnce(mode, agent, resumedState, session);

      expect(completed.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
      expect(resumedState._pendingSessionWrite).toBeUndefined();
      expect(session.compactionArgs.at(-1)).toMatchObject({
        compactionMode: 'input',
      });
      const toolItems = (await session.getItems()).filter(
        (item) =>
          item.type === 'function_call' || item.type === 'function_call_result',
      );
      expect(toolItems.map((item) => item.type)).toEqual([
        'function_call',
        'function_call_result',
      ]);
    },
  );

  it.each<{ mode: RunMode; serialize: boolean }>([
    { mode: 'non_streamed', serialize: true },
    { mode: 'streamed', serialize: false },
  ])(
    'recovers a committed terminal-tool $mode append before completing',
    async ({ mode, serialize }) => {
      const execute = vi.fn(async () => 'approved-result');
      const { agent, model } = createApprovalRun(execute, 'stop_on_first_tool');
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      expect(first.state._pendingSessionWrite).toBeDefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      const compactionsBeforeRecovery = session.compactionArgs.length;

      const resumedState = serialize
        ? await RunState.fromString(agent, first.state.toString())
        : first.state;
      const completed = await runOnce(mode, agent, resumedState, session);

      expect(completed.finalOutput).toBe('approved-result');
      expect(resumedState._pendingSessionWrite).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(session.compactionArgs).toHaveLength(
        compactionsBeforeRecovery + 1,
      );
      expect(session.compactionArgs.at(-1)).toMatchObject({
        compactionMode: 'input',
      });
      const toolItems = (await session.getItems()).filter(
        (item) =>
          item.type === 'function_call' || item.type === 'function_call_result',
      );
      expect(toolItems.map((item) => item.type)).toEqual([
        'function_call',
        'function_call_result',
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'recovers a serialized stopAtToolNames terminal $mode append',
    async (mode) => {
      const execute = vi.fn(async () => 'approved-result');
      const { agent, model } = createApprovalRun(execute, {
        stopAtToolNames: ['approval_tool'],
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      const restored = await RunState.fromString(agent, first.state.toString());
      const completed = await runOnce(mode, agent, restored, session);

      expect(completed.finalOutput).toBe('approved-result');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(restored._pendingSessionWrite).toBeUndefined();
    },
  );

  it.each<{ mode: RunMode; serialize: boolean }>([
    { mode: 'non_streamed', serialize: false },
    { mode: 'streamed', serialize: true },
  ])(
    'recovers a passing-output-guardrail terminal $mode append with serialize=$serialize',
    async ({ mode, serialize }) => {
      const execute = vi.fn(async () => 'approved-result');
      const { agent, model } = createApprovalRun(execute, 'stop_on_first_tool');
      const outputGuardrail = vi.fn(async () => ({
        outputInfo: undefined,
        tripwireTriggered: false,
      }));
      agent.outputGuardrails.push({
        name: 'passing terminal guardrail',
        execute: outputGuardrail,
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      expect(first.state._pendingSessionWrite).toBeDefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(outputGuardrail).toHaveBeenCalledTimes(1);
      const compactionsBeforeRecovery = session.compactionArgs.length;

      const resumedState = serialize
        ? await RunState.fromString(agent, first.state.toString())
        : first.state;
      const completed = await runOnce(mode, agent, resumedState, session);

      expect(completed.finalOutput).toBe('approved-result');
      expect(resumedState._pendingSessionWrite).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(outputGuardrail).toHaveBeenCalledTimes(2);
      expect(session.compactionArgs).toHaveLength(
        compactionsBeforeRecovery + 1,
      );
      const toolItems = (await session.getItems()).filter(
        (item) =>
          item.type === 'function_call' || item.type === 'function_call_result',
      );
      expect(toolItems.map((item) => item.type)).toEqual([
        'function_call',
        'function_call_result',
      ]);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects an ambiguous serialized sequential-approval terminal $mode append and recovers it live',
    async (mode) => {
      const firstExecute = vi.fn(async () => 'first-result');
      const secondExecute = vi.fn(async () => 'second-result');
      const firstTool = tool({
        name: 'first_approval_tool',
        description: 'Requires the first approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: firstExecute,
      });
      const secondTool = tool({
        name: 'second_approval_tool',
        description: 'Requires the second approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: secondExecute,
      });
      const model = new ScriptedModel([
        modelResponder(() => ({
          output: [
            {
              ...functionToolCall('first-approval-call'),
              name: 'first_approval_tool',
            },
            {
              ...functionToolCall('second-approval-call'),
              name: 'second_approval_tool',
            },
          ],
          usage: new Usage(),
        })),
      ]);
      const agent = new Agent({
        name: 'Multi-approval recovery agent',
        model,
        tools: [firstTool, secondTool],
        toolUseBehavior: 'stop_on_first_tool',
        outputGuardrails: [
          {
            name: 'passing terminal guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const session = new UncertainAppendSession();

      const first = await runOnce(mode, agent, 'Use both tools', session);
      first.state.approve(first.interruptions[0]!);
      const partial = await runOnce(mode, agent, first.state, session);
      partial.state.approve(partial.interruptions[0]!);
      session.failNextAppend('after');

      await expect(
        runOnce(mode, agent, partial.state, session),
      ).rejects.toThrow(/acknowledgement lost/);
      expect(
        partial.state._pendingSessionWrite?.terminalToolFinalization,
      ).toMatchObject({
        behavior: 'stop_on_first_tool',
        selectedCallId: 'second-approval-call',
        finalOutput: 'second-result',
      });

      await expect(
        RunState.fromString(agent, partial.state.toString()),
      ).rejects.toThrow(/pending Session write is invalid/);
      const completed = await runOnce(mode, agent, partial.state, session);

      expect(completed.finalOutput).toBe('second-result');
      expect(firstExecute).toHaveBeenCalledTimes(1);
      expect(secondExecute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(partial.state._pendingSessionWrite).toBeUndefined();
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects a reordered serialized stop-on-first selection from a multi-approval $mode append',
    async (mode) => {
      const firstTool = tool({
        name: 'first_approval_tool',
        description: 'Requires the first approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'first-result',
      });
      const secondTool = tool({
        name: 'second_approval_tool',
        description: 'Requires the second approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: async () => 'second-result',
      });
      const model = new ScriptedModel([
        modelResponder(() => ({
          output: [
            {
              ...functionToolCall('first-approval-call'),
              name: 'first_approval_tool',
            },
            {
              ...functionToolCall('second-approval-call'),
              name: 'second_approval_tool',
            },
          ],
          usage: new Usage(),
        })),
      ]);
      const agent = new Agent({
        name: 'Ordered multi-approval recovery agent',
        model,
        tools: [firstTool, secondTool],
        toolUseBehavior: 'stop_on_first_tool',
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use both tools', session);
      first.state.approve(first.interruptions[0]!);
      first.state.approve(first.interruptions[1]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      expect(
        first.state._pendingSessionWrite?.terminalToolFinalization,
      ).toMatchObject({
        behavior: 'stop_on_first_tool',
        selectedCallId: 'first-approval-call',
        finalOutput: 'first-result',
      });
      await expect(
        RunState.fromString(agent, first.state.toString()),
      ).resolves.toBeInstanceOf(RunState);

      const forged = JSON.parse(first.state.toString());
      const secondGeneratedItemIndex = first.state._generatedItems.findIndex(
        (item) =>
          item.rawItem.type === 'function_call_result' &&
          item.rawItem.callId === 'second-approval-call',
      );
      expect(secondGeneratedItemIndex).toBeGreaterThanOrEqual(0);
      forged.pendingSessionWrite.terminalToolFinalization.selectedCallId =
        'second-approval-call';
      forged.pendingSessionWrite.terminalToolFinalization.selectedGeneratedItemIndex =
        secondGeneratedItemIndex;
      forged.pendingSessionWrite.terminalToolFinalization.finalOutput =
        'second-result';
      forged.currentStep.output = 'second-result';

      await expect(
        RunState.fromString(agent, JSON.stringify(forged)),
      ).rejects.toThrow(/pending Session write is invalid/);

      const duplicateOutput = JSON.parse(first.state.toString());
      const firstGeneratedItemIndex = duplicateOutput.generatedItems.findIndex(
        (item: { rawItem?: { type?: string; callId?: string } }) =>
          item.rawItem?.type === 'function_call_result' &&
          item.rawItem.callId === 'first-approval-call',
      );
      expect(firstGeneratedItemIndex).toBeGreaterThanOrEqual(0);
      const canonicalOutput = duplicateOutput.generatedItems[
        firstGeneratedItemIndex
      ] as {
        rawItem: { output: unknown };
        output: unknown;
      };
      duplicateOutput.generatedItems.push(
        JSON.parse(JSON.stringify(canonicalOutput)),
      );
      canonicalOutput.rawItem.output = 'forged-first-result';
      canonicalOutput.output = 'forged-first-result';
      duplicateOutput.pendingSessionWrite.persistedItemCount =
        duplicateOutput.generatedItems.length;
      duplicateOutput.pendingSessionWrite.terminalToolFinalization.selectedGeneratedItemIndex =
        firstGeneratedItemIndex;
      duplicateOutput.pendingSessionWrite.terminalToolFinalization.finalOutput =
        'forged-first-result';
      duplicateOutput.currentStep.output = 'forged-first-result';

      await expect(
        RunState.fromString(agent, JSON.stringify(duplicateOutput)),
      ).rejects.toThrow(/pending Session write is invalid/);
      expect(model.calls).toHaveLength(1);
    },
  );

  it('rejects incomplete or reordered serialized custom-callback result provenance', async () => {
    const firstTool = tool({
      name: 'first_callback_tool',
      description: 'Returns the first callback input.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'first-result',
    });
    const secondTool = tool({
      name: 'second_callback_tool',
      description: 'Returns the second callback input.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'second-result',
    });
    const customBehavior = vi.fn<ToolToFinalOutputFunction>(
      async (_context, results) => ({
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: results
          .map((result) =>
            result.type === 'function_output' ? String(result.output) : '',
          )
          .join(','),
      }),
    );
    const model = new ScriptedModel([
      modelResponder(() => ({
        output: [
          {
            ...functionToolCall('first-callback-call'),
            name: 'first_callback_tool',
          },
          {
            ...functionToolCall('second-callback-call'),
            name: 'second_callback_tool',
          },
        ],
        usage: new Usage(),
      })),
    ]);
    const agent = new Agent({
      name: 'Multi-result callback recovery agent',
      model,
      tools: [firstTool, secondTool],
      toolUseBehavior: customBehavior,
    });
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use both callback tools',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    first.state.approve(first.interruptions[1]!);
    session.failNextAppend('after');

    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/acknowledgement lost/);
    expect(
      first.state._pendingSessionWrite?.terminalToolFinalization,
    ).toMatchObject({
      behavior: 'function',
      finalOutput: 'first-result,second-result',
    });
    const serialized = JSON.parse(first.state.toString());
    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(/pending Session write is invalid/);
    expect(customBehavior).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'recovers a mixed-result custom callback from only the resumed $mode result range',
    async (mode) => {
      const immediateExecute = vi.fn(async () => 'immediate-result');
      const approvedExecute = vi.fn(async () => 'approved-result');
      const immediateTool = tool({
        name: 'immediate_tool',
        description: 'Completes before the sibling approval.',
        parameters: z.object({}),
        execute: immediateExecute,
      });
      const approvalTool = tool({
        name: 'approval_tool',
        description: 'Completes after approval.',
        parameters: z.object({}),
        needsApproval: true,
        execute: approvedExecute,
      });
      const customBehavior = vi.fn<ToolToFinalOutputFunction>(
        async (_context, results) => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: `callback:${results
            .map((result) =>
              result.type === 'function_output' ? String(result.output) : '',
            )
            .join(',')}`,
        }),
      );
      const model = new ScriptedModel([
        modelResponder(() => ({
          output: [
            {
              ...functionToolCall('immediate-call'),
              name: 'immediate_tool',
            },
            {
              ...functionToolCall('approved-call'),
              name: 'approval_tool',
            },
          ],
          usage: new Usage(),
        })),
      ]);
      const agent = new Agent({
        name: 'Mixed-result callback recovery agent',
        model,
        tools: [immediateTool, approvalTool],
        toolUseBehavior: customBehavior,
        outputGuardrails: [
          {
            name: 'passing mixed-result guardrail',
            execute: async () => ({
              outputInfo: undefined,
              tripwireTriggered: false,
            }),
          },
        ],
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use both tools', session);

      expect(first.interruptions).toHaveLength(1);
      expect(immediateExecute).toHaveBeenCalledTimes(1);
      expect(approvedExecute).not.toHaveBeenCalled();
      expect(customBehavior).not.toHaveBeenCalled();
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      const finalization =
        first.state._pendingSessionWrite?.terminalToolFinalization;
      expect(finalization).toMatchObject({
        behavior: 'function',
        finalOutput: 'callback:approved-result',
      });
      await expect(
        RunState.fromString(agent, first.state.toString()),
      ).rejects.toThrow(/pending Session write is invalid/);
      expect(immediateExecute).toHaveBeenCalledTimes(1);
      expect(approvedExecute).toHaveBeenCalledTimes(1);
      expect(customBehavior).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it('recovers serialized custom terminal behavior without replaying its callback', async () => {
    const customBehavior = vi.fn<ToolToFinalOutputFunction>(
      async (_context, results) => {
        const firstResult = results[0];
        return {
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: `custom:${String(
            firstResult?.type === 'function_output' ? firstResult.output : '',
          )}`,
        };
      },
    );
    const { agent, execute, model } = createApprovalRun(
      vi.fn(async () => 'approved-result'),
      customBehavior,
    );
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');

    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/acknowledgement lost/);
    expect(first.state._pendingSessionWrite).toBeDefined();
    expect(customBehavior).toHaveBeenCalledTimes(1);

    await expect(
      RunState.fromString(agent, first.state.toString()),
    ).rejects.toThrow(/pending Session write is invalid/);
    expect(customBehavior).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('rejects serialized terminal-write authority when stopAtToolNames no longer selects the completed tool', async () => {
    const { agent, execute, model } = createApprovalRun(
      vi.fn(async () => 'approved-result'),
      { stopAtToolNames: ['approval_tool'] },
    );
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/acknowledgement lost/);

    agent.toolUseBehavior = { stopAtToolNames: ['different_tool'] };
    await expect(
      RunState.fromString(agent, first.state.toString()),
    ).rejects.toThrow(/pending Session write is invalid/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('rejects serialized terminal-write authority when the trusted agent no longer stops on tool output', async () => {
    const { agent, execute, model } = createApprovalRun(
      vi.fn(async () => 'approved-result'),
      'stop_on_first_tool',
    );
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/acknowledgement lost/);

    agent.toolUseBehavior = 'run_llm_again';
    await expect(
      RunState.fromString(agent, first.state.toString()),
    ).rejects.toThrow(/pending Session write is invalid/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('rejects a live stopAtToolNames checkpoint after changing to run_llm_again before Session access', async () => {
    const { agent, execute, model } = createApprovalRun(
      vi.fn(async () => 'approved-result'),
      { stopAtToolNames: ['approval_tool'] },
    );
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/acknowledgement lost/);
    const sessionCallsBeforeRetry = {
      add: session.addCalls,
      compaction: session.compactionArgs.length,
      id: session.sessionIdCalls,
      items: session.itemsCalls,
    };

    agent.toolUseBehavior = 'run_llm_again';
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/pending Session write is invalid/);

    expect(session.addCalls).toBe(sessionCallsBeforeRetry.add);
    expect(session.compactionArgs).toHaveLength(
      sessionCallsBeforeRetry.compaction,
    );
    expect(session.sessionIdCalls).toBe(sessionCallsBeforeRetry.id);
    expect(session.itemsCalls).toBe(sessionCallsBeforeRetry.items);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('rejects a live streamed stopAtToolNames checkpoint after changing to a nonmatching list before Session access', async () => {
    const { agent, execute, model } = createApprovalRun(
      vi.fn(async () => 'approved-result'),
      { stopAtToolNames: ['approval_tool'] },
    );
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');
    await expect(
      runOnce('streamed', agent, first.state, session),
    ).rejects.toThrow(/acknowledgement lost/);
    const sessionCallsBeforeRetry = {
      add: session.addCalls,
      compaction: session.compactionArgs.length,
      id: session.sessionIdCalls,
      items: session.itemsCalls,
    };

    agent.toolUseBehavior = { stopAtToolNames: ['different_tool'] };
    await expect(
      runOnce('streamed', agent, first.state, session),
    ).rejects.toThrow(/pending Session write is invalid/);

    expect(session.addCalls).toBe(sessionCallsBeforeRetry.add);
    expect(session.compactionArgs).toHaveLength(
      sessionCallsBeforeRetry.compaction,
    );
    expect(session.sessionIdCalls).toBe(sessionCallsBeforeRetry.id);
    expect(session.itemsCalls).toBe(sessionCallsBeforeRetry.items);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('rejects a live custom terminal checkpoint after changing its callback before Session access', async () => {
    const originalBehavior = vi.fn<ToolToFinalOutputFunction>(
      async (_context, results) => ({
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: `custom:${String(
          results[0]?.type === 'function_output' ? results[0].output : '',
        )}`,
      }),
    );
    const replacementBehavior = vi.fn<ToolToFinalOutputFunction>(async () => ({
      isFinalOutput: true,
      isInterrupted: undefined,
      finalOutput: 'replacement',
    }));
    const { agent, execute, model } = createApprovalRun(
      vi.fn(async () => 'approved-result'),
      originalBehavior,
    );
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/acknowledgement lost/);
    const sessionCallsBeforeRetry = {
      add: session.addCalls,
      compaction: session.compactionArgs.length,
      id: session.sessionIdCalls,
      items: session.itemsCalls,
    };

    agent.toolUseBehavior = replacementBehavior;
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/pending Session write is invalid/);

    expect(originalBehavior).toHaveBeenCalledTimes(1);
    expect(replacementBehavior).not.toHaveBeenCalled();
    expect(session.addCalls).toBe(sessionCallsBeforeRetry.add);
    expect(session.compactionArgs).toHaveLength(
      sessionCallsBeforeRetry.compaction,
    );
    expect(session.sessionIdCalls).toBe(sessionCallsBeforeRetry.id);
    expect(session.itemsCalls).toBe(sessionCallsBeforeRetry.items);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('recovers a live streamed custom terminal checkpoint with the exact callback', async () => {
    const customBehavior = vi.fn<ToolToFinalOutputFunction>(
      async (_context, results) => ({
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: `custom:${String(
          results[0]?.type === 'function_output' ? results[0].output : '',
        )}`,
      }),
    );
    const { agent, execute, model } = createApprovalRun(
      vi.fn(async () => 'approved-result'),
      customBehavior,
    );
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');
    await expect(
      runOnce('streamed', agent, first.state, session),
    ).rejects.toThrow(/acknowledgement lost/);
    const compactionsBeforeRecovery = session.compactionArgs.length;

    const completed = await runOnce('streamed', agent, first.state, session);

    expect(completed.finalOutput).toBe('custom:approved-result');
    expect(first.state._pendingSessionWrite).toBeUndefined();
    expect(customBehavior).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
    expect(session.compactionArgs).toHaveLength(compactionsBeforeRecovery + 1);
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'retains the producing custom callback when a $mode output guardrail is suspended',
    async (mode) => {
      let markGuardrailStarted!: () => void;
      let releaseGuardrail!: () => void;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      const guardrailGate = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      const originalBehavior = vi.fn<ToolToFinalOutputFunction>(
        async (_context, results) => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: `custom:${String(
            results[0]?.type === 'function_output' ? results[0].output : '',
          )}`,
        }),
      );
      const replacementBehavior = vi.fn<ToolToFinalOutputFunction>(
        async () => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: 'replacement',
        }),
      );
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        originalBehavior,
      );
      agent.outputGuardrails.push({
        name: 'suspended terminal guardrail',
        execute: async () => {
          markGuardrailStarted();
          await guardrailGate;
          return { outputInfo: undefined, tripwireTriggered: false };
        },
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      const appendCallsBeforeResume = session.addCalls;

      const resumed = runOnce(mode, agent, first.state, session);
      const rejectedResume = expect(resumed).rejects.toThrow(
        /pending Session write is invalid/,
      );
      await guardrailStarted;
      agent.toolUseBehavior = replacementBehavior;
      releaseGuardrail();
      await rejectedResume;

      expect(first.state._pendingSessionWrite).toBeDefined();
      expect(session.addCalls).toBe(appendCallsBeforeResume);
      expect(originalBehavior).toHaveBeenCalledTimes(1);
      expect(replacementBehavior).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      const sessionCallsBeforeRetry = {
        add: session.addCalls,
        compaction: session.compactionArgs.length,
        id: session.sessionIdCalls,
        items: session.itemsCalls,
      };

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /pending Session write is invalid/,
      );

      expect(session.addCalls).toBe(sessionCallsBeforeRetry.add);
      expect(session.compactionArgs).toHaveLength(
        sessionCallsBeforeRetry.compaction,
      );
      expect(session.sessionIdCalls).toBe(sessionCallsBeforeRetry.id);
      expect(session.itemsCalls).toBe(sessionCallsBeforeRetry.items);
      expect(originalBehavior).toHaveBeenCalledTimes(1);
      expect(replacementBehavior).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<{
    mode: RunMode;
    replacement: ToolUseBehavior;
  }>([
    { mode: 'non_streamed', replacement: 'stop_on_first_tool' },
    {
      mode: 'streamed',
      replacement: { stopAtToolNames: ['approval_tool'] },
    },
  ])(
    'does not reclassify a function-produced $mode terminal output through declarative behavior',
    async ({ mode, replacement }) => {
      let markGuardrailStarted!: () => void;
      let releaseGuardrail!: () => void;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      const guardrailGate = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      const originalBehavior = vi.fn<ToolToFinalOutputFunction>(
        async (_context, results) => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: String(
            results[0]?.type === 'function_output' ? results[0].output : '',
          ),
        }),
      );
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        originalBehavior,
      );
      agent.outputGuardrails.push({
        name: 'suspended declarative replacement guardrail',
        execute: async () => {
          markGuardrailStarted();
          await guardrailGate;
          return { outputInfo: undefined, tripwireTriggered: false };
        },
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      const appendCallsBeforeResume = session.addCalls;

      const resumed = runOnce(mode, agent, first.state, session);
      const rejectedResume = expect(resumed).rejects.toThrow(
        /pending Session write is invalid/,
      );
      await guardrailStarted;
      agent.toolUseBehavior = replacement;
      releaseGuardrail();
      await rejectedResume;

      expect(first.state._pendingSessionWrite).toBeDefined();
      expect(session.addCalls).toBe(appendCallsBeforeResume);
      expect(originalBehavior).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'recovers a committed $mode append after an unblocked output guardrail error',
    async (mode) => {
      let guardrailShouldFail = true;
      const customBehavior = vi.fn<ToolToFinalOutputFunction>(
        async (_context, results) => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: `custom:${String(
            results[0]?.type === 'function_output' ? results[0].output : '',
          )}`,
        }),
      );
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        customBehavior,
      );
      agent.outputGuardrails.push({
        name: 'retryable terminal guardrail error',
        execute: async () => {
          if (guardrailShouldFail) {
            throw new Error('retryable terminal guardrail failed');
          }
          return { outputInfo: undefined, tripwireTriggered: false };
        },
      });
      const session = new UncertainAppendSession();
      const runWithUnblockedGuardrailError = async (
        input: string | RunState<unknown, typeof agent>,
      ) => {
        if (mode === 'streamed') {
          const result = await run(agent, input, {
            session,
            stream: true,
          });
          await result.completed;
          return result;
        }
        return run(agent, input, {
          session,
        });
      };
      const first = await runWithUnblockedGuardrailError('Use approval_tool');
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runWithUnblockedGuardrailError(first.state)).rejects.toThrow(
        /Output guardrail failed to complete/,
      );

      expect(first.state._pendingSessionWrite).toBeDefined();
      expect(first.state._outputGuardrailResults).toHaveLength(0);
      expect(customBehavior).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      guardrailShouldFail = false;

      const completed = await runWithUnblockedGuardrailError(first.state);

      expect(completed.finalOutput).toBe('custom:approved-result');
      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(customBehavior).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      const toolResults = (await session.getItems()).filter(
        (item) => item.type === 'function_call_result',
      );
      expect(toolResults).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not repeat recovered input compaction after a $mode guardrail retry',
    async (mode) => {
      let guardrailAttempt = 0;
      const execute = vi.fn(async () => 'approved-result');
      const { agent, model } = createApprovalRun(execute, 'stop_on_first_tool');
      agent.outputGuardrails.push({
        name: 'fails only after reconciliation',
        execute: async () => {
          guardrailAttempt += 1;
          if (guardrailAttempt === 2) {
            throw new Error('post-reconciliation guardrail failed');
          }
          return { outputInfo: undefined, tripwireTriggered: false };
        },
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      const compactionsBeforeRecovery = session.compactionArgs.length;
      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /Output guardrail failed to complete/,
      );

      expect(session.compactionArgs).toHaveLength(
        compactionsBeforeRecovery + 1,
      );
      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(first.state._currentTurnSessionWriteCompactedItemCount).toBe(
        first.state._currentTurnPersistedItemCount,
      );

      const restored = await RunState.fromString(agent, first.state.toString());
      const completed = await runOnce(mode, agent, restored, session);

      expect(completed.finalOutput).toBe('approved-result');
      expect(session.compactionArgs).toHaveLength(
        compactionsBeforeRecovery + 1,
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not repeat recovered input compaction after $mode cancellation',
    async (mode) => {
      let guardrailAttempt = 0;
      let markGuardrailStarted!: () => void;
      let releaseGuardrail!: () => void;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      const guardrailGate = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      const execute = vi.fn(async () => 'approved-result');
      const { agent, model } = createApprovalRun(execute, 'stop_on_first_tool');
      agent.outputGuardrails.push({
        name: 'waits only after reconciliation',
        execute: async () => {
          guardrailAttempt += 1;
          if (guardrailAttempt === 2) {
            markGuardrailStarted();
            await guardrailGate;
          }
          return { outputInfo: undefined, tripwireTriggered: false };
        },
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      const compactionsBeforeRecovery = session.compactionArgs.length;
      const controller = new AbortController();
      const resumed =
        mode === 'streamed'
          ? (async () => {
              const result = await run(agent, first.state, {
                session,
                stream: true,
                signal: controller.signal,
              });
              await result.completed;
              return result;
            })()
          : run(agent, first.state, {
              session,
              signal: controller.signal,
            });

      await guardrailStarted;
      controller.abort();
      releaseGuardrail();
      const completedAfterCancellation = await resumed;

      expect(session.compactionArgs).toHaveLength(
        compactionsBeforeRecovery + 1,
      );
      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(first.state._currentTurnSessionWriteCompactedItemCount).toBe(
        first.state._currentTurnPersistedItemCount,
      );
      expect(completedAfterCancellation.finalOutput).toBe('approved-result');
      expect(session.compactionArgs).toHaveLength(
        compactionsBeforeRecovery + 1,
      );
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects a concurrent marker-only $mode retry before guardrail side effects',
    async (mode) => {
      let guardrailAttempt = 0;
      let markGuardrailStarted!: () => void;
      let releaseGuardrail!: () => void;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      const guardrailGate = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      const execute = vi.fn(async () => 'approved-result');
      const { agent, model } = createApprovalRun(execute, 'stop_on_first_tool');
      agent.outputGuardrails.push({
        name: 'blocks the first marker-only retry',
        execute: async () => {
          guardrailAttempt += 1;
          if (guardrailAttempt === 2) {
            throw new Error('post-reconciliation guardrail failed');
          }
          if (guardrailAttempt === 3) {
            markGuardrailStarted();
            await guardrailGate;
          }
          return { outputInfo: undefined, tripwireTriggered: false };
        },
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /Output guardrail failed to complete/,
      );
      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(first.state._currentTurnSessionWriteCompactedItemCount).toBe(
        first.state._currentTurnPersistedItemCount,
      );

      const activeRetry = runOnce(mode, agent, first.state, session);
      await guardrailStarted;
      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /cannot resume or reconcile.*concurrently/,
      );
      expect(guardrailAttempt).toBe(3);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);

      releaseGuardrail();
      const completed = await activeRetry;

      expect(completed.finalOutput).toBe('approved-result');
      expect(guardrailAttempt).toBe(3);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'atomically completes a $mode write when a passing output guardrail ignores cancellation',
    async (mode) => {
      let markGuardrailStarted!: () => void;
      let releaseGuardrail!: () => void;
      const suspendGuardrail = true;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      const guardrailGate = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      const customBehavior = vi.fn<ToolToFinalOutputFunction>(
        async (_context, results) => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: `custom:${String(
            results[0]?.type === 'function_output' ? results[0].output : '',
          )}`,
        }),
      );
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        customBehavior,
      );
      agent.outputGuardrails.push({
        name: 'passing guardrail that ignores cancellation',
        execute: async () => {
          if (suspendGuardrail) {
            markGuardrailStarted();
            await guardrailGate;
          }
          return { outputInfo: undefined, tripwireTriggered: false };
        },
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      const controller = new AbortController();
      const appendCallsBeforeResume = session.addCalls;
      const compactionsBeforeResume = session.compactionArgs.length;
      const resumed =
        mode === 'streamed'
          ? (async () => {
              const result = await run(agent, first.state, {
                session,
                stream: true,
                signal: controller.signal,
              });
              await result.completed;
              return result;
            })()
          : run(agent, first.state, {
              session,
              signal: controller.signal,
            });

      await guardrailStarted;
      controller.abort();
      releaseGuardrail();
      const completed = await resumed;

      expect(completed.finalOutput).toBe('custom:approved-result');
      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(session.addCalls).toBe(appendCallsBeforeResume + 1);
      expect(session.compactionArgs).toHaveLength(compactionsBeforeResume + 1);
      expect(customBehavior).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'retains a $mode checkpoint when cancellation wins during an output guardrail',
    async (mode) => {
      let markGuardrailStarted!: () => void;
      let markGuardrailFinished!: () => void;
      let releaseGuardrail!: () => void;
      let guardrailShouldFail = true;
      const guardrailStarted = new Promise<void>((resolve) => {
        markGuardrailStarted = resolve;
      });
      const guardrailFinished = new Promise<void>((resolve) => {
        markGuardrailFinished = resolve;
      });
      const guardrailGate = new Promise<void>((resolve) => {
        releaseGuardrail = resolve;
      });
      const originalBehavior = vi.fn<ToolToFinalOutputFunction>(
        async (_context, results) => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: `custom:${String(
            results[0]?.type === 'function_output' ? results[0].output : '',
          )}`,
        }),
      );
      const replacementBehavior = vi.fn<ToolToFinalOutputFunction>(
        async () => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: 'replacement',
        }),
      );
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        originalBehavior,
      );
      agent.outputGuardrails.push({
        name: 'cancelled terminal guardrail',
        execute: async () => {
          if (guardrailShouldFail) {
            try {
              markGuardrailStarted();
              await guardrailGate;
              throw new Error('guardrail stopped after cancellation');
            } finally {
              markGuardrailFinished();
            }
          }
          return { outputInfo: undefined, tripwireTriggered: false };
        },
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      const controller = new AbortController();
      const appendCallsBeforeResume = session.addCalls;
      const resumed =
        mode === 'streamed'
          ? (async () => {
              const result = await run(agent, first.state, {
                session,
                stream: true,
                signal: controller.signal,
              });
              await result.completed;
              return result;
            })()
          : run(agent, first.state, {
              session,
              signal: controller.signal,
            });
      const cancelledResume = expect(resumed).rejects.toMatchObject({
        name: 'AbortError',
      });
      await guardrailStarted;
      agent.toolUseBehavior = replacementBehavior;
      controller.abort();
      releaseGuardrail();
      await cancelledResume;
      await guardrailFinished;

      expect(first.state._pendingSessionWrite).toBeDefined();
      expect(first.state._outputGuardrailResults).toHaveLength(0);
      expect(session.addCalls).toBe(appendCallsBeforeResume);
      expect(originalBehavior).toHaveBeenCalledTimes(1);
      expect(replacementBehavior).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);

      agent.toolUseBehavior = originalBehavior;
      guardrailShouldFail = false;
      const completed = await runOnce(mode, agent, first.state, session);

      expect(completed.finalOutput).toBe('custom:approved-result');
      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(originalBehavior).toHaveBeenCalledTimes(1);
      expect(replacementBehavior).not.toHaveBeenCalled();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not publish an ordinary $mode checkpoint after blocked-message cancellation',
    async (mode) => {
      let markFormatterStarted!: () => void;
      const formatterStarted = new Promise<void>((resolve) => {
        markFormatterStarted = resolve;
      });
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        'stop_on_first_tool',
      );
      agent.outputGuardrails.push({
        name: 'blocked formatter cancellation guardrail',
        execute: async () => ({
          outputInfo: 'blocked formatter cancellation',
          tripwireTriggered: true,
        }),
      });
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      const appendCallsBeforeResume = session.addCalls;
      const controller = new AbortController();
      const abortReason = new Error('cancel blocked-message formatter');
      const outputGuardrailBlockedMessage = async () => {
        markFormatterStarted();
        return await new Promise<string>(() => {});
      };
      let streamedResult: any;
      const completionOutcome =
        mode === 'streamed'
          ? (async () => {
              streamedResult = await run(agent, first.state, {
                session,
                stream: true,
                signal: controller.signal,
                outputGuardrailBlockedMessage,
              });
              await streamedResult.completed;
            })()
          : run(agent, first.state, {
              session,
              signal: controller.signal,
              outputGuardrailBlockedMessage,
            });
      const cancelledResume =
        expect(completionOutcome).rejects.toBe(abortReason);

      await formatterStarted;
      controller.abort(abortReason);
      await cancelledResume;
      if (streamedResult) {
        await streamedResult._getStreamLoopPromise();
      }

      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(session.addCalls).toBe(appendCallsBeforeResume);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it('does not convert an uncertain terminal append into an error-handler output', async () => {
    const { agent, execute, model } = createApprovalRun(
      vi.fn(async () => 'approved-result'),
      'stop_on_first_tool',
    );
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');
    const errorHandler = vi.fn(async () => ({
      finalOutput: 'handled persistence failure',
    }));

    await expect(
      run(agent, first.state, {
        session,
        errorHandlers: { default: errorHandler },
      }),
    ).rejects.toThrow(/acknowledgement lost/);
    expect(errorHandler).not.toHaveBeenCalled();
    expect(first.state._pendingSessionWrite).toBeDefined();

    const completed = await runOnce(
      'non_streamed',
      agent,
      first.state,
      session,
    );
    expect(completed.finalOutput).toBe('approved-result');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('fails closed on a changed tail before model or tool work', async () => {
    const { agent, execute, model } = createApprovalRun();
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('before');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow('append rejected before commit');
    await session.addItems([
      { type: 'message', role: 'user', content: 'unrelated mutation' },
    ]);

    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(UserError);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
    expect(first.state._pendingSessionWrite).toBeDefined();
  });

  it('rejects a different logical Session before model or tool work', async () => {
    const { agent, execute, model } = createApprovalRun();
    const session = new UncertainAppendSession('original-session');
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('after');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/acknowledgement/);

    await expect(
      runOnce(
        'non_streamed',
        agent,
        first.state,
        new UncertainAppendSession('different-session'),
      ),
    ).rejects.toThrow(/different session/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('fails closed when only part of a resumed append committed', async () => {
    const execute = vi.fn(async () => 'approved-result');
    const approvalTool = tool({
      name: 'approval_tool',
      description: 'Returns a result after approval.',
      parameters: z.object({}),
      needsApproval: true,
      execute,
    });
    const model = new ScriptedModel([
      modelResponder(() => ({
        output: [
          functionToolCall('approval-a'),
          functionToolCall('approval-b'),
        ],
        usage: new Usage(),
      })),
      modelResponder(() => ({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      })),
    ]);
    const agent = new Agent({
      name: 'Partial Session write agent',
      model,
      tools: [approvalTool],
    });
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool twice',
      session,
    );
    expect(first.interruptions).toHaveLength(2);
    for (const interruption of first.interruptions) {
      first.state.approve(interruption);
    }
    session.failNextAppend('partial');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/partial commit/);

    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/cannot be reconciled safely/);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(model.calls).toHaveLength(1);
    expect(first.state._pendingSessionWrite).toBeDefined();
  });

  it('retains recovery authority when comparison hooks collapse record boundaries', async () => {
    const { agent, execute, model } = createApprovalRun();
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    const addCalls = session.addCalls;
    session.collapseComparisonItems = true;

    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/preserve.*boundaries/);
    expect(session.addCalls).toBe(addCalls);
    expect(first.state._pendingSessionWrite?.phase).toBe('prepared');
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);

    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/preserve stored item boundaries/);
    expect(session.addCalls).toBe(addCalls);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);
  });

  it('keeps the checkpoint detached and rejects old-schema or derived append data', async () => {
    const { agent, model } = createApprovalRun();
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('before');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/before commit/);

    const original = first.state.toString();
    const detached = first.state.toJSON() as any;
    detached.pendingSessionWrite.appendItems = [];
    expect(first.state.toString()).toBe(original);

    const releasedSchema = JSON.parse(original);
    releasedSchema.$schemaVersion = '1.19';
    delete releasedSchema.currentResponseGeneratedItemOwnership;
    await expect(
      RunState.fromString(agent, JSON.stringify(releasedSchema)),
    ).rejects.toThrow(/does not support pending Session writes/);

    const derivedAppend = JSON.parse(original);
    derivedAppend.pendingSessionWrite.appendItems = [
      { type: 'message', role: 'user', content: 'forged append' },
    ];
    const sessionIdCalls = session.sessionIdCalls;
    await expect(
      RunState.fromString(agent, JSON.stringify(derivedAppend)),
    ).rejects.toThrow(/Unrecognized key/);
    expect(session.sessionIdCalls).toBe(sessionIdCalls);
    expect(model.calls).toHaveLength(1);

    const mismatchedComparison = JSON.parse(original);
    mismatchedComparison.pendingSessionWrite.comparableAppendItems = [
      { type: 'message', role: 'user', content: 'forged comparison' },
    ];
    const restoredMismatch = await RunState.fromString(
      agent,
      JSON.stringify(mismatchedComparison),
    );
    await expect(
      runOnce('non_streamed', agent, restoredMismatch, session),
    ).rejects.toThrow(/comparison evidence/);
    expect(session.sessionIdCalls).toBe(sessionIdCalls);
    expect(model.calls).toHaveLength(1);
  });

  it.each(['prepared', 'append_ready'] as const)(
    'rejects derived append authority in a $phase checkpoint before custom tool-search rehydration',
    async (phase) => {
      const { agent, model, toolSearchExecute } =
        createApprovalRunWithToolSearch();
      const session = new UncertainAppendSession();
      const first = await runOnce(
        'non_streamed',
        agent,
        'Use approval_tool',
        session,
      );
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('before');
      await expect(
        runOnce('non_streamed', agent, first.state, session),
      ).rejects.toThrow(/before commit/);

      const forged = JSON.parse(first.state.toString());
      expect(forged.pendingSessionWrite.phase).toBe('append_ready');
      if (phase === 'prepared') {
        forged.pendingSessionWrite.phase = 'prepared';
        delete forged.pendingSessionWrite.beforeItems;
        delete forged.pendingSessionWrite.comparableAppendItems;
      }
      forged.pendingSessionWrite.appendItems = [
        { type: 'message', role: 'user', content: 'forged append' },
      ];
      forged.pendingSessionWrite.appendInputItemCount = 1;
      toolSearchExecute.mockClear();
      const sessionCallsBeforeRestore = {
        id: session.sessionIdCalls,
        items: session.itemsCalls,
      };

      await expect(
        RunState.fromString(agent, JSON.stringify(forged)),
      ).rejects.toThrow();
      expect(toolSearchExecute).not.toHaveBeenCalled();
      expect(session.sessionIdCalls).toBe(sessionCallsBeforeRestore.id);
      expect(session.itemsCalls).toBe(sessionCallsBeforeRestore.items);
      expect(model.calls).toHaveLength(1);
    },
  );

  it('rejects a forged terminal output before custom tool-search rehydration', async () => {
    const { agent, model, toolSearchExecute } =
      createApprovalRunWithToolSearch('stop_on_first_tool');
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('before');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/before commit/);

    const forged = JSON.parse(first.state.toString());
    expect(forged.currentStep.type).toBe('next_step_final_output');
    forged.currentStep.output = 'forged terminal output';
    toolSearchExecute.mockClear();

    await expect(
      RunState.fromString(agent, JSON.stringify(forged)),
    ).rejects.toThrow(/pending Session write is invalid/);
    expect(toolSearchExecute).not.toHaveBeenCalled();
    expect(model.calls).toHaveLength(1);
  });

  it.each(['prepared', 'append_ready'] as const)(
    'rejects a $phase checkpoint that owns only a generated-item prefix',
    async (phase) => {
      const { agent, toolSearchExecute } = createApprovalRunWithToolSearch();
      const session = new UncertainAppendSession();
      const first = await runOnce(
        'non_streamed',
        agent,
        'Use approval_tool',
        session,
      );
      const malformed = first.state.toJSON() as any;
      expect(malformed.generatedItems.length).toBeGreaterThan(1);
      malformed.currentTurnPersistedItemCount = 0;
      malformed.pendingSessionWrite = {
        phase,
        sessionId: 'uncertain-append-session',
        alreadyPersistedCount: 0,
        persistedItemCount: 1,
        reasoningItemIdPolicy: 'preserve',
        ...(phase === 'append_ready'
          ? {
              beforeItems: [],
              comparableAppendItems: [
                {
                  type: 'tool_search_call',
                  status: 'completed',
                  arguments: {},
                  providerData: { call_id: 'tool-search-call' },
                },
              ],
            }
          : {}),
      };
      toolSearchExecute.mockClear();

      await expect(
        RunState.fromString(agent, JSON.stringify(malformed)),
      ).rejects.toThrow(/pending Session write is invalid/);
      expect(toolSearchExecute).not.toHaveBeenCalled();
    },
  );

  it('rejects a prepared checkpoint without a persistable generated item', async () => {
    const { agent } = createApprovalRun();
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    const malformed = first.state.toJSON() as any;
    const approvalIndex = malformed.generatedItems.findIndex(
      (item: { type?: string }) => item.type === 'tool_approval_item',
    );
    expect(approvalIndex).toBeGreaterThanOrEqual(0);
    malformed.currentTurnPersistedItemCount = approvalIndex;
    malformed.pendingSessionWrite = {
      phase: 'prepared',
      sessionId: 'uncertain-append-session',
      alreadyPersistedCount: approvalIndex,
      persistedItemCount: approvalIndex + 1,
      reasoningItemIdPolicy: 'preserve',
    };

    await expect(
      RunState.fromString(agent, JSON.stringify(malformed)),
    ).rejects.toThrow(/does not own a persistable generated item/);
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'commits the checkpoint before $mode input compaction fails',
    async (mode) => {
      const { agent, execute, model } = createApprovalRun();
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextCompaction();

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /input compaction rejected/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe(
        'compaction_pending',
      );
      expect(first.state._currentTurnPersistedItemCount).toBe(
        first.state._generatedItems.length,
      );
      expect(
        first.state._currentTurnSessionWriteCompactedItemCount,
      ).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);

      const completed = await runOnce(mode, agent, first.state, session);
      expect(completed.finalOutput).toBe('done');
      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'records successful direct $mode compaction before a lifecycle callback fails',
    async (mode) => {
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        'stop_on_first_tool',
      );
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      let failAgentEnd = true;
      agent.on('agent_end', () => {
        if (failAgentEnd) {
          failAgentEnd = false;
          throw new Error('agent end failed after compaction');
        }
      });

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /agent end failed after compaction/,
      );
      expect(first.state._currentTurnSessionWriteCompactedItemCount).toBe(
        first.state._currentTurnPersistedItemCount,
      );
      const compactionsAfterFailure = session.compactionArgs.length;

      const completed = await runOnce(mode, agent, first.state, session);
      expect(completed.finalOutput).toBe('approved-result');
      expect(session.compactionArgs).toHaveLength(compactionsAfterFailure);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'keeps exact same-live custom terminal authority after $mode compaction fails',
    async (mode) => {
      const originalBehavior = vi.fn<ToolToFinalOutputFunction>(
        async (_context, results) => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: `custom:${String(
            results[0]?.type === 'function_output' ? results[0].output : '',
          )}`,
        }),
      );
      const replacementBehavior = vi.fn<ToolToFinalOutputFunction>(
        async () => ({
          isFinalOutput: true,
          isInterrupted: undefined,
          finalOutput: 'replacement',
        }),
      );
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        originalBehavior,
      );
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextCompaction();

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /input compaction rejected/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe(
        'compaction_pending',
      );
      expect(
        first.state._currentTurnSessionWriteCompactedItemCount,
      ).toBeUndefined();
      await expect(
        RunState.fromString(agent, first.state.toString()),
      ).rejects.toThrow(
        /pending Session compaction terminal output is invalid/,
      );
      const sessionCallsBeforeChangedCallback = {
        add: session.addCalls,
        compaction: session.compactionArgs.length,
        id: session.sessionIdCalls,
        items: session.itemsCalls,
      };

      agent.toolUseBehavior = replacementBehavior;
      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /pending Session compaction terminal output is invalid/,
      );
      expect(session.addCalls).toBe(sessionCallsBeforeChangedCallback.add);
      expect(session.compactionArgs).toHaveLength(
        sessionCallsBeforeChangedCallback.compaction,
      );
      expect(session.sessionIdCalls).toBe(sessionCallsBeforeChangedCallback.id);
      expect(session.itemsCalls).toBe(sessionCallsBeforeChangedCallback.items);
      expect(replacementBehavior).not.toHaveBeenCalled();

      agent.toolUseBehavior = originalBehavior;
      let failAgentEnd = true;
      agent.on('agent_end', () => {
        if (failAgentEnd) {
          failAgentEnd = false;
          throw new Error('agent end failed after retry compaction');
        }
      });
      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /agent end failed after retry compaction/,
      );
      expect(first.state._currentTurnSessionWriteCompactedItemCount).toBe(
        first.state._currentTurnPersistedItemCount,
      );
      expect(session.compactionArgs).toHaveLength(
        sessionCallsBeforeChangedCallback.compaction + 1,
      );
      expect(originalBehavior).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);

      const compactionsAfterRetry = session.compactionArgs.length;
      const completed = await runOnce(mode, agent, first.state, session);
      expect(completed.finalOutput).toBe('custom:approved-result');
      expect(session.compactionArgs).toHaveLength(compactionsAfterRetry);
      expect(originalBehavior).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not reclassify a compaction-pending function terminal output in $mode',
    async (mode) => {
      const customBehavior = vi.fn<ToolToFinalOutputFunction>(async () => ({
        isFinalOutput: true,
        isInterrupted: undefined,
        finalOutput: 'approved-result',
      }));
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        customBehavior,
      );
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextCompaction();

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /input compaction rejected/,
      );
      const sessionCallsBeforeChangedBehavior = {
        add: session.addCalls,
        compaction: session.compactionArgs.length,
        id: session.sessionIdCalls,
        items: session.itemsCalls,
      };
      agent.toolUseBehavior = 'stop_on_first_tool';

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /pending Session compaction terminal output is invalid/,
      );
      expect(session.addCalls).toBe(sessionCallsBeforeChangedBehavior.add);
      expect(session.compactionArgs).toHaveLength(
        sessionCallsBeforeChangedBehavior.compaction,
      );
      expect(session.sessionIdCalls).toBe(sessionCallsBeforeChangedBehavior.id);
      expect(session.itemsCalls).toBe(sessionCallsBeforeChangedBehavior.items);
      expect(customBehavior).toHaveBeenCalledTimes(1);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'validates restored declarative terminal output while $mode compaction is pending',
    async (mode) => {
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        'stop_on_first_tool',
      );
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextCompaction();

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /input compaction rejected/,
      );
      const serialized = first.state.toJSON() as any;
      serialized.currentStep.output = 'forged-output';
      await expect(
        RunState.fromString(agent, JSON.stringify(serialized)),
      ).rejects.toThrow(/pending Session .*invalid/);

      const untampered = first.state.toString();
      agent.toolUseBehavior = 'run_llm_again';
      await expect(RunState.fromString(agent, untampered)).rejects.toThrow(
        /pending Session .*invalid/,
      );
      agent.toolUseBehavior = 'stop_on_first_tool';
      const restored = await RunState.fromString(agent, untampered);
      const completed = await runOnce(mode, agent, restored, session);
      expect(completed.finalOutput).toBe('approved-result');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
    },
  );

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'requires the original Session before retrying $mode pending compaction',
    async (mode) => {
      const { agent, execute, model } = createApprovalRun(
        vi.fn(async () => 'approved-result'),
        'stop_on_first_tool',
      );
      const guardrail = vi.fn(async () => ({
        outputInfo: undefined,
        tripwireTriggered: false,
      }));
      const agentEnd = vi.fn();
      agent.outputGuardrails.push({
        name: 'pending compaction guardrail',
        execute: guardrail,
      });
      agent.on('agent_end', agentEnd);
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextCompaction();

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /input compaction rejected/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe(
        'compaction_pending',
      );
      const callsBeforeRejectedRetries = {
        guardrail: guardrail.mock.calls.length,
        agentEnd: agentEnd.mock.calls.length,
        model: model.calls.length,
        execute: execute.mock.calls.length,
      };

      await expect(runWithoutSession(mode, agent, first.state)).rejects.toThrow(
        /requires the same ordinary local Session/,
      );
      const replacementSession = new UncertainAppendSession(
        'replacement-session',
      );
      await expect(
        runOnce(mode, agent, first.state, replacementSession),
      ).rejects.toThrow(/belongs to a different session/);

      expect(first.state._pendingSessionWrite?.phase).toBe(
        'compaction_pending',
      );
      expect(guardrail).toHaveBeenCalledTimes(
        callsBeforeRejectedRetries.guardrail,
      );
      expect(agentEnd).toHaveBeenCalledTimes(
        callsBeforeRejectedRetries.agentEnd,
      );
      expect(model.calls).toHaveLength(callsBeforeRejectedRetries.model);
      expect(execute).toHaveBeenCalledTimes(callsBeforeRejectedRetries.execute);
      expect(replacementSession.addCalls).toBe(0);
      expect(replacementSession.itemsCalls).toBe(0);
      expect(replacementSession.compactionArgs).toHaveLength(0);
    },
  );

  it('rejects restored function terminal compaction without response evidence', async () => {
    const customBehavior = vi.fn<ToolToFinalOutputFunction>(async () => ({
      isFinalOutput: true,
      isInterrupted: undefined,
      finalOutput: 'approved-result',
    }));
    const { agent } = createApprovalRun(
      vi.fn(async () => 'approved-result'),
      customBehavior,
    );
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextCompaction();
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/input compaction rejected/);

    const serialized = first.state.toJSON() as any;
    delete serialized.lastModelResponse;
    serialized.modelResponses = [];
    delete serialized.lastProcessedResponse;

    await expect(
      RunState.fromString(agent, JSON.stringify(serialized)),
    ).rejects.toThrow(/pending Session compaction terminal output is invalid/);
    expect(customBehavior).toHaveBeenCalledTimes(1);
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'does not revive a recovered $mode append after compaction replaces history and rejects',
    async (mode) => {
      const { agent, execute, model } = createApprovalRun();
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);
      session.failNextAppend('after');

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /acknowledgement lost/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe('append_ready');
      session.failNextCompactionAfterReplacement();

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /input compaction acknowledgement lost/,
      );
      expect(first.state._pendingSessionWrite?.phase).toBe(
        'compaction_pending',
      );
      expect(first.state._currentTurnPersistedItemCount).toBe(
        first.state._generatedItems.length,
      );
      expect(
        first.state._currentTurnSessionWriteCompactedItemCount,
      ).toBeUndefined();
      expect(await session.getItems()).toEqual([
        {
          type: 'compaction',
          encrypted_content: 'replacement-acknowledgement-lost',
        },
      ]);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);

      const compactionGate = session.blockNextCompaction();
      const activeRetry = runOnce(mode, agent, first.state, session);
      await compactionGate.started;
      const callsBeforeConcurrentRetry = {
        add: session.addCalls,
        compaction: session.compactionArgs.length,
        id: session.sessionIdCalls,
        items: session.itemsCalls,
        model: model.calls.length,
      };

      await expect(runOnce(mode, agent, first.state, session)).rejects.toThrow(
        /cannot resume or reconcile.*concurrently/,
      );
      expect(session.addCalls).toBe(callsBeforeConcurrentRetry.add);
      expect(session.compactionArgs).toHaveLength(
        callsBeforeConcurrentRetry.compaction,
      );
      expect(session.sessionIdCalls).toBe(callsBeforeConcurrentRetry.id);
      expect(session.itemsCalls).toBe(callsBeforeConcurrentRetry.items);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(callsBeforeConcurrentRetry.model);

      compactionGate.release();
      const completed = await activeRetry;
      expect(completed.finalOutput).toBe('done');
      expect(first.state._pendingSessionWrite).toBeUndefined();
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
    },
  );

  it('retains the checkpoint across cancellation and another failed retry', async () => {
    const { agent, execute, model } = createApprovalRun();
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('abort');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(first.state._pendingSessionWrite).toBeDefined();

    session.failNextAppend('before');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/before commit/);
    expect(first.state._pendingSessionWrite).toBeDefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(1);

    first.state.addInput('follow-up after recovery');
    await runOnce('non_streamed', agent, first.state, session);
    expect(first.state._pendingSessionWrite).toBeUndefined();
    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(2);
    const resumedInput = model.calls[1]!.request.input;
    expect(Array.isArray(resumedInput)).toBe(true);
    const resumedItems = resumedInput as AgentInputItem[];
    expect(
      resumedItems.findIndex((item) => item.type === 'function_call_result'),
    ).toBeLessThan(
      resumedItems.findIndex(
        (item) =>
          item.type === 'message' &&
          item.role === 'user' &&
          item.content === 'follow-up after recovery',
      ),
    );
  });

  it('rejects concurrent recovery on the same live RunState', async () => {
    const { agent, execute, model } = createApprovalRun();
    const session = new UncertainAppendSession();
    const first = await runOnce(
      'non_streamed',
      agent,
      'Use approval_tool',
      session,
    );
    first.state.approve(first.interruptions[0]!);
    session.failNextAppend('before');
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/before commit/);

    const gate = session.blockNextRead();
    const recovery = runOnce('non_streamed', agent, first.state, session);
    await gate.started;
    await expect(
      runOnce('non_streamed', agent, first.state, session),
    ).rejects.toThrow(/cannot resume or reconcile.*concurrently/);
    gate.release();
    await recovery;

    expect(execute).toHaveBeenCalledTimes(1);
    expect(model.calls).toHaveLength(2);
  });

  it.each<RunMode>(['non_streamed', 'streamed'])(
    'rejects a concurrent $mode resume before the checkpoint exists',
    async (mode) => {
      let markStarted!: () => void;
      let releaseTool!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const toolGate = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      const execute = vi.fn(async () => {
        markStarted();
        await toolGate;
        return 'approved-result';
      });
      const { agent, model } = createApprovalRun(execute);
      const session = new UncertainAppendSession();
      const first = await runOnce(mode, agent, 'Use approval_tool', session);
      first.state.approve(first.interruptions[0]!);

      const firstResume =
        mode === 'streamed'
          ? (async () => {
              const result = await run(agent, first.state, {
                session,
                stream: true,
                maxTurns: 7,
                reasoningItemIdPolicy: 'preserve',
              });
              await result.completed;
              return result;
            })()
          : run(agent, first.state, {
              session,
              maxTurns: 7,
              reasoningItemIdPolicy: 'preserve',
            });
      await started;
      await expect(
        mode === 'streamed'
          ? (async () => {
              const result = await run(agent, first.state, {
                stream: true,
                maxTurns: 1,
                reasoningItemIdPolicy: 'omit',
              });
              await result.completed;
            })()
          : run(agent, first.state, {
              maxTurns: 1,
              reasoningItemIdPolicy: 'omit',
            }),
      ).rejects.toThrow(/cannot resume or reconcile.*concurrently/);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(first.state._maxTurns).toBe(7);
      expect(first.state._reasoningItemIdPolicy).toBe('preserve');

      releaseTool();
      const completed = await firstResume;
      expect(completed.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
    },
  );

  it.each([
    { name: 'without a Session', options: {} },
    {
      name: 'with a server-managed conversation',
      options: { conversationId: 'server-managed-resume' },
    },
  ])(
    'rejects an ordinary-Session competitor when the first resume starts $name',
    async ({ options }) => {
      let markStarted!: () => void;
      let releaseTool!: () => void;
      const started = new Promise<void>((resolve) => {
        markStarted = resolve;
      });
      const toolGate = new Promise<void>((resolve) => {
        releaseTool = resolve;
      });
      const execute = vi.fn(async () => {
        markStarted();
        await toolGate;
        return 'approved-result';
      });
      const { agent, model } = createApprovalRun(execute);
      const session = new UncertainAppendSession();
      const first = await runOnce(
        'non_streamed',
        agent,
        'Use approval_tool',
        session,
      );
      first.state.approve(first.interruptions[0]!);

      const firstResume = run(agent, first.state, {
        ...options,
        maxTurns: 7,
        reasoningItemIdPolicy: 'preserve',
      });
      await started;
      await expect(
        run(agent, first.state, {
          session,
          maxTurns: 1,
          reasoningItemIdPolicy: 'omit',
        }),
      ).rejects.toThrow(/cannot resume or reconcile.*concurrently/);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(1);
      expect(first.state._maxTurns).toBe(7);
      expect(first.state._reasoningItemIdPolicy).toBe('preserve');

      releaseTool();
      const completed = await firstResume;
      expect(completed.finalOutput).toBe('done');
      expect(execute).toHaveBeenCalledTimes(1);
      expect(model.calls).toHaveLength(2);
    },
  );
});
