import { describe, it, expect } from 'vitest';
import { parseRealtimeEvent } from '../src/openaiRealtimeEvents';

function createEvent(payload: any): MessageEvent {
  return new MessageEvent('message', { data: JSON.stringify(payload) });
}

describe('parseRealtimeEvent', () => {
  it('parses known conversation.item.created event', () => {
    const payload = {
      type: 'conversation.item.added',
      event_id: 'evt_1',
      item: {},
      previous_item_id: 'evt_prev',
    };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.isGeneric).toBe(false);
    expect(result.data).toEqual(payload);
  });

  it('returns generic result for unknown event type', () => {
    const payload = { type: 'unknown.event', event_id: 'evt_x', foo: 'bar' };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.isGeneric).toBe(true);
    expect(result.data).toEqual(payload);
  });

  it('preserves fields for unknown events', () => {
    const payload = {
      type: 'some.new.event',
      foo: 'bar',
      nested: { a: 1 },
    };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.isGeneric).toBe(true);
    expect(result.data).toEqual(payload);
  });

  it('parses event with extra fields', () => {
    const payload = {
      type: 'conversation.item.added',
      event_id: 'evt_2',
      item: { extra: 'field' },
      previous_item_id: 'evt_prev2',
      another: 123,
    };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.isGeneric).toBe(false);
    expect(result.data).toMatchObject({
      type: 'conversation.item.added',
      event_id: 'evt_2',
      item: {},
      previous_item_id: 'evt_prev2',
    });
  });

  it('returns null data for invalid payload', () => {
    const result = parseRealtimeEvent(createEvent({ notype: true }));
    expect(result.isGeneric).toBe(true);
    expect(result.data).toBeNull();
  });

  it('parses input_audio_transcription.completed with tokens usage', () => {
    const payload = {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'evt_t1',
      item_id: 'item_1',
      content_index: 0,
      transcript: 'hello',
      usage: {
        type: 'tokens',
        total_tokens: 12,
        input_tokens: 8,
        input_token_details: { text_tokens: 3, audio_tokens: 5 },
        output_tokens: 4,
      },
    };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.isGeneric).toBe(false);
    expect(result.data).toEqual(payload);
  });

  it('parses input_audio_transcription.completed with duration usage', () => {
    const payload = {
      type: 'conversation.item.input_audio_transcription.completed',
      event_id: 'evt_t2',
      item_id: 'item_2',
      content_index: 0,
      transcript: 'hello',
      usage: { type: 'duration', seconds: 2 },
    };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.isGeneric).toBe(false);
    expect(result.data).toEqual(payload);
  });
});
