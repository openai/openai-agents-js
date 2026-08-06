import { describe, it, expect } from 'vitest';
import { parseRealtimeEvent } from '../src/openaiRealtimeEvents';

function createEvent(payload: any): MessageEvent {
  return new MessageEvent('message', { data: JSON.stringify(payload) });
}

function createRawEvent(data: any): MessageEvent {
  return new MessageEvent('message', { data });
}

describe('parseRealtimeEvent', () => {
  it('parses known conversation.item.added event', () => {
    const payload = {
      type: 'conversation.item.added',
      event_id: 'evt_1',
      item: {},
      previous_item_id: 'evt_prev',
    };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.isGeneric).toBe(false);
    expect(result.data).toEqual(payload);
    expect(result.raw).toEqual(payload);
  });

  it('returns generic result for unknown event type', () => {
    const payload = { type: 'unknown.event', event_id: 'evt_x', foo: 'bar' };
    const result = parseRealtimeEvent(createEvent(payload));

    expect(result.isGeneric).toBe(true);
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

    expect(result.isGeneric).toBe(true);
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

    expect(result.isGeneric).toBe(false);
    expect(result.raw).toEqual(payload);
    expect(result.data).toEqual({
      type: 'conversation.item.added',
      event_id: 'evt_2',
      item: {
        type: 'message',
        content: [{ type: 'input_text', text: 'hello' }],
      },
      previous_item_id: 'evt_prev2',
    });
  });

  it('returns null data for invalid payload', () => {
    const result = parseRealtimeEvent(createEvent({ notype: true }));
    expect(result.isGeneric).toBe(true);
    expect(result.data).toBeNull();
    expect(result.raw).toBeNull();
  });

  it('returns null data for malformed JSON', () => {
    const result = parseRealtimeEvent(createRawEvent('{'));
    expect(result.isGeneric).toBe(true);
    expect(result.data).toBeNull();
    expect(result.raw).toBeNull();
  });

  it('returns null data for binary non-JSON frames', () => {
    const result = parseRealtimeEvent(
      createRawEvent(new Uint8Array([0, 1, 2])),
    );
    expect(result.isGeneric).toBe(true);
    expect(result.data).toBeNull();
    expect(result.raw).toBeNull();
  });
});
