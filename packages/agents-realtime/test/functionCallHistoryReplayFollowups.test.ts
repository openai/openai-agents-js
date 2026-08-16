import { UserError } from '@openai/agents-core';
import { describe, expect, it, vi } from 'vitest';

import type { RealtimeClientMessage } from '../src/clientMessages';
import type { RealtimeItem, RealtimeToolCallItem } from '../src/items';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';

class TestBase extends OpenAIRealtimeBase {
  status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
    'connected';
  events: RealtimeClientMessage[] = [];
  connect = vi.fn(async () => {});
  sendEvent(event: RealtimeClientMessage) {
    this.events.push(event);
  }
  mute = vi.fn();
  close = vi.fn();
  interrupt = vi.fn();
  get muted() {
    return false;
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

function echoFunctionCall(base: TestBase) {
  receive(base, {
    type: 'conversation.item.done',
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

const toolCall = {
  id: 'fc_1',
  type: 'function_call' as const,
  name: 'get_weather',
  callId: 'fc_1',
  arguments: '{"city":"Paris"}',
  responseId: 'response_1',
};

describe('Realtime function call history replay follow-up invariants', () => {
  it('rejects another output after acknowledgement and preserves output deletion ownership', () => {
    const base = new TestBase();
    const pendingCall = functionCall();
    const completedCall = functionCall({ output: '{"temp":21}' });

    base.resetHistory([], [pendingCall]);
    echoFunctionCall(base);
    base.events = [];

    base.sendFunctionCallOutput(toolCall, '{"temp":21}', false);
    echoFunctionCallOutput(base);
    base.events = [];

    expect(() =>
      base.sendFunctionCallOutput(toolCall, '{"temp":22}', false),
    ).toThrowError(UserError);
    expect(base.events).toEqual([]);

    base.resetHistory([completedCall], []);
    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        event_id: expect.any(String),
        item_id: 'fco_1',
      },
    ]);
  });

  it('recreates mixed replay changes in target history order', () => {
    const base = new TestBase();
    const oldMessage = message('msg_1', 'old');
    const editedMessage = message('msg_1', 'edited');
    const newMessage = message('msg_2', 'new');

    base.resetHistory(
      [oldMessage],
      [functionCall(), editedMessage, newMessage],
    );

    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        item_id: 'msg_1',
      },
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
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'edited' }],
          id: 'msg_1',
          status: 'completed',
        },
      },
      {
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'new' }],
          id: 'msg_2',
          status: 'completed',
        },
      },
    ]);
  });
});
