import { UserError } from '@openai/agents-core';
import { describe, expect, it, vi } from 'vitest';

import type { RealtimeClientMessage } from '../src/clientMessages';
import type { RealtimeItem, RealtimeToolCallItem } from '../src/items';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';

class TestBase extends OpenAIRealtimeBase {
  status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
    'connected';
  events: RealtimeClientMessage[] = [];
  failNextSend = false;
  failOnSendAttempt: number | null = null;
  sendAttempts = 0;
  connect = vi.fn(async () => {});
  sendEvent(event: RealtimeClientMessage) {
    this.sendAttempts += 1;
    if (this.failNextSend || this.failOnSendAttempt === this.sendAttempts) {
      this.failNextSend = false;
      this.failOnSendAttempt = null;
      throw new Error('synchronous send failure');
    }
    this.events.push(event);
  }
  mute = vi.fn();
  close = vi.fn();
  interrupt = vi.fn();
  get muted() {
    return false;
  }

  open() {
    this._onOpen();
  }

  announceConnected() {
    this.emit('connection_change', 'connected');
    this._onOpen();
  }

  closeTransport() {
    this._onClose();
  }
}

function functionCall({
  output = null,
}: { output?: string | null } = {}): RealtimeToolCallItem {
  return {
    itemId: 'fc_1',
    type: 'function_call',
    status: output === null ? 'in_progress' : 'completed',
    arguments: '{"city":"Paris"}',
    name: 'get_weather',
    output,
  };
}

function message(itemId: string, text: string): RealtimeItem {
  return {
    itemId,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [{ type: 'input_text', text }],
  };
}

function receive(base: TestBase, payload: Record<string, unknown>) {
  (base as any)._onMessage({ data: JSON.stringify(payload) });
}

function echoFunctionCall(
  base: TestBase,
  type:
    | 'conversation.item.added'
    | 'conversation.item.done' = 'conversation.item.added',
) {
  receive(base, {
    type,
    event_id: 'evt_call',
    previous_item_id: 'previous',
    item: {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'fc_1',
      name: 'get_weather',
      arguments: '{"city":"Paris"}',
      status: 'completed',
    },
  });
}

function echoFunctionCallOutput(base: TestBase) {
  receive(base, {
    type: 'conversation.item.done',
    event_id: 'evt_output',
    previous_item_id: 'previous',
    item: {
      type: 'function_call_output',
      id: 'fco_1',
      call_id: 'fc_1',
      output: '{"temp":21}',
      status: 'completed',
    },
  });
}

function echoDeleted(base: TestBase, itemId: string) {
  receive(base, {
    type: 'conversation.item.deleted',
    event_id: `evt_delete_${itemId}`,
    item_id: itemId,
  });
}

function echoClientEventError(base: TestBase, clientEventId: string) {
  base.on('error', () => {});
  receive(base, {
    type: 'error',
    event_id: `server_error_${clientEventId}`,
    error: {
      type: 'invalid_request_error',
      message: 'rejected client event',
      event_id: clientEventId,
    },
  });
}

describe('Realtime function call history replay', () => {
  it('adds a function call item to conversation history', () => {
    const base = new TestBase();
    base.resetHistory([], [functionCall()]);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.create',
        event_id: expect.any(String),
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'fc_1',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
          status: 'in_progress',
        },
      },
    ]);
  });

  it('restores the recorded output with the same synthetic call ID', () => {
    const base = new TestBase();
    base.resetHistory([], [functionCall({ output: '{"temp":21}' })]);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.create',
        event_id: expect.any(String),
        item: {
          type: 'function_call',
          id: 'fc_1',
          call_id: 'fc_1',
          name: 'get_weather',
          arguments: '{"city":"Paris"}',
          status: 'completed',
        },
      },
      {
        type: 'conversation.item.create',
        event_id: expect.any(String),
        item: {
          type: 'function_call_output',
          call_id: 'fc_1',
          output: '{"temp":21}',
        },
      },
    ]);
  });

  it('rejects an in-place function call edit before sending mutations', () => {
    const base = new TestBase();
    const oldCall = functionCall();
    const editedCall = { ...oldCall, arguments: '{"city":"London"}' };
    expect(() => base.resetHistory([oldCall], [editedCall])).toThrowError(
      UserError,
    );
    expect(base.events).toEqual([]);
  });

  it('rejects a cross-type replacement before unrelated removals are sent', () => {
    const base = new TestBase();
    const oldMessage = message('msg_old', 'old');
    const call = functionCall({ output: '{"temp":21}' });
    const replacement = message('fc_1', 'replacement');
    expect(() =>
      base.resetHistory([oldMessage, call], [replacement]),
    ).toThrowError(UserError);
    expect(base.events).toEqual([]);
  });

  it('rejects mid-history function call insertion before sending mutations', () => {
    const base = new TestBase();
    const first = message('msg_1', 'first');
    const second = message('msg_2', 'second');
    expect(() =>
      base.resetHistory([first, second], [first, functionCall(), second]),
    ).toThrowError(/only be replayed as appended history/);
    expect(base.events).toEqual([]);
  });

  it('rejects function call replay after an updated item before mutations', () => {
    const base = new TestBase();
    const oldMessage = message('msg_1', 'old');
    const editedMessage = message('msg_1', 'edited');
    expect(() =>
      base.resetHistory([oldMessage], [editedMessage, functionCall()]),
    ).toThrowError(/cannot follow an updated history item/);
    expect(base.events).toEqual([]);
  });

  it('rejects repeated replay while acknowledgement is pending', () => {
    const base = new TestBase();
    const call = functionCall();
    base.resetHistory([], [call]);
    base.events = [];
    expect(() => base.resetHistory([], [call])).toThrowError(
      /acknowledgement-pending replay/,
    );
    expect(base.events).toEqual([]);
  });

  it('projects echoed replayed calls and outputs into item updates', () => {
    const base = new TestBase();
    const updates: RealtimeToolCallItem[] = [];
    base.on('item_update', (item) => {
      if (item.type === 'function_call') updates.push(item);
    });
    base.resetHistory([], [functionCall({ output: '{"temp":21}' })]);
    echoFunctionCall(base);
    echoFunctionCallOutput(base);
    expect(updates).toEqual([
      {
        itemId: 'fc_1',
        previousItemId: 'previous',
        type: 'function_call',
        status: 'in_progress',
        arguments: '{"city":"Paris"}',
        name: 'get_weather',
        output: null,
      },
      {
        itemId: 'fc_1',
        previousItemId: 'previous',
        type: 'function_call',
        status: 'completed',
        arguments: '{"city":"Paris"}',
        name: 'get_weather',
        output: '{"temp":21}',
      },
    ]);
  });

  it('clears replay ownership before exposing a new connection', () => {
    const base = new TestBase();
    const call = functionCall();
    base.resetHistory([], [call]);
    base.open();
    base.events = [];
    expect(() => base.resetHistory([], [call])).not.toThrow();
    expect(base.events).toHaveLength(1);
  });

  it('clears replay ownership when the transport closes', () => {
    const base = new TestBase();
    const call = functionCall();
    base.resetHistory([], [call]);
    base.closeTransport();
    base.events = [];
    expect(() => base.resetHistory([], [call])).not.toThrow();
    expect(base.events).toHaveLength(1);
  });

  it('cleans replay ownership after a synchronous send failure', () => {
    const base = new TestBase();
    const call = functionCall();
    base.failNextSend = true;
    expect(() => base.resetHistory([], [call])).toThrowError(
      'synchronous send failure',
    );
    expect(base.events).toEqual([]);
    expect(() => base.resetHistory([], [call])).not.toThrow();
    expect(base.events).toHaveLength(1);
  });

  it('waits for output deletion acknowledgement before deleting its call', () => {
    const base = new TestBase();
    const call = functionCall({ output: '{"temp":21}' });
    base.resetHistory([], [call]);
    echoFunctionCall(base);
    echoFunctionCallOutput(base);
    base.events = [];

    base.resetHistory([call], []);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fco_1',
      },
    ]);

    echoDeleted(base, 'fco_1');
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fco_1',
      },
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fc_1',
      },
    ]);
    echoDeleted(base, 'fc_1');
  });

  it('advances deletion state before exposing deletion acknowledgements', () => {
    const base = new TestBase();
    const call = functionCall({ output: '{"temp":21}' });
    base.resetHistory([], [call]);
    echoFunctionCall(base);
    echoFunctionCallOutput(base);
    base.events = [];
    base.resetHistory([call], []);

    let retryError: unknown;
    base.on('item_deleted', ({ itemId }) => {
      if (itemId !== 'fco_1') return;
      try {
        base.resetHistory([call], []);
      } catch (error) {
        retryError = error;
      }
    });

    echoDeleted(base, 'fco_1');
    expect(retryError).toBeUndefined();
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fco_1',
      },
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fc_1',
      },
    ]);

    let replayError: unknown;
    base.on('item_deleted', ({ itemId }) => {
      if (itemId !== 'fc_1') return;
      try {
        base.resetHistory([], [functionCall()]);
      } catch (error) {
        replayError = error;
      }
    });

    echoDeleted(base, 'fc_1');
    expect(replayError).toBeUndefined();
    expect(base.events.at(-1)).toEqual({
      type: 'conversation.item.create',
      event_id: expect.any(String),
      item: {
        type: 'function_call',
        id: 'fc_1',
        call_id: 'fc_1',
        name: 'get_weather',
        arguments: '{"city":"Paris"}',
        status: 'in_progress',
      },
    });
  });

  it('rejects repeated removal while deletion is awaiting acknowledgement', () => {
    const base = new TestBase();
    const call = functionCall({ output: '{"temp":21}' });
    base.resetHistory([], [call]);
    echoFunctionCall(base);
    echoFunctionCallOutput(base);
    base.events = [];
    base.resetHistory([call], []);
    base.events = [];
    expect(() => base.resetHistory([call], [])).toThrowError(
      /deletion awaiting Realtime API acknowledgement/,
    );
    expect(base.events).toEqual([]);
  });

  it('rejects completed-call removal before output acknowledgement', () => {
    const base = new TestBase();
    const call = functionCall({ output: '{"temp":21}' });
    base.resetHistory([], [call]);
    echoFunctionCall(base);
    base.events = [];
    expect(() => base.resetHistory([call], [])).toThrowError(
      /before its output item is acknowledged/,
    );
    expect(base.events).toEqual([]);
  });

  it('preserves history restored synchronously from the connected notification', () => {
    const base = new TestBase();
    const call = functionCall();
    base.resetHistory([], [call]);
    base.closeTransport();
    base.events = [];

    base.on('connection_change', (status) => {
      if (status === 'connected') {
        base.resetHistory([], [call]);
      }
    });
    base.announceConnected();

    expect(base.events).toHaveLength(1);
    base.events = [];
    expect(() => base.resetHistory([], [call])).toThrowError(
      /acknowledgement-pending replay/,
    );
    expect(base.events).toEqual([]);
  });

  it('retains ownership when a completed replay partially sends', () => {
    const base = new TestBase();
    const call = functionCall({ output: '{"temp":21}' });
    base.failOnSendAttempt = 2;

    expect(() => base.resetHistory([], [call])).toThrowError(
      'synchronous send failure',
    );
    expect(base.events).toEqual([
      expect.objectContaining({
        type: 'conversation.item.create',
        item: expect.objectContaining({ type: 'function_call', id: 'fc_1' }),
      }),
    ]);

    base.events = [];
    expect(() => base.resetHistory([], [call])).toThrowError(
      /acknowledgement-pending replay/,
    );
    expect(base.events).toEqual([]);
  });

  it('retains in-progress replay correlation through a later public output', () => {
    const base = new TestBase();
    const pendingCall = functionCall();
    const completedCall = functionCall({ output: '{"temp":21}' });
    base.resetHistory([], [pendingCall]);
    echoFunctionCall(base, 'conversation.item.done');
    base.events = [];

    base.sendFunctionCallOutput(
      {
        id: 'fc_1',
        type: 'function_call',
        name: 'get_weather',
        callId: 'fc_1',
        arguments: '{"city":"Paris"}',
        responseId: 'response_1',
      },
      '{"temp":21}',
      false,
    );
    base.events = [];

    expect(() => base.resetHistory([completedCall], [])).toThrowError(
      /before its output item is acknowledged/,
    );
    echoFunctionCallOutput(base);
    base.events = [];

    base.resetHistory([completedCall], []);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fco_1',
      },
    ]);
  });

  it('correlates asynchronous rejection of a public replay output', () => {
    const base = new TestBase();
    const pendingCall = functionCall();
    const completedCall = functionCall({ output: '{"temp":21}' });
    const updates: RealtimeToolCallItem[] = [];
    base.on('item_update', (item) => {
      if (item.type === 'function_call') updates.push(item);
    });
    base.resetHistory([], [pendingCall]);
    echoFunctionCall(base, 'conversation.item.done');
    updates.length = 0;
    base.events = [];

    base.sendFunctionCallOutput(
      {
        id: 'fc_1',
        type: 'function_call',
        name: 'get_weather',
        callId: 'fc_1',
        arguments: '{"city":"Paris"}',
        responseId: 'response_1',
      },
      '{"temp":21}',
      false,
    );
    const outputEventId = base.events[0].event_id;
    expect(outputEventId).toEqual(expect.any(String));
    expect(updates.at(-1)).toMatchObject({
      itemId: 'fc_1',
      status: 'completed',
      output: '{"temp":21}',
    });

    echoClientEventError(base, outputEventId);
    expect(updates.at(-1)).toMatchObject({
      itemId: 'fc_1',
      status: 'in_progress',
      output: null,
    });
    base.events = [];

    expect(() => base.resetHistory([completedCall], [])).not.toThrow();
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fc_1',
      },
    ]);
  });

  it('retains deletion ownership across synchronous send failures', () => {
    const base = new TestBase();
    const call = functionCall({ output: '{"temp":21}' });
    base.resetHistory([], [call]);
    echoFunctionCall(base);
    echoFunctionCallOutput(base);
    base.events = [];

    base.failNextSend = true;
    expect(() => base.resetHistory([call], [])).toThrowError(
      'synchronous send failure',
    );
    expect(base.events).toEqual([]);

    base.resetHistory([call], []);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fco_1',
      },
    ]);

    base.failNextSend = true;
    expect(() => echoDeleted(base, 'fco_1')).toThrowError(
      'synchronous send failure',
    );
    base.events = [];

    base.resetHistory([call], []);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fc_1',
      },
    ]);
  });

  it('releases replay ownership after an asynchronous call-create rejection', () => {
    const base = new TestBase();
    const call = functionCall();
    base.resetHistory([], [call]);
    const failedEventId = base.events[0].event_id;
    expect(failedEventId).toEqual(expect.any(String));

    echoClientEventError(base, failedEventId);
    base.events = [];

    expect(() => base.resetHistory([], [call])).not.toThrow();
    expect(base.events).toHaveLength(1);
    expect(base.events[0].event_id).not.toBe(failedEventId);
  });

  it('transitions a rejected replay output so the acknowledged call can be removed', () => {
    const base = new TestBase();
    const call = functionCall({ output: '{"temp":21}' });
    base.resetHistory([], [call]);
    const outputEventId = base.events[1].event_id;
    expect(outputEventId).toEqual(expect.any(String));

    echoClientEventError(base, outputEventId);
    echoFunctionCall(base);
    base.events = [];

    const projectedCall = functionCall();
    base.resetHistory([projectedCall], []);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fc_1',
      },
    ]);
  });

  it('retries tracked deletions after asynchronous provider rejection', () => {
    const base = new TestBase();
    const call = functionCall({ output: '{"temp":21}' });
    base.resetHistory([], [call]);
    echoFunctionCall(base);
    echoFunctionCallOutput(base);
    base.events = [];

    base.resetHistory([call], []);
    const outputDeleteEventId = base.events[0].event_id;
    expect(outputDeleteEventId).toEqual(expect.any(String));
    echoClientEventError(base, outputDeleteEventId);
    base.events = [];

    base.resetHistory([call], []);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fco_1',
      },
    ]);

    echoDeleted(base, 'fco_1');
    const callDeleteEventId = base.events.at(-1)?.event_id;
    expect(callDeleteEventId).toEqual(expect.any(String));
    echoClientEventError(base, callDeleteEventId);
    base.events = [];

    base.resetHistory([call], []);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fc_1',
      },
    ]);
  });
});
