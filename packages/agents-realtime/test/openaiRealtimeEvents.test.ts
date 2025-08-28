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
});
