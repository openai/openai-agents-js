import { expect, it, vi } from 'vitest';
import {
  selectMcpTools,
  type Turn,
  type MCPToolStartObservation,
  type MCPToolEndObservation,
} from '../../src';
import {
  invokeFunctionTool,
  type ToolCallContext,
} from '../../src/runtime/tools';
import { BorrowedPeer } from '../native/fixtures/borrowed-mcp';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
const context = (signal: AbortSignal): ToolCallContext => ({
  context: undefined,
  submission: {} as Turn,
  threadId: 'thread',
  turnId: 'turn',
  callId: 'call',
  signal,
});

it('awaits approval, detached observers and wrapped transforms before projection; ignores returns', async () => {
  const peer = new BorrowedPeer();
  Object.assign(peer, { useStructuredContent: true });
  Object.assign(peer.declarations[0].inputSchema.properties!, {
    nested: { type: 'object', properties: { value: { type: 'string' } } },
  });
  const events: string[] = [];
  const approval = gate(),
    start = gate(),
    end = gate();
  const enteredApproval = gate(),
    enteredStart = gate(),
    enteredEnd = gate();
  const raw = {
    content: [{ type: 'text', text: 'raw' }],
    structuredContent: { observerProjection: 'real' },
    _meta: { owner: 'original' },
    extension: { source: 'preserved' },
  };
  const dispatch = vi.fn(async (args: unknown) => {
    expect(args).toEqual({
      value: 'transformed',
      nested: { value: 'original' },
    });
    events.push('invoke');
    return {
      ...raw,
      structuredContent: { observerProjection: 'before-transform' },
    };
  });
  peer.callToolResult = vi.fn(async (_name, args) => {
    expect(args).toEqual({ value: 'original', nested: { value: 'original' } });
    events.push('argument-transform');
    const result = await dispatch({ ...args, value: 'transformed' });
    events.push('result-transform');
    return { ...result, structuredContent: { observerProjection: 'real' } };
  });
  Object.assign(peer, {
    onToolStart: async (event: MCPToolStartObservation) => {
      events.push('start');
      (event.arguments.nested as { value: string }).value = 'changed';
      enteredStart.release();
      await start.promise;
      return { value: 'replacement' };
    },
    onToolEnd: async (event: MCPToolEndObservation) => {
      events.push('end');
      expect(event.result).toEqual(raw);
      event.result.structuredContent!.observerProjection = 'changed';
      event.result._meta!.owner = 'changed';
      enteredEnd.release();
      await end.promise;
      return { content: [] };
    },
  });
  const [selected] = await selectMcpTools(
    { name: 'crm', server: peer },
    {
      context: undefined,
      approval: async () => {
        events.push('approval');
        enteredApproval.release();
        await approval.promise;
        return true;
      },
    },
  );
  const stringify = JSON.stringify;
  const spy = vi
    .spyOn(JSON, 'stringify')
    .mockImplementation((value: unknown) => {
      if (
        value !== null &&
        typeof value === 'object' &&
        'observerProjection' in value
      )
        events.push('serialize');
      return stringify(value);
    });
  try {
    const completion = invokeFunctionTool(
      selected!,
      { value: 'original', nested: { value: 'original' } },
      context(new AbortController().signal),
      () => {},
    );
    await enteredApproval.promise;
    expect(events).toEqual(['approval']);
    approval.release();
    await enteredStart.promise;
    expect(peer.callToolResult).not.toHaveBeenCalled();
    start.release();
    await enteredEnd.promise;
    expect(events).not.toContain('serialize');
    end.release();
    expect(await completion).toEqual({
      success: true,
      contentItems: [
        { type: 'inputText', text: '{"observerProjection":"real"}' },
      ],
    });
    expect(events).toEqual([
      'approval',
      'start',
      'argument-transform',
      'invoke',
      'result-transform',
      'end',
      'serialize',
    ]);
    expect(raw._meta.owner).toBe('original');
  } finally {
    approval.release();
    start.release();
    end.release();
    spy.mockRestore();
  }
});

it.each(['deny', 'reject', 'cancel'] as const)(
  'does not dispatch after approval %s',
  async (mode) => {
    const peer = new BorrowedPeer();
    const start = vi.fn();
    Object.assign(peer, { onToolStart: start });
    const controller = new AbortController();
    const error = new Error('approval stopped');
    const [selected] = await selectMcpTools(
      { name: 'crm', server: peer },
      {
        context: undefined,
        approval: async () => {
          if (mode === 'reject') throw error;
          if (mode === 'cancel') controller.abort(error);
          return false;
        },
      },
    );
    await expect(
      invokeFunctionTool(
        selected!,
        { value: 'ok' },
        context(controller.signal),
        () => {},
      ),
    ).rejects.toThrow();
    expect(start).not.toHaveBeenCalled();
    expect(peer.callTool).not.toHaveBeenCalled();
  },
);

it.each(['reject', 'cancel'] as const)(
  'joins a held start and prevents dispatch on %s',
  async (mode) => {
    const peer = new BorrowedPeer();
    const entered = gate(),
      held = gate();
    const error = new Error('start stopped');
    const controller = new AbortController();
    Object.assign(peer, {
      onToolStart: async () => {
        entered.release();
        await held.promise;
        if (mode === 'reject') throw error;
      },
      onToolEnd: vi.fn(),
    });
    const [selected] = await selectMcpTools(
      { name: 'crm', server: peer },
      { context: undefined },
    );
    let settled = false;
    const completion = invokeFunctionTool(
      selected!,
      { value: 'ok' },
      context(controller.signal),
      () => {},
    ).finally(() => (settled = true));
    completion.catch(() => {});
    try {
      await entered.promise;
      if (mode === 'cancel') controller.abort(error);
      await Promise.resolve();
      expect(settled).toBe(false);
      expect(peer.callTool).not.toHaveBeenCalled();
      held.release();
      await expect(completion).rejects.toBe(error);
      expect(peer.callTool).not.toHaveBeenCalled();
    } finally {
      held.release();
      await completion.catch(() => {});
    }
  },
);

it.each(['reject', 'cancel'] as const)(
  'withholds output after end %s without repeating an effect',
  async (mode) => {
    const peer = new BorrowedPeer();
    const entered = gate(),
      held = gate();
    const error = new Error('end stopped');
    const controller = new AbortController();
    const observer = vi.fn(async () => {
      entered.release();
      await held.promise;
      if (mode === 'reject') throw error;
    });
    Object.assign(peer, { onToolEnd: observer });
    const [selected] = await selectMcpTools(
      { name: 'crm', server: peer },
      { context: undefined },
    );
    const completion = invokeFunctionTool(
      selected!,
      { value: 'ok' },
      context(controller.signal),
      () => {},
    );
    completion.catch(() => {});
    try {
      await entered.promise;
      expect(peer.callTool).toHaveBeenCalledTimes(1);
      if (mode === 'cancel') controller.abort(error);
      held.release();
      await expect(completion).rejects.toBe(error);
      expect(peer.callTool).toHaveBeenCalledTimes(1);
      expect(observer).toHaveBeenCalledTimes(1);
    } finally {
      held.release();
      await completion.catch(() => {});
    }
  },
);

it('preserves non-enumerable legacy metadata in the detached normalized result', async () => {
  const peer = new BorrowedPeer();
  const content = [{ type: 'text', text: 'failed' }];
  Object.defineProperties(content, {
    isError: { value: true },
    structuredContent: { value: { record: 'preserved' } },
    _meta: { value: { source: 'legacy' } },
  });
  peer.callTool.mockResolvedValue(content);
  const observer = vi.fn();
  Object.assign(peer, { onToolEnd: observer });
  const [selected] = await selectMcpTools(
    { name: 'crm', server: peer },
    { context: undefined },
  );
  expect(
    await invokeFunctionTool(
      selected!,
      { value: 'ok' },
      context(new AbortController().signal),
      () => {},
    ),
  ).toMatchObject({ success: false });
  expect(observer.mock.calls[0][0].result).toEqual({
    content: [{ type: 'text', text: 'failed' }],
    isError: true,
    structuredContent: { record: 'preserved' },
    _meta: { source: 'legacy' },
  });
});
