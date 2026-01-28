import { describe, it, expect } from 'vitest';
import { RunContext } from '../src/runContext';
import { RunToolApprovalItem as ToolApprovalItem } from '../src/items';
import { Agent } from '../src/agent';

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

describe('RunContext', () => {
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
});
