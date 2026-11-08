import { describe, expect, it } from 'vitest';
import { ToolOutput, type InputFile, type InputImageFile } from '../../src';
import { nativeInput, responseContent } from '../../src/runtime/input';
import { outputOf } from '../../src/runtime/tools';
import { CODEX_REVISION, parseNativeCheckpoint } from '../../src/runtime/state';

const sources = [
  { file_id: 'opaque-file' },
  { file_url: 'https://files.invalid/a.pdf?opaque=1' },
  { file_data: 'JVBERi0xLjcK' },
  { file_data: 'data:application/pdf;base64,JVBERi0xLjcK' },
] as const;

describe('media capture and shared projections', () => {
  for (const source of [
    { image_url: 'https://image.invalid/a.png' },
    { file_id: 'opaque-image' },
  ]) {
    for (const detail of [
      undefined,
      'auto',
      'low',
      'high',
      'original',
    ] as const) {
      it(`retains ${Object.keys(source)[0]} with detail ${detail}`, () => {
        const part = { type: 'input_image' as const, ...source, detail };
        const captured = nativeInput({ role: 'user', content: [part] });
        const expected = {
          type: 'input_image',
          ...source,
          ...(detail ? { detail } : {}),
        };
        expect(responseContent(captured)).toEqual([expected]);
        const image =
          'image_url' in source
            ? { imageUrl: source.image_url! }
            : { fileId: source.file_id! };
        const native = {
          type: 'inputImage' as const,
          ...image,
          ...(detail ? { detail } : {}),
        };
        expect(responseContent([native])).toEqual([expected]);
        expect(outputOf(new ToolOutput([native])).contentItems).toEqual([
          native,
        ]);
      });
    }
  }
  it.each(sources)(
    'detaches a file descriptor while retaining name and order: %o',
    (source) => {
      const file: InputFile = {
        type: 'input_file',
        ...source,
        filename: 'report.pdf',
      };
      const image: InputImageFile = {
        type: 'input_image',
        file_id: 'opaque-image',
        detail: 'low',
      };
      const captured = nativeInput({
        role: 'user',
        content: [{ type: 'input_text', text: 'before' }, image, file],
      });
      const expected = [
        { type: 'input_text', text: 'before' },
        image,
        { ...file },
      ];
      file.filename = 'changed';
      const projected = responseContent(captured);
      expect(projected).toEqual(expected);
      (projected[2] as Record<string, unknown>).filename = 'also changed';
      expect(responseContent(captured)).toEqual(expected);
      expect(
        outputOf(ToolOutput.file({ ...source, filename: 'report.pdf' })),
      ).toEqual({
        success: true,
        contentItems: [
          { type: 'inputFile', ...source, filename: 'report.pdf' },
        ],
      });
    },
  );
  it.each([
    { type: 'input_image' },
    {
      type: 'input_image',
      image_url: 'https://image.invalid/a',
      file_id: null,
    },
    { type: 'input_image', file_id: '' },
    { type: 'input_image', file_id: 'id', detail: 'maximum' },
    { type: 'input_image', image_url: '/tmp/image.png' },
    { type: 'input_file' },
    { type: 'input_file', file_id: 'id', file_url: null },
    { type: 'input_file', file_url: 'http://files.invalid/a' },
    { type: 'input_file', file_data: 'Zh==' },
    { type: 'input_file', file_data: 'not base64!' },
    { type: 'input_file', file_id: ' ', filename: 'a' },
    { type: 'input_file', file_id: 'id', filename: 1 },
  ])('rejects malformed content during capture: %o', (part) => {
    expect(() =>
      nativeInput({ role: 'user', content: [part] } as never),
    ).toThrow();
  });
  it('retains the legacy string factory and omits native-only text metadata', () => {
    const imageUrl = 'data:image/png;base64,AA==';
    expect(outputOf(ToolOutput.image(imageUrl))).toEqual(
      outputOf(new ToolOutput([{ type: 'inputImage', imageUrl }])),
    );
    expect(
      outputOf(ToolOutput.image({ fileId: 'id', detail: 'low' })).contentItems,
    ).toEqual([{ type: 'inputImage', fileId: 'id', detail: 'low' }]);
    expect(
      responseContent([{ type: 'text', text: 'a', text_elements: [] }]),
    ).toEqual([{ type: 'input_text', text: 'a' }]);
  });
  it('preserves additive native retained cell descriptors without granting a route profile', () => {
    const content_items = [
      { File: { file: { file_id: 'opaque', filename: 'a.pdf' } } },
      { RichImage: { image: { file_id: 'opaque-image' }, detail: 'Low' } },
      { Image: { image_url: 'data:image/png;base64,AA==', detail: 'High' } },
    ];
    const root_code_mode = {
      format_version: 1,
      next_cell_id: '2',
      stored_values: {},
      completed_cells: {
        '1': { event: { Completed: { content_items, error_text: null } } },
      },
    };
    const parsed = parseNativeCheckpoint({
      format_version: 4,
      codex_revision: CODEX_REVISION,
      source_session_id: 'root',
      history: [],
      root_metadata: {},
      root_code_mode,
    });
    expect(parsed.root_code_mode).toEqual(root_code_mode);
  });
});
