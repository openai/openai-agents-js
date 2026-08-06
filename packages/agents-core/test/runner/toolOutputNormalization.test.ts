import { describe, expect, it } from 'vitest';

import {
  convertStructuredToolOutputToInputItem,
  normalizeStructuredToolOutputs,
} from '../../src/runner/toolOutputNormalization';

describe('runner/toolOutputNormalization', () => {
  it('returns null for empty arrays and mixed unstructured outputs', () => {
    expect(normalizeStructuredToolOutputs([])).toBeNull();
    expect(
      normalizeStructuredToolOutputs([{ type: 'text', text: 'ok' }, 'bad']),
    ).toBeNull();
    expect(normalizeStructuredToolOutputs('plain')).toBeNull();
  });

  it('normalizes legacy image forms into protocol input images', () => {
    const bytes = Uint8Array.from([104, 105]);
    const normalized = normalizeStructuredToolOutputs([
      {
        type: 'image',
        imageUrl: 'https://example.com/legacy.png',
        detail: 'high',
        providerData: { source: 'legacy-url' },
      },
      {
        type: 'image',
        fileId: 'file_top_level',
      },
      {
        type: 'image',
        data: bytes,
        mediaType: 'image/png',
      },
      {
        type: 'image',
        image: {
          data: bytes,
          mediaType: 'image/jpeg',
        },
      },
    ]);

    expect(normalized).not.toBeNull();
    expect(normalized?.map(convertStructuredToolOutputToInputItem)).toEqual([
      {
        type: 'input_image',
        image: 'https://example.com/legacy.png',
        detail: 'high',
        providerData: { source: 'legacy-url' },
      },
      {
        type: 'input_image',
        image: { id: 'file_top_level' },
      },
      {
        type: 'input_image',
        image: 'data:image/png;base64,aGk=',
      },
      {
        type: 'input_image',
        image: 'data:image/jpeg;base64,aGk=',
      },
    ]);
  });

  it('normalizes legacy file forms into protocol input files', () => {
    const bytes = Uint8Array.from([104, 105]);
    const normalized = normalizeStructuredToolOutputs([
      {
        type: 'file',
        fileData: 'aGk=',
        mediaType: 'text/plain',
        filename: 'inline.txt',
      },
      {
        type: 'file',
        fileData: bytes,
        mediaType: 'application/octet-stream',
        filename: 'binary.bin',
      },
      {
        type: 'file',
        fileUrl: 'https://example.com/report.txt',
        filename: 'report.txt',
      },
      {
        type: 'file',
        fileId: 'file_legacy',
        filename: 'legacy.txt',
        providerData: { source: 'legacy-id' },
      },
    ]);

    expect(normalized).not.toBeNull();
    expect(normalized?.map(convertStructuredToolOutputToInputItem)).toEqual([
      {
        type: 'input_file',
        file: 'data:text/plain;base64,aGk=',
        filename: 'inline.txt',
      },
      {
        type: 'input_file',
        file: 'data:application/octet-stream;base64,aGk=',
        filename: 'binary.bin',
      },
      {
        type: 'input_file',
        file: { url: 'https://example.com/report.txt' },
        filename: 'report.txt',
      },
      {
        type: 'input_file',
        file: { id: 'file_legacy' },
        filename: 'legacy.txt',
        providerData: { source: 'legacy-id' },
      },
    ]);
  });

  it('rejects incomplete file data objects', () => {
    expect(
      normalizeStructuredToolOutputs({
        type: 'file',
        file: {
          data: 'aGk=',
          mediaType: 'text/plain',
        },
      }),
    ).toBeNull();

    expect(
      normalizeStructuredToolOutputs({
        type: 'file',
        fileData: 'aGk=',
        mediaType: 'text/plain',
      }),
    ).toBeNull();
  });
});
