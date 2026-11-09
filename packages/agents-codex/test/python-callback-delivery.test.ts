import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { Session, type OperationOptions } from '../src/runtime/session';
import { NativeAgents } from '../src/runtime/native-agents';
import { captureTools, tool, type FunctionTool } from '../src/runtime/tools';
import type { Engine, NativeThread } from '../src/runtime/binding';

// Native ownership receipts are controlled here. No native execution is claimed.
async function fixture(
  tools: readonly FunctionTool[],
  operation?: OperationOptions,
  nativeAgents?: NativeAgents,
) {
  const queued: string[][] = [];
  let waiting = Promise.withResolvers<string[]>();
  let reading = false;
  const emitBatch = (events: object[]) => {
    const batch = events.map((event) => JSON.stringify(event));
    if (reading) {
      reading = false;
      waiting.resolve(batch);
      waiting = Promise.withResolvers<string[]>();
    } else queued.push(batch);
  };
  const cancelled = new Set<string>();
  const native = {
    id: 'root',
    _submit: vi.fn(async () =>
      JSON.stringify({ status: 'started', turn_id: 'turn' }),
    ),
    _next_session_events: () => {
      if (queued.length) return Promise.resolve(queued.shift()!);
      reading = true;
      return waiting.promise;
    },
    _enter_python_callback: vi.fn((wire: string) => !cancelled.has(wire)),
    _python_callback_cancelled: vi.fn((wire: string) => cancelled.has(wire)),
    _release_python_callback: vi.fn((_wire: string) => true),
    _check_python_tool: vi.fn(() => true),
    _reply_prepared_request: vi.fn((_wire: string) => true),
    _reply_step: vi.fn((_wire: string) => true),
    _reply_child_step: vi.fn((_wire: string) => true),
    _check_step: vi.fn((_wire: string) => true),
    _child_turn: vi.fn(async () => ({
      session_id: 'root',
      child_id: 'child',
      incarnation: 'child-inc',
      instance_id: 'child-instance',
      turn_id: 'child-turn',
    })),
    _enable_native_interception: vi.fn(),
    _configure_native_interception: vi.fn(),
    _next_native_interception: async () => 'null',
    _revoke_native_interception: vi.fn(),
    _finish_native_interception_reader: vi.fn(),
    _respond_python_tool: vi.fn(async (_wire: string) => true),
    _finish_child_event_reader: vi.fn(),
    _stop_sampling_for_close: vi.fn(),
    _close_report: async () => {
      waiting.reject(new Error('reader closed'));
      return null;
    },
  };
  const session = new Session(
    { _close_report: async () => null } as unknown as Engine,
    native as unknown as NativeThread,
    captureTools(tools),
    { websocketsAllowed: false, nativeAgents },
    {},
  );
  await session._start();
  const turn = await session.submit('start', operation);
  const request = (slot: number, callId: string, invocation: string) => {
    const key = {
      _sdk_python_tool: { thread: 'root', generation: 0, slot },
      turnId: 'turn',
      callId,
    };
    const receipt = { kind: 'tool', request: key, invocation };
    return {
      receipt,
      wire: JSON.stringify(receipt),
      event: {
        id: 'turn',
        msg: {
          type: 'dynamic_tool_call_request',
          ...key,
          tool: tools[slot].name,
          namespace: null,
          arguments: {},
          _sdk_code_origin: null,
          _sdk_callback: receipt,
        },
      },
    };
  };
  return {
    session,
    turn,
    native,
    cancelled,
    request,
    emitBatch,
    finish: async () => {
      emitBatch([
        {
          id: 'turn',
          msg: { type: 'task_complete', last_agent_message: 'done' },
        },
      ]);
      await turn.wait();
      await session.close();
    },
  };
}

it('aborts only the exact callback and releases it after its actual finally settles', async () => {
  const entered = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  let siblingSignal: AbortSignal | undefined;
  const a = tool({
    name: 'a',
    parameters: z.object({}),
    execute: async (_args, { signal }) => {
      entered.resolve();
      try {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      } finally {
        cleaning.resolve();
        await release.promise;
      }
      return 'unreachable';
    },
  });
  const sibling = Promise.withResolvers<void>();
  const b = tool({
    name: 'b',
    parameters: z.object({}),
    execute: async (_args, { signal }) => {
      siblingSignal = signal;
      await sibling.promise;
      return 'B accepted';
    },
  });
  const peer = await fixture([a, b]);
  const first = peer.request(0, 'A', '1');
  const second = peer.request(1, 'B', '2');
  try {
    peer.emitBatch([first.event, second.event]);
    await entered.promise;
    await vi.waitFor(() => expect(siblingSignal).toBeDefined());
    peer.cancelled.add(first.wire);
    peer.emitBatch([
      {
        id: 'turn',
        msg: { type: '_sdk_callback_cancel', receipt: first.receipt },
      },
    ]);
    await cleaning.promise;
    expect(siblingSignal!.aborted).toBe(false);
    expect(peer.native._release_python_callback).not.toHaveBeenCalledWith(
      first.wire,
    );
    release.resolve();
    await vi.waitFor(() =>
      expect(peer.native._release_python_callback).toHaveBeenCalledWith(
        first.wire,
      ),
    );
    sibling.resolve();
    await vi.waitFor(() =>
      expect(peer.native._respond_python_tool).toHaveBeenCalledOnce(),
    );
    expect(
      JSON.parse(peer.native._respond_python_tool.mock.calls[0][0]).request
        .callId,
    ).toBe('B');
    expect(siblingSignal!.aborted).toBe(false);
    await peer.finish();
  } finally {
    release.resolve();
    sibling.resolve();
    await peer.session.close();
  }
});

it('does not enter application validation or execution after native admission is denied', async () => {
  const validate = vi.fn();
  const execute = vi.fn(() => 'forbidden');
  const selected = tool({
    name: 'denied',
    parameters: z.object({}).superRefine(validate),
    execute,
  });
  const peer = await fixture([selected]);
  const call = peer.request(0, 'A', '1');
  peer.native._check_python_tool.mockReturnValue(false);
  try {
    peer.emitBatch([call.event]);
    await vi.waitFor(() =>
      expect(peer.native._release_python_callback).toHaveBeenCalledWith(
        call.wire,
      ),
    );
    expect(peer.native._enter_python_callback).toHaveBeenCalledWith(call.wire);
    expect(peer.native._check_python_tool).toHaveBeenCalled();
    expect(validate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    expect(peer.native._respond_python_tool).not.toHaveBeenCalled();
    await peer.finish();
  } finally {
    await peer.session.close();
  }
});

it('atomically claims before application validation and skips a native-cancelled delivery', async () => {
  const validate = vi.fn();
  const execute = vi.fn(() => 'forbidden');
  const selected = tool({
    name: 'probe',
    parameters: z.object({}).superRefine(validate),
    execute,
  });
  const peer = await fixture([selected]);
  const call = peer.request(0, 'A', '1');
  try {
    peer.cancelled.add(call.wire);
    peer.emitBatch([call.event]);
    await vi.waitFor(() =>
      expect(peer.native._release_python_callback).toHaveBeenCalledWith(
        call.wire,
      ),
    );
    expect(peer.native._enter_python_callback).toHaveBeenCalledWith(call.wire);
    expect(validate).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await peer.finish();
  } finally {
    await peer.session.close();
  }
});

it('uses exact native cancellation proof when revocation beats its queued notice', async () => {
  const release = Promise.withResolvers<void>();
  const entered = Promise.withResolvers<void>();
  const selected = tool({
    name: 'probe',
    parameters: z.object({}),
    execute: async () => {
      entered.resolve();
      await release.promise;
      return 'late';
    },
  });
  const peer = await fixture([selected]);
  const call = peer.request(0, 'A', '1');
  try {
    peer.emitBatch([call.event]);
    await entered.promise;
    peer.cancelled.add(call.wire);
    peer.native._check_python_tool.mockImplementation(() => {
      throw new Error('request revoked');
    });
    release.resolve();
    await vi.waitFor(() =>
      expect(peer.native._release_python_callback).toHaveBeenCalledWith(
        call.wire,
      ),
    );
    expect(peer.native._python_callback_cancelled).toHaveBeenCalledWith(
      call.wire,
    );
    expect(peer.native._respond_python_tool).not.toHaveBeenCalled();
    await peer.finish();
  } finally {
    release.resolve();
    await peer.session.close();
  }
});

it('releases a skipped delivery without claiming application execution', async () => {
  const execute = vi.fn(() => 'forbidden');
  const peer = await fixture([
    tool({ name: 'probe', parameters: z.object({}), execute }),
  ]);
  const call = peer.request(0, 'A', '1');
  call.event.msg.turnId = 'other-turn';
  try {
    peer.emitBatch([call.event]);
    await vi.waitFor(() =>
      expect(peer.native._release_python_callback).toHaveBeenCalledWith(
        call.wire,
      ),
    );
    expect(peer.native._enter_python_callback).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
    await peer.finish();
  } finally {
    await peer.session.close();
  }
});

it.each(['request', 'selection'] as const)(
  'retains a %s preparation receipt through actual callback cleanup',
  async (kind) => {
    const entered = Promise.withResolvers<void>();
    const cleaning = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const held = async (signal: AbortSignal) => {
      entered.resolve();
      try {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      } finally {
        cleaning.resolve();
        await release.promise;
      }
    };
    const peer = await fixture(
      [],
      kind === 'request'
        ? {
            prepareRequest: async ({ signal, request }) => {
              await held(signal);
              return request;
            },
          }
        : {
            beforeStep: async ({ signal }) => {
              await held(signal);
              return [];
            },
          },
    );
    const receipt = { kind: 'preparation', thread: 'root', id: '3' };
    const wire = JSON.stringify(receipt);
    try {
      peer.emitBatch([
        {
          id: 'turn',
          msg: {
            type:
              kind === 'request' ? '_sdk_prepare_request' : '_sdk_select_step',
            turn_id: 'turn',
            generation: '0',
            request_id: '3',
            recovery_attempt: 0,
            data: { instructions: 'Help.', input: [], tools: [] },
            _sdk_callback: receipt,
          },
        },
      ]);
      await entered.promise;
      peer.cancelled.add(wire);
      peer.emitBatch([
        { id: 'turn', msg: { type: '_sdk_callback_cancel', receipt } },
      ]);
      await cleaning.promise;
      expect(peer.native._release_python_callback).not.toHaveBeenCalledWith(
        wire,
      );
      if (kind === 'request')
        expect(
          JSON.parse(peer.native._reply_prepared_request.mock.calls[0][0])
            .failed,
        ).toBe(true);
      else
        expect(
          JSON.parse(peer.native._reply_step.mock.calls[0][0]).names,
        ).toBeNull();
      release.resolve();
      await vi.waitFor(() =>
        expect(peer.native._release_python_callback).toHaveBeenCalledWith(wire),
      );
      await peer.finish();
    } finally {
      release.resolve();
      await peer.session.close();
    }
  },
);

it('retains a child selector receipt and cancels only its linked callback', async () => {
  const entered = Promise.withResolvers<void>();
  const cleaning = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const agents = new NativeAgents({
    beforeStep: async ({ signal }) => {
      entered.resolve();
      try {
        await new Promise<never>((_resolve, reject) => {
          const abort = () => reject(signal.reason);
          if (signal.aborted) abort();
          else signal.addEventListener('abort', abort, { once: true });
        });
      } finally {
        cleaning.resolve();
        await release.promise;
      }
      return [];
    },
  });
  const peer = await fixture([], undefined, agents);
  const receipt = {
    kind: 'preparation',
    thread: 'child',
    instance: 'child-inc',
    id: '9',
  };
  const wire = JSON.stringify(receipt);
  const envelope = {
    id: 'child-turn',
    subagent_id: 'child',
    subagent_incarnation: 'child-inc',
    subagent_instance_id: 'child-instance',
    subagent_managed_tools: true,
  };
  try {
    peer.emitBatch([
      {
        ...envelope,
        msg: {
          type: '_sdk_select_step',
          thread: 'child',
          turn_id: 'child-turn',
          generation: '0',
          request_id: '9',
          _sdk_callback: receipt,
        },
      },
    ]);
    await entered.promise;
    peer.cancelled.add(wire);
    peer.emitBatch([
      { ...envelope, msg: { type: '_sdk_callback_cancel', receipt } },
    ]);
    await cleaning.promise;
    expect(peer.native._release_python_callback).not.toHaveBeenCalledWith(wire);
    release.resolve();
    await vi.waitFor(() =>
      expect(peer.native._release_python_callback).toHaveBeenCalledWith(wire),
    );
    expect(
      JSON.parse(peer.native._reply_child_step.mock.calls[0][0]).names,
    ).toBeNull();
    await peer.finish();
  } finally {
    release.resolve();
    await peer.session.close();
  }
});
