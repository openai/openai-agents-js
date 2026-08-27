import type { PublicEvent } from '../shared/publicEvents';

type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null;
}

export function projectRealtimeEvent(event: unknown): PublicEvent | null {
  if (!isRecord(event) || typeof event.type !== 'string') {
    return null;
  }

  switch (event.type) {
    case 'input_audio_buffer.speech_started':
      return { type: 'app.agent.state', state: 'listening' };
    case 'input_audio_buffer.speech_stopped':
    case 'response.created':
      return { type: 'app.agent.state', state: 'thinking' };
    case 'response.output_audio.delta':
      return { type: 'app.agent.state', state: 'speaking' };
    case 'response.done': {
      const response = isRecord(event.response) ? event.response : null;
      if (response?.status === 'failed' || response?.status === 'incomplete') {
        return { type: 'app.error', code: 'VOICE_RESPONSE_ERROR' };
      }
      if (response?.status === 'cancelled') {
        return null;
      }
      return { type: 'app.agent.state', state: 'idle' };
    }
    case 'error':
      return { type: 'app.error', code: 'VOICE_SESSION_ERROR' };
    default:
      return null;
  }
}
