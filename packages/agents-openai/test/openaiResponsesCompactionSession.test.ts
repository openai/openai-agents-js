import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  applySessionHistoryMutations,
  MemorySession,
  RunContext,
  run,
  tool,
  Usage,
  UserError,
  type AgentInputItem,
  type RunContextAwareSession,
  type SessionHistoryExpectedRewriteAwareSession,
  type SessionHistoryRewriteArgs,
} from '@openai/agents-core';
import {
  ScriptedModel,
  assistantMessage,
  functionCall,
  modelResponse,
} from '@openai/agents-core/testing';

import { OpenAIResponsesCompactionSession } from '../src';
import { OPENAI_SESSION_API } from '../src/memory/openaiSessionApi';

function createDeferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

class PartiallyFailingReplacementSession extends MemorySession {
  addCalls = 0;
  clearCalls = 0;
  failureMessage = 'replacement failed';

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.addCalls += 1;
    if (this.addCalls === 1) {
      await super.addItems(items.slice(0, 1));
      throw new Error(this.failureMessage);
    }
    await super.addItems(items);
  }

  async clearSession(): Promise<void> {
    this.clearCalls += 1;
    await super.clearSession();
  }
}

class FailingClearBeforeMutationSession extends MemorySession {
  addCalls = 0;
  clearCalls = 0;

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.addCalls += 1;
    await super.addItems(items);
  }

  async clearSession(): Promise<void> {
    this.clearCalls += 1;
    throw new Error('clear failed');
  }
}

class FailingClearAfterMutationSession extends MemorySession {
  addCalls = 0;
  clearCalls = 0;
  popCalls = 0;

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.addCalls += 1;
    await super.addItems(items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    this.popCalls += 1;
    return super.popItem();
  }

  async clearSession(): Promise<void> {
    this.clearCalls += 1;
    await super.clearSession();
    throw new Error('clear failed');
  }
}

class FailingRestoreSession extends MemorySession {
  addCalls = 0;
  clearCalls = 0;

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.addCalls += 1;
    if (this.addCalls === 1) {
      await super.addItems(items.slice(0, 1));
      throw new Error('replacement failed');
    }
    throw new Error('restore failed');
  }

  async clearSession(): Promise<void> {
    this.clearCalls += 1;
    await super.clearSession();
  }
}

class BackendMetadataSession extends MemorySession {
  override async getItems(limit?: number): Promise<AgentInputItem[]> {
    const items = await super.getItems(limit);
    return items.map((item) =>
      item.type === 'function_call'
        ? {
            ...item,
            id: 'backend-assigned-id',
            providerData: { loadedAt: new Date() },
          }
        : item,
    );
  }

  prepareHistoryItemsForPersistenceComparison(
    items: AgentInputItem[],
  ): AgentInputItem[] {
    return items.map((item) => {
      if (item.type !== 'function_call') {
        return item;
      }
      const {
        id: _backendId,
        providerData: _backendProviderData,
        ...functionCall
      } = item;
      return functionCall;
    });
  }
}

class CommitThenFailRewriteSession extends MemorySession {
  readonly rewriteError = new Error('rewrite outcome is unknown');

  override async applyHistoryMutations(
    args: SessionHistoryRewriteArgs,
  ): Promise<void> {
    await super.applyHistoryMutations(args);
    throw this.rewriteError;
  }
}

type TenantContext = { tenantId: string };

class ContextAwareRewriteSession
  implements
    RunContextAwareSession<TenantContext>,
    SessionHistoryExpectedRewriteAwareSession
{
  readonly acceptsRunContext = true;
  readonly supportsExpectedHistoryMutations = true;
  readonly itemsByTenant = new Map<string, AgentInputItem[]>([['default', []]]);
  readonly rewriteContexts: Array<RunContext<TenantContext> | undefined> = [];

  async getSessionId(): Promise<string> {
    return 'context-aware-compaction-session';
  }

  async getItems(
    limit?: number,
    runContext?: RunContext<TenantContext>,
  ): Promise<AgentInputItem[]> {
    const items = this.getTenantItems(runContext);
    return limit === undefined ? [...items] : items.slice(-limit);
  }

  async addItems(
    items: AgentInputItem[],
    runContext?: RunContext<TenantContext>,
  ): Promise<void> {
    this.getTenantItems(runContext).push(...structuredClone(items));
  }

  async popItem(
    runContext?: RunContext<TenantContext>,
  ): Promise<AgentInputItem | undefined> {
    return this.getTenantItems(runContext).pop();
  }

  async clearSession(runContext?: RunContext<TenantContext>): Promise<void> {
    this.itemsByTenant.set(this.getTenantId(runContext), []);
  }

  async applyHistoryMutations(
    args: SessionHistoryRewriteArgs,
    runContext?: RunContext<TenantContext>,
  ): Promise<void> {
    this.rewriteContexts.push(runContext);
    const items = this.getTenantItems(runContext);
    this.itemsByTenant.set(
      this.getTenantId(runContext),
      applySessionHistoryMutations(items, args.mutations),
    );
  }

  private getTenantItems(
    runContext: RunContext<TenantContext> | undefined,
  ): AgentInputItem[] {
    const tenantId = this.getTenantId(runContext);
    const items = this.itemsByTenant.get(tenantId) ?? [];
    this.itemsByTenant.set(tenantId, items);
    return items;
  }

  private getTenantId(
    runContext: RunContext<TenantContext> | undefined,
  ): string {
    return runContext?.context.tenantId ?? 'default';
  }
}

function createApprovalModel(): ScriptedModel {
  return new ScriptedModel([
    modelResponse({
      usage: new Usage(),
      output: [
        functionCall(
          'lookup',
          { query: 'old' },
          {
            callId: 'call_compaction_override',
          },
        ),
      ],
    }),
  ]);
}

function createResponseIdModel(): ScriptedModel {
  return new ScriptedModel([
    modelResponse({
      usage: new Usage(),
      responseId: 'resp_manual_compaction',
      output: [assistantMessage('done')],
    }),
  ]);
}

describe('OpenAIResponsesCompactionSession', () => {
  it('rejects non-OpenAI model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'yet-another-model',
      });
    }).toThrow(/Unsupported model/);
  });

  it('rejects whitespace-only model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: '   ',
      });
    }).toThrow(/Unsupported model/);
  });

  it('rejects conversations-backed sessions', () => {
    const underlyingSession = new MemorySession();
    Object.defineProperty(underlyingSession, OPENAI_SESSION_API, {
      value: 'conversations',
    });

    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        underlyingSession,
      });
    }).toThrow(UserError);
  });

  it('allows unknown gpt-* model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'gpt-9999-super-new-model',
      });
    }).not.toThrow();
  });

  it('allows fine-tuned gpt-* model ids', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'ft:gpt-4.1-nano-2025-04-14:org:proj:suffix',
      });
    }).not.toThrow();
  });

  it('allows o* model names', () => {
    expect(() => {
      new OpenAIResponsesCompactionSession({
        client: {} as any,
        model: 'o1-pro',
      });
    }).not.toThrow();
  });

  it('delegates session identity and keeps cached candidates in sync', async () => {
    const assistantItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'first answer' }],
    } as AgentInputItem;
    const followUpItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'follow-up answer' }],
    } as AgentInputItem;
    const underlyingSession = new MemorySession({
      sessionId: 'compaction-session',
      initialItems: [
        {
          type: 'message',
          role: 'user',
          content: 'hello',
        },
        assistantItem,
      ] as AgentInputItem[],
    });
    const candidateSnapshots: AgentInputItem[][] = [];
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact: vi.fn() } } as any,
      underlyingSession,
      shouldTriggerCompaction: ({ compactionCandidateItems }) => {
        candidateSnapshots.push(compactionCandidateItems);
        return false;
      },
    });

    await expect(session.getSessionId()).resolves.toBe('compaction-session');
    await expect(session.getItems(1)).resolves.toEqual([assistantItem]);
    await session.addItems([]);
    await expect(session.runCompaction({ responseId: 'resp_1' })).resolves.toBe(
      null,
    );

    await session.addItems([followUpItem]);
    await expect(session.popItem()).resolves.toEqual(followUpItem);
    await expect(session.runCompaction()).resolves.toBe(null);

    await session.clearSession();
    await expect(session.popItem()).resolves.toBeUndefined();
    await expect(session.runCompaction()).resolves.toBe(null);

    expect(candidateSnapshots).toEqual([[assistantItem], [assistantItem], []]);
    await expect(session.getItems()).resolves.toEqual([]);
  });

  it('forwards history rewrites and invalidates cached compaction input', async () => {
    const originalCall = {
      type: 'function_call',
      name: 'lookup',
      callId: 'call_rewrite',
      status: 'completed',
      arguments: JSON.stringify({ query: 'old' }),
    } as Extract<AgentInputItem, { type: 'function_call' }>;
    const replacementCall = {
      ...originalCall,
      arguments: JSON.stringify({ query: 'new' }),
    };
    const candidateSnapshots: AgentInputItem[][] = [];
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact: vi.fn() } } as any,
      underlyingSession: new MemorySession({ initialItems: [originalCall] }),
      shouldTriggerCompaction: ({ compactionCandidateItems }) => {
        candidateSnapshots.push(compactionCandidateItems);
        return false;
      },
    });

    await session.runCompaction();
    await session.applyHistoryMutations({
      mutations: [
        {
          type: 'replace_function_call',
          callId: 'call_rewrite',
          expected: originalCall,
          replacement: replacementCall,
        },
      ],
    });
    await session.runCompaction();

    expect(candidateSnapshots).toEqual([[originalCall], [replacementCall]]);
    await expect(session.getItems()).resolves.toEqual([replacementCall]);
  });

  it('invalidates cached history when a rewrite commits and then rejects', async () => {
    const originalCall = {
      type: 'function_call',
      name: 'lookup',
      callId: 'call_uncertain_rewrite',
      arguments: JSON.stringify({ query: 'old' }),
    } as Extract<AgentInputItem, { type: 'function_call' }>;
    const replacementCall = {
      ...originalCall,
      arguments: JSON.stringify({ query: 'new' }),
    };
    const toolResult = {
      type: 'function_call_result',
      name: 'lookup',
      callId: 'call_uncertain_rewrite',
      status: 'completed',
      output: 'new result',
    } as Extract<AgentInputItem, { type: 'function_call_result' }>;
    const underlyingSession = new CommitThenFailRewriteSession({
      initialItems: [originalCall],
    });
    const candidateSnapshots: AgentInputItem[][] = [];
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact: vi.fn() } } as any,
      underlyingSession,
      shouldTriggerCompaction: ({ compactionCandidateItems }) => {
        candidateSnapshots.push(compactionCandidateItems);
        return false;
      },
    });

    await session.runCompaction();
    await expect(
      session.applyHistoryMutations({
        mutations: [
          {
            type: 'replace_function_call',
            callId: 'call_uncertain_rewrite',
            expected: originalCall,
            replacement: replacementCall,
          },
        ],
      }),
    ).rejects.toBe(underlyingSession.rewriteError);
    await session.addItems([toolResult]);
    await session.runCompaction();

    expect(candidateSnapshots).toEqual([
      [originalCall],
      [replacementCall, toolResult],
    ]);
    await expect(session.getItems()).resolves.toEqual([
      replacementCall,
      toolResult,
    ]);
  });

  it('delegates persistence comparison normalization before a resumed rewrite', async () => {
    let executedQuery: string | undefined;
    const lookup = tool({
      name: 'lookup',
      description: 'Looks up a query after approval.',
      parameters: z.object({ query: z.string() }),
      needsApproval: async () => true,
      execute: async ({ query }) => {
        executedQuery = query;
        return query;
      },
    });
    const underlyingSession = new BackendMetadataSession();
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact: vi.fn() } } as any,
      underlyingSession,
    });
    const agent = new Agent({
      name: 'CompactionOverrideAgent',
      model: createApprovalModel(),
      tools: [lookup],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const firstResult = await run(agent, 'query', { session });
    firstResult.state.approve(firstResult.interruptions[0]!, {
      overrideArguments: { query: 'new' },
    });

    const resumed = await run(agent, firstResult.state, { session });

    expect(resumed.finalOutput).toBe('new');
    expect(executedQuery).toBe('new');
    await expect(session.getItems()).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          id: 'backend-assigned-id',
          providerData: { loadedAt: expect.any(Date) },
          callId: 'call_compaction_override',
          arguments: JSON.stringify({ query: 'new' }),
        }),
      ]),
    );
  });

  it('forwards the active run context through a resumed history rewrite', async () => {
    let executedQuery: string | undefined;
    const lookup = tool({
      name: 'lookup',
      description: 'Looks up a query after approval.',
      parameters: z.object({ query: z.string() }),
      needsApproval: async () => true,
      execute: async ({ query }) => {
        executedQuery = query;
        return query;
      },
    });
    const underlyingSession = new ContextAwareRewriteSession();
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact: vi.fn() } } as any,
      underlyingSession,
      shouldTriggerCompaction: () => false,
    });
    const agent = new Agent<TenantContext>({
      name: 'ContextAwareCompactionOverrideAgent',
      model: createApprovalModel(),
      tools: [lookup],
      toolUseBehavior: 'stop_on_first_tool',
    });
    const firstResult = await run(agent, 'query', {
      session,
      context: { tenantId: 'tenant-a' },
    });
    firstResult.state.approve(firstResult.interruptions[0]!, {
      overrideArguments: { query: 'new' },
    });

    const resumed = await run(agent, firstResult.state, { session });

    expect(resumed.finalOutput).toBe('new');
    expect(executedQuery).toBe('new');
    expect(underlyingSession.rewriteContexts).toHaveLength(1);
    expect(underlyingSession.rewriteContexts[0]?.context).toEqual({
      tenantId: 'tenant-a',
    });
    expect(underlyingSession.itemsByTenant.get('default')).toEqual([]);
    expect(underlyingSession.itemsByTenant.get('tenant-a')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'function_call',
          callId: 'call_compaction_override',
          arguments: JSON.stringify({ query: 'new' }),
        }),
      ]),
    );
  });

  it('invalidates compaction caches when the active run context changes', async () => {
    const tenantACall = {
      type: 'function_call',
      name: 'lookup',
      callId: 'call_tenant_a',
      arguments: '{}',
    } as Extract<AgentInputItem, { type: 'function_call' }>;
    const tenantBCall = {
      ...tenantACall,
      callId: 'call_tenant_b',
    };
    const underlyingSession = new ContextAwareRewriteSession();
    const candidateSnapshots: AgentInputItem[][] = [];
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact: vi.fn() } } as any,
      underlyingSession,
      shouldTriggerCompaction: ({ compactionCandidateItems }) => {
        candidateSnapshots.push(compactionCandidateItems);
        return false;
      },
    });
    const tenantAContext = new RunContext<TenantContext>({
      tenantId: 'tenant-a',
    });
    const tenantBContext = new RunContext<TenantContext>({
      tenantId: 'tenant-b',
    });

    await session.addItems([tenantACall], tenantAContext);
    await session.runCompaction({}, tenantAContext);
    await session.addItems([tenantBCall], tenantBContext);
    await session.runCompaction({}, tenantBContext);

    expect(candidateSnapshots).toEqual([[tenantACall], [tenantBCall]]);
    expect(underlyingSession.itemsByTenant.get('default')).toEqual([]);
  });

  it('preserves the response ID for manual compaction with a context-insensitive session', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession: new MemorySession(),
      compactionMode: 'previous_response_id',
      shouldTriggerCompaction: () => false,
    });
    const agent = new Agent({
      name: 'ManualCompactionAgent',
      model: createResponseIdModel(),
    });

    await run(agent, 'hello', { session });
    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith({
      model: 'gpt-5.6-luna',
      previous_response_id: 'resp_manual_compaction',
    });
  });

  it('rejects history rewrites when the underlying session cannot rewrite', async () => {
    const underlyingSession = new MemorySession();
    Object.defineProperty(underlyingSession, 'applyHistoryMutations', {
      value: undefined,
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact: vi.fn() } } as any,
      underlyingSession,
    });

    await expect(
      session.applyHistoryMutations({ mutations: [] }),
    ).rejects.toThrow(
      'requires its underlying session to support expected function-call history rewrites',
    );
  });

  it('uses the default compaction threshold for candidate items', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [],
      usage: {
        input_tokens: 10,
        output_tokens: 1,
        total_tokens: 11,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'input',
    });
    await session.addItems(
      Array.from({ length: 10 }, (_, index) => ({
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: `answer ${index}` }],
      })) as AgentInputItem[],
    );

    await expect(session.runCompaction()).resolves.not.toBeNull();
    expect(compact).toHaveBeenCalledTimes(1);
  });

  it('skips compaction when the decision hook declines', async () => {
    const compact = vi.fn();
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      shouldTriggerCompaction: () => false,
    });

    await session.addItems([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hello' }],
      },
    ]);

    await session.runCompaction({ responseId: 'resp_1' });
    expect(compact).not.toHaveBeenCalled();
  });

  it('compacts using input mode without a response id', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'input',
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world' }],
      },
    ] as any);

    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(1);
    const [request] = compact.mock.calls[0] ?? [];
    expect(request).toMatchObject({ model: 'gpt-5.6-luna' });
    expect(request.previous_response_id).toBeUndefined();
    expect(request.input).toHaveLength(2);
    expect(request.input[0]).toMatchObject({
      role: 'user',
      content: 'hello',
    });
    expect(request.input[1]).toMatchObject({
      type: 'message',
      role: 'assistant',
    });
  });

  it('defaults to auto compaction and uses input without a response id', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
    ] as any);

    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(1);
    const [request] = compact.mock.calls[0] ?? [];
    expect(request.previous_response_id).toBeUndefined();
    expect(request.input).toHaveLength(1);
  });

  it('auto mode uses input when store is false', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [],
      usage: {
        input_tokens: 0,
        output_tokens: 0,
        total_tokens: 0,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'auto',
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world' }],
      },
    ] as any);

    await session.runCompaction({
      responseId: 'resp_auto',
      store: false,
      force: true,
    });

    expect(compact).toHaveBeenCalledTimes(1);
    const [request] = compact.mock.calls[0] ?? [];
    expect(request).toMatchObject({ model: 'gpt-5.6-luna' });
    expect(request.previous_response_id).toBeUndefined();
    expect(request.input).toHaveLength(2);
  });

  it('auto mode remembers store settings when store is omitted', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted output' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'auto',
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: 'hello',
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world' }],
      },
    ] as any);

    await session.runCompaction({
      responseId: 'resp_auto',
      store: false,
      force: true,
    });
    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(2);
    const [firstRequest] = compact.mock.calls[0] ?? [];
    const [secondRequest] = compact.mock.calls[1] ?? [];
    expect(firstRequest.previous_response_id).toBeUndefined();
    expect(secondRequest.previous_response_id).toBeUndefined();
    expect(secondRequest.input).toHaveLength(1);
  });

  it('allows custom compaction decisions using the stored history', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted output' }],
        },
      ],
      usage: {
        input_tokens: 7,
        output_tokens: 11,
        total_tokens: 18,
      },
    });
    const underlyingSession = new MemorySession();
    const decisionHistoryLengths: number[] = [];
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession,
      shouldTriggerCompaction: async ({ compactionCandidateItems }) => {
        decisionHistoryLengths.push(compactionCandidateItems.length);
        const estimatedTokens = compactionCandidateItems.reduce(
          (total, item) => total + JSON.stringify(item).length,
          0,
        );
        return estimatedTokens > 40;
      },
    });

    await session.addItems([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [
          {
            type: 'output_text',
            text: 'This reply is intentionally long to trigger compaction.',
          },
        ],
      },
    ]);

    await session.runCompaction({ responseId: 'resp_2' });

    expect(compact).toHaveBeenCalledTimes(1);
    expect(compact).toHaveBeenCalledWith({
      previous_response_id: 'resp_2',
      model: 'gpt-5.6-luna',
    });
    expect(decisionHistoryLengths).toEqual([1]);

    const storedItems = await session.getItems();
    expect(storedItems).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'compacted output' }],
      },
    ]);

    const compactionResult = await session.runCompaction({
      responseId: 'resp_2',
      force: true,
    });
    expect(compactionResult?.usage).toMatchObject({
      inputTokens: 7,
      outputTokens: 11,
      totalTokens: 18,
      endpoint: 'responses.compact',
    });
  });

  it('provides compaction candidates to the decision hook', async () => {
    const compact = vi.fn();
    const receivedCandidates: unknown[][] = [];
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      shouldTriggerCompaction: async ({ compactionCandidateItems }) => {
        receivedCandidates.push(compactionCandidateItems);
        return false;
      },
    });

    const userItem = {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'hello' }],
    };
    const assistantItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'world' }],
    };

    await session.addItems([userItem, assistantItem] as any);
    await session.runCompaction({ responseId: 'resp_3' });

    expect(receivedCandidates).toEqual([[assistantItem]]);
    expect(compact).not.toHaveBeenCalled();
  });

  it('replaces history after compaction and reuses the stored response id', async () => {
    const compact = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'compacted output' }],
          },
        ],
        usage: {
          input_tokens: 2,
          output_tokens: 3,
          total_tokens: 5,
        },
      })
      .mockResolvedValueOnce({
        output: [
          {
            type: 'message',
            role: 'assistant',
            status: 'completed',
            content: [{ type: 'output_text', text: 'second pass' }],
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hi' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'first output' }],
      },
    ] as any);

    await session.runCompaction({ responseId: 'resp_store', force: true });

    expect(compact).toHaveBeenCalledWith({
      previous_response_id: 'resp_store',
      model: 'gpt-5.6-luna',
    });
    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'compacted output' }],
      },
    ]);

    await session.addItems([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'follow up' }],
      },
    ] as any);

    await session.runCompaction({ force: true });

    expect(compact).toHaveBeenCalledTimes(2);
    expect(compact).toHaveBeenLastCalledWith({
      previous_response_id: 'resp_store',
      model: 'gpt-5.6-luna',
    });
    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'second pass' }],
      },
    ]);
  });

  it('restores history before a newer wrapper addItems mutation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'original' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'original reply' }],
      },
    ] as AgentInputItem[];
    const newerItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'newer reply' }],
    } as AgentInputItem;

    class GatedRollbackSession extends MemorySession {
      addCalls = 0;
      clearCalls = 0;
      readonly restoreClearStarted = createDeferred();
      readonly allowRestoreClear = createDeferred();

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.addCalls += 1;
        if (this.addCalls === 1) {
          await super.addItems(items.slice(0, 1));
          throw new Error('replacement failed');
        }
        await super.addItems(items);
      }

      async clearSession(): Promise<void> {
        this.clearCalls += 1;
        if (this.clearCalls === 2) {
          this.restoreClearStarted.resolve();
          await this.allowRestoreClear.promise;
        }
        await super.clearSession();
      }
    }

    const underlyingSession = new GatedRollbackSession({
      initialItems: history,
    });
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const decisionSnapshots: Array<{
      compactionCandidateItems: AgentInputItem[];
      sessionItems: AgentInputItem[];
    }> = [];
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession,
      compactionMode: 'input',
      shouldTriggerCompaction: ({ compactionCandidateItems, sessionItems }) => {
        decisionSnapshots.push({ compactionCandidateItems, sessionItems });
        return false;
      },
    });

    try {
      const compaction = session.runCompaction({ force: true });
      await underlyingSession.restoreClearStarted.promise;

      const newerWrite = session.addItems([newerItem]);
      expect(underlyingSession.addCalls).toBe(1);

      underlyingSession.allowRestoreClear.resolve();

      await expect(compaction).rejects.toThrow('replacement failed');
      await newerWrite;

      const expectedItems = [...history, newerItem];
      await expect(underlyingSession.getItems()).resolves.toEqual(
        expectedItems,
      );
      expect(underlyingSession.clearCalls).toBe(2);
      expect(underlyingSession.addCalls).toBe(3);

      await expect(session.runCompaction()).resolves.toBeNull();
      expect(decisionSnapshots).toEqual([
        {
          compactionCandidateItems: [history[1], newerItem],
          sessionItems: expectedItems,
        },
      ]);
    } finally {
      warn.mockRestore();
    }
  });

  it.each(['addItems', 'popItem', 'clearSession'] as const)(
    'orders a concurrent wrapper %s mutation after an in-flight compaction request',
    async (operationName) => {
      const compactedItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'compacted' }],
      } as AgentInputItem;
      const newerItem = {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'newer reply' }],
      } as AgentInputItem;

      class CountingSession extends MemorySession {
        addCalls = 0;
        clearCalls = 0;
        popCalls = 0;

        async addItems(items: AgentInputItem[]): Promise<void> {
          this.addCalls += 1;
          await super.addItems(items);
        }

        async clearSession(): Promise<void> {
          this.clearCalls += 1;
          await super.clearSession();
        }

        async popItem(): Promise<AgentInputItem | undefined> {
          this.popCalls += 1;
          return super.popItem();
        }
      }

      const underlyingSession = new CountingSession({
        initialItems: [
          {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: 'original' }],
          },
        ] as AgentInputItem[],
      });
      const compactRequestStarted = createDeferred();
      const allowCompactResponse = createDeferred();
      const compact = vi.fn(async () => {
        compactRequestStarted.resolve();
        await allowCompactResponse.promise;
        return {
          output: [compactedItem],
          usage: {
            input_tokens: 1,
            output_tokens: 1,
            total_tokens: 2,
          },
        };
      });
      const decisionSnapshots: Array<{
        compactionCandidateItems: AgentInputItem[];
        sessionItems: AgentInputItem[];
      }> = [];
      const session = new OpenAIResponsesCompactionSession({
        client: { responses: { compact } } as any,
        underlyingSession,
        compactionMode: 'input',
        shouldTriggerCompaction: ({
          compactionCandidateItems,
          sessionItems,
        }) => {
          decisionSnapshots.push({ compactionCandidateItems, sessionItems });
          return false;
        },
      });

      const compaction = session.runCompaction({ force: true });
      await compactRequestStarted.promise;
      const callsBeforeMutation = {
        addCalls: underlyingSession.addCalls,
        clearCalls: underlyingSession.clearCalls,
        popCalls: underlyingSession.popCalls,
      };

      const mutation =
        operationName === 'addItems'
          ? session.addItems([newerItem])
          : operationName === 'popItem'
            ? session.popItem()
            : session.clearSession();

      expect({
        addCalls: underlyingSession.addCalls,
        clearCalls: underlyingSession.clearCalls,
        popCalls: underlyingSession.popCalls,
      }).toEqual(callsBeforeMutation);

      allowCompactResponse.resolve();
      await compaction;
      const mutationResult = await mutation;

      const expectedItems =
        operationName === 'addItems' ? [compactedItem, newerItem] : [];
      await expect(underlyingSession.getItems()).resolves.toEqual(
        expectedItems,
      );
      if (operationName === 'popItem') {
        expect(mutationResult).toEqual(compactedItem);
      }

      await expect(session.runCompaction()).resolves.toBeNull();
      expect(decisionSnapshots).toEqual([
        {
          compactionCandidateItems: expectedItems,
          sessionItems: expectedItems,
        },
      ]);
    },
  );

  it('restores history when replacement addItems fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'original' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'private records' }],
      },
    ] as AgentInputItem[];
    const underlyingSession = new PartiallyFailingReplacementSession({
      initialItems: history,
    });
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted one' }],
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted two' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession,
      compactionMode: 'input',
    });

    try {
      await expect(
        session.runCompaction({ force: true, compactionMode: 'input' }),
      ).rejects.toThrow('replacement failed');

      expect(await underlyingSession.getItems()).toEqual(history);
      expect(underlyingSession.clearCalls).toBe(2);
      expect(underlyingSession.addCalls).toBe(2);
      expect(warn).toHaveBeenCalledWith(
        'Restored previous session history after compaction replacement failed.',
        'object',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('redacts replacement errors while restoring the previous session history', async () => {
    const original = process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA;
    process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = '1';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const secret = 'SECRET_COMPACTION_REPLACEMENT_123';
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: secret }],
      },
    ] as AgentInputItem[];
    const underlyingSession = new PartiallyFailingReplacementSession({
      initialItems: history,
    });
    underlyingSession.failureMessage = secret;
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession,
      compactionMode: 'input',
    });

    try {
      await expect(
        session.runCompaction({ force: true, compactionMode: 'input' }),
      ).rejects.toThrow(secret);
      expect(await underlyingSession.getItems()).toEqual(history);
      expect(warn).toHaveBeenCalledWith(
        'Restored previous session history after compaction replacement failed.',
        'object',
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(secret);
    } finally {
      warn.mockRestore();
      if (typeof original === 'undefined') {
        delete process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA;
      } else {
        process.env.OPENAI_AGENTS_DONT_LOG_MODEL_DATA = original;
      }
    }
  });

  it('does not restore when clearSession fails without mutation', async () => {
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'original' }],
      },
    ] as AgentInputItem[];
    const underlyingSession = new FailingClearBeforeMutationSession({
      initialItems: history,
    });
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession,
      compactionMode: 'input',
    });

    await expect(
      session.runCompaction({ force: true, compactionMode: 'input' }),
    ).rejects.toThrow('clear failed');

    expect(await underlyingSession.getItems()).toEqual(history);
    expect(underlyingSession.clearCalls).toBe(1);
    expect(underlyingSession.addCalls).toBe(0);

    const newerItem = {
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'newer reply' }],
    } as AgentInputItem;
    await session.addItems([newerItem]);
    await expect(underlyingSession.getItems()).resolves.toEqual([
      ...history,
      newerItem,
    ]);
  });

  it('restores history when clearSession fails after mutation', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'original' }],
      },
    ] as AgentInputItem[];
    const underlyingSession = new FailingClearAfterMutationSession({
      initialItems: history,
    });
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession,
      compactionMode: 'input',
    });

    try {
      await expect(
        session.runCompaction({ force: true, compactionMode: 'input' }),
      ).rejects.toThrow('clear failed');

      expect(await underlyingSession.getItems()).toEqual(history);
      expect(underlyingSession.clearCalls).toBe(1);
      expect(underlyingSession.addCalls).toBe(1);
      expect(underlyingSession.popCalls).toBe(0);
      expect(warn).toHaveBeenCalledWith(
        'Restored previous session history after compaction replacement failed.',
        'object',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('clears partial history before restoring after clearSession fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'survived clear' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'removed by partial clear' }],
      },
    ] as AgentInputItem[];

    class PartiallyFailingClearSession extends MemorySession {
      addCalls = 0;
      clearCalls = 0;
      popCalls = 0;

      async addItems(items: AgentInputItem[]): Promise<void> {
        this.addCalls += 1;
        await super.addItems(items);
      }

      async popItem(): Promise<AgentInputItem | undefined> {
        this.popCalls += 1;
        return super.popItem();
      }

      async clearSession(): Promise<void> {
        this.clearCalls += 1;
        await super.popItem();
        throw new Error('clear failed');
      }
    }

    const underlyingSession = new PartiallyFailingClearSession({
      initialItems: history,
    });
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession,
      compactionMode: 'input',
    });

    try {
      await expect(
        session.runCompaction({ force: true, compactionMode: 'input' }),
      ).rejects.toThrow('clear failed');

      expect(await underlyingSession.getItems()).toEqual(history);
      expect(underlyingSession.clearCalls).toBe(1);
      expect(underlyingSession.popCalls).toBe(1);
      expect(underlyingSession.addCalls).toBe(1);
      expect(warn).toHaveBeenCalledWith(
        'Restored previous session history after compaction replacement failed.',
        'object',
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('reraises replacement errors when restore fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'original' }],
      },
    ] as AgentInputItem[];
    const underlyingSession = new FailingRestoreSession({
      initialItems: history,
    });
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted one' }],
        },
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'compacted two' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      underlyingSession,
      compactionMode: 'input',
    });

    try {
      await expect(
        session.runCompaction({ force: true, compactionMode: 'input' }),
      ).rejects.toThrow('replacement failed');
      expect(warn).toHaveBeenCalledWith(
        'Failed to restore session history after compaction replacement failed.',
        'object',
      );
      expect(underlyingSession.clearCalls).toBe(2);
      expect(underlyingSession.addCalls).toBe(2);

      await session.clearSession();
      await expect(underlyingSession.getItems()).resolves.toEqual([]);
      expect(underlyingSession.clearCalls).toBe(3);
    } finally {
      warn.mockRestore();
    }
  });

  it('normalizes compacted user image messages before reusing them as input', async () => {
    const dataUrl = 'data:image/jpeg;base64,abc123';
    const compact = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: 'message',
            role: 'user',
            content: [
              { type: 'input_text', text: 'analyse these images' },
              {
                type: 'input_image',
                detail: 'auto',
                file_id: null,
                image_url: dataUrl,
              },
            ],
          },
        ],
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          total_tokens: 3,
        },
      })
      .mockResolvedValueOnce({
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          total_tokens: 1,
        },
      });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'input',
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'analyse these images' },
          {
            type: 'input_image',
            image: dataUrl,
          },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'how can I help?' }],
      },
    ] as any);

    await session.runCompaction({ force: true, compactionMode: 'input' });

    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'analyse these images' },
          {
            type: 'input_image',
            image: dataUrl,
            detail: 'auto',
          },
        ],
      },
    ]);

    await session.runCompaction({ force: true, compactionMode: 'input' });

    const [secondRequest] = compact.mock.calls[1] ?? [];
    expect(secondRequest.input).toHaveLength(1);
    expect(secondRequest.input[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'input_text', text: 'analyse these images' },
        {
          type: 'input_image',
          image_url: dataUrl,
          detail: 'auto',
        },
      ],
    });
    expect(secondRequest.input[0].content[1].file_id).toBeUndefined();
  });

  it('normalizes compacted user file_data messages before reusing them as input', async () => {
    const base64 = Buffer.from('inline-file').toString('base64');
    const compact = vi
      .fn()
      .mockResolvedValueOnce({
        output: [
          {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_file',
                file_data: base64,
                filename: 'notes.txt',
              },
            ],
          },
        ],
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          total_tokens: 3,
        },
      })
      .mockResolvedValueOnce({
        output: [],
        usage: {
          input_tokens: 1,
          output_tokens: 0,
          total_tokens: 1,
        },
      });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'input',
    });

    await session.addItems([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            file: base64,
            filename: 'notes.txt',
          },
        ],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ready' }],
      },
    ] as any);

    await session.runCompaction({ force: true, compactionMode: 'input' });

    expect(await session.getItems()).toEqual([
      {
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_file',
            file: base64,
            filename: 'notes.txt',
          },
        ],
      },
    ]);

    await session.runCompaction({ force: true, compactionMode: 'input' });

    const [secondRequest] = compact.mock.calls[1] ?? [];
    expect(secondRequest.input).toHaveLength(1);
    expect(secondRequest.input[0]).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'input_file',
          file_data: base64,
          filename: 'notes.txt',
        },
      ],
    });
    expect(secondRequest.input[0].content[0].file_id).toBeUndefined();
    expect(secondRequest.input[0].content[0].file_url).toBeUndefined();
  });

  it('normalizes compacted image and file references', async () => {
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'user',
          content: [
            {
              type: 'input_image',
              file_id: 'file_image',
              image_url: null,
              detail: null,
            },
            {
              type: 'input_file',
              file_url: 'https://example.com/notes.txt',
              filename: 'notes.txt',
            },
            {
              type: 'input_file',
              file_id: 'file_document',
              filename: 'document.pdf',
            },
          ],
        },
      ],
      usage: {
        input_tokens: 3,
        output_tokens: 1,
        total_tokens: 4,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'input',
    });
    await session.addItems([
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'ready' }],
      },
    ] as AgentInputItem[]);

    await session.runCompaction({ force: true });

    await expect(session.getItems()).resolves.toEqual([
      {
        id: undefined,
        type: 'message',
        role: 'user',
        content: [
          {
            type: 'input_image',
            image: { id: 'file_image' },
          },
          {
            type: 'input_file',
            file: 'https://example.com/notes.txt',
            filename: 'notes.txt',
          },
          {
            type: 'input_file',
            file: { id: 'file_document' },
            filename: 'document.pdf',
          },
        ],
      },
    ]);
  });

  it.each([
    [
      { type: 'input_file' },
      'Compaction input_file item missing file_data, file_url, or file_id.',
    ],
    [
      { type: 'input_audio', audio: 'abc123' },
      'Unsupported compaction message content type:',
    ],
  ])(
    'preserves history when compacted content cannot be normalized',
    async (content, error) => {
      const history = [
        {
          type: 'message',
          role: 'assistant',
          status: 'completed',
          content: [{ type: 'output_text', text: 'original' }],
        },
      ] as AgentInputItem[];
      const compact = vi.fn().mockResolvedValue({
        output: [
          {
            type: 'message',
            role: 'user',
            content: [content],
          },
        ],
        usage: {
          input_tokens: 1,
          output_tokens: 1,
          total_tokens: 2,
        },
      });
      const session = new OpenAIResponsesCompactionSession({
        client: { responses: { compact } } as any,
        underlyingSession: new MemorySession({ initialItems: history }),
        compactionMode: 'input',
      });

      await expect(session.runCompaction({ force: true })).rejects.toThrow(
        error,
      );
      await expect(session.getItems()).resolves.toEqual(history);
    },
  );

  it('preserves existing history when compacted output normalization fails', async () => {
    const history = [
      {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'hello' }],
      },
      {
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'world' }],
      },
    ] as const;
    const compact = vi.fn().mockResolvedValue({
      output: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', detail: 'auto' }],
        },
      ],
      usage: {
        input_tokens: 1,
        output_tokens: 1,
        total_tokens: 2,
      },
    });
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'input',
    });

    await session.addItems([...history] as any);

    await expect(
      session.runCompaction({ force: true, compactionMode: 'input' }),
    ).rejects.toThrow(
      'Compaction input_image item missing image_url or file_id.',
    );

    expect(await session.getItems()).toEqual(history);
  });

  it('throws when runCompaction is called without a responseId in previous_response_id mode', async () => {
    const compact = vi.fn();
    const session = new OpenAIResponsesCompactionSession({
      client: { responses: { compact } } as any,
      compactionMode: 'previous_response_id',
    });

    await expect(session.runCompaction({} as any)).rejects.toBeInstanceOf(
      UserError,
    );
  });
});
