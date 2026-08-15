import { describe, expect, it, vi } from 'vitest';

import type { RealtimeClientMessage } from '../src/clientMessages';
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

    expect(base.events).toEqual([
      {
        type: 'session.update',
        session: { tracing: 'auto' },
      },
    ]);
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

    expect(
      base.rawSessionConfig?.audio?.input?.turn_detection?.interrupt_response,
    ).toBe(true);
    expect(base.rawSessionConfig?.tracing).toBe('auto');
  });
});
