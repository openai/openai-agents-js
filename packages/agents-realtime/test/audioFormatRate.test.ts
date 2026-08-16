import { describe, expect, it } from 'vitest';
import { normalizeAudioFormat } from '../src/clientMessages';

describe('Realtime PCM audio format normalization', () => {
  it.each([16000, 44100, 48000, Number.NaN, Number.POSITIVE_INFINITY])(
    'normalizes unsupported PCM rate %s to 24000',
    (rate) => {
      expect(normalizeAudioFormat({ type: 'audio/pcm', rate })).toEqual({
        type: 'audio/pcm',
        rate: 24000,
      });
    },
  );

  it('preserves the supported 24000 Hz PCM format', () => {
    expect(normalizeAudioFormat({ type: 'audio/pcm', rate: 24000 })).toEqual({
      type: 'audio/pcm',
      rate: 24000,
    });
  });

  it('leaves G.711 formats unchanged', () => {
    expect(normalizeAudioFormat({ type: 'audio/pcmu' })).toEqual({
      type: 'audio/pcmu',
    });
    expect(normalizeAudioFormat({ type: 'audio/pcma' })).toEqual({
      type: 'audio/pcma',
    });
  });
});
