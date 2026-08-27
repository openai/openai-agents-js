import { describe, expect, it } from 'vitest';
import { projectRealtimeEvent } from '../src/server/publicEventProjection';

describe('projectRealtimeEvent', () => {
  it.each([
    ['input_audio_buffer.speech_started', 'listening'],
    ['input_audio_buffer.speech_stopped', 'thinking'],
    ['response.created', 'thinking'],
    ['response.output_audio.delta', 'speaking'],
  ])('maps %s to an allowlisted state', (type, state) => {
    expect(
      projectRealtimeEvent({ type, delta: 'private-audio-payload' }),
    ).toEqual({ type: 'app.agent.state', state });
  });

  it('constructs a generic public error without provider details', () => {
    expect(
      projectRealtimeEvent({
        type: 'error',
        error: { message: 'private provider error', code: 'secret-code' },
      }),
    ).toEqual({ type: 'app.error', code: 'VOICE_SESSION_ERROR' });
  });

  it('does not forward raw session configuration or unknown events', () => {
    expect(
      projectRealtimeEvent({
        type: 'session.updated',
        session: { instructions: 'private', tools: [{ name: 'private' }] },
      }),
    ).toBeNull();
    expect(projectRealtimeEvent({ type: 'rate_limits.updated' })).toBeNull();
  });

  it('reports failed responses and ignores cancelled responses', () => {
    expect(
      projectRealtimeEvent({
        type: 'response.done',
        response: { status: 'failed' },
      }),
    ).toEqual({ type: 'app.error', code: 'VOICE_RESPONSE_ERROR' });
    expect(
      projectRealtimeEvent({
        type: 'response.done',
        response: { status: 'cancelled' },
      }),
    ).toBeNull();
  });
});
