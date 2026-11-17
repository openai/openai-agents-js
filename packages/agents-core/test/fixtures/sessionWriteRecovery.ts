import { vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  tool,
  Usage,
  type AgentInputItem,
  type OpenAIResponsesCompactionArgs,
  type Session,
  type ToolUseBehavior,
} from '../../src';
import { modelResponder, ScriptedModel } from '../../src/testing';
import type { FunctionCallItem } from '../../src/types/protocol';
import { fakeModelMessage } from '../stubs';

export class UncertainAppendSession implements Session {
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

export function functionToolCall(callId = 'approval-call'): FunctionCallItem {
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

export function createApprovalRun(
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
