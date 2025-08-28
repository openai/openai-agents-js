import { describe, it, expect } from 'vitest';
import {
  base64ToArrayBuffer,
  arrayBufferToBase64,
  getLastTextFromAudioOutputMessage,
  diffRealtimeHistory,
  updateRealtimeHistory,
  hasWebRTCSupport,
  removeAudioFromContent,
} from '../src/utils';
import { RealtimeMessageItem } from '../src/items';

describe('realtime utils', () => {
  it('converts ArrayBuffer to base64 and back', () => {
    const text = 'hello world';
    const buffer = new TextEncoder().encode(text).buffer;
    const base64 = arrayBufferToBase64(buffer);
    const result = base64ToArrayBuffer(base64);

    expect(new Uint8Array(result)).toEqual(new Uint8Array(buffer));
  });

  it('extracts transcript from audio output message', () => {
    const message: RealtimeMessageItem = {
      itemId: '1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_audio', transcript: 'hello there' }],
    };

    const text = getLastTextFromAudioOutputMessage(message);
    expect(text).toBe('hello there');
  });

  it('extracts text from text output message', () => {
    const message: RealtimeMessageItem = {
      itemId: '2',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'hi!' }],
    };

    const text = getLastTextFromAudioOutputMessage(message);
    expect(text).toBe('hi!');
  });

  it('returns undefined for invalid inputs', () => {
    expect(getLastTextFromAudioOutputMessage(null)).toBeUndefined();
    expect(getLastTextFromAudioOutputMessage(undefined)).toBeUndefined();
    expect(getLastTextFromAudioOutputMessage('hello')).toBeUndefined();
    expect(
      getLastTextFromAudioOutputMessage({ type: 'text', text: 'hi' }),
    ).toBeUndefined();
    expect(
      getLastTextFromAudioOutputMessage({
        type: 'output_audio',
        transcript: 'hello',
      }),
    ).toBeUndefined();
    expect(
      getLastTextFromAudioOutputMessage({
        type: 'output_audio',
        transcript: 123,
      }),
    ).toBeUndefined();
    expect(
      getLastTextFromAudioOutputMessage({
        type: 'output_audio',
        transcript: true,
      }),
    ).toBeUndefined();
    expect(
      getLastTextFromAudioOutputMessage({
        type: 'output_audio',
        transcript: {},
      }),
    ).toBeUndefined();
    expect(
      getLastTextFromAudioOutputMessage({ type: 'message', content: [] }),
    ).toBeUndefined();
    expect(
      getLastTextFromAudioOutputMessage({ type: 'message', content: [{}] }),
    ).toBeUndefined();
    expect(
      getLastTextFromAudioOutputMessage({
        type: 'message',
        content: [{ type: 'output_text', text: 123 } as any],
      }),
    ).toBeUndefined();
    expect(
      getLastTextFromAudioOutputMessage({
        type: 'message',
        content: [{ type: 'output_audio', transcript: 123 } as any],
      }),
    ).toBeUndefined();
  });

  it('diffRealtimeHistory detects additions, removals and updates', () => {
    const oldHist: RealtimeMessageItem[] = [
      {
        itemId: '1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'hi' }],
      },
      {
        itemId: '2',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'there' }],
      },
    ];

    const newHist: RealtimeMessageItem[] = [
      {
        itemId: '1',
        type: 'message',
        role: 'user',
        status: 'completed',
        content: [{ type: 'input_text', text: 'hello' }],
      },
      {
        itemId: '3',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'new' }],
      },
    ];

    const diff = diffRealtimeHistory(oldHist, newHist);
    expect(diff.removals.map((i) => i.itemId)).toEqual(['2']);
    expect(diff.additions.map((i) => i.itemId)).toEqual(['3']);
    expect(diff.updates.map((i) => i.itemId)).toEqual(['1']);
  });

  it('updateRealtimeHistory inserts and strips audio', () => {
    const history: RealtimeMessageItem[] = [
      {
        itemId: '1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hi' }],
      },
    ];

    const newItem: RealtimeMessageItem = {
      itemId: '2',
      previousItemId: '1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_audio', transcript: 'hello', audio: 'abc' }],
    };

    const result = updateRealtimeHistory(history, newItem, false);
    expect(result.length).toBe(2);
    expect((result[1] as any).content[0].audio).toBeNull();
  });

  it('removeAudioFromContent strips input and output audio', () => {
    const userItem: RealtimeMessageItem = {
      itemId: 'u1',
      type: 'message',
      role: 'user',
      status: 'completed',
      content: [{ type: 'input_audio', audio: 'data', transcript: 'hi' }],
    };
    const assistantItem: RealtimeMessageItem = {
      itemId: 'a1',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_audio', audio: 'out', transcript: 'bye' }],
    };
    expect(
      (removeAudioFromContent(userItem).content[0] as any).audio,
    ).toBeNull();
    expect(
      (removeAudioFromContent(assistantItem).content[0] as any).audio,
    ).toBeNull();
  });

  it('hasWebRTCSupport detects window availability', () => {
    const originalWindow = (global as any).window;
    expect(hasWebRTCSupport()).toBe(false);
    (global as any).window = { RTCPeerConnection: function () {} };
    expect(hasWebRTCSupport()).toBe(true);
    (global as any).window = originalWindow;
  });
});
