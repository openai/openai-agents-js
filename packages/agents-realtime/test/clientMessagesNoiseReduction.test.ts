import { describe, expect, it } from 'vitest';
import { toNewSessionConfig } from '../src/clientMessages';

describe('Realtime GA audio config conversion', () => {
  it('does not disable noise reduction when the caller only sets input format', () => {
    const config = toNewSessionConfig({
      audio: {
        input: {
          format: { type: 'audio/pcm', rate: 24000 },
        },
      },
    });

    expect(config.audio?.input?.noiseReduction).toBeUndefined();
    expect(JSON.parse(JSON.stringify(config.audio?.input))).not.toHaveProperty(
      'noiseReduction',
    );
  });

  it('preserves explicit noise reduction disable and configuration values', () => {
    const disabled = toNewSessionConfig({
      audio: { input: { noiseReduction: null } },
    });
    const enabled = toNewSessionConfig({
      audio: { input: { noiseReduction: { type: 'near_field' } } },
    });

    expect(disabled.audio?.input?.noiseReduction).toBeNull();
    expect(enabled.audio?.input?.noiseReduction).toEqual({
      type: 'near_field',
    });
  });
});
