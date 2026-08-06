import { describe, expect, it, vi } from 'vitest';
import { ResponseCreateSequencer } from '../src/responseCreateSequencer';

const responseCreateEvent = (eventId?: string) =>
  ({
    type: 'response.create',
    ...(eventId ? { event_id: eventId } : {}),
  }) as const;

describe('ResponseCreateSequencer', () => {
  it('tracks generated event IDs and response cancellation state', () => {
    const sendEventNow = vi.fn();
    const sequencer = new ResponseCreateSequencer(sendEventNow);

    expect(sequencer.ongoingResponse).toBe(false);
    expect(sequencer.responseControl).toBe('free');
    expect(sequencer.pendingResponseCreateEventId).toBeNull();
    expect(sequencer.beginCancelResponse()).toBe(false);

    sequencer.requestResponseCreate(responseCreateEvent());

    expect(sendEventNow).toHaveBeenCalledWith({
      type: 'response.create',
      event_id: 'agents_js_response_create_1',
    });
    expect(sequencer.responseControl).toBe('create_requested');
    expect(sequencer.pendingResponseCreateEventId).toBe(
      'agents_js_response_create_1',
    );

    sequencer.markResponseCreated();
    expect(sequencer.ongoingResponse).toBe(true);
    expect(sequencer.responseControl).toBe('free');
    expect(sequencer.pendingResponseCreateEventId).toBeNull();
    expect(sequencer.beginCancelResponse()).toBe(true);
    expect(sequencer.beginCancelResponse()).toBe(false);
    expect(sequencer.responseControl).toBe('cancel_requested');

    sequencer.markResponseDone();
    expect(sequencer.ongoingResponse).toBe(false);
    expect(sequencer.responseControl).toBe('free');
  });

  it('reports synchronous send errors and releases the pending request', () => {
    const error = new Error('send failed');
    const onError = vi.fn();
    const sequencer = new ResponseCreateSequencer(() => {
      throw error;
    }, onError);

    sequencer.requestResponseCreate(responseCreateEvent('event_1'), {
      manual: true,
    });

    expect(onError).toHaveBeenCalledWith(error);
    expect(sequencer.responseControl).toBe('free');
    expect(sequencer.pendingResponseCreateEventId).toBeNull();
  });

  it('only clears a linked failure for the matching request', () => {
    const sendEventNow = vi.fn();
    const sequencer = new ResponseCreateSequencer(sendEventNow);
    sequencer.requestResponseCreate(responseCreateEvent('event_1'));

    expect(
      sequencer.handleResponseCreateError({
        error: { event_id: 'event_2' },
      }),
    ).toBe(false);
    expect(sequencer.pendingResponseCreateEventId).toBe('event_1');

    expect(
      sequencer.handleResponseCreateError({
        error: { event_id: 'event_1' },
      }),
    ).toBe(true);
    expect(sequencer.pendingResponseCreateEventId).toBeNull();
  });

  it.each([
    [{ code: 'response_create_failed' }],
    [{ message: 'The response.create request failed.' }],
  ])('clears an unlinked response.create failure %#', (error) => {
    const sequencer = new ResponseCreateSequencer(vi.fn());
    sequencer.requestResponseCreate(responseCreateEvent('event_1'));

    expect(sequencer.handleResponseCreateError({ error })).toBe(true);
    expect(sequencer.pendingResponseCreateEventId).toBeNull();
  });

  it('ignores unrelated errors and releases queued work on shutdown', async () => {
    const sendEventNow = vi.fn();
    const sequencer = new ResponseCreateSequencer(sendEventNow);
    sequencer.requestResponseCreate(responseCreateEvent('event_1'));
    sequencer.markResponseCreated();
    sequencer.requestResponseCreate(responseCreateEvent('event_2'));

    expect(
      sequencer.handleResponseCreateError({
        error: { code: 123, message: null },
      }),
    ).toBe(false);

    sequencer.releaseWaiters();
    await Promise.resolve();

    expect(sendEventNow).toHaveBeenCalledTimes(1);
    expect(sequencer.ongoingResponse).toBe(false);
    expect(sequencer.responseControl).toBe('free');
    expect(sequencer.pendingResponseCreateEventId).toBeNull();
  });
});
