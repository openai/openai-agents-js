import { describe, expect, it } from 'vitest';
import { Manifest, file } from '../src/sandbox';
import {
  deserializeManifest,
  serializeManifestRecord,
} from '../src/sandbox/internal';

describe('sandbox manifest binary persistence', () => {
  it('rejects malformed persisted base64 file content', () => {
    const serialized = serializeManifestRecord(
      new Manifest({
        entries: {
          'payload.bin': file({ content: Uint8Array.from([1, 2, 3]) }),
        },
      }),
    );
    const entries = serialized.entries as Record<string, any>;
    entries['payload.bin'].content = {
      type: 'base64',
      data: '!!!!',
    };

    expect(() => deserializeManifest(serialized)).toThrow(
      'Invalid base64 string.',
    );
  });
});
