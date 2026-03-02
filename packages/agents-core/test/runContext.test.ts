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
