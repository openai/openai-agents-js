import { describe, it, expect } from 'vitest';
import { toNewSessionConfig } from '../src/clientMessages';
import { RealtimeAgent } from '../src/realtimeAgent';
import { RealtimeSession } from '../src/realtimeSession';
import { OpenAIRealtimeBase } from '../src/openaiRealtimeBase';
import type { RealtimeClientMessage } from '../src/clientMessages';

const TELEPHONY_AUDIO_FORMAT = { type: 'audio/pcmu' as const };

class CapturingTransport extends OpenAIRealtimeBase {
  status: 'connected' | 'disconnected' | 'connecting' | 'disconnecting' =
    'disconnected';
  mergedConfig: any = null;
  events: RealtimeClientMessage[] = [];

  async connect(options: { initialSessionConfig?: any }) {
    this.mergedConfig = (this as any)._getMergedSessionConfig(
      options.initialSessionConfig ?? {},
    );
  }

  sendEvent(event: RealtimeClientMessage) {
    this.events.push(event);
  }

  mute() {}
  close() {}
  interrupt() {}

  get muted() {
    return false;
  }
}

describe('Realtime session voice config regression', () => {
  it('drops GA audio formats when top-level voice is present', () => {
    const converted = toNewSessionConfig({
      voice: 'alloy',
      audio: {
        input: { format: TELEPHONY_AUDIO_FORMAT },
        output: { format: TELEPHONY_AUDIO_FORMAT },
      },
    });

    expect(converted.audio?.input?.format).toEqual(TELEPHONY_AUDIO_FORMAT);
    expect(converted.audio?.output?.format).toEqual(TELEPHONY_AUDIO_FORMAT);
    expect(converted.audio?.output?.voice).toBe('alloy');
  });

  it('resets audio formats when connecting a session for an agent with voice configured', async () => {
    const transport = new CapturingTransport();
    const agent = new RealtimeAgent({
      name: 'voice-agent',
      instructions: 'Respond cheerfully.',
      voice: 'alloy',
    });

    const session = new RealtimeSession(agent, {
      transport,
      model: 'gpt-realtime',
      config: {
        audio: {
          input: { format: TELEPHONY_AUDIO_FORMAT },
          output: {
            format: TELEPHONY_AUDIO_FORMAT,
            voice: 'marin',
          },
        },
      },
    });

    await session.connect({ apiKey: 'dummy-key' });

    expect(transport.mergedConfig?.audio?.input?.format).toEqual(
      TELEPHONY_AUDIO_FORMAT,
    );
    expect(transport.mergedConfig?.audio?.output?.format).toEqual(
      TELEPHONY_AUDIO_FORMAT,
    );
    expect(transport.mergedConfig?.audio?.output?.voice).toBe('marin');
  });

  it('prefers config.voice over the agent voice when no audio output override exists', async () => {
    const transport = new CapturingTransport();
    const agent = new RealtimeAgent({
      name: 'voice-agent',
      instructions: 'Respond cheerfully.',
      voice: 'alloy',
    });

    const session = new RealtimeSession(agent, {
      transport,
      model: 'gpt-realtime',
      config: {
        voice: 'verse',
      },
    });

    await session.connect({ apiKey: 'dummy-key' });

    expect(transport.mergedConfig?.audio?.output?.voice).toBe('verse');
  });

  it('falls back to the agent voice when no config overrides are provided', async () => {
    const transport = new CapturingTransport();
    const agent = new RealtimeAgent({
      name: 'voice-agent',
      instructions: 'Respond cheerfully.',
      voice: 'alloy',
    });

    const session = new RealtimeSession(agent, {
      transport,
      model: 'gpt-realtime',
    });

    await session.connect({ apiKey: 'dummy-key' });

    expect(transport.mergedConfig?.audio?.output?.voice).toBe('alloy');
  });
});
