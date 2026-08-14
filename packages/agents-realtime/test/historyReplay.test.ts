import { UserError } from '@openai/agents-core';
import { describe, expect, it, vi } from 'vitest';

import type { RealtimeClientMessage } from '../src/clientMessages';
import type { RealtimeMessageItem } from '../src/items';
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
});
