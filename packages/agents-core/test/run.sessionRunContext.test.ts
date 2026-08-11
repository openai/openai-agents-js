import { beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
  Agent,
  RunContext,
  run,
  setTracingDisabled,
  tool,
  type AgentInputItem,
  type OpenAIResponsesCompactionArgs,
  type RunContextAwareSession,
  type Session,
  type SessionHistoryTransactionArgs,
} from '../src';
import {
  RunCompactionItem as CompactionItem,
  RunToolCallItem as ToolCallItem,
  RunToolCallOutputItem as ToolCallOutputItem,
} from '../src/items';
import logger from '../src/logger';
import { saveToSession } from '../src/runner/sessionPersistence';
import { RunResult } from '../src/result';
import { RunState } from '../src/runState';
import type * as protocol from '../src/types/protocol';
import { fakeModelMessage } from './stubs';
import { Usage } from '../src/usage';
import { ScriptedModel, modelResponse } from '../src/testing';

type TenantContext = {
  tenantId: string;
};

type SessionCall = {
  name: 'getItems' | 'addItems' | 'popItem' | 'clearSession';
  runContext: RunContext<TenantContext> | undefined;
};

class FinalResponseModel extends ScriptedModel {
  constructor() {
    super([
      modelResponse({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
        responseId: 'response-id',
      }),
    ]);
  }
}

class ApprovalModel extends ScriptedModel {
  constructor() {
    super([
      modelResponse({
        output: [
          {
            type: 'function_call',
            id: 'approval-item',
            callId: 'approval-call',
            name: 'context_tool',
            status: 'completed',
            arguments: '{}',
          },
        ],
        usage: new Usage(),
      }),
      modelResponse({
        output: [fakeModelMessage('done')],
        usage: new Usage(),
      }),
    ]);
  }
}

class TenantSession implements RunContextAwareSession<TenantContext> {
  readonly acceptsRunContext = true;
  readonly itemsByTenant = new Map<string, AgentInputItem[]>([['default', []]]);
  readonly calls: SessionCall[] = [];

  async getSessionId(): Promise<string> {
    return 'tenant-session';
  }

  async getItems(
    limit?: number,
    runContext?: RunContext<TenantContext>,
  ): Promise<AgentInputItem[]> {
    this.calls.push({ name: 'getItems', runContext });
    const items = this.getTenantItems(runContext);
    return limit === undefined ? [...items] : items.slice(-limit);
  }

  async addItems(
    items: AgentInputItem[],
    runContext?: RunContext<TenantContext>,
  ): Promise<void> {
    this.calls.push({ name: 'addItems', runContext });
    this.getTenantItems(runContext).push(...items);
  }

  async popItem(
    runContext?: RunContext<TenantContext>,
  ): Promise<AgentInputItem | undefined> {
    this.calls.push({ name: 'popItem', runContext });
    return this.getTenantItems(runContext).pop();
  }

  async clearSession(runContext?: RunContext<TenantContext>): Promise<void> {
    this.calls.push({ name: 'clearSession', runContext });
    this.itemsByTenant.set(this.getTenantId(runContext), []);
  }

  protected getTenantItems(
    runContext: RunContext<TenantContext> | undefined,
  ): AgentInputItem[] {
    const tenantId = this.getTenantId(runContext);
    const items = this.itemsByTenant.get(tenantId) ?? [];
    this.itemsByTenant.set(tenantId, items);
    return items;
  }

  protected getTenantId(
    runContext: RunContext<TenantContext> | undefined,
  ): string {
    return runContext?.context.tenantId ?? 'default';
  }
}

class ContextAwareTransactionSession extends TenantSession {
  readonly transactionContexts: Array<RunContext<TenantContext> | undefined> =
    [];

  async applyHistoryTransaction(
    args: SessionHistoryTransactionArgs,
    runContext?: RunContext<TenantContext>,
  ): Promise<void> {
    this.transactionContexts.push(runContext);
    const items = this.getTenantItems(runContext);
    if (args.transaction.type === 'append_items') {
      items.push(...structuredClone(args.transaction.items));
      return;
    }

    const suffixStart = items.length - args.transaction.expectedSuffix.length;
    items.splice(
      suffixStart,
      args.transaction.expectedSuffix.length,
      ...structuredClone(args.transaction.replacement),
    );
  }
}

class FailingTenantReplacementSession extends TenantSession {
  readonly replacementError = new Error('replacement failed');
  private failNextAdd = true;

  override async addItems(
    items: AgentInputItem[],
    runContext?: RunContext<TenantContext>,
  ): Promise<void> {
    this.calls.push({ name: 'addItems', runContext });
    const tenantItems = this.getTenantItems(runContext);
    if (this.failNextAdd) {
      this.failNextAdd = false;
      tenantItems.push(structuredClone(items[0]));
      throw this.replacementError;
    }
    tenantItems.push(...structuredClone(items));
  }
}

class ContextAwareCompactionSession extends TenantSession {
  readonly compactionContexts: Array<RunContext<TenantContext> | undefined> =
    [];

  async runCompaction(
    _args?: OpenAIResponsesCompactionArgs,
    runContext?: RunContext<TenantContext>,
  ): Promise<null> {
    this.compactionContexts.push(runContext);
    return null;
  }
}

class LegacySession implements Session {
  readonly calls: Array<{ name: string; argumentCount: number }> = [];
  readonly items: AgentInputItem[] = [];

  async getSessionId(): Promise<string> {
    return 'legacy-session';
  }

  async getItems(_limit?: number): Promise<AgentInputItem[]> {
    this.calls.push({ name: 'getItems', argumentCount: arguments.length });
    return [...this.items];
  }

  async addItems(items: AgentInputItem[]): Promise<void> {
    this.calls.push({ name: 'addItems', argumentCount: arguments.length });
    this.items.push(...items);
  }

  async popItem(): Promise<AgentInputItem | undefined> {
    this.calls.push({ name: 'popItem', argumentCount: arguments.length });
    return this.items.pop();
  }

  async clearSession(): Promise<void> {
    this.calls.push({ name: 'clearSession', argumentCount: arguments.length });
    this.items.length = 0;
  }
}

describe('run context aware sessions', () => {
  beforeAll(() => {
    setTracingDisabled(true);
  });

  it.each([false, true])(
    'passes one run context through %s streaming session operations',
    async (stream) => {
      const context: TenantContext = { tenantId: 'tenant-a' };
      const session = new TenantSession();
      const agent = new Agent({
        name: 'Context aware session',
        model: new FinalResponseModel(),
      });

      const result = stream
        ? await run(agent, 'hello', {
            context,
            session,
            stream: true,
          })
        : await run(agent, 'hello', {
            context,
            session,
            stream: false,
          });
      if ('completed' in result) {
        await result.completed;
      }

      expect(result.finalOutput).toBe('done');
      expect(session.itemsByTenant.get('default')).toEqual([]);
      expect(session.itemsByTenant.get('tenant-a')).toHaveLength(2);
      expect(session.calls.map((call) => call.name)).toEqual([
        'getItems',
        'addItems',
      ]);
      expect(
        session.calls.every((call) => call.runContext === result.runContext),
      ).toBe(true);
      expect(result.runContext.context).toBe(context);
    },
  );

  it('reuses the restored run context for resumed session operations', async () => {
    const context: TenantContext = { tenantId: 'tenant-a' };
    const session = new TenantSession();
    const contextTool = tool({
      name: 'context_tool',
      description: 'Return a context-aware result.',
      parameters: z.object({}),
      needsApproval: true,
      execute: async () => 'approved',
    });
    const agent = new Agent({
      name: 'Resumed context-aware session',
      model: new ApprovalModel(),
      tools: [contextTool],
    });

    const interrupted = await run(agent, 'hello', { context, session });
    expect(interrupted.interruptions).toHaveLength(1);
    interrupted.state.approve(interrupted.interruptions[0]);
    session.calls.length = 0;

    const resumed = await run(agent, interrupted.state, { session });

    expect(resumed.finalOutput).toBe('done');
    expect(resumed.runContext).toBe(interrupted.runContext);
    expect(
      session.calls.every((call) => call.runContext === interrupted.runContext),
    ).toBe(true);
    expect(session.itemsByTenant.get('default')).toEqual([]);
    expect(session.itemsByTenant.get('tenant-a')).toHaveLength(4);
  });

  it('passes the run context to an opted-in compaction hook', async () => {
    const session = new ContextAwareCompactionSession();
    const result = await run(
      new Agent({
        name: 'Context-aware compaction',
        model: new FinalResponseModel(),
      }),
      'hello',
      {
        context: { tenantId: 'tenant-a' },
        session,
      },
    );

    expect(session.compactionContexts).toEqual([result.runContext]);
  });

  it('passes the run context to session history transactions', async () => {
    const session = new ContextAwareTransactionSession();
    const context: TenantContext = { tenantId: 'tenant-a' };
    const runContext = new RunContext(context);
    const agent = new Agent<TenantContext>({
      name: 'Context-aware transaction',
      model: new FinalResponseModel(),
    });
    const call: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: 'transaction-call',
      name: 'context_tool',
      arguments: '{}',
    };
    const callItem = new ToolCallItem(call, agent as any);
    const resultItem = new ToolCallOutputItem(
      {
        type: 'function_call_result',
        callId: call.callId,
        name: call.name,
        status: 'completed',
        output: 'committed',
      },
      agent as any,
      'committed',
      undefined,
      'executed',
    );
    const input = fakeModelMessage('transaction input');
    const state = new RunState(runContext, [input], agent, 1);
    state._generatedItems = [callItem, resultItem];
    state._currentTurnSessionHistoryTransactionInputItems = [input];

    await saveToSession(session, [input], new RunResult(state as any), {
      outputBlocked: true,
    });

    expect(session.transactionContexts).toEqual([runContext]);
    expect(session.itemsByTenant.get('default')).toEqual([]);
    expect(session.itemsByTenant.get('tenant-a')).toEqual([
      input,
      call,
      resultItem.rawItem,
    ]);
  });

  it('uses the run context throughout failed replacement recovery', async () => {
    const call: protocol.FunctionCallItem = {
      type: 'function_call',
      callId: 'replacement-call',
      name: 'context_tool',
      arguments: '{}',
    };
    const compaction: protocol.CompactionItem = {
      type: 'compaction',
      id: 'replacement-compaction',
      encrypted_content: 'ciphertext',
    };
    const defaultItem = fakeModelMessage('default history');
    const session = new FailingTenantReplacementSession();
    session.itemsByTenant.set('default', [defaultItem]);
    session.itemsByTenant.set('tenant-a', [structuredClone(call)]);
    const runContext = new RunContext<TenantContext>({
      tenantId: 'tenant-a',
    });
    const agent = new Agent<TenantContext>({
      name: 'Context-aware replacement recovery',
      model: new FinalResponseModel(),
    });
    const state = new RunState(runContext, 'input', agent, 1);
    state._generatedItems = [
      new CompactionItem(compaction, agent as any),
      new ToolCallItem(call, agent as any),
    ];
    state._pendingLegacyCompactionSessionItems = [compaction, call];
    state._currentTurnPersistedItemCount = 2;
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});

    try {
      await expect(
        saveToSession(session, [], new RunResult(state as any), {
          runCompaction: false,
        }),
      ).rejects.toBe(session.replacementError);
    } finally {
      warnSpy.mockRestore();
    }

    expect(session.calls.map((call) => call.name)).toEqual([
      'getItems',
      'clearSession',
      'addItems',
      'getItems',
      'clearSession',
      'addItems',
    ]);
    expect(session.calls.every((call) => call.runContext === runContext)).toBe(
      true,
    );
    expect(session.itemsByTenant.get('tenant-a')).toEqual([call]);
    expect(session.itemsByTenant.get('default')).toEqual([defaultItem]);
    expect(state._pendingLegacyCompactionSessionItems).toEqual([
      compaction,
      call,
    ]);
    expect(state._currentTurnPersistedItemCount).toBe(2);
  });

  it.each([false, true])(
    'preserves legacy method call shapes for %s streaming runs',
    async (stream) => {
      const session = new LegacySession();
      const agent = new Agent({
        name: 'Legacy session',
        model: new FinalResponseModel(),
      });

      const result = stream
        ? await run(agent, 'hello', {
            context: { tenantId: 'tenant-a' },
            session,
            stream: true,
          })
        : await run(agent, 'hello', {
            context: { tenantId: 'tenant-a' },
            session,
            stream: false,
          });
      if ('completed' in result) {
        await result.completed;
      }

      expect(result.finalOutput).toBe('done');
      expect(session.calls).toEqual([
        { name: 'getItems', argumentCount: 0 },
        { name: 'addItems', argumentCount: 1 },
      ]);
    },
  );
});
