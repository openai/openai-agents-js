import { describe, expect, it, vi } from 'vitest';
import {
  createDelegationHandler,
  type LiveMessage,
} from '../../examples/live/delegation';

function event(
  type: string,
  details: Record<string, unknown> = {},
): LiveMessage {
  return {
    type: 'response.event',
    delegation_id: 'delegation-1',
    event: { type, ...details },
  };
}

function call(
  callId: string,
  args = JSON.stringify({ request: `Look up ${callId}.` }),
) {
  return event('response.output_item.done', {
    item: {
      type: 'function_call',
      call_id: callId,
      name: 'ask_order_agent',
      arguments: args,
    },
  });
}

function setup(
  delegate: (request: string, signal: AbortSignal) => Promise<string> = async (
    request,
  ) => `Answer: ${request}`,
) {
  const runAgent = vi.fn(delegate);
  const controller = new AbortController();
  const sent: LiveMessage[] = [];
  const notices: LiveMessage[] = [];
  const handler = createDelegationHandler({
    signal: controller.signal,
    runAgent,
    send: async (message) => {
      sent.push(message);
    },
    notify: async (message) => {
      notices.push(message);
    },
  });
  handler.receive(
    event('response.created', { response: { id: 'response-1' } }),
  );
  return { handler, controller, sent, notices, runAgent };
}

const complete = (id = 'response-1') =>
  event('response.completed', { response: { id, output: [] } });

describe('Live Responses delegation', () => {
  it('collects completed items and submits every original call before one continuation', async () => {
    const { handler, sent, runAgent } = setup();
    handler.receive(call('A0042'));
    handler.receive(call('A0043'));
    expect(runAgent).not.toHaveBeenCalled();
    await handler.receive(complete());
    expect(runAgent.mock.calls.map(([request]) => request)).toEqual([
      'Look up A0042.',
      'Look up A0043.',
    ]);
    expect(sent.map(({ type }) => type)).toEqual([
      'response.item.create',
      'response.item.create',
      'response.create',
    ]);
    expect(sent.slice(0, 2).map(({ item }) => item)).toEqual([
      {
        type: 'function_call_output',
        call_id: 'A0042',
        output: 'Answer: Look up A0042.',
      },
      {
        type: 'function_call_output',
        call_id: 'A0043',
        output: 'Answer: Look up A0043.',
      },
    ]);
  });

  it('does not repeat a completed response or a call observed again in the connection', async () => {
    const { handler, sent, runAgent } = setup();
    handler.receive(call('A0042'));
    await handler.receive(complete());
    handler.receive(complete());
    handler.receive(
      event('response.created', { response: { id: 'response-2' } }),
    );
    handler.receive(call('A0042'));
    await handler.receive(complete('response-2'));
    await handler.drain();
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(sent).toHaveLength(2);
  });

  it('keeps receiving events while a serial specialist call is pending', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const runAgent = vi.fn(async () => {
      entered.resolve();
      return release.promise;
    });
    const { handler, sent } = setup(runAgent);
    handler.receive(call('A0042'));
    const work = handler.receive(complete());
    await entered.promise;
    expect(
      handler.receive({ type: 'session.usage.updated', usage: {} }),
    ).toBeUndefined();
    expect(sent).toEqual([]);
    release.resolve('A0042 has shipped.');
    await work;
    expect(sent.at(-1)?.type).toBe('response.create');
  });

  it('joins an entered callback after cancellation and emits no late result', async () => {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<string>();
    const runAgent = vi.fn(async () => {
      entered.resolve();
      return release.promise;
    });
    const { handler, controller, sent, notices } = setup(runAgent);
    handler.receive(call('A0042'));
    handler.receive(call('A0043'));
    const work = handler.receive(complete())!;
    const failure = work.catch((error: unknown) => error);
    await entered.promise;
    controller.abort(new Error('Caller disconnected.'));
    let joined = false;
    void handler
      .drain()
      .catch(() => {})
      .then(() => {
        joined = true;
      });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(joined).toBe(false);
    release.resolve('A0042 has shipped.');
    expect(await failure).toMatchObject({ message: 'Caller disconnected.' });
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(sent).toEqual([]);
    expect(notices.map(({ status }) => status)).toEqual(['working']);
  });

  it('does not enter the specialist if cancellation arrives during the working notification', async () => {
    const notifying = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const controller = new AbortController();
    const runAgent = vi.fn(async () => 'A0042 has shipped.');
    const send = vi.fn(async () => {});
    const handler = createDelegationHandler({
      signal: controller.signal,
      runAgent,
      send,
      notify: async () => {
        notifying.resolve();
        await release.promise;
      },
    });
    handler.receive(
      event('response.created', { response: { id: 'response-1' } }),
    );
    handler.receive(call('A0042'));
    const result = handler
      .receive(complete())!
      .catch((error: unknown) => error);
    await notifying.promise;
    controller.abort(new Error('Caller disconnected.'));
    release.resolve();
    expect(await result).toMatchObject({ message: 'Caller disconnected.' });
    expect(runAgent).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it('returns a bounded public failure without leaking exception or invalid argument details', async () => {
    const runAgent = vi.fn(async () => {
      throw new Error('private-provider-token');
    });
    const { handler, sent } = setup(runAgent);
    handler.receive(call('invalid', '{private-input'));
    handler.receive(call('failed'));
    await handler.receive(complete());
    expect(runAgent).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(sent)).not.toContain('private');
    expect(sent[0]?.item).toMatchObject({
      output: 'Invalid specialist request. Supply a self-contained request.',
    });
    expect(sent[1]?.item).toMatchObject({
      output: 'The order specialist failed. No order was changed.',
    });
  });

  it.each(['response.failed', 'response.incomplete'])(
    'rejects %s without running collected calls',
    async (type) => {
      const { handler, runAgent, sent } = setup();
      handler.receive(call('A0042'));
      expect(() =>
        handler.receive(event(type, { response: { id: 'response-1' } })),
      ).toThrow('did not complete');
      await handler.drain();
      expect(runAgent).not.toHaveBeenCalled();
      expect(sent).toEqual([]);
    },
  );
});
