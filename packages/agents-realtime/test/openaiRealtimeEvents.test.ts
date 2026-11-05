import { describe, it, expect, expectTypeOf } from 'vitest';
import {
  parseRealtimeEvent,
  type RealtimeServerEvent,
} from '../src/openaiRealtimeEvents';

function createEvent(payload: any): MessageEvent {
  return new MessageEvent('message', { data: JSON.stringify(payload) });
}

function createRawEvent(data: any): MessageEvent {
  return new MessageEvent('message', { data });
}

describe('parseRealtimeEvent', () => {
  it('keeps SDK wire names separate from local action channels', () => {
    expectTypeOf<
      Exclude<RealtimeServerEvent['type'], 'error' | `${string}.${string}`>
    >().toEqualTypeOf<never>();
  });

  it('parses known conversation.item.added event', () => {
    const payload = {
      type: 'conversation.item.added',
      event_id: 'evt_1',
      item: {},
      previous_item_id: 'evt_prev',
    };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.data).toEqual(payload);
    expect(result.raw).toEqual(payload);
  });

  it('preserves unknown event types', () => {
    const payload = { type: 'unknown.event', event_id: 'evt_x', foo: 'bar' };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.data).toEqual(payload);
    expect(result.raw).toEqual(payload);
  });

  it('preserves fields for unknown events', () => {
    const payload = {
      type: 'some.new.event',
      foo: 'bar',
      nested: { a: 1 },
    };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.data).toEqual(payload);
    expect(result.raw).toEqual(payload);
  });

  it('preserves extra fields in the raw value for known events', () => {
    const payload = {
      type: 'conversation.item.added',
      event_id: 'evt_2',
      item: {
        type: 'message',
        content: [
          {
            type: 'input_text',
            text: 'hello',
            provider_nested: { value: true },
          },
        ],
      },
      previous_item_id: 'evt_prev2',
      provider_top_level: 123,
    };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.raw).toEqual(payload);
    expect(result.data).toEqual(payload);
  });

  it.each(['toString', '__proto__', 'constructor'])(
    'preserves unknown event %s without inherited handlers',
    (type) => {
      const payload = { type, extra: true };
      expect(parseRealtimeEvent(createEvent(payload)).data).toEqual(payload);
    },
  );

  it.each([
    { type: 'response.created', response: null },
    { type: 'conversation.item.done', item: [] },
    {
      type: 'response.output_text.delta',
      delta: 123,
      item_id: 'i',
      response_id: 'r',
    },
  ])(
    'retains malformed handler inputs only as raw events: $type',
    (payload) => {
      expect(parseRealtimeEvent(createEvent(payload))).toEqual({
        raw: payload,
        data: null,
      });
    },
  );

  it('returns null data for invalid payload', () => {
    const result = parseRealtimeEvent(createEvent({ notype: true }));
    expect(result.data).toBeNull();
    expect(result.raw).toBeNull();
  });

  it('returns null data for malformed JSON', () => {
    const result = parseRealtimeEvent(createRawEvent('{'));
    expect(result.data).toBeNull();
    expect(result.raw).toBeNull();
  });

  it('returns null data for binary non-JSON frames', () => {
    const result = parseRealtimeEvent(
      createRawEvent(new Uint8Array([0, 1, 2])),
    );
    expect(result.data).toBeNull();
    expect(result.raw).toBeNull();
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

    expect(result.data).toEqual(payload);
  });
});
