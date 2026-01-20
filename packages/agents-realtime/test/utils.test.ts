import { describe, it, expect } from 'vitest';
import {
  base64ToArrayBuffer,
  arrayBufferToBase64,
  getLastTextFromAudioOutputMessage,
  diffRealtimeHistory,
  updateRealtimeHistory,
  hasWebRTCSupport,
  removeAudioFromContent,
  realtimeApprovalItemToApprovalItem,
  approvalItemToRealtimeApprovalItem,
} from '../src/utils';
import { RealtimeMessageItem } from '../src/items';
import { RunToolApprovalItem } from '@openai/agents-core';
import { RealtimeAgent } from '../src/realtimeAgent';
import type { InputAudioTranscriptionCompletedEvent } from '../src/transportLayerEvents';

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

  it('preserves assistant output_audio transcript when new item lacks it', () => {
    const transcript = 'previous text';
    const history: RealtimeMessageItem[] = [
      {
        itemId: '2',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_audio', transcript }],
      },
    ];

    const incoming: RealtimeMessageItem = {
      itemId: '2',
      type: 'message',
      role: 'assistant',
      status: 'incomplete',
      content: [{ type: 'output_audio' } as any],
    } as RealtimeMessageItem;

    const updated = updateRealtimeHistory(history, incoming, false);
    expect(updated).toHaveLength(1);
    const updatedMessage = updated[0] as RealtimeMessageItem;
    const content = (updatedMessage as RealtimeMessageItem).content[0] as any;
    expect(content.transcript).toBe(transcript);
    if (updatedMessage.role === 'assistant' || updatedMessage.role === 'user') {
      expect(updatedMessage.status).toBe('incomplete');
    } else {
      throw new Error('Expected assistant message to retain transcript');
    }
  });

  it('prefers new transcript value when provided', () => {
    const history: RealtimeMessageItem[] = [
      {
        itemId: '3',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_audio', transcript: 'old' }],
      },
    ];

    const incoming: RealtimeMessageItem = {
      itemId: '3',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_audio', transcript: 'new' }],
    } as RealtimeMessageItem;

    const updated = updateRealtimeHistory(history, incoming, false);
    const content = (updated[0] as RealtimeMessageItem).content[0] as any;
    expect(content.transcript).toBe('new');
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

  it('merges input audio transcripts into history items', () => {
    const history: RealtimeMessageItem[] = [
      {
        itemId: 'u1',
        type: 'message',
        role: 'user',
        status: 'in_progress',
        content: [{ type: 'input_audio', audio: 'data', transcript: null }],
      },
    ];

    const event: InputAudioTranscriptionCompletedEvent = {
      type: 'conversation.item.input_audio_transcription.completed',
      item_id: 'u1',
      transcript: 'transcribed',
    };

    const updated = updateRealtimeHistory(history, event, true);
    const updatedItem = updated[0] as RealtimeMessageItem;
    expect((updatedItem.content[0] as any).transcript).toBe('transcribed');
    if (updatedItem.role !== 'system') {
      expect(updatedItem.status).toBe('completed');
    } else {
      throw new Error('Expected non-system message');
    }
  });

  it('appends items when previousItemId is missing', () => {
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
      previousItemId: 'missing',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'later' }],
    };

    const updated = updateRealtimeHistory(history, newItem, true);
    expect(updated[1]?.itemId).toBe('2');
  });

  it('keeps audio data when shouldIncludeAudioData is true', () => {
    const history: RealtimeMessageItem[] = [
      {
        itemId: '1',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_audio', audio: 'keep', transcript: 'x' }],
      },
      {
        itemId: '2',
        type: 'message',
        role: 'assistant',
        status: 'completed',
        content: [{ type: 'output_text', text: 'hi' }],
      },
    ];

    const updatedItem: RealtimeMessageItem = {
      itemId: '2',
      type: 'message',
      role: 'assistant',
      status: 'completed',
      content: [{ type: 'output_text', text: 'updated' }],
    };

    const updated = updateRealtimeHistory(history, updatedItem, true);
    const audioEntry = (updated[0] as RealtimeMessageItem).content[0] as any;
    expect(audioEntry.audio).toBe('keep');
  });

  it('converts approval requests to RunToolApprovalItem and back', () => {
    const agent = new RealtimeAgent({ name: 'Agent', handoffs: [] });
    const request = {
      type: 'mcp_approval_request',
      itemId: 'item-1',
      serverLabel: 'server',
      name: 'tool',
      arguments: { foo: 'bar' },
      approved: null,
    } as const;

    const approval = realtimeApprovalItemToApprovalItem(agent, request);
    expect(approval).toBeInstanceOf(RunToolApprovalItem);
    expect(approval.rawItem).toMatchObject({
      type: 'hosted_tool_call',
      name: 'tool',
      arguments: JSON.stringify({ foo: 'bar' }),
      status: 'in_progress',
    });
    expect((approval.rawItem as any).providerData).toMatchObject({
      itemId: 'item-1',
      serverLabel: 'server',
      type: 'mcp_approval_request',
    });

    const roundTrip = approvalItemToRealtimeApprovalItem(approval);
    expect(roundTrip).toMatchObject({
      type: 'mcp_approval_request',
      itemId: 'item-1',
      serverLabel: 'server',
      name: 'tool',
      arguments: { foo: 'bar' },
      approved: null,
    });
  });

  it('throws when approval items are missing required metadata', () => {
    const agent = new RealtimeAgent({ name: 'Agent', handoffs: [] });
    const approval = new RunToolApprovalItem(
      {
        type: 'hosted_tool_call',
        name: 'tool',
        arguments: '{}',
        status: 'in_progress',
      } as any,
      agent,
    );

    expect(() => approvalItemToRealtimeApprovalItem(approval)).toThrow(
      'Invalid approval item',
    );
  });

  it('rejects unsupported approval item types', () => {
    const agent = new RealtimeAgent({ name: 'Agent', handoffs: [] });
    const approval = new RunToolApprovalItem(
      {
        type: 'shell_call',
        id: 's1',
        callId: 'c1',
        status: 'in_progress',
        input: '',
      } as any,
      agent,
    );

    expect(() => approvalItemToRealtimeApprovalItem(approval)).toThrow(
      'Invalid approval item type',
    );
  });
});
