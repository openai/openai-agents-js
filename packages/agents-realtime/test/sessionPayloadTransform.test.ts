import { describe, expect, it, vi } from 'vitest';

import type { RealtimeClientMessage } from '../src/clientMessages';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';

class TestBase extends OpenAIRealtimeBase {
  status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
    'connected';
  events: RealtimeClientMessage[] = [];
  throwOnSend = false;
  connect = vi.fn(async () => {});
  sendEvent(event: RealtimeClientMessage) {
    const preparedEvent = this._prepareClientEventForSend(event);
    if (this.throwOnSend) {
      throw new Error('send failed');
    }
    this.events.push(preparedEvent);
    this._recordClientEventSent(preparedEvent);
  }
  mute = vi.fn();
  close = vi.fn();
  interrupt = vi.fn();
  get muted() {
    return false;
  }

  updateTracing(tracing: 'auto' | null) {
    this._updateTracingConfig(tracing);
  }

  get rawSessionConfig() {
    return this._rawSessionConfig;
  }

  receiveSessionUpdated(session: Record<string, unknown>) {
    this._onMessage({
      data: JSON.stringify({
        type: 'session.updated',
        event_id: 'evt_session_updated',
        session,
      }),
    } as MessageEvent);
  }

  receiveError(eventId: string) {
    this._onMessage({
      data: JSON.stringify({
        type: 'error',
        event_id: 'evt_error',
        error: { event_id: eventId, message: 'rejected' },
      }),
    } as MessageEvent);
  }
}

describe('Realtime session payload transform', () => {
  it('rewrites SDK-managed session updates', () => {
    const base = new TestBase({
      transformSessionPayload: (payload) => {
        const {
          type: _type,
          output_modalities: _modalities,
          audio,
          ...rest
        } = payload;
        return {
          ...rest,
          modalities: ['audio', 'text'],
          voice: audio?.output?.voice,
        };
      },
    });

    base.updateSessionConfig({ instructions: 'hi', voice: 'echo' });

    expect(base.events).toHaveLength(1);
    expect(base.events[0]?.session).toMatchObject({
      instructions: 'hi',
      model: 'gpt-realtime-2.1',
      modalities: ['audio', 'text'],
      voice: 'echo',
    });
    expect(base.events[0]?.session.type).toBeUndefined();
    expect(base.events[0]?.session.output_modalities).toBeUndefined();
    expect(base.events[0]?.session.audio).toBeUndefined();
  });

  it('does not let an in-place transform mutate canonical state', () => {
    const base = new TestBase({
      transformSessionPayload: (payload) => {
        const turnDetection = payload.audio?.input?.turn_detection;
        if (turnDetection) {
          delete turnDetection.interrupt_response;
        }
        return payload;
      },
    });

    base.updateSessionConfig({
      turnDetection: {
        type: 'server_vad',
        interruptResponse: true,
      },
    });

    expect(
      base.events[0]?.session.audio?.input?.turn_detection?.interrupt_response,
    ).toBeUndefined();
    expect(base.rawSessionConfig).toBeNull();

    base.receiveSessionUpdated({ provider_shape: true });
    expect(
      base.rawSessionConfig?.audio?.input?.turn_detection?.interrupt_response,
    ).toBe(true);
  });

  it('tracks direct session update acknowledgements after transformed updates', () => {
    const base = new TestBase({
      transformSessionPayload: ({ type: _type, ...rest }) => rest,
    });

    base.updateSessionConfig({ instructions: 'sdk managed' });
    base.receiveSessionUpdated({ instructions: 'provider acknowledgement' });

    expect(base.rawSessionConfig?.instructions).toBe('sdk managed');

    base.sendEvent({
      type: 'session.update',
      session: {
        audio: {
          input: {
            turn_detection: {
              type: 'server_vad',
              interrupt_response: false,
            },
          },
        },
      },
    });
    base.receiveSessionUpdated({
      audio: {
        input: {
          turn_detection: {
            type: 'server_vad',
            interrupt_response: false,
          },
        },
      },
    });

    expect(
      base.rawSessionConfig?.audio?.input?.turn_detection?.interrupt_response,
    ).toBe(false);
  });

  it('preserves acknowledgement order across raw and transformed updates', () => {
    const base = new TestBase({
      transformSessionPayload: ({ type: _type, ...rest }) => rest,
    });

    base.sendEvent({
      type: 'session.update',
      session: { instructions: 'raw update' },
    });
    base.updateSessionConfig({ instructions: 'sdk update' });

    base.receiveSessionUpdated({ instructions: 'raw update' });
    expect(base.rawSessionConfig?.instructions).toBe('raw update');

    base.receiveSessionUpdated({ instructions: 'provider-shaped sdk ack' });
    expect(base.rawSessionConfig?.instructions).toBe('sdk update');
  });

  it('does not change canonical state when transformation throws', () => {
    let shouldThrow = false;
    const base = new TestBase({
      transformSessionPayload: (payload) => {
        if (shouldThrow) {
          throw new Error('transform failed');
        }
        return payload;
      },
    });

    base.updateSessionConfig({ instructions: 'accepted' });
    base.receiveSessionUpdated({ instructions: 'accepted provider ack' });
    expect(base.rawSessionConfig?.instructions).toBe('accepted');

    shouldThrow = true;
    expect(() =>
      base.updateSessionConfig({ instructions: 'rejected' }),
    ).toThrow('transform failed');
    expect(base.rawSessionConfig?.instructions).toBe('accepted');
  });

  it('does not change canonical state or queue failed sends', () => {
    const base = new TestBase({
      transformSessionPayload: ({ type: _type, ...rest }) => rest,
    });

    base.updateSessionConfig({ instructions: 'accepted' });
    base.receiveSessionUpdated({ instructions: 'accepted provider ack' });

    base.throwOnSend = true;
    expect(() =>
      base.updateSessionConfig({ instructions: 'send failed' }),
    ).toThrow('send failed');
    base.throwOnSend = false;

    base.sendEvent({
      type: 'session.update',
      session: { instructions: 'raw after failure' },
    });
    base.receiveSessionUpdated({ instructions: 'raw after failure' });
    expect(base.rawSessionConfig?.instructions).toBe('raw after failure');
  });

  it('drops rejected transformed updates by client event id', () => {
    const base = new TestBase({
      transformSessionPayload: ({ type: _type, ...rest }) => rest,
    });

    base.updateSessionConfig({ instructions: 'will be rejected' });
    const rejectedEventId = base.events[0]?.event_id;
    expect(typeof rejectedEventId).toBe('string');
    base.receiveError(rejectedEventId as string);

    base.sendEvent({
      type: 'session.update',
      session: { instructions: 'raw accepted' },
    });
    base.receiveSessionUpdated({ instructions: 'raw accepted' });
    expect(base.rawSessionConfig?.instructions).toBe('raw accepted');
  });

  it('keeps buildSessionPayload canonical', () => {
    const base = new TestBase({
      transformSessionPayload: ({ type: _type, ...rest }) => rest,
    });

    const payload = base.buildSessionPayload({ instructions: 'hi' });

    expect(payload.type).toBe('realtime');
    expect(payload.output_modalities).toEqual(['audio']);
  });

  it('also rewrites tracing session updates', () => {
    const base = new TestBase({
      transformSessionPayload: ({ type: _type, ...rest }) => rest,
    });

    base.updateTracing('auto');

    expect(base.events).toHaveLength(1);
    expect(base.events[0]).toMatchObject({
      type: 'session.update',
      session: { tracing: 'auto' },
    });
    expect(base.events[0]?.event_id).toMatch(/^event_sdk_session_update_/);
  });

  it('preserves canonical turn detection state after transformed acknowledgements', () => {
    const base = new TestBase({
      transformSessionPayload: (payload) => {
        const { audio, ...rest } = payload;
        return {
          ...rest,
          turn_detection: audio?.input?.turn_detection,
        };
      },
    });

    base.updateSessionConfig({
      turnDetection: {
        type: 'server_vad',
        interruptResponse: true,
      },
    });
    base.receiveSessionUpdated({
      turn_detection: {
        type: 'server_vad',
        interrupt_response: true,
      },
    });
    base.updateTracing('auto');
    base.receiveSessionUpdated({ tracing: 'provider acknowledgement' });

    expect(
      base.rawSessionConfig?.audio?.input?.turn_detection?.interrupt_response,
    ).toBe(true);
    expect(base.rawSessionConfig?.tracing).toBe('auto');
  });
});
