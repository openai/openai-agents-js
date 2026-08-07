import { describe, it, expect } from 'vitest';
import { RunContext } from '../src/runContext';
import { RunToolApprovalItem as ToolApprovalItem } from '../src/items';
import { Agent } from '../src/agent';
import { tool } from '../src/tool';
import {
  getFunctionToolLookupKey,
  getFunctionToolStateKeyForCall,
} from '../src/toolIdentity';
import { z } from 'zod';

const agent = new Agent({ name: 'A' });
const rawItem = {
  type: 'function_call',
  name: 'toolX',
  callId: '123',
  status: 'completed',
  arguments: '{}',
};

function createApproval(callId = '123', toolName = 'toolX') {
  return new ToolApprovalItem(
    {
      ...rawItem,
      callId,
      name: toolName,
    } as any,
    agent,
  );
}

function createRealtimeHostedApproval(
  itemId = 'item-1',
  toolName = 'hostedMcp',
  serverLabel = 'server-1',
) {
  return new ToolApprovalItem(
    {
      type: 'hosted_tool_call',
      id: 'hosted-output-item',
      name: toolName,
      arguments: '{}',
      status: 'in_progress',
      providerData: {
        itemId,
        serverLabel,
        type: 'mcp_approval_request',
      },
    } as any,
    agent,
  );
}

describe('RunContext', () => {
  it.each(['shell', 'apply_patch', 'hosted_mcp'])(
    'keeps %s approvals separate from same-name function aliases',
    (toolName) => {
      const functionKey = getFunctionToolLookupKey(toolName)!;
      const permanentEntries = [
        [functionKey, { approved: true, rejected: [] }],
        [toolName, { approved: false, rejected: true }],
      ] as const;
      const perCallEntries = [
        [
          functionKey,
          { approved: ['function-call'], rejected: [] as string[] },
        ],
        [
          toolName,
          { approved: [] as string[], rejected: ['non-function-call'] },
        ],
      ] as const;

      for (const entries of [
        permanentEntries,
        [...permanentEntries].reverse(),
      ]) {
        const context = new RunContext();
        context._rebuildApprovals(Object.fromEntries(entries));

        expect(
          context.isToolApproved({
            toolName: functionKey,
            callId: 'future-function-call',
          }),
        ).toBe(true);
        expect(
          context.isToolApproved({
            toolName,
            callId: 'future-non-function-call',
            functionTool: false,
          }),
        ).toBe(false);
      }

      for (const entries of [perCallEntries, [...perCallEntries].reverse()]) {
        const context = new RunContext();
        context._rebuildApprovals(Object.fromEntries(entries));

        expect(
          context.isToolApproved({
            toolName: functionKey,
            callId: 'function-call',
          }),
        ).toBe(true);
        expect(
          context.isToolApproved({
            toolName,
            callId: 'function-call',
            functionTool: false,
          }),
        ).toBeUndefined();
        expect(
          context.isToolApproved({
            toolName,
            callId: 'non-function-call',
            functionTool: false,
          }),
        ).toBe(false);
      }
    },
  );

  it('keeps same-name bare and deferred approvals distinct', () => {
    const bare = tool({
      name: 'lookup',
      description: 'Immediate lookup.',
      parameters: z.object({}),
      execute: async () => 'bare',
    });
    const deferred = tool({
      name: 'lookup',
      description: 'Deferred lookup.',
      parameters: z.object({}),
      deferLoading: true,
      execute: async () => 'deferred',
    });
    const approvalAgent = new Agent({
      name: 'Approval agent',
      tools: [bare, deferred],
    });
    const deferredApproval = new ToolApprovalItem(
      {
        type: 'function_call',
        name: 'lookup',
        namespace: 'lookup',
        callId: 'deferred-call',
        arguments: '{}',
      },
      approvalAgent,
    );
    const ctx = new RunContext();

    ctx.approveTool(deferredApproval, { alwaysApprove: true });

    expect(
      ctx.isToolApproved({
        toolName: getFunctionToolStateKeyForCall(
          deferredApproval.rawItem as { name?: string; namespace?: string },
        )!,
        callId: 'future-deferred-call',
      }),
    ).toBe(true);
    expect(
      ctx.isToolApproved({
        toolName: 'lookup',
        callId: 'future-bare-call',
      }),
    ).toBeUndefined();
  });

  it('keeps dotted bare and explicit namespace approvals distinct', () => {
    const namespacedApproval = new ToolApprovalItem(
      {
        type: 'function_call',
        name: 'lookup',
        namespace: 'crm',
        callId: 'namespaced-call',
        arguments: '{}',
      },
      agent,
    );
    const ctx = new RunContext();

    ctx.approveTool(namespacedApproval, { alwaysApprove: true });

    expect(
      ctx.isToolApproved({
        toolName: getFunctionToolStateKeyForCall(
          namespacedApproval.rawItem as {
            name?: string;
            namespace?: string;
          },
        )!,
        callId: 'future-namespaced-call',
      }),
    ).toBe(true);
    expect(
      ctx.isToolApproved({
        toolName: 'crm.lookup',
        callId: 'future-dotted-call',
      }),
    ).toBeUndefined();
  });

  it('approves and rejects tool calls', () => {
    const ctx = new RunContext();
    const item = createApproval();
    ctx.approveTool(item, { alwaysApprove: true });
    expect(ctx.isToolApproved({ toolName: 'toolX', callId: '123' })).toBe(true);

    ctx.rejectTool(item, { alwaysReject: true });
    expect(ctx.isToolApproved({ toolName: 'toolX', callId: '123' })).toBe(
      false,
    );
  });

  it('rejects all subsequent calls when alwaysReject is true', () => {
    const ctx = new RunContext();
    const item = createApproval();
    ctx.rejectTool(item, { alwaysReject: true });
    expect(ctx.isToolApproved({ toolName: 'toolX', callId: '456' })).toBe(
      false,
    );
  });

  it('scopes function approval decisions to the owning agent', () => {
    const otherAgent = new Agent({ name: 'B' });
    const first = createApproval('shared-call');
    const second = new ToolApprovalItem(
      {
        ...rawItem,
        callId: 'shared-call',
      } as any,
      otherAgent,
    );
    const toolName = getFunctionToolStateKeyForCall(
      first.rawItem as { name?: string; namespace?: string },
    )!;
    const ctx = new RunContext();

    ctx.approveTool(first, { alwaysApprove: true });
    ctx.rejectTool(second, { message: 'Rejected for B.' });

    expect(
      ctx.isToolApproved({
        toolName,
        callId: 'future-call',
        functionTool: false,
        agent,
      }),
    ).toBe(true);
    expect(
      ctx.isToolApproved({
        toolName,
        callId: 'shared-call',
        functionTool: false,
        agent: otherAgent,
      }),
    ).toBe(false);
    expect(
      ctx.isToolApproved({
        toolName,
        callId: 'future-call',
        functionTool: false,
        agent: otherAgent,
      }),
    ).toBeUndefined();
    expect(
      ctx._getFunctionRejectionMessage(toolName, 'shared-call', otherAgent),
    ).toBe('Rejected for B.');
  });

  it('reuses alwaysReject messages for future call ids', () => {
    const ctx = new RunContext();
    const item = createApproval();

    ctx.rejectTool(item, {
      alwaysReject: true,
      message: 'Blocked by policy.',
    });

    expect(ctx.getRejectionMessage('toolX', '123')).toBe('Blocked by policy.');
    expect(ctx.getRejectionMessage('toolX', '456')).toBe('Blocked by policy.');
    expect(ctx.toJSON().approvals.toolX.messages).toEqual({
      '123': 'Blocked by policy.',
    });
    expect(ctx.toJSON().approvals.toolX.stickyRejectMessage).toBe(
      'Blocked by policy.',
    );
  });

  it('uses realtime hosted MCP item ids for rejection message lookups', () => {
    const ctx = new RunContext();
    const item = createRealtimeHostedApproval();

    ctx.rejectTool(item, { message: 'Denied by policy.' });

    expect(ctx._getHostedMcpApprovalStatus(item)).toBe(false);
    expect(ctx._getHostedMcpRejectionMessage(item)).toBe('Denied by policy.');
    expect(ctx.toJSON()).not.toHaveProperty('hostedMcpApprovals');
  });

  it('fails closed for legacy sticky hosted MCP decisions', () => {
    const ctx = new RunContext();
    const item = createRealtimeHostedApproval();
    ctx._rebuildApprovals({
      hostedMcp: {
        approved: true,
        rejected: [],
      },
    });

    expect(ctx._getHostedMcpApprovalStatus(item)).toBeUndefined();
  });

  it('does not treat a colliding aggregate key as hosted MCP state', () => {
    const ctx = new RunContext();
    const item = createRealtimeHostedApproval();
    const collidingLegacyKey = JSON.stringify([
      'hosted_mcp',
      'server-1',
      'hostedMcp',
    ]);
    ctx._rebuildApprovals({
      [collidingLegacyKey]: {
        approved: true,
        rejected: [],
      },
    });

    expect(ctx._getHostedMcpApprovalStatus(item)).toBeUndefined();
  });

  it('isolates hosted MCP state from colliding local tool names', () => {
    const stateKey = JSON.stringify(['hosted_mcp', 'server-1', 'hostedMcp']);
    const hosted = createRealtimeHostedApproval();
    const local = new ToolApprovalItem(
      {
        type: 'shell_call',
        callId: 'local-call',
        name: stateKey,
        status: 'completed',
        action: { commands: ['echo ok'] },
      } as any,
      agent,
      stateKey,
    );

    const hostedContext = new RunContext();
    hostedContext.approveTool(hosted, { alwaysApprove: true });
    expect(
      hostedContext.isToolApproved({
        toolName: stateKey,
        callId: 'future-local-call',
        functionTool: false,
      }),
    ).toBeUndefined();
    expect(
      hostedContext._resolveToolInvocationApproval(
        agent,
        stateKey,
        local.rawItem,
      ),
    ).toBeUndefined();

    const localContext = new RunContext();
    localContext.approveTool(local, { alwaysApprove: true });
    expect(localContext._getHostedMcpApprovalStatus(hosted)).toBeUndefined();
  });

  it('does not consult legacy exact-call hosted MCP decisions at runtime', () => {
    const ctx = new RunContext();
    const item = createRealtimeHostedApproval();
    ctx._rebuildApprovals({
      hostedMcp: {
        approved: [],
        rejected: ['item-1'],
        messages: { 'item-1': 'Legacy denial.' },
      },
    });

    expect(ctx._getHostedMcpApprovalStatus(item)).toBeUndefined();
    expect(ctx._getHostedMcpRejectionMessage(item)).toBeUndefined();
  });

  it('keeps generic hosted one-shot approvals with opaque provider data', () => {
    const ctx = new RunContext();
    const item = new ToolApprovalItem(
      {
        type: 'hosted_tool_call',
        id: 'opaque-hosted-call',
        name: 'opaque_hosted_tool',
        status: 'completed',
        providerData: { vendor: 'example' },
      } as any,
      agent,
    );

    ctx.approveTool(item);

    expect(
      ctx.isToolApproved({
        toolName: 'opaque_hosted_tool',
        callId: 'opaque-hosted-call',
        functionTool: false,
      }),
    ).toBe(true);
  });

  it('does not expose hosted MCP rejection messages to local tools', () => {
    const ctx = new RunContext();
    const hosted = createRealtimeHostedApproval('item-a', 'shell');
    const shell = new ToolApprovalItem(
      {
        type: 'shell_call',
        callId: 'shell-call',
        name: 'shell',
        status: 'completed',
        action: { commands: ['echo ok'] },
      } as any,
      agent,
      'shell',
    );

    ctx.rejectTool(hosted, {
      alwaysReject: true,
      message: 'Hosted-only policy.',
    });
    ctx.rejectTool(shell);

    expect(
      ctx.getRejectionMessage('shell', 'shell-call', { functionTool: false }),
    ).toBeUndefined();
  });

  it('does not expose ambiguous hosted MCP rejection messages publicly', () => {
    const ctx = new RunContext();
    ctx._rebuildApprovals({
      [JSON.stringify(['hosted_mcp', 'server-a', 'lookup_account'])]: {
        approved: [],
        rejected: ['shared-call'],
        messages: { 'shared-call': 'Denied by server A.' },
      },
      [JSON.stringify(['hosted_mcp', 'server-b', 'lookup_account'])]: {
        approved: [],
        rejected: ['shared-call'],
        messages: { 'shared-call': 'Denied by server B.' },
      },
    });

    expect(
      ctx.getRejectionMessage('lookup_account', 'shared-call', {
        functionTool: false,
      }),
    ).toBeUndefined();
  });

  it('rejects hosted MCP decisions without a server identity', () => {
    const ctx = new RunContext();
    const item = createRealtimeHostedApproval();
    delete (item.rawItem.providerData as any).serverLabel;

    expect(() => ctx.approveTool(item)).toThrow(
      'Hosted MCP approval decisions require a non-empty server label and tool name.',
    );
    expect(() => ctx.rejectTool(item)).toThrow(
      'Hosted MCP approval decisions require a non-empty server label and tool name.',
    );
  });

  it.each([
    { label: 'missing', providerData: undefined },
    {
      label: 'wrong-type',
      providerData: { type: 'web_search_call', id: 'item-1' },
    },
  ])(
    'rejects hosted MCP decisions with $label provider data',
    ({ providerData }) => {
      const ctx = new RunContext();
      const item = createRealtimeHostedApproval();
      (item.rawItem as any).providerData = providerData;

      expect(() => ctx.approveTool(item, { alwaysApprove: true })).toThrow(
        'Persistent hosted approval decisions require valid MCP approval request provider data.',
      );
      expect(() => ctx.rejectTool(item, { alwaysReject: true })).toThrow(
        'Persistent hosted approval decisions require valid MCP approval request provider data.',
      );
      expect(ctx.toJSON().approvals).toEqual({});
      expect(ctx.toJSON()).not.toHaveProperty('hostedMcpApprovals');
    },
  );

  it('rebuilds approvals map', () => {
    const ctx = new RunContext();
    ctx._rebuildApprovals({ other: { approved: true, rejected: [] } });
    expect(ctx.isToolApproved({ toolName: 'other', callId: '1' })).toBe(true);
  });

  it('merges approvals without discarding existing entries', () => {
    const ctx = new RunContext();
    ctx.approveTool(createApproval('a'), {});
    ctx._mergeApprovals({
      toolX: { approved: ['b'], rejected: ['c'] },
      other: { approved: true, rejected: [] },
    });

    expect(ctx.isToolApproved({ toolName: 'toolX', callId: 'a' })).toBe(true);
    expect(ctx.isToolApproved({ toolName: 'toolX', callId: 'b' })).toBe(true);
    expect(ctx.isToolApproved({ toolName: 'toolX', callId: 'c' })).toBe(false);
    expect(ctx.isToolApproved({ toolName: 'other', callId: '1' })).toBe(true);
  });

  it('creates child contexts with shared state and tool input', () => {
    const ctx = new RunContext({ locale: 'en-US' });
    ctx.approveTool(createApproval('call-1'), {});

    const child = ctx._forkWithToolInput({ input: 'hello' });

    expect(child).not.toBe(ctx);
    expect(child.context).toBe(ctx.context);
    expect(child.usage).toBe(ctx.usage);
    expect(child.toolInput).toEqual({ input: 'hello' });
    expect(child.isToolApproved({ toolName: 'toolX', callId: 'call-1' })).toBe(
      true,
    );
    expect(child.toJSON().toolInput).toEqual({ input: 'hello' });
  });

  it('can clear inherited tool input in child contexts', () => {
    const ctx = new RunContext({ locale: 'en-US' });
    ctx.toolInput = { input: 'stale' };

    const child = ctx._forkWithoutToolInput();

    expect(child).not.toBe(ctx);
    expect(child.context).toBe(ctx.context);
    expect(child.usage).toBe(ctx.usage);
    expect(child.toolInput).toBeUndefined();
    expect(child.toJSON().toolInput).toBeUndefined();
    expect(ctx.toolInput).toEqual({ input: 'stale' });
  });

  it('preserves custom RunContext subclasses when _createFork is overridden', () => {
    class ExtendedRunContext extends RunContext<{ locale: string }> {
      marker: string;

      constructor(context: { locale: string }, marker: string) {
        super(context);
        this.marker = marker;
      }

      protected override _createFork(): RunContext<{ locale: string }> {
        return new ExtendedRunContext(this.context, this.marker);
      }

      describe() {
        return `${this.context.locale}:${this.marker}`;
      }
    }

    const ctx = new ExtendedRunContext({ locale: 'en-US' }, 'marker');
    ctx.toolInput = { input: 'stale' };

    const withInput = ctx._forkWithToolInput({ input: 'fresh' });
    const withoutInput = ctx._forkWithoutToolInput();

    expect(withInput).toBeInstanceOf(ExtendedRunContext);
    expect((withInput as ExtendedRunContext).describe()).toBe('en-US:marker');
    expect(withInput.toolInput).toEqual({ input: 'fresh' });

    expect(withoutInput).toBeInstanceOf(ExtendedRunContext);
    expect((withoutInput as ExtendedRunContext).describe()).toBe(
      'en-US:marker',
    );
    expect(withoutInput.toolInput).toBeUndefined();
    expect(ctx.toolInput).toEqual({ input: 'stale' });
  });

  it('falls back to a base RunContext when subclasses do not override _createFork', () => {
    class ExtendedRunContext extends RunContext<{ locale: string }> {
      marker: string;

      constructor(context: { locale: string }, marker: string) {
        super(context);
        this.marker = marker;
      }
    }

    const ctx = new ExtendedRunContext({ locale: 'en-US' }, 'marker');

    const child = ctx._forkWithToolInput({ input: 'fresh' });

    expect(child).toBeInstanceOf(RunContext);
    expect(child).not.toBeInstanceOf(ExtendedRunContext);
    expect(child.context).toBe(ctx.context);
    expect(child.usage).toBe(ctx.usage);
    expect(child.toolInput).toEqual({ input: 'fresh' });
  });
});
