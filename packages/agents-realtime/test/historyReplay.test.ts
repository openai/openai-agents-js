import { UserError } from '@openai/agents-core';
import { describe, expect, it, vi } from 'vitest';

import type { RealtimeClientMessage } from '../src/clientMessages';
import type { RealtimeMcpCallItem, RealtimeMessageItem } from '../src/items';
import logger from '../src/logger';
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

function mcpCall(itemId: string, output: string): RealtimeMcpCallItem {
  return {
    itemId,
    type: 'mcp_call',
    status: 'completed',
    arguments: '{}',
    name: 'some_tool',
    output,
  };
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

  it('warns that the item was removed for an updated mcp_call item', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const base = new TestBase();
      const oldHistory = [mcpCall('mcp-1', 'old')];
      const newHistory = [mcpCall('mcp-1', 'new')];

      base.resetHistory(oldHistory, newHistory);

      const deleteEvents = base.events.filter(
        (event) => event.type === 'conversation.item.delete',
      );
      expect(deleteEvents).toEqual([
        {
          type: 'conversation.item.delete',
          item_id: 'mcp-1',
        },
      ]);
      expect(
        base.events.filter(
          (event) => event.type === 'conversation.item.create',
        ),
      ).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('MCP items cannot be manually updated'),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('cannot be manually added'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });

  it('warns without claiming removal for a newly added mcp_call item', () => {
    const warnSpy = vi.spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const base = new TestBase();
      const oldHistory: RealtimeMcpCallItem[] = [];
      const newHistory = [mcpCall('mcp-1', 'new')];

      base.resetHistory(oldHistory, newHistory);

      const deleteEvents = base.events.filter(
        (event) => event.type === 'conversation.item.delete',
      );
      expect(deleteEvents).toEqual([]);
      expect(
        base.events.filter(
          (event) => event.type === 'conversation.item.create',
        ),
      ).toEqual([]);
      expect(warnSpy).toHaveBeenCalledWith(
        expect.stringContaining('MCP items cannot be manually added'),
      );
      expect(warnSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('was removed'),
      );
    } finally {
      warnSpy.mockRestore();
    }
  });
});
