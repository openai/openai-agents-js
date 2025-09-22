import { describe, it, expect } from 'vitest';
import { toNewSessionConfig } from '../src/clientMessages';

const TELEPHONY_AUDIO_FORMAT = { type: 'audio/pcmu' as const };

describe('Realtime session voice config regression', () => {
  it('preserves GA audio formats when top-level voice is present', () => {
    const converted = toNewSessionConfig({
      voice: 'alloy',
      audio: {
        input: { format: TELEPHONY_AUDIO_FORMAT },
        output: { format: TELEPHONY_AUDIO_FORMAT },
      },
    });

    expect(converted.audio?.input?.format).toEqual(TELEPHONY_AUDIO_FORMAT);
    expect(converted.audio?.output?.format).toEqual(TELEPHONY_AUDIO_FORMAT);
    // Also ensure GA voice lifting occurs if GA output.voice is not set explicitly
    expect(converted.audio?.output?.voice).toEqual('alloy');
  });
});

