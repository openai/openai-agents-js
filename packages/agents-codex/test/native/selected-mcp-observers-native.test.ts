import { afterEach, expect, it, vi } from 'vitest';
import {
  Agent,
  NativeProvider,
  selectMcpTools,
  type Session,
  type MCPToolStartObservation,
} from '../../src';
import { BorrowedPeer } from './fixtures/borrowed-mcp';
import { ModelServer, call, message } from './fixtures/model-server';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}
const sessions: Session[] = [];
const providers: NativeProvider[] = [];
afterEach(async () => {
  for (const session of sessions.splice(0)) await session.close();
  for (const provider of providers.splice(0)) await provider.close();
  await ModelServer.closeAll();
});
async function application(
  peer: BorrowedPeer,
  approval?: (event: MCPToolStartObservation) => boolean | Promise<boolean>,
  onToolLifecycle?: Agent['onToolLifecycle'],
) {
  const selected = await selectMcpTools(
    { name: 'crm', server: peer },
    { context: undefined, approval },
  );
  const model = new ModelServer([
    [
      call(
        'lookup',
        { value: 'ok' },
        { namespace: 'crm', callId: 'selected-call' },
      ),
    ],
    [message('done')],
  ]);
  const config = await model.config();
  const route = config['model_providers.fixture'] as { base_url: string };
  const provider = new NativeProvider({
    baseUrl: route.base_url,
    apiKey: 'synthetic',
    supportsWebsockets: false,
  });
  providers.push(provider);
  const session = await new Agent({
    instructions: 'Call the selected MCP tool once.',
    model: 'gpt-5.5',
    programmaticToolCalling: false,
    provider,
    tools: selected,
    onToolLifecycle,
  }).session();
  sessions.push(session);
  return { session, model };
}
async function entered(gate: Promise<void>, completion: Promise<unknown>) {
  await Promise.race([
    gate,
    completion.then(() => {
      throw new Error('Turn completed before observer was entered');
    }),
  ]);
}

it.each([false, true])(
  'runs selected MCP lifecycle observers after approval and before dispatch (deny: %s)',
  async (deny) => {
    const peer = new BorrowedPeer();
    const events: string[] = [];
    const refusal = new Error('selected tool lifecycle refused');
    const { session, model } = await application(
      peer,
      () => {
        events.push('approved');
        expect(peer.callTool).not.toHaveBeenCalled();
        return true;
      },
      (event) => {
        events.push(event.kind);
        expect(event.callId).toBe('selected-call');
        if (event.kind === 'start') {
          expect(peer.callTool).not.toHaveBeenCalled();
          if (deny) throw refusal;
        } else {
          expect(peer.callTool).toHaveBeenCalledTimes(1);
          expect(model.requests).toHaveLength(1);
        }
      },
    );
    const turn = await session.submit('run');
    if (deny) {
      await expect(turn.wait()).rejects.toBe(refusal);
      expect(events).toEqual(['approved', 'start']);
      expect(model.requests).toHaveLength(1);
      expect(peer.callTool).not.toHaveBeenCalled();
    } else {
      expect((await turn.wait()).finalOutput).toBe('done');
      expect(events).toEqual(['approved', 'start', 'end']);
      expect(model.requests).toHaveLength(2);
      expect(peer.callTool).toHaveBeenCalledTimes(1);
    }
  },
);

it('pauses native execution at approval, start and normalized end before result publication', async () => {
  const peer = new BorrowedPeer();
  const approval = gate(),
    start = gate(),
    end = gate(),
    atApproval = gate(),
    atStart = gate(),
    atEnd = gate();
  const events: string[] = [];
  Object.assign(peer, {
    onToolStart: async (event: MCPToolStartObservation) => {
      events.push('start');
      (event.arguments as Record<string, unknown>).value = 'ignored';
      atStart.release();
      await start.promise;
      return 'ignored';
    },
    onToolEnd: async () => {
      events.push('end');
      atEnd.release();
      await end.promise;
      return { content: [] };
    },
  });
  const f = await application(peer, async () => {
    events.push('approval');
    atApproval.release();
    await approval.promise;
    return true;
  });
  const turn = await f.session.submit('run');
  const completion = turn.wait();
  completion.catch(() => {});
  try {
    await entered(atApproval.promise, completion);
    expect(events).toEqual(['approval']);
    expect(peer.callTool).not.toHaveBeenCalled();
    approval.release();
    await entered(atStart.promise, completion);
    expect(peer.callTool).not.toHaveBeenCalled();
    start.release();
    await entered(atEnd.promise, completion);
    expect(peer.callTool).toHaveBeenCalledExactlyOnceWith(
      'lookup',
      { value: 'ok' },
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(f.model.requests).toHaveLength(1);
    end.release();
    expect((await completion).finalOutput).toBe('done');
    expect(events).toEqual(['approval', 'start', 'end']);
    expect(f.model.requests).toHaveLength(2);
  } finally {
    approval.release();
    start.release();
    end.release();
    await completion.catch(() => {});
  }
});

it.each(['approval', 'start', 'end'] as const)(
  'fails native execution on rejected %s without replay or output publication',
  async (phase) => {
    const peer = new BorrowedPeer();
    const failure = new Error('observation stopped');
    const start = vi.fn(() => {
      if (phase === 'start') throw failure;
    });
    const end = vi.fn(() => {
      if (phase === 'end') throw failure;
    });
    Object.assign(peer, { onToolStart: start, onToolEnd: end });
    const f = await application(
      peer,
      phase === 'approval'
        ? async () => {
            throw failure;
          }
        : undefined,
    );
    const turn = await f.session.submit('run');
    await expect(turn.wait()).rejects.toThrow('observation stopped');
    expect(peer.callTool).toHaveBeenCalledTimes(phase === 'end' ? 1 : 0);
    expect(start).toHaveBeenCalledTimes(phase === 'approval' ? 0 : 1);
    expect(end).toHaveBeenCalledTimes(phase === 'end' ? 1 : 0);
    expect(f.model.requests).toHaveLength(1);
  },
);

it.each(['start', 'end'] as const)(
  'joins a cancelled native %s and never publishes or repeats a late result',
  async (phase) => {
    const peer = new BorrowedPeer();
    const at = gate(),
      hold = gate();
    let observedSignal: AbortSignal | undefined;
    const observer = vi.fn(async (event: MCPToolStartObservation) => {
      observedSignal = event.signal;
      at.release();
      await hold.promise;
    });
    Object.assign(
      peer,
      phase === 'start' ? { onToolStart: observer } : { onToolEnd: observer },
    );
    const f = await application(peer);
    const turn = await f.session.submit('run');
    const completion = turn.wait();
    completion.catch(() => {});
    let close: Promise<void> | undefined;
    try {
      await entered(at.promise, completion);
      let closed = false;
      close = f.session.close().then(() => {
        closed = true;
      });
      await vi.waitFor(() => expect(observedSignal?.aborted).toBe(true));
      expect(closed).toBe(false);
      expect(peer.callTool).toHaveBeenCalledTimes(phase === 'start' ? 0 : 1);
      hold.release();
      await close;
      await expect(completion).rejects.toThrow();
      expect(peer.callTool).toHaveBeenCalledTimes(phase === 'start' ? 0 : 1);
      expect(observer).toHaveBeenCalledTimes(1);
      expect(f.model.requests).toHaveLength(1);
    } finally {
      hold.release();
      await close;
      await completion.catch(() => {});
    }
  },
);
