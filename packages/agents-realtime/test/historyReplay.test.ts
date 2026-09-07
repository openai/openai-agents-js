import { UserError } from '@openai/agents-core';
import { describe, expect, it, vi } from 'vitest';

import type { RealtimeClientMessage } from '../src/clientMessages';
import type {
  RealtimeItem,
  RealtimeMcpCallApprovalRequestItem,
  RealtimeMcpCallItem,
  RealtimeMessageItem,
} from '../src/items';
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

function assistantAudio(
  itemId: string,
  transcript: string,
): RealtimeMessageItem {
  return {
    itemId,
    type: 'message',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_audio', transcript, audio: null }],
  };
}

function userText(itemId: string, text: string): RealtimeMessageItem {
  return {
    itemId,
    type: 'message',
    role: 'user',
    status: 'completed',
    content: [{ type: 'input_text', text }],
  };
}

function mcpCall(
  itemId: string,
  output: string,
  type: 'mcp_call' | 'mcp_tool_call' = 'mcp_call',
): RealtimeMcpCallItem {
  return {
    itemId,
    type,
    status: 'completed',
    arguments: '{}',
    name: 'some_tool',
    output,
  };
}

function mcpApprovalRequest(
  itemId: string,
  approved: boolean | null,
): RealtimeMcpCallApprovalRequestItem {
  return {
    itemId,
    type: 'mcp_approval_request',
    serverLabel: 'srv',
    name: 'some_tool',
    arguments: {},
    approved,
  };
}

function deleteEvents(events: RealtimeClientMessage[]) {
  return events.filter((event) => event.type === 'conversation.item.delete');
}

function createEvents(events: RealtimeClientMessage[]) {
  return events.filter((event) => event.type === 'conversation.item.create');
}

describe('OpenAI realtime history replay', () => {
  it('rejects assistant audio additions before sending history mutations', () => {
    const base = new TestBase();
    const oldHistory = [userText('old', 'hello')];
    const newHistory = [assistantAudio('audio', 'response')];
    let thrown: unknown;

    try {
      base.resetHistory(oldHistory, newHistory);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UserError);
    expect((thrown as Error).message).toContain(
      'Convert its transcript to output_text content or remove the item before calling updateHistory()',
    );
    expect(base.events).toEqual([]);
  });

  it('rejects assistant audio updates before sending history mutations', () => {
    const base = new TestBase();
    const oldHistory = [assistantAudio('audio', 'before')];
    const newHistory = [assistantAudio('audio', 'after')];

    expect(() => base.resetHistory(oldHistory, newHistory)).toThrowError(
      UserError,
    );
    expect(base.events).toEqual([]);
  });

  it('allows unchanged assistant audio while applying other supported changes', () => {
    const base = new TestBase();
    const audio = assistantAudio('audio', 'response');
    const oldHistory = [audio, userText('remove-me', 'old')];
    const newHistory = [audio];

    base.resetHistory(oldHistory, newHistory);

    expect(base.events).toEqual([
      {
        type: 'conversation.item.delete',
        item_id: 'remove-me',
      },
    ]);
  });

  it('adds a new message item without touching unrelated history', () => {
    const base = new TestBase();
    const oldHistory: RealtimeItem[] = [];
    const newHistory = [userText('new', 'hi there')];

    base.resetHistory(oldHistory, newHistory);

    expect(deleteEvents(base.events)).toEqual([]);
    expect(createEvents(base.events)).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          id: 'new',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'hi there' }],
          status: 'completed',
        },
      },
    ]);
  });

  it('updates a message item by deleting and recreating it', () => {
    const base = new TestBase();
    const oldHistory = [userText('msg-1', 'old text')];
    const newHistory = [userText('msg-1', 'new text')];

    base.resetHistory(oldHistory, newHistory);

    expect(deleteEvents(base.events)).toEqual([
      { type: 'conversation.item.delete', item_id: 'msg-1' },
    ]);
    expect(createEvents(base.events)).toEqual([
      {
        type: 'conversation.item.create',
        item: {
          id: 'msg-1',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'new text' }],
          status: 'completed',
        },
      },
    ]);
  });

  it('removes a message item that is absent from the new history', () => {
    const base = new TestBase();
    const oldHistory = [userText('msg-1', 'text')];
    const newHistory: RealtimeItem[] = [];

    base.resetHistory(oldHistory, newHistory);

    expect(deleteEvents(base.events)).toEqual([
      { type: 'conversation.item.delete', item_id: 'msg-1' },
    ]);
    expect(createEvents(base.events)).toEqual([]);
  });

  it('treats an unchanged MCP item as a no-op', () => {
    const base = new TestBase();
    const call = mcpCall('mcp-1', 'result');
    const oldHistory = [call];
    const newHistory = [call];

    expect(() => base.resetHistory(oldHistory, newHistory)).not.toThrow();
    expect(base.events).toEqual([]);
  });

  it('still emits a delete for an explicit MCP item removal', () => {
    const base = new TestBase();
    const oldHistory = [mcpCall('mcp-1', 'result')];
    const newHistory: RealtimeItem[] = [];

    base.resetHistory(oldHistory, newHistory);

    expect(base.events).toEqual([
      { type: 'conversation.item.delete', item_id: 'mcp-1' },
    ]);
  });

  describe.each([
    { type: 'mcp_call' as const, build: (id: string) => mcpCall(id, 'out') },
    {
      type: 'mcp_tool_call' as const,
      build: (id: string) => mcpCall(id, 'out', 'mcp_tool_call'),
    },
    {
      type: 'mcp_approval_request' as const,
      build: (id: string) => mcpApprovalRequest(id, null),
    },
  ])('$type items', ({ type, build }) => {
    it(`throws UserError and sends zero events when added`, () => {
      const base = new TestBase();
      const oldHistory: RealtimeItem[] = [];
      const newHistory = [build('mcp-1')];

      let thrown: unknown;
      try {
        base.resetHistory(oldHistory, newHistory);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UserError);
      expect((thrown as Error).message).toContain(type);
      expect(deleteEvents(base.events)).toEqual([]);
      expect(createEvents(base.events)).toEqual([]);
      expect(base.events).toEqual([]);
    });

    it(`throws UserError and sends zero events when updated`, () => {
      const base = new TestBase();
      const oldHistory = [build('mcp-1')];
      const updated = build('mcp-1');
      (updated as { output?: string | null }).output = 'changed';
      if (type === 'mcp_approval_request') {
        (updated as RealtimeMcpCallApprovalRequestItem).approved = true;
      }
      const newHistory = [updated];

      let thrown: unknown;
      try {
        base.resetHistory(oldHistory, newHistory);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UserError);
      expect((thrown as Error).message).toContain(type);
      expect(deleteEvents(base.events)).toEqual([]);
      expect(createEvents(base.events)).toEqual([]);
      expect(base.events).toEqual([]);
    });

    it(`throws UserError and sends zero events when replaced by a message with the same ID`, () => {
      const base = new TestBase();
      const oldHistory = [build('mcp-1')];
      const newHistory = [userText('mcp-1', 'same id, different type')];

      let thrown: unknown;
      try {
        base.resetHistory(oldHistory, newHistory);
      } catch (error) {
        thrown = error;
      }

      expect(thrown).toBeInstanceOf(UserError);
      expect((thrown as Error).message).toContain(type);
      expect(deleteEvents(base.events)).toEqual([]);
      expect(createEvents(base.events)).toEqual([]);
      expect(base.events).toEqual([]);
    });
  });
});
