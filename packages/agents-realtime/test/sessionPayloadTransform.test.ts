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
}

describe('Realtime session payload transform', () => {
  it('rewrites SDK-managed session updates', () => {
    const base = new TestBase({
      transformSessionPayload: (payload) => {
        const { type: _type, output_modalities: _modalities, audio, ...rest } =
          payload;
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
});
