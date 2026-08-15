import { describe, expect, it } from 'vitest';
import {
  normalizeAudioFormat,
  toNewSessionConfig,
} from '../src/clientMessages';

describe('normalizeAudioFormat', () => {
  it.each([NaN, Infinity, -Infinity])(
    'falls back to 24kHz PCM for non-finite rate %s',
    (rate) => {
      const format = { type: 'audio/pcm' as const, rate };

      expect(normalizeAudioFormat(format)).toEqual({
        type: 'audio/pcm',
        rate: 24000,
      });
    },
  );

  it('preserves a finite structured PCM format', () => {
    const format = { type: 'audio/pcm' as const, rate: 24000 };

    expect(normalizeAudioFormat(format)).toBe(format);
  });

  it.each(['audio/pcmu', 'audio/pcma'] as const)(
    'preserves structured telephony format %s',
    (type) => {
      const format = { type };

      expect(normalizeAudioFormat(format)).toBe(format);
    },
  );

  it('preserves unknown structured formats for forward compatibility', () => {
    const format = { type: 'audio/future', rate: NaN };

    expect(normalizeAudioFormat(format as any)).toBe(format);
  });

  it('normalizes non-finite PCM rates for both session audio directions', () => {
    const format = { type: 'audio/pcm' as const, rate: NaN };

    const config = toNewSessionConfig({
      audio: {
        input: { format },
        output: { format },
      },
    });

    expect(config.audio?.input?.format).toEqual({
      type: 'audio/pcm',
      rate: 24000,
    });
    expect(config.audio?.output?.format).toEqual({
      type: 'audio/pcm',
      rate: 24000,
    });
  });
});
