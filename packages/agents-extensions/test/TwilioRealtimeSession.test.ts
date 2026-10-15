import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import {
  OpenAIRealtimeWebSocket,
  RealtimeAgent,
  RealtimeSession,
  type RealtimeAudioFormat,
  type RealtimeSessionConfig,
} from '@openai/agents/realtime';
import { TwilioRealtimeTransportLayer } from '../src/TwilioRealtimeTransport';

// Replace only the network connection so session merging, Twilio defaults, and
// wire serialization all run through their production implementations.
class RecordingSocket extends EventEmitter {
  sent: string[] = [];

  addEventListener(type: string, listener: (...args: any[]) => void) {
    this.on(type, listener);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.emit('close', {});
  }

  sessionUpdates() {
    return this.sent
      .map((data) => JSON.parse(data))
      .filter((event) => event.type === 'session.update');
  }
}

describe('RealtimeSession transport audio defaults', () => {
  const configs: [
    string,
    Partial<RealtimeSessionConfig> | undefined,
    RealtimeAudioFormat?,
  ][] = [
    ['omitted config', undefined],
    ['empty config', {}],
    ['top-level voice', { voice: 'verse' }],
    ['nested voice', { audio: { output: { voice: 'verse' } } }],
    [
      'explicit formats',
      {
        audio: {
          input: { format: { type: 'audio/pcmu' } },
          output: { format: { type: 'audio/pcmu' }, speed: 1.2 },
        },
      },
    ],
    [
      'explicit input format override',
      { audio: { input: { format: { type: 'audio/pcm', rate: 24000 } } } },
      { type: 'audio/pcm', rate: 24000 },
    ],
  ];

  it.each(configs)(
    'uses Twilio formats with %s across agent updates',
    async (_, config, expectedInputFormat = { type: 'audio/pcmu' }) => {
      const socket = new RecordingSocket();
      const transport = new TwilioRealtimeTransportLayer({
        twilioWebSocket: new RecordingSocket() as unknown as WebSocket,
        createWebSocket: async () => socket as unknown as WebSocket,
        skipOpenEventListeners: true,
      });
      const session = new RealtimeSession(
        new RealtimeAgent({ name: 'First' }),
        {
          transport,
          config,
        },
      );

      try {
        await session.connect({ apiKey: 'ek_test' });
        const initialUpdates = socket.sessionUpdates();
        expect(initialUpdates.length).toBeGreaterThan(0);
        await session.updateAgent(new RealtimeAgent({ name: 'Next' }));
        const updates = socket.sessionUpdates();
        expect(updates.length).toBeGreaterThan(initialUpdates.length);
        for (const { session: payload } of updates) {
          expect(payload.audio.input.format).toEqual(expectedInputFormat);
          expect(payload.audio.output.format).toEqual({ type: 'audio/pcmu' });
          if (
            config?.voice ||
            (config && 'audio' in config && config.audio?.output?.voice)
          ) {
            expect(payload.audio.output.voice).toBe('verse');
          }
          if (config && 'audio' in config && config.audio?.output?.speed) {
            expect(payload.audio.output.speed).toBe(1.2);
          }
        }
      } finally {
        session.close();
      }
    },
  );

  it('retains ordinary WebSocket defaults across agent updates', async () => {
    const socket = new RecordingSocket();
    const transport = new OpenAIRealtimeWebSocket({
      createWebSocket: async () => socket as unknown as WebSocket,
      skipOpenEventListeners: true,
    });
    const session = new RealtimeSession(new RealtimeAgent({ name: 'First' }), {
      transport,
    });

    try {
      await session.connect({ apiKey: 'ek_test' });
      await session.updateAgent(new RealtimeAgent({ name: 'Next' }));
      const updates = socket.sessionUpdates();
      expect(updates.length).toBeGreaterThanOrEqual(2);
      for (const { session: payload } of updates) {
        expect(payload.output_modalities).toEqual(['audio']);
        expect(payload.audio.input).toEqual({
          format: { type: 'audio/pcm', rate: 24000 },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          turn_detection: { type: 'semantic_vad' },
          noise_reduction: null,
        });
        expect(payload.audio.output.format).toEqual({
          type: 'audio/pcm',
          rate: 24000,
        });
        expect(payload.audio.output.speed).toBe(1);
      }
    } finally {
      session.close();
    }
  });
});
