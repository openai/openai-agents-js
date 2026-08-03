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
) {
  return new ToolApprovalItem(
    {
      type: 'hosted_tool_call',
      name: toolName,
      arguments: '{}',
      status: 'in_progress',
      providerData: {
        itemId,
        serverLabel: 'server-1',
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
    const approvalKey = getFunctionToolStateKeyForCall(
      item.rawItem as { name?: string; namespace?: string },
    )!;
    expect(ctx.toJSON().approvals[approvalKey].messages).toEqual({
      '123': 'Blocked by policy.',
    });
    expect(ctx.toJSON().approvals[approvalKey].stickyRejectMessage).toBe(
      'Blocked by policy.',
    );
  });

  it('uses realtime hosted MCP item ids for rejection message lookups', () => {
    const ctx = new RunContext();
    const item = createRealtimeHostedApproval();

    ctx.rejectTool(item, { message: 'Denied by policy.' });

    expect(
      ctx.isToolApproved({ toolName: 'hostedMcp', callId: 'item-1' }),
    ).toBe(false);
    expect(ctx.getRejectionMessage('hostedMcp', 'item-1')).toBe(
      'Denied by policy.',
    );
    expect(ctx.toJSON().approvals.hostedMcp.messages).toEqual({
      'item-1': 'Denied by policy.',
    });
  });

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
